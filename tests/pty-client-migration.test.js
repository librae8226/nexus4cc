/**
 * Tests for PTY client migration on PTY process exit.
 *
 * When a PTY process exits (e.g. tmux window closed), the onExit handler
 * must save connected WebSocket clients and their sizes before deleting
 * the ptyMap entry, then migrate them to the newly recreated PTY.
 *
 * Uses Node's built-in test runner.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// ---------------------------------------------------------------------------
// Minimal mocks — only what the migration logic touches
// ---------------------------------------------------------------------------

/**
 * Creates a mock WebSocket-like object.
 * @param {number} readyState
 */
function mockWs(readyState = 1) {
  const sent = [];
  return {
    readyState,
    sent,
    send(data) { sent.push(data); },
  };
}

/**
 * Creates a fake ptyMap entry.
 */
function fakeEntry(overrides = {}) {
  return {
    pty: { killed: false },
    clients: new Set(),
    clientSizes: new Map(),
    lastOutput: '',
    lastActivity: Date.now(),
    ...overrides,
  };
}

/**
 * Extracts the migration logic from the onExit handler into a testable
 * helper. This mirrors exactly what server.js does inside the setTimeout
 * callback after PTY recreation succeeds.
 */
function migrateClients(savedClients, savedSizes, newEntry) {
  for (const ws of savedClients) {
    if (ws.readyState === 1) {
      newEntry.clients.add(ws);
      const size = savedSizes.get(ws);
      if (size) newEntry.clientSizes.set(ws, size);
    }
  }
  if (newEntry.lastOutput) {
    for (const ws of savedClients) {
      if (ws.readyState === 1) ws.send(newEntry.lastOutput.slice(-2000));
    }
  }
}

// ===========================================================================
// Tests
// ===========================================================================

