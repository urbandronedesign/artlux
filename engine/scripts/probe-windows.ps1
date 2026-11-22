param([string]$Exe, [string]$Mode = '', [string]$Out)
# E0b PROBE — the engine's windows, read from the SCREEN (Windows). No hooks into the engine.
#   powershell -File engine/scripts/probe-windows.ps1 -Exe engine/target/release/artlux-engine.exe -Out <dir>
#   [-Mode --fullscreen]   (covers the display for ~6 s)        set ARTLUX_ENGINE_BACKEND=vulkan for Vulkan
# Claims: a visible engine window appears; each test-card quadrant is its exact colour on screen; the
# live bar moves between two captures; the engine exits at its deadline; and closing its window (a
# WM_CLOSE to the window FOUND BY TITLE — Process.MainWindowHandle can be winit's hidden helper
# window, which is how a first version of this test closed the wrong window and reported a hang).
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System; using System.Text; using System.Runtime.InteropServices; using System.Collections.Generic;
public static class W2 {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc p, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref POINT p);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int cx, int cy, uint f);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  public static List<IntPtr> All() { var l = new List<IntPtr>(); EnumWindows((h, x) => { l.Add(h); return true; }, IntPtr.Zero); return l; }
}
"@
[void][W2]::SetProcessDPIAware()
New-Item -ItemType Directory -Force $Out | Out-Null
$log = Join-Path $Out "engine$Mode.log"
$argList = @('--windows', '--seconds', '6') + $(if ($Mode) { @($Mode) } else { @() })
$p = Start-Process -FilePath $Exe -ArgumentList $argList -PassThru -RedirectStandardOutput $log -RedirectStandardError "$log.err"
$t0 = Get-Date
$h = [IntPtr]::Zero
while (((Get-Date) - $t0).TotalSeconds -lt 5 -and $h -eq [IntPtr]::Zero) {
  foreach ($x in [W2]::All()) {
    [uint32]$wp = 0; [void][W2]::GetWindowThreadProcessId($x, [ref]$wp)
    if ([int]$wp -ne $p.Id -or -not [W2]::IsWindowVisible($x)) { continue }
    $sb = New-Object System.Text.StringBuilder 256; [void][W2]::GetWindowText($x, $sb, 256)
    if ($sb.ToString() -like 'ArtLux engine*') { $h = $x; $title = $sb.ToString() }
  }
  Start-Sleep -Milliseconds 100
}
if ($h -eq [IntPtr]::Zero) { "FAIL no visible engine window"; exit 1 }
"visible after $([int]((Get-Date) - $t0).TotalMilliseconds) ms: '$title'"
[void][W2]::SetWindowPos($h, [IntPtr](-1), 0, 0, 0, 0, 0x0003)
Start-Sleep -Milliseconds 1200
$r = New-Object W2+RECT; [void][W2]::GetClientRect($h, [ref]$r)
$o = New-Object W2+POINT; [void][W2]::ClientToScreen($h, [ref]$o)
$w = $r.R; $hh = $r.B
"client area ${w}x${hh} at $($o.X),$($o.Y)"
function Grab($name) {
  $bmp = New-Object System.Drawing.Bitmap $w, $hh
  $g = [System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($o.X, $o.Y, 0, 0, $bmp.Size); $g.Dispose()
  $bmp.Save((Join-Path $Out "$name.png"), [System.Drawing.Imaging.ImageFormat]::Png)
  return $bmp
}
$a = Grab "card$Mode-a"
Start-Sleep -Milliseconds 300
$b = Grab "card$Mode-b"
[void][W2]::SetWindowPos($h, [IntPtr](-2), 0, 0, 0, 0, 0x0003)
$fails = 0
$want = @(@(0.25, 0.34, 255, 0, 0, 'red'), @(0.75, 0.34, 0, 255, 0, 'green'), @(0.25, 0.78, 0, 0, 255, 'blue'), @(0.75, 0.78, 255, 255, 255, 'white'))
foreach ($q in $want) {
  $c = $a.GetPixel([int]($w * $q[0]), [int]($hh * $q[1]))
  $ok = ($c.R -eq $q[2] -and $c.G -eq $q[3] -and $c.B -eq $q[4])
  if (-not $ok) { $fails++ }
  "$(if ($ok) {'ok  '} else {'FAIL'}) $($q[5]) quadrant: ($($c.R),$($c.G),$($c.B))"
}
function BarX($bmp) {
  $y = [int]($hh * 0.06)
  for ($x = 0; $x -lt $w; $x++) { $c = $bmp.GetPixel($x, $y); if ($c.R -gt 200 -and $c.G -lt 50 -and $c.B -gt 200) { return $x } }
  return -1
}
$xa = BarX $a; $xb = BarX $b
$live = ($xa -ge 0 -and $xb -ge 0 -and $xa -ne $xb)
if (-not $live) { $fails++ }
"$(if ($live) {'ok  '} else {'FAIL'}) live: the bar moved between two captures ($xa -> $xb)"
$a.Dispose(); $b.Dispose()
[void]$p.WaitForExit(10000)
$gone = $p.HasExited
if (-not $gone) { $fails++; Stop-Process -Id $p.Id -Force }
"$(if ($gone) {'ok  '} else {'FAIL'}) the engine closed its windows and exited at its deadline (exit $($p.ExitCode))"
"--- engine stdout:"; Get-Content $log; Get-Content "$log.err" -ErrorAction SilentlyContinue
# Closing the window ends the engine (no deadline: only the close can end it).
$p2 = Start-Process -FilePath $Exe -ArgumentList @('--windows') -PassThru
$h2 = [IntPtr]::Zero
for ($i = 0; $i -lt 50 -and $h2 -eq [IntPtr]::Zero; $i++) {
  Start-Sleep -Milliseconds 100
  foreach ($x in [W2]::All()) {
    [uint32]$wp = 0; [void][W2]::GetWindowThreadProcessId($x, [ref]$wp)
    if ([int]$wp -ne $p2.Id -or -not [W2]::IsWindowVisible($x)) { continue }
    $sb = New-Object System.Text.StringBuilder 256; [void][W2]::GetWindowText($x, $sb, 256)
    if ($sb.ToString() -like 'ArtLux engine*') { $h2 = $x }
  }
}
Start-Sleep -Seconds 1
[void][W2]::PostMessage($h2, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)
$closed = $p2.WaitForExit(5000)
if (-not $closed) { $fails++; Stop-Process -Id $p2.Id -Force }
"$(if ($closed) {'ok  '} else {'FAIL'}) closing its window ends the engine"
"FAILS=$fails"
if ($fails) { exit 1 }
