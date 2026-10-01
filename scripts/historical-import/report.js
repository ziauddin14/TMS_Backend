// Renders a plan (plan.js) as the human-review Markdown report. Pure: no DB, no filesystem.
const day = (d) => (d ? new Date(d).toISOString().slice(0, 10) : '—');
const cell = (s) => String(s ?? '—').replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ');
const quote = (s) => `> ${String(s).trim().replace(/\s*\n\s*/g, '\n> ')}`;

function table(rows) {
  return ['| Field | Value |', '|---|---|', ...rows.map(([k, v]) => `| ${k} | ${cell(v)} |`)].join('\n');
}

function renderCounts(obj) {
  return Object.entries(obj)
    .map(([k, v]) => `${k}: **${v}**`)
    .join(' · ');
}

function renderHandoverCase(t, who) {
  const h = t.handover;
  const prior = t.updates
    .slice(0, -1)
    .map((u) => `- ${day(u.update.createdAt)} · ${u.speakerLabel}: ${cell(u.update.description)}`)
    .join('\n');
  return [
    `### ${t.code} (${t.personKey})`,
    `**Task:** ${cell(t.task.title)}`,
    '',
    '**Closing line (quoted verbatim):**',
    quote(t.closingRemark),
    '',
    prior ? `**Earlier updates:**\n${prior}` : '',
    '',
    `**Best-guess interpretation (mine, not applied):** ${h.bestGuess} — ${h.rationale}`,
    '',
    table([
      ['Status (either way)', `closed (signal: ${t.closureSignal}), closedAt ${day(t.task.closedAt)}`],
      ['If decided "completed"', `rating ${t.formulaRating} (${t.hasExplicitPercent ? 'existing formula on explicit %' : "'-' — no explicit % in this task"})`],
      ['If decided "reassigned"', "rating '-' (performance not attributed to this zimmedar)"],
      ['Assignee', who(t.task.assignees[0])],
      ['Decision recorded', h.decision || '**NOT YET — blocks --commit**'],
    ]),
  ].join('\n');
}

function renderTaskDetail(t, who) {
  const ts = t.task.timeStatus;
  const header = `### ${t.code} — ${t.personKey} — ${t.task.status}${t.mergedFrom ? ' (merged)' : ''}`;
  const fields = table([
    ['title', t.task.title],
    ['assignees', t.task.assignees.map(who).join(', ')],
    ['responsibility', t.task.responsibility],
    ['deadline', `${day(t.task.deadline)} (source "${t.raw.target}")`],
    ['createdAt', `${day(t.task.createdAt)} (code_date)`],
    ['createdBy', who(t.task.createdBy)],
    ['status', `${t.task.status} — closure signal: ${t.closureSignal}`],
    ['closedAt / closedBy', t.task.closedAt ? `${day(t.task.closedAt)} / ${who(t.task.closedBy)}` : '—'],
    ['source Close column', t.raw.close || '(empty)'],
    ['completionPercent', t.task.completionPercent],
    ['lastUpdateAt', day(t.task.lastUpdateAt)],
    ['timeStatus (system formula)', `${ts.type} ${ts.days}`],
    ['performanceRating', `${t.task.performanceRating} (${t.ratingBasis})`],
    ['reminder from next scan', t.reminderType || (t.task.status === 'closed' ? '— (closed)' : 'none yet')],
    ['dataQualityIssues', t.dataQualityIssues.join(', ') || '—'],
    ['review notes', t.reviewNotes.join(' | ') || '—'],
  ]);
  const updates = t.updates
    .map((u) => {
      const flagStr = Object.entries(u.flags)
        .map(([k, v]) => (v === true ? k : `${k}=${JSON.stringify(v)}`))
        .join(', ');
      const meta = [
        `**${day(u.update.createdAt)}** (${u.dateSource})`,
        `${u.speakerLabel} → ${who(u.update.updatedBy)}`,
        `${u.update.completionPercent}% (${u.percentSource}${u.percentsFound.length ? `; found ${u.percentsFound.join(', ')}` : ''})`,
        u.isClosingRemark ? '**closing remark**' : null,
        flagStr ? `flags: ${flagStr}` : null,
        u.dataQualityIssues.length ? `⚠️ ${u.dataQualityIssues.join(', ')}` : null,
      ]
        .filter(Boolean)
        .join(' · ');
      return `${u.index + 1}. ${meta}\n\n${quote(u.update.description)
        .split('\n')
        .map((l) => `   ${l}`)
        .join('\n')}`;
    })
    .join('\n\n');
  return `${header}\n\n${fields}\n\n**TaskUpdates (${t.updates.length}):**\n\n${updates}`;
}

