import express from 'express';
import bcrypt from 'bcrypt';

// Dependencies injected: tmuxService, fileService, taskStore, config
import authMiddleware, { createJwtToken, setAuthCookie, clearAuthCookie, createRefreshToken } from '../middleware/auth.js';
import { loginLimiter } from '../middleware/rateLimit.js';

import { ACC_PASSWORD_HASH } from '../config/env.js';

/**
 * Create authentication router
 * - Implements login at /api/auth/login
 * - Uses rate limiter (loginLimiter)
 * - Accepts { password } only in body; no username
 * - Validates password against ACC_PASSWORD_HASH
 * - Issues short-lived JWT (15m) and httpOnly refresh token cookie nexus_token (7d)
 * - Returns { token } with short-lived JWT for backward compat
 * @param {Object} deps
 * @param {Object} deps.config
 */
export function createAuthRouter(/* deps not strictly required for this rewrite */) {
  const router = express.Router();

  // LOGIN (no auth required)
  router.post('/login', loginLimiter, async (req, res) => {
    try {
      const { password } = req.body || {};
      if (!password) {
        return res.status(400).json({ error: 'Missing credentials' });
      }

      // Compare against configured password hash
      const match = await bcrypt.compare(password, ACC_PASSWORD_HASH);
      if (!match) {
        return res.status(401).json({ error: 'Invalid credentials' });
      }

      // Create tokens
      const shortLived = createJwtToken(); // 15m token
      const refreshToken = createRefreshToken();
      // Persist refresh token in a httpOnly cookie (nexus_token)
      setAuthCookie(res, refreshToken);

      // Return short-lived token for backward compatibility
      return res.json({ token: shortLived });
    } catch (err) {
      console.error('Auth login error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  // All other routes require authentication
  router.use(authMiddleware);

  // The actual route implementations are in the other router modules
  // which will be mounted by the server using the same deps object.

  return router;
}

export default createAuthRouter;
