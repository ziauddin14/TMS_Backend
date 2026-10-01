// Pure planning step for the one-off historical "Follow-up Karkardagi" import — turns the parsed
// source JSON into the exact Task/TaskUpdate documents that WOULD be written, plus every flag,
// data-quality note and review item. No database access here at all: the dry run is just this
// plan rendered as a report, and the --commit run writes exactly this plan, nothing re-derived.
const { computeTimeStatus, computePerformanceRating } = require('../../src/services/task.service');

const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
const MS_PER_MINUTE = 60 * 1000;

// A completed-state closure phrase ("کلوز ہے / ہوا / کیا جا رہا / کر دیتے ہیں" ...), as opposed to
// an instruction ("کلوز کر دیجئے", "کلوز کروائیے") or an unrelated use ("اجارے کلوز ہوچکے", the
// monthly "کلوزنگ" figures). Only ever tested against a task's LAST update — closure is a
// terminal event, and earlier mentions in this dataset are instructions or unrelated.
const CLOSURE_PHRASE = /کلوز\s*(ہے|ہوا|ہو[۔\s]|ہو$|ہورہا|ہو رہا|ہو چکا|ہوچکا|کیا جا|کر دیتے|کرکے|\))/;
const LATE_PHRASE = /تاخیر/;
const PERCENT = /([0-9۰-۹٠-٩]+(?:[.٫][0-9۰-۹٠-٩]+)?)\s*(?:فیصد|%)/g;

const FLAG_KEYS = ['date_inherited', 'year_inferred', 'year_inferred_ambiguous', 'year_candidates', 'speaker_inferred'];

// "31-Dec-25" / "5-Feb-25" -> a UTC-midnight Date, or null if it isn't a real calendar date.
// UTC midnight matches how POST /tasks stores a date-input value (z.coerce.date('YYYY-MM-DD')),
// and falls on the same Karachi calendar date inside computeTimeStatus.
function parseSourceDate(str) {
  const match = /^(\d{1,2})-([A-Za-z]{3})-(\d{2})$/.exec(String(str || '').trim());
  if (!match || !(match[2] in MONTHS)) return null;
  const day = Number(match[1]);
  const date = new Date(Date.UTC(2000 + Number(match[3]), MONTHS[match[2]], day));
  return date.getUTCDate() === day ? date : null;
}

function isoDay(date) {
  return date.toISOString().slice(0, 10);
}

function toAsciiNumber(str) {
  return Number(
    str
      .replace(/[۰-۹]/g, (c) => String(c.charCodeAt(0) - 0x06f0))
      .replace(/[٠-٩]/g, (c) => String(c.charCodeAt(0) - 0x0660))
      .replace('٫', '.')
  );
}

function extractPercents(text) {
  return [...text.matchAll(PERCENT)].map((m) => toAsciiNumber(m[1]));
}

function resolveSpeaker(speaker, ownerKey, config) {
  if (speaker === 'zimmedar') return config.userMap[ownerKey];
  if (speaker === 'admin') return config.adminUserId;
  const other = /^other_zimmedar:(.+)$/.exec(speaker);
  if (other && config.userMap[other[1]]) return config.userMap[other[1]];
  throw new Error(`Unmappable speaker "${speaker}" (owner ${ownerKey})`);
}

// Same classification as reminder-engine.service.js's classify() — duplicated here only to
// report which reminder each imported OPEN task will trigger from the next scan onward.
function reminderTypeFor(timeStatus, reminderDaysBefore) {
  if (timeStatus.type === 'overdue') return 'TASK_OVERDUE';
  if (timeStatus.type !== 'remaining') return null;
  if (timeStatus.days === 0) return 'TASK_DUE_TODAY';
  if (timeStatus.days === 1) return 'TASK_DUE_TOMORROW';
  if (timeStatus.days <= reminderDaysBefore) return 'TASK_DUE_SOON';
  return null;
}

