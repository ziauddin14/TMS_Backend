// Markdown rendering for the synthetic-rating plan (dry run and commit) and for the rollback plan.
// Pure: takes already-built data, returns a string.
const fs = require('fs');
const path = require('path');

const RATING_URDU = { excellent: 'ممتاز', good: 'بہتر', fair: 'مناسب', weak: 'کمزور' };
const showRating = (rating) => (rating === null || rating === undefined ? '(unset)' : RATING_URDU[rating] ? `${rating} (${RATING_URDU[rating]})` : String(rating));
const cell = (value) => String(value ?? '').replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
const shorten = (text, max = 70) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const table = (head, rows) => [`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`, ...rows.map((r) => `| ${r.map(cell).join(' | ')} |`)].join('\n');

const REFERENCE_PATTERN = /performanceRating|byPerformance|computePerformanceRating|ratingForPercent|getEffectivePercent|syntheticRating/;
const ASSIGNMENT_PATTERN = /\.performanceRating\s*=(?!=)/;

// Every source file that mentions the rating, found by scanning the code at run time (so this list
// cannot go stale). `roots` are [label, absoluteDir] pairs; a root that does not exist is skipped.
function findRatingReferences(roots) {
  const results = [];
  const walk = (dir, visit) => {
    fs.readdirSync(dir, { withFileTypes: true }).forEach((entry) => {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, visit);
      else if (/\.(js|jsx)$/.test(entry.name)) visit(full);
    });
  };
  roots.forEach(([label, dir]) => {
    if (!fs.existsSync(dir)) {
      results.push({ file: `${label}/ (not present on this machine)`, lines: [], assigns: false });
      return;
    }
    walk(dir, (full) => {
      const lines = fs.readFileSync(full, 'utf8').split('\n');
      const hits = lines.map((text, i) => (REFERENCE_PATTERN.test(text) ? i + 1 : null)).filter(Boolean);
      if (!hits.length) return;
      results.push({
        file: `${label}/${path.relative(dir, full).replace(/\\/g, '/')}`,
        lines: hits,
        assigns: lines.some((text) => ASSIGNMENT_PATTERN.test(text)),
      });
    });
  });
  return results.sort((a, b) => a.file.localeCompare(b.file));
}

function renderChecks(checks) {
  return checks.map((c) => `- ${c.ok ? 'OK  ' : '**FAIL**'} ${c.label}${c.detail ? ` — ${c.detail}` : ''}`).join('\n');
}

