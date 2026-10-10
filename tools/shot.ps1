# Dev helper: runs the app with an automation script and waits for it to finish.
#   powershell -File tools\shot.ps1 <auto.json> [timeoutSeconds]
param([string]$Auto, [int]$Timeout = 120)
$root = Split-Path $PSScriptRoot -Parent
$out = Join-Path $env:TEMP 'boe-out.txt'; $err = Join-Path $env:TEMP 'boe-err.txt'
$p = Start-Process -FilePath (Join-Path $root 'node_modules\electron\dist\electron.exe') -ArgumentList "`"$root`"", '--log', "--auto=$Auto" -PassThru -RedirectStandardOutput $out -RedirectStandardError $err -NoNewWindow
if (-not $p.WaitForExit($Timeout * 1000)) { $p.Kill(); 'TIMEOUT' }
Get-Content $out | Where-Object { $_ -match '^\[ui\]|auto|Error|error' } | Select-Object -Last 25
Get-Content $err | Where-Object { $_ -match 'Error|error|Uncaught' -and $_ -notmatch 'Security Warning' } | Select-Object -Last 15
