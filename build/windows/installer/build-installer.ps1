$ErrorActionPreference = 'Stop'

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..\..\..')
$installerScript = Join-Path $PSScriptRoot 'iago.iss'
$installerOutputDir = Join-Path $env:TEMP 'iago-installer-output'
$finalOutputDir = Join-Path $repoRoot 'dist\windows\installer'
$finalInstallerPath = Join-Path $finalOutputDir 'iago-setup.exe'
$iscc = Get-Command iscc.exe -ErrorAction SilentlyContinue

if (-not $iscc) {
    $candidatePaths = @(
        (Join-Path ${env:ProgramFiles(x86)} 'Inno Setup 6\ISCC.exe'),
        (Join-Path $env:ProgramFiles 'Inno Setup 6\ISCC.exe')
    )

    foreach ($candidate in $candidatePaths) {
        if ($candidate -and (Test-Path -LiteralPath $candidate)) {
            $iscc = [pscustomobject]@{ Source = $candidate }
            break
        }
    }
}

if (-not $iscc) {
    throw 'Inno Setup compiler (ISCC.exe) was not found on PATH or in the standard Inno Setup install locations.'
}

Remove-Item -LiteralPath $installerOutputDir -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $installerOutputDir | Out-Null
New-Item -ItemType Directory -Force -Path $finalOutputDir | Out-Null

& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $repoRoot 'build\rust\cli\build-windows-exe.ps1')
& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $repoRoot 'build\rust\server\build-windows-exe.ps1')

& $iscc.Source "/O$installerOutputDir" $installerScript

Copy-Item -LiteralPath (Join-Path $installerOutputDir 'iago-setup.exe') -Destination $finalInstallerPath -Force
Write-Host "Built Windows installer at $finalInstallerPath"