function planUpdates(src, ownerKey, context, config) {
  const { createdAt, closeDate, hasClosingRemark } = context;
  let running = null;
  let prevDay = null;

  return src.updates.map((u, index) => {
    const issues = [];
    const flags = {};
    FLAG_KEYS.forEach((key) => {
      if (u[key] !== undefined) flags[key] = u[key];
    });

    let day = new Date(Date.UTC(u.date_year, u.date_month - 1, u.date_day));
    let dateSource = u.date_inherited ? `inherited_${u.date_inherited}` : 'explicit';

    // Call #4: a dateless closing remark whose date is just the task-creation placeholder takes the
    // task's (valid) Close date instead — unless that would put it before the task's creation or
    // before the previous update, in which case it's left alone and flagged.
    const isClosingRemark = index === src.updates.length - 1 && hasClosingRemark;
    const isCreationPlaceholder = Boolean(u.date_inherited) && isoDay(day) === src.code_date;
    if (isClosingRemark && isCreationPlaceholder && closeDate) {
      if (closeDate >= createdAt && (!prevDay || closeDate >= prevDay)) {
        day = closeDate;
        dateSource = 'close_date_substituted';
      } else {
        issues.push('close_date_substitution_skipped_out_of_order');
      }
    }
    prevDay = day;

    // Call #2: an update's own single explicit "N فیصد" wins; otherwise carry forward the task's
    // most recent explicit value (0 if none yet). Multiple or out-of-range figures are flagged and
    // fall back to the carry-forward value — never one picked silently.
    const found = extractPercents(u.text);
    let completionPercent;
    let percentSource;
    if (found.length === 1 && found[0] >= 0 && found[0] <= 100) {
      [completionPercent] = found;
      running = completionPercent;
      percentSource = 'explicit';
    } else {
      if (found.length > 1) issues.push('multiple_percentages_in_text');
      if (found.length === 1) issues.push('percent_out_of_range');
      completionPercent = running ?? 0;
      percentSource = running === null ? 'default_zero' : 'carried_forward';
    }

    return {
      sourceKey: `update:${src.code}:${index}`,
      index,
      speakerLabel: u.speaker,
      update: {
        updatedBy: resolveSpeaker(u.speaker, ownerKey, config),
        description: u.text.trim(),
        completionPercent,
        attachment: null,
        // +index minutes keeps same-day updates in their source order under the
        // { taskId, createdAt } sort without moving any of them off their calendar date.
        createdAt: new Date(day.getTime() + index * MS_PER_MINUTE),
      },
      isClosingRemark,
      dateSource,
      percentSource,
      percentsFound: found,
      flags,
      dataQualityIssues: issues,
      raw: {
        speaker: u.speaker,
        date_year: u.date_year,
        date_month: u.date_month,
        date_day: u.date_day,
        year_candidates: u.year_candidates ?? null,
      },
    };
  });
}

