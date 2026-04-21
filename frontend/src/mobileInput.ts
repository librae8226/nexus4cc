/**
 * mobileInput.ts — Pure-function key mapping for the mobile hidden input.
 *
 * Extracted from Terminal.tsx handleKeyDown to be testable without React/DOM.
 *
 * DESIGN RATIONALE (the CIME bug fix):
 *   On iOS, compositionstart fires AFTER the first keydown for a printable char.
 *   If handleKeyDown intercepts that keydown and calls sendToWs('n'), the letter
 *   leaks before the IME composition begins. Then compositionend sends the final
 *   Han character, producing "n你" in the terminal.
 *
 *   Fix: mapSpecialKey returns null for printable characters. handleKeyDown only
 *   acts on special keys and Ctrl combos. Printable chars fall through to the
 *   browser's default behavior, which populates input.value and fires onChange
 *   (handleInputChange). During composition, onChange is guarded by isComposingRef.
 *   After composition, compositionend sends the final text.
 *
 *   For non-CJK input (no composition), onChange fires once with the typed char,
 *   and handleInputChange sends it — same end result, no double-send.
 */

export type KeyMapping = string | null

/**
 * Determine whether handleInputChange should SKIP sending text to the terminal.
 *
 * iOS Safari can fire input/change events BEFORE compositionstart, or interleave
 * them unpredictably. The old single-guard (isComposingRef only) leaked interim
 * latin characters (e.g. typing "你" produced "n你").
 *
 * This function checks THREE independent signals; if ANY is true, we skip:
 *   1. nativeEvent.isComposing — set by the browser during composition
 *   2. inputType contains 'Composition' — covers insertCompositionText,
 *      insertFromComposition, deleteCompositionText
 *   3. refFlag (isComposingRef.current) — our own compositionstart/end flag
 */
export function shouldSkipInput(opts: {
  isComposing?: boolean
  inputType?: string
  refFlag: boolean
}): boolean {
  if (opts.isComposing === true) return true
  if (opts.inputType && opts.inputType.includes('Composition')) return true
  if (opts.refFlag) return true
  return false
}

/**
 * Map a keyboard event's key to a terminal escape sequence, or return null
 * if the key should NOT be intercepted (printable chars, Unidentified, etc.).
 *
 * @param eKey    - event.key
 * @param ctrlKey - event.ctrlKey
 * @returns terminal sequence string, or null to skip interception
 */
export function mapSpecialKey(
  eKey: string,
  ctrlKey: boolean,
): KeyMapping {
  // Special keys — always map
  if (eKey === 'Enter') return '\r'
  if (eKey === 'Backspace') return '\x7f'
  if (eKey === 'Tab') return '\t'
  if (eKey === 'Escape') return '\x1b'
  if (eKey === 'Delete') return '\x1b[3~'
  if (eKey === 'ArrowUp') return '\x1b[A'
  if (eKey === 'ArrowDown') return '\x1b[B'
  if (eKey === 'ArrowRight') return '\x1b[C'
  if (eKey === 'ArrowLeft') return '\x1b[D'
  if (eKey === 'Home') return '\x1b[H'
  if (eKey === 'End') return '\x1b[F'
  if (eKey === 'PageUp') return '\x1b[5~'
  if (eKey === 'PageDown') return '\x1b[6~'

  // Ctrl combos — map single chars (Ctrl+A → 0x01, etc.)
  if (ctrlKey && eKey.length === 1) {
    return String.fromCharCode(eKey.toLowerCase().charCodeAt(0) - 96)
  }

  // Printable chars, Unidentified, modifier+char combos — do NOT intercept.
  // Let them flow to onChange → handleInputChange (guarded by isComposingRef).
  return null
}