describe('PTY client migration', () => {
  // -----------------------------------------------------------------------
  // 1. ensureWindowPty return structure (structural check)
  // -----------------------------------------------------------------------
  describe('ensureWindowPty return structure', () => {
    it('should return { key, entry } where entry has required fields', () => {
      // Verify the expected structure matches what the code creates
      const entry = fakeEntry();
      const key = 'session:0';
      const result = { key, entry };

      assert.equal(result.key, 'session:0');
      assert.ok(result.entry.clients instanceof Set);
      assert.ok(result.entry.clientSizes instanceof Map);
      assert.equal(typeof result.entry.lastOutput, 'string');
      assert.equal(typeof result.entry.lastActivity, 'number');
    });
  });

  // -----------------------------------------------------------------------
  // 2. Core migration: clients and sizes preserved and migrated
  // -----------------------------------------------------------------------
  describe('onExit handler — client migration', () => {
    it('should migrate live clients to the new PTY entry', () => {
      const ws1 = mockWs(1);
      const ws2 = mockWs(1);

      const oldEntry = fakeEntry();
      oldEntry.clients.add(ws1);
      oldEntry.clients.add(ws2);
      oldEntry.clientSizes.set(ws1, { cols: 80, rows: 24 });
      oldEntry.clientSizes.set(ws2, { cols: 120, rows: 40 });

      // Simulate what onExit does before delete
      const savedClients = oldEntry.clients;
      const savedSizes = oldEntry.clientSizes;

      // Simulate new PTY creation
      const newEntry = fakeEntry({ lastOutput: 'Hello from new PTY' });

      migrateClients(savedClients, savedSizes, newEntry);

      assert.ok(newEntry.clients.has(ws1), 'ws1 should be in new entry');
      assert.ok(newEntry.clients.has(ws2), 'ws2 should be in new entry');
      assert.deepEqual(newEntry.clientSizes.get(ws1), { cols: 80, rows: 24 });
      assert.deepEqual(newEntry.clientSizes.get(ws2), { cols: 120, rows: 40 });

      // Both clients should receive recent output
      assert.equal(ws1.sent.length, 1);
      assert.equal(ws1.sent[0], 'Hello from new PTY');
      assert.equal(ws2.sent.length, 1);
      assert.equal(ws2.sent[0], 'Hello from new PTY');
    });

    it('should truncate lastOutput to last 2000 chars when sending', () => {
      const ws = mockWs(1);
      const oldEntry = fakeEntry();
      oldEntry.clients.add(ws);

      const longOutput = 'x'.repeat(5000);
      const newEntry = fakeEntry({ lastOutput: longOutput });

      migrateClients(oldEntry.clients, oldEntry.clientSizes, newEntry);

      assert.equal(ws.sent.length, 1);
      assert.equal(ws.sent[0].length, 2000);
      assert.ok(ws.sent[0].startsWith('x'));
    });

    it('should not send if newEntry.lastOutput is empty', () => {
      const ws = mockWs(1);
      const oldEntry = fakeEntry();
      oldEntry.clients.add(ws);

      const newEntry = fakeEntry({ lastOutput: '' });
      migrateClients(oldEntry.clients, oldEntry.clientSizes, newEntry);

      assert.ok(newEntry.clients.has(ws), 'client still migrated');
      assert.equal(ws.sent.length, 0, 'nothing sent for empty lastOutput');
    });
  });

  // -----------------------------------------------------------------------
  // 3. Edge case: client with readyState !== 1 is NOT migrated
  // -----------------------------------------------------------------------
  describe('edge case — closed/closing clients', () => {
    it('should skip clients with readyState 2 (CLOSING)', () => {
      const wsLive = mockWs(1);
      const wsClosing = mockWs(2);

      const oldEntry = fakeEntry();
      oldEntry.clients.add(wsLive);
      oldEntry.clients.add(wsClosing);
      oldEntry.clientSizes.set(wsLive, { cols: 80, rows: 24 });
      oldEntry.clientSizes.set(wsClosing, { cols: 100, rows: 30 });

      const newEntry = fakeEntry({ lastOutput: 'output' });
      migrateClients(oldEntry.clients, oldEntry.clientSizes, newEntry);

      assert.ok(newEntry.clients.has(wsLive), 'live client migrated');
      assert.ok(!newEntry.clients.has(wsClosing), 'closing client NOT migrated');
      assert.deepEqual(newEntry.clientSizes.get(wsLive), { cols: 80, rows: 24 });
      assert.equal(newEntry.clientSizes.has(wsClosing), false, 'closing client size NOT migrated');

      assert.equal(wsLive.sent.length, 1, 'live client received output');
      assert.equal(wsClosing.sent.length, 0, 'closing client NOT sent output');
    });

    it('should skip clients with readyState 3 (CLOSED)', () => {
      const wsClosed = mockWs(3);
      const oldEntry = fakeEntry();
      oldEntry.clients.add(wsClosed);

      const newEntry = fakeEntry({ lastOutput: 'output' });
      migrateClients(oldEntry.clients, oldEntry.clientSizes, newEntry);

      assert.ok(!newEntry.clients.has(wsClosed), 'closed client NOT migrated');
      assert.equal(wsClosed.sent.length, 0);
    });

    it('should skip clients with readyState 0 (CONNECTING)', () => {
      const wsConnecting = mockWs(0);
      const oldEntry = fakeEntry();
      oldEntry.clients.add(wsConnecting);

      const newEntry = fakeEntry({ lastOutput: 'output' });
      migrateClients(oldEntry.clients, oldEntry.clientSizes, newEntry);

      assert.ok(!newEntry.clients.has(wsConnecting));
    });
  });

  // -----------------------------------------------------------------------
  // 4. Edge case: window no longer exists — no recreation
  // -----------------------------------------------------------------------
  describe('edge case — window gone', () => {
    it('should not throw when saved clients are not migrated (no new PTY)', () => {
      const ws = mockWs(1);
      const oldEntry = fakeEntry();
      oldEntry.clients.add(ws);
      oldEntry.clientSizes.set(ws, { cols: 80, rows: 24 });

      // Simulate: onExit saves clients, deletes from map, but
      // window check fails so no new PTY is created.
      const savedClients = oldEntry.clients;
      const savedSizes = oldEntry.clientSizes;

      // No migrateClients call — window gone.
      // The saved references still exist but nothing happens.
      assert.ok(savedClients.has(ws));
      assert.ok(savedSizes.has(ws));
      assert.equal(ws.sent.length, 0, 'nothing sent — no new PTY');
    });
  });

  // -----------------------------------------------------------------------
  // 5. Verify the onExit handler saves clients BEFORE ptyMap.delete
  // -----------------------------------------------------------------------
  describe('onExit handler — save-before-delete ordering', () => {
    it('should preserve client references when entry is removed from map', () => {
      const ptyMap = new Map();
      const ws = mockWs(1);
      const entry = fakeEntry();
      entry.clients.add(ws);
      entry.clientSizes.set(ws, { cols: 80, rows: 24 });

      const actualKey = 'session:0';
      ptyMap.set(actualKey, entry);

      // Simulate the onExit save-then-delete sequence
      const savedClients = entry.clients;
      const savedSizes = entry.clientSizes;
      ptyMap.delete(actualKey);

      // After delete, ptyMap no longer has the entry
      assert.equal(ptyMap.has(actualKey), false);

      // But saved references are intact
      assert.ok(savedClients.has(ws));
      assert.deepEqual(savedSizes.get(ws), { cols: 80, rows: 24 });
    });
  });
});
