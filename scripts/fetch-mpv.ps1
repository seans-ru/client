# fetch-mpv.ps1 - download bundled libmpv for the Seans Windows client (M7).
#
# BUILD / DEV TIME ONLY. Never call this from the application at runtime.
# AV policy: no packers, no runtime DLL download - these DLLs are package resources.
#
# Usage (repo root):
#   powershell -ExecutionPolicy Bypass -File scripts\fetch-mpv.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\fetch-mpv.ps1 -Force
#
# Result:
#   src-tauri/resources/mpv/libmpv-2.dll   (+ dependency DLLs from the same package)
#
# Source: shinchiro/mpv-winbuild-cmake (official community Windows builds of libmpv).
# Release page: https://github.com/shinchiro/mpv-winbuild-cmake/releases
# Use the *dev* package (libmpv-2.dll + headers). The non-dev mpv-x86_64 package
# is the portable mpv.exe player and does NOT ship libmpv-2.dll.
#
# Pinned asset (winbuild x64). Re-verify SHA256 when bumping:
#   URL:  https://github.com/shinchiro/mpv-winbuild-cmake/releases/download/20261006/mpv-dev-x86_64-20261006-git-6c092d978b.7z
#   SHA256: bc0e016bdf6573bada824873d4746ab58d9bfac0ddd59c046f160312f81f9548
#         (from GitHub release asset digest). Re-verify when bumping.
#
# The archive contains libmpv-2.dll (may be named mpv-2.dll) and its dependent
# DLLs (ffmpeg, etc.). All *.dll files from the package root are copied into
# src-tauri/resources/mpv/ so Windows can resolve them side-by-side.

[CmdletBinding()]
param(
    # Re-download and overwrite even if libmpv-2.dll is already present.
    [switch]$Force,
    # Compute and print the archive SHA256, then exit (no install).
    [switch]$PrintHash,
    # Skip SHA256 enforcement (development only).
    [switch]$SkipHashCheck
)

$ErrorActionPreference = "Stop"
# PS 5.1 on Win10 may default to TLS 1.0; GitHub requires 1.2+.
try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
} catch {}

# --- Pinned release (keep URL + hash in sync) ---------------------------------
$ReleaseUrl = "https://github.com/shinchiro/mpv-winbuild-cmake/releases/download/20261006/mpv-dev-x86_64-20261006-git-6c092d978b.7z"
# Expected SHA256 of the archive (GitHub asset digest).
$ExpectedSha256 = "bc0e016bdf6573bada824873d4746ab58d9bfac0ddd59c046f160312f81f9548"

$root = Split-Path -Parent $PSScriptRoot
$destDir = Join-Path $root "src-tauri\resources\mpv"
$dllPath = Join-Path $destDir "libmpv-2.dll"

function Expand-ArchiveAny {
    param([string]$Archive, [string]$Destination)
    if (Test-Path $Destination) {
        Remove-Item -Recurse -Force $Destination
    }
    New-Item -ItemType Directory -Path $Destination | Out-Null

    $sevenZip = Get-Command "7z.exe" -ErrorAction SilentlyContinue
    if ($sevenZip) {
        & $sevenZip.Source x -y "-o$Destination" $Archive | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "7z extraction failed ($LASTEXITCODE)" }
        return
    }

    $tar = Get-Command "tar.exe" -ErrorAction SilentlyContinue
    if ($tar) {
        # Windows 10+ bsdtar understands 7z and zip.
        & $tar.Source -xf $Archive -C $Destination
        if ($LASTEXITCODE -ne 0) { throw "tar extraction failed ($LASTEXITCODE)" }
        return
    }

    if ($Archive.ToLower().EndsWith(".zip")) {
        Expand-Archive -Path $Archive -DestinationPath $Destination -Force
        return
    }

    throw "No 7z.exe or tar.exe on PATH - install 7-Zip or Windows tar to extract $(Split-Path -Leaf $Archive)"
}

