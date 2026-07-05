# Tier-2 OS supervisor installer — registers the "ArtLux Watchdog" Scheduled Task.
#
# The task runs at logon AND repeats every minute; its action (watchdog-check.ps1) relaunches ArtLux
# into broadcast mode if the process is gone entirely (a crash so hard the process died, or a reboot)
# — the case the in-app Tier-1 watchdog cannot cover once its own process is dead. See docs/WATCHDOG.md.
#
# Invoked by the app (src/main/watchdog.ts installTask) or run by hand. Self-elevates via UAC because
# registering a task with a repetition trigger requires admin.
#
#   powershell -ExecutionPolicy Bypass -File install-watchdog-task.ps1 -Exe "C:\path\ArtLux.exe" -Project "C:\shows\my.artlux"

param(
  [string]$Exe = '',
  [string]$Project = ''
)
$ErrorActionPreference = 'Stop'
$TaskName = 'ArtLux Watchdog'

# Self-elevate if not already admin.
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principalCheck = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principalCheck.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  $relaunch = "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`" -Exe `"$Exe`" -Project `"$Project`""
  Start-Process powershell.exe -Verb RunAs -ArgumentList $relaunch
  exit
}

if (-not $Exe) { $Exe = (Get-Process -Id $PID).Path } # fallback (unlikely useful, but avoids empty)

$checkScript = Join-Path $PSScriptRoot 'watchdog-check.ps1'
$argument = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$checkScript`" -Exe `"$Exe`" -Project `"$Project`""
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $argument

# At-logon trigger, grafted with a 1-minute repetition for the full session (Task Scheduler has no
# native "every minute forever" trigger, so we borrow a Once trigger's Repetition block).
$logon = New-ScheduledTaskTrigger -AtLogOn
$pulse = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 1) -RepetitionDuration (New-TimeSpan -Days 3650)
$logon.Repetition = $pulse.Repetition

# Keep it running on a show machine: survive battery, start when available, never time out, and never
# stack instances (the check exits fast if the app is already up).
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Seconds 0)
# Interactive logon so the relaunched app can open windows on the operator's desktop session.
$taskPrincipal = New-ScheduledTaskPrincipal -UserId $identity.Name -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $logon -Settings $settings -Principal $taskPrincipal -Force | Out-Null
Write-Host "Registered scheduled task '$TaskName' (logon + every 1 min) → $Exe $Project"
