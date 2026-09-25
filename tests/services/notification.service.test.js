const mongoose = require('mongoose');
const { connect, closeDatabase, clearDatabase } = require('../helpers/db');
const Notification = require('../../src/models/Notification');
const notificationService = require('../../src/services/notification.service');
const pushService = require('../../src/services/push.service');

beforeAll(async () => connect());
afterEach(async () => clearDatabase());
afterAll(async () => closeDatabase());

function basePayload(overrides = {}) {
  return {
    recipientUserId: new mongoose.Types.ObjectId(),
    type: 'TASK_OVERDUE',
    title: 'Title',
    message: 'Message',
    source: 'system',
    ...overrides,
  };
}

describe('notification.service — createNotification (the single creation entry point, locked blueprint §11)', () => {
  it('creates a notification with the given fields', async () => {
    const recipientUserId = new mongoose.Types.ObjectId();
    const doc = await notificationService.createNotification(basePayload({ recipientUserId }));

    expect(doc.recipientUserId.toString()).toBe(recipientUserId.toString());
    expect(doc.type).toBe('TASK_OVERDUE');
    expect(doc.isRead).toBe(false);
  });

  it('rejects an unknown notification type', async () => {
    await expect(notificationService.createNotification(basePayload({ type: 'NOT_A_REAL_TYPE' }))).rejects.toThrow(
      /Unknown notification type/
    );
  });

  // Locked blueprint §5 — the dedup guarantee is a database-level unique index, not a
  // check-then-insert race. This proves the SERVICE's own duplicate-handling branch: a second
  // create() with the identical dedupKey doesn't throw — it returns the ALREADY-EXISTING row.
  it('a duplicate dedupKey is treated as a no-op, returning the existing row rather than throwing', async () => {
    const dedupKey = 'AUTO_REMINDER:task1:user1:2026-09-14';
    const first = await notificationService.createNotification(basePayload({ dedupKey, title: 'First' }));

    const second = await notificationService.createNotification(basePayload({ dedupKey, title: 'Second attempt' }));

    expect(second.id).toBe(first.id);
    expect(second.title).toBe('First'); // the original row, untouched — not overwritten
    expect(await Notification.countDocuments({ dedupKey })).toBe(1);
  });

  // Concurrency proof (locked blueprint §5's proof-by-cases, case 1/3): two "simultaneous" writers
  // attempting the identical dedupKey must still only ever produce one row, regardless of which
  // one's promise settles first.
  it('guarantees exactly one row when two concurrent creates use the identical dedupKey', async () => {
    const dedupKey = 'AUTO_REMINDER:task1:user1:2026-09-14';
    const payload = basePayload({ dedupKey });

    const [a, b] = await Promise.all([
      notificationService.createNotification(payload),
      notificationService.createNotification(payload),
    ]);

    expect(a.id).toBe(b.id);
    expect(await Notification.countDocuments({ dedupKey })).toBe(1);
  });

  it('never dedups admin-sourced rows (no dedupKey) — multiple deliberate sends all persist', async () => {
    await notificationService.createNotification(basePayload({ source: 'admin' }));
    await notificationService.createNotification(basePayload({ source: 'admin' }));

    expect(await Notification.countDocuments({ source: 'admin' })).toBe(2);
  });

  it('a genuine duplicate-key error with NO dedupKey still throws (not silently swallowed)', async () => {
    // Not reachable through normal use (only dedupKey is uniquely indexed), but proves the
    // catch branch is correctly scoped to dedupKey-bearing calls only, not "any 11000."
    const err = new Error('duplicate');
    err.code = 11000;
    const createSpy = jest.spyOn(Notification, 'create').mockRejectedValueOnce(err);

    await expect(notificationService.createNotification(basePayload({ dedupKey: null }))).rejects.toBe(err);
    createSpy.mockRestore();
  });
});

describe('notification.service — createNotifications (bulk fan-out, not yet called by anything in Phase 1)', () => {
  it('creates one row per payload, sequentially', async () => {
    const results = await notificationService.createNotifications([
      basePayload({ title: 'One' }),
      basePayload({ title: 'Two' }),
      basePayload({ title: 'Three' }),
    ]);

    expect(results).toHaveLength(3);
    expect(await Notification.countDocuments({})).toBe(3);
  });
});

