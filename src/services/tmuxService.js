import { execFile, execFileSync } from 'child_process';
import { promisify } from 'util';

// Promisified async wrapper for execFile
const execFileP = promisify(execFile);

// Lightweight, validated TMUX session name pattern
const SESSION_NAME_REGEX = /^[A-Za-z0-9._~-]+$/;

/** Utility: validate a tmux session name */
function validateSessionName(name) {
  if (typeof name !== 'string' || !SESSION_NAME_REGEX.test(name)) {
    throw new Error(`Invalid tmux session name: ${name}`);
  }
}

/** Utility: run tmux with async API using execFile
 *  Returns stdout as string
 */
async function runTmuxAsync(args) {
  const result = await execFileP('tmux', args, { encoding: 'utf8' });
  // promisified execFile may resolve to [stdout, stderr] or an object depending on Node version
  if (Array.isArray(result)) {
    return (result[0] != null) ? String(result[0]) : '';
  }
  if (result && typeof result === 'object') {
    // some Node versions return { stdout, stderr }
    if (typeof result.stdout === 'string') return result.stdout;
  }
  // fallback
  return String(result);
}

/** Utility: run tmux with sync API using execFileSync
 *  Returns stdout as string
 */
function runTmuxSync(args) {
  const stdout = execFileSync('tmux', args, { encoding: 'utf8' });
  return stdout.toString();
}

