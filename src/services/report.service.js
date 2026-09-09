require('../config/env');
// puppeteer ships as an ESM-only package (no CommonJS entry point) as of the installed version —
// the rest of this backend is CommonJS throughout, so it's loaded via a lazy dynamic import()
// (Node's standard, documented CJS-consuming-ESM interop) inside withBrowserPage below, rather
// than a top-level require() here, which would throw a SyntaxError on 'export * from ...'.
const ExcelJS = require('exceljs');
const { Document, Packer, Paragraph, Table, TableRow, TableCell, HeadingLevel, ExternalHyperlink, TextRun, WidthType } = require('docx');
const logger = require('../utils/logger');
const TaskUpdate = require('../models/TaskUpdate');
const User = require('../models/User');
const taskService = require('./task.service');
const dashboardService = require('./dashboard.service');
const { formatDateShort, MONTH_NAMES } = require('../utils/formatDate');

// "Unpaginated, all matching rows" (docs/06-backend.md §9) implemented by calling the existing,
// unmodified listTasks with a limit far beyond this project's confirmed scale (docs/01-architecture.md
// §9: ~20-25 users, small task volume) — not a new "no pagination" mode added to listTasks itself.
const UNPAGINATED_LIMIT = 100000;

const USER_SUMMARY_COLUMNS = ['name', 'responsibility', 'ongoing', 'pending', 'complete', 'closed', 'excellent', 'good', 'fair', 'weak', 'notApplicable', 'total'];
const USER_SUMMARY_COLUMN_LABELS = {
  name: 'Name',
  responsibility: 'Responsibility',
  ongoing: 'Ongoing',
  pending: 'Pending',
  complete: 'Complete',
  closed: 'Closed',
  excellent: 'Excellent',
  good: 'Good',
  fair: 'Fair',
  weak: 'Weak',
  notApplicable: 'N/A',
  total: 'Total',
};

// Grouped task report's fixed columns (docs/06-backend.md §9, rewritten) — every format
// (html->pdf/jpeg, excel, docx) renders the SAME two tables per task, in this order.
const TASK_HEADER_LABELS = ['Code Number', 'Task', 'Deadline', 'Remaining Days'];
const UPDATE_TABLE_LABELS = ['Date', 'Updated By', 'Description', 'Completion %', 'Attachment'];
const REPORT_COLUMN_COUNT = UPDATE_TABLE_LABELS.length; // the widest of the two tables — used for merges/spans

function resolveColumns(requested, allColumns) {
  if (!requested || requested.length === 0) return allColumns;
  return allColumns.filter((c) => requested.includes(c));
}

