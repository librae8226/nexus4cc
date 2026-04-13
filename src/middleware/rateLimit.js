// src/middleware/rateLimit.js
// Simple in-memory rate limiter built from scratch (no external dependencies)
// Exports:
//  - createRateLimiter({ windowMs, max, keyFn }) -> Express middleware
//  - loginLimiter, apiLimiter (pre-configured)

const limiterStore = new Map(); // key -> { count, resetAt }

function nowMs() {
  return Date.now();
}

export function createRateLimiter({ windowMs, max, keyFn }) {
  const windowMsVal = typeof windowMs === 'number' ? windowMs : 60000;
  const maxRequests = typeof max === 'number' ? max : 60;
  const keyResolver = typeof keyFn === 'function' ? keyFn : () => '';

  return function rateLimiter(req, res, next) {
    const key = String(keyResolver(req) || 'default');
    const now = nowMs();
    let entry = limiterStore.get(key);

    if (!entry || now > entry.resetAt) {
      // reset window
      entry = { count: 0, resetAt: now + windowMsVal };
      limiterStore.set(key, entry);
    }

    if (entry.count < maxRequests) {
      entry.count += 1;
      return next();
    }

    // limit exceeded
    const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
    res.status(429).json({ error: 'too many requests', retryAfter });
  };
}

// Pre-configured limiters
export const loginLimiter = createRateLimiter({ windowMs: 60_000, max: 5, keyFn: (req) => req.ip || req.connection?.remoteAddress || '' });
export const apiLimiter = createRateLimiter({ windowMs: 60_000, max: 100, keyFn: (req) => req.ip || req.connection?.remoteAddress || '' });

export default { createRateLimiter, loginLimiter, apiLimiter };
