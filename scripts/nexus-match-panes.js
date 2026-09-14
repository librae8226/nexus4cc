#!/usr/bin/env node
// nexus-match-panes.js — 把 tmux-resurrect 快照里的 pane 标题，模糊匹配到
// ~/.claude/projects/**/*.jsonl 里的对话，输出每个 pane 该用哪个 session 接续。
//
// 用法: nexus-match-panes.js <snapshot_file>
// 输出（每行）: session:window.pane|<resume_arg>|<score>|<title>
//   resume_arg = <session-uuid>  → 精确匹配，调用方用 claude --resume <id>
//   resume_arg = CONTINUE        → 无匹配，调用方回退 --continue
//
// 为什么是 node 而不是 python3：nexus 本身就是 node 应用，node 一定在；
// 而 python3 在 macOS（自 Mojave 起不再自带）和最小化 Debian 上都没有。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SNAP = process.argv[2];
if (!SNAP) {
  console.error('[nexus-match-panes] 用法: nexus-match-panes.js <snapshot_file>');
  process.exit(2);
}

// 注意：Python 里字符串按「码点」迭代，JS 的 split('')/slice() 按 UTF-16 码元，
// 会把 emoji 劈成两半导致打分不一致。所以统一走 Array.from() 取码点。
const NOISE = new Set(Array.from(' ,.。，、：:（）()@/#!！?？\n\r\t'));
// pane 标题前缀的状态符号（✳⠐⏵⚡✅❌⚠️🔍📝🔄 与空格）
const TITLE_PREFIX = /^[✳⠐⏵⚡✅❌⚠️🔍📝🔄 ]+/u;

function unigramJaccard(a, b) {
  const sa = new Set(Array.from(a.toLowerCase()));
  const sb = new Set(Array.from(b.toLowerCase()));
  for (const ch of NOISE) { sa.delete(ch); sb.delete(ch); }
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const ch of sa) if (sb.has(ch)) inter++;
  return inter / (sa.size + sb.size - inter);
}

// 注意：只有 short 一侧去噪，long 一侧保持原样 —— 与 Python 版一致，别"顺手修好"。
function containsScore(short, long) {
  const ss = new Set(Array.from(short));
  for (const ch of NOISE) ss.delete(ch);
  if (ss.size === 0) return 0;
  const sl = new Set(Array.from(long));
  let inter = 0;
  for (const ch of ss) if (sl.has(ch)) inter++;
  return inter / ss.size;
}

const cpSlice = (s, n) => Array.from(s).slice(0, n).join('');

function collectPanes(snapshot) {
  const panes = [];
  for (const raw of fs.readFileSync(snapshot, 'utf8').split('\n')) {
    if (!raw.startsWith('pane\t')) continue;
    const p = raw.trim().split('\t');
    const [sess, win, pidx, titleField, cwdField, pfullField] = [p[1], p[2], p[5], p[6], p[7], p[10]];
    const strip = (v) => (v && v.startsWith(':') ? v.slice(1) : v);
    const pfull = strip(pfullField);
    if (!pfull || !pfull.includes('nexus-run-claude.sh')) continue;
    const title = (titleField || '').replace(TITLE_PREFIX, '').trim();
    const cwd = strip(cwdField) || '';
    panes.push({
      target: `${sess}:${win}.${pidx}`,
      title,
      cwd: cwd.replace(/\/+$/, ''),
    });
  }
  return panes;
}

function textsFromJsonl(file) {
  const texts = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    if (d?.type !== 'user' || d?.message?.role !== 'user') continue;
    const content = d.message.content ?? '';
    let text;
    if (Array.isArray(content)) {
      text = content.filter((x) => x?.type === 'text').map((x) => x.text ?? '').join(' ');
    } else {
      text = typeof content === 'string' ? content : JSON.stringify(content);
    }
    if (text.startsWith('<') || text.startsWith('Base directory')) continue;
    texts.push(text);
  }
  return texts;
}

function jsonlFilesFor(cwd) {
  const dir = path.join(os.homedir(), '.claude', 'projects', cwd.split('/').join('-'));
  let names;
  try { names = fs.readdirSync(dir); } catch { return []; }
  return names
    .filter((n) => n.endsWith('.jsonl') && !n.startsWith('.'))
    .map((n) => path.join(dir, n))
    .map((f) => ({ f, mtime: fs.statSync(f).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
    .map((x) => x.f);
}

for (const { target, title, cwd } of collectPanes(SNAP)) {
  let bestScore = 0;
  let bestSid = '';

  for (const file of jsonlFilesFor(cwd)) {
    const sid = path.basename(file).slice(0, -6);
    let texts;
    try { texts = textsFromJsonl(file); } catch { continue; }
    for (const text of texts) {
      const head = cpSlice(text, 300);
      const score = 0.5 * unigramJaccard(title, head) + 0.5 * containsScore(title, head);
      if (score > bestScore) { bestScore = score; bestSid = sid; }
    }
  }

  const arg = bestScore > 0.15 ? bestSid : 'CONTINUE';
  // 注：Python 的 :.2f 用银行家舍入，JS 的 toFixed 用四舍五入，极少数边界会差 0.01。
  // 该值只用于日志展示，不参与上面的 > 0.15 判定，所以不影响行为。
  process.stdout.write(`${target}|${arg}|${bestScore.toFixed(2)}|${cpSlice(title, 60)}\n`);
}
