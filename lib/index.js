// dsh-qwenwork — QwenWork / Qoder CLI 模型接入 DeepSeek Harness
//
// 在 DSH 进程内运行一个本地 OpenAI 兼容代理（默认 127.0.0.1:8790），
// 后端是 Qoder CLI 的 headless 模式（qoder -p -o stream-json）。
// 与 dsh-workbuddy（端口 8789）并行工作，端口不同、互不干扰。
//
// 为什么要走 CLI 而不是直连 API（2026-09-22 实测结论）：
//   - QwenWork 客户端(D:\qw\QwenWork)的登录态是 WASM 加密的 auth.dat(v10)，
//     外部读不出 token；模型网关 gateway.qwenwork.ai 还要求动态 jobToken + 签名
//     （实测 403 {"code":"101","message":"Signature invalid"}），无公开授权 API。
//   - Qoder CLI 提供官方通道：浏览器设备码授权（qoder.com/device/selectAccounts）
//     或 QODER_PERSONAL_ACCESS_TOKEN 环境变量，且支持 headless 调用。
//
// 前置条件：
//   1. npm install -g @qoder-ai/qodercli
//   2. 浏览器访问 http://127.0.0.1:8790/login 完成授权（或设 PAT 环境变量）
//   3. settings.yaml 里加 provider 指向 http://127.0.0.1:8790
//
// 设计取舍（ponytail）：
//   - 零外部依赖，只用 node:http / node:child_process / node:crypto
//   - 代理跑在 DSH 进程内，随 DSH 启停；无外部进程、无计划任务
//   - 每次请求起一个 CLI 进程（约 2-5s），换来完全无状态的实现
//   - 端口被占用自动 +1 避让（8790 → 8791 → …）
//   - prompt 过长（>4000 字符，Windows 命令行上限约 8191）自动改走 stdin

import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'

export const name = 'qwenwork'

const LOG = '[dsh-qwenwork]'

const DEFAULTS = {
  port: 8790,
  host: '127.0.0.1',
  /** 局域网共享时设置的共享密钥；留空=不鉴权（仅本机监听时安全） */
  shareToken: '',
  /** 自定义 CLI dispatcher 路径；留空=自动探测 npm 全局目录 */
  cliPath: '',
  /** CLI 配置目录（QODER_CONFIG_DIR）；留空=用 CLI 默认 ~/.qoder */
  configDir: '',
  debug: false,
  /** 单次模型请求超时（毫秒） */
  requestTimeoutMs: 120000,
  /** 登录等待上限（毫秒） */
  loginTimeoutMs: 300000,
  /** 模型列表缓存时长（毫秒） */
  modelsTtlMs: 3600000,
  /**
   * 只暴露免费模型。默认关（列出全部，由用户自己选）。
   * CLI 的 --list-models 列出 17 个模型，但实测只有 Qwen3.8-Flash 的 credits = 0，
   * 其余调用会消耗付费额度 —— 所以无论开关，模型名的后缀都会标出「免费 / 付费」。
   * 想彻底屏蔽付费模型，设 freeOnly: true。
   */
  freeOnly: false,
  /** 未指定模型时使用的模型；保持免费档位，避免 DSH 默认调用就扣费 */
  defaultModel: 'Qwen3.8-Flash',
}

/**
 * 实测免费模型白名单（2026-09-22，Free 套餐）。
 * 判据：`-m <model>` 跑一次后 `modelUsage[*].credits === 0`。
 * 注意：这是订阅状态相关的实测结论，套餐变化后需重新核对。
 */
const FREE_MODELS = ['Qwen3.8-Flash']

/**
 * CLI 未返回模型列表时的兜底。
 * 2026-09-22 实测 `qoder --list-models` 明文输出（17 个）：
 *   Auto / Ultimate / Performance / Efficient / Sonus / Cantus
 *   Qwen3.8-Max / Qwen3.8-Flash / Qwen3.7-Max / Qwen3.7-Plus
 *   Kimi-K3 / Kimi-K2.8-Preview / GLM-5.3 / GLM-5.3-Flash
 *   DeepSeek-V4-Pro / DeepSeek-Flash / MiniMax-M3
 */
const FALLBACK_MODELS = [
  { id: 'Qwen3.8-Flash', name: 'Qwen3.8-Flash · 免费' },
  { id: 'Qwen3.8-Max', name: 'Qwen3.8-Max · 付费' },
]

