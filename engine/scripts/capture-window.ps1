param([int]$ProcId, [string]$Name, [string]$Out, [int]$WaitMs = 1500)
# Capture one engine window's CLIENT AREA from the SCREEN (Windows) — no hooks into the engine. Used by
# scripts/test-projector-windows.cjs. Finds the window by TITLE among the process's visible windows
# (Process.MainWindowHandle can be winit's hidden helper — probe-windows.ps1 learned that), raises it
# topmost so nothing covers it, waits for presents to settle, grabs it to a PNG, then lowers it again.
# Prints one line: "<x> <y> <w> <h>" — the client area's screen rectangle, physical pixels.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System; using System.Text; using System.Runtime.InteropServices; using System.Collections.Generic;
public static class W3 {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc p, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref POINT p);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int cx, int cy, uint f);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  public static List<IntPtr> All() { var l = new List<IntPtr>(); EnumWindows((h, x) => { l.Add(h); return true; }, IntPtr.Zero); return l; }
}
"@
[void][W3]::SetProcessDPIAware()
$h = [IntPtr]::Zero
$t0 = Get-Date
while (((Get-Date) - $t0).TotalSeconds -lt 6 -and $h -eq [IntPtr]::Zero) {
  foreach ($x in [W3]::All()) {
    [uint32]$wp = 0; [void][W3]::GetWindowThreadProcessId($x, [ref]$wp)
    if ([int]$wp -ne $ProcId -or -not [W3]::IsWindowVisible($x)) { continue }
    $sb = New-Object System.Text.StringBuilder 256; [void][W3]::GetWindowText($x, $sb, 256)
    if ($sb.ToString() -like "ArtLux output*$Name") { $h = $x }   # the name only: an em dash does not survive every console code page
  }
  if ($h -eq [IntPtr]::Zero) { Start-Sleep -Milliseconds 100 }
}
if ($h -eq [IntPtr]::Zero) { "NOWINDOW"; exit 0 }   # an answer, not an error: "no window" is what a refusal test expects
[void][W3]::SetWindowPos($h, [IntPtr](-1), 0, 0, 0, 0, 0x0003)
Start-Sleep -Milliseconds $WaitMs
$r = New-Object W3+RECT; [void][W3]::GetClientRect($h, [ref]$r)
$o = New-Object W3+POINT; [void][W3]::ClientToScreen($h, [ref]$o)
$bmp = New-Object System.Drawing.Bitmap $r.R, $r.B
$g = [System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($o.X, $o.Y, 0, 0, $bmp.Size); $g.Dispose()
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose()
[void][W3]::SetWindowPos($h, [IntPtr](-2), 0, 0, 0, 0, 0x0003)
"$($o.X) $($o.Y) $($r.R) $($r.B)"
