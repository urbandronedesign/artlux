<#
.SYNOPSIS
  Verify a downloaded ArtLux (or ArtLux Launcher) installer against the checksum GitHub published.

.DESCRIPTION
  ArtLux ships UNSIGNED by decision (docs/LAUNCHER.md -> Licence and signing), so this comparison is
  not extra diligence: it is the only integrity guarantee the project offers. Windows SmartScreen
  warns about the installer either way, and that warning says nothing about whether the bytes are
  the ones we published. This does.

  The Launcher performs exactly this check on every download and refuses a mismatch, which is why it
  is the recommended way to install. This script is for installing the .exe by hand.

  FAILS LOUDLY, AND DISTINGUISHES ITS FAILURES. A verifier that cannot obtain the expected value
  must NOT report success. The dangerous outcome is not "mismatch", it is "compared nothing against
  nothing and printed OK", because that ends the conversation. Exit codes:

      0  the file matches what was published
      1  MISMATCH - do not run the file
      2  could not verify (network, bad tag, malformed metadata) - this is NOT a pass

  ASCII ONLY, deliberately. Windows PowerShell 5.1 reads a .ps1 as ANSI, so a stray em dash or arrow
  in a string is a PARSE ERROR on a machine with a different code page - and a script that fails to
  parse exits 1, which is indistinguishable from "mismatch". The first version of this file did
  exactly that and its own test reported a false pass.

.PARAMETER File
  The downloaded installer.

.PARAMETER Tag
  Release tag, e.g. v0.25.0 or launcher-v0.1.1. Inferred from the filename when omitted.

.PARAMETER Expected
  Skip the network and compare against a base64 SHA-512 you already have.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File verify-download.ps1 -File .\ArtLux-0.25.0-x64.exe
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$File,
  [string]$Tag = '',
  [string]$Expected = ''
)

$ErrorActionPreference = 'Stop'
$REPO = 'urbandronedesign/artlux'
# Set when the tag had to be resolved from a fixed-name copy rather than read off the filename; it
# changes what a mismatch means. See the failure path at the bottom.
$rolling = $false

function Fail([string]$msg, [int]$code) {
  Write-Host "[FAIL] $msg" -ForegroundColor Red
  exit $code
}
function Note([string]$msg) { Write-Host "       $msg" -ForegroundColor DarkGray }

# Fetch a URL and hand back the body as text. GitHub serves .yml as octet-stream and -UseBasicParsing
# does not decode that, so .Content can be a Byte[]; treating it as a string yields nothing at all,
# silently. Shared by the metadata fetch and the tag lookup so only one of them can get it wrong.
function Get-Body([string]$url, [string]$what) {
  try {
    $resp = Invoke-WebRequest $url -UseBasicParsing
  } catch {
    Fail "could not fetch $what - $($_.Exception.Message)" 2
  }
  if ($resp.Content -is [byte[]]) { return [System.Text.Encoding]::UTF8.GetString($resp.Content) }
  return [string]$resp.Content
}

# Which release is a FIXED-NAME copy a copy of? Those files (ArtLux-Setup-x64.exe,
# ArtLuxLauncher-Setup-x64.exe) exist so a download link never has to be edited, which means they
# carry no version and the tag cannot be read off the filename. It is always the newest release of
# that product - but "newest" is per-PRODUCT here, because both publish into one list:
#
#   app      : /releases/latest, which excludes pre-releases - and every launcher release is one.
#              That exclusion is the property the whole two-product arrangement rests on.
#   launcher : the newest tag starting launcher-v, found by walking the list. NOT the launcher-latest
#              release itself: that one deliberately publishes no .yml, because its metadata would
#              name a versioned installer that does not exist under that tag.
#
# The walk is paged for the reason the launcher's own resolver is: app releases land far more often,
# so the newest launcher-v* sinks down the list and a single page eventually stops containing it.
function Resolve-LatestTag([string]$kind) {
  if ($kind -eq 'app') {
    $json = Get-Body "https://api.github.com/repos/$REPO/releases/latest" "the latest release"
    $tag  = (ConvertFrom-Json -InputObject $json).tag_name
    if (-not $tag) { Fail "GitHub did not name a latest release - pass -Tag" 2 }
    return $tag
  }
  for ($page = 1; $page -le 5; $page++) {
    $json = Get-Body "https://api.github.com/repos/$REPO/releases?per_page=100&page=$page" "the release list"
    # ASSIGN, THEN WRAP - and never @(<a command that returns an array>). Windows PowerShell 5.1's
    # ConvertFrom-Json emits a JSON array as ONE object, so @(ConvertFrom-Json ...) collects a single
    # pipeline item and hands back a one-element list holding the array. The loop below then inspects
    # that one item, finds no tag_name of its own, and reports "no published launcher release was
    # found" - a wrong answer with a plausible message, never a parse error. Wrapping a VARIABLE that
    # already holds the array is the version that flattens correctly. Both -InputObject and a pipe
    # get this wrong; the difference is the assignment.
    $parsed = ConvertFrom-Json -InputObject $json
    $all    = @($parsed)
    if ($all.Count -eq 0) { break }
    foreach ($r in $all) {
      if (-not $r.draft -and $r.tag_name -like 'launcher-v*') { return $r.tag_name }
    }
    if ($all.Count -lt 100) { break }
  }
  Fail "no published launcher release was found - pass -Tag" 2
}