function planTask(src, ownerKey, config) {
  const { code } = src;
  const issues = [];
  const reviewNotes = [];
  const createdAt = new Date(`${src.code_date}T00:00:00.000Z`);

  const deadline = parseSourceDate(src.target);
  if (!deadline) throw new Error(`Task ${code}: unparseable target "${src.target}"`);
  if (deadline < createdAt) issues.push('deadline_before_creation');

  let closeDate = null;
  if (src.close) {
    closeDate = parseSourceDate(src.close);
    if (!closeDate) issues.push('close_field_invalid');
    else if (closeDate < createdAt) issues.push('close_before_creation');
  }

  const lastSource = src.updates[src.updates.length - 1];
  const hasClosingRemark = CLOSURE_PHRASE.test(lastSource.text);
  const override = config.statusOverrides[code];
  const isClosed = override ? override.status === 'closed' : hasClosingRemark || Boolean(closeDate);
  if (override) reviewNotes.push(`status override (${override.status}): ${override.reason}`);

  let closureSignal = 'none';
  if (hasClosingRemark && closeDate) closureSignal = 'closing_remark+close_date';
  else if (hasClosingRemark) closureSignal = 'closing_remark';
  else if (closeDate) closureSignal = 'close_date';

  const updates = planUpdates(src, ownerKey, { createdAt, closeDate, hasClosingRemark }, config);
  const lastUpdate = updates[updates.length - 1];
  const lastUpdateAt = lastUpdate.update.createdAt;
  const { completionPercent } = lastUpdate.update;
  const hasExplicitPercent = updates.some((u) => u.percentSource === 'explicit');

  let closedAt = null;
  let closedBy = null;
  if (isClosed) {
    closedBy = config.adminUserId;
    if (closeDate) {
      closedAt = closeDate;
    } else {
      closedAt = lastUpdateAt;
      if (lastUpdate.dateSource !== 'explicit') issues.push('closed_at_from_inferred_date');
    }
  }

  const updatedAt = new Date(Math.max(createdAt, lastUpdateAt, closedAt || 0));
  const timeStatus = computeTimeStatus(
    { status: isClosed ? 'closed' : 'ongoing', deadline, lastUpdateAt, closedAt, updatedAt },
    config.now
  );
  // Mirrors reminder-engine.service.js's maintainTaskState: an overdue open task is 'pending'.
  let status = 'ongoing';
  if (isClosed) status = 'closed';
  else if (timeStatus.type === 'overdue') status = 'pending';

  const handoverKey = `${ownerKey}:${code}`;
  const handoverCase = config.handoverCases[handoverKey] || null;
  const handoverDecision = handoverCase ? config.handoverDecisions[handoverKey] ?? null : null;

  // Call #3: the existing formula only for closed tasks with at least one explicit percentage;
  // '-' for every other closed task rather than assuming 100% or 0%.
  const formulaRating =
    isClosed && hasExplicitPercent ? computePerformanceRating(completionPercent, timeStatus, 'closed') : '-';
  const performanceRating = handoverDecision === 'reassigned' ? '-' : formulaRating;
  let ratingBasis = 'computed_from_explicit_percent';
  if (!isClosed) ratingBasis = 'open_task';
  else if (!hasExplicitPercent) ratingBasis = 'no_explicit_percent';
  else if (handoverDecision === 'reassigned') ratingBasis = 'handover_reassigned';

  // Informational only — the committed timeStatus/rating come from the system's own
  // computeTimeStatus (last update vs deadline). This records where the source's own lateness
  // signals (an explicit "تاخیر" in the closing remark, or Close date vs deadline) disagree.
  let latenessCheck = null;
  if (isClosed) {
    const remarkSaysLate = hasClosingRemark && LATE_PHRASE.test(lastSource.text);
    const closeDateLate = closeDate ? closeDate > deadline : null;
    const sourceSaysLate = remarkSaysLate || closeDateLate === true;
    latenessCheck = {
      systemLate: timeStatus.type === 'late',
      remarkSaysLate,
      closeDateLate,
      disagrees: (timeStatus.type === 'late') !== sourceSaysLate,
    };
  }

  return {
    sourceKey: `task:${code}`,
    code,
    personKey: ownerKey,
    mergedFrom: null,
    task: {
      codeNumber: code,
      title: src.desc.trim(),
      assignees: [config.userMap[ownerKey]],
      responsibility: config.responsibilityByPerson[ownerKey],
      deadline,
      status,
      completionPercent,
      lastUpdateAt,
      timeStatus,
      performanceRating,
      createdBy: config.adminUserId,
      closedBy,
      closedAt,
      createdAt,
      updatedAt,
    },
    closureSignal,
    closingRemark: hasClosingRemark ? lastSource.text.trim() : null,
    hasExplicitPercent,
    formulaRating,
    ratingBasis,
    latenessCheck,
    reminderType: isClosed ? null : reminderTypeFor(timeStatus, config.reminderDaysBefore),
    handover: handoverCase ? { key: handoverKey, ...handoverCase, decision: handoverDecision } : null,
    dataQualityIssues: issues,
    reviewNotes,
    raw: { target: src.target, close: src.close, code_date: src.code_date },
    updates,
  };
}

function sameTaskContent(a, b) {
  if (a.desc !== b.desc || a.target !== b.target || a.close !== b.close) return false;
  if (a.updates.length !== b.updates.length) return false;
  // Speaker labels legitimately differ between the copies (the handover); content must not.
  return a.updates.every(
    (u, i) =>
      u.text === b.updates[i].text &&
      u.date_year === b.updates[i].date_year &&
      u.date_month === b.updates[i].date_month &&
      u.date_day === b.updates[i].date_day
  );
}

