const reportService = require('../services/report.service');
const asyncHandler = require('../utils/asyncHandler');

const CONTENT_TYPES = {
  excel: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pdf: 'application/pdf',
  jpeg: 'image/jpeg',
};
const EXTENSIONS = { excel: 'xlsx', pdf: 'pdf', jpeg: 'jpg' };

function todayStamp() {
  return new Date().toISOString().slice(0, 10);
}

function sendFile(res, { format, buffer, filenamePrefix }) {
  res.set('Content-Type', CONTENT_TYPES[format]);
  res.set('Content-Disposition', `attachment; filename="${filenamePrefix}-${todayStamp()}.${EXTENSIONS[format]}"`);
  res.send(buffer);
}

// GET /reports/export — docs/05-apis.md §9. Binary stream, not the standard {success,data} envelope.
const exportReport = asyncHandler(async (req, res) => {
  const { format, reportType, columns, ...filters } = req.query;

  const data = await reportService.buildReportData(req.user, filters, reportType);
  const headerInfo = reportService.buildHeaderInfo(
    data.tasks.map((t) => t.task),
    filters
  );
  const buffer = await reportService.generateReportFile(data, { format, columns, headerInfo });

  sendFile(res, { format, buffer, filenamePrefix: `task-report-${reportType}` });
});

// GET /reports/user-summary — docs/05-apis.md §9. Admin-only (requireRole('admin') on the route).
const exportUserSummary = asyncHandler(async (req, res) => {
  const { format, columns } = req.query;

  const rows = await reportService.buildUserSummaryData(req.user);
  const buffer = await reportService.generateUserSummaryFile(rows, { format, columns });

  sendFile(res, { format, buffer, filenamePrefix: 'user-summary' });
});

module.exports = { exportReport, exportUserSummary };
