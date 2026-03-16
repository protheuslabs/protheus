param(
  [switch]$Full,
  [switch]$Minimal,
  [switch]$Pure,
  [switch]$TinyMax,
  [switch]$Repair
)

$ErrorActionPreference = "Stop"

$RepoOwner = "protheuslabs"
$RepoName = "InfRing"
$DefaultApi = "https://api.github.com/repos/$RepoOwner/$RepoName/releases/latest"
$DefaultBase = "https://github.com/$RepoOwner/$RepoName/releases/download"

$InstallDir = if ($env:INFRING_INSTALL_DIR) { $env:INFRING_INSTALL_DIR } elseif ($env:PROTHEUS_INSTALL_DIR) { $env:PROTHEUS_INSTALL_DIR } else { Join-Path $HOME ".protheus\bin" }
$RequestedVersion = if ($env:INFRING_VERSION) { $env:INFRING_VERSION } elseif ($env:PROTHEUS_VERSION) { $env:PROTHEUS_VERSION } else { "latest" }
$ApiUrl = if ($env:INFRING_RELEASE_API_URL) { $env:INFRING_RELEASE_API_URL } elseif ($env:PROTHEUS_RELEASE_API_URL) { $env:PROTHEUS_RELEASE_API_URL } else { $DefaultApi }
$BaseUrl = if ($env:INFRING_RELEASE_BASE_URL) { $env:INFRING_RELEASE_BASE_URL } elseif ($env:PROTHEUS_RELEASE_BASE_URL) { $env:PROTHEUS_RELEASE_BASE_URL } else { $DefaultBase }
$InstallFull = $false
if ($env:INFRING_INSTALL_FULL -and @("1", "true", "yes", "on") -contains $env:INFRING_INSTALL_FULL.ToLower()) {
  $InstallFull = $true
} elseif ($env:PROTHEUS_INSTALL_FULL -and @("1", "true", "yes", "on") -contains $env:PROTHEUS_INSTALL_FULL.ToLower()) {
  $InstallFull = $true
}
$InstallPure = $false
if ($env:INFRING_INSTALL_PURE -and @("1", "true", "yes", "on") -contains $env:INFRING_INSTALL_PURE.ToLower()) {
  $InstallPure = $true
} elseif ($env:PROTHEUS_INSTALL_PURE -and @("1", "true", "yes", "on") -contains $env:PROTHEUS_INSTALL_PURE.ToLower()) {
  $InstallPure = $true
}
$InstallTinyMax = $false
if ($env:INFRING_INSTALL_TINY_MAX -and @("1", "true", "yes", "on") -contains $env:INFRING_INSTALL_TINY_MAX.ToLower()) {
  $InstallTinyMax = $true
} elseif ($env:PROTHEUS_INSTALL_TINY_MAX -and @("1", "true", "yes", "on") -contains $env:PROTHEUS_INSTALL_TINY_MAX.ToLower()) {
  $InstallTinyMax = $true
}
$InstallRepair = $false
if ($env:INFRING_INSTALL_REPAIR -and @("1", "true", "yes", "on") -contains $env:INFRING_INSTALL_REPAIR.ToLower()) {
  $InstallRepair = $true
} elseif ($env:PROTHEUS_INSTALL_REPAIR -and @("1", "true", "yes", "on") -contains $env:PROTHEUS_INSTALL_REPAIR.ToLower()) {
  $InstallRepair = $true
}
if ($Full) { $InstallFull = $true }
if ($Minimal) { $InstallFull = $false }
if ($Pure) {
  $InstallPure = $true
  $InstallFull = $false
}
if ($TinyMax) {
  $InstallTinyMax = $true
  $InstallPure = $true
  $InstallFull = $false
}
if ($Repair) { $InstallRepair = $true }