function escapeHtml(str) {
  const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return String(str ?? '').replace(/[&<>"']/g, (c) => map[c]);
}

function formatShortDate(date) {
  const d = new Date(date);
  return `${MONTH_NAMES[d.getMonth()]} ${d.getDate()}`;
}

function formatDateRange(from, to) {
  if (from && to) {
    const fromD = new Date(from);
    const toD = new Date(to);
    if (fromD.getFullYear() === toD.getFullYear() && fromD.getMonth() === toD.getMonth()) {
      return `${MONTH_NAMES[fromD.getMonth()]} ${fromD.getDate()}–${toD.getDate()}`;
    }
    return `${formatShortDate(fromD)}–${formatShortDate(toD)}`;
  }
  if (from) return `from ${formatShortDate(from)}`;
  return `until ${formatShortDate(to)}`;
}

function capitalize(str) {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

// docs/06-backend.md §9 / docs/05-apis.md §9: the applied filter's plain-language description,
// built explicitly from whatever filters were actually passed — never a hardcoded generic label.
function buildFilterDescription(filters = {}) {
  const parts = [];
  if (filters.status) parts.push(`Status: ${capitalize(filters.status)}`);
  if (filters.performanceRating) parts.push(`Performance: ${filters.performanceRating === '-' ? 'Not Applicable' : capitalize(filters.performanceRating)}`);
  if (filters.responsibility) parts.push(`Responsibility: ${filters.responsibility}`);
  if (filters.deadlineFrom || filters.deadlineTo) {
    parts.push(`Deadline: ${formatDateRange(filters.deadlineFrom, filters.deadlineTo)}`);
  }
  if (filters.entryFrom || filters.entryTo) {
    parts.push(`Entry Date: ${formatDateRange(filters.entryFrom, filters.entryTo)}`);
  }
  if (filters.search) parts.push(`Search: "${filters.search}"`);
  return parts.length > 0 ? parts.join(', ') : 'All Data';
}

// docs/06-backend.md §9 — "Task Report" title + the filter description above, or "All Data" if
// none applied. No longer names a single task/"All Responsible" — the report itself is now
// organized by Zimmedar (assignee), which replaces that older single-vs-many-tasks framing
// entirely (buildReportData below returns groups, not a flat task list).
function buildHeaderInfo(filters) {
  return {
    title: 'Task Report',
    filterDescription: buildFilterDescription(filters),
  };
}

// "Baqi Din" (Remaining Days) — reuses the task's own already-computed timeStatus
// (task.service.js's computeTimeStatus), phrased the same way the frontend's
// formatTimeStatusLabel (frontend/src/utils/formatDate.js) reads it, just in English to match
// this document's existing label convention.
function formatRemainingDaysLabel(timeStatus) {
  if (!timeStatus) return '-';
  const { type, days } = timeStatus;
  switch (type) {
    case 'remaining':
      return days === 0 ? 'Due today' : `${days} day(s) remaining`;
    case 'overdue':
      return `${days} day(s) overdue`;
    case 'early':
      return days === 0 ? 'Completed on time' : `${days} day(s) early`;
    case 'late':
      return `${days} day(s) late`;
    default:
      return '-';
  }
}

function attachmentLabel(attachment) {
  if (!attachment) return '-';
  return attachment.fileName || attachment.url || '-';
}

// docs/06-backend.md §9 (rewritten) — one section per Zimmedar (name + their OWN
// User.responsibility, not the task's own responsibility field — that field described the task's
// department/category at creation time and isn't repeated here now that tasks are grouped by
// person instead of listed flat). A task with more than one assignee appears once per assignee it
// actually has — EXCEPT when the caller filtered to one specific assigneeId, in which case every
// matching task is placed only under that one Zimmedar's section (a co-assignee the admin didn't
// ask to see must not leak a section of their own just because they share a task).
function groupTasksByAssignee(tasksWithUpdates, { onlyAssigneeId } = {}) {
  const groups = new Map();
  tasksWithUpdates.forEach(({ task, updates }) => {
    const relevantAssignees = onlyAssigneeId
      ? task.assignees.filter((a) => String(a.id) === String(onlyAssigneeId))
      : task.assignees;
    relevantAssignees.forEach((assignee) => {
      const key = String(assignee.id);
      if (!groups.has(key)) {
        groups.set(key, {
          assignee: { id: assignee.id, name: assignee.name, responsibility: assignee.responsibility },
          tasks: [],
        });
      }
      groups.get(key).tasks.push({ task, updates });
    });
  });
  return [...groups.values()].sort((a, b) => a.assignee.name.localeCompare(b.assignee.name));
}

// docs/06-backend.md §9 step 1 — reuses task.service.listTasks (unmodified), unpaginated, same
// RBAC scoping as GET /tasks. Every matching task's full update history is always fetched (via
// the same underlying query taskUpdate.service.js's listUpdates uses — not via listUpdates
// itself, since that re-runs a per-task ownership check already redundant here, and paginates,
// where a report needs the FULL history); lastUpdateOnly trims each task down to just its single
// most recent entry afterward — the tasks matched, and which Zimmedar(an) they're grouped under,
// never depend on this flag, only how much of each task's Updates section is shown.
async function buildReportData(requestingUser, filters, { lastUpdateOnly } = {}) {
  const { items: tasks } = await taskService.listTasks(requestingUser, filters, {
    page: 1,
    limit: UNPAGINATED_LIMIT,
    sortBy: filters.sortBy,
    sortOrder: filters.sortOrder,
  });

  let updatesByTaskId = {};
  if (tasks.length > 0) {
    const taskIds = tasks.map((t) => t._id);
    const allUpdates = await TaskUpdate.find({ taskId: { $in: taskIds } })
      .sort({ createdAt: -1 })
      .populate('updatedBy', 'name role');
    allUpdates.forEach((u) => {
      const key = u.taskId.toString();
      (updatesByTaskId[key] ||= []).push(u);
    });
  }

  const tasksWithUpdates = tasks.map((task) => {
    const allTaskUpdates = updatesByTaskId[task.id] || [];
    const updates = lastUpdateOnly ? allTaskUpdates.slice(0, 1) : allTaskUpdates;
    return { task, updates };
  });

  const groups = groupTasksByAssignee(tasksWithUpdates, { onlyAssigneeId: filters.assigneeId });

  return { groups, lastUpdateOnly: Boolean(lastUpdateOnly) };
}

// Shared HTML shell — Jameel Noori Nastaleeq is referenced by name (the same font-family the
// documented frontend setup will use — Frontend Foundation document §7) with real fallbacks; no
// project currently ships the actual font file (frontend work hasn't started yet — see Phase 8
// report, section I), so Puppeteer's Chromium falls back to whatever Arabic/Nastaliq-capable
// font is actually installed in the deployment environment until that asset exists.
function htmlDocument(title, bodyHtml) {
  return `<!doctype html>
<html dir="rtl" lang="ur">
<head>
<meta charset="utf-8" />
<title>${escapeHtml(title)}</title>
<style>
  body { font-family: 'Jameel Noori Nastaleeq', 'Noto Nastaliq Urdu', 'Noto Sans Arabic', serif; direction: rtl; margin: 24px; }
  h1 { font-size: 20px; margin-bottom: 4px; }
  p.filter-description { color: #555; margin: 4px 0 16px; }
  h2.assignee-header { font-size: 16px; margin: 20px 0 8px; padding-bottom: 4px; border-bottom: 2px solid #2f6f4f; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 4px; }
  th, td { border: 1px solid #ccc; padding: 6px; text-align: right; font-size: 12px; }
  th { background: #eef5ef; }
  table.task-header th, table.task-header td { background: #f5f5f5; }
  h4.updates-heading { font-size: 13px; margin: 4px 0; }
  table.updates-table { margin-bottom: 16px; }
  td.empty-updates { text-align: center; color: #777; }
</style>
</head>
<body>
${bodyHtml}
</body>
</html>`;
}

function attachmentCellHtml(attachment) {
  if (!attachment) return '-';
  const label = escapeHtml(attachment.fileName || 'Attachment');
  return attachment.url ? `<a href="${escapeHtml(attachment.url)}">${label}</a>` : label;
}

function renderUpdateRowHtml(update) {
  return `<tr>
<td>${escapeHtml(formatDateShort(update.createdAt))}</td>
<td>${escapeHtml(update.updatedBy?.name)}</td>
<td>${escapeHtml(update.description)}</td>
<td>${update.completionPercent}%</td>
<td>${attachmentCellHtml(update.attachment)}</td>
</tr>`;
}

function renderTaskBlockHtml(task, updates) {
  const updatesRows =
    updates.length > 0
      ? updates.map((u) => renderUpdateRowHtml(u)).join('')
      : `<tr><td colspan="${REPORT_COLUMN_COUNT}" class="empty-updates">No updates yet</td></tr>`;

  return `
<table class="task-header">
<thead><tr>${TASK_HEADER_LABELS.map((l) => `<th>${escapeHtml(l)}</th>`).join('')}</tr></thead>
<tbody><tr>
<td>${escapeHtml(task.codeNumber)}</td>
<td>${escapeHtml(task.title)}</td>
<td>${escapeHtml(formatDateShort(task.deadline))}</td>
<td>${escapeHtml(formatRemainingDaysLabel(task.timeStatus))}</td>
</tr></tbody>
</table>
<h4 class="updates-heading">Updates</h4>
<table class="updates-table">
<thead><tr>${UPDATE_TABLE_LABELS.map((l) => `<th>${escapeHtml(l)}</th>`).join('')}</tr></thead>
<tbody>${updatesRows}</tbody>
</table>`;
}

// docs/06-backend.md §9 (rewritten) — builds the HTML string rendered by generatePdf/generateJpeg.
function renderReportHtml(groups, { headerInfo }) {
  const groupsHtml =
    groups.length > 0
      ? groups
          .map(
            (group) => `
<h2 class="assignee-header">${escapeHtml(group.assignee.name)} — ${escapeHtml(group.assignee.responsibility)}</h2>
${group.tasks.map(({ task, updates }) => renderTaskBlockHtml(task, updates)).join('')}`
          )
          .join('')
      : '<p>No tasks found.</p>';

  const body = `
<h1>${escapeHtml(headerInfo.title)}</h1>
<p class="filter-description">${escapeHtml(headerInfo.filterDescription)}</p>
${groupsHtml}`;

  return htmlDocument(headerInfo.title, body);
}

function renderUserSummaryHtml(rows, { columns }) {
  const activeColumns = resolveColumns(columns, USER_SUMMARY_COLUMNS);
  const headRow = activeColumns.map((c) => `<th>${escapeHtml(USER_SUMMARY_COLUMN_LABELS[c])}</th>`).join('');
  const bodyRows = rows
    .map((row) => `<tr>${activeColumns.map((c) => `<td>${escapeHtml(row[c])}</td>`).join('')}</tr>`)
    .join('');

  const body = `
<h1>User-wise Summary Report</h1>
<table><thead><tr>${headRow}</tr></thead><tbody>${bodyRows}</tbody></table>`;

  return htmlDocument('User-wise Summary Report', body);
}

// docs/06-backend.md §9 — Admin-only (enforced by requireRole('admin') on the route, same
// pattern as every other Admin-only endpoint). One row per active user, reusing
// dashboard.service.js's exact aggregation (computeSummaryForFilter), grouped per-user instead
// of globally, per the doc's explicit "do not write a second aggregation" instruction.
async function buildUserSummaryData(_requestingUser) {
  const activeUsers = await User.find({ isActive: true }).sort({ name: 1 });

  return Promise.all(
    activeUsers.map(async (user) => {
      const summary = await dashboardService.computeSummaryForFilter({ assignees: user._id });
      return {
        id: user.id,
        name: user.name,
        responsibility: user.responsibility,
        ongoing: summary.byStatus.ongoing.count,
        pending: summary.byStatus.pending.count,
        complete: summary.byStatus.complete.count,
        closed: summary.byStatus.closed.count,
        excellent: summary.byPerformance.excellent.count,
        good: summary.byPerformance.good.count,
        fair: summary.byPerformance.fair.count,
        weak: summary.byPerformance.weak.count,
        notApplicable: summary.byPerformance.notApplicable.count,
        total: summary.total,
      };
    })
  );
}

// Per-request launch/close (docs/06-backend.md §5's "acceptable for this small internal tool's
// traffic" option) — chosen over a shared long-lived instance to avoid any shared-mutable-state/
// shutdown-hook lifecycle management; at ~25 users and modest report frequency the ~0.3-1s launch
// overhead per request is a good trade for simplicity and zero risk of a leaked zombie browser.
async function withBrowserPage(fn) {
  const { default: puppeteer } = await import('puppeteer');
  const launchOptions = {
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  };
  let browser;
  try {
    browser = await puppeteer.launch(launchOptions);
  } catch (launchError) {
    logger.error('Puppeteer browser launch failed:', launchError);
    throw launchError;
  }

  try {
    const page = await browser.newPage();
    return await fn(page);
  } catch (pageError) {
    logger.error('Puppeteer report generation failed on page:', pageError);
    throw pageError;
  } finally {
    if (browser) {
      await browser.close().catch((closeError) => {
        logger.error('Failed to close Puppeteer browser:', closeError);
      });
    }
  }
}

async function generatePdf(html) {
  return withBrowserPage(async (page) => {
    await page.setContent(html, { waitUntil: 'networkidle0' });
    // page.pdf() resolves a plain Uint8Array, not a Node Buffer — Express's res.send() special-
    // cases Buffer.isBuffer() for correct binary responses (Content-Length etc.), so wrap
    // explicitly rather than let a subtly-wrong type reach the controller.
    return Buffer.from(await page.pdf({ format: 'A4' }));
  });
}

async function generateJpeg(html) {
  return withBrowserPage(async (page) => {
    await page.setContent(html, { waitUntil: 'networkidle0' });
    // Same Uint8Array-vs-Buffer reasoning as generatePdf above.
    return Buffer.from(await page.screenshot({ type: 'jpeg', fullPage: true }));
  });
}

// docs/06-backend.md §9 — exceljs, sheet views: { rightToLeft: true }, cells: alignment:
// { readingOrder: 'rtl' }. Since the report is now a sequence of differently-shaped blocks
// (a section header, a task's 2-row header table, an "Updates" label, that task's own update
// table) rather than one flat table, this is built as a plain sequence of rows on one sheet,
// merged where a "row" is really a single full-width label — REPORT_COLUMN_COUNT (5, the
// Updates table's own width) is used as the merge span throughout so every block lines up.
async function generateExcel(data, { headerInfo }) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Task Report', { views: [{ rightToLeft: true }] });
  sheet.columns = Array.from({ length: REPORT_COLUMN_COUNT }, () => ({ width: 24 }));

  function addMergedRow(text, { bold = false, italic = false } = {}) {
    const row = sheet.addRow([text]);
    sheet.mergeCells(row.number, 1, row.number, REPORT_COLUMN_COUNT);
    const cell = row.getCell(1);
    cell.font = { bold, italic };
    cell.alignment = { readingOrder: 'rtl' };
    return row;
  }

  function addDataRow(values, { bold = false } = {}) {
    const row = sheet.addRow(values);
    row.eachCell((cell) => {
      cell.alignment = { readingOrder: 'rtl' };
      if (bold) cell.font = { bold: true };
    });
    return row;
  }

  addMergedRow(headerInfo.title, { bold: true });
  addMergedRow(headerInfo.filterDescription);
  sheet.addRow([]);

  if (data.groups.length === 0) {
    addMergedRow('No tasks found.');
  }

  data.groups.forEach((group) => {
    addMergedRow(`${group.assignee.name} — ${group.assignee.responsibility}`, { bold: true });

    group.tasks.forEach(({ task, updates }) => {
      addDataRow(TASK_HEADER_LABELS, { bold: true });
      addDataRow([task.codeNumber, task.title, formatDateShort(task.deadline), formatRemainingDaysLabel(task.timeStatus)]);

      addMergedRow('Updates', { italic: true });
      addDataRow(UPDATE_TABLE_LABELS, { bold: true });

      if (updates.length === 0) {
        addMergedRow('No updates yet');
      } else {
        updates.forEach((u) => {
          const row = addDataRow([
            formatDateShort(u.createdAt),
            u.updatedBy?.name || '-',
            u.description,
            `${u.completionPercent}%`,
            attachmentLabel(u.attachment),
          ]);
          if (u.attachment?.url) {
            const cell = row.getCell(REPORT_COLUMN_COUNT);
            cell.value = { text: attachmentLabel(u.attachment), hyperlink: u.attachment.url };
          }
        });
      }

      sheet.addRow([]);
    });
  });

  return Buffer.from(await workbook.xlsx.writeBuffer());
}

async function generateUserSummaryExcel(rows, { columns }) {
  const activeColumns = resolveColumns(columns, USER_SUMMARY_COLUMNS);
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('User Summary', { views: [{ rightToLeft: true }] });
  sheet.columns = activeColumns.map((c) => ({ header: USER_SUMMARY_COLUMN_LABELS[c], key: c, width: 18 }));

  rows.forEach((row) => {
    const rowValues = {};
    activeColumns.forEach((c) => {
      rowValues[c] = row[c];
    });
    const addedRow = sheet.addRow(rowValues);
    addedRow.eachCell((cell) => {
      cell.alignment = { readingOrder: 'rtl' };
    });
  });

  return Buffer.from(await workbook.xlsx.writeBuffer());
}

// docs/06-backend.md §9 — Word export (docx package), same grouped-by-Zimmedar structure as
// every other format: a heading + table per task inside each Zimmedar's own heading section.
function docxCell(text, { bold = false, header = false } = {}) {
  return new TableCell({
    children: [new Paragraph({ bidirectional: true, children: [new TextRun({ text: String(text ?? '-'), bold: bold || header })] })],
    shading: header ? { fill: 'EEF5EF' } : undefined,
  });
}

function docxAttachmentCell(attachment) {
  if (!attachment?.url) return docxCell(attachmentLabel(attachment));
  return new TableCell({
    children: [
      new Paragraph({
        bidirectional: true,
        children: [new ExternalHyperlink({ link: attachment.url, children: [new TextRun({ text: attachment.fileName || 'Attachment', style: 'Hyperlink' })] })],
      }),
    ],
  });
}

function docxTaskHeaderTable(task) {
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      new TableRow({ children: TASK_HEADER_LABELS.map((l) => docxCell(l, { header: true })) }),
      new TableRow({
        children: [
          docxCell(task.codeNumber),
          docxCell(task.title),
          docxCell(formatDateShort(task.deadline)),
          docxCell(formatRemainingDaysLabel(task.timeStatus)),
        ],
      }),
    ],
  });
}

