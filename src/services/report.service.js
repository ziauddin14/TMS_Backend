require('../config/env');
// puppeteer ships as an ESM-only package (no CommonJS entry point) as of the installed version —
// the rest of this backend is CommonJS throughout, so it's loaded via a lazy dynamic import()
// (Node's standard, documented CJS-consuming-ESM interop) inside withBrowserPage below, rather
// than a top-level require() here, which would throw a SyntaxError on 'export * from ...'.
const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');
const {
  Document,
  Packer,
  Paragraph,
  Table,
  TableRow,
  TableCell,
  HeadingLevel,
  ExternalHyperlink,
  TextRun,
  ImageRun,
  AlignmentType,
  BorderStyle,
  WidthType,
} = require('docx');
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

// Prompt — Dawat-e-Islami brand green, already defined as `brand.DEFAULT` in
// frontend/tailwind.config.js; read once at module load (small, 8KB PNG) rather than per-request.
// Copied into the backend's OWN assets (not read from ../frontend/...) so this works regardless
// of how backend/frontend are deployed relative to each other — see the chat report for the exact
// source path this was copied from.
const BRAND_GREEN = '1F6F3F';
const LOGO_PATH = path.join(__dirname, '../assets/logo.png');
const LOGO_BUFFER = fs.readFileSync(LOGO_PATH);
const LOGO_BASE64 = LOGO_BUFFER.toString('base64');

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
// (html->pdf/jpeg, excel, docx) renders the SAME two tables per task, in this order. Prompt —
// exact Urdu terms as given, not invented translations; do not add/rename without being handed
// the replacement term explicitly.
const TASK_HEADER_LABELS = ['کام کوڈ', 'کام', 'آخری تاریخ', 'باقی دن'];
const UPDATE_TABLE_LABELS = ['تاریخ', 'رپلائی کرنے والا', 'وضاحت', 'تکمیل فیصد', 'اٹیچمنٹ'];
const UPDATES_HEADING = 'اپڈیٹس';
const ASSIGNEE_LABEL = 'ذمہ دار';
const RESPONSIBILITY_LABEL = 'ذمہ داری';
const BRAND_TITLE = 'ٹاسک مینجمنٹ سسٹم';
const GENERATED_BY_LABEL = 'رپورٹ جنریٹ کرنے والا';
const GENERATED_AT_LABEL = 'رپورٹ کی تاریخ';
const REPORT_COLUMN_COUNT = UPDATE_TABLE_LABELS.length; // the widest of the two tables — used for merges/spans

function resolveColumns(requested, allColumns) {
  if (!requested || requested.length === 0) return allColumns;
  return allColumns.filter((c) => requested.includes(c));
}

