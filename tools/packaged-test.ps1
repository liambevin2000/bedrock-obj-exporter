# Dev check of the packaged app (dist\win-unpacked): opens a world and builds a preview, then runs
# the self-update path against a local copy that is one version ahead, and cleans up.
#   powershell -File tools\packaged-test.ps1 <work folder> <auto.json for the preview run>
param([string]$Work, [string]$Auto)
$root = Split-Path $PSScriptRoot -Parent
$exe = Join-Path $root 'dist\win-unpacked\Bedrock OBJ Exporter.exe'
function Run($autoFile) {
  $out = Join-Path $env:TEMP 'boe-packaged-out.txt'; $err = Join-Path $env:TEMP 'boe-packaged-err.txt'
  $p = Start-Process -FilePath $exe -ArgumentList '--log', "--auto=$autoFile" -PassThru -RedirectStandardOutput $out -RedirectStandardError $err -NoNewWindow
  if (-not $p.WaitForExit(120000)) { $p.Kill(); 'TIMEOUT' }
  Get-Content $out | Where-Object { $_ -match 'auto:|\[update\]' } | ForEach-Object { if ($_.Length -gt 230) { $_.Substring(0, 230) } else { $_ } }
  Get-Content $err | Where-Object { $_ -match 'Error|Uncaught|Cannot find' -and $_ -notmatch 'cache|Security Warning' } | Select-Object -First 6
}
'--- packaged app: open a world and preview ---'
Run $Auto

$remote = Join-Path $Work 'remote'
$upd = Join-Path $Work 'auto-update.json'
if ((Test-Path $remote) -and (Test-Path $upd)) {
  $env:BOE_UPDATE_URL = 'file:///' + $remote.Replace('\', '/') + '/'
  '--- packaged app, first start: should download the newer version ---'
  Run $upd
  '--- packaged app, second start: should be running it ---'
  Run $upd
  Remove-Item Env:\BOE_UPDATE_URL
  foreach ($name in 'Bedrock OBJ Exporter', 'bedrock-obj-exporter') {
    $u = Join-Path (Join-Path $env:APPDATA $name) 'updates'
    if (Test-Path $u) { Get-ChildItem $u | ForEach-Object { "cleaning $($_.FullName)"; Remove-Item -LiteralPath $_.FullName -Recurse -Force } }
  }
}
