$ErrorActionPreference = 'Stop'

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..\..\..')
$installerScript = Join-Path $PSScriptRoot 'iago.iss'
$iscc = Get-Command iscc.exe -ErrorAction SilentlyContinue

if (-not $iscc) {
    throw 'Inno Setup compiler (iscc.exe) was not found on PATH.'
}

& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $repoRoot 'build\rust\cli\build-windows-exe.ps1')
& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $repoRoot 'build\rust\server\build-windows-exe.ps1')

& $iscc.Source $installerScript