function docxUpdatesTable(updates) {
  const headerRow = new TableRow({ children: UPDATE_TABLE_LABELS.map((l) => docxCell(l, { header: true })) });

  if (updates.length === 0) {
    return new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      rows: [
        headerRow,
        new TableRow({
          children: [
            new TableCell({
              columnSpan: REPORT_COLUMN_COUNT,
              children: [new Paragraph({ bidirectional: true, alignment: 'center', children: [new TextRun('No updates yet')] })],
            }),
          ],
        }),
      ],
    });
  }

  const dataRows = updates.map(
    (u) =>
      new TableRow({
        children: [
          docxCell(formatDateShort(u.createdAt)),
          docxCell(u.updatedBy?.name || '-'),
          docxCell(u.description),
          docxCell(`${u.completionPercent}%`),
          docxAttachmentCell(u.attachment),
        ],
      })
  );

  return new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: [headerRow, ...dataRows] });
}

async function generateDocx(data, { headerInfo }) {
  const children = [
    new Paragraph({ heading: HeadingLevel.HEADING_1, bidirectional: true, children: [new TextRun(headerInfo.title)] }),
    new Paragraph({ bidirectional: true, children: [new TextRun(headerInfo.filterDescription)] }),
  ];

  if (data.groups.length === 0) {
    children.push(new Paragraph({ bidirectional: true, children: [new TextRun('No tasks found.')] }));
  }

  data.groups.forEach((group) => {
    children.push(
      new Paragraph({
        heading: HeadingLevel.HEADING_2,
        bidirectional: true,
        children: [new TextRun(`${group.assignee.name} — ${group.assignee.responsibility}`)],
      })
    );

    group.tasks.forEach(({ task, updates }) => {
      children.push(docxTaskHeaderTable(task));
      children.push(new Paragraph({ heading: HeadingLevel.HEADING_4, bidirectional: true, children: [new TextRun('Updates')] }));
      children.push(docxUpdatesTable(updates));
      children.push(new Paragraph({ children: [] })); // spacer between tasks
    });
  });

  const doc = new Document({ sections: [{ children }] });
  return Packer.toBuffer(doc);
}

// Thin format dispatch, used by the controller so it stays free of business logic
// (docs/03-backend-foundation.md's controller convention). Every format renders the SAME data
// (data.groups) — no per-format branching in how the report is built, only in how it's rendered.
async function generateReportFile(data, { format, headerInfo }) {
  if (format === 'excel') return generateExcel(data, { headerInfo });
  if (format === 'docx') return generateDocx(data, { headerInfo });
  const html = renderReportHtml(data.groups, { headerInfo });
  return format === 'pdf' ? generatePdf(html) : generateJpeg(html);
}

async function generateUserSummaryFile(rows, { format, columns }) {
  if (format === 'excel') return generateUserSummaryExcel(rows, { columns });
  const html = renderUserSummaryHtml(rows, { columns });
  return format === 'pdf' ? generatePdf(html) : generateJpeg(html);
}

module.exports = {
  buildReportData,
  buildHeaderInfo,
  groupTasksByAssignee,
  renderReportHtml,
  renderUserSummaryHtml,
  buildUserSummaryData,
  generatePdf,
  generateJpeg,
  generateExcel,
  generateDocx,
  generateUserSummaryExcel,
  generateReportFile,
  generateUserSummaryFile,
  buildFilterDescription,
  formatRemainingDaysLabel,
};