describe('notification.service — listForUser', () => {
  it('scopes strictly to the given recipientUserId', async () => {
    const me = new mongoose.Types.ObjectId();
    const other = new mongoose.Types.ObjectId();
    await notificationService.createNotification(basePayload({ recipientUserId: me }));
    await notificationService.createNotification(basePayload({ recipientUserId: other }));

    const { items, meta } = await notificationService.listForUser(me, { page: 1, limit: 20, unreadOnly: false });

    expect(items).toHaveLength(1);
    expect(meta.total).toBe(1);
  });

  it('sorts newest first', async () => {
    const me = new mongoose.Types.ObjectId();
    const first = await notificationService.createNotification(basePayload({ recipientUserId: me, title: 'First' }));
    await new Promise((r) => setTimeout(r, 5));
    const second = await notificationService.createNotification(basePayload({ recipientUserId: me, title: 'Second' }));

    const { items } = await notificationService.listForUser(me, { page: 1, limit: 20, unreadOnly: false });

    expect(items[0].id).toBe(second.id);
    expect(items[1].id).toBe(first.id);
  });

  it('paginates correctly (page/limit/meta.totalPages)', async () => {
    const me = new mongoose.Types.ObjectId();
    // eslint-disable-next-line no-await-in-loop -- deliberate sequential creation, test setup only
    for (let i = 0; i < 5; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await notificationService.createNotification(basePayload({ recipientUserId: me, title: `N${i}` }));
    }

    const page1 = await notificationService.listForUser(me, { page: 1, limit: 2, unreadOnly: false });
    const page3 = await notificationService.listForUser(me, { page: 3, limit: 2, unreadOnly: false });

    expect(page1.items).toHaveLength(2);
    expect(page1.meta).toEqual({ page: 1, limit: 2, total: 5, totalPages: 3 });
    expect(page3.items).toHaveLength(1); // last page, remainder
  });

  it('unreadOnly filters out already-read notifications', async () => {
    const me = new mongoose.Types.ObjectId();
    const readOne = await notificationService.createNotification(basePayload({ recipientUserId: me }));
    await notificationService.createNotification(basePayload({ recipientUserId: me }));
    await notificationService.markRead(me, readOne.id);

    const { items, meta } = await notificationService.listForUser(me, { page: 1, limit: 20, unreadOnly: true });

    expect(items).toHaveLength(1);
    expect(meta.total).toBe(1);
  });
});

describe('notification.service — getUnreadCount', () => {
  it('counts only the given user\'s unread notifications', async () => {
    const me = new mongoose.Types.ObjectId();
    const other = new mongoose.Types.ObjectId();
    const mine = await notificationService.createNotification(basePayload({ recipientUserId: me }));
    await notificationService.createNotification(basePayload({ recipientUserId: me }));
    await notificationService.createNotification(basePayload({ recipientUserId: other }));
    await notificationService.markRead(me, mine.id);

    expect(await notificationService.getUnreadCount(me)).toBe(1);
    expect(await notificationService.getUnreadCount(other)).toBe(1);
  });
});

describe('notification.service — markRead', () => {
  it('marks an owned notification read and stamps readAt', async () => {
    const me = new mongoose.Types.ObjectId();
    const doc = await notificationService.createNotification(basePayload({ recipientUserId: me }));

    const updated = await notificationService.markRead(me, doc.id);

    expect(updated.isRead).toBe(true);
    expect(updated.readAt).toBeInstanceOf(Date);
  });

  it("throws NOTIFICATION_NOT_FOUND (404) for another user's notification — ownership enforced", async () => {
    const owner = new mongoose.Types.ObjectId();
    const attacker = new mongoose.Types.ObjectId();
    const doc = await notificationService.createNotification(basePayload({ recipientUserId: owner }));

    await expect(notificationService.markRead(attacker, doc.id)).rejects.toMatchObject({
      statusCode: 404,
      code: 'NOTIFICATION_NOT_FOUND',
    });
    // Untouched by the failed attempt.
    expect((await Notification.findById(doc.id)).isRead).toBe(false);
  });

  it('throws NOTIFICATION_NOT_FOUND for a well-formed but nonexistent id', async () => {
    const me = new mongoose.Types.ObjectId();
    await expect(notificationService.markRead(me, new mongoose.Types.ObjectId().toString())).rejects.toMatchObject({
      statusCode: 404,
      code: 'NOTIFICATION_NOT_FOUND',
    });
  });

  it('throws NOTIFICATION_NOT_FOUND for a malformed id, rather than a raw CastError', async () => {
    const me = new mongoose.Types.ObjectId();
    await expect(notificationService.markRead(me, 'not-a-valid-object-id')).rejects.toMatchObject({
      statusCode: 404,
      code: 'NOTIFICATION_NOT_FOUND',
    });
  });

  it('is idempotent — marking an already-read notification again does not error or change readAt', async () => {
    const me = new mongoose.Types.ObjectId();
    const doc = await notificationService.createNotification(basePayload({ recipientUserId: me }));
    const firstRead = await notificationService.markRead(me, doc.id);

    const secondRead = await notificationService.markRead(me, doc.id);

    expect(secondRead.readAt.getTime()).toBe(firstRead.readAt.getTime());
  });
});

