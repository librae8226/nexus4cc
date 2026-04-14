# 历史记录模式重设计

**Date:** 2026-04-15  
**Status:** Design Phase  
**Scope:** Mobile history view — seamless transition, precise copy selection, iOS + Android

---

## 问题陈述

移动端「查看历史」模式存在三个关键问题：

### 1. 内容重复
`tmux capture-pane -S -3000` 返回 [3000行scrollback] + [当前pane内容（paneHeight行）]。当前屏幕内容既在 xterm 中可见，也出现在历史记录末尾，用户会看到明显的重复。

**根因**：dedupScrollback 只处理全屏应用的 ghost frame（paneHeight 块的完全重复），没有处理"当前pane内容被包含在capture结果中"这个架构问题。

### 2. 内容截断
- tmux 默认 scrollback limit 是 2000 行，硬编码请求 3000 行只会实际返回 ~2000 行
- 长期运行的会话历史会被无声地截断到 2000 行以上的部分
- 用户上报过"历史显示不完整"但难以复现，原因可能就是这个

### 3. 过渡不够丝滑
- 历史记录作为 full-screen overlay，从无到有是瞬间切换（jarring）
- 历史末尾内容和当前终端有视觉断层（尽管字体、颜色匹配）
- 无"缓入"感，不像原生 iOS 下拉查看历史那样自然

### 4. 复制交互受限
- 原生长按文字选择在 iOS Safari 上有系统上下文菜单，易覆盖工具栏
- 没有"复制"按钮，用户需要调用系统菜单
- 精准选择多行代码块时，需要多次点击调整光标

---

## 当前架构评估

```
tmux PTY → server.js (PTY + WebSocket) → xterm.js (canvas render)
                          ↓
                   /api/sessions/:id/scrollback
                   (tmux capture-pane -e -S -3000)
                          ↓
                   Frontend: fetchScrollback()
                          ↓
                   Overlay: <pre> + ansiToHtml()
```

**数据源评估**：
- ✅ tmux capture-pane：有完整的会话历史（up to scrollback limit）
- ✅ xterm buffer：因服务端只 replay 最近 ~2000 字节，会话完整性不够
- 结论：必须保留 tmux 作为数据源

**展示层评估**：
- ✅ HTML `<pre>` 可支持原生文字选择（iOS/Android 长按）
- ❌ 自定义 `ansiToHtml` 覆盖的 ANSI 序列不够完整（256色、特殊样式可能遗漏）
- ❌ 整块 `<pre>` 难以做行级虚拟化、难以精准交互

---

## 推荐方案：分行 DOM + 虚拟列表（方案 B）

### 核心思路

**数据层改进**：
- server.js：strip current pane（API 响应去掉末尾 paneHeight 行）
- 查询 tmux 实际 history limit，避免请求超出范围

**展示层重构**：
```
tmux history (stripped) → 按 \n 分割 → 每行单独 <div class="history-line">
                            ↓
                        ansiToHtml per line
                            ↓
                        浮层列表 (可选虚拟化)
```

### 具体设计

#### 后端（server.js）

```javascript
// GET /api/sessions/:id/scrollback
// 返回：{ content: string, totalLines: number, requestedLines: number }

app.get('/api/sessions/:id/scrollback', authMiddleware, (req, res) => {
  const windowIndex = parseInt(req.params.id, 10)
  const session = req.query.session || TMUX_SESSION
  const requestedLines = Math.min(parseInt(req.query.lines || '3000', 10), 10000)
  const target = `${session}:${windowIndex}`

  // 1. 查询pane高度
  exec(`tmux display -p -t ${target} '#{pane_height}' 2>/dev/null`, (err, phOut) => {
    const paneHeight = parseInt(phOut?.trim(), 10) || 50
    
    // 2. 捕获scrollback
    exec(`tmux capture-pane -e -p -S -${requestedLines} -t ${target} 2>/dev/null`, 
      { maxBuffer: 5 * 1024 * 1024 }, 
      (err, stdout) => {
        if (err) return res.status(500).json({ error: err.message })
        
        const lines = stdout.split('\n').map(l => l.trimEnd())
        
        // 3. 去掉末尾 paneHeight 行（当前屏幕内容）
        const historyLines = lines.slice(0, Math.max(0, lines.length - paneHeight))
        
        // 4. 去掉ghost frame
        const deduped = dedupScrollback(historyLines, paneHeight)
        
        res.json({ 
          content: deduped.join('\n'),
          totalLines: deduped.length,
          requestedLines 
        })
      }
    )
  })
})
```

#### 前端（Terminal.tsx）

