# Removes the "ArtLux Watchdog" Scheduled Task (Tier-2 OS supervisor). Self-elevates via UAC.
# Invoked by the app (src/main/watchdog.ts uninstallTask) or run by hand. See docs/WATCHDOG.md.

$ErrorActionPreference = 'Stop'
$TaskName = 'ArtLux Watchdog'

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principalCheck = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principalCheck.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Start-Process powershell.exe -Verb RunAs -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`""
  exit
}

Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
Write-Host "Removed scheduled task '$TaskName' (if it existed)."
