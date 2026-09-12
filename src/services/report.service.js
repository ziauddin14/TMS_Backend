require('../config/env');
// puppeteer ships as an ESM-only package (no CommonJS entry point) as of the installed version —
// the rest of this backend is CommonJS throughout, so it's loaded via a lazy dynamic import()
// (Node's standard, documented CJS-consuming-ESM interop) inside withBrowserPage below, rather
// than a top-level require() here, which would throw a SyntaxError on 'export * from ...'.
const fs = require('fs');
const os = require('os');
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
const { formatDateShort } = require('../utils/formatDate');

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

// Prompt — the real Jameel Noori Nastaleeq font file still doesn't exist anywhere in this
// project (frontend/src/assets/fonts/README.md has flagged this as a client-provided-later gap
// since Phase 8); asked directly, the client chose a working substitute now over broken glyphs.
// "Noto Nastaliq Urdu" (Google Fonts, SIL Open Font License — free to embed/redistribute) is a
// COMPLETE Nastaliq font, unlike whatever partial/absent Arabic-script font Puppeteer's headless
// Chromium and a viewer's Word happened to fall back to in production — that's what was actually
// dropping "ہ"/mangling "آ", not a wrong font NAME. Swap in the real file at the paths below
// (same names) the moment the client provides it; nothing else needs to change.
const NASTALIQ_FONT_NAME = 'Noto Nastaliq Urdu';
const NASTALIQ_WOFF2_BASE64 = fs.readFileSync(path.join(__dirname, '../assets/fonts/NotoNastaliqUrdu-Regular.woff2')).toString('base64');
const NASTALIQ_TTF_BUFFER = fs.readFileSync(path.join(__dirname, '../assets/fonts/NotoNastaliqUrdu-Regular.ttf'));

// Prompt — ROOT-CAUSE fix for the "□ square boxes in the Urdu PDF" bug (PDF-specific — JPEG/DOCX
// were never affected, which was the exact clue). Inspected the generated PDF's own internal
// structure with pikepdf/fontTools, not just eyeballing a screenshot: Chromium's Skia PDF backend
// embeds a normal system font (e.g. Arial, used for <bdi>'s Latin runs) as a real Type0/
// CIDFontType2 font with genuine outline data — but a font loaded only via @font-face (our
// Nastaliq WOFF2 data: URI) gets embedded as a Type3 font instead: every individual glyph becomes
// its own tiny vector-drawing procedure, with NO real cmap/glyf font program backing it. Type3 is
// fragile — Chrome's own PDF.js viewer tolerates it (which is why testing only that way never
// showed the bug), but stricter PDF readers render an unrecognized/malformed Type3 CharProc as a
// missing-glyph box. Verified the fix directly: installing this exact font as a genuine OS font
// (not @font-face) and re-generating made Chromium embed it as a proper CIDFontType2 with real
// FontFile2 TrueType data — no Type3, no boxes, confirmed by re-inspecting the PDF's font
// resources. JAMEEL_NOORI_TTF_BUFFER below is the SAME Noto Nastaliq Urdu font file with only its
// internal name-table renamed (via fontTools) to 'Jameel Noori Nastaleeq', so installing it under
// that exact name is honest, not a rebrand of a different font.
const JAMEEL_NOORI_FONT_NAME = 'Jameel Noori Nastaleeq';
const JAMEEL_NOORI_TTF_PATH = path.join(__dirname, '../assets/fonts/JameelNooriNastaleeq.ttf');
const JAMEEL_NOORI_FONTS_DIR = path.dirname(JAMEEL_NOORI_TTF_PATH);

// Prompt — makes Chromium treat the bundled TTF as a genuine installed OS font (see the big
// comment above for why that's what actually avoids the Type3/box bug), without needing root
// access to write into /usr/share/fonts or requiring the `fc-cache` CLI tool to exist in
// production's container at all: fontconfig (which Chromium already links against on Linux to
// enumerate fonts — that's how it finds Arial/Times New Roman today) reads its config from
// FONTCONFIG_FILE if that env var is set, and can scan a plain directory listed in <dir> live,
// with no prebuilt cache required, for a single extra font. <include ignore_missing="yes"> chains
// in the host's own default config (when present) so every OTHER font Chromium already resolves
// (fallback serif/sans-serif, Arial, etc.) keeps working exactly as before — this only ADDS one
// font, it doesn't replace the system's font configuration. <cachedir> points at the OS temp dir
// (always writable) rather than anywhere under the read-only-in-production font/config paths.
// Harmless on Windows/macOS dev machines too: those platforms don't use fontconfig, so Chromium
// simply ignores an env var it has no use for, and CSS falls through to the @font-face-embedded
// 'Noto Nastaliq Urdu' below instead (unchanged safety net — see htmlDocument's font-family stack
// and generateDocx's own font embedding, neither of which depend on this).
function buildFontconfigEnv() {
  const cacheDir = path.join(os.tmpdir(), 'tms-report-fontconfig-cache');
  fs.mkdirSync(cacheDir, { recursive: true });
  const fontsConfPath = path.join(os.tmpdir(), 'tms-report-fonts.conf');
  const fontsConfXml = `<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "fonts.dtd">
<fontconfig>
  <include ignore_missing="yes">/etc/fonts/fonts.conf</include>
  <dir>${JAMEEL_NOORI_FONTS_DIR}</dir>
  <cachedir>${cacheDir}</cachedir>
</fontconfig>
`;
  fs.writeFileSync(fontsConfPath, fontsConfXml);
  return { FONTCONFIG_FILE: fontsConfPath };
}

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

