// Nexus4CC Environment configuration (refactored)
// - Load .env from project root
// - Export ALL env vars used across the app with defaults
// - Validate required vars at load time

import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';

// Load .env if present in project root
const envPath = path.resolve(process.cwd(), '.env');
try {
  if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath });
  } else {
    // Fallback: try to load from process.env directly
    // Do nothing if no .env found
  }
} catch (e) {
  // Silently ignore dotenv issues, but continue with process.env
}

// Core secrets and config (with explicit defaults where sensible)
const JWT_SECRET = process.env.JWT_SECRET;
const ACC_PASSWORD_HASH = process.env.ACC_PASSWORD_HASH;
const TMUX_SESSION = process.env.TMUX_SESSION || 'main';
const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT || '/workspace';
const PORT = process.env.PORT || '59000';
const CLAUDE_PROXY = process.env.CLAUDE_PROXY || '';
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET;
const TELEGRAM_DEFAULT_SESSION = process.env.TELEGRAM_DEFAULT_SESSION || '';
const GITHUB_REPO = process.env.GITHUB_REPO || 'librae8226/nexus4cc';

// Validation: required fields must be present
if (!JWT_SECRET) {
  throw new Error('Environment validation error: JWT_SECRET is required');
}
if (!ACC_PASSWORD_HASH) {
  throw new Error('Environment validation error: ACC_PASSWORD_HASH is required');
}

const config = {
  JWT_SECRET,
  ACC_PASSWORD_HASH,
  TMUX_SESSION,
  WORKSPACE_ROOT,
  PORT,
  CLAUDE_PROXY,
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_WEBHOOK_SECRET,
  TELEGRAM_DEFAULT_SESSION,
  GITHUB_REPO,
};

export { JWT_SECRET, ACC_PASSWORD_HASH, TMUX_SESSION, WORKSPACE_ROOT, PORT, CLAUDE_PROXY, TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET, TELEGRAM_DEFAULT_SESSION, GITHUB_REPO };
export default config;
