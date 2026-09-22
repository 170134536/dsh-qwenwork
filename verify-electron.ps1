# 用 DSH 同款环境（Electron exe + ELECTRON_RUN_AS_NODE=1）跑 verify-electron.mjs
# 等价于生产环境，能测出 node.exe 下测不出的「CLI 静默空返回」问题。
$ErrorActionPreference = 'Stop'
$exe = 'D:\DSH\DSH Desktop\DSH Desktop.exe'
$script = Join-Path $PSScriptRoot 'verify-electron.mjs'
if (-not (Test-Path $exe)) { throw "找不到 DSH: $exe" }
if (-not (Test-Path $script)) { throw "找不到 $script" }

$out = Join-Path $env:TEMP 'qw-verify-e2e.txt'
$err = Join-Path $env:TEMP 'qw-verify-e2e.err.txt'
$bat = Join-Path $env:TEMP 'qw-verify-e2e.bat'
$b = "@echo off`r`nset ELECTRON_RUN_AS_NODE=1`r`ncd /d `"$PSScriptRoot`"`r`n`"$exe`" `"$script`" > `"$out`" 2> `"$err`"`r`necho EXITCODE=%ERRORLEVEL%`r`n"
[System.IO.File]::WriteAllText($bat, $b, (New-Object System.Text.UTF8Encoding($false)))
& cmd.exe /c $bat | Out-Null
$code = $LASTEXITCODE
Get-Content $out -ErrorAction SilentlyContinue | Out-Host
if (Test-Path $err) {
  $e = Get-Content $err -Raw
  if ($e.Trim()) { Write-Host '--- stderr ---'; Write-Host $e }
}
Remove-Item $bat, $out, $err -Force -ErrorAction SilentlyContinue
if ($code -ne 0) { Write-Host "验收失败 (exit=$code)" -ForegroundColor Red; exit 1 }
Write-Host "验收通过 (exit=0)" -ForegroundColor Green