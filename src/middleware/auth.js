// src/middleware/auth.js
// JWT-based authentication middleware with support for Bearer tokens and httpOnly cookies
// Exports:
//  - authMiddleware(req, res, next)
//  - cookieAuthMiddleware(req, res, next)
//  - createJwtToken()
//  - createRefreshToken()
//  - setAuthCookie(res, token)
//  - clearAuthCookie(res)
//
// Requires: JWT_SECRET from config/env.js

import jwt from 'jsonwebtoken';
import { JWT_SECRET } from '../config/env.js';

// Verify a JWT and return payload or throw
function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET);
}

// 1) Export authMiddleware: supports Bearer header or nexus_token cookie
export function authMiddleware(req, res, next) {
  // 1) Try Bearer token in Authorization header
  const authHeader = (req.headers?.authorization || '').toString().trim();
  if (authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7).trim();
    try {
      verifyToken(token);
      req.authenticated = true;
      return next();
    } catch {
      // fall through to cookie-based auth
    }
  }

  // 2) Try httpOnly cookie named nexus_token
  const tokenFromCookie = req.cookies?.nexus_token;
  if (tokenFromCookie) {
    try {
      verifyToken(tokenFromCookie);
      req.authenticated = true;
      return next();
    } catch {
      // invalid cookie -> unauthorized
    }
  }

  // If neither method worked
  res.status(401).json({ error: 'unauthorized' });
}

// 1b) Export cookieAuthMiddleware: ONLY checks httpOnly cookie
export function cookieAuthMiddleware(req, res, next) {
  const tokenFromCookie = req.cookies?.nexus_token;
  if (!tokenFromCookie) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  try {
    verifyToken(tokenFromCookie);
    req.authenticated = true;
    return next();
  } catch {
    return res.status(401).json({ error: 'unauthorized' });
  }
}

// 2) Token creation helpers with required expiries
export function createJwtToken() {
  // Short-lived access token
  return jwt.sign({}, JWT_SECRET, { expiresIn: '15m' });
}

export function createRefreshToken() {
  // Longer-lived refresh token
  return jwt.sign({}, JWT_SECRET, { expiresIn: '7d' });
}

// 3) Cookie helpers
export function setAuthCookie(res, token) {
  // 7 days expiry, httpOnly, Secure, SameSite Strict
  res.cookie('nexus_token', token, {
    httpOnly: true,
    secure: true,
    sameSite: 'strict',
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });
}

export function clearAuthCookie(res) {
  res.clearCookie('nexus_token', {
    httpOnly: true,
    secure: true,
    sameSite: 'strict',
  });
}

export default { authMiddleware, cookieAuthMiddleware };
