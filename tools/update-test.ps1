# Dev check of the self-update path, without GitHub: makes a copy of the app that is one version
# ahead, points the updater at it, starts the app twice (download, then run the update) and
# cleans up.   powershell -File tools\update-test.ps1 <work folder>
param([string]$Work)
$root = Split-Path $PSScriptRoot -Parent
$remote = Join-Path $Work 'remote'
if (Test-Path $remote) { Remove-Item -LiteralPath $remote -Recurse -Force }
New-Item -ItemType Directory $remote | Out-Null
Copy-Item (Join-Path $root 'src'), (Join-Path $root 'c4d-plugin') -Destination $remote -Recurse
Copy-Item (Join-Path $root 'package.json'), (Join-Path $root 'release.js'), (Join-Path $root 'changelog.json') -Destination $remote

# the copy is one version ahead
$cl = Get-Content (Join-Path $remote 'changelog.json') -Raw | ConvertFrom-Json
$next = [pscustomobject]@{ version = '9.9.9'; date = '2026-10-11'; changes = @('Test update: proves the update path works.') }
ConvertTo-Json -InputObject (@($next) + $cl) -Depth 5 | Set-Content -Encoding ascii (Join-Path $remote 'changelog.json')
Push-Location $remote; node release.js | Out-Null; Pop-Location

$auto = Join-Path $Work 'auto-update.json'
'{ "world": "x", "update": 6000 }' | Set-Content -Encoding ascii $auto
$env:BOE_UPDATES = '1'
$env:BOE_UPDATE_URL = 'file:///' + $remote.Replace('\', '/') + '/'
'--- first start: should download 9.9.9 ---'
& powershell -NoProfile -File (Join-Path $PSScriptRoot 'shot.ps1') $auto 60 | Select-String 'auto: update|\[update\]'
'--- second start: should be running 9.9.9 ---'
& powershell -NoProfile -File (Join-Path $PSScriptRoot 'shot.ps1') $auto 60 | Select-String 'auto: update|\[update\]'
Remove-Item Env:\BOE_UPDATES, Env:\BOE_UPDATE_URL

# remove the test update so a real run never picks it up
foreach ($name in 'Bedrock OBJ Exporter', 'bedrock-obj-exporter') {
  $u = Join-Path (Join-Path $env:APPDATA $name) 'updates'
  if (Test-Path $u) { Get-ChildItem $u | ForEach-Object { "cleaning $($_.FullName)"; Remove-Item -LiteralPath $_.FullName -Recurse -Force } }
}
