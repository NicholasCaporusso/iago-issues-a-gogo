$ErrorActionPreference = 'Stop'

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..\..\..')
$manifestPath = Join-Path $repoRoot 'src\rust\Cargo.toml'
$targetDir = Join-Path $repoRoot 'target\rust'
$distDir = Join-Path $repoRoot 'dist\rust\server'
$sourceExe = Join-Path $targetDir 'release\issues-relay-server.exe'
$destExe = Join-Path $distDir 'issues-relay-server.exe'

New-Item -ItemType Directory -Force -Path $distDir | Out-Null

cargo build --release --manifest-path $manifestPath --package issues-relay-server --target-dir $targetDir
Copy-Item -LiteralPath $sourceExe -Destination $destExe -Force

Write-Host "Built Windows executable at $destExe"
