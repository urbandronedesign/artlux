# Tier-2 supervisor tick (run every minute by the "ArtLux Watchdog" Scheduled Task). If ArtLux is not
# running AND the Tier-1 circuit breaker hasn't tripped, (re)launch it into broadcast mode. Honors the
# same tripped marker the in-app watchdog writes, so Tier-2 never undoes Tier-1's decision to give up
# after a crash storm. Fast no-op when the app is already up. See docs/WATCHDOG.md.
#
#   powershell -ExecutionPolicy Bypass -File watchdog-check.ps1 -Exe "C:\path\ArtLux.exe" -Project "C:\shows\my.artlux"

param(
  [string]$Exe = '',
  [string]$Project = ''
)
$ErrorActionPreference = 'SilentlyContinue'

if (-not $Exe -or -not (Test-Path $Exe)) { exit 0 }
$name = [System.IO.Path]::GetFileNameWithoutExtension($Exe)

# Circuit breaker: the app's userData dir is %APPDATA%\<AppName>, and the packaged exe base name equals
# the Electron app name — so the tripped marker sits beside the app's other userData files.
$trippedFlag = Join-Path (Join-Path $env:APPDATA $name) 'artlux-watchdog-tripped.flag'
if (Test-Path $trippedFlag) { exit 0 } # Tier-1 gave up — stand down rather than thrash.

# Already running? Nothing to do.
if (Get-Process -Name $name -ErrorAction SilentlyContinue) { exit 0 }

$launchArgs = @('--broadcast')
if ($Project) { $launchArgs += "--project=$Project" }
Start-Process -FilePath $Exe -ArgumentList $launchArgs