# Skip when already bundled (idempotent).
if ((Test-Path $dllPath) -and -not $Force) {
    Write-Host "libmpv-2.dll already present at $dllPath - skip (use -Force to refresh)."
    exit 0
}

New-Item -ItemType Directory -Force -Path $destDir | Out-Null

$workDir = Join-Path ([System.IO.Path]::GetTempPath()) ("seans-mpv-" + [System.Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $workDir | Out-Null
$archivePath = Join-Path $workDir (Split-Path -Leaf $ReleaseUrl)

try {
    Write-Host "Downloading $ReleaseUrl"
    # Local temp file only; the archive never ships and nothing is executed from it.
    # Prefer curl.exe (Win10 1803+): more reliable on GitHub redirects than IWR/PS5.1.
    $curl = Get-Command "curl.exe" -ErrorAction SilentlyContinue
    if ($curl) {
        & $curl.Source -L --fail --retry 3 --retry-delay 2 -o $archivePath $ReleaseUrl
        if ($LASTEXITCODE -ne 0) { throw "curl download failed ($LASTEXITCODE)" }
    } else {
        Invoke-WebRequest -Uri $ReleaseUrl -OutFile $archivePath -UseBasicParsing
    }

    $sha = (Get-FileHash -Path $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
    Write-Host "SHA256: $sha"

    if ($PrintHash) {
        Write-Host "Pin this value in scripts/fetch-mpv.ps1 as `$ExpectedSha256 = `"$sha`""
        return
    }

    $hashArmed = ($ExpectedSha256 -and $ExpectedSha256 -notmatch '^(UNLOCKED|TODO|PENDING)' -and $ExpectedSha256.Length -eq 64)
    if ($hashArmed -and -not $SkipHashCheck) {
        if ($sha -ne $ExpectedSha256.ToLowerInvariant()) {
            throw "SHA256 mismatch. Expected $($ExpectedSha256), got $sha. Refusing to install."
        }
        Write-Host "SHA256 verified."
    } elseif (-not $SkipHashCheck) {
        Write-Warning "ExpectedSha256 is not pinned yet - archive NOT verified. Run with -PrintHash, pin the value, re-run."
    }

    $extractDir = Join-Path $workDir "extract"
    Expand-ArchiveAny -Archive $archivePath -Destination $extractDir

    # Collect DLLs (root of package, plus common bin/ subfolders).
    $dlls = @()
    $dlls += Get-ChildItem -Path $extractDir -Filter "*.dll" -File -ErrorAction SilentlyContinue
    foreach ($sub in @("bin", "libmpv", "x86_64")) {
        $p = Join-Path $extractDir $sub
        if (Test-Path $p) {
            $dlls += Get-ChildItem -Path $p -Filter "*.dll" -File -ErrorAction SilentlyContinue
        }
    }

    if (-not $dlls) {
        throw "No DLLs found in the extracted package - unexpected archive layout."
    }

    $copied = 0
    foreach ($dll in $dlls) {
        $name = $dll.Name
        # Normalize the C API import name to libmpv-2.dll.
        if ($name -in @("mpv-2.dll", "mpv.dll", "libmpv.dll")) {
            $name = "libmpv-2.dll"
        }
        Copy-Item -Path $dll.FullName -Destination (Join-Path $destDir $name) -Force
        Write-Host "  -> $name"
        $copied += 1
    }

    if (-not (Test-Path $dllPath)) {
        throw "libmpv-2.dll not found after extraction (looked for mpv-2.dll / libmpv-2.dll)."
    }

    Write-Host "Installed $copied DLL(s) into $destDir"
    Write-Host "Bundle them via src-tauri/tauri.conf.json bundle.resources (resources/mpv/ -> mpv/)."
}
finally {
    if (Test-Path $workDir) {
        Remove-Item -Recurse -Force $workDir -ErrorAction SilentlyContinue
    }
}
