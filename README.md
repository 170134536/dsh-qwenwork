# dsh-qwenwork

把 **QwenWork / Qoder CLI** 的模型接进 DeepSeek Harness。

DSH 进程内起一个 OpenAI 兼容代理（默认 `http://127.0.0.1:8790`），后端调用 Qoder CLI 的 headless 模式。与 `dsh-workbuddy`（8789）端口隔离，可同时启用。

**状态：已实测跑通**（2026-09-22）—— 冒烟测试 9/9 通过，含真实流式与非流式模型调用。

---

## ⚠️ 费用说明（重要，先看）

CLI 的 `--list-models` 会列出 **17 个模型**，但实测**只有 `Qwen3.8-Flash` 免费**：

| 模型 | `modelUsage[*].credits` | 结论 |
|---|---|---|
| **Qwen3.8-Flash** | **0** | ✅ 免费 |
| DeepSeek-Flash | 0.00505 | ❌ 扣费 |
| Auto | 0.0907 | ❌ 扣费 |
| GLM-5.3 | 0.0932 | ❌ 扣费 |

因此插件：

- **默认 `freeOnly: false`** —— 17 个全部列出，但每个模型名后缀都会标注 `· 免费` / `· 付费`
- **`defaultModel` 固定为 `Qwen3.8-Flash`** —— 未指定模型时不会误扣费
- 想彻底屏蔽付费模型：配置里设 `freeOnly: true`

> 判定依据是订阅状态相关的实测结果，账号套餐变化后需重新核对。

---

## 为什么客户端那 2 个模型接不了

| | QwenWork 客户端 | Qoder CLI |
|---|---|---|
| 登录域 | `qwenwork.ai/signin` | `qoder.com` |
| 模型目录 | `gateway.qwenwork.ai/api/v2/model/list`（**WASM 加密**存 `catalog-v6`） | `--list-models`（明文 17 个） |
| 显示模型 | 2 个 | 17 个 |

客户端本身**无法被第三方接入**，实测障碍：

| 障碍 | 实测结果 |
|------|----------|
| 登录态 | `auth.dat` / `auth-v2.dat` 是 WASM 加密的 **v10** 格式（magic `76 31 30`），外部读不出 token |
| 公开授权 API | 无（`gateway.qwenwork.ai` 各 auth 路径全 404） |
| 模型网关 | 需动态 `jobToken` + 签名，实测 `403 {"code":"101","message":"Signature invalid"}` |
| jobToken | 每次会话由宿主进程签发，SDK worker 通过 stdio `control_request(fetch_job_token)` 索取 |
| 本地端口 | 54365 = MCP 控制面（25 个管理工具，**无模型能力**）；54367 = 需 jobToken，**未登录一律 401**；16789 = 浏览器 relay（Computer Use，非模型通道） |

**结论**：`auth.dat` 的凭据只存在客户端进程内存（WASM 解密上下文）里，jobToken 又是短期动态签发——外部无从复用。所以走 Qoder CLI 的官方通道。

---

## 前置条件

```powershell
npm install -g @qoder-ai/qodercli
```

> 若 postinstall 被 npm 拦截，补一次：
> `npm install -g @qoder-ai/qodercli --allow-scripts=@qoder-ai/qodercli,sharp`

## 安装插件

> ⚠️ **两个必须遵守的前提，否则插件会"看起来装好了但永不加载"：**
>
> **① 装到 `$DSH_HOME\profiles\<name>`，不是 `%APPDATA%`。**
> 本机存在两套独立副本，DSH 只读前者：
> - ✅ `D:\DSH\.dsh\profiles\desktop`（`$env:DSH_HOME = D:\DSH\.dsh`）
> - ❌ `%APPDATA%\dsh-desktop\harness\profiles\desktop`（旧实例残留，DSH 不读）
>
> **② 必须用 pnpm 装，不能手工建符号链接。**
> DSH 解析 bundle 走 pnpm 维护的 `node_modules/.package-map.json`，不是直接读 `node_modules`。
> 手工改 `package.json` + 建链接会绕过这张表 → **DSH 启动时静默跳过该 bundle**（端口不监听、无任何报错日志）。

一键安装（幂等，自动推断 DSH_HOME + 三项校验 + 凭据检查）：

```powershell
# 在你 clone 下来的插件目录里执行
cd <你放置插件的目录>\dsh-qwenwork
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
# 装到 web profile 就加 -Profile web
# 插件不在脚本同目录时：-PluginDir <插件绝对路径>
```