function Resolve-Arch {
  $archRaw = if ($env:PROCESSOR_ARCHITECTURE) { $env:PROCESSOR_ARCHITECTURE } else { [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString() }
  switch ($archRaw.ToLower()) {
    "amd64" { "x86_64" }
    "arm64" { "aarch64" }
    default { throw "Unsupported architecture: $archRaw" }
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
    Write-Host "[infring install] downloaded $Asset"
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

  if (Download-Asset $Version "$Stem.exe" $raw) {
    Move-Item -Force $raw $OutPath
    return $true
  }

  if (Download-Asset $Version "$Stem" $raw) {
    Move-Item -Force $raw $OutPath
    return $true
  }

  return $false
}

function Install-ClientBundle($Version, $Triple, $OutDir) {
  New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
  $tmp = New-TemporaryFile
  Remove-Item $tmp.FullName -Force
  New-Item -ItemType Directory -Path $tmp.FullName | Out-Null
  $archive = Join-Path $tmp.FullName "client-runtime.bundle"
  function Expand-ClientArchive($ArchivePath, $Destination) {
    if ($ArchivePath.EndsWith(".tar.zst")) {
      try {
        tar -xf $ArchivePath -C $Destination
        return $true
      } catch {
        if (Get-Command zstd -ErrorAction SilentlyContinue) {
          $tarPath = [System.IO.Path]::ChangeExtension($ArchivePath, ".tar")
          zstd -d --stdout $ArchivePath > $tarPath
          tar -xf $tarPath -C $Destination
          return $true
        }
        Write-Host "[infring install] skipping .tar.zst bundle (zstd unavailable); falling back to .tar.gz assets"
        return $false
      }
    }
    if ($ArchivePath.EndsWith(".tar.gz")) {
      tar -xzf $ArchivePath -C $Destination
      return $true
    }
    return $false
  }
  $assets = @(
    "protheus-client-runtime-$Triple.tar.zst",
    "protheus-client-runtime.tar.zst",
    "protheus-client-$Triple.tar.zst",
    "protheus-client.tar.zst",
    "protheus-client-runtime-$Triple.tar.gz",
    "protheus-client-runtime.tar.gz",
    "protheus-client-$Triple.tar.gz",
    "protheus-client.tar.gz"
  )
  foreach ($asset in $assets) {
    if (Download-Asset $Version $asset $archive) {
      if (Expand-ClientArchive $archive $OutDir) {
        Write-Host "[infring install] installed optional client runtime bundle"
        return $true
      }
    }
  }
  return $false
}

function Resolve-WorkspaceRootForRepair {
  $candidates = @(
    $env:INFRING_WORKSPACE_ROOT,
    $env:PROTHEUS_WORKSPACE_ROOT,
    (Get-Location).Path,
    (Join-Path $HOME ".openclaw/workspace")
  )
  foreach ($candidate in $candidates) {
    if (-not $candidate) { continue }
    $manifest = Join-Path $candidate "core/layer0/ops/Cargo.toml"
    $runtimeDir = Join-Path $candidate "client/runtime"
    if ((Test-Path $manifest) -and (Test-Path $runtimeDir)) {
      return $candidate
    }
  }
  return $null
}

function Invoke-RepairInstallDir {
  $targets = @(
    "infring.cmd", "infringctl.cmd", "infringd.cmd",
    "protheus.cmd", "protheusctl.cmd", "protheusd.cmd",
    "protheus-ops.exe", "protheus-pure-workspace.exe",
    "protheusd.exe", "conduit_daemon.exe", "protheus-client"
  )
  foreach ($target in $targets) {
    $path = Join-Path $InstallDir $target
    if (Test-Path $path) {
      Remove-Item -Force -Recurse $path
      Write-Host "[infring install] repair removed stale install artifact: $path"
    }
  }
}

function Invoke-RepairWorkspaceState {
  $workspaceRoot = Resolve-WorkspaceRootForRepair
  if (-not $workspaceRoot) {
    Write-Host "[infring install] repair skipped workspace cleanup (workspace root not detected)"
    return
  }
  $timestamp = Get-Date -Format "yyyyMMddTHHmmssZ"
  $archiveDir = Join-Path $workspaceRoot "local/workspace/archive/install-repair"
  New-Item -ItemType Directory -Force -Path $archiveDir | Out-Null

  $memoryPath = Join-Path $workspaceRoot "local/workspace/memory"
  if (Test-Path $memoryPath) {
    $memoryArchive = Join-Path $archiveDir "memory-$timestamp.zip"
    try {
      Compress-Archive -Path $memoryPath -DestinationPath $memoryArchive -Force
      Write-Host "[infring install] repair archived local/workspace/memory to $memoryArchive"
    } catch {
      Write-Host "[infring install] repair warning: failed to archive memory path ($memoryPath)"
    }
  }

  $statePath = Join-Path $workspaceRoot "local/state"
  if (Test-Path $statePath) {
    $stateArchive = Join-Path $archiveDir "state-$timestamp.zip"
    try {
      Compress-Archive -Path $statePath -DestinationPath $stateArchive -Force
      Write-Host "[infring install] repair archived local/state to $stateArchive"
    } catch {
      Write-Host "[infring install] repair warning: failed to archive state path ($statePath)"
    }
  }

  $cleanup = @("client/runtime/local", "client/tmp", "core/local/tmp", "local/state")
  foreach ($rel in $cleanup) {
    $abs = Join-Path $workspaceRoot $rel
    if (Test-Path $abs) {
      Remove-Item -Force -Recurse $abs
      Write-Host "[infring install] repair removed stale runtime path: $rel"
    }
  }
  New-Item -ItemType Directory -Force -Path (Join-Path $workspaceRoot "local/state") | Out-Null
}

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
if ($InstallRepair) {
  Write-Host "[infring install] repair mode enabled"
  Invoke-RepairInstallDir
  Invoke-RepairWorkspaceState
}
$arch = Resolve-Arch
$triple = if ($IsWindows) {
  "$arch-pc-windows-msvc"
} elseif ($IsLinux) {
  "$arch-unknown-linux-gnu"
} elseif ($IsMacOS) {
  "$arch-apple-darwin"
} else {
  throw "Unsupported OS for installer"
}
$version = Resolve-Version

Write-Host "[infring install] version: $version"
Write-Host "[infring install] platform: $triple"
Write-Host "[infring install] install dir: $InstallDir"

$opsBin = Join-Path $InstallDir "protheus-ops.exe"
$pureBin = Join-Path $InstallDir "protheus-pure-workspace.exe"
$protheusdBin = Join-Path $InstallDir "protheusd.exe"
$daemonBin = Join-Path $InstallDir "conduit_daemon.exe"
$preferredDaemonTriple = if ($IsLinux -and $arch -eq "x86_64") { "x86_64-unknown-linux-musl" } else { $triple }

if ($InstallPure) {
  $pureInstalled = $false
  if ($InstallTinyMax) {
    $pureInstalled = Install-Binary $version $triple "protheus-pure-workspace-tiny-max" $pureBin
  }
  if (-not $pureInstalled) {
    $pureInstalled = Install-Binary $version $triple "protheus-pure-workspace" $pureBin
  }
  if (-not $pureInstalled) {
    throw "Failed to download pure workspace binary for $triple ($version)"
  }
  if ($InstallTinyMax) {
    Write-Host "[infring install] tiny-max pure mode selected: Rust-only tiny profile installed"
  } else {
    Write-Host "[infring install] pure mode selected: Rust-only client installed"
  }
} elseif (-not (Install-Binary $version $triple "protheus-ops" $opsBin)) {
  throw "Failed to download protheus-ops for $triple ($version)"
}

$daemonMode = "spine"
if ($InstallTinyMax -and (Install-Binary $version $preferredDaemonTriple "protheusd-tiny-max" $protheusdBin)) {
  $daemonMode = "protheusd"
  Write-Host "[infring install] using tiny-max protheusd"
} elseif (Install-Binary $version $preferredDaemonTriple "protheusd" $protheusdBin) {
  $daemonMode = "protheusd"
  if ($preferredDaemonTriple -eq "x86_64-unknown-linux-musl") {
    Write-Host "[infring install] using static musl protheusd (embedded-minimal-core)"
  } else {
    Write-Host "[infring install] using protheusd"
  }
} elseif ($preferredDaemonTriple -ne $triple -and (Install-Binary $version $triple "protheusd" $protheusdBin)) {
  $daemonMode = "protheusd"
  Write-Host "[infring install] using native protheusd fallback"
} elseif (Install-Binary $version $triple "conduit_daemon" $daemonBin) {
  $daemonMode = "conduit"
  Write-Host "[infring install] using conduit_daemon compatibility fallback"
} else {
  Write-Host "[infring install] no dedicated daemon binary found; falling back to protheus-ops spine mode"
}

$infringCmd = Join-Path $InstallDir "infring.cmd"
if ($InstallPure) {
  if ($InstallTinyMax) {
    Set-Content -Path $infringCmd -Value "@echo off`r`n`"%~dp0protheus-pure-workspace.exe`" --tiny-max=1 %*"
  } else {
    Set-Content -Path $infringCmd -Value "@echo off`r`n`"%~dp0protheus-pure-workspace.exe`" %*"
  }
} else {
  Set-Content -Path $infringCmd -Value "@echo off`r`n`"%~dp0protheus-ops.exe`" protheusctl %*"
}

$infringctlCmd = Join-Path $InstallDir "infringctl.cmd"
if ($InstallPure) {
  Set-Content -Path $infringctlCmd -Value "@echo off`r`n`"%~dp0protheus-pure-workspace.exe`" conduit %*"
} else {
  Set-Content -Path $infringctlCmd -Value "@echo off`r`n`"%~dp0protheus-ops.exe`" protheusctl %*"
}

$infringdCmd = Join-Path $InstallDir "infringd.cmd"
if ($daemonMode -eq "protheusd") {
  Set-Content -Path $infringdCmd -Value "@echo off`r`n`"%~dp0protheusd.exe`" %*"
} elseif ($daemonMode -eq "conduit") {
  Set-Content -Path $infringdCmd -Value "@echo off`r`n`"%~dp0conduit_daemon.exe`" %*"
} else {
  if ($InstallPure) {
    throw "No daemon binary available for pure mode"
  }
  Set-Content -Path $infringdCmd -Value "@echo off`r`n`"%~dp0protheus-ops.exe`" spine %*"
}

$protheusCmd = Join-Path $InstallDir "protheus.cmd"
Set-Content -Path $protheusCmd -Value "@echo off`r`necho [deprecation] 'protheus' is deprecated; use 'infring'. 1>&2`r`ncall `"%~dp0infring.cmd`" %*"

$protheusctlCmd = Join-Path $InstallDir "protheusctl.cmd"
Set-Content -Path $protheusctlCmd -Value "@echo off`r`ncall `"%~dp0infringctl.cmd`" %*"

$protheusdCmd = Join-Path $InstallDir "protheusd.cmd"
Set-Content -Path $protheusdCmd -Value "@echo off`r`necho [deprecation] 'protheusd' is deprecated; use 'infringd'. 1>&2`r`ncall `"%~dp0infringd.cmd`" %*"

if ($InstallPure) {
  Write-Host "[infring install] pure mode: skipping OpenClaw client bundle"
} elseif ($InstallFull) {
  $clientDir = Join-Path $InstallDir "protheus-client"
  if (Install-ClientBundle $version $triple $clientDir) {
    Write-Host "[infring install] full mode enabled: client runtime installed at $clientDir"
  } else {
    Write-Host "[infring install] full mode requested but no client runtime bundle was published for this release"
  }
} else {
  Write-Host "[infring install] lazy mode: skipping TS systems/eyes client bundle (use -Full to include)"
}

$machinePath = [Environment]::GetEnvironmentVariable("Path", "User")
if ($machinePath -notlike "*$InstallDir*") {
  [Environment]::SetEnvironmentVariable("Path", "$machinePath;$InstallDir", "User")
  Write-Host "[infring install] added install dir to user PATH"
}

Write-Host "[infring install] installed: infring, infringctl, infringd"
Write-Host "[infring install] aliases: protheus, protheusctl, protheusd"
Write-Host "[infring install] open a new terminal and run: infring --help"