// Grouped task report's fixed task-summary columns. Prompt — client's explicit, "LOCKED" column
// spec for the manual-office-report digitization: exact labels AND order — کوڈ, کام کی تفصیل,
// باقی دن, آخری تاریخ (renamed/reordered from this project's earlier کام کوڈ/کام/آخری
// تاریخ/باقی دن — flagging the discrepancy here rather than silently carrying the old wording,
// per this project's own "surface doc/data contradictions" convention). HTML/PDF/JPEG and DOCX
// both render these 4 columns in this literal array order (see renderTaskBlockHtml/
// docxTaskHeaderTable); generateExcel (untouched/out of scope for this request) also reads this
// same array for its own header row, so its hardcoded data-row value order was updated to match —
// see its own comment — purely to avoid a header/data column mismatch, not a scope expansion.
const TASK_HEADER_LABELS = ['کوڈ', 'کام کی تفصیل', 'باقی دن', 'آخری تاریخ'];
// Prompt — client's latest, explicit spec: Updates go back to ONE table per task (the
// card/conversation-block layout from the previous request is gone), with EXACTLY these 4
// columns — تاریخ, اپڈیٹ کرنے والا ("Updated By", renamed from the older "رپلائی کرنے والا"),
// وضاحت, تکمیل فیصد. No 5th اٹیچمنٹ column this time; an attachment is folded into the وضاحت
// cell instead (see renderUpdateRowHtml/docxUpdateRow) — "compact inside the appropriate cell,"
// per the client's own wording, not dropped.
//
// Column order — the client's message gave two different orderings for this table (the numbered
// list here vs. a separate "RIGHT → LEFT" line that listed the same four columns reversed); this
// was flagged back to the client and explicitly confirmed: keep the numbered-list order below
// (تاریخ→اپڈیٹ کرنے والا→وضاحت→تکمیل فیصد, i.e. when → who → what → completion), matching this
// project's established "first array element = rightmost column" convention.
const UPDATE_TABLE_LABELS = ['تاریخ', 'اپڈیٹ کرنے والا', 'وضاحت', 'تکمیل فیصد'];
const UPDATE_ATTACHMENT_LABEL = 'اٹیچمنٹ';
// Prompt — generateExcel's own Updates table was NOT part of this request (Excel hasn't been
// mentioned in any of the last several report-generation prompts) and keeps its original,
// unrelated 5-column shape/wording untouched, under its own name so it no longer shares (and
// can't accidentally be broken by changes to) the constant every other format now uses.
const EXCEL_UPDATE_TABLE_LABELS = ['تاریخ', 'رپلائی کرنے والا', 'وضاحت', 'تکمیل فیصد', 'اٹیچمنٹ'];
const UPDATES_HEADING = 'اپڈیٹس';
const ASSIGNEE_LABEL = 'ذمہ دار';
const RESPONSIBILITY_LABEL = 'ذمہ داری';
const BRAND_TITLE = 'ٹاسک مینجمنٹ سسٹم';
const GENERATED_BY_LABEL = 'رپورٹ جنریٹ کرنے والا';
const GENERATED_AT_LABEL = 'رپورٹ کی تاریخ';
const EMPTY_UPDATES_TEXT = 'کوئی اپڈیٹ نہیں';
// Excel-only merge-span width (its own Updates table, untouched, is still 5 columns wide).
const REPORT_COLUMN_COUNT = EXCEL_UPDATE_TABLE_LABELS.length;

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

// FINAL DATE FORMAT — reuses the same DD-MM-YY formatter as the rest of the report so a filter
// summary line never shows a different, non-compliant date shape (was a compact "Aug 1–31" style).
function formatDateRange(from, to) {
  if (from && to) return `${formatDateShort(from)}–${formatDateShort(to)}`;
  if (from) return `from ${formatDateShort(from)}`;
  return `until ${formatDateShort(to)}`;
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
    title: 'ٹاسک رپورٹ',
    filterDescription: buildFilterDescription(filters),
    generatedByLine: `${requestingUser.name} (${requestingUser.responsibility})`,
    generatedAtLabel: formatDateShort(new Date()),
  };
}

// "Baqi Din" (Remaining Days) — reuses the task's own already-computed timeStatus
// (task.service.js's computeTimeStatus). Prompt — converted to Urdu; "remaining"/"early" use the
// client's own exact given strings, and this now matches the SAME wording the frontend's own
// formatTimeStatusLabel (frontend/src/utils/formatDate.js) already uses for this exact concept
// elsewhere in the app. "overdue" wasn't one of the three strings the client called out (their
// sample likely just didn't happen to include a still-open overdue task) — ported from that same
// frontend precedent rather than left in English. days===0 edge cases (not in the client's given
// list either) also borrow the frontend's existing wording for consistency.
function formatRemainingDaysLabel(timeStatus) {
  if (!timeStatus) return '-';
  const { type, days } = timeStatus;
  switch (type) {
    case 'remaining':
      return days === 0 ? 'آج آخری تاریخ ہے' : `${days} دن باقی`;
    case 'overdue':
      return `${days} دن تاخیر سے`;
    case 'early':
      return days === 0 ? 'وقت پر مکمل ہوا' : `${days} دن پہلے مکمل`;
    case 'late':
      return `${days} دن تاخیر سے`;
    default:
      return '-';
  }
}