脚本做的事：
1. 从 `$env:DSH_HOME` 推断正确的 profile 目录（不写死路径）
2. 用 DSH 自己的 pnpm 通路 `pnpm add link:<插件目录>`，**含 `--config.minimumReleaseAge=0`**
   （DSH 每次 pnpm 操作都注入该参数，漏掉会被供应链策略 `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION` 挡住）
3. 把 `dsh-qwenwork` 补进 `dsh.profile.bundles`（pnpm 不管这个字段）
4. 三项校验：`package.json` 依赖 / `bundles` 列表 / `.package-map.json` 都必须含它
5. 检查 `QWENWORK_API_KEY` 是否已在凭据库

**装完必须重启 DSH Desktop** —— 新增 bundle 不在 `patchReload: live` 的热重载范围内。

### 验证是否真的被加载（决定性方法）

用 **DSH 自己的解析引擎**，别靠看配置文件：

```powershell
# desktop profile 被 Electron 独占，CLI 拒绝直读 → 复制一份临时的
$dshHome = $env:DSH_HOME                      # 例如 D:\DSH\.dsh
$app     = '<DSH 安装目录>\resources\app'      # 例如 D:\DSH\DSH Desktop\resources\app
$src = "$dshHome\profiles\desktop"; $dst = "$dshHome\profiles\test"
Remove-Item $dst -Recurse -Force -EA SilentlyContinue
New-Item -ItemType Directory $dst -Force | Out-Null
Copy-Item "$src\package.json" $dst -Force
Copy-Item "$src\pnpm-lock.yaml" $dst -Force
New-Item -ItemType Junction "$dst\node_modules" -Target "$src\node_modules" | Out-Null

node "$app\node_modules\@deepseek-ai\dsh\lib\bin.js" `
     --profile test --dump-default-config | Select-String 'qwenwork'

# 用完删掉（先 rmdir 掉 junction，别删到真 node_modules）
cmd /c "rmdir `"$dst\node_modules`""; Remove-Item $dst -Recurse -Force
```

输出里出现 `- id: qwenwork` / `name: dsh-qwenwork` 才算真加载。
> 测试副本**每次都要重建**——它不随主 profile 更新，用旧的会得到过期结论。

<details>
<summary>手工安装（等价，供理解原理）</summary>

```powershell
$dshRoot = '<DSH 安装目录>'                     # 例如 D:\DSH\DSH Desktop
$exe     = "$dshRoot\DSH Desktop.exe"
$pnpm    = "$dshRoot\resources\app\node_modules\pnpm\bin\pnpm.cjs"
$clear   = "$env:APPDATA\DSH Desktop\runtime-commands\private\clear-env.cjs"
$prof    = "$env:DSH_HOME\profiles\desktop"     # ← 注意：DSH_HOME，不是 APPDATA
$plugin  = '<你 clone 的插件目录>\dsh-qwenwork'

$env:ELECTRON_RUN_AS_NODE = '1'; $env:DSH_HOME = $env:DSH_HOME; $env:CI = 'true'
cd $prof
& $exe --require $clear $pnpm --config.minimumReleaseAge=0 add "link:$plugin"

# 再把 "dsh-qwenwork" 加进 $prof\package.json 的 dsh.profile.bundles 数组
```

> 不能用 `dsh plugin --profile desktop add ...`：desktop profile 由 Electron 应用独占管理，CLI 会直接拒绝。
</details>

## 配置 provider

在 `settings.yaml` 的 `llm-pi-ai.providers` 下加：

```yaml
    qwenwork:
      displayName: QwenWork (Qoder CLI)
      apiKeyEnv: QWENWORK_API_KEY    # 代理走 CLI 自身登录态，这里只需占位
      api: openai-completions
      baseURL: http://127.0.0.1:8790
      models:
        - id: Qwen3.8-Flash
          name: Qwen3.8-Flash (免费)
```

> 模型列表以 `GET http://127.0.0.1:8790/models` 为准，可在 DSH 模型设置页点「获取可用模型」刷新。

## 配置凭据（必做，否则 DSH 拒绝路由）

`apiKeyEnv` 声明的键**必须真实存在于 DSH 凭据库**，否则报
`no credential for provider route "qwenwork"`，请求根本到不了插件。

往 `%APPDATA%\dsh-desktop\harness\.credentials.yaml` 的 `refs:` 下加一行：

```yaml
  QWENWORK_API_KEY: local-proxy-no-auth
```

