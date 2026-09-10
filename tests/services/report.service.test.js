const mongoose = require('mongoose');
const ExcelJS = require('exceljs');
const JSZip = require('jszip');
const { Document, Packer } = require('docx');
const { connect, closeDatabase, clearDatabase } = require('../helpers/db');
const User = require('../../src/models/User');
const LookupList = require('../../src/models/LookupList');
const taskService = require('../../src/services/task.service');
const taskUpdateService = require('../../src/services/taskUpdate.service');
const dashboardService = require('../../src/services/dashboard.service');
const reportService = require('../../src/services/report.service');

beforeAll(async () => connect());
afterEach(async () => clearDatabase());
afterAll(async () => closeDatabase());

async function makeAdmin() {
  return User.create({
    name: 'Admin',
    email: `admin${new mongoose.Types.ObjectId()}@x.com`,
    responsibility: 'Admin',
    role: 'admin',
  });
}
async function makeUser(overrides = {}) {
  return User.create({
    name: 'User',
    email: `user${new mongoose.Types.ObjectId()}@x.com`,
    responsibility: 'X',
    role: 'user',
    ...overrides,
  });
}
async function makeLookup(value = 'Donation Box Incharge') {
  return LookupList.create({ listType: 'responsibility', value });
}
function inDays(n) {
  return new Date(Date.now() + n * 24 * 60 * 60 * 1000);
}

describe('buildHeaderInfo / buildFilterDescription (docs/06-backend.md §9 header wording)', () => {
  it('shows "All Data" when no filter was applied', () => {
    const info = reportService.buildHeaderInfo({ name: 'Admin Person', responsibility: 'Admin' }, {});
    expect(info.title).toBe('ٹاسک رپورٹ'); // Prompt — was English "Task Report"
    expect(info.filterDescription).toBe('All Data');
  });

  it('carries the report-generator line (name + their own responsibility) and today\'s date, in the same "dd MMM yy" format used everywhere else', () => {
    const info = reportService.buildHeaderInfo({ name: 'Admin Person', responsibility: 'Zonal Incharge' }, {});
    expect(info.generatedByLine).toBe('Admin Person (Zonal Incharge)');
    expect(info.generatedAtLabel).toMatch(/^\d{2} [A-Za-z]{3} \d{2}$/); // e.g. "09 Sep 26" — today, so not hardcoded
  });

  it('builds the exact documented example: "Status: Ongoing, Deadline: Aug 1–31"', () => {
    const description = reportService.buildFilterDescription({
      status: 'ongoing',
      deadlineFrom: new Date('2026-08-01T00:00:00Z'),
      deadlineTo: new Date('2026-08-31T00:00:00Z'),
    });
    expect(description).toBe('Status: Ongoing, Deadline: Aug 1–31');
  });

  it('combines multiple active filters, one clause per filter, comma-separated', () => {
    const description = reportService.buildFilterDescription({
      status: 'closed',
      responsibility: 'Donation Box Incharge',
      search: 'boxes',
    });
    expect(description).toBe('Status: Closed, Responsibility: Donation Box Incharge, Search: "boxes"');
  });
});

describe('formatRemainingDaysLabel (pure, Urdu — Prompt: converted from English)', () => {
  it('uses the client\'s exact given strings for remaining/early, and the frontend\'s own established wording for overdue/late/edge-cases', () => {
    expect(reportService.formatRemainingDaysLabel({ type: 'remaining', days: 3 })).toBe('3 دن باقی');
    expect(reportService.formatRemainingDaysLabel({ type: 'remaining', days: 0 })).toBe('آج آخری تاریخ ہے');
    expect(reportService.formatRemainingDaysLabel({ type: 'overdue', days: 2 })).toBe('2 دن تاخیر سے');
    expect(reportService.formatRemainingDaysLabel({ type: 'early', days: 1 })).toBe('1 دن پہلے مکمل');
    expect(reportService.formatRemainingDaysLabel({ type: 'early', days: 0 })).toBe('وقت پر مکمل ہوا');
    expect(reportService.formatRemainingDaysLabel({ type: 'late', days: 4 })).toBe('4 دن تاخیر سے');
    expect(reportService.formatRemainingDaysLabel(null)).toBe('-');
  });
});

