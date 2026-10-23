// Markdown rendering for the final-rating late-downgrade plan (dry run and commit) and for its
// rollback. Pure: takes already-built data, returns a string.
const { showRating } = require('../synthetic-ratings/report');

const cell = (value) => String(value ?? '').replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
const shorten = (text, max = 60) => (String(text || '').length > max ? `${String(text).slice(0, max - 1)}…` : String(text || ''));
const table = (head, rows) => [`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`, ...rows.map((r) => `| ${r.map(cell).join(' | ')} |`)].join('\n');

function renderPlanReport(plan, { meta, result, verification }) {
  const out = [];
  out.push(`# Final ratings — late downgrade — ${meta.mode}`);
  out.push(`Generated ${meta.generatedAt} · batch \`${meta.importBatch}\``);
  out.push(
    meta.mode === 'DRY RUN'
      ? '\n**Nothing was written to the database.** This is what `--commit` would do.'
      : '\n**This run wrote to the database.** A mongodump backup was taken first (see below).'
  );
  out.push('\nRule: a FINAL rating (an admin changed the estimate) is rated like a real rating with the percent the admin entered — the same thresholds (≥90 ممتاز, ≥80 بہتر, ≥70 مناسب, <70 کمزور), and ONE level down when the task was completed late. A rating that is still only an estimate is not touched.');

  out.push('\n## Checks\n');
  out.push(plan.checks.map((c) => `- ${c.ok ? 'OK  ' : '**FAIL**'} ${c.label}${c.detail ? ` — ${c.detail}` : ''}`).join('\n'));
  out.push(`\n**${plan.ok ? 'All checks pass.' : 'One or more checks FAIL — a commit would refuse to run.'}**`);

  out.push('\n## Totals\n');
  out.push(
    `Final ratings: ${plan.totals.finalRatings} · **to correct: ${plan.totals.toFix}** · already correct: ${plan.totals.alreadyCorrect} · corrected by an earlier run: ${plan.totals.alreadyFixed} · open (no change while open): ${plan.totals.openFinals} · anomalies: ${plan.totals.anomalies}`
  );
  const changes = Object.entries(plan.byChange);
  out.push(changes.length ? `\nBy change: ${changes.map(([k, v]) => `${k.replace('→', ' → ')}: ${v}`).join(' · ')}` : '\nBy change: none');

  out.push('\n## Every task to correct\n');
  out.push(
    plan.items.length
      ? table(
          ['Code', 'Status', 'Final %', 'Current band', 'New band', 'Days late', 'Title'],
          plan.items.map((i) => [i.code, i.status, `${i.assumedPercent}%`, showRating(i.from), showRating(i.to), i.daysLate, shorten(i.title)])
        )
      : '_nothing to correct_'
  );
  if (plan.anomalies.length) {
    out.push('\n## Anomalies — left alone, and the commit refuses to run while there are any\n');
    out.push(plan.anomalies.map((a) => `- ${a}`).join('\n'));
  }

  out.push('\n## What is written per task\n');
  out.push('- `performanceRating` — from the plain band of the final percent to the late-rule band');
  out.push('- one `syntheticRating.history` entry by `system:script` (from → to, the same percent, a note) — a string author, so it is never counted as an admin edit and the task stays final');
  out.push('- one ledger record in `HistoricalImportRecord` (`action: "final-rating-late-downgrade"`, previous and new band) — used by `--rollback`');
  out.push('\nNever written: the final percent, `finalizedAt`/`finalizedBy`, `isSynthetic`, `status`, `completionPercent`, `timeStatus`, `deadline`, `closedAt`, `lastUpdateAt`, `updatedAt`; no TaskUpdate; no notification. Each task is re-read inside its own transaction and the write is aborted unless everything else is byte-identical.');

  if (result) {
    out.push('\n## Commit result\n');
    out.push(`- backup: \`${result.backupDir}\``);
    out.push(`- corrected: **${result.fixed}**`);
    out.push(`- skipped: ${result.skipped.length}${result.skipped.length ? ` — ${result.skipped.map((s) => `${s.code} (${s.reason})`).join('; ')}` : ''}`);
  }
  if (verification) {
    out.push('\n### Verified after the write\n');
    out.push(`- every corrected task reads back with its new band and is still final: **${verification.allCorrected ? 'yes' : 'NO'}**${verification.problems.length ? ` — ${verification.problems.join('; ')}` : ''}`);
    out.push(`- every other final rating byte-identical before and after: **${verification.othersUnchanged ? 'yes' : 'NO'}** (${verification.othersCount} documents)`);
    out.push(`- TaskUpdate documents: ${verification.taskUpdates.before} before → ${verification.taskUpdates.after} after`);
  }
  return `${out.join('\n')}\n`;
}

function renderRollbackReport(rows, { meta, result }) {
  const out = [];
  out.push(`# Final ratings — late downgrade — ROLLBACK ${meta.mode}`);
  out.push(`Generated ${meta.generatedAt}`);
  out.push(meta.mode === 'DRY RUN' ? '\n**Nothing was written to the database.** This is what `--rollback --commit` would do.' : '\n**This run wrote to the database.** A mongodump backup was taken first.');
  const counts = rows.reduce((acc, r) => ({ ...acc, [r.action]: (acc[r.action] || 0) + 1 }), {});
  out.push(`\nActive late-downgrade ledger records: **${rows.length}** — ${Object.entries(counts).map(([k, v]) => `${k}: ${v}`).join(' · ') || 'nothing to roll back'}`);
  if (rows.length) {
    out.push('');
    out.push(table(['Code', 'Action', 'Detail'], rows.map((r) => [r.code, r.action, r.detail])));
  }
  if (result) {
    out.push('\n## Rollback result\n');
    out.push(`- backup: \`${result.backupDir}\``);
    out.push(`- restored: **${result.restored}** · ledger only: ${result.ledgerOnly} · skipped (changed since, left as they are): ${result.skipped.length}`);
    if (result.skipped.length) out.push(`- skipped: ${result.skipped.map((s) => `${s.code} (${s.reason})`).join('; ')}`);
    if (result.notRestoredExactly.length) {
      out.push(`- restored, but the document differs from its state before the correction in some OTHER field (changed by the live app since): ${result.notRestoredExactly.join(', ')}`);
    }
  }
  return `${out.join('\n')}\n`;
}

module.exports = { renderPlanReport, renderRollbackReport };
