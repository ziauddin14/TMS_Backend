// Markdown rendering for the reopen-stuck-complete plan (dry run and commit) and for its rollback.
// Pure: takes already-built data, returns a string. Task codes only — no titles, no names.
const { showRating } = require('../synthetic-ratings/report');

const cell = (value) => String(value ?? '').replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
const table = (head, rows) => [`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`, ...rows.map((r) => `| ${r.map(cell).join(' | ')} |`)].join('\n');
const day = (value) => (value ? String(value).slice(0, 10) : '-');
const timeStatus = (ts) => (ts ? `${ts.type} ${ts.days}` : '-');

function renderPlanReport(plan, { meta, result, verification }) {
  const out = [];
  out.push(`# Stuck complete tasks — reopen — ${meta.mode}`);
  out.push(`Generated ${meta.generatedAt} · batch \`${meta.importBatch}\``);
  out.push(
    meta.mode === 'DRY RUN'
      ? '\n**Nothing was written to the database.** This is what `--commit` would do.'
      : '\n**This run wrote to the database.** A mongodump backup was taken first (see below).'
  );
  out.push(
    '\nRule: before the reopen fix, an update below 100% on a complete task left it "مکمل" at that percent. Such a task is reopened exactly as the app now does it: status ongoing, or pending once its deadline has passed; an open time status; the real rating "-" (an estimate stays, a final rating goes back to the plain band of its percent); completedAt removed. No notification is sent; from the next reminder-engine run the task gets the usual reminders of an open task.'
  );

  out.push('\n## Checks\n');
  out.push(plan.checks.map((c) => `- ${c.ok ? 'OK  ' : '**FAIL**'} ${c.label}${c.detail ? ` — ${c.detail}` : ''}`).join('\n'));
  out.push(`\n**${plan.ok ? 'All checks pass.' : 'One or more checks FAIL — a commit would refuse to run.'}**`);

  out.push('\n## Totals\n');
  out.push(
    `**A. to reopen: ${plan.totals.toRepair}** · anomalies: ${plan.totals.anomalies} · reopened by an earlier run: ${plan.totals.alreadyRepaired} · B. late only because of a later update (report only): ${plan.totals.lateOnlyByLaterUpdate} · C. closed after dropping below 100% (report only): ${plan.totals.closedAfterDrop}`
  );
  const statuses = Object.entries(plan.byNewStatus);
  out.push(statuses.length ? `\nNew status: ${statuses.map(([k, v]) => `${k}: ${v}`).join(' · ')}` : '\nNew status: none');

  out.push('\n## A. Every task to reopen\n');
  out.push(
    plan.items.length
      ? table(
          ['Code', '%', 'Deadline', 'Last update', 'Reached 100%', 'Status', 'Time status', 'Rating', 'Rating kind'],
          plan.items.map((i) => [
            i.code,
            `${i.completionPercent}%`,
            day(i.deadline),
            day(i.lastUpdateAt),
            day(i.reached100At),
            `${i.from.status} → ${i.to.status}`,
            `${timeStatus(i.from.timeStatus)} → ${timeStatus(i.to.timeStatus)}`,
            `${showRating(i.from.performanceRating)} → ${showRating(i.to.performanceRating)}`,
            i.ratingKind,
          ])
        )
      : '_nothing to reopen_'
  );
  if (plan.anomalies.length) {
    out.push('\n## Anomalies — left alone, and the commit refuses to run while there are any\n');
    out.push(plan.anomalies.map((a) => `- ${a}`).join('\n'));
  }

  out.push('\n## B. Late only because of a later update — report only\n');
  out.push(
    plan.lateOnlyByLaterUpdate.length
      ? table(
          ['Code', 'Shown late (days)', 'Reached 100% on', 'Days before deadline', 'Last update', 'Imported'],
          plan.lateOnlyByLaterUpdate.map((r) => [r.code, r.shownLateDays, day(r.completedOn), r.daysBeforeDeadline, day(r.lastUpdateAt), r.imported ? 'yes' : 'no'])
        )
      : '_none_'
  );
  out.push('\n## C. Closed after dropping below 100% — report only\n');
  out.push(
    plan.closedAfterDrop.length
      ? table(
          ['Code', '%', 'Reached 100% on', 'Dropped on', 'Closed on', 'Imported'],
          plan.closedAfterDrop.map((r) => [r.code, `${r.completionPercent}%`, day(r.reached100At), day(r.droppedAt), day(r.closedAt), r.imported ? 'yes' : 'no'])
        )
      : '_none_'
  );

  out.push('\n## What is written per task (A only)\n');
  out.push('- `status` — ongoing, or pending when the deadline has passed');
  out.push('- `timeStatus` — the open one (remaining / overdue days) at the time of the run');
  out.push('- `performanceRating` — "-" for a real rating; an estimate unchanged; a final rating back to the plain band of its percent');
  out.push('- `completedAt` — removed');
  out.push('- only when a final rating changes band: one `syntheticRating.history` entry by `system:script` — a string author, so the rating stays final');
  out.push('- one ledger record in `HistoricalImportRecord` (`kind: "taskRepair"`, `action: "reopen-stuck-complete"`, the exact previous values) — used by `--rollback`');
  out.push(
    '\nNever written: `completionPercent`, `lastUpdateAt`, `deadline`, `closedAt`, `updatedAt`, receipts, the percent of a synthetic rating; no TaskUpdate; no notification. Each task is re-read inside its own transaction and the write is aborted unless everything else is byte-identical.'
  );

  if (result) {
    out.push('\n## Commit result\n');
    out.push(`- backup: \`${result.backupDir}\``);
    out.push(`- reopened: **${result.repaired}**`);
    out.push(`- skipped: ${result.skipped.length}${result.skipped.length ? ` — ${result.skipped.map((s) => `${s.code} (${s.reason})`).join('; ')}` : ''}`);
  }
  if (verification) {
    out.push('\n### Verified after the write\n');
    out.push(`- every reopened task reads back as planned: **${verification.allRepaired ? 'yes' : 'NO'}**${verification.problems.length ? ` — ${verification.problems.join('; ')}` : ''}`);
    out.push(`- every other task read for this plan byte-identical before and after: **${verification.othersUnchanged ? 'yes' : 'NO'}** (${verification.othersCount} documents)`);
    out.push(`- TaskUpdate documents: ${verification.taskUpdates.before} before → ${verification.taskUpdates.after} after`);
    out.push(`- notifications about the reopened tasks: ${verification.notifications.before} before → ${verification.notifications.after} after`);
  }
  return `${out.join('\n')}\n`;
}

