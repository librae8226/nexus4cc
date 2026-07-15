> **说明**: 本文为 CJK 字符宽度与终端表格对齐问题的参考资料（第三方生成），非 Nexus 架构专属文档。该问题在 scrollback 渲染中仍有表现，保留本文作为问题背景参考。

这个是从 tmux 里显示出来的表格形式，但是如果放在普通的纯文本里边去显示，即便字体和样式一样，表格也会错位。这是什么原因，有什么解决方案？

---

这是因为中文字符和英文字符的宽度不一致导致的。

在终端（tmux）里，等宽字体下中文占 2 列宽、英文占 1 列宽，终端模拟器能正确按列对齐。但在"普通纯文本"环境中（比如记事本、邮件、网页 `
` 标签），即使用了等宽字体，不同系统和渲染引擎对中英混排的宽度计算可能不一致，表格就会错位。

核心问题就是：绘制表格的程序（比如 CLI 工具用的 `cli-table3`、`wcwidth` 库）按"1中文=2英文宽"来计算填充空格数，但显示端的字体渲染未必遵守这个比例。

常见解决方案：

**如果目标仍是终端/纯文本显示**，确保显示端使用的字体严格遵守 CJK 双宽（比如 Nerd Font、Sarasa Gothic / 更纱黑体），并且终端的 `ambiguous width` 设置为 2。

**如果目标是分享或文档**，不要用纯文本表格，改用 Markdown 表格（渲染器会处理对齐）、HTML `
`、或者导出为 CSV / Excel。


**如果是自己写的 CLI 工具**，用 `wcwidth` / `string-width` 这类库来计算实际显示宽度再做 padding，而不是简单用 `String.length`。

你截图里这个看起来是某个 Node.js 项目的 Claude Code 审计输出？如果你需要把这些表格内容导出成可分享的格式，我可以帮你转。

---

对的。我的是 node.js 项目。claude code 运行在 tmux 中通过浏览器显示，和终端交互。但是遇到这个问题，你有什么解决办法吗？

---

明白了，你是通过浏览器访问 tmux（比如 ttyd 或类似的 web terminal），然后 Claude Code 输出的表格在浏览器里中英混排错位。

问题出在浏览器端渲染终端字体时，中文字符没有严格占 2 列宽。解决方向主要是调字体：

**最直接的方案：换一个 CJK 等宽字体**

推荐 **Sarasa Gothic（更纱黑体）** 或 **LXGW WenKai Mono（霞鹜文楷等宽）**，这些字体严格保证中文=2×英文宽度。安装后在你的 web terminal 配置里指定字体，比如 ttyd 的话可以通过 CSS 覆盖：

```css
.xterm-rows {
font-family: "Sarasa Mono SC", "LXGW WenKai Mono", monospace !important;
}
```

**如果你用的是 ttyd**，启动时可以加参数：

```bash
ttyd -t fontSize=14 -t fontFamily="Sarasa Mono SC" claude
```

**如果没法换字体**，还有一个思路是在 tmux 里设置 `set -g utf8 on` 以及确认 locale 是 `zh_CN.UTF-8`，不过这通常只影响是否能显示中文，不解决宽度问题。
