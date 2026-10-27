# ==============================================================================
# Septum Standalone Binary Installer (Windows PowerShell)
# https://github.com/Shironim/septum-mcp
# ==============================================================================

[CmdletBinding()]
param (
    [string]$Version = $env:VERSION,
    [string]$InstallDir = $env:SEPTUM_INSTALL_DIR
)

$ErrorActionPreference = "Stop"

$Repo = "Shironim/septum-mcp"
$BinaryName = "septum.exe"

function Write-Info {
    param([string]$Message)
    Write-Host "[info] " -ForegroundColor Cyan -NoNewline
    Write-Host $Message
}

function Write-Success {
    param([string]$Message)
    Write-Host "[success] " -ForegroundColor Green -NoNewline
    Write-Host $Message -ForegroundColor White
}

function Write-Warn {
    param([string]$Message)
    Write-Host "[warn] " -ForegroundColor Yellow -NoNewline
    Write-Host $Message
}

function Write-Err {
    param([string]$Message)
    Write-Host "[error] " -ForegroundColor Red -NoNewline
    Write-Host $Message
    exit 1
}

# 1. Architecture Check
$Arch = if ([System.Environment]::Is64BitOperatingSystem) { "x64" } else { "x86" }
if ($Arch -ne "x64") {
    Write-Err "Septum only supports 64-bit Windows architectures (x64)."
}

$Target = "septum-windows-x64.exe"
Write-Info "Detected Windows x64 architecture (target: $Target)"

# 2. Determine download URL
if ($Version) {
    $BaseUrl = "https://github.com/$Repo/releases/download/$Version"
    Write-Info "Installing specified version: $Version"
} else {
    $BaseUrl = "https://github.com/$Repo/releases/latest/download"
    Write-Info "Fetching latest release from GitHub..."
}

$DownloadUrl = "$BaseUrl/$Target"
$ChecksumUrl = "$BaseUrl/checksums.txt"

# 3. Determine Installation Directory
if (-not $InstallDir) {
    $InstallDir = Join-Path $env:LOCALAPPDATA "Programs\septum"
}

if (-not (Test-Path $InstallDir)) {
    New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
}

$TargetFile = Join-Path $InstallDir $BinaryName
$TempDir = Join-Path ([System.IO.Path]::GetTempPath()) ([System.Guid]::NewGuid().ToString())
New-Item -ItemType Directory -Path $TempDir -Force | Out-Null

try {
    $TempBin = Join-Path $TempDir $BinaryName
    Write-Info "Downloading $Target..."
    
    [System.Net.ServicePointManager]::SecurityProtocol = [System.Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -Uri $DownloadUrl -OutFile $TempBin -UseBasicParsing

    # 4. Optional Checksum Verification
    $TempChecksums = Join-Path $TempDir "checksums.txt"
    try {
        Invoke-WebRequest -Uri $ChecksumUrl -OutFile $TempChecksums -UseBasicParsing -ErrorAction SilentlyContinue
    } catch {
        # Checksums file optional if offline or unavailable
    }

    if (Test-Path $TempChecksums) {
        Write-Info "Verifying SHA256 checksum..."
        $ChecksumContent = Get-Content $TempChecksums
        $Match = $ChecksumContent | Where-Object { $_ -match $Target }
        if ($Match) {
            $ExpectedHash = ($Match -split '\s+')[0].Trim().ToLower()
            $ActualHash = (Get-FileHash -Path $TempBin -Algorithm SHA256).Hash.ToLower()

            if ($ExpectedHash -ne $ActualHash) {
                Write-Err "Checksum verification failed! Expected: $ExpectedHash, Actual: $ActualHash"
            }
            Write-Info "Checksum verified: $ActualHash"
        }
    }

    # 5. Move binary into place
    Move-Item -Path $TempBin -Destination $TargetFile -Force
} finally {
    if (Test-Path $TempDir) {
        Remove-Item -Path $TempDir -Recurse -Force -ErrorAction SilentlyContinue
    }
}

# 6. Check and Update User PATH
$UserPath = [System.Environment]::GetEnvironmentVariable("Path", [System.EnvironmentVariableTarget]::User)
$PathEntries = $UserPath -split ';' | Where-Object { $_ -ne "" }

if ($PathEntries -notcontains $InstallDir) {
    Write-Info "Adding $InstallDir to User PATH..."
    $NewPath = "$UserPath;$InstallDir"
    [System.Environment]::SetEnvironmentVariable("Path", $NewPath, [System.EnvironmentVariableTarget]::User)
    $env:Path = "$env:Path;$InstallDir"
    Write-Warn "Note: Newly opened terminal windows will automatically recognize 'septum'."
}

Write-Host ""
Write-Success "Septum successfully installed at: $TargetFile"

try {
    $VersionOutput = & $TargetFile --version
    Write-Host "       $VersionOutput" -ForegroundColor Gray
} catch {
    # Non-blocking if execution fails in restricted PowerShell session
}

Write-Host ""
Write-Host "Quick Start:" -ForegroundColor White
Write-Host "  1. Run 'septum init' in your project root to configure bounded contexts."
Write-Host "  2. Run 'septum serve' to start the stdio MCP server for AI coding agents."
Write-Host ""

