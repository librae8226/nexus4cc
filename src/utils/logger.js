// Structured logging with pino, including request-scoped loggers
import pino from 'pino';
import crypto from 'crypto';

// Base logger writes to stdout by default
export const logger = pino({ name: 'nexus4cc', level: process.env.LOG_LEVEL || 'info' });

// Create a request-scoped child logger for a given request
export function createRequestLogger(req) {
  if (!req) return logger;
  // Generate a lightweight request id if not provided by client
  const reqId =
    (req.headers && req.headers['x-request-id']) ||
    (typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : crypto.randomBytes(8).toString('hex'));
  const child = logger.child({ reqId, method: req.method, url: req.originalUrl || req.url });
  return child;
}

// Express-style middleware to attach a per-request logger
export function createRequestLoggerMiddleware(req, res, next) {
  req.log = createRequestLogger(req);
  next();
}

// Convenience: alias for middleware export with a clear name
export const requestLogger = createRequestLoggerMiddleware;

// Small wrapper exposing standard log level methods (fatal, error, warn, info, debug, trace)
export const log = {
  fatal: (...args) => logger.fatal(...args),
  error: (...args) => logger.error(...args),
  warn: (...args) => logger.warn(...args),
  info: (...args) => logger.info(...args),
  debug: (...args) => logger.debug(...args),
  trace: (...args) => logger.trace(...args),
};
