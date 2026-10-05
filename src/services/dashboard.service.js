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
  // performanceRating is stored as '-' for tasks with no rating yet — normally every task still
  // ongoing/pending, except one that carries a developer-assigned (synthetic) rating, which is
  // counted under that rating like any other (docs/02-db-design.md §7, docs/04-db-models.md §3).
  // The documented response shape names the '-' bucket "notApplicable" (docs/05-apis.md §8).
  const notApplicableCount = counts['-'] || 0;
  breakdown.notApplicable = { count: notApplicableCount, percent: percentOf(notApplicableCount, total) };
  return breakdown;
}

// Whole-number percentages of `counts` that add up to exactly 100 (largest-remainder method:
// round every share down, then hand the leftover points to the largest fractional parts, earlier
// entries first on a tie). All zeros when there is nothing to take a share of.
function percentsSummingTo100(counts) {
  const total = counts.reduce((sum, count) => sum + count, 0);
  if (total === 0) return counts.map(() => 0);

  const exact = counts.map((count) => (count / total) * 100);
  const percents = exact.map(Math.floor);
  let leftover = 100 - percents.reduce((sum, percent) => sum + percent, 0);
  const byRemainder = exact.map((value, index) => ({ index, remainder: value - Math.floor(value) })).sort((a, b) => b.remainder - a.remainder || a.index - b.index);
  for (let i = 0; leftover > 0; i += 1, leftover -= 1) {
    percents[byRemainder[i].index] += 1;
  }
  return percents;
}

// The rating KPIs for a set of tasks (docs/05-apis.md §8 `ratings`):
// - The RATED set is every task whose performanceRating is not '-'. Each band's percent is its
//   share of that rated set only (unrated tasks are reported separately, never as a band).
// - overallQuality is the plain average, over the rated set, of each task's effective percent —
//   Task.getEffectivePercent, the single source: the assumed percent while a task's rating is
//   synthetic, otherwise its real completionPercent — put through the same thresholds as any
//   rating (ratingForPercent). No weights. With nothing rated there is no value at all (null).
// - The average is shown truncated (never rounded up) to one decimal, so the figure on screen can
//   never read as having reached a threshold the band says it has not.
function buildRatingKpis(tasks) {
  const rated = tasks.filter((task) => task.performanceRating && task.performanceRating !== '-');
  const counts = PERFORMANCE_KEYS.map((key) => rated.filter((task) => task.performanceRating === key).length);
  const percents = percentsSummingTo100(counts);
  const bands = Object.fromEntries(PERFORMANCE_KEYS.map((key, index) => [key, { count: counts[index], percent: percents[index] }]));

  let averageEffectivePercent = null;
  let overallQuality = null;
  if (rated.length > 0) {
    // Rounded at the 6th decimal first: sums of fractional percents carry floating-point noise
    // (79.99999999999999 instead of 80) that must not decide which side of a threshold it falls.
    const average = Math.round((rated.reduce((sum, task) => sum + Task.getEffectivePercent(task), 0) / rated.length) * 1e6) / 1e6;
    averageEffectivePercent = Math.floor(average * 10 + 1e-9) / 10;
    overallQuality = { band: taskService.ratingForPercent(average), percent: averageEffectivePercent };
  }

  return {
    bands,
    ratedCount: rated.length,
    unratedCount: tasks.length - rated.length,
    syntheticCount: rated.filter((task) => task.syntheticRating?.isSynthetic === true).length,
    averageEffectivePercent,
    overallQuality,
  };
}

// $facet computes all three groupings against the identical matched-document snapshot in one
// aggregation call (docs/05-apis.md §3 instruction: avoids read skew between byStatus and
// byPerformance if data changes between separate queries). Takes an already-built Mongo filter
// (with any id already cast to a real ObjectId, since Task.aggregate() — unlike .find()/
// .countDocuments() — does not go through Mongoose's automatic query-casting layer) so it can be
// driven by any filter, not just the requesting-user's own scope.
//
// Phase 8 addition: extracted and exported so report.service.js's buildUserSummaryData can reuse
// this exact aggregation per-user (docs/06-backend.md §9: "reuses the same aggregation logic...
// grouped per-user instead of globally") instead of writing a second one from scratch.
// getDashboardSummary below is refactored to call this helper but returns byte-identical output
// for its existing caller — nothing about Phase 7's behavior changes.
//
// `ratings` (added with the KPI redesign) is computed over the same filter from a second, lean
// query rather than inside the $facet, so that the effective percent comes from the model's own
// Task.getEffectivePercent instead of a copy of its rule written as an aggregation expression.
// byStatus/byPerformance/total are unchanged — the documented shape older clients read.
async function computeSummaryForFilter(filter) {
  const [[result], ratingFields] = await Promise.all([
    Task.aggregate([
      { $match: filter },
      {
        $facet: {
          byStatus: [{ $group: { _id: '$status', count: { $sum: 1 } } }],
          byPerformance: [{ $group: { _id: '$performanceRating', count: { $sum: 1 } } }],
          total: [{ $count: 'count' }],
        },
      },
    ]),
    Task.find(filter).select('performanceRating completionPercent syntheticRating.isSynthetic syntheticRating.assumedPercent').lean(),
  ]);

  const total = result.total[0]?.count ?? 0;

  return {
    byStatus: buildStatusBreakdown(result.byStatus, total),
    byPerformance: buildPerformanceBreakdown(result.byPerformance, total),
    total,
    ratings: buildRatingKpis(ratingFields),
  };
}

// docs/05-apis.md §8 — GET /dashboard/summary. Scoped identically to listTasks
// (docs/06-backend.md §4.1): reuses task.service.js's buildTaskFilter, unmodified, rather than
// reimplementing the RBAC rule — and, since the KPI redesign, with the same filters too
// (`filters` is the validated query: every filter GET /tasks accepts), so the figures describe
// exactly the set of tasks the table lists for the same query. A User is always limited to their
// own tasks, whatever they send: buildTaskFilter forces that server-side.
async function getDashboardSummary(requestingUser, filters = {}) {
  const filter = taskService.buildTaskFilter(requestingUser, filters);
  // See computeSummaryForFilter's comment: Task.aggregate() doesn't auto-cast, so a raw id
  // string would never match the stored ObjectId values and would silently return an empty
  // result for every User. Cast explicitly here; buildTaskFilter itself still returns exactly
  // what it already returned (Phase 5 unchanged). An assigneeId that is not an id at all can
  // match no task — say so directly rather than letting the cast throw.
  if (filter.assignees) {
    if (mongoose.Types.ObjectId.isValid(filter.assignees)) {
      filter.assignees = new mongoose.Types.ObjectId(filter.assignees);
    } else {
      delete filter.assignees;
      filter._id = { $in: [] };
    }
  }

  return computeSummaryForFilter(filter);
}

module.exports = { getDashboardSummary, computeSummaryForFilter, buildRatingKpis, percentsSummingTo100 };
