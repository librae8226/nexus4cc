// src/middleware/validators.js
// Lightweight request validators using pure JavaScript
// Exports:
//  - validateTmuxSessionName(name)
//  - validateWorkspacePath(path, workspaceRoot)
//  - validateFileSize(size, maxBytes)
//  - validateFileName(name)
//  - validatePrompt(text, maxLength)

import path from 'path';

export function validateTmuxSessionName(name) {
  if (typeof name !== 'string' || !name.trim()) {
    return { valid: false, sanitized: '', error: 'name is required' };
  }
  // Replace whitespace with underscore, remove disallowed chars
  const trimmed = name.trim();
  const sanitized = trimmed.replace(/\s+/g, '_').replace(/[^a-zA-Z0-9._-]/g, '_');
  const valid = sanitized.length > 0 && /^[a-zA-Z0-9._-]+$/.test(sanitized);
  return {
    valid,
    sanitized,
    error: valid ? '' : 'invalid characters in tmux session name',
  };
}

export function validateWorkspacePath(inputPath, workspaceRoot) {
  if (typeof inputPath !== 'string' || !workspaceRoot) {
    return { valid: false, sanitized: '', error: 'invalid arguments' };
  }
  const resolved = path.resolve(workspaceRoot, inputPath);
  const rootResolved = path.resolve(workspaceRoot);
  const isInside = resolved === rootResolved || resolved.startsWith(rootResolved + path.sep);
  if (!isInside) {
    return { valid: false, sanitized: '', error: 'path escapes workspace' };
  }
  return { valid: true, sanitized: resolved, error: '' };
}

export function validateFileSize(size, maxBytes) {
  const valid = typeof size === 'number' && size >= 0 && size <= maxBytes;
  return { valid, error: valid ? '' : 'file size exceeds maximum' };
}

export function validateFileName(name) {
  if (typeof name !== 'string' || !name) {
    return { valid: false, sanitized: '', error: 'invalid filename' };
  }
  // Remove directory separators and dangerous chars
  const sanitized = name.replace(/[\/?<>:*|"\\]+/g, '_').replace(/[^a-zA-Z0-9._-]/g, '_');
  const valid = sanitized.length > 0 && !sanitized.includes('..');
  return { valid, sanitized, error: valid ? '' : 'invalid filename' };
}

export function validatePrompt(text, maxLength) {
  if (typeof text !== 'string') {
    return { valid: false, sanitized: '', error: 'invalid prompt' };
  }
  const sanitized = text.trim();
  const valid = sanitized.length > 0 && sanitized.length <= maxLength;
  return {
    valid,
    sanitized,
    error: valid ? '' : `prompt must be between 1 and ${maxLength} characters`,
  };
}

export default {
  validateTmuxSessionName,
  validateWorkspacePath,
  validateFileSize,
  validateFileName,
  validatePrompt,
};
