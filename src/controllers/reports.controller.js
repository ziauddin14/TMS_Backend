const reportService = require('../services/report.service');
const asyncHandler = require('../utils/asyncHandler');

const CONTENT_TYPES = {
  excel: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pdf: 'application/pdf',
  jpeg: 'image/jpeg',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};
const EXTENSIONS = { excel: 'xlsx', pdf: 'pdf', jpeg: 'jpg', docx: 'docx' };

function todayStamp() {
  return new Date().toISOString().slice(0, 10);
}

function sendFile(res, { format, buffer, filenamePrefix }) {
  res.set('Content-Type', CONTENT_TYPES[format]);
  res.set('Content-Disposition', `attachment; filename="${filenamePrefix}-${todayStamp()}.${EXTENSIONS[format]}"`);
  res.send(buffer);
}

// GET /reports/export — docs/05-apis.md §9. Binary stream, not the standard {success,data}
// envelope. Prompt — rewritten: the report is now one fixed grouped-by-Zimmedar structure
// (reportService.buildReportData/generateReportFile), so reportType/columns are gone from here;
// lastUpdateOnly is the one remaining request-shaped option.
const exportReport = asyncHandler(async (req, res) => {
  const { format, lastUpdateOnly, ...filters } = req.query;

  const data = await reportService.buildReportData(req.user, filters, { lastUpdateOnly });
  const headerInfo = reportService.buildHeaderInfo(filters);
  const buffer = await reportService.generateReportFile(data, { format, headerInfo });

  sendFile(res, { format, buffer, filenamePrefix: 'task-report' });
});

// GET /reports/user-summary — docs/05-apis.md §9. Admin-only (requireRole('admin') on the route).
const exportUserSummary = asyncHandler(async (req, res) => {
  const { format, columns } = req.query;

  const rows = await reportService.buildUserSummaryData(req.user);
  const buffer = await reportService.generateUserSummaryFile(rows, { format, columns });

  sendFile(res, { format, buffer, filenamePrefix: 'user-summary' });
});

module.exports = { exportReport, exportUserSummary };
