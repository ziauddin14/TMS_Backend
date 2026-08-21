// Cross-phase checks (Phase 3 Auth + Phase 4 Users/LookupLists + Phase 2 models working
// together), per the Phase 4 instructions — not just isolated per-module unit tests.
const jwt = require('jsonwebtoken');
const request = require('supertest');
const app = require('../../src/app');
const env = require('../../src/config/env');
const { connect, closeDatabase, clearDatabase } = require('../helpers/db');
const User = require('../../src/models/User');
const LookupList = require('../../src/models/LookupList');
const Task = require('../../src/models/Task');

beforeAll(async () => connect());
afterEach(async () => clearDatabase());
afterAll(async () => closeDatabase());

function tokenFor(user) {
  return jwt.sign({ sub: user.id, role: user.role }, env.JWT_SECRET, { expiresIn: env.JWT_EXPIRES_IN });
}

describe('Deactivating a user via PATCH /users/:id blocks a subsequent login (Phase 3 + Phase 4)', () => {
  it('a user who logs in fine, then gets deactivated by an Admin, then fails login with USER_INACTIVE', async () => {
    const admin = await User.create({
      name: 'Admin',
      email: 'admin@dawateislami.net',
      responsibility: 'Admin',
      role: 'admin',
    });
    const target = await User.create({
      name: 'Target',
      email: 'target@dawateislami.net',
      responsibility: 'X',
      role: 'user',
    });

    // 1. Confirm login works before deactivation (dev-login, non-production shortcut per docs/12-testing.md §5)
    //    and keep the issued token to prove mid-session revocation later.
    const beforeRes = await request(app).post('/api/v1/auth/dev-login').send({ email: 'target@dawateislami.net' });
    expect(beforeRes.status).toBe(200);
    const tokenIssuedBeforeDeactivation = beforeRes.body.data.token;

    // 2. Admin deactivates the user through the real Phase 4 endpoint.
    const patchRes = await request(app)
      .patch(`/api/v1/users/${target.id}`)
      .set('Authorization', `Bearer ${tokenFor(admin)}`)
      .send({ isActive: false });
    expect(patchRes.status).toBe(200);
    expect(patchRes.body.data.isActive).toBe(false);

    // 3. A fresh login attempt now fails with USER_INACTIVE.
    const afterRes = await request(app).post('/api/v1/auth/dev-login').send({ email: 'target@dawateislami.net' });
    expect(afterRes.status).toBe(403);
    expect(afterRes.body.code).toBe('USER_INACTIVE');

    // 4. The token issued back in step 1, BEFORE deactivation, also stops working — proves the
    //    revocation is real-time (Phase 3's auth.middleware.js re-checks isActive on every
    //    request), not just enforced at the next login.
    const meRes = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${tokenIssuedBeforeDeactivation}`);
    expect(meRes.status).toBe(401);
    expect(meRes.body.code).toBe('UNAUTHORIZED');
  });
});

describe('Retiring a LookupList value does not affect a Task that already references its text (docs/04-db-models.md §5)', () => {
  it('a Task created while a responsibility value was active keeps that text unchanged after the value is retired', async () => {
    const admin = await User.create({
      name: 'Admin',
      email: 'admin2@dawateislami.net',
      responsibility: 'Admin',
      role: 'admin',
    });
    const assignee = await User.create({
      name: 'Assignee',
      email: 'assignee@dawateislami.net',
      responsibility: 'X',
      role: 'user',
    });
    const lookup = await LookupList.create({ listType: 'responsibility', value: 'Donation Box Incharge' });

    // Task APIs don't exist yet (Phase 5) — create directly via the Phase 2 model, as instructed.
    const task = await Task.create({
      codeNumber: '260801',
      title: 'Collect donation boxes',
      assignees: [assignee._id],
      responsibility: lookup.value, // stored as plain text, per docs/02-db-design.md §9
      deadline: new Date('2026-12-31'),
      createdBy: admin._id,
    });

    // Retire the lookup value through the real Phase 4 endpoint.
    const patchRes = await request(app)
      .patch(`/api/v1/lookup-lists/${lookup.id}`)
      .set('Authorization', `Bearer ${tokenFor(admin)}`)
      .send({ isActive: false });
    expect(patchRes.status).toBe(200);

    // The task's stored responsibility text is completely unaffected.
    const reloadedTask = await Task.findById(task._id);
    expect(reloadedTask.responsibility).toBe('Donation Box Incharge');

    // The retired value no longer appears in the dropdown-populating endpoint...
    const listRes = await request(app)
      .get('/api/v1/lookup-lists?type=responsibility')
      .set('Authorization', `Bearer ${tokenFor(assignee)}`);
    expect(listRes.body.data.map((d) => d.value)).not.toContain('Donation Box Incharge');

    // ...but the underlying document itself still exists, unaffected (retired, not deleted).
    const stillExists = await LookupList.findById(lookup._id);
    expect(stillExists).not.toBeNull();
    expect(stillExists.value).toBe('Donation Box Incharge');
  });
});