if (-not (Test-Path -LiteralPath $File)) { Fail "no such file: $File" 2 }
$path = (Resolve-Path -LiteralPath $File).Path
$size = (Get-Item -LiteralPath $path).Length
Write-Host ''
Write-Host "  file : $path"
Write-Host "  size : $size bytes"

# ---------------------------------------------------------------------------------------------
# The expected value
# ---------------------------------------------------------------------------------------------
if (-not $Expected) {
  if (-not $Tag) {
    # ArtLux-0.25.0-x64.exe -> v0.25.0 ; ArtLuxLauncher_0.1.1_x64-setup.exe -> launcher-v0.1.1
    $name = Split-Path -Leaf $path
    if ($name -match '^ArtLuxLauncher_(\d+\.\d+\.\d+)_') { $Tag = 'launcher-v' + $Matches[1] }
    elseif ($name -match '^ArtLux-(\d+\.\d+\.\d+)-')      { $Tag = 'v' + $Matches[1] }
    # The fixed-name copies, which name no version at all - see Resolve-LatestTag.
    elseif ($name -match '^ArtLuxLauncher-Setup-') { $Tag = Resolve-LatestTag 'launcher'; $rolling = $true }
    elseif ($name -match '^ArtLux-Setup-')         { $Tag = Resolve-LatestTag 'app';      $rolling = $true }
    else { Fail "cannot tell which release '$name' belongs to - pass -Tag" 2 }
    Note "inferred tag: $Tag"
  }
  # The launcher publishes its metadata under a different name so the two products never contend
  # for the same file, nor for GitHub's idea of "latest".
  $meta = if ($Tag -like 'launcher-v*') { 'launcher-latest.yml' } else { 'latest.yml' }
  $url  = "https://github.com/$REPO/releases/download/$Tag/$meta"
  Note "metadata: $url"

  $yml = Get-Body $url "$meta for $Tag"

  foreach ($line in ($yml -split "`r?`n")) {
    # TOP-LEVEL only. The nested `files:` list repeats sha512, and an indented match would be the
    # checksum of a different artifact.
    if ($line -match '^sha512:\s*(.+)$') { $Expected = $Matches[1].Trim(); break }
  }
  if (-not $Expected) { Fail "$meta for $Tag carries no top-level sha512 - cannot verify" 2 }
}

# ---------------------------------------------------------------------------------------------
# Shape check
# ---------------------------------------------------------------------------------------------
# An empty or malformed expected value must never reach the comparison. Comparing '' against ''
# prints a cheerful match and proves nothing, which is strictly worse than not checking at all.
# Base64 SHA-512 is always 88 characters ending '=='.
if ($Expected.Length -ne 88 -or $Expected -notmatch '^[A-Za-z0-9+/]{86}==$') {
  $shown = $Expected
  if ($shown.Length -gt 24) { $shown = $shown.Substring(0, 24) + '...' }
  Fail "the published checksum is not a base64 SHA-512 (got $($Expected.Length) chars: '$shown') - refusing to compare against something that cannot be a hash" 2
}

# ---------------------------------------------------------------------------------------------
# Compute and compare
# ---------------------------------------------------------------------------------------------
# BASE64, not hex. Get-FileHash returns hex; comparing that against the published value makes a
# perfectly good download look corrupt. Streamed, because these installers are ~240 MB.
$stream = [System.IO.File]::OpenRead($path)
try {
  $sha = [System.Security.Cryptography.SHA512]::Create()
  $actual = [Convert]::ToBase64String($sha.ComputeHash($stream))
} finally {
  $stream.Dispose()
}

Write-Host "  published : $Expected"
Write-Host "  computed  : $actual"
Write-Host ''

# Ordinal and case-sensitive: base64 is case-significant and PowerShell's -eq is not.
if ([string]::Equals($Expected, $actual, [System.StringComparison]::Ordinal)) {
  Write-Host "[OK] This is the file we published. Windows will still warn that it is unsigned." -ForegroundColor Green
  exit 0
}
# A mismatch on a fixed-name copy has one innocent explanation the versioned files do not: the tag
# was resolved just now, so a release published while the download was in flight means the file is a
# real installer being compared against the NEXT one's checksum. Say so - the advice is different.
if ($rolling) {
  Note "this file names no version, so it was compared against $Tag - the newest release as of a moment ago"
  Note "if a release was published while you were downloading, download it again before drawing any conclusion"
}
Fail "MISMATCH - this is NOT the file we published. Do not run it. Download it again; if it keeps happening, say so before installing." 1