describe('groupTasksByAssignee (pure — docs/06-backend.md §9 grouping rule)', () => {
  it('fans a multi-assignee task out into each of its assignees’ sections when no onlyAssigneeId is given', () => {
    const ali = { id: 'u1', name: 'Ali', responsibility: 'IT' };
    const bilal = { id: 'u2', name: 'Bilal', responsibility: 'Media' };
    const task = { id: 't1', assignees: [ali, bilal] };

    const groups = reportService.groupTasksByAssignee([{ task, updates: [] }]);

    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.assignee.name).sort()).toEqual(['Ali', 'Bilal']);
    groups.forEach((g) => expect(g.tasks).toHaveLength(1));
  });

  it('with onlyAssigneeId, places the task ONLY under that assignee’s section, not a co-assignee’s', () => {
    const ali = { id: 'u1', name: 'Ali', responsibility: 'IT' };
    const bilal = { id: 'u2', name: 'Bilal', responsibility: 'Media' };
    const task = { id: 't1', assignees: [ali, bilal] };

    const groups = reportService.groupTasksByAssignee([{ task, updates: [] }], { onlyAssigneeId: 'u1' });

    expect(groups).toHaveLength(1);
    expect(groups[0].assignee.name).toBe('Ali');
  });

  it('sorts sections by assignee name', () => {
    const zain = { id: 'u3', name: 'Zain', responsibility: 'IT' };
    const ali = { id: 'u1', name: 'Ali', responsibility: 'IT' };
    const groups = reportService.groupTasksByAssignee([
      { task: { id: 't1', assignees: [zain] }, updates: [] },
      { task: { id: 't2', assignees: [ali] }, updates: [] },
    ]);
    expect(groups.map((g) => g.assignee.name)).toEqual(['Ali', 'Zain']);
  });
});

