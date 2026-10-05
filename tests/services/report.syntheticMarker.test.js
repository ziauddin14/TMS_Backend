const ExcelJS = require('exceljs');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const request = require('supertest');
const app = require('../../src/app');
const env = require('../../src/config/env');
const { connect, closeDatabase, clearDatabase } = require('../helpers/db');
const User = require('../../src/models/User');
const Task = require('../../src/models/Task');
const reportService = require('../../src/services/report.service');

// Reports must never present a developer-assigned (synthetic, "تخمینی") rating as a real one. The
// user-summary report counts ratings per person, so it always says how many of them are synthetic.
beforeAll(async () => connect());
afterEach(async () => clearDatabase());
afterAll(async () => closeDatabase());

const SYNTHETIC_HEADER = 'تخمینی (Estimated)';
const NOTE_START = 'تخمینی (Estimated): developer-assigned ratings, not real ones.';
const day = (iso) => new Date(`${iso}T00:00:00.000Z`);

async function seed() {
  const admin = await User.create({ name: 'Admin', email: `a${new mongoose.Types.ObjectId()}@x.com`, responsibility: 'Admin', role: 'admin' });
  const userA = await User.create({ name: 'Person A', email: `ua${new mongoose.Types.ObjectId()}@x.com`, responsibility: 'R1', role: 'user' });
  const userB = await User.create({ name: 'Person B', email: `ub${new mongoose.Types.ObjectId()}@x.com`, responsibility: 'R2', role: 'user' });
  const base = (code, extra) => ({ codeNumber: code, title: `task ${code}`, assignees: [userA._id], responsibility: 'R1', deadline: day('2026-06-30'), createdBy: admin._id, ...extra });
  const syn = (assumedPercent) => ({ isSynthetic: true, assumedPercent, assignedAt: day('2026-10-05'), assignedBy: 'system:script' });
  await Task.create([
    base('260101', { status: 'closed', completionPercent: 95, performanceRating: 'excellent' }), // real
    base('260102', { status: 'closed', performanceRating: 'good', syntheticRating: syn(80) }),
    base('260103', { status: 'pending', performanceRating: 'weak', syntheticRating: syn(40) }),
    base('260104', { status: 'ongoing' }), // unrated
    base('260201', { assignees: [userB._id], responsibility: 'R2', status: 'closed', completionPercent: 50, performanceRating: 'weak' }), // real
  ]);
  return { admin, userA, userB };
}
const headerCells = (html) => [...html.matchAll(/<th>(.*?)<\/th>/g)].map((m) => m[1]);

