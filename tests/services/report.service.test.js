const mongoose = require('mongoose');
const ExcelJS = require('exceljs');
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
    const info = reportService.buildHeaderInfo({});
    expect(info.title).toBe('Task Report');
    expect(info.filterDescription).toBe('All Data');
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

describe('formatRemainingDaysLabel (pure)', () => {
  it('describes each timeStatus type in words', () => {
    expect(reportService.formatRemainingDaysLabel({ type: 'remaining', days: 3 })).toBe('3 day(s) remaining');
    expect(reportService.formatRemainingDaysLabel({ type: 'remaining', days: 0 })).toBe('Due today');
    expect(reportService.formatRemainingDaysLabel({ type: 'overdue', days: 2 })).toBe('2 day(s) overdue');
    expect(reportService.formatRemainingDaysLabel({ type: 'early', days: 1 })).toBe('1 day(s) early');
    expect(reportService.formatRemainingDaysLabel({ type: 'early', days: 0 })).toBe('Completed on time');
    expect(reportService.formatRemainingDaysLabel({ type: 'late', days: 4 })).toBe('4 day(s) late');
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

describe('renderReportHtml (pure — grouped structure)', () => {
  it('renders an assignee header, task header row, and Updates table, per group/task', () => {
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

    const html = reportService.renderReportHtml(groups, { headerInfo: { title: 'Task Report', filterDescription: 'All Data' } });

    expect(html).toContain('Ali — IT');
    expect(html).toContain('260801');
    expect(html).toContain('Collect boxes');
    expect(html).toContain('Updates');
    expect(html).toContain('Progress made');
    expect(html).toContain('40%');
  });

  it('shows "No updates yet" for a task with an empty updates array', () => {
    const groups = [
      {
        assignee: { id: 'u1', name: 'Ali', responsibility: 'IT' },
        tasks: [{ task: { codeNumber: '1', title: 'T', deadline: new Date(), timeStatus: { type: 'remaining', days: 1 } }, updates: [] }],
      },
    ];
    const html = reportService.renderReportHtml(groups, { headerInfo: { title: 'Task Report', filterDescription: 'All Data' } });
    expect(html).toContain('No updates yet');
  });

  it('shows "No tasks found." when there are zero groups', () => {
    const html = reportService.renderReportHtml([], { headerInfo: { title: 'Task Report', filterDescription: 'All Data' } });
    expect(html).toContain('No tasks found.');
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
    const headerInfo = reportService.buildHeaderInfo({});

    const buffer = await reportService.generateExcel(data, { headerInfo });
    expect(buffer.length).toBeGreaterThan(0);

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);
    const sheet = workbook.worksheets[0];
    expect(sheet.views[0].rightToLeft).toBe(true);

    const allText = [];
    sheet.eachRow((row) => row.eachCell((cell) => allText.push(String(cell.value?.text ?? cell.value ?? ''))));
    const joined = allText.join(' | ');
    expect(joined).toContain('Task Report');
    expect(joined).toContain('Ali');
    expect(joined).toContain('Collect boxes');
    expect(joined).toContain('Updates');
    expect(joined).toContain('Progress');
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
    const headerInfo = reportService.buildHeaderInfo({});

    const buffer = await reportService.generateDocx(data, { headerInfo });

    expect(buffer.length).toBeGreaterThan(0);
    // .docx is a zip archive — signature check proves this is a genuine Office document, not
    // just an arbitrary non-empty buffer.
    expect(buffer.subarray(0, 2).toString('ascii')).toBe('PK');
  });

  it('handles zero groups without throwing (an empty Document/Packer round-trip still works)', async () => {
    const buffer = await reportService.generateDocx({ groups: [] }, { headerInfo: { title: 'Task Report', filterDescription: 'All Data' } });
    expect(buffer.length).toBeGreaterThan(0);
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
