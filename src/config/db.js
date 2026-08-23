const mongoose = require('mongoose');
const dns = require('dns');
const env = require('./env');
const logger = require('../utils/logger');

async function connectDB() {
  try {
    if (env.MONGODB_URI && env.MONGODB_URI.startsWith('mongodb+srv://')) {
      try {
        dns.setServers(['8.8.8.8', '8.8.4.4', '1.1.1.1']);
      } catch (dnsErr) {
        logger.warn('Could not set custom DNS servers:', dnsErr.message);
      }
    }
    await mongoose.connect(env.MONGODB_URI);
    logger.info('MongoDB connected');
  } catch (err) {
    logger.error('MongoDB connection failed:', err.message);
    process.exit(1);
  }
}

module.exports = { connectDB };