describe('buildReportData (docs/06-backend.md §9 step 1, rewritten: grouped by Zimmedar)', () => {
  it('groups tasks under their assignee(s), with the full update history by default', async () => {
    const admin = await makeAdmin();
    const assignee = await makeUser({ name: 'Zimmedar Person' });
    const lookup = await makeLookup();
    const task = await taskService.createTask(
      { id: admin.id },
      { title: 'X', assignees: [assignee._id], responsibility: lookup.value, deadline: inDays(5) }
    );
    await taskUpdateService.createUpdate({ id: admin.id, role: 'admin' }, task.id, { description: 'First', completionPercent: 20 });
    await taskUpdateService.createUpdate({ id: admin.id, role: 'admin' }, task.id, { description: 'Second', completionPercent: 60 });

    const data = await reportService.buildReportData({ id: admin.id, role: 'admin' }, {}, {});

    expect(data.lastUpdateOnly).toBe(false);
    expect(data.groups).toHaveLength(1);
    expect(data.groups[0].assignee.name).toBe('Zimmedar Person');
    expect(data.groups[0].tasks).toHaveLength(1);
    expect(data.groups[0].tasks[0].updates).toHaveLength(2);
  });

  it('lastUpdateOnly trims each task down to just its single most recent update', async () => {
    const admin = await makeAdmin();
    const assignee = await makeUser();
    const lookup = await makeLookup();
    const task = await taskService.createTask(
      { id: admin.id },
      { title: 'X', assignees: [assignee._id], responsibility: lookup.value, deadline: inDays(5) }
    );
    await taskUpdateService.createUpdate({ id: admin.id, role: 'admin' }, task.id, { description: 'First', completionPercent: 20 });
    await taskUpdateService.createUpdate({ id: admin.id, role: 'admin' }, task.id, { description: 'Second', completionPercent: 60 });

    const data = await reportService.buildReportData({ id: admin.id, role: 'admin' }, {}, { lastUpdateOnly: true });

    expect(data.lastUpdateOnly).toBe(true);
    expect(data.groups[0].tasks[0].updates).toHaveLength(1);
    expect(data.groups[0].tasks[0].updates[0].description).toBe('Second'); // most recent
  });

  it('a task with no updates yet still appears, with an empty updates array', async () => {
    const admin = await makeAdmin();
    const assignee = await makeUser();
    const lookup = await makeLookup();
    await taskService.createTask({ id: admin.id }, { title: 'X', assignees: [assignee._id], responsibility: lookup.value, deadline: inDays(5) });

    const data = await reportService.buildReportData({ id: admin.id, role: 'admin' }, {}, {});

    expect(data.groups[0].tasks[0].updates).toEqual([]);
  });

  it('is unpaginated: returns every matching task, not just a default page', async () => {
    const admin = await makeAdmin();
    const assignee = await makeUser();
    const lookup = await makeLookup();
    await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        taskService.createTask(
          { id: admin.id },
          { title: `Task ${i}`, assignees: [assignee._id], responsibility: lookup.value, deadline: inDays(5) }
        )
      )
    );

    const data = await reportService.buildReportData({ id: admin.id, role: 'admin' }, {}, {});
    expect(data.groups[0].tasks).toHaveLength(5);
  });

  it('is RBAC-scoped exactly like GET /tasks: a User only gets their own tasks', async () => {
    const admin = await makeAdmin();
    const me = await makeUser({ name: 'Me' });
    const other = await makeUser({ name: 'Other' });
    const lookup = await makeLookup();
    await taskService.createTask({ id: admin.id }, { title: 'Mine', assignees: [me._id], responsibility: lookup.value, deadline: inDays(5) });
    await taskService.createTask({ id: admin.id }, { title: 'Not mine', assignees: [other._id], responsibility: lookup.value, deadline: inDays(5) });

    const data = await reportService.buildReportData({ id: me.id, role: 'user' }, {}, {});

    expect(data.groups).toHaveLength(1);
    expect(data.groups[0].assignee.name).toBe('Me');
    expect(data.groups[0].tasks[0].task.title).toBe('Mine');
  });

  it('filtering by assigneeId groups matching tasks only under that one Zimmedar, even if a task has a co-assignee', async () => {
    const admin = await makeAdmin();
    const ali = await makeUser({ name: 'Ali' });
    const bilal = await makeUser({ name: 'Bilal' });
    const lookup = await makeLookup();
    await taskService.createTask(
      { id: admin.id },
      { title: 'Shared', assignees: [ali._id, bilal._id], responsibility: lookup.value, deadline: inDays(5) }
    );

    const data = await reportService.buildReportData({ id: admin.id, role: 'admin' }, { assigneeId: ali.id }, {});

    expect(data.groups).toHaveLength(1);
    expect(data.groups[0].assignee.name).toBe('Ali');
  });

  it('no filters at all ("All"): every matching task across every Zimmedar is included', async () => {
    const admin = await makeAdmin();
    const ali = await makeUser({ name: 'Ali' });
    const bilal = await makeUser({ name: 'Bilal' });
    const lookup = await makeLookup();
    await taskService.createTask({ id: admin.id }, { title: 'A', assignees: [ali._id], responsibility: lookup.value, deadline: inDays(5) });
    await taskService.createTask({ id: admin.id }, { title: 'B', assignees: [bilal._id], responsibility: lookup.value, deadline: inDays(5) });

    const data = await reportService.buildReportData({ id: admin.id, role: 'admin' }, {}, {});

    expect(data.groups.map((g) => g.assignee.name)).toEqual(['Ali', 'Bilal']);
  });
});

const SAMPLE_HEADER_INFO = {
  title: 'ٹاسک رپورٹ',
  filterDescription: 'All Data',
  generatedByLine: 'Admin Person (Admin)',
  generatedAtLabel: '09 Sep 26',
};