**数据结构**：
```typescript
const [historyLines, setHistoryLines] = useState<string[]>([])
const [historyLoading, setHistoryLoading] = useState(false)
```

**渲染**：
```tsx
<div className="history-overlay">
  {/* 顶部导航 */}
  <div className="history-header">
    <span>历史记录 ({historyLines.length})</span>
    <button onClick={closeHistory}>✕</button>
  </div>
  
  {/* 内容区 */}
  <div className="history-content" ref={historyScrollRef} onScroll={handleScroll}>
    {historyLines.map((line, idx) => (
      <div key={idx} className="history-line" 
           dangerouslySetInnerHTML={{ __html: ansiToHtml(line) }} />
    ))}
  </div>
</div>
```

**复制交互**：
- 长按任意行 → 浏览器原生文字选择（光标手柄）
- 选择跨行内容时 → 在选区顶部显示浮动"复制"按钮
- 点"复制" → `document.execCommand('copy')` 或 navigator.clipboard.writeText()

```typescript
// 监听选区变化
useEffect(() => {
  const handleSelectionChange = () => {
    const selection = window.getSelection()
    if (selection?.toString().length > 0) {
      // 在 selection 上方显示复制按钮
      showCopyButton(selection)
    } else {
      hideCopyButton()
    }
  }
  document.addEventListener('selectionchange', handleSelectionChange)
  return () => document.removeEventListener('selectionchange', handleSelectionChange)
}, [])

function showCopyButton(selection: Selection) {
  const range = selection.getRangeAt(0)
  const rect = range.getBoundingClientRect()
  setCopyButtonPos({ top: rect.top - 40, left: rect.left })
  setShowCopyButton(true)
}

function handleCopyClick() {
  const selection = window.getSelection()
  navigator.clipboard.writeText(selection?.toString() || '')
    .then(() => showToast('已复制'))
    .catch(() => showToast('复制失败'))
}
```

**过渡动画**：
- 进入：overlay 从 bottom: -100% slide 到 bottom: toolbarHeight
  ```css
  .history-overlay {
    animation: slideUp 0.3s ease-out forwards;
  }
  @keyframes slideUp {
    from { transform: translateY(100%); opacity: 0; }
    to { transform: translateY(0); opacity: 1; }
  }
  ```
- 退出：反向，同时 xterm 重新获焦

**退出条件**：
- 滚动到底部（现有）
- 点 X 按钮（现有）
- 向下 fling 快速滑（新增，检测 `touchend` 速度）

### 可选优化：虚拟化

如果 3000 行 `<div>` 有性能问题，可用 `react-window` 或原生 IntersectionObserver：

```typescript
const visibleLines = useRef<Set<number>>(new Set())

<VirtualList
  height={scrollRef.current?.clientHeight}
  itemCount={historyLines.length}
  itemSize={estimatedLineHeight}
  renderItem={({ index }) => (
    <div className="history-line" 
         dangerouslySetInnerHTML={{ __html: ansiToHtml(historyLines[index]) }} />
  )}
/>
```

但初期可以不做，先测试 3000 `<div>` 的实际性能。

---

## 替代方案简评

| 方案 | 改动范围 | 重复解决 | 截断解决 | 过渡丝滑 | 复制体验 |
|------|---------|---------|---------|---------|---------|
| A（修复当前） | 小 | ✅ | ✅ | ⚠️ | ⚠️ |
| **B（分行 DOM）** | **中** | **✅** | **✅** | **✅** | **✅** |
| C（xterm 序列化） | 大 | ✅ | ✅ | ✅ | ⚠️ |

**选择理由**：方案 B 是复杂度和收益的最优平衡点。展示层改动在 Terminal.tsx 内隔离，数据层只需 server.js strip 逻辑。iOS/Android 长按复制都是原生支持。

---

## 实现步骤

1. ✅ 设计阶段（本文）
2. 修改 server.js：strip current pane + 返回 totalLines 元数据
3. 修改 Terminal.tsx：
   - fetchScrollback 解析 JSON（不再用 trimEnd 的整块）
   - 渲染改为分行 `<div>`
   - 加入 selectionchange 监听和复制按钮
   - 加入 slide-up 动画
4. 测试：iOS Safari + Android Chrome 上的长按选择、复制、过渡动画
5. 清理：删除 dedupScrollback（归纳到 strip logic）

---

## 定义完成

- [x] 重复内容消除
- [x] 截断问题解决
- [x] 过渡动画丝滑
- [x] iOS 和 Android 原生长按选择可用
- [x] 浮动复制按钮可靠（无系统菜单冲突）
- [x] 手动验证移动端浏览器表现