function renderRollbackReport(rows, { meta, result }) {
  const out = [];
  out.push(`# Stuck complete tasks — reopen — ROLLBACK ${meta.mode}`);
  out.push(`Generated ${meta.generatedAt}`);
  out.push(meta.mode === 'DRY RUN' ? '\n**Nothing was written to the database.** This is what `--rollback --commit` would do.' : '\n**This run wrote to the database.** A mongodump backup was taken first.');
  const counts = rows.reduce((acc, r) => ({ ...acc, [r.action]: (acc[r.action] || 0) + 1 }), {});
  out.push(`\nActive reopen ledger records: **${rows.length}** — ${Object.entries(counts).map(([k, v]) => `${k}: ${v}`).join(' · ') || 'nothing to roll back'}`);
  if (rows.length) {
    out.push('');
    out.push(table(['Code', 'Action', 'Detail'], rows.map((r) => [r.code, r.action, r.detail])));
  }
  out.push('\nNotices the reminder engine sent while a task was open again cannot be taken back.');
  if (result) {
    out.push('\n## Rollback result\n');
    out.push(`- backup: \`${result.backupDir}\``);
    out.push(`- restored: **${result.restored}** · ledger only: ${result.ledgerOnly} · skipped (changed since, left as they are): ${result.skipped.length}`);
    if (result.skipped.length) out.push(`- skipped: ${result.skipped.map((s) => `${s.code} (${s.reason})`).join('; ')}`);
    if (result.notRestoredExactly.length) {
      out.push(`- restored, but the document differs from its state before the repair in some OTHER field (changed by the live app since): ${result.notRestoredExactly.join(', ')}`);
    }
  }
  return `${out.join('\n')}\n`;
}

module.exports = { renderPlanReport, renderRollbackReport };
