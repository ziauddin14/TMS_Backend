function notFoundHandler(req, res) {
  res.status(404).json({
    success: false,
    message: 'Route not found',
    code: 'NOT_FOUND',
  });
}

module.exports = notFoundHandler;
