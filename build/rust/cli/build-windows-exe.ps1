$ErrorActionPreference = 'Stop'

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..\..\..')
$manifestPath = Join-Path $repoRoot 'src\rust\Cargo.toml'
$targetDir = Join-Path $repoRoot 'target\rust'
$distDir = Join-Path $repoRoot 'dist\rust\cli'
$sourceExe = Join-Path $targetDir 'release\github-issues-resolver.exe'
$destExe = Join-Path $distDir 'github-issues-resolver.exe'

New-Item -ItemType Directory -Force -Path $distDir | Out-Null

cargo build --release --manifest-path $manifestPath --package github-issues-resolver --target-dir $targetDir
Copy-Item -LiteralPath $sourceExe -Destination $destExe -Force

Write-Host "Built Windows executable at $destExe"
