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

  it('carries the report-generator line (name + their own responsibility) and today\'s date, in the same "DD-MM-YY" format used everywhere else', () => {
    const info = reportService.buildHeaderInfo({ name: 'Admin Person', responsibility: 'Zonal Incharge' }, {});
    expect(info.generatedByLine).toBe('Admin Person (Zonal Incharge)');
    expect(info.generatedAtLabel).toMatch(/^\d{2}-\d{2}-\d{2}$/); // e.g. "09-09-26" — today, so not hardcoded
  });

  it('builds the filter description with DD-MM-YY range endpoints: "Status: Ongoing, Deadline: 01-08-26–31-08-26"', () => {
    const description = reportService.buildFilterDescription({
      status: 'ongoing',
      deadlineFrom: new Date('2026-08-01T00:00:00Z'),
      deadlineTo: new Date('2026-08-31T00:00:00Z'),
    });
    expect(description).toBe('Status: Ongoing, Deadline: 01-08-26–31-08-26');
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
  generatedAtLabel: '09-09-26',
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
    expect(html).toContain('<bdi>09-09-26</bdi>');
  });

  it('renders an assignee header (with the exact ذمہ دار/ذمہ داری labels), task header row, and an اپڈیٹس table, per group/task', () => {
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
    // exact, LOCKED Urdu column labels/order for the task-summary table.
    ['کوڈ', 'کام کی تفصیل', 'باقی دن', 'آخری تاریخ'].forEach((label) => expect(html).toContain(label));
    // Updates render as ONE table again (client's latest request reverses the previous
    // card/conversation-block layout) — exactly these 4 columns, in this order, no 5th column.
    expect(html).toContain('<table class="updates-table">');
    expect(html).toMatch(/<thead><tr><th>تاریخ<\/th><th>اپڈیٹ کرنے والا<\/th><th>وضاحت<\/th><th>تکمیل فیصد<\/th><\/tr><\/thead>/);
    expect(html).not.toContain('<th>اٹیچمنٹ</th>');
  });

  it('folds an attachment into the وضاحت cell as a compact secondary line instead of a separate column', () => {
    const groups = [
      {
        assignee: { id: 'u1', name: 'Ali', responsibility: 'IT' },
        tasks: [
          {
            task: { codeNumber: '1', title: 'T', deadline: new Date(), timeStatus: { type: 'remaining', days: 1 } },
            updates: [
              {
                createdAt: new Date('2026-08-20'),
                updatedBy: { name: 'Ali' },
                description: 'Done',
                completionPercent: 100,
                attachment: { fileName: 'receipt.pdf', url: 'https://example.com/receipt.pdf' },
              },
            ],
          },
        ],
      },
    ];

    const html = reportService.renderReportHtml(groups, { headerInfo: SAMPLE_HEADER_INFO });

    expect(html).toContain('class="update-attachment"');
    expect(html).toContain('اٹیچمنٹ:');
    expect(html).toContain('href="https://example.com/receipt.pdf"');
    expect(html).toContain('receipt.pdf');
    // No attachment at all still renders cleanly, no leftover ".update-attachment" markup.
    const noAttachmentHtml = reportService.renderReportHtml(
      [
        {
          assignee: { id: 'u1', name: 'Ali', responsibility: 'IT' },
          tasks: [
            {
              task: { codeNumber: '1', title: 'T', deadline: new Date(), timeStatus: { type: 'remaining', days: 1 } },
              updates: [{ createdAt: new Date(), updatedBy: { name: 'Ali' }, description: 'Done', completionPercent: 100, attachment: null }],
            },
          ],
        },
      ],
      { headerInfo: SAMPLE_HEADER_INFO }
    );
    // Slice off the <style> block first — it declares the ".update-attachment" CSS rule
    // unconditionally, so checking the full document would always "find" the class name.
    const noAttachmentBodyHtml = noAttachmentHtml.slice(noAttachmentHtml.indexOf('<body>'));
    expect(noAttachmentBodyHtml).not.toContain('update-attachment');
  });

  it('keeps updates chronological (oldest first) and never merges multiple updates into one row', () => {
    const groups = [
      {
        assignee: { id: 'u1', name: 'Ali', responsibility: 'IT' },
        tasks: [
          {
            task: { codeNumber: '1', title: 'T', deadline: new Date(), timeStatus: { type: 'remaining', days: 1 } },
            updates: [
              { createdAt: new Date('2026-08-01'), updatedBy: { name: 'Ali' }, description: 'First message', completionPercent: 10, attachment: null },
              { createdAt: new Date('2026-08-15'), updatedBy: { name: 'Ali' }, description: 'Second message', completionPercent: 50, attachment: null },
            ],
          },
        ],
      },
    ];

    const html = reportService.renderReportHtml(groups, { headerInfo: SAMPLE_HEADER_INFO });
    const rowMatches = [...html.matchAll(/<tr>(?:(?!<\/tr>).)*?<\/tr>/gs)].map((m) => m[0]);
    const updateRows = rowMatches.filter((r) => r.includes('First message') || r.includes('Second message'));

    expect(updateRows).toHaveLength(2); // one <tr> per update, never merged
    expect(html.indexOf('First message')).toBeLessThan(html.indexOf('Second message')); // oldest first
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
    expect(html).toContain("font-family: 'Noto Nastaliq Urdu'");
    expect(html).toContain('data:font/woff2;base64,');
  });

  // Prompt — root-caused the "□ boxes in the Urdu PDF" bug to Chromium's PDF export embedding an
  // @font-face-only web font as a fragile per-glyph Type3 font instead of a real CIDFontType2 one
  // (verified by inspecting the actual generated PDF's font resources — see report.service.js's
  // own comment on buildFontconfigEnv). The fix installs 'Jameel Noori Nastaleeq' as a genuine OS
  // font at Puppeteer-launch time; body must try that name FIRST, with the @font-face-embedded
  // 'Noto Nastaliq Urdu' kept as an explicit fallback in case the OS-install doesn't apply.
  it('tries the OS-installed font name first, with the @font-face-embedded font as an explicit fallback (not the only name in the stack)', () => {
    const html = reportService.renderReportHtml([], { headerInfo: SAMPLE_HEADER_INFO });
    expect(html).toMatch(/body\s*\{[^}]*font-family:\s*'Jameel Noori Nastaleeq',\s*'Noto Nastaliq Urdu',\s*serif/);
  });

  it('prints the column-header row ("کوڈ | کام کی تفصیل | باقی دن | آخری تاریخ") for EVERY task in a Zimmedar section, not just the first', () => {
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

    // The column header text appears once per task — 3 tasks, 3 <thead> rows.
    const codeHeaderOccurrences = bodyHtml.split('کوڈ').length - 1;
    expect(codeHeaderOccurrences).toBe(3);
    // Each of these 3 tasks has an EMPTY updates array, which renders as a plain "کوئی اپڈیٹ
    // نہیں" paragraph, not a table (see renderUpdatesTableHtml) — so only the task-header table's
    // own thead contributes here: 3 tasks = 3 table-head rows total.
    expect(html.match(/<thead>/g)).toHaveLength(3);
    // Every task's own data still renders.
    expect(html).toContain('<bdi>1</bdi>');
    expect(html).toContain('<bdi>2</bdi>');
    expect(html).toContain('<bdi>3</bdi>');
    // No leftover "no-header"/skip class anywhere.
    expect(html).not.toContain('no-header');
  });

  // Prompt — visual-only "(01) Title" numbering: only kicks in once a ذمہ دار has MORE than one
  // task, starts at (01), never touches task.title/task.codeNumber, and a single-task section gets
  // no number at all (covered by the next test).
  it('prefixes task titles with "(01)", "(02)", "(03)"... when a Zimmedar has more than one task', () => {
    const group = {
      assignee: { id: 'u1', name: 'Ali', responsibility: 'IT' },
      tasks: [
        { task: { codeNumber: '1', title: 'First', deadline: new Date(), timeStatus: { type: 'remaining', days: 1 } }, updates: [] },
        { task: { codeNumber: '2', title: 'Second', deadline: new Date(), timeStatus: { type: 'remaining', days: 1 } }, updates: [] },
        { task: { codeNumber: '3', title: 'Third', deadline: new Date(), timeStatus: { type: 'remaining', days: 1 } }, updates: [] },
      ],
    };
    const html = reportService.renderReportHtml([group], { headerInfo: SAMPLE_HEADER_INFO });
    expect(html).toContain('<bdi>(01) First</bdi>');
    expect(html).toContain('<bdi>(02) Second</bdi>');
    expect(html).toContain('<bdi>(03) Third</bdi>');
  });

  it('does NOT number a task title when its Zimmedar has only one task', () => {
    const group = {
      assignee: { id: 'u1', name: 'Ali', responsibility: 'IT' },
      tasks: [{ task: { codeNumber: '1', title: 'Solo Task', deadline: new Date(), timeStatus: { type: 'remaining', days: 1 } }, updates: [] }],
    };
    const html = reportService.renderReportHtml([group], { headerInfo: SAMPLE_HEADER_INFO });
    expect(html).toContain('<bdi>Solo Task</bdi>');
    expect(html).not.toContain('(01)');
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

    expect(html).toContain('<bdi>01-09-26</bdi>'); // deadline
    expect(html).toContain('<bdi>20-08-26</bdi>'); // update date
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
    // exact Urdu column labels — locked task-summary set (کوڈ/کام کی تفصیل/باقی دن/آخری تاریخ)
    // plus the Updates table's own separate labels.
    ['کوڈ', 'کام کی تفصیل', 'باقی دن', 'آخری تاریخ', 'تاریخ', 'رپلائی کرنے والا', 'وضاحت', 'تکمیل فیصد', 'اٹیچمنٹ'].forEach((label) =>
      expect(joined).toContain(label)
    );

    // brand-green fill on a table header row (e.g. the task-header row's first cell).
    const headerCandidateRow = sheet
      .getRows(1, sheet.rowCount)
      .find((row) => row.getCell(1).value === 'کوڈ');
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

    const codeHeaderOccurrences = allText.filter((v) => v === 'کوڈ').length;
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

  it('prints "کام کوڈ" for EVERY task in a Zimmedar section, not just the first, and numbers the titles "(01)"/"(02)"', async () => {
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

    const codeHeaderOccurrences = documentXml.split('کوڈ').length - 1;
    expect(codeHeaderOccurrences).toBe(2);
    expect(documentXml).toContain('(01) First');
    expect(documentXml).toContain('(02) Second');
  });

  // Prompt — the client's own explicit challenge: `bidirectional: true` on a paragraph only
  // affects TEXT flow within a cell, not the TABLE'S column order — Word still lays columns out
  // left-to-right in literal cell-insertion order unless the table itself carries OOXML's
  // `<w:bidiVisual/>` flag (docx.js's `visuallyRightToLeft` option). This asserts the actual XML
  // tag is present on the generated table, not just that the document "looks" RTL. Updates are no
  // longer rendered as a table at all (see docxUpdateEntry) — only the one task-header table
  // exists per task now, so a single task's report has exactly 1 bidiVisual table.
  it('sets genuine OOXML table-direction RTL (<w:bidiVisual/>) on BOTH the task-header and Updates tables, not just paragraph-level bidi', async () => {
    const admin = await makeAdmin();
    const assignee = await makeUser({ name: 'Ali' });
    const lookup = await makeLookup();
    await taskService.createTask({ id: admin.id }, { title: 'First', assignees: [assignee._id], responsibility: lookup.value, deadline: inDays(5) });
    const data = await reportService.buildReportData({ id: admin.id, role: 'admin' }, {}, {});
    const headerInfo = reportService.buildHeaderInfo({ id: admin.id, name: admin.name, responsibility: admin.responsibility }, {});

    const buffer = await reportService.generateDocx(data, { headerInfo });
    const zip = await JSZip.loadAsync(buffer);
    const documentXml = await zip.file('word/document.xml').async('string');

    // One task-header table + one Updates table (still a table even with zero updates — see
    // docxUpdatesTable's empty-state branch) = 2 tables, both genuinely RTL.
    const bidiVisualOccurrences = documentXml.split('bidiVisual').length - 1;
    expect(bidiVisualOccurrences).toBe(2);
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

  // Prompt — root cause of the "JPEG cropped on the right side" report: Puppeteer's page stayed
  // at its own default 800px-wide viewport, and fullPage:true only extends the CAPTURED height,
  // never the width — content wider than 800px (a long, unwrapped RTL header line, matching real
  // reports once a filter narrows to one ذمہ دار) got cut off. This HTML has an unwrapped div far
  // wider than 800px on purpose; the fix (resizeViewportToContent) measures the page's own real
  // scrollWidth and resizes the viewport to match before capturing — so the resulting JPEG's own
  // pixel width must cover the full unwrapped content, not be clamped at the old 800px default.
  it('generateJpeg is never cropped: a JPEG wider than Puppeteer\'s 800px default viewport captures its FULL width', async () => {
    const wideHtml = `<html dir="rtl"><body style="margin:0">
      <div style="white-space:nowrap; font-size:20px;">${'ایک لمبی اور غیر لپٹی ہوئی سطر '.repeat(20)}</div>
    </body></html>`;
    const buffer = await reportService.generateJpeg(wideHtml);
    const { width } = readJpegDimensions(buffer);
    expect(width).toBeGreaterThan(800);
  }, 30000);
});

// Minimal, dependency-free JPEG width/height reader: scans markers for a Start-Of-Frame segment
// (SOF0/SOF2 — the only ones Chromium's screenshot encoder emits) and reads its big-endian
// height/width fields, exactly as the JPEG spec lays them out.
function readJpegDimensions(buffer) {
  let offset = 2; // skip the SOI marker (0xFFD8)
  while (offset < buffer.length) {
    if (buffer[offset] !== 0xff) throw new Error('Malformed JPEG: expected a marker');
    const marker = buffer[offset + 1];
    if (marker === 0xc0 || marker === 0xc2) {
      const height = buffer.readUInt16BE(offset + 5);
      const width = buffer.readUInt16BE(offset + 7);
      return { width, height };
    }
    const segmentLength = buffer.readUInt16BE(offset + 2);
    offset += 2 + segmentLength;
  }
  throw new Error('No SOF marker found in JPEG');
}

// Sanity check that the Document/Packer imports used inside report.service.js are wired
// correctly at the module level too (not just via generateDocx's own thin wrapper).
describe('docx package sanity', () => {
  it('Document/Packer are the real exports report.service.js depends on', () => {
    expect(typeof Document).toBe('function');
    expect(typeof Packer.toBuffer).toBe('function');
  });
});