describe('user-summary report — synthetic ratings are marked', () => {
  it('each row carries how many of that person\'s ratings are synthetic', async () => {
    const { admin } = await seed();

    const rows = await reportService.buildUserSummaryData({ id: admin.id, role: 'admin' });

    const a = rows.find((r) => r.name === 'Person A');
    const b = rows.find((r) => r.name === 'Person B');
    // Person A: 3 rated (excellent real, good + weak synthetic), 1 unrated.
    expect(a).toMatchObject({ excellent: 1, good: 1, fair: 0, weak: 1, synthetic: 2, notApplicable: 1, total: 4 });
    expect(b).toMatchObject({ weak: 1, synthetic: 0, notApplicable: 0, total: 1 });
    expect(rows.find((r) => r.name === 'Admin')).toMatchObject({ synthetic: 0, total: 0 });
  });

  it('HTML (PDF/JPEG): the تخمینی column sits right after the rating columns, with an explanatory note', async () => {
    const { admin } = await seed();
    const rows = await reportService.buildUserSummaryData({ id: admin.id, role: 'admin' });

    const html = reportService.renderUserSummaryHtml(rows, { columns: undefined });

    expect(headerCells(html)).toEqual(['Name', 'Responsibility', 'Ongoing', 'Pending', 'Complete', 'Closed', 'Excellent', 'Good', 'Fair', 'Weak', SYNTHETIC_HEADER, 'N/A', 'Total']);
    expect(html).toContain(NOTE_START);
    // Person A's row: Ongoing 1, Pending 1, Complete 0, Closed 2 · Excellent 1, Good 1, Fair 0,
    // Weak 1 · تخمینی 2 · N/A 1 · Total 4
    const cells = [1, 1, 0, 2, 1, 1, 0, 1, 2, 1, 4].map((n) => `<td>${n}</td>`).join('');
    expect(html).toContain(`<td>Person A</td><td>R1</td>${cells}`);
  });

  it('an older client that never asks for the column still gets it whenever a rating column is shown', async () => {
    const { admin } = await seed();
    const rows = await reportService.buildUserSummaryData({ id: admin.id, role: 'admin' });

    // The column list the already-deployed frontend sends: it does not know "synthetic" exists.
    const html = reportService.renderUserSummaryHtml(rows, { columns: ['name', 'good', 'weak', 'total'] });

    expect(headerCells(html)).toEqual(['Name', 'Good', 'Weak', SYNTHETIC_HEADER, 'Total']);
    expect(html).toContain(NOTE_START);
  });

  it('a report with no rating column at all has nothing to mark: no column, no note', async () => {
    const { admin } = await seed();
    const rows = await reportService.buildUserSummaryData({ id: admin.id, role: 'admin' });

    const html = reportService.renderUserSummaryHtml(rows, { columns: ['name', 'ongoing', 'closed', 'total'] });

    expect(headerCells(html)).toEqual(['Name', 'Ongoing', 'Closed', 'Total']);
    expect(html).not.toContain('تخمینی');
  });

  it('Excel: the same column and note', async () => {
    const { admin } = await seed();
    const rows = await reportService.buildUserSummaryData({ id: admin.id, role: 'admin' });

    const buffer = await reportService.generateUserSummaryExcel(rows, { columns: undefined });

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);
    const sheet = workbook.worksheets[0];
    const header = sheet.getRow(1).values.slice(1);
    expect(header).toEqual(['Name', 'Responsibility', 'Ongoing', 'Pending', 'Complete', 'Closed', 'Excellent', 'Good', 'Fair', 'Weak', SYNTHETIC_HEADER, 'N/A', 'Total']);
    const syntheticColumn = header.indexOf(SYNTHETIC_HEADER) + 1;
    const rowsByFirstCell = {};
    let lastFirstCell = null;
    sheet.eachRow((row) => {
      rowsByFirstCell[row.getCell(1).value] = row;
      lastFirstCell = row.getCell(1).value;
    });
    expect(rowsByFirstCell['Person A'].getCell(syntheticColumn).value).toBe(2);
    expect(rowsByFirstCell['Person B'].getCell(syntheticColumn).value).toBe(0);
    // The note is the last thing on the sheet.
    expect(String(lastFirstCell)).toContain(NOTE_START);
  });

  it('Excel for an older client\'s column list: column and note still present', async () => {
    const { admin } = await seed();
    const rows = await reportService.buildUserSummaryData({ id: admin.id, role: 'admin' });

    const buffer = await reportService.generateUserSummaryExcel(rows, { columns: ['name', 'excellent'] });

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);
    expect(workbook.worksheets[0].getRow(1).values.slice(1)).toEqual(['Name', 'Excellent', SYNTHETIC_HEADER]);
  });
});

describe('task report export — the synthetic / real filter', () => {
  const tokenFor = (user) => jwt.sign({ sub: user.id, role: user.role }, env.JWT_SECRET, { expiresIn: env.JWT_EXPIRES_IN });

  it('buildReportData lists only the tasks the same filter lists on the dashboard', async () => {
    const { admin } = await seed();
    const requester = { id: admin.id, role: 'admin' };
    const codes = (data) => JSON.stringify(data).match(/2602?0?\d{3}|26010\d/g) || [];

    const syntheticOnly = await reportService.buildReportData(requester, { ratingSource: 'synthetic' }, {});
    const realOnly = await reportService.buildReportData(requester, { ratingSource: 'real' }, {});

    expect([...new Set(codes(syntheticOnly))].sort()).toEqual(['260102', '260103']);
    expect([...new Set(codes(realOnly))].sort()).toEqual(['260101', '260201']);
  });

  it('GET /reports/export accepts ratingSource, and rejects an unknown value', async () => {
    const { admin } = await seed();

    const ok = await request(app).get('/api/v1/reports/export?format=excel&ratingSource=synthetic').set('Authorization', `Bearer ${tokenFor(admin)}`);
    const bad = await request(app).get('/api/v1/reports/export?format=excel&ratingSource=bogus').set('Authorization', `Bearer ${tokenFor(admin)}`);

    expect(ok.status).toBe(200);
    expect(bad.status).toBe(400);
  });
});
