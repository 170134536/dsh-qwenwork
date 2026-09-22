# 安装 dsh-qwenwork 到 DSH profile（走 DSH 官方 pnpm 通路）
#
# 为什么必须用这个脚本（三条实测踩坑，见 lessons L-DSH-BUNDLE-1/6）：
#
#  1) 【profile 位置】DSH 真正使用的是 $DSH_HOME\profiles\<name>（本机 = D:\DSH\.dsh\profiles\desktop）。
#     %APPDATA%\dsh-desktop\harness\profiles\ 是旧实例残留下来的另一套独立副本，
#     DSH 根本不读它。装错地方的表现 = 一切看起来都对，但插件永远不加载。
#     脚本从 DSH_HOME 环境变量推断正确路径，不写死。
#
#  2) 【包索引】DSH 解析 bundle 走 pnpm 维护的 node_modules/.package-map.json，
#     不是直接读 node_modules。手工改 package.json + 建符号链接会绕过这张表
#     → DSH 启动时静默跳过该 bundle（端口不监听、无任何报错日志）。
#     必须用 DSH 自己的 pnpm 通路装。
#
#  3) 【供应链策略】DSH 每次 pnpm 操作都注入 --config.minimumReleaseAge=0
#     （见 lib/pnpm-policy-Dj9BWmx3.js）。漏掉它会被
#     ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION 挡住整个安装。
#
#  4) 【凭据】provider 的 apiKeyEnv 声明的键必须存在于 $DSH_HOME\.credentials.yaml
#     的 refs: 下，否则 DSH 在路由阶段就拒绝，报 no credential for provider route。
#
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1 -Profile web
#
# 装完必须重启 DSH Desktop（新增 bundle 不在 patchReload=live 的热重载范围内）。

param(
  [string]$Profile = 'desktop',
  [string]$PluginDir = 'D:\AI\tools\dsh-qwenwork'
)

$ErrorActionPreference = 'Stop'
$pluginName = 'dsh-qwenwork'
$keyName = 'QWENWORK_API_KEY'

Write-Host "=== 安装 $pluginName -> profile [$Profile] ===" -ForegroundColor Cyan

# --- 定位 DSH_HOME（权威来源：环境变量）---
$dshHome = $env:DSH_HOME
if (-not $dshHome) { $dshHome = Join-Path $env:USERPROFILE '.dsh' }
if (-not (Test-Path $dshHome)) { throw "DSH_HOME 不存在: $dshHome" }
$hi = Get-Item $dshHome -Force
if ($hi.LinkType) { $dshHome = @($hi.Target)[0] }

$profDir = Join-Path $dshHome "profiles\$Profile"
Write-Host "  DSH_HOME : $dshHome"
Write-Host "  profile  : $profDir"
if (-not (Test-Path (Join-Path $profDir 'package.json'))) {
  throw "profile 不存在或缺少 package.json: $profDir"
}

# --- 定位 DSH 运行时组件 ---
$exe = 'D:\DSH\DSH Desktop\DSH Desktop.exe'
$pnpm = 'D:\DSH\DSH Desktop\resources\app\node_modules\pnpm\bin\pnpm.cjs'
foreach ($f in @($exe, $pnpm, (Join-Path $PluginDir 'cordis.patch.yml'))) {
  if (-not (Test-Path $f)) { throw "缺少必要文件: $f" }
}

$genRoot = Join-Path $env:APPDATA 'DSH Desktop\runtime-commands\generations'
$clear = Get-ChildItem $genRoot -Recurse -Filter 'clear-env.cjs' -ErrorAction SilentlyContinue |
  Sort-Object LastWriteTime -Descending | Select-Object -First 1 -ExpandProperty FullName
if (-not $clear) { $clear = Join-Path $env:APPDATA 'DSH Desktop\runtime-commands\private\clear-env.cjs' }
if (-not (Test-Path $clear)) { throw '找不到 clear-env.cjs' }

