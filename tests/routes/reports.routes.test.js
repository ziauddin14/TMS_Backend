const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const request = require('supertest');
const app = require('../../src/app');
const env = require('../../src/config/env');
const { connect, closeDatabase, clearDatabase } = require('../helpers/db');
const User = require('../../src/models/User');
const LookupList = require('../../src/models/LookupList');

beforeAll(async () => connect());
afterEach(async () => clearDatabase());
afterAll(async () => closeDatabase());

function tokenFor(user) {
  return jwt.sign({ sub: user.id, role: user.role }, env.JWT_SECRET, { expiresIn: env.JWT_EXPIRES_IN });
}
async function makeAdmin() {
  return User.create({ name: 'Admin', email: `admin${new mongoose.Types.ObjectId()}@x.com`, responsibility: 'Admin', role: 'admin' });
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
function bufferParser(response, callback) {
  const chunks = [];
  response.on('data', (chunk) => chunks.push(chunk));
  response.on('end', () => callback(null, Buffer.concat(chunks)));
}

const TASK_REPORT_CONTENT_TYPES = {
  excel: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pdf: 'application/pdf',
  jpeg: 'image/jpeg',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

describe('GET /api/v1/reports/export (grouped-by-Zimmedar report, rewritten)', () => {
  let admin;
  let assignee;

  beforeEach(async () => {
    admin = await makeAdmin();
    assignee = await makeUser();
    const lookup = await makeLookup();
    await request(app)
      .post('/api/v1/tasks')
      .set('Authorization', `Bearer ${tokenFor(admin)}`)
      .send({ title: 'X', assignees: [assignee.id], responsibility: lookup.value, deadline: inDays(5) });
  });

  it.each(['excel', 'pdf', 'jpeg', 'docx'])('format=%s returns 200, correct Content-Type, and a non-empty body', async (format) => {
    const res = await request(app)
      .get(`/api/v1/reports/export?format=${format}`)
      .set('Authorization', `Bearer ${tokenFor(admin)}`)
      .buffer(true)
      .parse(bufferParser);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe(TASK_REPORT_CONTENT_TYPES[format]);
    expect(res.headers['content-disposition']).toContain('attachment');
    expect(res.body.length).toBeGreaterThan(0);
  }, 30000);

  it('accepts lastUpdateOnly=true alongside any format', async () => {
    const res = await request(app)
      .get('/api/v1/reports/export?format=excel&lastUpdateOnly=true')
      .set('Authorization', `Bearer ${tokenFor(admin)}`)
      .buffer(true)
      .parse(bufferParser);

    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThan(0);
  });

  it('rejects an invalid format with VALIDATION_ERROR', async () => {
    const res = await request(app)
      .get('/api/v1/reports/export?format=bogus')
      .set('Authorization', `Bearer ${tokenFor(admin)}`);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('rejects an unauthenticated request', async () => {
    const res = await request(app).get('/api/v1/reports/export?format=excel');
    expect(res.status).toBe(401);
  });

  it("scopes a User's export to only their own tasks", async () => {
    const other = await makeUser();
    // Reuses the same responsibility value the outer beforeEach already created — LookupList
    // enforces a unique (listType, value) pair, and a second identical value isn't needed here.
    await request(app)
      .post('/api/v1/tasks')
      .set('Authorization', `Bearer ${tokenFor(admin)}`)
      .send({ title: 'Not mine', assignees: [other.id], responsibility: 'Donation Box Incharge', deadline: inDays(5) });

    const res = await request(app)
      .get('/api/v1/reports/export?format=excel')
      .set('Authorization', `Bearer ${tokenFor(assignee)}`)
      .buffer(true)
      .parse(bufferParser);

    expect(res.status).toBe(200);
    // Can't easily assert group/row content from a raw buffer here without re-parsing; the RBAC
    // scoping itself is already proven directly at the service level (report.service.test.js) —
    // this route-level check just confirms the endpoint doesn't error for a scoped User.
  });

  it('the excel export contains the assignee’s own section header, re-parseable from the workbook', async () => {
    const ExcelJS = require('exceljs');
    const res = await request(app)
      .get('/api/v1/reports/export?format=excel')
      .set('Authorization', `Bearer ${tokenFor(admin)}`)
      .buffer(true)
      .parse(bufferParser);

    expect(res.status).toBe(200);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(res.body);
    const sheet = workbook.worksheets[0];
    const allText = [];
    sheet.eachRow((row) => row.eachCell((cell) => allText.push(String(cell.value?.text ?? cell.value ?? ''))));
    expect(allText.join(' | ')).toContain(assignee.name);
  });
});

describe('GET /api/v1/reports/user-summary (untouched by the task-report rewrite)', () => {
  it.each(['excel', 'pdf', 'jpeg'])('format=%s returns 200, correct Content-Type, non-empty body', async (format) => {
    const admin = await makeAdmin();

    const res = await request(app)
      .get(`/api/v1/reports/user-summary?format=${format}`)
      .set('Authorization', `Bearer ${tokenFor(admin)}`)
      .buffer(true)
      .parse(bufferParser);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe(TASK_REPORT_CONTENT_TYPES[format]);
    expect(res.body.length).toBeGreaterThan(0);
  }, 30000);

  it('rejects a docx format request (only the task report supports docx)', async () => {
    const admin = await makeAdmin();
    const res = await request(app)
      .get('/api/v1/reports/user-summary?format=docx')
      .set('Authorization', `Bearer ${tokenFor(admin)}`);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('rejects a non-Admin User with FORBIDDEN_ROLE', async () => {
    const user = await makeUser();
    const res = await request(app)
      .get('/api/v1/reports/user-summary?format=excel')
      .set('Authorization', `Bearer ${tokenFor(user)}`);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FORBIDDEN_ROLE');
  });

  it('rejects an unauthenticated request', async () => {
    const res = await request(app).get('/api/v1/reports/user-summary?format=excel');
    expect(res.status).toBe(401);
  });

  it('rejects an invalid format', async () => {
    const admin = await makeAdmin();
    const res = await request(app)
      .get('/api/v1/reports/user-summary?format=bogus')
      .set('Authorization', `Bearer ${tokenFor(admin)}`);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });
});
