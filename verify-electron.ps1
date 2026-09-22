# 用 DSH 同款环境（Electron exe + ELECTRON_RUN_AS_NODE=1）跑 verify-electron.mjs
#
# 为什么必须这样跑：
#   插件运行在 DSH 进程内时 process.execPath 是 Electron 二进制。若 spawn CLI 时
#   不设 ELECTRON_RUN_AS_NODE=1，Electron 会静默启动 GUI、返回空 stdout
#   （表现为「CLI 未返回任何内容」/ HTTP 502）。
#   node.exe 下不触发这个坑，所以 node smoke-test.mjs 测不出来。
#
# 输出用 Node 读回（避免 bat 控制台 GBK 把中文显示成乱码），退出码取自脚本真实结果。

$ErrorActionPreference = 'Stop'

$exe = 'D:\DSH\DSH Desktop\DSH Desktop.exe'
if (-not (Test-Path $exe)) {
  $exe = Get-ChildItem 'C:\Program Files','D:\' -Filter 'DSH Desktop.exe' -Recurse -Depth 3 -ErrorAction SilentlyContinue |
    Select-Object -First 1 -ExpandProperty FullName
}
if (-not $exe -or -not (Test-Path $exe)) { throw '找不到 DSH Desktop.exe，请用 -Exe 指定' }

$script = Join-Path $PSScriptRoot 'verify-electron.mjs'
if (-not (Test-Path $script)) { throw "找不到 $script" }

$out = Join-Path $env:TEMP 'qw-verify-e2e.txt'
$err = Join-Path $env:TEMP 'qw-verify-e2e.err.txt'
$codeFile = Join-Path $env:TEMP 'qw-verify-e2e.code'
$bat = Join-Path $env:TEMP 'qw-verify-e2e.bat'

# 把退出码写进独立文件 —— 否则 bat 末行的 echo 会覆盖 %ERRORLEVEL%
$b = @"
@echo off
set ELECTRON_RUN_AS_NODE=1
set NO_COLOR=1
cd /d "$PSScriptRoot"
"$exe" "$script" > "$out" 2> "$err"
echo %ERRORLEVEL% > "$codeFile"
"@
[System.IO.File]::WriteAllText($bat, $b, (New-Object System.Text.UTF8Encoding($false)))

& cmd.exe /c $bat | Out-Null

# 用 Node 读回，保证中文正确显示
if (Test-Path $out) {
  node -e "process.stdout.write(require('fs').readFileSync(process.argv[1],'utf8'))" $out
}

if (Test-Path $err) {
  $e = Get-Content $err -Raw -ErrorAction SilentlyContinue
  if ($null -ne $e -and $e.Trim().Length -gt 0) {
    Write-Host '--- stderr ---'
    node -e "process.stdout.write(require('fs').readFileSync(process.argv[1],'utf8').slice(0,800))" $err
  }
}

$code = if (Test-Path $codeFile) { [int](Get-Content $codeFile -Raw -ErrorAction SilentlyContinue).Trim() } else { 1 }
Remove-Item $bat, $out, $err, $codeFile -Force -ErrorAction SilentlyContinue

if ($code -ne 0) {
  Write-Host "验收失败 (exit=$code)" -ForegroundColor Red
  exit 1
}
Write-Host '验收通过 (exit=0)' -ForegroundColor Green