/** 超过此长度的 prompt 改走 stdin，避开 Windows 命令行长度上限 */
const STDIN_THRESHOLD = 4000

/** system prompt 超过此长度则拼进 prompt 正文（命令行参数也有长度限制） */
const SYS_PROMPT_MAX = 2000

/** 探测 npm 全局安装的 Qoder CLI dispatcher */
function findDispatcher(cliPath) {
  if (cliPath) return fs.existsSync(cliPath) ? cliPath : null
  const appData = process.env.APPDATA || join(os.homedir(), 'AppData', 'Roaming')
  const candidates = [
    join(appData, 'npm', 'node_modules', '@qoder-ai', 'qodercli', 'bundle', 'qoder-npm-dispatcher.cjs'),
    join(os.homedir(), '.npm-global', 'lib', 'node_modules', '@qoder-ai', 'qodercli', 'bundle', 'qoder-npm-dispatcher.cjs'),
    join('/usr', 'local', 'lib', 'node_modules', '@qoder-ai', 'qodercli', 'bundle', 'qoder-npm-dispatcher.cjs'),
    join('/usr', 'lib', 'node_modules', '@qoder-ai', 'qodercli', 'bundle', 'qoder-npm-dispatcher.cjs'),
  ]
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p
    } catch {
      /* 忽略权限问题 */
    }
  }
  return null
}

function normalizeConfig(config) {
  const cfg = { ...DEFAULTS }
  if (config && typeof config === 'object') {
    for (const key of Object.keys(DEFAULTS)) {
      const v = config[key]
      if (v === undefined || v === null || v === '') continue
      cfg[key] = typeof DEFAULTS[key] === 'number' ? Number(v) : v
    }
  }
  return cfg
}

/**
 * 把 OpenAI messages 转成 CLI 提示词。
 * system 单独抽出（走 --system-prompt），其余按 [role] 前缀拼成一段文本。
 */
function buildPrompt(messages) {
  const sys = []
  const parts = []
  const list = Array.isArray(messages) ? messages : []
  for (const m of list) {
    if (!m || typeof m !== 'object') continue
    const role = typeof m.role === 'string' ? m.role : 'user'
    let text
    if (typeof m.content === 'string') text = m.content
    else if (Array.isArray(m.content)) {
      text = m.content
        .map((b) => (b && typeof b === 'object' && typeof b.text === 'string' ? b.text : ''))
        .filter(Boolean)
        .join('\n')
    } else text = ''
    if (!text) continue
    if (role === 'system') sys.push(text)
    else parts.push(`[${role}] ${text}`)
  }
  return { system: sys.join('\n'), prompt: parts.join('\n\n') || 'Hello' }
}

function sendJson(res, status, payload) {
  if (res.headersSent) return
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(payload))
}