/** Build a safe proxy export string from a map of environment vars. */
export function buildProxyCommand(proxyVars) {
  if (!proxyVars) return '';
  const parts = [];
  for (const [key, value] of Object.entries(proxyVars)) {
    if (value != null && value !== '') {
      const safeVal = String(value).replace(/"/g, '\\"');
      parts.push(`export ${key}="${safeVal}"`);
    }
  }
  return parts.length ? parts.join(' && ') : '';
}

/** Create a shell command string to initialize claude/bash sessions safely.
 * shellType: e.g. 'bash' or 'zsh'
 * profile: optional profile file to source
 * cwd: working directory to switch to
 * CLAUDE_PROXY: optional proxy string to export as CLAUDE_PROXY
 * runScriptPath: optional script to execute in the session
 */
export function createShellCmd(shellType, profile, cwd, CLAUDE_PROXY, runScriptPath) {
  const parts = [];
  if (CLAUDE_PROXY) {
    // CLAUDE_PROXY assumed to be a string value
    const safeVal = String(CLAUDE_PROXY).replace(/"/g, '\\"');
    parts.push(`export CLAUDE_PROXY="${safeVal}"`);
  }
  if (cwd) {
    parts.push(`cd "${cwd.replace(/"/g, '\\"')}"`);
  }
  if (profile) {
    parts.push(`source "${profile.replace(/"/g, '\\"')}"`);
  }
  if (runScriptPath) {
    parts.push(`"${runScriptPath}"`);
  }
  const innerCmd = parts.filter(p => p && p.length > 0).join(' && ');
  // Escape single quotes inside the inner command
  const escaped = innerCmd.replace(/'/g, "'\\''");
  // Build a tmux-friendly shell wrapper: shellType -lc '<command>'
  const wrapper = `${shellType} -lc '${escaped}'`;
  return wrapper;
}

/** Core adapter for tmux service. */
export class TmuxService {
  constructor() {
    // no-op for now; could host shared state if needed
  }

  // PRIVATE helpers
  _validateSessionName(name) {
    validateSessionName(name);
  }

  // 1) listWindows(session) — returns array of { index, name, active, cwd }
  async listWindows(session) {
    this._validateSessionName(session);
    const args = ['list-windows', '-t', session, '-F', '#{window_index}::#{window_name}::#{?window_active,1,0}::#{pane_current_path}'];
    const stdout = await runTmuxAsync(args);
    const lines = stdout.trim().length ? stdout.trim().split(/\r?\n/) : [];
    return lines.map(line => {
      const [index, name, activeFlag, cwd] = line.split('::');
      return {
        index: Number(index),
        name,
        active: activeFlag === '1',
        cwd,
      };
    });
  }

  // 2) listSessions() — returns array of { name, windows, attached }
  async listSessions() {
    const args = ['list-sessions', '-F', '#{session_name}::#{session_windows}::#{session_attached}'];
    const stdout = await runTmuxAsync(args);
    const lines = stdout.trim().length ? stdout.trim().split(/\r?\n/) : [];
    return lines.map(line => {
      const [name, windows, attachedFlag] = line.split('::');
      return {
        name,
        windows: Number(windows),
        attached: attachedFlag === '1',
      };
    });
  }

  // 3) createWindow(session, cwd, name, shellCmd)
  async createWindow(session, cwd, name, shellCmd) {
    this._validateSessionName(session);
    if (!cwd || !name) throw new Error('createWindow requirescwd and name');
    const args = ['new-window', '-t', session, '-c', cwd, '-n', name];
    if (typeof shellCmd === 'string' && shellCmd.length > 0) {
      args.push(shellCmd);
    }
    await runTmuxAsync(args);
    return true;
  }

  // 4) createSession(sessionName, cwd, initialWindowName, shellCmd)
  async createSession(sessionName, cwd, initialWindowName, shellCmd) {
    this._validateSessionName(sessionName);
    if (!cwd || !initialWindowName) throw new Error('createSession requires cwd and initialWindowName');
    const args = ['new-session', '-s', sessionName, '-c', cwd, '-n', initialWindowName];
    if (typeof shellCmd === 'string' && shellCmd.length > 0) {
      args.push(shellCmd);
    }
    await runTmuxAsync(args);
    return true;
  }

  // 5) killWindow(session, windowIndex)
  async killWindow(session, windowIndex) {
    this._validateSessionName(session);
    const target = `${session}:${windowIndex}`;
    await runTmuxAsync(['kill-window', '-t', target]);
    return true;
  }

  // 6) killSession(sessionName)
  async killSession(sessionName) {
    this._validateSessionName(sessionName);
    await runTmuxAsync(['kill-session', '-t', sessionName]);
    return true;
  }

  // 7) renameWindow(session, windowIndex, newName)
  async renameWindow(session, windowIndex, newName) {
    this._validateSessionName(session);
    if (!newName) throw new Error('renameWindow requires newName');
    const target = `${session}:${windowIndex}`;
    await runTmuxAsync(['rename-window', '-t', target, newName]);
    return true;
  }

  // 8) renameSession(oldName, newName)
  async renameSession(oldName, newName) {
    this._validateSessionName(oldName);
    if (!newName) throw new Error('renameSession requires newName');
    await runTmuxAsync(['rename-session', '-t', oldName, '-n', newName]);
    return true;
  }

  // 9) selectWindow(session, windowIndex)
  async selectWindow(session, windowIndex) {
    this._validateSessionName(session);
    const target = `${session}:${windowIndex}`;
    await runTmuxAsync(['select-window', '-t', target]);
    return true;
  }

  // 10) setEnv(session, key, value)
  async setEnv(session, key, value) {
    this._validateSessionName(session);
    if (!key) throw new Error('setEnv requires key');
    await runTmuxAsync(['set-environment', '-t', session, key, value]);
    return true;
  }

  // 11) getEnv(session, key)
  async getEnv(session, key) {
    this._validateSessionName(session);
    if (!key) throw new Error('getEnv requires key');
    const stdout = await runTmuxAsync(['show-environment', '-t', session]);
    // show-environment prints lines like: key="value" or key=value
    const lines = stdout.split(/\r?\n/).filter(l => l.length);
    for (const line of lines) {
      // Split at first '='
      const idx = line.indexOf('=');
      if (idx > 0) {
        const k = line.substring(0, idx);
        const v = line.substring(idx + 1).replace(/^"|"$/g, '');
        if (k === key) return v;
      }
    }
    return undefined;
  }

  // 12) capturePane(session, windowIndex, lines)
  async capturePane(session, windowIndex, lines) {
    this._validateSessionName(session);
    const target = `${session}:${windowIndex}`;
    const args = ['capture-pane', '-t', target, '-p'];
    if (typeof lines === 'number' && lines > 0) {
      args.push('-S', `-${lines}`);
    }
    const stdout = await runTmuxAsync(args);
    return stdout;
  }

  // 13) hasSession(sessionName)
  async hasSession(sessionName) {
    this._validateSessionName(sessionName);
    try {
      await runTmuxAsync(['has-session', '-t', sessionName]);
      return true;
    } catch {
      return false;
    }
  }

  // 14) ensureSession(sessionName, cwd, initialWindowName, shellCmd)
  async ensureSession(sessionName, cwd, initialWindowName, shellCmd) {
    this._validateSessionName(sessionName);
    const exists = await this.hasSession(sessionName);
    if (exists) return true;
    if (!cwd || !initialWindowName) throw new Error('ensureSession requires cwd and initialWindowName when creating');
    await this.createSession(sessionName, cwd, initialWindowName, shellCmd);
    return true;
  }

  // 15) getWindowCount(session)
  async getWindowCount(session) {
    this._validateSessionName(session);
    const stdout = await runTmuxAsync(['list-windows', '-t', session, '-F', '#{window_index}']);
    const lines = stdout.trim().length ? stdout.trim().split(/\r?\n/) : [];
    // If there are no windows, tmux prints nothing; treat as 0
    // When there are windows, each line contains a number index.
    return lines.length;
  }
}

export default TmuxService;
