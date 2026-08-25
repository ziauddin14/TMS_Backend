require('../config/env');
// puppeteer ships as an ESM-only package (no CommonJS entry point) as of the installed version —
// the rest of this backend is CommonJS throughout, so it's loaded via a lazy dynamic import()
// (Node's standard, documented CJS-consuming-ESM interop) inside withBrowserPage below, rather
// than a top-level require() here, which would throw a SyntaxError on 'export * from ...'.
const ExcelJS = require('exceljs');
const logger = require('../utils/logger');
const TaskUpdate = require('../models/TaskUpdate');
const User = require('../models/User');
const taskService = require('./task.service');
const dashboardService = require('./dashboard.service');

// "Unpaginated, all matching rows" (docs/06-backend.md §9) implemented by calling the existing,
// unmodified listTasks with a limit far beyond this project's confirmed scale (docs/01-architecture.md
// §9: ~20-25 users, small task volume) — not a new "no pagination" mode added to listTasks itself.
const UNPAGINATED_LIMIT = 100000;

const TASK_COLUMNS = ['codeNumber', 'title', 'assignees', 'responsibility', 'deadline', 'status', 'timeStatus', 'completionPercent', 'performanceRating'];
const TASK_COLUMN_LABELS = {
  codeNumber: 'Code Number',
  title: 'Task',
  assignees: 'Zimmedar(an)',
  responsibility: 'Zimmedari',
  deadline: 'Deadline',
  status: 'Status',
  timeStatus: 'Time Status',
  completionPercent: 'Completion %',
  performanceRating: 'Performance',
};

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

function resolveColumns(requested, allColumns) {
  if (!requested || requested.length === 0) return allColumns;
  return allColumns.filter((c) => requested.includes(c));
}