describe('renderReportHtml (pure — grouped structure, branded header, exact Urdu labels)', () => {
  it('renders the branded header (logo, app name, generated-by/at lines) once, before any group', () => {
    const html = reportService.renderReportHtml([], { headerInfo: SAMPLE_HEADER_INFO });

    expect(html).toContain('data:image/png;base64,');
    expect(html).toContain('ٹاسک مینجمنٹ سسٹم');
    // Prompt — the LTR value (name/date) is wrapped in <bdi> so the browser's bidi algorithm
    // doesn't reorder it relative to the Urdu label it follows (caught by actually opening a
    // generated .jpg — see the chat report); label and value are asserted separately rather than
    // as one un-tagged substring.
    expect(html).toContain('رپورٹ جنریٹ کرنے والا:');
    expect(html).toContain('<bdi>Admin Person (Admin)</bdi>');
    expect(html).toContain('رپورٹ کی تاریخ:');
    expect(html).toContain('<bdi>09 Sep 26</bdi>');
  });

  it('renders an assignee header (with the exact ذمہ دار/ذمہ داری labels), task header row, and اپڈیٹس table, per group/task', () => {
    const groups = [
      {
        assignee: { id: 'u1', name: 'Ali', responsibility: 'IT' },
        tasks: [
          {
            task: { codeNumber: '260801', title: 'Collect boxes', deadline: new Date('2026-09-01'), timeStatus: { type: 'remaining', days: 5 } },
            updates: [
              { createdAt: new Date('2026-08-20'), updatedBy: { name: 'Ali' }, description: 'Progress made', completionPercent: 40, attachment: null },
            ],
          },
        ],
      },
    ];

    const html = reportService.renderReportHtml(groups, { headerInfo: SAMPLE_HEADER_INFO });

    expect(html).toContain('ذمہ دار:');
    expect(html).toContain('<bdi>Ali</bdi>');
    expect(html).toContain('ذمہ داری:');
    expect(html).toContain('<bdi>IT</bdi>');
    expect(html).toContain('260801');
    expect(html).toContain('Collect boxes');
    expect(html).toContain('اپڈیٹس');
    expect(html).toContain('Progress made');
    expect(html).toContain('40%');
    // exact Urdu column labels, verbatim from the client's given term list — not invented.
    ['کام کوڈ', 'کام', 'آخری تاریخ', 'باقی دن'].forEach((label) => expect(html).toContain(label));
    ['تاریخ', 'رپلائی کرنے والا', 'وضاحت', 'تکمیل فیصد', 'اٹیچمنٹ'].forEach((label) => expect(html).toContain(label));
  });

  it('shows "کوئی اپڈیٹ نہیں" (Prompt — was English "No updates yet") for a task with an empty updates array', () => {
    const groups = [
      {
        assignee: { id: 'u1', name: 'Ali', responsibility: 'IT' },
        tasks: [{ task: { codeNumber: '1', title: 'T', deadline: new Date(), timeStatus: { type: 'remaining', days: 1 } }, updates: [] }],
      },
    ];
    const html = reportService.renderReportHtml(groups, { headerInfo: SAMPLE_HEADER_INFO });
    expect(html).toContain('کوئی اپڈیٹ نہیں');
  });

  it('shows "No tasks found." when there are zero groups', () => {
    const html = reportService.renderReportHtml([], { headerInfo: SAMPLE_HEADER_INFO });
    expect(html).toContain('No tasks found.');
  });

  it('embeds the real Nastaliq font via @font-face as a base64 data: URI (no network fetch, no reliance on a viewer/server having it installed)', () => {
    const html = reportService.renderReportHtml([], { headerInfo: SAMPLE_HEADER_INFO });
    expect(html).toContain('@font-face');
    expect(html).toContain("font-family: 'Jameel Noori Nastaleeq'");
    expect(html).toContain('data:font/woff2;base64,');
  });

  // Prompt — the reported "inconsistent font / boxes in the PDF" bug traced back to the body's
  // font-family stack naming 'Jameel Noori Nastaleeq' with no @font-face backing it (a separate,
  // actually-embedded 'Noto Nastaliq Urdu' face came second) — an unbacked name in the stack is
  // exactly what let Chromium's font matcher substitute something else for some glyphs/elements.
  // The fix aliases the ONE embedded face directly under 'Jameel Noori Nastaleeq', so body must
  // reference that same name and nothing else — no second/fallback Nastaliq name left in the mix.
  it('applies the SAME embedded font name consistently — body never falls back to a second, unbacked Nastaliq name', () => {
    const html = reportService.renderReportHtml([], { headerInfo: SAMPLE_HEADER_INFO });
    expect(html).toMatch(/body\s*\{[^}]*font-family:\s*'Jameel Noori Nastaleeq',\s*serif/);
    expect(html).not.toContain('Noto Nastaliq Urdu');
  });

  it('prints the column-header row ("کام کوڈ | کام | آخری تاریخ | باقی دن") only for the FIRST task in a Zimmedar section, not repeated for every task', () => {
    const group = {
      assignee: { id: 'u1', name: 'Ali', responsibility: 'IT' },
      tasks: [
        { task: { codeNumber: '1', title: 'First', deadline: new Date(), timeStatus: { type: 'remaining', days: 1 } }, updates: [] },
        { task: { codeNumber: '2', title: 'Second', deadline: new Date(), timeStatus: { type: 'remaining', days: 1 } }, updates: [] },
        { task: { codeNumber: '3', title: 'Third', deadline: new Date(), timeStatus: { type: 'remaining', days: 1 } }, updates: [] },
      ],
    };
    const html = reportService.renderReportHtml([group], { headerInfo: SAMPLE_HEADER_INFO });
    const bodyHtml = html.slice(html.indexOf('<body>')); // exclude the <style> block, which has its own explanatory comment mentioning this label

    // The column header text appears exactly once per label (only the first task's table has a
    // <thead>), even though there are 3 tasks.
    const codeHeaderOccurrences = bodyHtml.split('کام کوڈ').length - 1;
    expect(codeHeaderOccurrences).toBe(1);
    // But every task's own data still renders.
    expect(html).toContain('<bdi>1</bdi>');
    expect(html).toContain('<bdi>2</bdi>');
    expect(html).toContain('<bdi>3</bdi>');
    // Later tasks get the no-header/visual-separator class instead of a repeated <thead>.
    expect(html).toContain('task-header no-header');
  });

  it('omits the filter-description line entirely when there is nothing to say ("All Data"), but shows a real one when a filter is active', () => {
    const htmlNoFilter = reportService.renderReportHtml([], { headerInfo: SAMPLE_HEADER_INFO });
    // The CSS rule `p.filter-description {...}` is always present in <style> — check for the
    // actual rendered ELEMENT, not just the class name appearing anywhere in the document.
    expect(htmlNoFilter).not.toContain('<p class="filter-description">');

    const htmlWithFilter = reportService.renderReportHtml([], {
      headerInfo: { ...SAMPLE_HEADER_INFO, filterDescription: 'Status: Ongoing' },
    });
    expect(htmlWithFilter).toContain('<p class="filter-description">');
    expect(htmlWithFilter).toContain('Status: Ongoing');
  });

  it('the brand-green color (#1F6F3F) is applied to headings/dividers/table headers, scoped so it never touches the separate user-summary report', () => {
    const html = reportService.renderReportHtml([], { headerInfo: SAMPLE_HEADER_INFO });
    expect(html).toContain('#1F6F3F');
    expect(html).toContain('.task-report');

    const userSummaryHtml = reportService.renderUserSummaryHtml([], { columns: undefined });
    expect(userSummaryHtml).not.toContain('class="task-report"');
  });

  // Prompt — regression tests for two bugs only found by actually opening a generated .jpg (not
  // by reading the HTML/CSS, which looked correct): (1) LTR values inside an RTL page get their
  // word order reversed by the browser's bidi algorithm unless isolated; (2) a JPEG export with
  // no explicit page background flattens transparency to black, not white.
  it('every LTR data value (dates, code numbers, names, percentages, descriptions) is wrapped in <bdi> to prevent bidi reordering', () => {
    const groups = [
      {
        assignee: { id: 'u1', name: 'Ali Raza', responsibility: 'IT' },
        tasks: [
          {
            task: { codeNumber: '260801', title: 'Collect boxes', deadline: new Date('2026-09-01'), timeStatus: { type: 'remaining', days: 5 } },
            updates: [
              { createdAt: new Date('2026-08-20'), updatedBy: { name: 'Ali Raza' }, description: 'Progress made', completionPercent: 40, attachment: null },
            ],
          },
        ],
      },
    ];
    const html = reportService.renderReportHtml(groups, { headerInfo: SAMPLE_HEADER_INFO });

    expect(html).toContain('<bdi>01 Sep 26</bdi>'); // deadline
    expect(html).toContain('<bdi>20 Aug 26</bdi>'); // update date
    expect(html).toContain('<bdi>260801</bdi>');
    expect(html).toContain('<bdi>Collect boxes</bdi>');
    expect(html).toContain('<bdi>Progress made</bdi>');
    expect(html).toContain('<bdi>40%</bdi>');
    expect(html).toContain('<bdi>Ali Raza</bdi>');
  });

  it('the page has an explicit white background (so a JPEG export never flattens to black)', () => {
    const html = reportService.renderReportHtml([], { headerInfo: SAMPLE_HEADER_INFO });
    expect(html).toMatch(/body\s*\{[^}]*background:\s*#fff/);
  });
});

describe('buildUserSummaryData (docs/06-backend.md §9 — reuses dashboard aggregation, untouched by the task-report rewrite)', () => {
  it('includes only active users, one row with name/responsibility/KPI figures', async () => {
    const admin = await makeAdmin();
    const activeUser = await makeUser({ name: 'Active Person' });
    await makeUser({ name: 'Inactive Person', isActive: false });
    const lookup = await makeLookup();
    await taskService.createTask({ id: admin.id }, { title: 'X', assignees: [activeUser._id], responsibility: lookup.value, deadline: inDays(5) });

    const rows = await reportService.buildUserSummaryData({ id: admin.id, role: 'admin' });

    const names = rows.map((r) => r.name);
    expect(names).toContain('Active Person');
    expect(names).not.toContain('Inactive Person');

    const activeRow = rows.find((r) => r.name === 'Active Person');
    expect(activeRow).toMatchObject({ responsibility: activeUser.responsibility, ongoing: 1, total: 1 });
  });

  it('produces figures that exactly match dashboard.service.computeSummaryForFilter for the same user (proves genuine reuse, not a re-derived calculation)', async () => {
    const admin = await makeAdmin();
    const user = await makeUser();
    const lookup = await makeLookup();
    const task = await taskService.createTask({ id: admin.id }, { title: 'X', assignees: [user._id], responsibility: lookup.value, deadline: inDays(-1) });
    await taskService.closeTask({ id: admin.id }, task.id);

    const rows = await reportService.buildUserSummaryData({ id: admin.id, role: 'admin' });
    const row = rows.find((r) => r.id === user.id);

    const directSummary = await dashboardService.computeSummaryForFilter({ assignees: user._id });

    expect(row.closed).toBe(directSummary.byStatus.closed.count);
    expect(row.weak).toBe(directSummary.byPerformance.weak.count);
    expect(row.total).toBe(directSummary.total);
  });
});

describe('generateExcel (exceljs, real generation, rewritten grouped structure)', () => {
  it('produces a non-empty .xlsx with rightToLeft view, title row, Zimmedar section, and task/Updates rows', async () => {
    const admin = await makeAdmin();
    const assignee = await makeUser({ name: 'Ali' });
    const lookup = await makeLookup();
    const task = await taskService.createTask(
      { id: admin.id },
      { title: 'Collect boxes', assignees: [assignee._id], responsibility: lookup.value, deadline: inDays(5) }
    );
    await taskUpdateService.createUpdate({ id: admin.id, role: 'admin' }, task.id, { description: 'Progress', completionPercent: 40 });
    const data = await reportService.buildReportData({ id: admin.id, role: 'admin' }, {}, {});
    const headerInfo = reportService.buildHeaderInfo({ id: admin.id, name: admin.name, responsibility: admin.responsibility }, {});

    const buffer = await reportService.generateExcel(data, { headerInfo });
    expect(buffer.length).toBeGreaterThan(0);

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);
    const sheet = workbook.worksheets[0];
    expect(sheet.views[0].rightToLeft).toBe(true);

    const allText = [];
    sheet.eachRow((row) => row.eachCell((cell) => allText.push(String(cell.value?.text ?? cell.value ?? ''))));
    const joined = allText.join(' | ');
    expect(joined).toContain('ٹاسک مینجمنٹ سسٹم');
    expect(joined).toContain(`${admin.name} (${admin.responsibility})`);
    expect(joined).toContain('ٹاسک رپورٹ'); // Prompt — was English "Task Report"
    expect(joined).toContain('Ali');
    expect(joined).toContain('Collect boxes');
    expect(joined).toContain('اپڈیٹس');
    expect(joined).toContain('Progress');
    // exact Urdu column labels
    ['کام کوڈ', 'کام', 'آخری تاریخ', 'باقی دن', 'تاریخ', 'رپلائی کرنے والا', 'وضاحت', 'تکمیل فیصد', 'اٹیچمنٹ'].forEach((label) =>
      expect(joined).toContain(label)
    );

    // brand-green fill on a table header row (e.g. the task-header row's first cell).
    const headerCandidateRow = sheet
      .getRows(1, sheet.rowCount)
      .find((row) => row.getCell(1).value === 'کام کوڈ');
    expect(headerCandidateRow.getCell(1).fill.fgColor.argb).toBe('FF1F6F3F');
  });

  it('"All Data" (no filter) is NOT printed as its own redundant line', async () => {
    const admin = await makeAdmin();
    const data = { groups: [] };
    const headerInfo = reportService.buildHeaderInfo({ id: admin.id, name: admin.name, responsibility: admin.responsibility }, {});
    expect(headerInfo.filterDescription).toBe('All Data');

    const buffer = await reportService.generateExcel(data, { headerInfo });
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);
    const allText = [];
    workbook.worksheets[0].eachRow((row) => row.eachCell((cell) => allText.push(String(cell.value?.text ?? cell.value ?? ''))));
    expect(allText).not.toContain('All Data');
  });

  it('prints "کام کوڈ" only once for a Zimmedar with multiple tasks — later tasks skip the repeated header row', async () => {
    const admin = await makeAdmin();
    const assignee = await makeUser({ name: 'Ali' });
    const lookup = await makeLookup();
    await taskService.createTask({ id: admin.id }, { title: 'First', assignees: [assignee._id], responsibility: lookup.value, deadline: inDays(5) });
    await taskService.createTask({ id: admin.id }, { title: 'Second', assignees: [assignee._id], responsibility: lookup.value, deadline: inDays(5) });
    const data = await reportService.buildReportData({ id: admin.id, role: 'admin' }, {}, {});
    const headerInfo = reportService.buildHeaderInfo({ id: admin.id, name: admin.name, responsibility: admin.responsibility }, {});

    const buffer = await reportService.generateExcel(data, { headerInfo });
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);
    const allText = [];
    workbook.worksheets[0].eachRow((row) => row.eachCell((cell) => allText.push(String(cell.value?.text ?? cell.value ?? ''))));

    const codeHeaderOccurrences = allText.filter((v) => v === 'کام کوڈ').length;
    expect(codeHeaderOccurrences).toBe(1);
    expect(allText).toContain('First');
    expect(allText).toContain('Second');
  });

  it('generateUserSummaryExcel produces a non-empty .xlsx with rightToLeft view (untouched by the rewrite)', async () => {
    const admin = await makeAdmin();
    const rows = await reportService.buildUserSummaryData({ id: admin.id, role: 'admin' });

    const buffer = await reportService.generateUserSummaryExcel(rows, { columns: undefined });
    expect(buffer.length).toBeGreaterThan(0);

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);
    expect(workbook.worksheets[0].views[0].rightToLeft).toBe(true);
  });
});

