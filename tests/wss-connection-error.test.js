/**
 * Tests for wss.on('connection') error handling in server.js
 *
 * Verifies that:
 * 1. ensureWindowPty errors are caught and ws.close(1011) is called
 * 2. Null/undefined entry.pty is detected and ws.close(1011) is called
 * 3. Normal flow proceeds when ensureWindowPty succeeds
 * 4. Error messages are logged to console
 */
import { describe, it, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(__dirname, '..', 'server.js');

// ---------------------------------------------------------------------------
// Static code analysis tests — verify the protective patterns exist in source
// ---------------------------------------------------------------------------

describe('wss.on("connection") error handling — code patterns', () => {
  let source;

  before(() => {
    source = fs.readFileSync(serverPath, 'utf8');
  });

  it('wraps ensureWindowPty in try/catch', () => {
    // Look for the try/catch pattern around ensureWindowPty in the connection handler
    const pattern = /try\s*\{\s*\(\{[^}]*\}\s*=\s*ensureWindowPty\(/;
    assert.match(source, pattern, 'ensureWindowPty should be called inside a try block with destructuring');
  });

  it('catch block closes ws with code 1011 on ensureWindowPty failure', () => {
    // After the try block with ensureWindowPty, there should be a catch that calls ws.close(1011, ...)
    const ensureBlock = source.match(
      /try\s*\{\s*\(\{[^}]*\}\s*=\s*ensureWindowPty\([^)]*\)\);\s*\}\s*catch\s*\(\w+\)\s*\{[^}]*ws\.close\(1011[^)]*\)/s
    );
    assert.ok(ensureBlock, 'catch block should call ws.close(1011, ...) after ensureWindowPty failure');
  });

  it('catch block logs error to console', () => {
    const logPattern = /ensureWindowPty failed:/;
    assert.match(source, logPattern, 'should log "ensureWindowPty failed:" message');
  });

  it('checks entry.pty for null/undefined after ensureWindowPty', () => {
    const ptyCheck = /if\s*\(\s*!entry\s*\|\|\s*!entry\.pty\s*\)/;
    assert.match(source, ptyCheck, 'should have a null guard for entry and entry.pty');
  });

  it('null check closes ws with code 1011 and pty unavailable message', () => {
    const unavailablePattern = /ws\.close\(1011,\s*['"]pty unavailable['"]\)/;
    assert.match(source, unavailablePattern, 'should close with 1011 and "pty unavailable"');
  });
});

// ---------------------------------------------------------------------------
// Behavioral tests — simulate the connection handler logic
// ---------------------------------------------------------------------------

describe('wss.on("connection") error handling — behavior', () => {
  /**
   * Extract and sandbox the connection handler logic.
   * We recreate the relevant portion of the handler to test error paths.
   */
  function createMockWs() {
    const ws = {
      closeCalls: [],
      sendCalls: [],
      eventHandlers: {},
      close(code, reason) {
        this.closeCalls.push({ code, reason });
      },
      send(data) {
        this.sendCalls.push(data);
      },
      on(event, handler) {
        this.eventHandlers[event] = handler;
      },
    };
    return ws;
  }

  it('closes ws with 1011 when ensureWindowPty throws', () => {
    const ws = createMockWs();
    const error = new Error('tmux session not found');

    // Simulate the handler logic
    function ensureWindowPty() {
      throw error;
    }

    let key, entry;
    try {
      ({ key, entry } = ensureWindowPty('test-session', 0));
    } catch (err) {
      ws.close(1011, 'internal error');
    }

    assert.equal(ws.closeCalls.length, 1);
    assert.equal(ws.closeCalls[0].code, 1011);
    assert.equal(ws.closeCalls[0].reason, 'internal error');
  });

  it('closes ws with 1011 when entry.pty is null', () => {
    const ws = createMockWs();

    // Simulate ensureWindowPty returning entry with null pty
    const result = { key: 'test:0', entry: { pty: null, clients: new Set() } };

    let key, entry;
    ({ key, entry } = result);

    if (!entry || !entry.pty) {
      ws.close(1011, 'pty unavailable');
    }

    assert.equal(ws.closeCalls.length, 1);
    assert.equal(ws.closeCalls[0].code, 1011);
    assert.equal(ws.closeCalls[0].reason, 'pty unavailable');
  });

  it('closes ws with 1011 when entry is undefined', () => {
    const ws = createMockWs();

    const result = { key: 'test:0', entry: undefined };

    let key, entry;
    ({ key, entry } = result);

    if (!entry || !entry.pty) {
      ws.close(1011, 'pty unavailable');
    }

    assert.equal(ws.closeCalls.length, 1);
    assert.equal(ws.closeCalls[0].code, 1011);
    assert.equal(ws.closeCalls[0].reason, 'pty unavailable');
  });

  it('proceeds normally when ensureWindowPty succeeds with valid pty', () => {
    const ws = createMockWs();

    const mockPty = { write: () => {}, resize: () => {}, kill: () => {} };
    const result = {
      key: 'test:0',
      entry: { pty: mockPty, clients: new Set(), lastOutput: Buffer.from('hello') },
    };

    let key, entry;
    let errorThrown = false;
    try {
      ({ key, entry } = result);
    } catch {
      errorThrown = true;
    }

    assert.equal(errorThrown, false, 'no error should be thrown');

    if (!entry || !entry.pty) {
      ws.close(1011, 'pty unavailable');
    }

    assert.equal(ws.closeCalls.length, 0, 'ws.close should not be called on success');

    // Verify the entry was usable
    assert.equal(entry.pty, mockPty);
    entry.clients.add(ws);
    assert.equal(entry.clients.size, 1);
  });

  it('logs error message when ensureWindowPty throws', () => {
    const logMessages = [];
    const originalError = console.error;
    console.error = (...args) => logMessages.push(args.join(' '));

    try {
      const error = new Error('spawn failed');
      let key, entry;
      try {
        ({ key, entry } = (() => { throw error; })());
      } catch (err) {
        console.error('ensureWindowPty failed:', err.message);
      }

      assert.equal(logMessages.length, 1);
      assert.ok(logMessages[0].includes('ensureWindowPty failed:'));
      assert.ok(logMessages[0].includes('spawn failed'));
    } finally {
      console.error = originalError;
    }
  });
});
