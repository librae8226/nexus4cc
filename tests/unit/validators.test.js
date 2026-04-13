import { validateTmuxSessionName, validateWorkspacePath, validateFileSize, validateFileName, validatePrompt } from '../../src/middleware/validators.js';

describe('validators', () => {
  describe('validateTmuxSessionName', () => {
    it('accepts valid names', () => {
      const r1 = validateTmuxSessionName('tmux-1');
      expect(r1.valid).toBe(true);
      const r2 = validateTmuxSessionName('my_session');
      expect(r2.valid).toBe(true);
    });

    it('rejects names with spaces', () => {
      const r = validateTmuxSessionName('bad name');
      expect(r.valid).toBe(false);
    });

    it('rejects names with shell metacharacters', () => {
      const r1 = validateTmuxSessionName('test$var');
      expect(r1.valid).toBe(false);
      const r2 = validateTmuxSessionName('test;cmd');
      expect(r2.valid).toBe(false);
    });
  });

  describe('validateWorkspacePath', () => {
    it('accepts paths within workspace', () => {
      const r = validateWorkspacePath('/workspace/project/src', '/workspace');
      expect(r.valid).toBe(true);
    });

    it('rejects path traversal', () => {
      const r = validateWorkspacePath('/workspace/../../../etc', '/workspace');
      expect(r.valid).toBe(false);
    });
  });

  describe('validateFileSize', () => {
    it('accepts files within limit', () => {
      const r = validateFileSize(1024, 50 * 1024 * 1024);
      expect(r.valid).toBe(true);
    });

    it('rejects oversized files', () => {
      const r = validateFileSize(100 * 1024 * 1024, 50 * 1024 * 1024);
      expect(r.valid).toBe(false);
    });
  });

  describe('validateFileName', () => {
    it('sanitizes dangerous chars', () => {
      const r = validateFileName('file<>:"|?*\\/.txt');
      expect(r.valid).toBe(true);
      expect(r.sanitized).not.toMatch(/[<>:"|?*\\/\x00-\x1f]/);
    });

    it('rejects empty names', () => {
      const r = validateFileName('');
      expect(r.valid).toBe(false);
    });
  });

  describe('validatePrompt', () => {
    it('rejects empty prompts', () => {
      const r = validatePrompt('', 1000);
      expect(r.valid).toBe(false);
    });

    it('rejects overly long prompts', () => {
      const r = validatePrompt('x'.repeat(5001), 5000);
      expect(r.valid).toBe(false);
    });

    it('accepts valid prompts', () => {
      const r = validatePrompt('do something', 1000);
      expect(r.valid).toBe(true);
    });
  });
});