function renderMarkdown(plan, { meta, preflight, userNames }) {
  const who = (id) => (id ? `${userNames[String(id)] || 'UNKNOWN USER'} (${id})` : '—');
  const t = plan.totals;
  const out = [];

  out.push(`# Historical Follow-up Import — ${meta.mode} REPORT`);
  out.push(
    `Generated ${meta.generatedAt} · source \`${meta.sourceFile}\` · status computed as of **${meta.now}** (Karachi calendar) · batch \`${meta.importBatch}\``
  );
  out.push(meta.mode === 'DRY RUN' ? '**Nothing was written to the database.**' : '');

  out.push('\n## Preflight (read-only database checks)');
  out.push(preflight.checks.map((c) => `- ${c.ok ? '✅' : '❌'} ${c.label}${c.detail ? ` — ${c.detail}` : ''}`).join('\n'));

  out.push('\n## Totals');
  out.push(
    [
      `- Source: ${t.sourceTasks} tasks / ${t.sourceUpdates} updates → **would create ${t.tasks} Tasks / ${t.updates} TaskUpdates** (duplicate 260410 merged)`,
      `- Per person: ${Object.entries(t.byPerson).map(([p, c]) => `${p} ${c.tasks}/${c.updates}`).join(' · ')}`,
      `- Status: ${renderCounts(t.byStatus)}`,
      `- Closure signal: ${renderCounts(t.byClosureSignal)}`,
      `- Rating: ${renderCounts(t.byRating)} — basis: ${renderCounts(t.byRatingBasis)}`,
      `- Update date source: ${renderCounts(t.byDateSource)}`,
      `- Update % source: ${renderCounts(t.byPercentSource)}`,
    ].join('\n')
  );

  out.push('\n## ⚠️ Reminder exposure (accepted, expected)');
  out.push(
    'Open tasks import as real active work. From the **first daily reminder scan after commit**, these trigger automatic in-app + push notifications to the assignee (deduplicated to one per task per person per day):'
  );
  out.push(
    Object.entries(plan.reminderExposure.byPerson)
      .map(([p, c]) => `- **${p}**: ${renderCounts(c) || 'no open tasks'}`)
      .join('\n')
  );
  out.push(`- **Total**: ${renderCounts(plan.reminderExposure.total)}`);

  out.push(`\n## 🔍 REVIEW REQUIRED — handover-style closures (${plan.handoverCases.length})`);
  out.push(
    'Not resolved by the script. Each needs a human decision ("completed" or "reassigned") recorded in `HANDOVER_DECISIONS` before `--commit` will run.'
  );
  plan.handoverCases.forEach((c) => out.push(`\n${renderHandoverCase(c, who)}`));

  const overrides = plan.tasks.filter((x) => x.reviewNotes.length);
  out.push(`\n## 🔍 Review notes (${overrides.length})`);
  overrides.forEach((x) =>
    out.push(`- **${x.code}** → status **${x.task.status}**, assignee ${who(x.task.assignees[0])}: ${x.reviewNotes.join(' | ')}`)
  );

  out.push(`\n## Data-quality issues — tasks (${plan.taskIssues.length})`);
  plan.taskIssues.forEach((x) =>
    out.push(`- **${x.code}** (${x.personKey}): ${x.dataQualityIssues.join(', ')} — target "${x.raw.target}", close "${x.raw.close || ''}", created ${x.raw.code_date}`)
  );

  out.push(`\n## Data-quality issues — updates (${plan.updateIssues.length})`);
  plan.updateIssues.forEach((u) =>
    out.push(
      `- **${u.code} #${u.index + 1}** (${u.personKey}): ${u.dataQualityIssues.join(', ')} — percents found [${u.percentsFound.join(', ')}], used ${u.update.completionPercent}% (${u.percentSource})\n  ${quote(u.update.description)}`
    )
  );

  out.push(`\n## Closing-remark dates replaced by the Close date (call #4) (${plan.substitutions.length})`);
  plan.substitutions.forEach((u) =>
    out.push(`- **${u.code} #${u.index + 1}** (${u.personKey}): placeholder ${u.raw.date_year}-${u.raw.date_month}-${u.raw.date_day} → ${day(u.update.createdAt)}`)
  );

  out.push(`\n## Lateness: system formula vs the source's own signals (${plan.latenessDisagreements.length} disagreements)`);
  out.push(
    "Informational. Committed timeStatus/rating use the system's own `computeTimeStatus` (last update vs deadline). These closed tasks are where an explicit \"تاخیر\" in the closing remark, or the Close date vs the deadline, says otherwise. Only rows with an explicit % affect a rating."
  );
  plan.latenessDisagreements.forEach((x) =>
    out.push(
      `- **${x.code}** (${x.personKey}): system ${x.task.timeStatus.type} ${x.task.timeStatus.days} · remark says late: ${x.latenessCheck.remarkSaysLate} · close date late: ${x.latenessCheck.closeDateLate} · rating ${x.task.performanceRating} (${x.ratingBasis})`
    )
  );

  out.push(`\n## Every task (${plan.tasks.length}) and every TaskUpdate (${t.updates})`);
  plan.tasks.forEach((x) => out.push(`\n${renderTaskDetail(x, who)}`));

  return `${out.filter((s) => s !== '').join('\n')}\n`;
}

module.exports = { renderMarkdown };
