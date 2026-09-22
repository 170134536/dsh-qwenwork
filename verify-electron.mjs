// 冒烟测试（Electron 环境版）：
// 在「DSH 同款运行环境」（Electron exe + ELECTRON_RUN_AS_NODE=1）下起插件并做真实模型调用。
//
// 为什么需要这个版本：
//   DSH 进程内 process.execPath 是 DSH Desktop.exe（Electron 二进制）。
//   插件 spawn CLI 时必须设置 ELECTRON_RUN_AS_NODE=1，否则 Electron 会静默启动完整 GUI、
//   什么都不执行 → 报「CLI 未返回任何内容」（exit 0 但 stdout 为空）。
//   node smoke-test.mjs 在 node.exe 下跑，execPath 正常，测不出这个坑；
//   必须用 DSH exe 跑本脚本才等价于生产环境。
//
// 用法:  powershell -NoProfile -ExecutionPolicy Bypass -File verify-electron.ps1
//        （脚本内部用 DSH Desktop.exe 以 ELECTRON_RUN_AS_NODE=1 执行本文件）

import { writeFileSync } from 'node:fs'

console.log('execPath =', process.execPath)
console.log('ELECTRON_RUN_AS_NODE =', process.env.ELECTRON_RUN_AS_NODE || '(未设置)')

const mod = await import(new URL('./lib/index.js', import.meta.url).href)
console.log('插件 name =', mod.name, '| apply =', typeof mod.apply)

const disposers = []
mod.apply(
  {
    effect: (fn) => {
      const d = fn()
      if (typeof d === 'function') disposers.push(d)
      return d
    },
  },
  { port: 8791, debug: false },
)
await new Promise((r) => setTimeout(r, 2500))

const results = []
const record = (name, ok, detail) => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `\n      ${detail}` : ''}`)
}

// 1) 健康检查（确认在 Electron 环境下 CLI 能找到且已登录）
try {
  const h = await (await fetch('http://127.0.0.1:8791/health', { signal: AbortSignal.timeout(15000) })).json()
  record('GET /health', h?.ok === true && h?.loggedIn === true, `cliFound=${h?.cliFound} loggedIn=${h?.loggedIn}`)
} catch (e) {
  record('GET /health', false, e.message)
}

// 2) 非流式真实调用 —— 修复 ELECTRON_RUN_AS_NODE 后必须返回 200 + 文本
try {
  const r = await fetch('http://127.0.0.1:8791/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ stream: false, messages: [{ role: 'user', content: '1+1=? 只回答数字' }] }),
    signal: AbortSignal.timeout(120000),
  })
  const j = await r.json()
  const m = j?.choices?.[0]?.message || {}
  const c = m.content || ''
  const u = j?.usage || {}
  record('非流式模型调用', r.status === 200 && c.length > 0, `status=${r.status} content=${JSON.stringify(c.slice(0, 40))}${j?.error ? ' err=' + JSON.stringify(j.error).slice(0, 120) : ''}`)
  // 思考过程：CLI 有 thinking 就必须回传成 reasoning_content，否则 DSH 看不到思考
  record('非流式 回传 reasoning_content', typeof m.reasoning_content === 'string' && m.reasoning_content.length > 0, `reasoning=${JSON.stringify((m.reasoning_content || '').slice(0, 50))}`)
  // token 计量：CLI 恒返 0，插件须用估算兜底，否则 DSH 界面永远显示 0
  record('非流式 回传 token 计量', (u.prompt_tokens || 0) > 0 || (u.completion_tokens || 0) > 0, `usage=${JSON.stringify(u)}`)
} catch (e) {
  record('非流式模型调用', false, e.message)
}

// 3) 流式真实调用（DSH 实际走的路径：pi-ai 硬编码 stream: true）
try {
  const r = await fetch('http://127.0.0.1:8791/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'Qwen3.8-Flash', stream: true, messages: [{ role: 'user', content: '2+2=? 只回答数字' }] }),
    signal: AbortSignal.timeout(120000),
  })
  const text = await r.text()
  let asm = ''
  let asmR = ''
  let lastUsage = null
  for (const line of text.split('\n')) {
    if (!line.startsWith('data: ') || line.includes('[DONE]')) continue
    try {
      const c = JSON.parse(line.slice(6))
      const d = c?.choices?.[0]?.delta || {}
      if (d.content) asm += d.content
      if (d.reasoning_content) asmR += d.reasoning_content
      if (c.usage) lastUsage = c.usage
    } catch {}
  }
  record('流式模型调用', r.status === 200 && asm.length > 0 && text.includes('[DONE]'), `status=${r.status} 拼接=${JSON.stringify(asm.slice(0, 40))} 含[DONE]=${text.includes('[DONE]')}`)
  // 这是 DSH 真实消费字段（pi-ai 的 delta.reasoning_content）
  record('流式 reasoning_content delta', asmR.length > 0, `reasoning=${JSON.stringify(asmR.slice(0, 50))}`)
  record('流式 末帧带 usage', !!lastUsage && (lastUsage.prompt_tokens > 0 || lastUsage.completion_tokens > 0), `usage=${JSON.stringify(lastUsage)}`)
} catch (e) {
  record('流式模型调用', false, e.message)
}

const failed = results.filter((r) => !r.ok)
console.log(`\n===== 验收 ${results.length - failed.length}/${results.length} =====`)
for (const d of disposers) {
  try {
    d()
  } catch {}
}
process.exit(failed.length ? 1 : 0)