function countBy(items, keyFn) {
  return items.reduce((acc, item) => {
    const key = keyFn(item);
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
}

function buildPlan(data, config) {
  Object.keys(data).forEach((personKey) => {
    if (!config.userMap[personKey]) throw new Error(`No user mapping for person "${personKey}"`);
    if (!config.responsibilityByPerson[personKey]) throw new Error(`No responsibility for person "${personKey}"`);
  });

  // Merges: every dropped copy must be content-identical to the kept one, or the run stops.
  Object.entries(config.merges).forEach(([code, merge]) => {
    const kept = data[merge.keep]?.tasks.find((t) => t.code === code);
    if (!kept) throw new Error(`Merge ${code}: no copy under "${merge.keep}"`);
    merge.drop.forEach((dropKey) => {
      const dropped = data[dropKey]?.tasks.find((t) => t.code === code);
      if (!dropped) throw new Error(`Merge ${code}: no copy under "${dropKey}"`);
      if (!sameTaskContent(kept, dropped)) throw new Error(`Merge ${code}: copies under ${merge.keep}/${dropKey} differ`);
    });
  });

  const seen = new Map();
  const tasks = [];
  let sourceTaskCount = 0;
  let sourceUpdateCount = 0;
  Object.entries(data).forEach(([personKey, person]) => {
    person.tasks.forEach((src) => {
      sourceTaskCount += 1;
      sourceUpdateCount += src.updates.length;
      const merge = config.merges[src.code];
      if (merge && merge.drop.includes(personKey)) return;
      if (seen.has(src.code)) {
        throw new Error(`Duplicate code ${src.code} under ${seen.get(src.code)} and ${personKey} with no configured merge`);
      }
      seen.set(src.code, personKey);
      const planned = planTask(src, personKey, config);
      if (merge) {
        planned.mergedFrom = merge.drop;
        planned.reviewNotes.push(
          `merged: duplicate copy under ${merge.drop.join(', ')} dropped; responsibility taken from the new owner (${personKey})`
        );
      }
      tasks.push(planned);
    });
  });

  const updates = tasks.flatMap((t) => t.updates);
  const openTasks = tasks.filter((t) => t.task.status !== 'closed');

  return {
    tasks,
    totals: {
      sourceTasks: sourceTaskCount,
      sourceUpdates: sourceUpdateCount,
      tasks: tasks.length,
      updates: updates.length,
      byPerson: Object.fromEntries(
        Object.keys(data).map((p) => {
          const own = tasks.filter((t) => t.personKey === p);
          return [p, { tasks: own.length, updates: own.reduce((s, t) => s + t.updates.length, 0) }];
        })
      ),
      byStatus: countBy(tasks, (t) => t.task.status),
      byClosureSignal: countBy(tasks, (t) => t.closureSignal),
      byRating: countBy(tasks, (t) => t.task.performanceRating),
      byRatingBasis: countBy(tasks, (t) => t.ratingBasis),
      byDateSource: countBy(updates, (u) => u.dateSource),
      byPercentSource: countBy(updates, (u) => u.percentSource),
    },
    reminderExposure: {
      byPerson: Object.fromEntries(
        Object.keys(data).map((p) => [
          p,
          countBy(
            openTasks.filter((t) => t.personKey === p),
            (t) => t.reminderType || 'none_yet'
          ),
        ])
      ),
      total: countBy(openTasks, (t) => t.reminderType || 'none_yet'),
    },
    handoverCases: tasks.filter((t) => t.handover),
    taskIssues: tasks.filter((t) => t.dataQualityIssues.length),
    updateIssues: tasks.flatMap((t) =>
      t.updates.filter((u) => u.dataQualityIssues.length).map((u) => ({ code: t.code, personKey: t.personKey, ...u }))
    ),
    substitutions: tasks.flatMap((t) =>
      t.updates.filter((u) => u.dateSource === 'close_date_substituted').map((u) => ({ code: t.code, personKey: t.personKey, ...u }))
    ),
    latenessDisagreements: tasks.filter((t) => t.latenessCheck && t.latenessCheck.disagrees),
  };
}

module.exports = { buildPlan, parseSourceDate, extractPercents, CLOSURE_PHRASE };