function attachmentLabel(attachment) {
  if (!attachment) return '-';
  return attachment.fileName || attachment.url || '-';
}

// Prompt — purely a REPORT-DISPLAY convenience: "(01) Title", "(02) Title", ... in front of a
// task's title, only when its ذمہ دار has more than one task in this report (a single-task
// section gets no "(01)" at all, per the client's own example). Never touches task.title or
// task.codeNumber themselves, never re-sorts anything — indexInGroup is just this task's existing
// position within its group's already-built tasks array (whatever order groupTasksByAssignee
// already produced).
function formatTaskTitleForDisplay(title, indexInGroup, groupTaskCount) {
  if (groupTaskCount <= 1) return title;
  const serial = String(indexInGroup + 1).padStart(2, '0');
  return `(${serial}) ${title}`;
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

  // Prompt — allUpdates is fetched newest-first (createdAt: -1) so lastUpdateOnly's slice(0, 1)
  // correctly grabs the single MOST RECENT entry. The client's manual-report reference reads
  // updates like an actual conversation, oldest message first — for the full-history case (not
  // lastUpdateOnly) the array is reversed to chronological/ascending order right here, after the
  // lastUpdateOnly decision already used the original newest-first order; this only changes
  // report DISPLAY order, not what's fetched/stored, and not the separate task-updates
  // history views elsewhere in the app (those query taskUpdate.service.js directly, untouched).
  const tasksWithUpdates = tasks.map((task) => {
    const allTaskUpdates = updatesByTaskId[task.id] || [];
    const updates = lastUpdateOnly ? allTaskUpdates.slice(0, 1) : [...allTaskUpdates].reverse();
    return { task, updates };
  });

  const groups = groupTasksByAssignee(tasksWithUpdates, { onlyAssigneeId: filters.assigneeId });

  return { groups, lastUpdateOnly: Boolean(lastUpdateOnly) };
}

