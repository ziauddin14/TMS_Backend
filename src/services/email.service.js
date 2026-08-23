const nodemailer = require('nodemailer');
const env = require('../config/env');
const logger = require('../utils/logger');

// docs/06-backend.md §7: "A single nodemailer transporter created once at startup from the
// SMTP_* env vars." Creating the transporter does not itself connect to the SMTP server —
// nodemailer only connects lazily on an actual send — so this is safe at module-load time even
// against the dummy credentials in .env.test (never actually invoked for real there; mocked).
const transporter = nodemailer.createTransport({
  host: env.SMTP_HOST,
  port: env.SMTP_PORT,
  secure: env.SMTP_PORT === 465,
  auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
});

function escapeHtml(str) {
  const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return String(str ?? '').replace(/[&<>"']/g, (c) => map[c]);
}

// FRONTEND_URL already exists (added Phase 1, used for CORS since app.js) — reused here rather
// than introducing a new env var for "the app's base URL," per the Phase 9 instructions.
function taskLink(task) {
  return `${env.FRONTEND_URL}/tasks/${task.id ?? task._id}`;
}

// Simple bilingual-friendly HTML, not a templating engine (docs/06-backend.md §7).
function buildEmailHtml({ headingEn, headingUr, task }) {
  const link = taskLink(task);
  return `<!doctype html>
<html>
<head><meta charset="utf-8" /></head>
<body style="font-family: sans-serif; direction: ltr;">
  <h2>${escapeHtml(headingEn)} / <span dir="rtl">${escapeHtml(headingUr)}</span></h2>
  <p><strong>Task / کام:</strong> ${escapeHtml(task.title)}</p>
  <p><strong>Code Number:</strong> ${escapeHtml(task.codeNumber)}</p>
  <p><strong>Deadline / آخری تاریخ:</strong> ${new Date(task.deadline).toLocaleDateString()}</p>
  <p><a href="${link}">${link}</a></p>
</body>
</html>`;
}

// docs/06-backend.md §7: "Every send is wrapped so a failure (SMTP hiccup) is logged but never
// crashes the cron job — one failed email should not stop the rest of the batch from sending."
// Returns true/false rather than throwing, so callers can tally successes without try/catch.
async function sendMail({ to, subject, html }) {
  try {
    await transporter.sendMail({ from: env.SMTP_USER, to, subject, html });
    return true;
  } catch (err) {
    logger.error(`Failed to send email to ${to}:`, err.message);
    return false;
  }
}

async function sendDeadlineSoonEmail(task, user) {
  const html = buildEmailHtml({
    headingEn: 'Deadline Approaching',
    headingUr: 'آخری تاریخ قریب ہے',
    task,
  });
  return sendMail({
    to: user.email,
    subject: `Deadline Approaching: ${task.title} (${task.codeNumber})`,
    html,
  });
}

async function sendOverdueEmail(task, user) {
  const html = buildEmailHtml({
    headingEn: 'Task Overdue',
    headingUr: 'کام میں تاخیر ہو چکی ہے',
    task,
  });
  return sendMail({
    to: user.email,
    subject: `Overdue: ${task.title} (${task.codeNumber})`,
    html,
  });
}

module.exports = { sendDeadlineSoonEmail, sendOverdueEmail };
