param([string]$App, [string]$Project, [string]$Work)
# E1a probe on the PACKAGED app, no CDP: processes and the machine log only.
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force $Work | Out-Null
$prefs = Join-Path $env:APPDATA 'ArtLux\artlux-prefs.json'
$bak = Join-Path $Work 'prefs.bak'
Copy-Item $prefs $bak -Force
$fails = 0
function Note($ok, $what) { if (-not $ok) { $script:fails++ }; "$(if ($ok) {'ok  '} else {'FAIL'}) $what" }
# ⚠ callers wrap in @(): PowerShell 5.1 unrolls a one-element array on return, and a lone
# PSCustomObject has no .Count there.
function Engines { @(Get-CimInstance Win32_Process -Filter "Name='artlux-engine.exe'" | Select-Object ProcessId, ParentProcessId) }
function AppPids { @(Get-Process -Name ArtLux -ErrorAction SilentlyContinue | ForEach-Object { $_.Id }) }
# The first engine whose pid is not $notPid, waiting up to $ms. (Plain loop: a scriptblock helper
# returned nothing under this host.)
function WaitEngine([int]$notPid, [int]$ms) {
  $t = Get-Date
  while (((Get-Date) - $t).TotalMilliseconds -lt $ms) {
    $e = @(@(Engines) | Where-Object { $_.ProcessId -ne $notPid })
    if ($e.Count -ge 1) { return $e[0] }
    Start-Sleep -Milliseconds 100
  }
  return $null
}
function WaitNoEngine([int]$ms) {
  $t = Get-Date
  while (((Get-Date) - $t).TotalMilliseconds -lt $ms) { if (@(Engines).Count -eq 0) { return $true }; Start-Sleep -Milliseconds 100 }
  return $false
}
function StopApp { Get-Process -Name ArtLux -ErrorAction SilentlyContinue | Stop-Process -Force; Start-Sleep -Seconds 2 }
try {
  StopApp
  # A. Without the flag: no engine.
  $p = Start-Process -FilePath $App -ArgumentList "--project=$Project" -PassThru
  Start-Sleep -Seconds 12
  Note (@(Engines).Count -eq 0) "without --native-engine, no engine process (the app is what it was)"
  StopApp

  # B. With the flag, and the one-shot hang file.
  $hang = Join-Path $Work 'hang-once'
  Set-Content $hang 'x'
  $env:ARTLUX_ENGINE_TEST_HANG_FILE = $hang
  $t0 = Get-Date
  $p = Start-Process -FilePath $App -ArgumentList "--project=$Project", '--native-engine' -PassThru
  $e1 = WaitEngine -1 20000
  Note ([bool]$e1) "with --native-engine, the engine starts as a child of ArtLux (pid $($e1.ProcessId), parent $($e1.ParentProcessId), app pids $((AppPids) -join ','))"
  $isChild = $e1 -and ((AppPids) -contains [int]$e1.ParentProcessId)
  Note $isChild "its parent is the ArtLux main process"
  # The first engine stops answering 2 s after its hello; main must kill it and start another.
  $e2 = if ($e1) { WaitEngine $e1.ProcessId 20000 } else { $null }
  Note ([bool]$e2) "a HUNG engine (alive, not answering) is killed and replaced (pid $($e1.ProcessId) -> $($e2.ProcessId))"
  Note (-not (Test-Path $hang)) "the hang hook was one-shot (its file consumed)"
  Start-Sleep -Seconds 3
  $still = @(Engines)
  Note ($e2 -and $still.Count -eq 1 -and $still[0].ProcessId -eq $e2.ProcessId) "the replacement stays up (answers its pings)"
  # A crash: kill it outright.
  $tk = Get-Date
  if ($e2) { Stop-Process -Id $e2.ProcessId -Force }
  $e3 = if ($e2) { WaitEngine $e2.ProcessId 5000 } else { $null }
  $back = [int]((Get-Date) - $tk).TotalMilliseconds
  Note ([bool]$e3) "a KILLED engine is restarted (pid $($e2.ProcessId) -> $($e3.ProcessId), process seen again after ~$back ms)"
  # Quit the app the way an operator does: close its main window.
  Start-Sleep -Seconds 2
  foreach ($a in Get-Process -Name ArtLux -ErrorAction SilentlyContinue) { if ($a.MainWindowHandle -ne 0) { [void]$a.CloseMainWindow() } }
  $gone = WaitNoEngine 10000
  Note ([bool]$gone) "closing ArtLux takes the engine with it"
  StopApp
  # The machine log of that run.
  $log = Get-ChildItem (Join-Path $env:APPDATA 'ArtLux\logs') -Filter 'artlux-*.log' | Where-Object { $_.LastWriteTime -gt $t0 } | Sort-Object LastWriteTime | Select-Object -Last 1
  $lines = if ($log) { Get-Content $log.FullName | Where-Object { $_ -match '"cat":"engine"' } } else { @() }
  "--- machine log ($($log.Name)), category engine:"
  $lines | ForEach-Object { $_.Substring(0, [Math]::Min(220, $_.Length)) }
  $evs = $lines | ForEach-Object { if ($_ -match '"ev":"([a-z-]+)"') { $Matches[1] } }
  Note (($evs -contains 'enabled') -and (($evs | Where-Object { $_ -eq 'up' }).Count -ge 3) -and ($evs -contains 'hung') -and ($evs -contains 'exited')) "the machine log records enabled, up (x3), hung and exited"
} finally {
  Remove-Item Env:ARTLUX_ENGINE_TEST_HANG_FILE -ErrorAction SilentlyContinue
  StopApp
  Get-Process -Name artlux-engine -ErrorAction SilentlyContinue | Stop-Process -Force
  Copy-Item $bak $prefs -Force
  "prefs restored"
}
"FAILS=$fails"
