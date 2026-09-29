/**
 * Tests for mobileInput.ts — pure-function key mapping for the mobile hidden input.
 *
 * Run from project root:  npx tsx frontend/mobileInput.test.ts
 *   (or inside frontend/:  npx tsx mobileInput.test.ts)
 */
import assert from 'node:assert/strict'
import { mapSpecialKey, shouldSkipInput, canFlushComposition } from './src/mobileInput'

let passed = 0
let failed = 0

function test(name: string, fn: () => void) {
  try {
    fn()
    passed++
    console.log(`  PASS: ${name}`)
  } catch (err: unknown) {
    failed++
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`  FAIL: ${name}\n        ${msg}`)
  }
}

// --- Special keys should still be mapped ---

test('Enter maps to carriage return', () => {
  assert.equal(mapSpecialKey('Enter', false), '\r')
})

test('Backspace maps to DEL', () => {
  assert.equal(mapSpecialKey('Backspace', false), '\x7f')
})

test('Tab maps to tab', () => {
  assert.equal(mapSpecialKey('Tab', false), '\t')
})

test('Escape maps to ESC', () => {
  assert.equal(mapSpecialKey('Escape', false), '\x1b')
})

test('Delete maps to VT220 delete', () => {
  assert.equal(mapSpecialKey('Delete', false), '\x1b[3~')
})

test('ArrowUp maps to CSI A', () => {
  assert.equal(mapSpecialKey('ArrowUp', false), '\x1b[A')
})

test('ArrowDown maps to CSI B', () => {
  assert.equal(mapSpecialKey('ArrowDown', false), '\x1b[B')
})

test('ArrowRight maps to CSI C', () => {
  assert.equal(mapSpecialKey('ArrowRight', false), '\x1b[C')
})

test('ArrowLeft maps to CSI D', () => {
  assert.equal(mapSpecialKey('ArrowLeft', false), '\x1b[D')
})

test('Home maps to CSI H', () => {
  assert.equal(mapSpecialKey('Home', false), '\x1b[H')
})

test('End maps to CSI F', () => {
  assert.equal(mapSpecialKey('End', false), '\x1b[F')
})

test('PageUp maps to CSI 5~', () => {
  assert.equal(mapSpecialKey('PageUp', false), '\x1b[5~')
})

test('PageDown maps to CSI 6~', () => {
  assert.equal(mapSpecialKey('PageDown', false), '\x1b[6~')
})

// --- Ctrl combos ---

test('Ctrl+c maps to ETX (0x03)', () => {
  assert.equal(mapSpecialKey('c', true), '\x03')
})

test('Ctrl+d maps to EOT (0x04)', () => {
  assert.equal(mapSpecialKey('d', true), '\x04')
})

// --- Printable chars: the root-cause fix ---
// Before the fix, handleKeyDown intercepted printable chars (e.g. 'n')
// and sent them via sendToWs BEFORE compositionstart could set the guard.
// After the fix, mapSpecialKey returns null for printable chars,
// so handleKeyDown skips them and they go through onChange instead.

test('printable letter "n" should NOT be mapped (returns null) - prevents CIME pre-letter bug', () => {
  assert.equal(mapSpecialKey('n', false), null)
})

test('printable letter "a" should NOT be mapped (returns null)', () => {
  assert.equal(mapSpecialKey('a', false), null)
})

test('printable digit "5" should NOT be mapped (returns null)', () => {
  assert.equal(mapSpecialKey('5', false), null)
})

test('printable punctuation "," should NOT be mapped (returns null)', () => {
  assert.equal(mapSpecialKey(',', false), null)
})

test('space should NOT be mapped (returns null)', () => {
  assert.equal(mapSpecialKey(' ', false), null)
})

test('uppercase "Z" should NOT be mapped (returns null)', () => {
  assert.equal(mapSpecialKey('Z', false), null)
})

// --- Unidentified (Android) should not map ---

test('Unidentified key should NOT be mapped', () => {
  assert.equal(mapSpecialKey('Unidentified', false), null)
})

// --- shouldSkipInput: composition guard for handleInputChange ---
//
// iOS Safari fires input/change BEFORE compositionstart (or interleaves them).
// handleInputChange must skip sending interim latin text during composition.
// shouldSkipInput encodes the multi-signal guard so it's testable as a pure fn.

test('shouldSkipInput: isComposing=true → skip', () => {
  assert.equal(shouldSkipInput({ isComposing: true, inputType: 'insertText', refFlag: false }), true)
})

test('shouldSkipInput: inputType contains "Composition" (insertCompositionText) → skip', () => {
  assert.equal(shouldSkipInput({ isComposing: false, inputType: 'insertCompositionText', refFlag: false }), true)
})

test('shouldSkipInput: inputType contains "Composition" (insertFromComposition) → skip', () => {
  assert.equal(shouldSkipInput({ isComposing: false, inputType: 'insertFromComposition', refFlag: false }), true)
})

test('shouldSkipInput: inputType contains "Composition" (deleteCompositionText) → skip', () => {
  assert.equal(shouldSkipInput({ isComposing: false, inputType: 'deleteCompositionText', refFlag: false }), true)
})

test('shouldSkipInput: refFlag=true → skip', () => {
  assert.equal(shouldSkipInput({ isComposing: false, inputType: 'insertText', refFlag: true }), true)
})

test('shouldSkipInput: plain insertText with no composition signals → do NOT skip', () => {
  assert.equal(shouldSkipInput({ isComposing: false, inputType: 'insertText', refFlag: false }), false)
})

test('shouldSkipInput: undefined inputType treated as non-composition → do NOT skip (no ref)', () => {
  assert.equal(shouldSkipInput({ isComposing: false, inputType: undefined, refFlag: false }), false)
})

test('shouldSkipInput: all three signals true → skip (triple guard)', () => {
  assert.equal(shouldSkipInput({ isComposing: true, inputType: 'insertCompositionText', refFlag: true }), true)
})

// --- canFlushComposition ---
//
// Regression guard for the xterm double-commit bug: a keydown during composition
// with a keyCode xterm does NOT ignore makes CompositionHelper flush the
// provisional composition text, which compositionend then sends again.
//
// Confirmed against live xterm 5.5.0 (Windows Chrome):
//   Enter (13) mid-composition -> ["RAW", "\r", "POLISHED"]   two different texts
//   letter (65) mid-composition -> ["RAW", "a", "POLISHED"]
//   pinyin 229s mid-composition -> ["CLEAN"]                  single send, correct

test('canFlushComposition: 229 (IME keystroke) → do NOT arm — keeps normal CJK typing single-send', () => {
  assert.equal(canFlushComposition(229), false)
})

test('canFlushComposition: 16/17/18 (Shift/Ctrl/Alt) → do NOT arm — xterm ignores these too', () => {
  assert.equal(canFlushComposition(16), false)
  assert.equal(canFlushComposition(17), false)
  assert.equal(canFlushComposition(18), false)
})

test('canFlushComposition: 13 (Enter) → arm — reproduces the duplicate provisional send', () => {
  assert.equal(canFlushComposition(13), true)
})

test('canFlushComposition: 65 (letter) → arm — any printable key flushes mid-composition', () => {
  assert.equal(canFlushComposition(65), true)
})

test('canFlushComposition: 0/undefined-ish keyCode → arm (xterm only spares 229 + modifiers)', () => {
  assert.equal(canFlushComposition(0), true)
})

// --- Summary ---
console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
