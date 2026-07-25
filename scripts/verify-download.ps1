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

function Fail([string]$msg, [int]$code) {
  Write-Host "[FAIL] $msg" -ForegroundColor Red
  exit $code
}
function Note([string]$msg) { Write-Host "       $msg" -ForegroundColor DarkGray }

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
    else { Fail "cannot tell which release '$name' belongs to - pass -Tag" 2 }
    Note "inferred tag: $Tag"
  }
  # The launcher publishes its metadata under a different name so the two products never contend
  # for the same file, nor for GitHub's idea of "latest".
  $meta = if ($Tag -like 'launcher-v*') { 'launcher-latest.yml' } else { 'latest.yml' }
  $url  = "https://github.com/$REPO/releases/download/$Tag/$meta"
  Note "metadata: $url"

  try {
    # -UseBasicParsing: without it this needs an interactive session and throws in automation.
    $resp = Invoke-WebRequest $url -UseBasicParsing
  } catch {
    Fail "could not fetch $meta for $Tag - $($_.Exception.Message)" 2
  }
  # .Content is a Byte[] here: GitHub serves .yml as octet-stream and -UseBasicParsing does not
  # decode it. Treating it as a string yields nothing at all, silently.
  if ($resp.Content -is [byte[]]) { $yml = [System.Text.Encoding]::UTF8.GetString($resp.Content) }
  else { $yml = [string]$resp.Content }

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
Fail "MISMATCH - this is NOT the file we published. Do not run it. Download it again; if it keeps happening, say so before installing." 1
