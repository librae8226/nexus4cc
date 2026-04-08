export interface KeyDef {
  id: string
  label: string
  seq: string
  desc: string
  action?: 'scrollToBottom' | 'pasteClipboard' | 'copyTerminal' | 'fit'
  category: 'nav' | 'edit' | 'control' | 'input' | 'ui'
}

export interface ToolbarConfig {
  pinned: string[]
  expanded: string[]
}

// Unified label conventions:
// - ^X for Ctrl+X
// - M-x for Alt+x
// - Single symbols for arrows (↑↓←→), Enter (↵), Tab (⇥), Backspace (⌫)
// - Special actions use icons (↓↓ 📋 ⟳)

export const ALL_KEYS: KeyDef[] = [
  // === Navigation (nav) ===
  { id: 'up',         label: '↑',     seq: '\x1b[A',   desc: 'toolbarKeys.prevHistory', category: 'nav' },
  { id: 'down',       label: '↓',     seq: '\x1b[B',   desc: 'toolbarKeys.nextHistory', category: 'nav' },
  { id: 'left',       label: '←',     seq: '\x1b[D',   desc: 'toolbarKeys.cursorLeft', category: 'nav' },
  { id: 'right',      label: '→',     seq: '\x1b[C',   desc: 'toolbarKeys.cursorRight', category: 'nav' },
  { id: 'ctrl-a',     label: '^A',    seq: '\x01',     desc: 'toolbarKeys.lineStart', category: 'nav' },
  { id: 'ctrl-e',     label: '^E',    seq: '\x05',     desc: 'toolbarKeys.lineEnd', category: 'nav' },
  { id: 'alt-b',      label: 'Mb',    seq: '\x1bb',    desc: 'toolbarKeys.wordBack', category: 'nav' },
  { id: 'alt-f',      label: 'Mf',    seq: '\x1bf',    desc: 'toolbarKeys.wordForward', category: 'nav' },

  // === Editing (edit) ===
  { id: 'backspace',  label: '⌫',    seq: '\x7f',     desc: 'toolbarKeys.backspace', category: 'edit' },
  { id: 'tab',        label: '⇥',     seq: '\t',       desc: 'toolbarKeys.acceptSuggestion', category: 'edit' },
  { id: 'ctrl-u',     label: '^U',    seq: '\x15',     desc: 'toolbarKeys.deleteLine', category: 'edit' },
  { id: 'ctrl-k',     label: '^K',    seq: '\x0b',     desc: 'toolbarKeys.deleteToEnd', category: 'edit' },
  { id: 'ctrl-y',     label: '^Y',    seq: '\x19',     desc: 'toolbarKeys.yank', category: 'edit' },
  { id: 'ctrl-d',     label: '^D',    seq: '\x04',     desc: 'toolbarKeys.exitEof', category: 'edit' },
  { id: 'ctrl-j',     label: '^J',    seq: '\x0a',     desc: 'toolbarKeys.newline', category: 'edit' },
  { id: 'ctrl-z',     label: '^Z',    seq: '\x1a',     desc: 'toolbarKeys.suspend', category: 'edit' },

  // === Control (control) ===
  { id: 'esc',        label: 'Esc',   seq: '\x1b',     desc: 'toolbarKeys.escapeVim', category: 'control' },
  { id: 'ctrl-c',     label: '^C',    seq: '\x03',     desc: 'toolbarKeys.cancelInput', category: 'control' },
  { id: 'enter',      label: '↵',     seq: '\r',       desc: 'toolbarKeys.submit', category: 'control' },
  { id: 'ctrl-l',     label: '^L',    seq: '\x0c',     desc: 'toolbarKeys.clearScreen', category: 'control' },
  { id: 'ctrl-r',     label: '^R',    seq: '\x12',     desc: 'toolbarKeys.historySearch', category: 'control' },
  { id: 'ctrl-o',     label: '^O',    seq: '\x0f',     desc: 'toolbarKeys.toggleVerbose', category: 'control' },
  { id: 'ctrl-t',     label: '^T',    seq: '\x14',     desc: 'toolbarKeys.taskListToggle', category: 'control' },
  { id: 'ctrl-b',     label: '^B',    seq: '\x02',     desc: 'toolbarKeys.backgroundTask', category: 'control' },
  { id: 'ctrl-g',     label: '^G',    seq: '\x07',     desc: 'toolbarKeys.openInEditor', category: 'control' },
  { id: 'ctrl-f',     label: '^F',    seq: '\x06',     desc: 'toolbarKeys.killAgents', category: 'control' },

  // === Input (input) ===
  { id: 'slash',      label: '/',     seq: '/',        desc: 'toolbarKeys.slashCommand', category: 'input' },
  { id: 'bang',       label: '!',     seq: '!',        desc: 'toolbarKeys.bashMode', category: 'input' },
  { id: 'at',         label: '@',     seq: '@',        desc: 'toolbarKeys.filePathComplete', category: 'input' },
  { id: 'backslash',  label: '\\',    seq: '\\',       desc: 'toolbarKeys.backslash', category: 'input' },
  { id: 'ctrl-v',     label: '^V',    seq: '',         desc: 'toolbarKeys.pasteClipboard', action: 'pasteClipboard', category: 'input' },
  { id: 'shift-tab',  label: '^⇥',    seq: '\x1b[Z',   desc: 'toolbarKeys.togglePermission', category: 'input' },

  // === UI Actions (ui) ===
  { id: 'scroll-btm', label: '↓↓',   seq: '',         desc: 'toolbarKeys.scrollBottom', action: 'scrollToBottom', category: 'ui' },
  { id: 'copy-term',  label: 'Cp',    seq: '',         desc: 'toolbarKeys.copyTerminal', action: 'copyTerminal', category: 'ui' },
  { id: 'fit',        label: 'Fit',   seq: '',         desc: 'toolbarKeys.fitTerminal', action: 'fit', category: 'ui' },
]

// Reorganized factory defaults by priority and category grouping
export const FACTORY_PINNED = [
  // Control
  'esc',
  // Navigation
  'up', 'down', 'left', 'right',
  // Editing
  'enter', 'backspace',
  // Navigation — ^A ^E
  'ctrl-a', 'ctrl-e',
  // Editing — tab (moved from backspace's right)
  'tab',
  // Input — \ / adjacent
  'backslash', 'slash',
  // Clipboard
  'ctrl-v', 'ctrl-c',
]

export const FACTORY_EXPANDED = [
  // Navigation group
  'alt-b', 'alt-f',
  // Editing group
  'ctrl-d', 'ctrl-u', 'ctrl-k', 'ctrl-y', 'ctrl-z', 'ctrl-j',
  // Control group
  'ctrl-l', 'ctrl-r', 'ctrl-b', 'ctrl-o', 'ctrl-t', 'ctrl-f', 'ctrl-g',
  // Input group
  'shift-tab', 'bang', 'at',
  // UI Actions
  'scroll-btm', 'copy-term', 'fit',
]

export const FACTORY_CONFIG: ToolbarConfig = {
  pinned: FACTORY_PINNED,
  expanded: FACTORY_EXPANDED,
}
