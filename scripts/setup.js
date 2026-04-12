#!/usr/bin/env node
// Nexus automated setup script — run with: node scripts/setup.js
// Requires Node.js 20+. All other dependencies are installed by this script.

import { execSync, spawnSync } from 'child_process';
import { existsSync, copyFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function run(cmd, opts = {}) {
  return spawnSync(cmd, { shell: true, stdio: 'inherit', cwd: ROOT, ...opts });
}

function check(cmd) {
  return spawnSync(cmd, { shell: true, stdio: 'pipe' }).status === 0;
}

function step(msg) {
  console.log(`\n\x1b[36m▶ ${msg}\x1b[0m`);
}

function ok(msg) {
  console.log(`\x1b[32m✔ ${msg}\x1b[0m`);
}

function fail(msg) {
  console.error(`\x1b[31m✖ ${msg}\x1b[0m`);
  process.exit(1);
}

// ── 1. Node version ──────────────────────────────────────────────────────────
step('Checking Node.js version');
const [major] = process.versions.node.split('.').map(Number);
if (major < 20) fail(`Node.js 20+ required, found ${process.version}. Install via: nvm install 20 && nvm use 20`);
ok(`Node.js ${process.version}`);

// ── 2. tmux ──────────────────────────────────────────────────────────────────
step('Checking tmux');
if (!check('tmux -V')) {
  console.log('tmux not found — attempting install...');
  if (check('apt-get --version')) {
    run('sudo apt-get install -y tmux');
  } else if (check('brew --version')) {
    run('brew install tmux');
  } else {
    fail('tmux not found. Install it manually: sudo apt install tmux  OR  brew install tmux');
  }
}
ok('tmux available');

// ── 3. .env ──────────────────────────────────────────────────────────────────
step('Setting up .env');
if (!existsSync(resolve(ROOT, '.env'))) {
  if (!existsSync(resolve(ROOT, '.env.example'))) fail('.env.example not found — repo may be incomplete');
  copyFileSync(resolve(ROOT, '.env.example'), resolve(ROOT, '.env'));
  ok('.env created from .env.example (default password: nexus123)');
} else {
  ok('.env already exists — skipping');
}

// ── 4. Backend deps ──────────────────────────────────────────────────────────
step('Installing backend dependencies');
const r = run('npm install');
if (r.status !== 0) fail('npm install failed');
ok('Backend dependencies installed');

// ── 5. Frontend build ────────────────────────────────────────────────────────
step('Building frontend');
const fe = run('npm install && npm run build', { cwd: resolve(ROOT, 'frontend') });
if (fe.status !== 0) fail('Frontend build failed — check frontend/node_modules or run: cd frontend && npm install && npm run build');
ok('Frontend built');

// ── 6. PM2 ───────────────────────────────────────────────────────────────────
step('Checking PM2');
if (!check('pm2 --version')) {
  console.log('PM2 not found — installing globally...');
  const pm2install = run('npm install -g pm2');
  if (pm2install.status !== 0) fail('Failed to install PM2 globally. Try: sudo npm install -g pm2');
}
ok('PM2 available');

// ── 7. ecosystem.config.cjs ──────────────────────────────────────────────────
step('Writing ecosystem.config.cjs');
const ecosystemContent = `module.exports = {
  apps: [{
    name: 'nexus',
    script: './server.js',
    cwd: ${JSON.stringify(ROOT)},
    instances: 1,
    exec_mode: 'fork',
    env: {
      NODE_ENV: 'production'
    },
    error_file: './logs/nexus-error.log',
    out_file: './logs/nexus-out.log',
    log_file: './logs/nexus-combined.log',
    time: true
  }]
};
`;
writeFileSync(resolve(ROOT, 'ecosystem.config.cjs'), ecosystemContent);
run('mkdir -p logs');
ok(`ecosystem.config.cjs written with cwd: ${ROOT}`);

// ── 8. Start with PM2 ────────────────────────────────────────────────────────
step('Starting Nexus with PM2');
run('pm2 delete nexus 2>/dev/null; true');
const start = run('pm2 start ecosystem.config.cjs');
if (start.status !== 0) fail('PM2 start failed — check logs: pm2 logs nexus');
run('pm2 save');
ok('Nexus started and saved');

// ── 9. tmux session ──────────────────────────────────────────────────────────
step('Ensuring tmux session "main" exists');
if (!check('tmux has-session -t main 2>/dev/null')) {
  run('tmux new-session -d -s main');
  ok('tmux session "main" created');
} else {
  ok('tmux session "main" already exists');
}

// ── Done ─────────────────────────────────────────────────────────────────────
console.log(`
\x1b[32m
╔══════════════════════════════════════════╗
║  Nexus setup complete!
║
║  URL:      http://localhost:59000
║  Password: nexus123  (change in .env)
║
║  pm2 status    — check process
║  pm2 logs nexus — view logs
╚══════════════════════════════════════════╝
\x1b[0m`);