export function apply(ctx, config = {}) {
  const cfg = normalizeConfig(config)
  const log = (...args) => {
    if (cfg.debug) console.log(LOG, ...args)
  }
  const dispatcher = findDispatcher(cfg.cliPath)

  if (!dispatcher) {
    console.error(LOG, 'Qoder CLI 未找到。请运行: npm install -g @qoder-ai/qodercli')
    console.error(LOG, '或用 config.cliPath 指定 bundle/qoder-npm-dispatcher.cjs 的路径')
  }

  /** 浏览器登录状态机 */
  const login = { proc: null, authUrl: '', running: false, error: '' }

  /** CLI 运行环境：强制打印登录 URL（不开浏览器）、禁用颜色 */
  function cliEnv() {
    const env = { ...process.env, NO_COLOR: '1', BROWSER: 'www-browser' }
    if (cfg.configDir) env.QODER_CONFIG_DIR = cfg.configDir
    // 关键：插件运行在 DSH 进程内，process.execPath 指向 Electron 的 DSH Desktop.exe。
    // 不用 ELECTRON_RUN_AS_NODE=1 的话，spawn 它会静默启动完整 GUI、什么都不执行，
    // 表现为「CLI 未返回任何内容」（exit 0 但 stdout 为空）。
    // DSH 自己的 pnpm 服务也是这么做的（lib/pnpm.js: ELECTRON_RUN_AS_NODE: '1'）。
    env.ELECTRON_RUN_AS_NODE = '1'
    return env
  }

  /** 决定 prompt 走命令行参数还是 stdin；空 prompt（如 status/--list-models）不追加任何参数 */
  function splitArgs(baseArgs, promptText) {
    const text = typeof promptText === 'string' ? promptText : ''
    if (!text) return { args: baseArgs, useStdin: false }
    const useStdin = text.length > STDIN_THRESHOLD
    return { args: useStdin ? baseArgs : [...baseArgs, text], useStdin }
  }

  function attachStdin(child, promptText, useStdin) {
    // 始终关闭 stdin：CLI 在无 TTY 时会等 stdin，不关会挂住
    child.stdin.on('error', () => {
      /* EPIPE：进程提前退出时忽略 */
    })
    if (useStdin) child.stdin.write(promptText)
    child.stdin.end()
  }

  /** 非流式调用：等 CLI 退出后返回完整 stdout */
  function runCli(baseArgs, promptText, timeoutMs) {
    return new Promise((resolve, reject) => {
      if (!dispatcher) {
        reject(new Error('Qoder CLI not found'))
        return
      }
      const { args, useStdin } = splitArgs(baseArgs, promptText)
      const child = spawn(process.execPath, [dispatcher, ...args], {
        env: cliEnv(),
        timeout: timeoutMs || cfg.requestTimeoutMs,
      })
      let out = ''
      let err = ''
      let settled = false
      attachStdin(child, promptText, useStdin)
      child.stdout.on('data', (d) => {
        out += d.toString()
      })
      child.stderr.on('data', (d) => {
        err += d.toString()
      })
      child.on('close', (code) => {
        if (settled) return
        settled = true
        // CLI 出错时也把诊断 JSON 写 stdout（如 {"is_error":true,"result":"Not logged in"}），
        // 所以非 0 退出时仍把 stdout 交回调用方解析，只在两者都空时才报 exit code
        if (code === 0) resolve({ stdout: out, stderr: err, code })
        else if (out.trim()) resolve({ stdout: out, stderr: err, code })
        else reject(new Error(err.trim() || `CLI exit ${code}`))
      })
      child.on('error', (e) => {
        if (settled) return
        settled = true
        reject(e)
      })
    })
  }

  /** 流式调用：逐行回调 stdout（每行一个 JSON） */
  function streamCli(baseArgs, promptText, onLine, timeoutMs) {
    if (!dispatcher) throw new Error('Qoder CLI not found')
    const { args, useStdin } = splitArgs(baseArgs, promptText)
    const child = spawn(process.execPath, [dispatcher, ...args], {
      env: cliEnv(),
      timeout: timeoutMs || cfg.requestTimeoutMs,
    })
    attachStdin(child, promptText, useStdin)
    let buf = ''
    child.stdout.on('data', (d) => {
      buf += d.toString()
      const lines = buf.split('\n')
      buf = lines.pop() || ''
      for (const line of lines) {
        const t = line.trim()
        if (t) onLine(t)
      }
    })
    child.on('close', () => {
      const t = buf.trim()
      buf = ''
      if (t) onLine(t)
    })
    return child
  }

  // ────────────────────────── 登录 ──────────────────────────

  /** 启动浏览器登录；CLI 会打印设备码授权 URL 并阻塞等待 */
  async function startLogin() {
    if (!dispatcher) return ''
    if (login.running) return login.authUrl
    login.running = true
    login.authUrl = ''
    login.error = ''
    try {
      const child = spawn(process.execPath, [dispatcher, 'login'], { env: cliEnv() })
      login.proc = child
      let buf = ''
      child.stdout.on('data', (d) => {
        buf += d.toString()
        if (!login.authUrl) {
          const m = /https:\/\/[^\s]*\/device\/selectAccounts\?\S+/.exec(buf)
          if (m) login.authUrl = m[0]
        }
      })
      child.stderr.on('data', (d) => {
        const s = d.toString()
        if (/error/i.test(s)) login.error = s.trim().slice(0, 300)
      })
      child.on('close', () => {
        login.running = false
        login.proc = null
      })
      child.on('error', (e) => {
        login.running = false
        login.proc = null
        login.error = e.message
      })
    } catch (e) {
      login.running = false
      login.error = (e && e.message) || String(e)
    }
    // 等 URL 出现（CLI 启动到打印 URL 约几百毫秒）
    for (let i = 0; i < 20 && !login.authUrl && login.running; i++) {
      await new Promise((r) => setTimeout(r, 250))
    }
    return login.authUrl
  }

  /** 查询 CLI 登录状态 */
  async function checkLogin() {
    if (!dispatcher) return false
    try {
      const r = await runCli(['status'], '', 15000)
      return !/Not logged in/i.test(r.stdout)
    } catch {
      return false
    }
  }

  // ────────────────────────── 模型列表 ──────────────────────────

  let modelCache = { at: 0, list: null }

  async function getModels() {
    if (modelCache.list && Date.now() - modelCache.at < cfg.modelsTtlMs) return modelCache.list
    if (!dispatcher) return FALLBACK_MODELS
    let list = FALLBACK_MODELS
    try {
      const r = await runCli(['--list-models'], '', 20000)
      const parsed = parseModelList(r.stdout)
      if (parsed.length > 0) list = parsed
      else log('--list-models 无可解析输出，用兜底列表')
    } catch (e) {
      log('--list-models 失败:', (e && e.message) || e)
    }
    // 给每个模型标注免费/付费，让用户在 DSH 模型列表里一眼分清（避免误调用扣额度）
    let tagged = list.map((m) => ({
      ...m,
      name: m.name.includes('免费') || m.name.includes('付费') ? m.name : `${m.name} · ${FREE_MODELS.includes(m.id) ? '免费' : '付费'}`,
    }))
    // freeOnly：彻底屏蔽付费模型
    if (cfg.freeOnly) {
      const free = tagged.filter((m) => FREE_MODELS.includes(m.id))
      if (free.length > 0) tagged = free
      else {
        console.warn(LOG, `未在模型列表中找到已知免费模型 [${FREE_MODELS.join(', ')}]，暂用兜底列表；如账号已升配可设 freeOnly: false`)
        tagged = FALLBACK_MODELS
      }
    }
    modelCache = { at: Date.now(), list: tagged }
    return tagged
  }

  /** 解析 --list-models 输出：先试 JSON，再退回逐行取首个 token */
  function parseModelList(stdout) {
    const out = []
    const text = String(stdout || '').trim()
    if (!text) return out
    // 1) 整段 JSON（数组或 {data:[...]} / {models:[...]}）
    try {
      const json = JSON.parse(text)
      const arr = Array.isArray(json) ? json : Array.isArray(json.data) ? json.data : Array.isArray(json.models) ? json.models : null
      if (arr) {
        for (const m of arr) {
          if (typeof m === 'string' && m) out.push({ id: m, name: m })
          else if (m && typeof m === 'object' && typeof m.id === 'string' && m.id) {
            out.push({ id: m.id, name: typeof m.name === 'string' && m.name ? m.name : m.id })
          }
        }
        if (out.length > 0) return out
      }
    } catch {
      /* 不是 JSON，走逐行解析 */
    }
    // 2) 逐行：实测格式为表头 + 每行一个模型名：
    //      MODEL
    //      Qwen3.8-Max
    //      Qwen3.8-Flash
    //    注意：只剥行首的项目符号，不能全局替换 '-'，否则 Qwen3.8-Max 会被截断。
    for (const raw of text.split('\n')) {
      const line = raw.replace(/^\s*[*•·>]\s*/, '').trim()
      if (!line) continue
      if (/^(version|usage|available|models?|model|account|status|qodercli|not logged|list)/i.test(line)) continue
      const m = /^([A-Za-z0-9][\w.\-]*)/.exec(line)
      if (!m) continue
      const id = m[1]
      if (/^(in|not|no|please|run)$/i.test(id)) continue
      if (out.some((x) => x.id === id)) continue
      // 行内除模型名外还有说明文字时（如 "Qwen3.8-Max  Flagship"），把说明拼进显示名
      const rest = line.slice(id.length).replace(/^[\s:–—|-]+/, '').trim()
      out.push({ id, name: rest ? `${id} · ${rest}` : id })
    }
    return out
  }

  // ────────────────────────── 聊天 ──────────────────────────

  async function handleChat(req, res, body) {
    if (!dispatcher) {
      sendJson(res, 503, {
        error: { message: 'Qoder CLI 未安装：请运行 npm install -g @qoder-ai/qodercli' },
      })
      return
    }
    const messages = body && body.messages
    const model = (body && typeof body.model === 'string' && body.model) || cfg.defaultModel
    const wantStream = !(body && body.stream === false)
    const { system, prompt } = buildPrompt(messages)

    // 组装 CLI 参数：单轮、禁用工具、跳过权限确认、不落会话
    const baseArgs = [
      '-p',
      '-o',
      wantStream ? 'stream-json' : 'json',
      '--tools',
      '',
      '--max-turns',
      '1',
      '--permission-mode',
      'bypass_permissions',
      '--no-session-persistence',
      '-m',
      model,
    ]
    let promptText = prompt
    if (system && system.length <= SYS_PROMPT_MAX) {
      baseArgs.push('--system-prompt', system)
    } else if (system) {
      // system 太长，拼进 prompt 正文，避免命令行超长
      promptText = `[system] ${system}\n\n${prompt}`
    } else {
      baseArgs.push('--system-prompt', 'You are a helpful assistant. Answer directly and concisely.')
    }

    const id = `chatcmpl-${randomUUID()}`
    const created = Math.floor(Date.now() / 1000)

    if (!wantStream) {
      try {
        const r = await runCli(baseArgs, promptText)
        let json
        try {
          json = JSON.parse(r.stdout)
        } catch {
          sendJson(res, 502, { error: { message: 'CLI 返回了非 JSON 输出', raw: String(r.stdout || '').slice(0, 500) } })
          return
        }
        const text = typeof json.result === 'string' ? json.result : ''
        if (json.is_error || /Not logged in/i.test(text)) {
          sendJson(res, 502, { error: { message: text || 'CLI 执行失败', hint: '访问 /login 完成登录' } })
          return
        }
        sendJson(res, 200, {
          id,
          object: 'chat.completion',
          created,
          model,
          choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
          usage: normalizeUsage(json.usage),
        })
      } catch (e) {
        sendJson(res, 502, { error: { message: (e && e.message) || String(e) } })
      }
      return
    }

    // 流式：把 CLI 的 stream-json 逐行转成 OpenAI SSE
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    })
    let finished = false
    /** 流结束时把 CLI 的收尾信息补齐：出错则回一个 error 事件，正常则回 finish + [DONE] */
    const finish = (errText) => {
      if (finished) return
      finished = true
      if (errText) {
        res.write(`data: ${JSON.stringify({ error: { message: errText } })}\n\n`)
        res.end()
        return
      }
      const done = {
        id,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      }
      res.write(`data: ${JSON.stringify(done)}\n\n`)
      res.write('data: [DONE]\n\n')
      res.end()
    }
    let sawText = false
    let resultError = ''
    try {
      const child = streamCli(baseArgs, promptText, (line) => {
        if (!line.startsWith('{')) return
        let json
        try {
          json = JSON.parse(line)
        } catch {
          return
        }
        // result 行携带最终状态：is_error 或 "Not logged in" 需要回给调用方
        if (json.type === 'result') {
          const t = typeof json.result === 'string' ? json.result : ''
          if (json.is_error || /Not logged in/i.test(t)) resultError = t || 'CLI 执行失败'
          return
        }
        if (json.type !== 'assistant' || !json.message || !Array.isArray(json.message.content)) return
        for (const block of json.message.content) {
          if (!block || block.type !== 'text' || typeof block.text !== 'string' || !block.text) continue
          sawText = true
          const chunk = {
            id,
            object: 'chat.completion.chunk',
            created,
            model,
            choices: [{ index: 0, delta: { content: block.text }, finish_reason: null }],
          }
          res.write(`data: ${JSON.stringify(chunk)}\n\n`)
        }
      })
      child.on('close', () => finish(resultError || (sawText ? '' : 'CLI 未返回任何内容')))
      child.on('error', (e) => finish((e && e.message) || String(e)))
    } catch (e) {
      finish((e && e.message) || String(e))
    }
  }

  /** CLI usage → OpenAI usage 字段名 */
  function normalizeUsage(usage) {
    if (!usage || typeof usage !== 'object') return undefined
    const p = Number(usage.input_tokens) || 0
    const c = Number(usage.output_tokens) || 0
    return { prompt_tokens: p, completion_tokens: c, total_tokens: p + c }
  }

  // ────────────────────────── HTTP 服务 ──────────────────────────

  function authorized(req) {
    if (!cfg.shareToken) return true
    const header = req.headers['authorization'] || ''
    const bearer = header.replace(/^Bearer\s+/i, '').trim()
    const xkey = String(req.headers['x-api-key'] || '').trim()
    return bearer === cfg.shareToken || xkey === cfg.shareToken
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      if (!res.headersSent) sendJson(res, 500, { error: { message: (e && e.message) || String(e) } })
    })
  })

  async function handle(req, res) {
    if (!authorized(req)) {
      sendJson(res, 401, { error: { message: 'unauthorized: invalid or missing share token' } })
      return
    }
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)

    // GET /login — 触发浏览器授权登录（无 token 时调模型也会自动提示）
    if (req.method === 'GET' && url.pathname === '/login') {
      if (await checkLogin()) {
        sendJson(res, 200, { alreadyLoggedIn: true, authUrl: null })
        return
      }
      const authUrl = await startLogin()
      sendJson(res, 200, {
        authUrl: authUrl || null,
        running: login.running,
        error: login.error,
        hint: authUrl ? '请在浏览器打开 authUrl 完成授权' : '未能取得授权 URL，请查看 CLI 输出或日志',
      })
      return
    }

    // GET /login/status — 登录状态
    if (req.method === 'GET' && url.pathname === '/login/status') {
      sendJson(res, 200, {
        loggedIn: await checkLogin(),
        loginRunning: login.running,
        authUrl: login.authUrl,
        cliPath: dispatcher,
      })
      return
    }

    // GET /models 与 /v1/models — DSH 的「获取可用模型」调 /models
    if (req.method === 'GET' && (url.pathname === '/models' || url.pathname === '/v1/models')) {
      const models = await getModels()
      sendJson(res, 200, { object: 'list', data: models.map((m) => ({ ...m, object: 'model' })) })
      return
    }

    // GET /health — 健康检查
    if (req.method === 'GET' && url.pathname === '/health') {
      sendJson(res, 200, {
        ok: true,
        port: listenPort,
        cliFound: !!dispatcher,
        loggedIn: await checkLogin(),
        models: modelCache.list ? modelCache.list.length : 0,
      })
      return
    }

    // GET /version — CLI 版本
    if (req.method === 'GET' && url.pathname === '/version') {
      try {
        const r = await runCli(['--version'], '', 10000)
        sendJson(res, 200, { version: r.stdout.trim() })
      } catch (e) {
        sendJson(res, 500, { error: { message: (e && e.message) || String(e) } })
      }
      return
    }

    // POST /v1/chat/completions 与 /chat/completions
    if (req.method === 'POST' && (url.pathname === '/v1/chat/completions' || url.pathname === '/chat/completions')) {
      const chunks = []
      for await (const c of req) chunks.push(c)
      let body
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } catch {
        sendJson(res, 400, { error: { message: 'invalid JSON body' } })
        return
      }
      await handleChat(req, res, body)
      return
    }

    res.writeHead(404)
    res.end()
  }

  // 端口占用自动 +1 避让
  let listenPort = cfg.port
  let attempts = 0
  server.on('error', (e) => {
    if (e && e.code === 'EADDRINUSE' && attempts < 20) {
      attempts += 1
      listenPort += 1
      log(`端口 ${listenPort - 1} 被占用，尝试 ${listenPort}`)
      server.listen(listenPort, cfg.host)
      return
    }
    console.error(LOG, '代理启动失败:', (e && e.message) || e)
  })

  server.listen(cfg.port, cfg.host, () => {
    console.log(
      LOG,
      `代理已启动 http://${cfg.host}:${listenPort} → Qoder CLI | 鉴权 ${cfg.shareToken ? '开' : '关'} | 登录 /login | 模型 /models`,
    )
    if (!dispatcher) console.warn(LOG, 'CLI 未找到，模型调用将返回 503；先运行 npm install -g @qoder-ai/qodercli')
    // 启动时预取一次模型列表（失败自动降级，不阻塞服务）
    checkLogin()
      .then((ok) => {
        if (!ok) console.warn(LOG, `未登录：浏览器访问 http://${cfg.host}:${listenPort}/login 完成授权`)
      })
      .catch(() => {})
  })

  // 卸载时关闭服务与登录进程
  ctx.effect(() => () => {
    if (login.proc) {
      try {
        login.proc.kill()
      } catch {
        /* 进程可能已退出 */
      }
    }
    try {
      server.close()
    } catch {
      /* 关闭失败不影响宿主退出 */
    }
  })
}