describe('notification.service — markAllRead', () => {
  it("marks only the given user's unread notifications, leaving another user's untouched", async () => {
    const me = new mongoose.Types.ObjectId();
    const other = new mongoose.Types.ObjectId();
    await notificationService.createNotification(basePayload({ recipientUserId: me }));
    await notificationService.createNotification(basePayload({ recipientUserId: me }));
    const otherDoc = await notificationService.createNotification(basePayload({ recipientUserId: other }));

    const { updatedCount } = await notificationService.markAllRead(me);

    expect(updatedCount).toBe(2);
    expect(await notificationService.getUnreadCount(me)).toBe(0);
    expect((await Notification.findById(otherDoc.id)).isRead).toBe(false);
  });

  it('returns updatedCount: 0 when there is nothing unread', async () => {
    const me = new mongoose.Types.ObjectId();
    const { updatedCount } = await notificationService.markAllRead(me);
    expect(updatedCount).toBe(0);
  });
});

// Web Push addition — a progressive-enhancement delivery channel layered on top of the DB write
// above (locked constraint: never a replacement, never touches dedup/recipient-resolution/content
// logic). Hooked into createOrDetectDuplicate itself, so every existing caller (admin flows via
// createNotification, the reminder engine via createSystemNotification) gets it "for free," with
// no per-caller changes anywhere else in this file.
describe('notification.service — Web Push integration (fire-and-forget on top of the DB write)', () => {
  afterEach(() => {
    if (pushService.sendPushToUser.mockRestore) pushService.sendPushToUser.mockRestore();
  });

  it('fires a push send for a genuinely new notification, with the same title/message/task metadata', async () => {
    const pushSpy = jest.spyOn(pushService, 'sendPushToUser').mockResolvedValue(undefined);
    const recipientUserId = new mongoose.Types.ObjectId();
    const taskId = new mongoose.Types.ObjectId();

    const doc = await notificationService.createNotification(
      basePayload({
        recipientUserId,
        title: 'عنوان',
        message: 'پیغام',
        taskId,
        metadata: { taskCodeNumber: '260901' },
      })
    );

    expect(pushSpy).toHaveBeenCalledTimes(1);
    expect(pushSpy).toHaveBeenCalledWith(recipientUserId, {
      title: 'عنوان',
      body: 'پیغام',
      icon: '/favicon.png',
      data: { notificationId: doc.id, taskCodeNumber: '260901' },
    });
  });

  it('does NOT fire a push send on a dedup-hit (created:false) — a duplicate scan must never re-push the same alert', async () => {
    const pushSpy = jest.spyOn(pushService, 'sendPushToUser').mockResolvedValue(undefined);
    const dedupKey = 'AUTO_REMINDER:task-x:user-x:2026-09-25';
    await notificationService.createNotification(basePayload({ dedupKey }));
    pushSpy.mockClear(); // only the SECOND (duplicate) call matters from here on

    await notificationService.createNotification(basePayload({ dedupKey, title: 'Different title, same key' }));

    expect(pushSpy).not.toHaveBeenCalled();
  });

  it('a push send that rejects never breaks notification creation — createNotification still resolves normally', async () => {
    jest.spyOn(pushService, 'sendPushToUser').mockRejectedValue(new Error('push service down'));

    const doc = await notificationService.createNotification(basePayload());

    expect(doc).toBeDefined();
    expect(doc.title).toBe('Title');
    // Let the fire-and-forget .catch() settle before the test ends, so its console.error log
    // never bleeds into a later test's output.
    await new Promise((resolve) => setImmediate(resolve));
  });

  it("also fires for the automatic reminder engine's own entry point (createSystemNotification)", async () => {
    const pushSpy = jest.spyOn(pushService, 'sendPushToUser').mockResolvedValue(undefined);
    const recipientUserId = new mongoose.Types.ObjectId();

    await notificationService.createSystemNotification(
      basePayload({ recipientUserId, dedupKey: 'AUTO_REMINDER:task-y:user-y:2026-09-25' })
    );

    expect(pushSpy).toHaveBeenCalledTimes(1);
  });
});