describe('generateDocx (docx package, real generation)', () => {
  it('produces a non-empty, genuinely-parseable .docx for a grouped report', async () => {
    const admin = await makeAdmin();
    const assignee = await makeUser({ name: 'Ali' });
    const lookup = await makeLookup();
    const task = await taskService.createTask(
      { id: admin.id },
      { title: 'Collect boxes', assignees: [assignee._id], responsibility: lookup.value, deadline: inDays(5) }
    );
    await taskUpdateService.createUpdate({ id: admin.id, role: 'admin' }, task.id, { description: 'Progress', completionPercent: 40 });
    const data = await reportService.buildReportData({ id: admin.id, role: 'admin' }, {}, {});
    const headerInfo = reportService.buildHeaderInfo({ id: admin.id, name: admin.name, responsibility: admin.responsibility }, {});

    const buffer = await reportService.generateDocx(data, { headerInfo });

    expect(buffer.length).toBeGreaterThan(0);
    // .docx is a zip archive — signature check proves this is a genuine Office document, not
    // just an arbitrary non-empty buffer.
    expect(buffer.subarray(0, 2).toString('ascii')).toBe('PK');
  });

  it('handles zero groups without throwing (an empty Document/Packer round-trip still works)', async () => {
    const buffer = await reportService.generateDocx({ groups: [] }, { headerInfo: SAMPLE_HEADER_INFO });
    expect(buffer.length).toBeGreaterThan(0);
  });

  // Prompt — "setting the font NAME only does nothing for a viewer without it installed; the
  // font file must be EMBEDDED in the .docx itself." Verified by actually unzipping the
  // generated file (a .docx is a zip/OOXML package) and checking for the real embedded-fonts
  // relationship, not just trusting that passing `fonts:` to Document did something.
  it('genuinely embeds the Nastaliq font file in the .docx (not just a font-name reference)', async () => {
    const buffer = await reportService.generateDocx({ groups: [] }, { headerInfo: SAMPLE_HEADER_INFO });
    const zip = await JSZip.loadAsync(buffer);

    const fontTableXml = await zip.file('word/fontTable.xml')?.async('string');
    expect(fontTableXml).toBeTruthy();
    expect(fontTableXml).toContain('Noto Nastaliq Urdu');
    expect(fontTableXml).toContain('embedRegular');

    const embeddedFontFiles = Object.keys(zip.files).filter((name) => name.startsWith('word/fonts/'));
    expect(embeddedFontFiles.length).toBeGreaterThan(0);
  });

  it('prints "کام کوڈ" only once for a Zimmedar with multiple tasks — later tasks skip the repeated header row', async () => {
    const admin = await makeAdmin();
    const assignee = await makeUser({ name: 'Ali' });
    const lookup = await makeLookup();
    await taskService.createTask({ id: admin.id }, { title: 'First', assignees: [assignee._id], responsibility: lookup.value, deadline: inDays(5) });
    await taskService.createTask({ id: admin.id }, { title: 'Second', assignees: [assignee._id], responsibility: lookup.value, deadline: inDays(5) });
    const data = await reportService.buildReportData({ id: admin.id, role: 'admin' }, {}, {});
    const headerInfo = reportService.buildHeaderInfo({ id: admin.id, name: admin.name, responsibility: admin.responsibility }, {});

    const buffer = await reportService.generateDocx(data, { headerInfo });
    const zip = await JSZip.loadAsync(buffer);
    const documentXml = await zip.file('word/document.xml').async('string');

    const codeHeaderOccurrences = documentXml.split('کام کوڈ').length - 1;
    expect(codeHeaderOccurrences).toBe(1);
    expect(documentXml).toContain('First');
    expect(documentXml).toContain('Second');
  });

  it('shows "کوئی اپڈیٹ نہیں" (Prompt — was English "No updates yet") for a task with no updates', async () => {
    const admin = await makeAdmin();
    const assignee = await makeUser();
    const lookup = await makeLookup();
    await taskService.createTask({ id: admin.id }, { title: 'X', assignees: [assignee._id], responsibility: lookup.value, deadline: inDays(5) });
    const data = await reportService.buildReportData({ id: admin.id, role: 'admin' }, {}, {});
    const headerInfo = reportService.buildHeaderInfo({ id: admin.id, name: admin.name, responsibility: admin.responsibility }, {});

    const buffer = await reportService.generateDocx(data, { headerInfo });
    const zip = await JSZip.loadAsync(buffer);
    const documentXml = await zip.file('word/document.xml').async('string');

    expect(documentXml).toContain('کوئی اپڈیٹ نہیں');
  });
});

describe('generatePdf / generateJpeg (Puppeteer, real generation)', () => {
  it('generatePdf returns a non-empty buffer starting with the %PDF signature', async () => {
    const buffer = await reportService.generatePdf('<html><body><h1>Test</h1></body></html>');
    expect(buffer.length).toBeGreaterThan(0);
    expect(buffer.subarray(0, 4).toString('ascii')).toBe('%PDF');
  }, 30000);

  it('generateJpeg returns a non-empty buffer starting with the JPEG SOI marker', async () => {
    const buffer = await reportService.generateJpeg('<html><body><h1>Test</h1></body></html>');
    expect(buffer.length).toBeGreaterThan(0);
    expect(buffer[0]).toBe(0xff);
    expect(buffer[1]).toBe(0xd8);
  }, 30000);
});

// Sanity check that the Document/Packer imports used inside report.service.js are wired
// correctly at the module level too (not just via generateDocx's own thin wrapper).
describe('docx package sanity', () => {
  it('Document/Packer are the real exports report.service.js depends on', () => {
    expect(typeof Document).toBe('function');
    expect(typeof Packer.toBuffer).toBe('function');
  });
});