function renderAssignReport(plan, { meta, references, result, protectedCheck }) {
  const out = [];
  out.push(`# Synthetic ratings — ${meta.mode}`);
  out.push(`Generated ${meta.generatedAt} · batch \`${meta.importBatch}\` · assigned by \`${meta.assignedBy}\``);
  out.push(
    meta.mode === 'DRY RUN'
      ? '\n**Nothing was written to the database.** This is what `--commit` would do.'
      : '\n**This run wrote to the database.** A mongodump backup was taken first (see below).'
  );

  out.push('\n## Checks\n');
  out.push(renderChecks(plan.checks));
  out.push(`\n**${plan.ok ? 'All checks pass.' : 'One or more checks FAIL — a commit would refuse to run.'}**`);

  out.push('\n## Groups\n');
  out.push(
    table(
      ['Group', 'Assumed %', 'New rating', 'Expected', 'To assign now', 'Already synthetic', 'Since replaced by a real rating'],
      Object.values(plan.groups).map((g) => [g.label, `${g.assumedPercent}%`, showRating(g.rating), g.expectedCount, g.toAssign.length, g.alreadySynthetic.length, g.replacedByReal.length])
    )
  );
  out.push(`\nTotal to assign now: **${plan.totals.toAssign}** · already synthetic: ${plan.totals.alreadySynthetic} · since replaced by a real rating: ${plan.totals.replacedByReal} · tasks in the database: ${plan.totals.tasks}`);
  out.push('\nRating rule: the same thresholds as a real rating (≥90 ممتاز, ≥80 بہتر, ≥70 مناسب, <70 کمزور), applied to the assumed percentage, with **no late downgrade**.');
  out.push('\nAfterwards, in the app: an update on an open task keeps the synthetic rating; the moment the task earns a real rating (it is closed, or an update takes it to 100%), the real rating replaces it, `syntheticRating.isSynthetic` becomes `false` and the replacement is added to its history.');

  out.push('\n## Sample — 5 tasks per group\n');
  Object.values(plan.groups).forEach((g) => {
    out.push(`### ${g.label}\n`);
    out.push(
      g.toAssign.length
        ? table(
            ['Code', 'Title', 'Status (unchanged)', 'Real % (unchanged)', 'Old rating', 'New rating'],
            g.toAssign.slice(0, 5).map((i) => [i.code, shorten(i.title), i.status, `${i.completionPercent}%`, showRating(i.performanceRating), showRating(i.newRating)])
          )
        : '_nothing to assign in this group_'
    );
    out.push('');
  });

  out.push('## Left untouched\n');
  out.push(`### The ${plan.realRated.length} really-rated tasks — not in the plan\n`);
  out.push(
    table(
      ['Code', 'Status', 'Real %', 'Real rating'],
      [...plan.realRated].sort((a, b) => a.code.localeCompare(b.code)).map((t) => [t.code, t.status, `${t.completionPercent}%`, showRating(t.performanceRating)])
    )
  );
  out.push('\n### Never-touch list — not in the plan\n');
  out.push(
    plan.neverTouched.length
      ? table(['Code', 'Title', 'Status', 'Real %', 'Rating'], plan.neverTouched.map((t) => [t.code, shorten(t.title), t.status, `${t.completionPercent}%`, showRating(t.performanceRating)]))
      : '_none of the never-touch codes exist in the database_'
  );
  out.push('\n### Excluded on purpose — stay unrated, not in the plan\n');
  out.push(
    plan.excluded.length
      ? table(['Code', 'Title', 'Status', 'Real %', 'Rating (stays)', 'Why'], plan.excluded.map((t) => [t.code, shorten(t.title, 50), t.status, `${t.completionPercent}%`, showRating(t.performanceRating), t.why]))
      : '_no exclusions configured_'
  );
  if (plan.notEligible.length) {
    out.push('\n### Other unrated tasks that are NOT eligible\n');
    out.push(table(['Code', 'Status', 'Why not'], plan.notEligible.map((t) => [t.code, t.status, t.why])));
  }
  if (protectedCheck) {
    out.push('\n### Verified after the write\n');
    out.push(`- really-rated + never-touch + excluded tasks byte-identical before and after: **${protectedCheck.protectedUnchanged ? 'yes' : 'NO'}** (${protectedCheck.protectedCount} documents)`);
    out.push(`- TaskUpdate documents: ${protectedCheck.taskUpdates.before} before → ${protectedCheck.taskUpdates.after} after`);
    out.push(`- Notification documents: ${protectedCheck.notifications.before} before → ${protectedCheck.notifications.after} after (the live app may add its own during the run)`);
  }

  if (plan.reviewNotes.length) {
    out.push('\n## PROBLEM — handover tasks in the plan\n');
    out.push('These tasks were deliberately left unrated by the import review and should be on the exclusion list:\n');
    out.push(table(['Code', 'Title', 'Note'], plan.reviewNotes.map((n) => [n.code, shorten(n.title), n.note])));
  }

  out.push('\n## What is written per task\n');
  out.push('- `performanceRating` — set to the new rating');
  out.push('- `syntheticRating` — `{ isSynthetic: true, assumedPercent, assignedAt, assignedBy, reason, history: [one entry] }`');
  out.push('- one ledger record in `HistoricalImportRecord` (`action: "synthetic-rating"`, previous and new values) — used by `--rollback`');
  out.push('\nNever written: `status`, `completionPercent`, `deadline`, `assignees`, `lastUpdateAt`, `timeStatus`, `closedAt`, `updatedAt`; no TaskUpdate; no notification; no reminder state. Each task is re-read inside its own transaction and the write is aborted unless every other field is byte-identical.');

  out.push('\n## Files that reference the rating\n');
  out.push(table(['File', 'Lines', 'Assigns the field'], references.map((r) => [r.file, r.lines.join(', '), r.assigns ? 'YES — overwrites it' : ''])));

  if (result) {
    out.push('\n## Commit result\n');
    out.push(`- backup: \`${result.backupDir}\``);
    out.push(`- assigned: **${result.assigned}**`);
    out.push(`- skipped: ${result.skipped.length}${result.skipped.length ? ` — ${result.skipped.map((s) => `${s.code} (${s.reason})`).join('; ')}` : ''}`);
  }

  out.push('\n## Every task in the plan\n');
  out.push(
    plan.items.length
      ? table(
          ['Code', 'Group', 'Status', 'Real %', 'Old rating', 'New rating', 'Assumed %', 'Title'],
          plan.items.map((i) => [i.code, i.group, i.status, `${i.completionPercent}%`, showRating(i.performanceRating), showRating(i.newRating), `${i.assumedPercent}%`, shorten(i.title, 50)])
        )
      : '_nothing to assign_'
  );
  return `${out.join('\n')}\n`;
}

function renderRollbackReport(rows, { meta, result }) {
  const out = [];
  out.push(`# Synthetic ratings — ROLLBACK ${meta.mode}`);
  out.push(`Generated ${meta.generatedAt}`);
  out.push(meta.mode === 'DRY RUN' ? '\n**Nothing was written to the database.** This is what `--rollback --commit` would do.' : '\n**This run wrote to the database.** A mongodump backup was taken first.');
  const counts = rows.reduce((acc, r) => ({ ...acc, [r.action]: (acc[r.action] || 0) + 1 }), {});
  out.push(`\nActive synthetic-rating ledger records: **${rows.length}** — ${Object.entries(counts).map(([k, v]) => `${k}: ${v}`).join(' · ') || 'nothing to roll back'}`);
  if (rows.length) {
    out.push('');
    out.push(table(['Code', 'Action', 'Detail'], rows.map((r) => [r.code, r.action, r.detail])));
  }
  if (result) {
    out.push('\n## Rollback result\n');
    out.push(`- backup: \`${result.backupDir}\``);
    out.push(`- restored: **${result.restored}** · marker removed only: ${result.markerOnly} · ledger only: ${result.ledgerOnly} · skipped: ${result.skipped.length}`);
    if (result.notRestoredExactly.length) {
      out.push(`- restored, but the document differs from its pre-assignment state in some OTHER field (changed by the live app since): ${result.notRestoredExactly.join(', ')}`);
    }
  }
  return `${out.join('\n')}\n`;
}

module.exports = { renderAssignReport, renderRollbackReport, findRatingReferences, showRating };