// Shared HTML shell. Prompt — layered Urdu font strategy (see buildFontconfigEnv's own comment
// for the full root-cause story): 'Jameel Noori Nastaleeq' is installed as a genuine OS font at
// launch time, which is what actually gets Chromium's PDF backend to embed it as a real font
// instead of the fragile per-glyph Type3 fallback that caused the □ boxes. The @font-face below
// (base64 data: URI, no network fetch) stays as a SAFETY NET under the separate name
// '${NASTALIQ_FONT_NAME}' — if the OS-font install ever doesn't apply (e.g. a platform without
// fontconfig), the stack still falls through to a working, correctly-shaped Nastaliq render; it
// just goes back to risking the Type3/box issue specifically in non-Chromium-PDF.js PDF readers,
// same as before this fix, never worse. waitUntil:'load' (see generatePdf/generateJpeg) stays
// fine for the same reason as before — the @font-face font is inlined, not fetched — but
// generatePdf/generateJpeg also await `document.fonts.ready` before capturing, since 'load' firing
// isn't the same guarantee as the embedded glyph data having actually finished decoding.
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
  @font-face {
    font-family: '${NASTALIQ_FONT_NAME}';
    src: url(data:font/woff2;base64,${NASTALIQ_WOFF2_BASE64}) format('woff2');
    font-weight: normal;
    font-style: normal;
  }
  /* background: #fff is required, not decorative — page.screenshot({type:'jpeg'}) has no alpha
     channel, so an unset (transparent) page background flattens to BLACK in the .jpg export
     specifically (PDF happened to look fine without it; JPEG did not — caught by actually
     opening the generated .jpg, not by reading the HTML/CSS).
     line-height: 2 — Nastaliq's diagonal, stacked letterforms need noticeably more vertical room
     than Naskh/Latin text at the same font-size or ascenders/descenders from adjacent lines visibly
     crowd each other (caught by zooming into a generated PDF, not by reading this CSS); this is a
     line-height fix, not a font-size one — font-size stays untouched everywhere in this document. */
  body { font-family: '${JAMEEL_NOORI_FONT_NAME}', '${NASTALIQ_FONT_NAME}', serif; direction: rtl; margin: 24px; background: #fff; line-height: 2; }
  /* Found by zooming into a generated image, not by reading this CSS: the Nastaliq font's own
     shaping silently drops the space between a digit and the following Latin letter at a <bdi>
     isolation boundary — "09 Sep 26" rendered as "09Sep 26". <bdi> only ever wraps Latin/numeric
     data values (dates, code numbers, English names) in this document, never Urdu text, so it's
     safe — and fixes the spacing — to give it an ordinary Latin font instead. */
  bdi { font-family: Arial, Helvetica, sans-serif; line-height: normal; }
  h1 { font-size: 20px; margin-bottom: 4px; }
  p.filter-description { color: #555; margin: 4px 0 16px; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 4px; table-layout: fixed; }
  /* height: auto (explicit, not just the default) — table-layout:fixed only fixes COLUMN widths;
     rows already grow with their content by default, this just documents that no fixed/max-height
     is meant to ever be added here for text-heavy cells (Task/Description), per the client's own
     "allow the row height to expand naturally" requirement. */
  th, td { border: 1px solid #ccc; padding: 8px 6px; text-align: right; font-size: 12px; line-height: 2; height: auto; overflow-wrap: break-word; word-break: break-word; }
  th { background: #eef5ef; }
  h4.updates-heading { font-size: 13px; margin: 4px 0; }

  /* Prompt — کوڈ/باقی دن/آخری تاریخ are short, fixed-shape system-generated values that should
     never need two lines; table-layout:fixed above (needed so these nth-child widths are honored
     at all) otherwise splits width evenly across every column, which was squeezing exactly these
     into wrapping — caught by looking at a generated image, not by reading the CSS: "10 Sep 26"
     broke into "10 Sep" / "26". کام کی تفصیل (nth-child 2, free text) is deliberately left
     wrapping — that content is unbounded. */
  .task-report table.task-header th:nth-child(1), .task-report table.task-header td:nth-child(1) { width: 15%; white-space: nowrap; }
  .task-report table.task-header th:nth-child(3), .task-report table.task-header td:nth-child(3),
  .task-report table.task-header th:nth-child(4), .task-report table.task-header td:nth-child(4) { width: 20%; white-space: nowrap; }

  /* Prompt — back to ONE table per task for Updates (the client's previous request had this as
     chronological cards; this request reverses that back to a table — see renderUpdateRowHtml).
     break-inside/page-break-inside: avoid is on the ROW, not the whole table, so a task with many
     updates still paginates normally across pages (Section 10's "tables should continue naturally
     across pages") — only a single row is ever kept from being ugly-split mid-row. table.task-
     header (below) keeps its own avoid rule since it's always just 2 rows total. The table-head
     row repeats automatically at the top of each page this table's body spans across — standard
     Chromium print behavior, needs no extra CSS. */
  .task-report table.updates-table tr { break-inside: avoid; page-break-inside: avoid; }
  .task-report table.updates-table th:nth-child(1), .task-report table.updates-table td:nth-child(1) { width: 13%; white-space: nowrap; }
  .task-report table.updates-table th:nth-child(2), .task-report table.updates-table td:nth-child(2) { width: 16%; }
  .task-report table.updates-table th:nth-child(4), .task-report table.updates-table td:nth-child(4) { width: 12%; white-space: nowrap; }
  /* اٹیچمنٹ folded into the وضاحت cell as a compact secondary line (client's own "display it
     compactly inside the appropriate table cell instead of creating a separate large card") —
     this is what the client's 4-locked-column spec pushed it into, not a 5th column. */
  .task-report .update-attachment { margin-top: 4px; font-size: 11px; color: #666; }
  .task-report p.empty-updates { color: #777; margin: 4px 0 16px; }

  .task-report .brand-header { text-align: center; margin-bottom: 12px; }
  .task-report .brand-logo { width: 64px; height: 64px; display: block; margin: 0 auto 8px; }
  .task-report .brand-title { color: #${BRAND_GREEN}; font-size: 24px; font-weight: bold; margin: 0 0 8px; }
  .task-report .brand-meta { font-size: 12px; color: #333; margin: 2px 0; }
  .task-report .brand-divider { border: none; border-top: 3px solid #${BRAND_GREEN}; margin: 12px 0 16px; }
  .task-report h1.report-title { color: #${BRAND_GREEN}; text-align: center; }
  .task-report h2.assignee-header { font-size: 16px; margin: 20px 0 8px; padding-bottom: 4px; color: #${BRAND_GREEN}; border-bottom: 2px solid #${BRAND_GREEN}; }
  /* Prompt — every task now prints its own "کوڈ | کام کی تفصیل | باقی دن | آخری تاریخ" header row
     (see renderTaskBlockHtml), so every task-header table gets the same top spacing — not just
     tasks after the first — to keep consistent breathing room from whatever precedes it (the
     ذمہ دار heading, or the previous task's last update entry). break-inside: avoid — see the
     .update-entry rule's own comment; this table is only ever 2 rows (header + the one task), so
     avoiding a split here never risks stranding a large block. */
  .task-report table.task-header { margin-top: 14px; break-inside: avoid; page-break-inside: avoid; }
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

// Prompt — back to one <tr> per update (see UPDATE_TABLE_LABELS' own comment for the column
// set/order and the flagged RIGHT→LEFT ambiguity). اٹیچمنٹ has no column of its own this time —
// folded into the وضاحت cell as a compact secondary line, never dropped.
function renderUpdateRowHtml(update) {
  const attachmentHtml = update.attachment
    ? `<div class="update-attachment">${escapeHtml(UPDATE_ATTACHMENT_LABEL)}: ${attachmentCellHtml(update.attachment)}</div>`
    : '';
  return `<tr>
<td>${bdi(escapeHtml(formatDateShort(update.createdAt)))}</td>
<td>${bdi(escapeHtml(update.updatedBy?.name ?? '-'))}</td>
<td>${bdi(escapeHtml(update.description))}${attachmentHtml}</td>
<td>${bdi(`${update.completionPercent}%`)}</td>
</tr>`;
}

function renderUpdatesTableHtml(updates) {
  if (updates.length === 0) {
    return `<p class="empty-updates">${escapeHtml(EMPTY_UPDATES_TEXT)}</p>`;
  }
  return `<table class="updates-table">
<thead><tr>${UPDATE_TABLE_LABELS.map((l) => `<th>${escapeHtml(l)}</th>`).join('')}</tr></thead>
<tbody>${updates.map((u) => renderUpdateRowHtml(u)).join('')}</tbody>
</table>`;
}

// Prompt — every task in a Zimmedar's section prints its OWN "کوڈ | کام کی تفصیل | باقی دن |
// آخری تاریخ" column-header row (previously only the first task in a group did, with later tasks
// skipping it for a border-only separator — the client reported that as headers "lost/reused
// inconsistently" and asked for every task block to carry its own headers, so the skip stays
// removed). indexInGroup/groupTaskCount feed formatTaskTitleForDisplay's "(01) Title" numbering
// (see its own comment) — a display-only prefix, never touching task.title itself. The data row's
// own cell order matches TASK_HEADER_LABELS' locked order exactly: کوڈ, کام کی تفصیل, باقی دن
// (remaining days), آخری تاریخ (deadline) — note remaining-days now comes BEFORE deadline.
function renderTaskBlockHtml(task, updates, { indexInGroup, groupTaskCount }) {
  const displayTitle = formatTaskTitleForDisplay(task.title, indexInGroup, groupTaskCount);

  return `
<table class="task-header">
<thead><tr>${TASK_HEADER_LABELS.map((l) => `<th>${escapeHtml(l)}</th>`).join('')}</tr></thead>
<tbody><tr>
<td>${bdi(escapeHtml(task.codeNumber))}</td>
<td>${bdi(escapeHtml(displayTitle))}</td>
<td>${bdi(escapeHtml(formatRemainingDaysLabel(task.timeStatus)))}</td>
<td>${bdi(escapeHtml(formatDateShort(task.deadline)))}</td>
</tr></tbody>
</table>
<h4 class="updates-heading">${escapeHtml(UPDATES_HEADING)}</h4>
${renderUpdatesTableHtml(updates)}`;
}

// docs/06-backend.md §9 (rewritten) — builds the HTML string rendered by generatePdf/generateJpeg.
// Prompt — the branded header (logo, app name, "generated by"/"generated at") now sits above the
// existing title/filter-description block, once per document (not repeated per group/task).
// filterDescription is only printed when a real filter is active — "All Data" (buildFilterDescription's
// own fallback for "no filter") added no information once the branded header already existed, so
// it's omitted entirely rather than printed as a redundant line.
function renderReportHtml(groups, { headerInfo }) {
  const groupsHtml =
    groups.length > 0
      ? groups
          .map(
            (group) => `
<h2 class="assignee-header">${escapeHtml(ASSIGNEE_LABEL)}: ${bdi(escapeHtml(group.assignee.name))} — ${escapeHtml(RESPONSIBILITY_LABEL)}: ${bdi(escapeHtml(group.assignee.responsibility))}</h2>
${group.tasks.map(({ task, updates }, index) => renderTaskBlockHtml(task, updates, { indexInGroup: index, groupTaskCount: group.tasks.length })).join('')}`
          )
          .join('')
      : '<p>No tasks found.</p>';

  const filterDescriptionHtml =
    headerInfo.filterDescription === 'All Data' ? '' : `<p class="filter-description">${bdi(escapeHtml(headerInfo.filterDescription))}</p>`;

  const body = `
<div class="task-report">
<div class="brand-header">
<img class="brand-logo" src="data:image/png;base64,${LOGO_BASE64}" alt="Dawat-e-Islami" />
<div class="brand-title">${escapeHtml(BRAND_TITLE)}</div>
<p class="brand-meta">${escapeHtml(GENERATED_BY_LABEL)}: ${bdi(escapeHtml(headerInfo.generatedByLine))}</p>
<p class="brand-meta">${escapeHtml(GENERATED_AT_LABEL)}: ${bdi(escapeHtml(headerInfo.generatedAtLabel))}</p>
</div>
<hr class="brand-divider" />
<h1 class="report-title">${escapeHtml(headerInfo.title)}</h1>
${filterDescriptionHtml}
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
//
// Prompt — root-caused from real Render production logs (not a guess): the first export after a
// cold start failed with "TimeoutError: Navigation timeout of 30000 ms exceeded" inside
// page.setContent, then succeeded ~1 minute later once the container/Chromium had warmed up.
// waitUntil:'networkidle0' (the previous setting) waits for zero in-flight network connections
// for 500ms straight — pointless overhead here, since every resource in this HTML (logo, font,
// everything) is already inlined as a base64 data: URI with no network fetch at all — and it's
// also known to be flaky under a slow/CPU-throttled first render, exactly what a cold Render
// container is. Switched to 'load' (fires once the DOM + inlined resources finish, which is all
// this document needs) with an explicit, more generous 45s timeout as a safety margin for a
// still-cold container — both changes target the exact call site the logs pointed at.
async function withBrowserPage(step, fn) {
  const { default: puppeteer } = await import('puppeteer');
  const launchOptions = {
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    // See buildFontconfigEnv's own comment — this is the actual fix for the Type3/□-boxes bug,
    // not the @font-face embedding alone.
    env: { ...process.env, ...buildFontconfigEnv() },
  };
  let browser;
  try {
    browser = await puppeteer.launch(launchOptions);
  } catch (launchError) {
    logger.error(`Puppeteer browser launch failed (report step: ${step}):`, launchError);
    throw launchError;
  }

  try {
    const page = await browser.newPage();
    return await fn(page);
  } catch (pageError) {
    logger.error(`Puppeteer report generation failed on page (report step: ${step}):`, pageError);
    throw pageError;
  } finally {
    if (browser) {
      await browser.close().catch((closeError) => {
        logger.error(`Failed to close Puppeteer browser (report step: ${step}):`, closeError);
      });
    }
  }
}

// Prompt — root-caused the "inconsistent Urdu font/boxes in the PDF" report: waitUntil:'load'
// firing (page.setContent resolving) is NOT the same guarantee as the @font-face's embedded glyph
// data having actually finished decoding — Chromium can still paint a first frame with its own
// fallback font while the real one is mid-decode, and page.pdf()/page.screenshot() capture
// whatever was painted at that moment. The CSS Font Loading API's `document.fonts.ready` is the
// actual, deterministic signal for "every font this page needs has settled" (it resolves once
// loading finishes either way, so it can't hang forever on a font that fails) — awaited here
// before every capture. Raced against a short explicit timeout anyway, matching this file's
// existing explicit-timeout convention, purely as a last-resort safety net.
async function waitForFontsReady(page) {
  await Promise.race([
    // eslint-disable-next-line no-undef -- runs inside the Puppeteer page (browser context), not Node.
    page.evaluate(() => document.fonts.ready.then(() => undefined)),
    new Promise((resolve) => setTimeout(resolve, 5000)),
  ]);
}

async function generatePdf(html) {
  return withBrowserPage('generatePdf', async (page) => {
    await page.setContent(html, { waitUntil: 'load', timeout: 45000 });
    await waitForFontsReady(page);
    // page.pdf() resolves a plain Uint8Array, not a Node Buffer — Express's res.send() special-
    // cases Buffer.isBuffer() for correct binary responses (Content-Length etc.), so wrap
    // explicitly rather than let a subtly-wrong type reach the controller.
    return Buffer.from(await page.pdf({ format: 'A4', timeout: 45000 }));
  });
}

// Prompt — root-caused the "JPEG cropped on the right side" report, in two layers:
// 1. Puppeteer's page never had setViewport() called on it, so it stayed at Puppeteer's own
//    default (800x600) regardless of how wide/tall the actual rendered report content was.
// 2. The real surprise, found only by comparing screenshots taken different ways on the same
//    page (not by reading Puppeteer's docs): it's specifically Chromium's CLIPPED screenshot
//    capture path — `page.screenshot({ clip })`, and `fullPage: true` goes through that exact
//    same path internally — that corrupts this RTL document's rendering. A verified example: a
//    single-ذمہ دار filtered report whose content measured well within the default 800x600 (no
//    overflow at all) still came out with "ذمہ دار:"/"کام کوڈ" missing from the right edge under
//    `fullPage: true` AND under an explicit `clip` of the exact same size — while a plain,
//    unclipped `page.screenshot()` at that identical viewport size rendered every element
//    correctly. Clipped capture, not viewport width, was silently re-flowing/mispainting the RTL
//    layout. Fix: measure the page's real rendered width/height, resize the viewport to match
//    EXACTLY via setViewport (never a hardcoded guess, never shrinking font/scale), then take a
//    plain, unclipped screenshot — since the viewport now equals the content size exactly, a
//    plain capture already covers the whole report with nothing left to clip.
async function resizeViewportToContent(page) {
  const { width, height } = await page.evaluate(() => ({
    // eslint-disable-next-line no-undef -- runs inside the Puppeteer page (browser context), not Node.
    width: document.documentElement.scrollWidth,
    // eslint-disable-next-line no-undef -- runs inside the Puppeteer page (browser context), not Node.
    height: document.documentElement.scrollHeight,
  }));
  await page.setViewport({ width, height });
}

async function generateJpeg(html) {
  return withBrowserPage('generateJpeg', async (page) => {
    await page.setContent(html, { waitUntil: 'load', timeout: 45000 });
    await waitForFontsReady(page);
    await resizeViewportToContent(page);
    // Deliberately NOT fullPage/clip — see resizeViewportToContent's comment: clipped capture is
    // what was corrupting this RTL layout, not viewport size. The viewport above is already
    // sized to the exact content, so a plain screenshot already captures all of it.
    return Buffer.from(await page.screenshot({ type: 'jpeg' }));
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
  // Prompt — "All Data" (buildFilterDescription's own "nothing was filtered" fallback) is
  // redundant now that the branded header exists; only a REAL filter description is printed.
  if (headerInfo.filterDescription !== 'All Data') {
    addMergedRow(headerInfo.filterDescription);
  }
  sheet.addRow([]);

  if (data.groups.length === 0) {
    addMergedRow('No tasks found.');
  }

  data.groups.forEach((group) => {
    addMergedRow(`${ASSIGNEE_LABEL}: ${group.assignee.name} — ${RESPONSIBILITY_LABEL}: ${group.assignee.responsibility}`, {
      bold: true,
      color: `FF${BRAND_GREEN}`,
    });

    // Prompt — only the first task in this Zimmedar's section gets the
    // "کام کوڈ | کام | آخری تاریخ | باقی دن" header row; later tasks skip it and instead get a
    // thicker top border on their own data row (added below) as a lighter visual separator.
    group.tasks.forEach(({ task, updates }, index) => {
      const isFirstInGroup = index === 0;
      if (isFirstInGroup) {
        addDataRow(TASK_HEADER_LABELS, { header: true });
      }
      // Prompt — value order matches TASK_HEADER_LABELS' own (locked) order: کوڈ, کام کی تفصیل,
      // باقی دن, آخری تاریخ — kept in sync so this row's data never lands under the wrong header.
      const taskRow = addDataRow([task.codeNumber, task.title, formatRemainingDaysLabel(task.timeStatus), formatDateShort(task.deadline)], {
        ltrColumns: [1, 3, 4],
      });
      if (!isFirstInGroup) {
        taskRow.eachCell((cell) => {
          cell.border = { ...cell.border, top: { style: 'medium', color: { argb: `FF${BRAND_GREEN}` } } };
        });
      }

      addMergedRow(UPDATES_HEADING, { italic: true, color: `FF${BRAND_GREEN}` });
      addDataRow(EXCEL_UPDATE_TABLE_LABELS, { header: true });

      if (updates.length === 0) {
        addMergedRow(EMPTY_UPDATES_TEXT);
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
//
// Prompt — every TextRun below carries `font: NASTALIQ_FONT_NAME` explicitly, rather than
// relying on Word's own style-inheritance cascade (styles.default.document/heading1/heading2/...)
// to pick it up: Word's built-in heading styles pull their font from the document THEME by
// default, which can silently override a font set only at the "Normal"/document-default level —
// setting it per-run is the only way to GUARANTEE every visible piece of text actually uses the
// embedded font (see generateDocx's `fonts:` option below for the embedding itself, which is the
// other half of this fix: setting a font NAME with nothing backing it does nothing for a viewer
// who doesn't have that font installed).
function docxCell(text, { bold = false, header = false } = {}) {
  return new TableCell({
    children: [
      new Paragraph({
        bidirectional: true,
        children: [new TextRun({ text: String(text ?? '-'), bold: bold || header, color: header ? 'FFFFFF' : undefined, font: NASTALIQ_FONT_NAME })],
      }),
    ],
    shading: header ? { fill: BRAND_GREEN } : undefined,
  });
}

// Prompt — every task now gets its own "کوڈ | کام کی تفصیل | باقی دن | آخری تاریخ" header row
// (see renderTaskBlockHtml's matching HTML comment — same fix, same reason, applied here too).
// indexInGroup/groupTaskCount feed formatTaskTitleForDisplay's "(01) Title" numbering. The data
// row's cell order matches TASK_HEADER_LABELS' locked order exactly (remaining-days BEFORE
// deadline — see that constant's own comment).
//
// Prompt — `visuallyRightToLeft: true` is the actual OOXML table-direction flag (`<w:bidiVisual/>`
// under the hood) — this is what makes Word render the FIRST cell in each row's children array as
// the RIGHTMOST column and lay out the rest right-to-left from there, matching the exact reading
// order docx.js's own cell INSERTION order already uses. Without this, Word ignores document
// `bidirectional`/paragraph-level RTL entirely for TABLE COLUMN ORDER and lays columns out
// left-to-right regardless — `text-align: right` or per-paragraph `bidirectional` on the cell
// content alone does not fix this, since column order is a table-level property, not a text one.
// cantSplit: true on the data row keeps this one-row table together across a page boundary
// (Section 10's "prefer to stay together") — it can only ever move the whole row to the next
// page, never clip or drop content.
function docxTaskHeaderTable(task, { indexInGroup, groupTaskCount } = {}) {
  const displayTitle = formatTaskTitleForDisplay(task.title, indexInGroup, groupTaskCount);
  const headerRow = new TableRow({ children: TASK_HEADER_LABELS.map((l) => docxCell(l, { header: true })) });
  const dataRow = new TableRow({
    cantSplit: true,
    children: [
      docxCell(task.codeNumber),
      docxCell(displayTitle),
      docxCell(formatRemainingDaysLabel(task.timeStatus)),
      docxCell(formatDateShort(task.deadline)),
    ],
  });
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    visuallyRightToLeft: true,
    rows: [headerRow, dataRow],
  });
}

// Prompt — back to one table per task for Updates (mirrors renderUpdatesTableHtml — see
// UPDATE_TABLE_LABELS' own comment for the column set/order and the flagged RIGHT→LEFT
// ambiguity). Same `visuallyRightToLeft: true` reasoning as docxTaskHeaderTable — column order is
// a table-level OOXML property, not something paragraph-level `bidirectional` affects.
// tableHeader: true on the header row makes Word automatically repeat "تاریخ | اپڈیٹ کرنے والا |
// وضاحت | تکمیل فیصد" at the top of every page this table's body spans — the client's own "table
// headers should remain visually clear" across a multi-page Updates table, with zero extra CSS-
// equivalent needed (native Word table feature). cantSplit on each data row keeps a single update
// from being cut mid-row across a page, while the table as a whole still paginates normally.
function docxUpdateDescriptionCell(update) {
  const children = [new Paragraph({ bidirectional: true, children: [new TextRun({ text: update.description || '-', font: NASTALIQ_FONT_NAME })] })];
  if (update.attachment) {
    const extraChildren = [new TextRun({ text: `${UPDATE_ATTACHMENT_LABEL}: `, size: 16, color: '666666', font: NASTALIQ_FONT_NAME })];
    if (update.attachment.url) {
      extraChildren.push(
        new ExternalHyperlink({
          link: update.attachment.url,
          children: [new TextRun({ text: attachmentLabel(update.attachment), style: 'Hyperlink', rightToLeft: false, size: 16, font: NASTALIQ_FONT_NAME })],
        })
      );
    } else {
      extraChildren.push(new TextRun({ text: attachmentLabel(update.attachment), rightToLeft: false, size: 16, color: '666666', font: NASTALIQ_FONT_NAME }));
    }
    children.push(new Paragraph({ bidirectional: true, children: extraChildren }));
  }
  return new TableCell({ children });
}

function docxUpdateRow(update) {
  return new TableRow({
    cantSplit: true,
    children: [docxCell(formatDateShort(update.createdAt)), docxCell(update.updatedBy?.name || '-'), docxUpdateDescriptionCell(update), docxCell(`${update.completionPercent}%`)],
  });
}

function docxUpdatesTable(updates) {
  const headerRow = new TableRow({ tableHeader: true, children: UPDATE_TABLE_LABELS.map((l) => docxCell(l, { header: true })) });
  if (updates.length === 0) {
    return new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      visuallyRightToLeft: true,
      rows: [
        headerRow,
        new TableRow({
          children: [
            new TableCell({
              columnSpan: UPDATE_TABLE_LABELS.length,
              children: [new Paragraph({ bidirectional: true, alignment: AlignmentType.CENTER, children: [new TextRun({ text: EMPTY_UPDATES_TEXT, font: NASTALIQ_FONT_NAME })] })],
            }),
          ],
        }),
      ],
    });
  }
  return new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, visuallyRightToLeft: true, rows: [headerRow, ...updates.map((u) => docxUpdateRow(u))] });
}

// Prompt — filterDescription paragraph omitted entirely when it's just "All Data" (no filter
// applied) — redundant once the branded header above it already exists.
function docxBrandHeaderParagraphs(headerInfo) {
  const paragraphs = [
    new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [new ImageRun({ type: 'png', data: LOGO_BUFFER, transformation: { width: 56, height: 56 } })],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      bidirectional: true,
      children: [new TextRun({ text: BRAND_TITLE, bold: true, size: 32, color: BRAND_GREEN, font: NASTALIQ_FONT_NAME })],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      bidirectional: true,
      children: [new TextRun({ text: `${GENERATED_BY_LABEL}: ${headerInfo.generatedByLine}`, size: 20, font: NASTALIQ_FONT_NAME })],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      bidirectional: true,
      children: [new TextRun({ text: `${GENERATED_AT_LABEL}: ${headerInfo.generatedAtLabel}`, size: 20, font: NASTALIQ_FONT_NAME })],
    }),
    new Paragraph({
      border: { bottom: { color: BRAND_GREEN, space: 4, style: BorderStyle.SINGLE, size: 12 } },
      children: [],
    }),
    new Paragraph({
      heading: HeadingLevel.HEADING_1,
      alignment: AlignmentType.CENTER,
      bidirectional: true,
      children: [new TextRun({ text: headerInfo.title, color: BRAND_GREEN, font: NASTALIQ_FONT_NAME })],
    }),
  ];
  if (headerInfo.filterDescription !== 'All Data') {
    paragraphs.push(
      new Paragraph({
        alignment: AlignmentType.CENTER,
        bidirectional: true,
        children: [new TextRun({ text: headerInfo.filterDescription, font: NASTALIQ_FONT_NAME })],
      })
    );
  }
  return paragraphs;
}

async function generateDocx(data, { headerInfo }) {
  const children = docxBrandHeaderParagraphs(headerInfo);

  if (data.groups.length === 0) {
    children.push(new Paragraph({ bidirectional: true, children: [new TextRun({ text: 'No tasks found.', font: NASTALIQ_FONT_NAME })] }));
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
            font: NASTALIQ_FONT_NAME,
          }),
        ],
      })
    );

    group.tasks.forEach(({ task, updates }, index) => {
      children.push(docxTaskHeaderTable(task, { indexInGroup: index, groupTaskCount: group.tasks.length }));
      children.push(
        new Paragraph({
          heading: HeadingLevel.HEADING_4,
          bidirectional: true,
          children: [new TextRun({ text: UPDATES_HEADING, color: BRAND_GREEN, bold: true, font: NASTALIQ_FONT_NAME })],
        })
      );
      children.push(docxUpdatesTable(updates));
      children.push(new Paragraph({ children: [] })); // spacer between tasks
    });
  });

  // Prompt — embeds the actual font FILE in the .docx (Word's own "embed fonts in the file"
  // mechanism, exposed here via docx's `fonts` option): setting `font: NASTALIQ_FONT_NAME` on
  // every run above only sets a NAME — if the viewer's own Windows/Office install doesn't have
  // that family, Word silently substitutes something else and the text can render wrong, which
  // is exactly the bug being fixed here.
  const doc = new Document({
    fonts: [{ name: NASTALIQ_FONT_NAME, data: NASTALIQ_TTF_BUFFER }],
    sections: [{ children }],
  });
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
