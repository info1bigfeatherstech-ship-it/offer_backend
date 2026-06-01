/**
 * Central logging: console by default; optional Winston (files + console) when LOG_USE_WINSTON=true.
 * Does not change API surface — same { info, warn, error, debug } used across the app.
 */
const fs = require('fs');
const path = require('path');

const useWinston =
  String(process.env.LOG_USE_WINSTON || '').toLowerCase() === 'true';

function createConsoleLogger() {
  return {
    info: (message, meta = {}) => {
      console.log(`[INFO] ${message}`, Object.keys(meta).length ? meta : '');
    },
    error: (message, meta = {}) => {
      console.error(`[ERROR] ${message}`, Object.keys(meta).length ? meta : '');
    },
    warn: (message, meta = {}) => {
      console.warn(`[WARN] ${message}`, Object.keys(meta).length ? meta : '');
    },
    debug: (message, meta = {}) => {
      console.debug(`[DEBUG] ${message}`, Object.keys(meta).length ? meta : '');
    }
  };
}

function createWinstonLogger() {
  const winston = require('winston');
  const logDir = path.join(__dirname, '..', 'logs');
  try {
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
  } catch (_) {
    /* fallback: file transports may fail; console still works */
  }

  const level = process.env.LOG_LEVEL || 'info';
// logger format
  const logFormat = winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.errors({ stack: true }),
    winston.format.splat(),
    winston.format.printf(({ timestamp, level: lvl, message, stack, ...meta }) => {
      const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
      return `${timestamp} [${lvl.toUpperCase()}] ${message}${stack ? ` ${stack}` : ''}${metaStr}`;
    })
  );

  const transports = [
    new winston.transports.File({
      filename: path.join(logDir, 'error.log'),
      level: 'error',
      maxsize: 5 * 1024 * 1024,
      maxFiles: 5
    }),
    new winston.transports.File({
      filename: path.join(logDir, 'combined.log'),
      maxsize: 5 * 1024 * 1024,
      maxFiles: 5
    }),
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.printf(({ level: lvl, message, stack, ...meta }) => {
          const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
          return `${lvl}: ${message}${stack ? ` ${stack}` : ''}${metaStr}`;
        })
      )
    })
  ];

  const w = winston.createLogger({
    level,
    format: logFormat,
    transports
  });

  return {
    info: (message, meta = {}) => w.info(message, meta),
    error: (message, meta = {}) => w.error(message, meta),
    warn: (message, meta = {}) => w.warn(message, meta),
    debug: (message, meta = {}) => w.debug(message, meta)
  };
}

let logger;
try {
  logger = useWinston ? createWinstonLogger() : createConsoleLogger();
} catch (e) {
  console.error('[logger] Winston init failed, using console:', e.message);
  logger = createConsoleLogger();
}

module.exports = logger;
