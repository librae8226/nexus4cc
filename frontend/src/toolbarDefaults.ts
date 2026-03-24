export interface KeyDef {
  id: string
  label: string
  seq: string
  desc: string
  action?: 'scrollToBottom' | 'pasteClipboard' | 'copyTerminal' | 'fit'
}

export interface ToolbarConfig {
  pinned: string[]
  expanded: string[]
}

export const ALL_KEYS: KeyDef[] = [
  { id: 'esc',        label: 'Esc',   seq: '\x1b',     desc: '取消 / Vim Normal' },
  { id: 'tab',        label: 'Tab',   seq: '\t',       desc: '接受建议 / 补全' },
  { id: 'ctrl-c',     label: '^C',    seq: '\x03',     desc: '取消当前输入/生成' },
  { id: 'enter',      label: '↵',     seq: '\r',       desc: '提交' },
  { id: 'up',         label: '↑',     seq: '\x1b[A',   desc: '上一条历史' },
  { id: 'down',       label: '↓',     seq: '\x1b[B',   desc: '下一条历史' },
  { id: 'left',       label: '←',     seq: '\x1b[D',   desc: '左移光标' },
  { id: 'right',      label: '→',     seq: '\x1b[C',   desc: '右移光标' },
  { id: 'ctrl-l',     label: '^L',    seq: '\x0c',     desc: '清屏（保留对话）' },
  { id: 'ctrl-r',     label: '^R',    seq: '\x12',     desc: '历史搜索' },
  { id: 'ctrl-d',     label: '^D',    seq: '\x04',     desc: '退出会话 / EOF' },
  { id: 'ctrl-u',     label: '^U',    seq: '\x15',     desc: '删除整行' },
  { id: 'ctrl-k',     label: '^K',    seq: '\x0b',     desc: '删至行尾' },
  { id: 'ctrl-y',     label: '^Y',    seq: '\x19',     desc: '粘贴已删内容（readline）' },
  { id: 'ctrl-o',     label: '^O',    seq: '\x0f',     desc: '切换详细输出' },
  { id: 'ctrl-t',     label: '^T',    seq: '\x14',     desc: '任务列表开关' },
  { id: 'ctrl-b',     label: '^B',    seq: '\x02',     desc: '后台任务' },
  { id: 'ctrl-g',     label: '^G',    seq: '\x07',     desc: '在编辑器中打开' },
  { id: 'ctrl-f',     label: '^F',    seq: '\x06',     desc: '终止所有后台 Agent' },
  { id: 'ctrl-j',     label: '^J',    seq: '\x0a',     desc: '换行（多行输入）' },
  { id: 'shift-tab',  label: 'S-Tab', seq: '\x1b[Z',   desc: '切换权限模式' },
  { id: 'ctrl-a',     label: '^A',    seq: '\x01',     desc: '移到行首' },
  { id: 'ctrl-e',     label: '^E',    seq: '\x05',     desc: '移到行尾' },
  { id: 'alt-b',      label: 'M-B',   seq: '\x1bb',    desc: '向后移动一词' },
  { id: 'alt-f',      label: 'M-F',   seq: '\x1bf',    desc: '向前移动一词' },
  { id: 'slash',      label: '/',     seq: '/',        desc: '斜杠命令' },
  { id: 'bang',       label: '!',     seq: '!',        desc: 'Bash 模式' },
  { id: 'at',         label: '@',     seq: '@',        desc: '文件路径补全' },
  { id: 'ctrl-z',     label: '^Z',    seq: '\x1a',     desc: '挂起进程（SIGTSTP）' },
  { id: 'backslash',  label: '\\',    seq: '\\',       desc: '反斜杠' },
  { id: 'ctrl-v',     label: '^V',    seq: '',         desc: '粘贴剪贴板图片', action: 'pasteClipboard' },
  { id: 'scroll-btm', label: '↓↓',   seq: '',         desc: '滚动到底部',     action: 'scrollToBottom' },
  { id: 'copy-term',  label: '📋',    seq: '',         desc: '复制终端内容',   action: 'copyTerminal' },
  { id: 'fit',        label: '⟳',    seq: '',         desc: '重新适配终端大小', action: 'fit' },
  { id: 'backspace',  label: '⌫',    seq: '\x7f',     desc: '退格删除' },
]

export const FACTORY_PINNED = ['esc', 'tab', 'ctrl-c', 'up', 'down', 'left', 'right', 'enter', 'ctrl-l', 'ctrl-r', 'ctrl-e', 'backslash', 'backspace']
export const FACTORY_EXPANDED = [
  'ctrl-d', 'ctrl-u', 'ctrl-k', 'ctrl-y', 'ctrl-a', 'ctrl-z',
  'ctrl-b', 'ctrl-o', 'ctrl-t', 'ctrl-f', 'ctrl-g', 'ctrl-j', 'shift-tab',
  'alt-b', 'alt-f', 'slash', 'bang', 'at', 'ctrl-v', 'scroll-btm', 'copy-term', 'fit',
]

export const FACTORY_CONFIG: ToolbarConfig = {
  pinned: FACTORY_PINNED,
  expanded: FACTORY_EXPANDED,
}
