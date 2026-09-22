// 冒烟测试：在 DSH 之外单独运行插件，验证各端点 + 真实模型调用
// 用法: node smoke-test.mjs
import { apply } from 'file:///D:/AI/tools/dsh-qwenwork/lib/index.js'

// 最小 ctx 桩：只提供 effect
const ctx = {
  effect(fn) {
    const dispose = fn()
    process.on('SIGINT', () => {
      if (typeof dispose === 'function') dispose()
      process.exit(0)
    })
  },
}

apply(ctx, { port: 8790, debug: false })

const BASE = 'http://127.0.0.1:8790'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function get(path, timeout = 60000) {
  const res = await fetch(BASE + path, { signal: AbortSignal.timeout(timeout) })
  const text = await res.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    /* 非 JSON */
  }
  return { status: res.status, json, text }
}

async function main() {
  await sleep(2500) // 等 server listen

  const results = []
  const record = (name, ok, detail) => {
    results.push({ name, ok, detail })
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}\n      ${detail}`)
  }

  // 1) /health
  try {
    const r = await get('/health')
    record('GET /health', r.status === 200 && r.json?.ok === true, `cliFound=${r.json?.cliFound} loggedIn=${r.json?.loggedIn}`)
  } catch (e) {
    record('GET /health', false, e.message)
  }

  // 2) /models — 必须是真实的两个模型（不是兜底以外的垃圾）
  let modelIds = []
  try {
    const r = await get('/models')
    modelIds = (r.json?.data || []).map((m) => m.id)
    const ok = r.status === 200 && modelIds.length > 0 && !modelIds.includes('MODEL')
    record('GET /models', ok, `models=[${modelIds.join(', ')}]`)
  } catch (e) {
    record('GET /models', false, e.message)
  }

  // 3) /v1/models 同样可用
  try {
    const r = await get('/v1/models')
    record('GET /v1/models', r.status === 200 && (r.json?.data?.length ?? 0) > 0, `count=${r.json?.data?.length}`)
  } catch (e) {
    record('GET /v1/models', false, e.message)
  }

  // 4) /version
  try {
    const r = await get('/version')
    record('GET /version', r.status === 200 && !!r.json?.version, `version=${r.json?.version}`)
  } catch (e) {
    record('GET /version', false, e.message)
  }

  // 5) /login/status — 现在应该已登录
  try {
    const r = await get('/login/status')
    record('GET /login/status', r.status === 200 && r.json?.loggedIn === true, `loggedIn=${r.json?.loggedIn}`)
  } catch (e) {
    record('GET /login/status', false, e.message)
  }

  // 6) 真实模型调用 —— 非流式
  const target = modelIds[0] || 'Qwen3.8-Flash'
  try {
    const res = await fetch(BASE + '/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: target,
        stream: false,
        messages: [{ role: 'user', content: '只回答两个字：你好' }],
      }),
      signal: AbortSignal.timeout(120000),
    })
    const j = await res.json().catch(() => null)
    const content = j?.choices?.[0]?.message?.content || ''
    const ok = res.status === 200 && content.length > 0
    record(`POST 非流式 (${target})`, ok, `status=${res.status} content="${content.slice(0, 60)}"`)
  } catch (e) {
    record(`POST 非流式 (${target})`, false, e.message)
  }

  // 7) 真实模型调用 —— 流式
  try {
    const res = await fetch(BASE + '/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: target,
        stream: true,
        messages: [{ role: 'user', content: '只回答两个字：你好' }],
      }),
      signal: AbortSignal.timeout(120000),
    })
    const text = await res.text()
    const chunks = text.split('\n').filter((l) => l.startsWith('data: ') && !l.includes('[DONE]'))
    let assembled = ''
    for (const c of chunks) {
      try {
        const j = JSON.parse(c.slice(6))
        assembled += j?.choices?.[0]?.delta?.content || ''
      } catch {
        /* 跳过 */
      }
    }
    const ok = res.status === 200 && assembled.length > 0 && text.includes('[DONE]')
    record(`POST 流式 (${target})`, ok, `status=${res.status} chunks=${chunks.length} 拼接文本="${assembled.slice(0, 60)}"`)
  } catch (e) {
    record(`POST 流式 (${target})`, false, e.message)
  }

  // 8) 非法 JSON body 必须 400
  try {
    const res = await fetch(BASE + '/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{not json',
      signal: AbortSignal.timeout(10000),
    })
    record('POST invalid JSON -> 400', res.status === 400, `status=${res.status}`)
  } catch (e) {
    record('POST invalid JSON -> 400', false, e.message)
  }

  // 9) 404 路由
  try {
    const r = await get('/nope')
    record('GET /nope -> 404', r.status === 404, `status=${r.status}`)
  } catch (e) {
    record('GET /nope -> 404', false, e.message)
  }

  const failed = results.filter((r) => !r.ok)
  console.log('\n===== 汇总 =====')
  console.log(`通过 ${results.length - failed.length}/${results.length}`)
  if (failed.length) console.log('失败项:', failed.map((f) => f.name).join(', '))
  process.exit(failed.length ? 1 : 0)
}

main().catch((e) => {
  console.error('测试异常:', e)
  process.exit(2)
})
