# setup-worktree.ps1 - bring gitignored dev binaries into a fresh git worktree.
#
# `libmpv-2.dll` and the optional ffmpeg binary are package resources that are
# never committed (see .gitignore, AV policy). A fresh `git worktree` therefore
# starts without them and the player fails with «Не найден libmpv-2.dll»
# before the first frame (issue #87).
#
# Usage (from any worktree root, incl. the main checkout):
#   powershell -ExecutionPolicy Bypass -File scripts\setup-worktree.ps1
#
# Copies (only what is missing, never overwrites a newer local copy):
#   src-tauri/resources/mpv/*        <- scripts/fetch-mpv.ps1 output in main checkout
#   src-tauri/resources/ffmpeg/*     <- optional clip-export ffmpeg
#
# The "main checkout" is resolved from git itself (`git worktree list`), so the
# script works from every worktree of the repo.

$ErrorActionPreference = "Stop"

$repoRoot = (git rev-parse --show-toplevel).Trim()
if (-not $repoRoot) {
    Write-Error "Not inside a git worktree of seans-client."
    exit 1
}

# First worktree listed by git is the main checkout (where the DLLs were fetched).
$mainRoot = (git worktree list --porcelain |
    Select-String -Pattern "^worktree " |
    Select-Object -First 1) -replace "^worktree ", ""
if (-not $mainRoot) {
    $mainRoot = $repoRoot
}

function Sync-ResourceDir([string]$rel) {
    $src = Join-Path $mainRoot $rel
    $dst = Join-Path $repoRoot $rel
    if (-not (Test-Path $src)) {
        Write-Host "skip  $rel (no source in $mainRoot)"
        return
    }
    New-Item -ItemType Directory -Path $dst -Force | Out-Null
    $copied = 0
    foreach ($file in Get-ChildItem $src -File) {
        $target = Join-Path $dst $file.Name
        if (-not (Test-Path $target)) {
            Copy-Item $file.FullName $target
            $copied++
        }
    }
    Write-Host "sync  $rel ($copied file(s) copied)"
}

Sync-ResourceDir "src-tauri/resources/mpv"
Sync-ResourceDir "src-tauri/resources/ffmpeg"

if (-not (Test-Path (Join-Path $repoRoot "node_modules"))) {
    Write-Host "note  node_modules missing - run 'npm install' (or link it) in this worktree"
}

Write-Host "done  $repoRoot ready for 'npm run tauri dev'"
