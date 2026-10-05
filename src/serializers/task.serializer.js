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

// Each task populated with assignees (name, responsibility) and createdBy (name).
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
    createdBy: task.createdBy ? { id: task.createdBy.id, name: task.createdBy.name } : null,
    closedBy: task.closedBy,
    closedAt: task.closedAt,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
}

module.exports = { serializeTask, serializeSyntheticRating };
