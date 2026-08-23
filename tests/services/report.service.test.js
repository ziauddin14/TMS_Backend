const mongoose = require('mongoose');
const ExcelJS = require('exceljs');
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

describe('buildHeaderInfo (pure — docs/06-backend.md §9 header wording)', () => {
  it('shows the task name/responsibility when the result is a single task', () => {
    const tasks = [{ title: 'Collect boxes', responsibility: 'Donation Box Incharge' }];
    const info = reportService.buildHeaderInfo(tasks, {});
    expect(info.title).toBe('Task Report');
    expect(info.subject).toBe('Collect boxes (Donation Box Incharge)');
  });

  it('shows "All Responsible" when the result spans multiple tasks', () => {
    const tasks = [
      { title: 'A', responsibility: 'X' },
      { title: 'B', responsibility: 'Y' },
    ];
    const info = reportService.buildHeaderInfo(tasks, {});
    expect(info.subject).toBe('All Responsible');
  });

  it('shows "All Responsible" for zero tasks too (not a single-task label)', () => {
    const info = reportService.buildHeaderInfo([], {});
    expect(info.subject).toBe('All Responsible');
  });

  it('shows "All Data" when no filter was applied', () => {
    const info = reportService.buildHeaderInfo([{ title: 'A', responsibility: 'X' }], {});
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

describe('buildReportData (docs/06-backend.md §9 step 1)', () => {
  it('summary reportType returns tasks with no update history fetched', async () => {
    const admin = await makeAdmin();
    const assignee = await makeUser();
    const lookup = await makeLookup();
    const task = await taskService.createTask(
      { id: admin.id },
      { title: 'X', assignees: [assignee._id], responsibility: lookup.value, deadline: inDays(5) }
    );
    await taskUpdateService.createUpdate({ id: admin.id, role: 'admin' }, task.id, {
      description: 'Progress',
      completionPercent: 50,
    });

    const data = await reportService.buildReportData({ id: admin.id, role: 'admin' }, {}, 'summary');

    expect(data.reportType).toBe('summary');
    expect(data.tasks).toHaveLength(1);
    expect(data.tasks[0].task.completionPercent).toBe(50); // latest state, per "summary = latest update only"
    expect(data.tasks[0].updates).toEqual([]); // history NOT fetched for summary
  });

  it('detailed reportType includes the full update history per task', async () => {
    const admin = await makeAdmin();
    const assignee = await makeUser();
    const lookup = await makeLookup();
    const task = await taskService.createTask(
      { id: admin.id },
      { title: 'X', assignees: [assignee._id], responsibility: lookup.value, deadline: inDays(5) }
    );
    await taskUpdateService.createUpdate({ id: admin.id, role: 'admin' }, task.id, {
      description: 'First',
      completionPercent: 20,
    });
    await taskUpdateService.createUpdate({ id: admin.id, role: 'admin' }, task.id, {
      description: 'Second',
      completionPercent: 60,
    });

    const data = await reportService.buildReportData({ id: admin.id, role: 'admin' }, {}, 'detailed');

    expect(data.reportType).toBe('detailed');
    expect(data.tasks[0].updates).toHaveLength(2);
    expect(data.tasks[0].updates.map((u) => u.description).sort()).toEqual(['First', 'Second']);
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

    const data = await reportService.buildReportData({ id: admin.id, role: 'admin' }, {}, 'summary');
    expect(data.tasks).toHaveLength(5);
  });

  it('is RBAC-scoped exactly like GET /tasks: a User only gets their own tasks', async () => {
    const admin = await makeAdmin();
    const me = await makeUser();
    const other = await makeUser();
    const lookup = await makeLookup();
    await taskService.createTask(
      { id: admin.id },
      { title: 'Mine', assignees: [me._id], responsibility: lookup.value, deadline: inDays(5) }
    );
    await taskService.createTask(
      { id: admin.id },
      { title: 'Not mine', assignees: [other._id], responsibility: lookup.value, deadline: inDays(5) }
    );

    const data = await reportService.buildReportData({ id: me.id, role: 'user' }, {}, 'summary');

    expect(data.tasks).toHaveLength(1);
    expect(data.tasks[0].task.title).toBe('Mine');
  });
});

describe('buildUserSummaryData (docs/06-backend.md §9 — reuses dashboard aggregation)', () => {
  it('includes only active users, one row with name/responsibility/KPI figures', async () => {
    const admin = await makeAdmin();
    const activeUser = await makeUser({ name: 'Active Person' });
    await makeUser({ name: 'Inactive Person', isActive: false });
    const lookup = await makeLookup();
    await taskService.createTask(
      { id: admin.id },
      { title: 'X', assignees: [activeUser._id], responsibility: lookup.value, deadline: inDays(5) }
    );

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
    const task = await taskService.createTask(
      { id: admin.id },
      { title: 'X', assignees: [user._id], responsibility: lookup.value, deadline: inDays(-1) }
    );
    await taskService.closeTask({ id: admin.id }, task.id);

    const rows = await reportService.buildUserSummaryData({ id: admin.id, role: 'admin' });
    const row = rows.find((r) => r.id === user.id);

    const directSummary = await dashboardService.computeSummaryForFilter({ assignees: user._id });

    expect(row.closed).toBe(directSummary.byStatus.closed.count);
    expect(row.weak).toBe(directSummary.byPerformance.weak.count);
    expect(row.total).toBe(directSummary.total);
  });
});

describe('generateExcel / generateUserSummaryExcel (exceljs, real generation)', () => {
  it('generateExcel produces a non-empty .xlsx with rightToLeft view and RTL cell alignment', async () => {
    const admin = await makeAdmin();
    const assignee = await makeUser();
    const lookup = await makeLookup();
    await taskService.createTask(
      { id: admin.id },
      { title: 'X', assignees: [assignee._id], responsibility: lookup.value, deadline: inDays(5) }
    );
    const data = await reportService.buildReportData({ id: admin.id, role: 'admin' }, {}, 'summary');

    const buffer = await reportService.generateExcel(data, { columns: undefined });
    expect(buffer.length).toBeGreaterThan(0);

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);
    const sheet = workbook.worksheets[0];
    expect(sheet.views[0].rightToLeft).toBe(true);
    const firstDataRow = sheet.getRow(2);
    expect(firstDataRow.getCell(1).alignment.readingOrder).toBe('rtl');
  });

  it('omits columns not in the requested list', async () => {
    const admin = await makeAdmin();
    const assignee = await makeUser();
    const lookup = await makeLookup();
    await taskService.createTask(
      { id: admin.id },
      { title: 'X', assignees: [assignee._id], responsibility: lookup.value, deadline: inDays(5) }
    );
    const data = await reportService.buildReportData({ id: admin.id, role: 'admin' }, {}, 'summary');

    const buffer = await reportService.generateExcel(data, { columns: ['codeNumber', 'title'] });

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);
    const sheet = workbook.worksheets[0];
    const headerValues = sheet.getRow(1).values.filter(Boolean);
    expect(headerValues).toEqual(['Code Number', 'Task']);
  });

  it('generateUserSummaryExcel produces a non-empty .xlsx with rightToLeft view', async () => {
    const admin = await makeAdmin();
    const rows = await reportService.buildUserSummaryData({ id: admin.id, role: 'admin' });

    const buffer = await reportService.generateUserSummaryExcel(rows, { columns: undefined });
    expect(buffer.length).toBeGreaterThan(0);

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);
    expect(workbook.worksheets[0].views[0].rightToLeft).toBe(true);
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
