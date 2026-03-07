$ErrorActionPreference = "Stop"

$RepoOwner = "protheuslabs"
$RepoName = "protheus"
$DefaultApi = "https://api.github.com/repos/$RepoOwner/$RepoName/releases/latest"
$DefaultBase = "https://github.com/$RepoOwner/$RepoName/releases/download"

$InstallDir = if ($env:PROTHEUS_INSTALL_DIR) { $env:PROTHEUS_INSTALL_DIR } else { Join-Path $HOME ".protheus\bin" }
$RequestedVersion = if ($env:PROTHEUS_VERSION) { $env:PROTHEUS_VERSION } else { "latest" }
$ApiUrl = if ($env:PROTHEUS_RELEASE_API_URL) { $env:PROTHEUS_RELEASE_API_URL } else { $DefaultApi }
$BaseUrl = if ($env:PROTHEUS_RELEASE_BASE_URL) { $env:PROTHEUS_RELEASE_BASE_URL } else { $DefaultBase }

function Resolve-Arch {
  switch ($env:PROCESSOR_ARCHITECTURE.ToLower()) {
    "amd64" { "x86_64" }
    "arm64" { "aarch64" }
    default { throw "Unsupported architecture: $($env:PROCESSOR_ARCHITECTURE)" }
  }
}

function Resolve-Version {
  if ($RequestedVersion -ne "latest") {
    if ($RequestedVersion.StartsWith("v")) { return $RequestedVersion }
    return "v$RequestedVersion"
  }

  $release = Invoke-RestMethod -Uri $ApiUrl -UseBasicParsing
  if (-not $release.tag_name) {
    throw "Failed to resolve latest release tag"
  }
  return $release.tag_name
}

function Download-Asset($Version, $Asset, $OutPath) {
  $url = "$BaseUrl/$Version/$Asset"
  try {
    Invoke-WebRequest -Uri $url -OutFile $OutPath -UseBasicParsing | Out-Null
    Write-Host "[protheus install] downloaded $Asset"
    return $true
  } catch {
    return $false
  }
}

function Install-Binary($Version, $Triple, $Stem, $OutPath) {
  $tmp = New-TemporaryFile
  Remove-Item $tmp.FullName -Force
  New-Item -ItemType Directory -Path $tmp.FullName | Out-Null

  $raw = Join-Path $tmp.FullName "$Stem.exe"
  if (Download-Asset $Version "$Stem-$Triple.exe" $raw) {
    Move-Item -Force $raw $OutPath
    return $true
  }

  if (Download-Asset $Version "$Stem-$Triple" $raw) {
    Move-Item -Force $raw $OutPath
    return $true
  }

  if (Download-Asset $Version "$Stem-$Triple.bin" $raw) {
    Move-Item -Force $raw $OutPath
    return $true
  }

  return $false
}

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
$arch = Resolve-Arch
$triple = "$arch-pc-windows-msvc"
$version = Resolve-Version

Write-Host "[protheus install] version: $version"
Write-Host "[protheus install] platform: $triple"
Write-Host "[protheus install] install dir: $InstallDir"

$opsBin = Join-Path $InstallDir "protheus-ops.exe"
$daemonBin = Join-Path $InstallDir "conduit_daemon.exe"

if (-not (Install-Binary $version $triple "protheus-ops" $opsBin)) {
  throw "Failed to download protheus-ops for $triple ($version)"
}

$daemonInstalled = Install-Binary $version $triple "conduit_daemon" $daemonBin
if (-not $daemonInstalled) {
  Write-Host "[protheus install] conduit_daemon not found in release; skipping daemon binary"
}

$protheusCmd = Join-Path $InstallDir "protheus.cmd"
Set-Content -Path $protheusCmd -Value "@echo off`r`n`"%~dp0protheus-ops.exe`" protheusctl %*"

$protheusctlCmd = Join-Path $InstallDir "protheusctl.cmd"
Set-Content -Path $protheusctlCmd -Value "@echo off`r`n`"%~dp0protheus-ops.exe`" protheusctl %*"

$protheusdCmd = Join-Path $InstallDir "protheusd.cmd"
if ($daemonInstalled) {
  Set-Content -Path $protheusdCmd -Value "@echo off`r`n`"%~dp0conduit_daemon.exe`" %*"
} else {
  Set-Content -Path $protheusdCmd -Value "@echo off`r`n`"%~dp0protheus-ops.exe`" spine %*"
}

$machinePath = [Environment]::GetEnvironmentVariable("Path", "User")
if ($machinePath -notlike "*$InstallDir*") {
  [Environment]::SetEnvironmentVariable("Path", "$machinePath;$InstallDir", "User")
  Write-Host "[protheus install] added install dir to user PATH"
}

Write-Host "[protheus install] installed: protheus, protheusctl, protheusd"
Write-Host "[protheus install] open a new terminal and run: protheus --help"
