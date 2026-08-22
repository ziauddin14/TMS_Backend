const mongoose = require('mongoose');
const Task = require('../models/Task');
const taskService = require('./task.service');

const STATUS_KEYS = ['ongoing', 'pending', 'complete', 'closed'];
const PERFORMANCE_KEYS = ['excellent', 'good', 'fair', 'weak'];

// Math.round, single consistent direction (docs/05-apis.md §8 example: 8/25=32%, 3/25=12%, both
// exact here, but percentages are not guaranteed to sum to exactly 100 in general — expected,
// not a bug, per the Phase 7 instructions.
function percentOf(count, total) {
  if (total === 0) return 0;
  return Math.round((count / total) * 100);
}

function countsByKey(groupResults) {
  return Object.fromEntries(groupResults.map((r) => [r._id, r.count]));
}

function buildStatusBreakdown(groupResults, total) {
  const counts = countsByKey(groupResults);
  const breakdown = {};
  STATUS_KEYS.forEach((key) => {
    const count = counts[key] || 0;
    breakdown[key] = { count, percent: percentOf(count, total) };
  });
  return breakdown;
}

function buildPerformanceBreakdown(groupResults, total) {
  const counts = countsByKey(groupResults);
  const breakdown = {};
  PERFORMANCE_KEYS.forEach((key) => {
    const count = counts[key] || 0;
    breakdown[key] = { count, percent: percentOf(count, total) };
  });
  // performanceRating is stored as '-' for tasks still ongoing/pending (docs/04-db-models.md §3);
  // the documented response shape names this bucket "notApplicable" (docs/05-apis.md §8), not '-'.
  const notApplicableCount = counts['-'] || 0;
  breakdown.notApplicable = { count: notApplicableCount, percent: percentOf(notApplicableCount, total) };
  return breakdown;
}

// docs/05-apis.md §8 — GET /dashboard/summary. Scoped identically to listTasks
// (docs/06-backend.md §4.1): reuses task.service.js's buildTaskFilter, unmodified, rather than
// reimplementing the RBAC rule.
async function getDashboardSummary(requestingUser) {
  const filter = taskService.buildTaskFilter(requestingUser, {});
  // task.service.js's other callers use Task.find()/countDocuments(), which auto-cast query
  // values against the schema (a string id becomes ObjectId transparently). Task.aggregate()
  // does NOT go through that casting layer — Mongoose sends $match straight through — so a raw
  // id string here would never match the stored ObjectId values and would silently return an
  // empty result for every User. Cast explicitly for this one aggregate-specific caller only;
  // buildTaskFilter itself is left returning exactly what it already returned (Phase 5 unchanged).
  if (filter.assignees) {
    filter.assignees = new mongoose.Types.ObjectId(filter.assignees);
  }

  // $facet computes all three groupings against the identical matched-document snapshot in one
  // aggregation call (docs/05-apis.md §3 instruction: avoids read skew between byStatus and
  // byPerformance if data changes between separate queries).
  const [result] = await Task.aggregate([
    { $match: filter },
    {
      $facet: {
        byStatus: [{ $group: { _id: '$status', count: { $sum: 1 } } }],
        byPerformance: [{ $group: { _id: '$performanceRating', count: { $sum: 1 } } }],
        total: [{ $count: 'count' }],
      },
    },
  ]);

  const total = result.total[0]?.count ?? 0;

  return {
    byStatus: buildStatusBreakdown(result.byStatus, total),
    byPerformance: buildPerformanceBreakdown(result.byPerformance, total),
    total,
  };
}

module.exports = { getDashboardSummary };
