// The one API representation of a task (docs/05-apis.md §5) — used by every endpoint that returns
// one (task.controller.js, and taskUpdate.controller.js's POST /tasks/:id/updates), so they can
// never drift apart. `viewer` is the requesting user (req.user): it only decides how much of a
// synthetic rating's detail is included.
function serializeAssignee(user) {
  return { id: user.id, name: user.name, responsibility: user.responsibility };
}

// A developer-assigned (synthetic) rating — models/Task.js syntheticRating. null when the task
// never had one. Everyone who can see the task sees that its rating is synthetic and from what
// assumed percentage; who assigned it and why (assignedBy, reason) stay server-side; the change
// history is for admins only.
function serializeSyntheticRating(syntheticRating, viewer) {
  if (!syntheticRating) return null;

  const serialized = {
    isSynthetic: syntheticRating.isSynthetic === true,
    assumedPercent: syntheticRating.assumedPercent,
    assignedAt: syntheticRating.assignedAt,
  };
  if (viewer?.role === 'admin') {
    serialized.history = (syntheticRating.history || []).map((entry) => ({
      at: entry.at,
      by: entry.by === undefined || entry.by === null ? null : String(entry.by),
      fromPercent: entry.fromPercent,
      toPercent: entry.toPercent,
      fromRating: entry.fromRating,
      toRating: entry.toRating,
      note: entry.note,
    }));
  }
  return serialized;
}

// Task receipt (models/Task.js `receipts`). Only CURRENT receipts are shown (a superseded one is
// history). A task from before the feature has no receipts: both fields are null.
//   receipt   — admins only: how many people must confirm, how many have, and who/when.
//   myReceipt — everyone else: their own receipt only, or null if they have none on this task.
function idOf(value) {
  if (!value) return null;
  return String(value._id || value);
}

function serializeReceipts(receipts, viewer) {
  if (!Array.isArray(receipts)) return { receipt: null, myReceipt: null };
  const current = receipts.filter((receipt) => !receipt.supersededAt);

  if (viewer?.role === 'admin') {
    return {
      receipt: {
        required: current.length,
        acknowledged: current.filter((receipt) => receipt.acknowledgedAt).length,
        people: current.map((receipt) => ({
          id: String(receipt._id),
          user: { id: idOf(receipt.user), name: receipt.user?.name ?? null },
          assignedAt: receipt.assignedAt,
          acknowledgedAt: receipt.acknowledgedAt || null,
          remindersSent: (receipt.remindersSent || []).length,
        })),
      },
      myReceipt: null,
    };
  }

  const mine = current.find((receipt) => idOf(receipt.user) === viewer?.id);
  return {
    receipt: null,
    myReceipt: mine ? { assignedAt: mine.assignedAt, acknowledgedAt: mine.acknowledgedAt || null } : null,
  };
}

// Each task populated with assignees (name, responsibility), createdBy (name) and, when it has
// receipts, receipts.user (name).
function serializeTask(task, viewer) {
  return {
    id: task.id,
    codeNumber: task.codeNumber,
    title: task.title,
    assignees: task.assignees.map(serializeAssignee),
    responsibility: task.responsibility,
    deadline: task.deadline,
    status: task.status,
    completionPercent: task.completionPercent,
    lastUpdateAt: task.lastUpdateAt,
    timeStatus: task.timeStatus,
    performanceRating: task.performanceRating,
    syntheticRating: serializeSyntheticRating(task.syntheticRating, viewer),
    ...serializeReceipts(task.receipts, viewer),
    createdBy: task.createdBy ? { id: task.createdBy.id, name: task.createdBy.name } : null,
    closedBy: task.closedBy,
    closedAt: task.closedAt,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
}

module.exports = { serializeTask, serializeSyntheticRating, serializeReceipts };
