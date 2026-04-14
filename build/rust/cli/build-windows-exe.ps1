$ErrorActionPreference = 'Stop'

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..\..\..')
$manifestPath = Join-Path $repoRoot 'src\rust\Cargo.toml'
$targetDir = Join-Path $env:TEMP 'tools-github-issues-resolver-rust-cli'
$distDir = Join-Path $repoRoot 'dist\rust\cli'
$sourceExe = Join-Path $targetDir 'release\github-issues-resolver.exe'
$destExe = Join-Path $distDir 'github-issues-resolver.exe'
$cargoExe = Join-Path $env:USERPROFILE '.cargo\bin\cargo.exe'

New-Item -ItemType Directory -Force -Path $distDir | Out-Null

& $cargoExe build --release --manifest-path $manifestPath --package github-issues-resolver --target-dir $targetDir
Copy-Item -LiteralPath $sourceExe -Destination $destExe -Force

Write-Host "Built Windows executable at $destExe"