> **值随便填** —— 插件不校验它，真正的认证走 Qoder CLI 自身的登录态。
> 但这一行不能省：DSH 在**路由阶段**就检查凭据是否存在。
>
> 症状提醒：缺这一行时，UI 里表现为**模型"自己跳回"上一个可用模型**——
> 那不是自动 fallback，是每次选中这个 provider 都失败。
>
> 文件必须**无 BOM**，改完用严格 YAML 解析器回读，确认 `records:` 段和其他 key 没丢。

## 登录

```powershell
Invoke-RestMethod http://127.0.0.1:8790/login       # 触发登录，返回 authUrl
Invoke-RestMethod http://127.0.0.1:8790/login/status # 查状态
```

浏览器打开返回的 `authUrl`（形如 `https://qoder.com/device/selectAccounts?...`）授权即可。CLI 自动刷新 token，日常无需重复登录。

---

## 可用端点

| 端点 | 说明 |
|------|------|
| `POST /v1/chat/completions` | OpenAI 兼容聊天补全（流式 / 非流式） |
| `GET /models`、`/v1/models` | 模型列表（DSH「获取可用模型」调这个） |
| `GET /login` | 触发浏览器授权，返回 `authUrl` |
| `GET /login/status` | 登录状态 |
| `GET /health` | 健康检查（CLI 是否存在 / 是否登录 / 模型数） |
| `GET /version` | CLI 版本号 |

## 配置项（写在 cordis.patch.yml 的 config 下）

| 键 | 默认 | 说明 |
|---|---|---|
| `port` | `8790` | 代理监听端口 |
| `host` | `127.0.0.1` | 局域网共享可设 `0.0.0.0` |
| `shareToken` | `''` | 共享密钥；留空=不鉴权（仅本机安全） |
| `freeOnly` | `false` | `true` 时只暴露免费模型 |
| `defaultModel` | `Qwen3.8-Flash` | 未指定模型时使用 |
| `cliPath` | `''` | 自定义 CLI dispatcher 路径；留空=自动探测 |
| `configDir` | `''` | `QODER_CONFIG_DIR`；留空=`~/.qoder` |
| `requestTimeoutMs` | `120000` | 单次请求超时 |
| `modelsTtlMs` | `3600000` | 模型列表缓存时长 |
| `debug` | `false` | 详细日志 |

---

## 已知限制

- **每次请求起一个 CLI 进程**，首字延迟约 2–5 秒（无状态换来实现简单）。
- CLI 本质是 coding agent；插件用 `--tools ""` + `--max-turns 1` + `--no-session-persistence` 把它压成单轮纯文本回复，工具调用被禁用。
- `--system-prompt` 有长度上限，超长 system 自动拼进 prompt 正文。
- prompt 超过 4000 字符自动改走 stdin（规避 Windows 命令行长度上限）。
- 未登录时调模型返回 `502`，`hint` 字段提示去 `/login`。
- 额度耗尽时 CLI 返回 `error_code 118`「Credits exhausted」，插件原样透传错误信息。

---

## ⚠️ 关键实现细节：Electron 环境下必须设 ELECTRON_RUN_AS_NODE

插件运行在 DSH 进程内，此处 **`process.execPath` 指向 `DSH Desktop.exe`（Electron 二进制），不是 `node.exe`**。

用它去 spawn CLI 脚本时，**必须**传 `ELECTRON_RUN_AS_NODE=1`，否则 Electron 会静默启动一个完整 GUI、什么都不执行：

```
现象：exit code 0，但 stdout 为空  →  插件报「CLI 未返回任何内容」/ HTTP 502
```

`cliEnv()` 里已设置该变量。DSH 自己的 pnpm 服务也是这么做的（`lib/pnpm.js`）。

> **为什么 `node smoke-test.mjs` 测不出来**：在 node.exe 下 `process.execPath` 正常，这个坑不触发。
> 必须用 **DSH exe** 跑才等价于生产环境 —— 见下方「自测」的 `verify-electron.ps1`。

## 自测

```powershell
# ① 逻辑冒烟（node 环境，快）
node smoke-test.mjs

# ② 端到端验收（DSH 同款 Electron 环境，能测出上面那个坑）★推荐
powershell -NoProfile -ExecutionPolicy Bypass -File verify-electron.ps1
```

`verify-electron.ps1` 会用 `DSH Desktop.exe` + `ELECTRON_RUN_AS_NODE=1` 起一个临时实例（端口 8791，避开 8790），
验证 `/health`、非流式调用、流式调用三项，**这是唯一能代表真实运行环境的验证方式**。