function escapeHtml(str) {
  const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return String(str ?? '').replace(/[&<>"']/g, (c) => map[c]);
}

// Prompt — found by actually looking at the rendered JPEG, not by reading the HTML string: a
// date like "01 Sep 26" (three separate LTR runs, space-separated) sitting inside an RTL-
// direction page gets its own runs REORDERED right-to-left by the browser's bidi algorithm —
// rendering as "Sep 26 01". Same thing happens to "ذمہ دار: Ali Raza" (Urdu label + LTR value):
// the whole LTR run gets repositioned to the visual left of the label it belongs after. <bdi>
// (HTML5's dedicated bidirectional-isolation element) stops the surrounding RTL paragraph from
// reordering an embedded run at all — every piece of value text below (dates, names, numbers,
// free-text descriptions/titles that might be English) is wrapped in it, never the static Urdu
// labels themselves, which are already correctly RTL on their own.
function bdi(escapedHtml) {
  return `<bdi>${escapedHtml}</bdi>`;
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
//
// Prompt — now also carries the branded report header's own two lines: who generated it
// (req.user — already carries name/responsibility off the verified JWT + DB lookup, see
// auth.middleware.js, so this is never client-supplied) and when. Every format's own renderer
// reads generatedByLine/generatedAtLabel off this same object — one source of truth, not
// duplicated per format.
function buildHeaderInfo(requestingUser, filters) {
  return {
    title: 'Task Report',
    filterDescription: buildFilterDescription(filters),
    generatedByLine: `${requestingUser.name} (${requestingUser.responsibility})`,
    generatedAtLabel: formatDateShort(new Date()),
  };
}

// "Baqi Din" (Remaining Days) — reuses the task's own already-computed timeStatus
// (task.service.js's computeTimeStatus), phrased the same way the frontend's
// formatTimeStatusLabel (frontend/src/utils/formatDate.js) reads it, just in English to match
// this document's existing label convention (this specific phrase wasn't in the client's given
// Urdu term list, so it stays as-is rather than inventing a translation for it).
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
//
// Prompt — the branded header/table styling below is scoped under `.task-report` on purpose:
// this shell is shared with renderUserSummaryHtml (a separate, untouched report), and bare
// `th`/`h1`/`h2` selectors would have silently reskinned that report too.
function htmlDocument(title, bodyHtml) {
  return `<!doctype html>
<html dir="rtl" lang="ur">
<head>
<meta charset="utf-8" />
<title>${escapeHtml(title)}</title>
<style>
  /* background: #fff is required, not decorative — page.screenshot({type:'jpeg'}) has no alpha
     channel, so an unset (transparent) page background flattens to BLACK in the .jpg export
     specifically (PDF happened to look fine without it; JPEG did not — caught by actually
     opening the generated .jpg, not by reading the HTML/CSS). */
  body { font-family: 'Jameel Noori Nastaleeq', 'Noto Nastaliq Urdu', 'Noto Sans Arabic', serif; direction: rtl; margin: 24px; background: #fff; }
  /* Found by zooming into a generated image, not by reading this CSS: whatever Nastaliq/Arabic
     font this environment actually falls back to (the real Jameel Noori Nastaleeq font isn't
     shipped yet — see the comment on htmlDocument()) silently drops the space between a digit
     and the following Latin letter at a <bdi> isolation boundary — "09 Sep 26" rendered as
     "09Sep 26". <bdi> only ever wraps Latin/numeric data values (dates, code numbers, English
     names) in this document, never Urdu text, so it's safe — and fixes the spacing — to give it
     an ordinary Latin font instead of inheriting the Nastaliq stack. */
  bdi { font-family: Arial, Helvetica, sans-serif; }
  h1 { font-size: 20px; margin-bottom: 4px; }
  p.filter-description { color: #555; margin: 4px 0 16px; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 4px; }
  th, td { border: 1px solid #ccc; padding: 6px; text-align: right; font-size: 12px; }
  th { background: #eef5ef; }
  h4.updates-heading { font-size: 13px; margin: 4px 0; }
  table.updates-table { margin-bottom: 16px; }
  td.empty-updates { text-align: center; color: #777; }

  .task-report .brand-header { text-align: center; margin-bottom: 12px; }
  .task-report .brand-logo { width: 64px; height: 64px; display: block; margin: 0 auto 8px; }
  .task-report .brand-title { color: #${BRAND_GREEN}; font-size: 24px; font-weight: bold; margin: 0 0 8px; }
  .task-report .brand-meta { font-size: 12px; color: #333; margin: 2px 0; }
  .task-report .brand-divider { border: none; border-top: 3px solid #${BRAND_GREEN}; margin: 12px 0 16px; }
  .task-report h1.report-title { color: #${BRAND_GREEN}; text-align: center; }
  .task-report h2.assignee-header { font-size: 16px; margin: 20px 0 8px; padding-bottom: 4px; color: #${BRAND_GREEN}; border-bottom: 2px solid #${BRAND_GREEN}; }
  /* th declared AFTER, and deliberately not scoped away from table.task-header: every table
     header row (the 2-row task-header table's own header included) gets the same brand-green
     fill + white text; task-header's own DATA row (below it) keeps its light-gray tint. Caught
     via a zoomed screenshot: an earlier, narrower task-header-th-specific rule set only the
     background back to light gray while still inheriting white text from this rule — nearly
     invisible white-on-light-gray column labels that no amount of reading the CSS source would
     have surfaced, only actually looking at the rendered image did. */
  .task-report table.task-header td { background: #f5f5f5; }
  .task-report th { background: #${BRAND_GREEN}; color: #fff; }
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
  return attachment.url ? `<a href="${escapeHtml(attachment.url)}">${bdi(label)}</a>` : bdi(label);
}

function renderUpdateRowHtml(update) {
  return `<tr>
<td>${bdi(escapeHtml(formatDateShort(update.createdAt)))}</td>
<td>${bdi(escapeHtml(update.updatedBy?.name))}</td>
<td>${bdi(escapeHtml(update.description))}</td>
<td>${bdi(`${update.completionPercent}%`)}</td>
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
<td>${bdi(escapeHtml(task.codeNumber))}</td>
<td>${bdi(escapeHtml(task.title))}</td>
<td>${bdi(escapeHtml(formatDateShort(task.deadline)))}</td>
<td>${bdi(escapeHtml(formatRemainingDaysLabel(task.timeStatus)))}</td>
</tr></tbody>
</table>
<h4 class="updates-heading">${escapeHtml(UPDATES_HEADING)}</h4>
<table class="updates-table">
<thead><tr>${UPDATE_TABLE_LABELS.map((l) => `<th>${escapeHtml(l)}</th>`).join('')}</tr></thead>
<tbody>${updatesRows}</tbody>
</table>`;
}

// docs/06-backend.md §9 (rewritten) — builds the HTML string rendered by generatePdf/generateJpeg.
// Prompt — the branded header (logo, app name, "generated by"/"generated at") now sits above the
// existing title/filter-description block, once per document (not repeated per group/task).
function renderReportHtml(groups, { headerInfo }) {
  const groupsHtml =
    groups.length > 0
      ? groups
          .map(
            (group) => `
<h2 class="assignee-header">${escapeHtml(ASSIGNEE_LABEL)}: ${bdi(escapeHtml(group.assignee.name))} — ${escapeHtml(RESPONSIBILITY_LABEL)}: ${bdi(escapeHtml(group.assignee.responsibility))}</h2>
${group.tasks.map(({ task, updates }) => renderTaskBlockHtml(task, updates)).join('')}`
          )
          .join('')
      : '<p>No tasks found.</p>';

  const body = `
<div class="task-report">
<div class="brand-header">
<img class="brand-logo" src="data:image/png;base64,${LOGO_BASE64}" alt="Dawat-e-Islami" />
<div class="brand-title">${escapeHtml(BRAND_TITLE)}</div>
<p class="brand-meta">${escapeHtml(GENERATED_BY_LABEL)}: ${bdi(escapeHtml(headerInfo.generatedByLine))}</p>
<p class="brand-meta">${escapeHtml(GENERATED_AT_LABEL)}: ${bdi(escapeHtml(headerInfo.generatedAtLabel))}</p>
</div>
<hr class="brand-divider" />
<h1 class="report-title">${bdi(escapeHtml(headerInfo.title))}</h1>
<p class="filter-description">${bdi(escapeHtml(headerInfo.filterDescription))}</p>
${groupsHtml}
</div>`;

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
// (a branded header, a section header, a task's 2-row header table, an "Updates" label, that
// task's own update table) rather than one flat table, this is built as a plain sequence of rows
// on one sheet, merged where a "row" is really a single full-width label —
// REPORT_COLUMN_COUNT (5, the Updates table's own width) is used as the merge span throughout so
// every block lines up.
const THIN_GRAY_BORDER = { style: 'thin', color: { argb: 'FFCCCCCC' } };

async function generateExcel(data, { headerInfo }) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Task Report', { views: [{ rightToLeft: true }] });
  // Prompt — a uniform width looked fine with no borders (overflow silently bled into the next,
  // empty-looking cell) but clipped mid-word the moment real borders (above) made that overflow
  // stop being possible ("Zone 3" clipped to "Z" against the Code Number column). The task-header
  // and Updates tables share these same 5 physical columns for merge-span purposes but don't
  // agree on what each column MEANS (column 2 is "Task" in one, "Updated By" in the other; column
  // 3 is "Deadline" in one, "Description" in the other) — column 2/3 are widened generously to
  // cover whichever long-text field lands there, and every data cell wraps text besides.
  sheet.columns = [14, 40, 30, 18, 20].map((width) => ({ width }));

  // Prompt — found by exporting an actual sheet to PDF via Excel itself (real Excel, not just
  // ExcelJS's own writer) and looking at it, twice over:
  // 1. No border was ever set on any cell — Excel only shows its on-screen gridlines when a
  //    workbook is opened live; export/print drops them by default, so adjacent cells' text
  //    (e.g. a task title right next to its Code Number) visually ran together with no
  //    separator at all. Every cell below gets an explicit thin gray border.
  // 2. Real Excel applies the SAME bidi reordering a browser does to an RTL cell's content:
  //    "01 Sep 26" (digits + letters + digits, several separate runs) came out as "Sep 26 01".
  //    ExcelJS's alignment.readingOrder is a per-CELL, binary rtl/ltr switch (no HTML-<bdi>-style
  //    per-span isolation exists in the xlsx format) — ltrColumns below marks exactly the
  //    columns whose values are ALWAYS system-generated Latin/numeric data (dates, code numbers,
  //    the remaining-days label, completion %), forcing just those to readingOrder:'ltr'. Free
  //    text the admin/user actually typed (task title, description, a person's name) is left at
  //    the sheet's default 'rtl' — it's just as likely to genuinely be Urdu, and forcing it 'ltr'
  //    would flip THAT case instead.
  function addMergedRow(text, { bold = false, italic = false, size, color, align = 'right', readingOrder = 'rtl' } = {}) {
    const row = sheet.addRow([text]);
    sheet.mergeCells(row.number, 1, row.number, REPORT_COLUMN_COUNT);
    const cell = row.getCell(1);
    cell.font = { bold, italic, size, color: color ? { argb: color } : undefined };
    cell.alignment = { readingOrder, horizontal: align };
    cell.border = { top: THIN_GRAY_BORDER, bottom: THIN_GRAY_BORDER, left: THIN_GRAY_BORDER, right: THIN_GRAY_BORDER };
    return row;
  }

  function addDataRow(values, { bold = false, header = false, ltrColumns = [] } = {}) {
    const row = sheet.addRow(values);
    row.eachCell((cell, colNumber) => {
      cell.alignment = { readingOrder: ltrColumns.includes(colNumber) ? 'ltr' : 'rtl', wrapText: !header };
      cell.border = { top: THIN_GRAY_BORDER, bottom: THIN_GRAY_BORDER, left: THIN_GRAY_BORDER, right: THIN_GRAY_BORDER };
      if (header) {
        cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: `FF${BRAND_GREEN}` } };
      } else if (bold) {
        cell.font = { bold: true };
      }
    });
    return row;
  }

  // Branded header — logo anchored top-start of the sheet, brand name + generated-by/at lines
  // centered underneath, same info every other format's own header carries. The "generated at"
  // line is split into two cells (label merged across most of the row, the date alone in its own
  // ltr cell) rather than one merged label+value string, for the same bidi reason as above — a
  // single shared cell has only one readingOrder for its whole content, so it can't isolate just
  // the date the way the other two (digit-free) header lines don't need to.
  const logoImageId = workbook.addImage({ buffer: LOGO_BUFFER, extension: 'png' });
  sheet.addImage(logoImageId, { tl: { col: 0, row: 0 }, ext: { width: 56, height: 56 } });
  [1, 2, 3, 4].forEach((rowNum) => {
    sheet.getRow(rowNum).height = 20;
  });
  addMergedRow(BRAND_TITLE, { bold: true, size: 16, color: `FF${BRAND_GREEN}`, align: 'center' });
  addMergedRow(`${GENERATED_BY_LABEL}: ${headerInfo.generatedByLine}`, { size: 10, align: 'center' });
  {
    const dateRow = sheet.addRow([`${GENERATED_AT_LABEL}:`, null, null, null, headerInfo.generatedAtLabel]);
    sheet.mergeCells(dateRow.number, 1, dateRow.number, REPORT_COLUMN_COUNT - 1);
    const labelCell = dateRow.getCell(1);
    labelCell.font = { size: 10 };
    labelCell.alignment = { readingOrder: 'rtl', horizontal: 'center' };
    const valueCell = dateRow.getCell(REPORT_COLUMN_COUNT);
    valueCell.font = { size: 10 };
    valueCell.alignment = { readingOrder: 'ltr', horizontal: 'center' };
  }
  sheet.addRow([]);

  addMergedRow(headerInfo.title, { bold: true, color: `FF${BRAND_GREEN}` });
  addMergedRow(headerInfo.filterDescription);
  sheet.addRow([]);

  if (data.groups.length === 0) {
    addMergedRow('No tasks found.');
  }

  data.groups.forEach((group) => {
    addMergedRow(`${ASSIGNEE_LABEL}: ${group.assignee.name} — ${RESPONSIBILITY_LABEL}: ${group.assignee.responsibility}`, {
      bold: true,
      color: `FF${BRAND_GREEN}`,
    });

    group.tasks.forEach(({ task, updates }) => {
      addDataRow(TASK_HEADER_LABELS, { header: true });
      addDataRow([task.codeNumber, task.title, formatDateShort(task.deadline), formatRemainingDaysLabel(task.timeStatus)], {
        ltrColumns: [1, 3, 4],
      });

      addMergedRow(UPDATES_HEADING, { italic: true, color: `FF${BRAND_GREEN}` });
      addDataRow(UPDATE_TABLE_LABELS, { header: true });

      if (updates.length === 0) {
        addMergedRow('No updates yet');
      } else {
        updates.forEach((u) => {
          const row = addDataRow(
            [formatDateShort(u.createdAt), u.updatedBy?.name || '-', u.description, `${u.completionPercent}%`, attachmentLabel(u.attachment)],
            { ltrColumns: [1, 4] }
          );
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

// docs/06-backend.md §9 — Word export (docx package), same grouped-by-Zimmedar structure, same
// Urdu labels, same brand-green/logo header as every other format.
function docxCell(text, { bold = false, header = false } = {}) {
  return new TableCell({
    children: [
      new Paragraph({
        bidirectional: true,
        children: [new TextRun({ text: String(text ?? '-'), bold: bold || header, color: header ? 'FFFFFF' : undefined })],
      }),
    ],
    shading: header ? { fill: BRAND_GREEN } : undefined,
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
              children: [new Paragraph({ bidirectional: true, alignment: AlignmentType.CENTER, children: [new TextRun('No updates yet')] })],
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

function docxBrandHeaderParagraphs(headerInfo) {
  return [
    new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [new ImageRun({ type: 'png', data: LOGO_BUFFER, transformation: { width: 56, height: 56 } })],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      bidirectional: true,
      children: [new TextRun({ text: BRAND_TITLE, bold: true, size: 32, color: BRAND_GREEN })],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      bidirectional: true,
      children: [new TextRun({ text: `${GENERATED_BY_LABEL}: ${headerInfo.generatedByLine}`, size: 20 })],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      bidirectional: true,
      children: [new TextRun({ text: `${GENERATED_AT_LABEL}: ${headerInfo.generatedAtLabel}`, size: 20 })],
    }),
    new Paragraph({
      border: { bottom: { color: BRAND_GREEN, space: 4, style: BorderStyle.SINGLE, size: 12 } },
      children: [],
    }),
    new Paragraph({
      heading: HeadingLevel.HEADING_1,
      alignment: AlignmentType.CENTER,
      bidirectional: true,
      children: [new TextRun({ text: headerInfo.title, color: BRAND_GREEN })],
    }),
    new Paragraph({ alignment: AlignmentType.CENTER, bidirectional: true, children: [new TextRun(headerInfo.filterDescription)] }),
  ];
}

async function generateDocx(data, { headerInfo }) {
  const children = docxBrandHeaderParagraphs(headerInfo);

  if (data.groups.length === 0) {
    children.push(new Paragraph({ bidirectional: true, children: [new TextRun('No tasks found.')] }));
  }

  data.groups.forEach((group) => {
    children.push(
      new Paragraph({
        heading: HeadingLevel.HEADING_2,
        bidirectional: true,
        children: [
          new TextRun({
            text: `${ASSIGNEE_LABEL}: ${group.assignee.name} — ${RESPONSIBILITY_LABEL}: ${group.assignee.responsibility}`,
            color: BRAND_GREEN,
            bold: true,
          }),
        ],
      })
    );

    group.tasks.forEach(({ task, updates }) => {
      children.push(docxTaskHeaderTable(task));
      children.push(
        new Paragraph({
          heading: HeadingLevel.HEADING_4,
          bidirectional: true,
          children: [new TextRun({ text: UPDATES_HEADING, color: BRAND_GREEN, bold: true })],
        })
      );
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
