const mongoose = require('mongoose');
const { serializeTask, serializeSyntheticRating } = require('../../src/serializers/task.serializer');

// The one API representation of a task, shared by every endpoint that returns one. Pure — these
// tests use plain objects shaped like a populated Task document.
const ASSIGNED_AT = new Date('2026-10-05T09:20:22.000Z');
const ADMIN_ID = new mongoose.Types.ObjectId();

function makeTask(overrides = {}) {
  return {
    id: 'task-1',
    codeNumber: '250103',
    title: 'کام',
    assignees: [{ id: 'u1', name: 'Zimmedar', responsibility: 'R', email: 'private@example.invalid', role: 'user' }],
    responsibility: 'R',
    deadline: new Date('2025-03-31T00:00:00.000Z'),
    status: 'closed',
    completionPercent: 0,
    lastUpdateAt: new Date('2025-04-20T00:00:00.000Z'),
    timeStatus: { type: 'late', days: 20 },
    performanceRating: 'good',
    createdBy: { id: 'a1', name: 'Admin', email: 'admin@example.invalid' },
    closedBy: 'a1',
    closedAt: new Date('2025-04-20T00:00:00.000Z'),
    createdAt: new Date('2025-01-10T00:00:00.000Z'),
    updatedAt: new Date('2025-04-20T00:00:00.000Z'),
    ...overrides,
  };
}
const syntheticRating = (overrides = {}) => ({
  isSynthetic: true,
  assumedPercent: 80,
  assignedAt: ASSIGNED_AT,
  assignedBy: 'system:script',
  reason: 'internal reason',
  history: [
    { at: ASSIGNED_AT, by: 'system:script', fromPercent: null, toPercent: 80, fromRating: '-', toRating: 'good', note: 'initial synthetic rating' },
    { at: new Date('2026-10-06T00:00:00.000Z'), by: ADMIN_ID, fromPercent: 80, toPercent: 85, fromRating: 'good', toRating: 'good', note: null },
  ],
  ...overrides,
});
const user = { id: 'u1', role: 'user' };
const admin = { id: 'a1', role: 'admin' };

describe('serializeTask', () => {
  it('returns exactly the documented task fields, and only the public parts of populated users', () => {
    expect(serializeTask(makeTask(), user)).toEqual({
      id: 'task-1',
      codeNumber: '250103',
      title: 'کام',
      assignees: [{ id: 'u1', name: 'Zimmedar', responsibility: 'R' }],
      responsibility: 'R',
      deadline: new Date('2025-03-31T00:00:00.000Z'),
      status: 'closed',
      completionPercent: 0,
      lastUpdateAt: new Date('2025-04-20T00:00:00.000Z'),
      timeStatus: { type: 'late', days: 20 },
      performanceRating: 'good',
      syntheticRating: null,
      createdBy: { id: 'a1', name: 'Admin' },
      closedBy: 'a1',
      closedAt: new Date('2025-04-20T00:00:00.000Z'),
      createdAt: new Date('2025-01-10T00:00:00.000Z'),
      updatedAt: new Date('2025-04-20T00:00:00.000Z'),
    });
  });

  it('syntheticRating is null when the task never had one, for every kind of viewer', () => {
    expect(serializeTask(makeTask(), user).syntheticRating).toBeNull();
    expect(serializeTask(makeTask(), admin).syntheticRating).toBeNull();
    expect(serializeTask(makeTask({ syntheticRating: undefined })).syntheticRating).toBeNull();
  });

  it('a normal user gets isSynthetic, assumedPercent and assignedAt — nothing else', () => {
    const { syntheticRating: exposed } = serializeTask(makeTask({ syntheticRating: syntheticRating() }), user);
    expect(exposed).toEqual({ isSynthetic: true, assumedPercent: 80, assignedAt: ASSIGNED_AT });
  });

  it('an admin additionally gets the history, with `by` as a plain string — still no assignedBy or reason', () => {
    const { syntheticRating: exposed } = serializeTask(makeTask({ syntheticRating: syntheticRating() }), admin);
    expect(exposed).toEqual({
      isSynthetic: true,
      assumedPercent: 80,
      assignedAt: ASSIGNED_AT,
      history: [
        { at: ASSIGNED_AT, by: 'system:script', fromPercent: null, toPercent: 80, fromRating: '-', toRating: 'good', note: 'initial synthetic rating' },
        { at: new Date('2026-10-06T00:00:00.000Z'), by: String(ADMIN_ID), fromPercent: 80, toPercent: 85, fromRating: 'good', toRating: 'good', note: null },
      ],
    });
    expect(exposed).not.toHaveProperty('assignedBy');
    expect(exposed).not.toHaveProperty('reason');
  });

  it('no viewer at all is treated like a normal user (no history)', () => {
    const exposed = serializeTask(makeTask({ syntheticRating: syntheticRating() })).syntheticRating;
    expect(exposed).not.toHaveProperty('history');
  });

  it('a synthetic rating that is no longer in force is still reported, as isSynthetic: false', () => {
    const exposed = serializeTask(makeTask({ syntheticRating: syntheticRating({ isSynthetic: false }) }), user).syntheticRating;
    expect(exposed).toEqual({ isSynthetic: false, assumedPercent: 80, assignedAt: ASSIGNED_AT });
  });

  it('keeps the REAL completion percent and status exactly as stored, next to a synthetic rating', () => {
    const serialized = serializeTask(makeTask({ syntheticRating: syntheticRating() }), user);
    expect(serialized).toMatchObject({ status: 'closed', completionPercent: 0, performanceRating: 'good' });
  });

  it('handles a task with no creator populated', () => {
    expect(serializeTask(makeTask({ createdBy: null }), user).createdBy).toBeNull();
  });

  it('does not mutate the task it is given', () => {
    const task = makeTask({ syntheticRating: syntheticRating() });
    const before = JSON.stringify(task);
    serializeTask(task, admin);
    expect(JSON.stringify(task)).toBe(before);
  });
});

describe('serializeSyntheticRating', () => {
  it('copes with a missing history, and with a history entry that has no author', () => {
    expect(serializeSyntheticRating({ isSynthetic: true, assumedPercent: 40, assignedAt: ASSIGNED_AT }, admin).history).toEqual([]);
    const withAnonymousEntry = syntheticRating({ history: [{ at: ASSIGNED_AT, by: null, fromPercent: null, toPercent: 40, fromRating: '-', toRating: 'weak', note: null }] });
    expect(serializeSyntheticRating(withAnonymousEntry, admin).history[0].by).toBeNull();
  });

  it('normalises isSynthetic to a strict boolean', () => {
    expect(serializeSyntheticRating({ isSynthetic: undefined, assumedPercent: 40, assignedAt: ASSIGNED_AT }, user).isSynthetic).toBe(false);
  });
});
