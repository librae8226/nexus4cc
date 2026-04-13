// Safe shell command execution utilities using execFile/spawn instead of shell interpolation
import { execFile, execFileSync, spawn } from 'child_process';

// Sanitize arbitrary strings to be used in tmux window/session names
export function sanitizeForTmuxName(str) {
  if (typeof str !== 'string') return '';
  // Allow alphanumeric and common safe chars, replace everything else with '-'
  return str.replace(/[^a-zA-Z0-9._-]/g, '-');
}

// Async execution of tmux commands with arguments supplied as an array
export function tmuxExec(args, options = {}) {
  if (!Array.isArray(args)) {
    throw new TypeError('tmuxExec: args must be an array of strings');
  }
  return new Promise((resolve, reject) => {
    execFile('tmux', args, options, (error, stdout, stderr) => {
      if (error) {
        (error).stdout = stdout;
        (error).stderr = stderr;
        return reject(error);
      }
      resolve({ stdout, stderr });
    });
  });
}

// Synchronous execution of tmux commands
export function tmuxExecSync(args, options = {}) {
  if (!Array.isArray(args)) {
    throw new TypeError('tmuxExecSync: args must be an array of strings');
  }
  return execFileSync('tmux', args, options);
}

// Spawn a tmux process (non-blocking, streaming IO)
export function tmuxSpawn(args, options = {}) {
  if (!Array.isArray(args)) {
    throw new TypeError('tmuxSpawn: args must be an array of strings');
  }
  return spawn('tmux', args, options);
}