# --- 用 DSH 完全相同的通路跑 pnpm add（含供应链策略参数）---
$outF = Join-Path $env:TEMP "qw-install-$Profile.txt"
$cmdline = '"' + $exe + '" --require "' + $clear + '" "' + $pnpm + '" --config.minimumReleaseAge=0 add "link:' + $PluginDir + '"'
$batch = "@echo off`r`ncd /d `"$profDir`"`r`n$cmdline > `"$outF`" 2>&1`r`necho EXITCODE=%ERRORLEVEL%`r`n"
$bf = Join-Path $env:TEMP "qw-install-$Profile.bat"
[System.IO.File]::WriteAllText($bf, $batch, (New-Object System.Text.UTF8Encoding($false)))

$env:ELECTRON_RUN_AS_NODE = '1'
$env:DSH_HOME = $dshHome
$env:CI = 'true'

Write-Host "  执行 pnpm add link:$PluginDir ..."
& cmd.exe /c $bf | Out-Null
$installOut = Get-Content $outF -Raw -ErrorAction SilentlyContinue
$installOut | Write-Host
if ($installOut -match 'ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION') {
  Write-Host '  pnpm 供应链策略拦截 —— 检查是否漏了 --config.minimumReleaseAge=0' -ForegroundColor Yellow
}

# --- 补 bundles 字段 + 三项校验 ---
$vf = Join-Path $env:TEMP 'qw-verify.mjs'
$vjs = @'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
const [profDir, name] = process.argv.slice(2)
const pkgPath = profDir + '/package.json'
const b = readFileSync(pkgPath)
if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) {
  console.log('  package.json 带 BOM —— DSH 用严格 JSON.parse 会崩，正在修复')
  writeFileSync(pkgPath, b.subarray(3).toString('utf8'), 'utf8')
}
const j = JSON.parse(readFileSync(pkgPath, 'utf8'))
if (!j.dsh.profile.bundles.includes(name)) {
  j.dsh.profile.bundles.push(name)
  writeFileSync(pkgPath, JSON.stringify(j, null, 4) + '\n', 'utf8')
  console.log('  已加入 dsh.profile.bundles')
}
const map = JSON.parse(readFileSync(profDir + '/node_modules/.package-map.json', 'utf8'))
const dep = j.dependencies?.[name]
const inBundles = j.dsh.profile.bundles.includes(name)
const inMap = map.packages?.['.']?.dependencies?.[name]
console.log('  package.json dep        = ' + (dep || '缺失'))
console.log('  dsh.profile.bundles 含它 = ' + inBundles)
console.log('  .package-map.json 含它   = ' + (inMap || '缺失'))
console.log('  符号链接                 = ' + (existsSync(profDir + '/node_modules/' + name) ? '有' : '无'))
if (!dep || !inBundles || !inMap) {
  console.log('\n  安装不完整 —— DSH 会静默跳过该 bundle')
  process.exit(1)
}
console.log('\n  三项齐备')
'@
[System.IO.File]::WriteAllText($vf, $vjs, (New-Object System.Text.UTF8Encoding($false)))
Write-Host ''
Write-Host '=== 验证 ===' -ForegroundColor Cyan
node $vf $profDir $pluginName
$verifyOk = ($LASTEXITCODE -eq 0)

# --- 凭据检查 ---
Write-Host ''
Write-Host '=== 凭据检查 ===' -ForegroundColor Cyan
$credFile = Join-Path $dshHome '.credentials.yaml'
$raw = if (Test-Path $credFile) { Get-Content $credFile -Raw } else { '' }
if ($raw -match "(?m)^\s*$keyName\s*:") {
  Write-Host "  $keyName 已配置 ($credFile)"
} else {
  Write-Host "  缺少 $keyName —— DSH 会拒绝路由到该 provider" -ForegroundColor Yellow
  Write-Host ("  修复：往 $credFile 的 refs: 下加一行  " + $keyName + ": local-proxy-no-auth")
  Write-Host '  （插件不校验此值，认证走 Qoder CLI 自身登录态）'
}

# --- 重启提示 ---
$running = Get-CimInstance Win32_Process -Filter "Name='DSH Desktop.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -notmatch '--type=' }
if ($running) {
  Write-Host ''
  Write-Host '  DSH Desktop 正在运行 —— 新增 bundle 不在热重载范围内，必须重启才生效' -ForegroundColor Yellow
}

Remove-Item $bf, $outF, $vf -Force -ErrorAction SilentlyContinue
if (-not $verifyOk) { exit 1 }