function escapeHtml(str) {
  const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return String(str ?? '').replace(/[&<>"']/g, (c) => map[c]);
}

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

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

/**
 * docs/06-backend.md §9: "Task Report" title; relevant task name/responsibility if the result is
 * a single task, or "All Responsible" if it spans multiple; the filter description above, or
 * "All Data" if none applied. Pure function — no DB access — so header-wording branches are
 * directly testable without generating an actual report file (per the Phase 8 testing instructions).
 */
function buildHeaderInfo(tasks, filters) {
  const subject = tasks.length === 1 ? `${tasks[0].title} (${tasks[0].responsibility})` : 'All Responsible';
  return {
    title: 'Task Report',
    subject,
    filterDescription: buildFilterDescription(filters),
  };
}

function getTaskCellValue(task, column) {
  switch (column) {
    case 'assignees':
      return task.assignees.map((a) => a.name).join(', ');
    case 'deadline':
      return new Date(task.deadline).toLocaleDateString();
    case 'timeStatus':
      return `${task.timeStatus.type} (${task.timeStatus.days}d)`;
    case 'completionPercent':
      return `${task.completionPercent}%`;
    default:
      return String(task[column] ?? '');
  }
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
  h2 { font-size: 16px; font-weight: normal; margin: 4px 0; }
  p.filter-description { color: #555; margin: 4px 0 16px; }
  table { width: 100%; border-collapse: collapse; }
  th, td { border: 1px solid #ccc; padding: 6px; text-align: right; font-size: 12px; }
  th { background: #eef5ef; }
  tr.update-row td { background: #f9f9f9; font-size: 11px; color: #333; }
</style>
</head>
<body>
${bodyHtml}
</body>
</html>`;
}

// docs/06-backend.md §9 — builds the HTML string rendered by generatePdf/generateJpeg.
function renderReportHtml(data, { columns, headerInfo }) {
  const activeColumns = resolveColumns(columns, TASK_COLUMNS);
  const headRow = activeColumns.map((c) => `<th>${escapeHtml(TASK_COLUMN_LABELS[c])}</th>`).join('');

  const bodyRows = data.tasks
    .map(({ task, updates }) => {
      const cells = activeColumns.map((c) => `<td>${escapeHtml(getTaskCellValue(task, c))}</td>`).join('');
      let row = `<tr>${cells}</tr>`;
      if (data.reportType === 'detailed') {
        row += updates
          .map(
            (u) =>
              `<tr class="update-row"><td colspan="${activeColumns.length}">${new Date(u.createdAt).toLocaleString()} — ${escapeHtml(u.updatedBy?.name)}: ${escapeHtml(u.description)} (${u.completionPercent}%)</td></tr>`
          )
          .join('');
      }
      return row;
    })
    .join('');

  const body = `
<h1>${escapeHtml(headerInfo.title)}</h1>
<h2>${escapeHtml(headerInfo.subject)}</h2>
<p class="filter-description">${escapeHtml(headerInfo.filterDescription)}</p>
<table><thead><tr>${headRow}</tr></thead><tbody>${bodyRows}</tbody></table>`;

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

// docs/06-backend.md §9 step 1 — reuses task.service.listTasks (unmodified), unpaginated, same
// RBAC scoping as GET /tasks. If detailed, also fetches every matching task's full update
// history via the same underlying query taskUpdate.service.js's listUpdates uses — not via
// listUpdates itself, since that re-runs a per-task ownership check (already redundant: listTasks
// already scoped the task set) and paginates (a report needs the FULL history, not one page).
async function buildReportData(requestingUser, filters, reportType) {
  const { items: tasks } = await taskService.listTasks(requestingUser, filters, {
    page: 1,
    limit: UNPAGINATED_LIMIT,
    sortBy: filters.sortBy,
    sortOrder: filters.sortOrder,
  });

  let updatesByTaskId = {};
  if (reportType === 'detailed' && tasks.length > 0) {
    const taskIds = tasks.map((t) => t._id);
    const allUpdates = await TaskUpdate.find({ taskId: { $in: taskIds } })
      .sort({ createdAt: -1 })
      .populate('updatedBy', 'name role');
    allUpdates.forEach((u) => {
      const key = u.taskId.toString();
      (updatesByTaskId[key] ||= []).push(u);
    });
  }

  return {
    tasks: tasks.map((task) => ({ task, updates: updatesByTaskId[task.id] || [] })),
    reportType,
  };
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
  // Full `puppeteer` (not `puppeteer-core`) ships its own bundled Chromium and resolves it
  // automatically — this code never sets `executablePath` in launchOptions (removed the
  // `if (process.env.PUPPETEER_EXECUTABLE_PATH)` override that used to be here).
  //
  // IMPORTANT — this code-level fix is NOT sufficient on its own if PUPPETEER_EXECUTABLE_PATH is
  // set as an actual environment variable (Render dashboard, shell, etc.): puppeteer's own
  // getConfiguration() (node_modules/puppeteer/lib/puppeteer/getConfiguration.js) reads that env
  // var directly from process.env and threads it through BrowserLauncher.resolveExecutablePath()
  // as the browser's default executablePath — entirely independent of whatever this file's
  // launchOptions object contains. Confirmed locally: even with no code-level override, this
  // process still launches the Chrome at backend/.env.test's PUPPETEER_EXECUTABLE_PATH, because
  // puppeteer reads it internally. If Render's production environment has this variable set
  // (to the Windows-only path from .env.test, or anything else), it MUST be removed from Render's
  // own environment-variable dashboard — no code change here can override puppeteer's own env-var
  // resolution. The debug line below prints the actual resolved path on every export so Render's
  // logs give direct proof of what's happening at runtime; remove it once confirmed fixed there.
  console.log('[DEBUG] Puppeteer executablePath resolved to:', await puppeteer.executablePath());
  const fs = require('fs');
  const cacheDir = process.env.PUPPETEER_CACHE_DIR || '/opt/render/.cache/puppeteer';
  try {
    console.log('[DEBUG] PUPPETEER_CACHE_DIR env:', process.env.PUPPETEER_CACHE_DIR);
    console.log('[DEBUG] Cache dir exists?', cacheDir, fs.existsSync(cacheDir));
    if (fs.existsSync(cacheDir)) {
      console.log('[DEBUG] Cache dir full contents:', JSON.stringify(fs.readdirSync(cacheDir, { recursive: true })));
    }
  } catch (e) {
    console.log('[DEBUG] Error reading cache dir:', e.message);
  }
  const launchOptions = {
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  };
  let browser;
  try {
    browser = await puppeteer.launch(launchOptions);
  } catch (launchError) {
    logger.error('Puppeteer browser launch failed:', launchError);
    console.error('Puppeteer browser launch failed stack:', launchError.stack || launchError);
    throw launchError;
  }

  try {
    const page = await browser.newPage();
    return await fn(page);
  } catch (pageError) {
    logger.error('Puppeteer report generation failed on page:', pageError);
    console.error('Puppeteer report generation failed stack:', pageError.stack || pageError);
    throw pageError;
  } finally {
    if (browser) {
      await browser.close().catch((closeError) => {
        logger.error('Failed to close Puppeteer browser:', closeError);
        console.error('Failed to close Puppeteer browser stack:', closeError.stack || closeError);
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

// docs/06-backend.md §9 — exceljs, sheet views: { rightToLeft: true }, Urdu cells:
// alignment: { readingOrder: 'rtl' }.
async function generateExcel(data, { columns }) {
  const activeColumns = resolveColumns(columns, TASK_COLUMNS);
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Tasks', { views: [{ rightToLeft: true }] });
  sheet.columns = activeColumns.map((c) => ({ header: TASK_COLUMN_LABELS[c], key: c, width: 22 }));

  data.tasks.forEach(({ task }) => {
    const rowValues = {};
    activeColumns.forEach((c) => {
      rowValues[c] = getTaskCellValue(task, c);
    });
    const row = sheet.addRow(rowValues);
    row.eachCell((cell) => {
      cell.alignment = { readingOrder: 'rtl' };
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

// Thin format dispatch, used by the controller so it stays free of business logic
// (docs/03-backend-foundation.md's controller convention).
async function generateReportFile(data, { format, columns, headerInfo }) {
  if (format === 'excel') return generateExcel(data, { columns });
  const html = renderReportHtml(data, { columns, headerInfo });
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
  renderReportHtml,
  renderUserSummaryHtml,
  buildUserSummaryData,
  generatePdf,
  generateJpeg,
  generateExcel,
  generateUserSummaryExcel,
  generateReportFile,
  generateUserSummaryFile,
  buildFilterDescription,
};
