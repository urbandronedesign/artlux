<#
.SYNOPSIS
  ArtLux dependency preflight -- reports every missing dependency BEFORE (or after) an install.

.DESCRIPTION
  Two modes, one script:

    -Mode runtime   a venue / show PC that only runs the packaged installer. Checks the things that
                    make ArtLux features silently vanish: the VC++ runtime, the NDI Runtime, a real
                    D3D12 GPU, an audio output device, firewall/network posture -- and, if ArtLux is
                    already installed, an audit of resources/ plus a PE import-table check on every
                    native addon.

    -Mode dev       a machine that clones the repo and builds. Checks Node/Rust/MSVC/CMake and the
                    optional OpenCV + LLVM + NDI SDK toolchains, plus whether the repo currently holds
                    the artifacts a correct `npm run package` requires.

  Why this exists: every native module in ArtLux degrades gracefully by design (a missing addon logs
  one line to the main-process console and disables its feature -- never a crash). That is right for
  robustness and terrible for diagnosis: installing on a second machine produced an app with no NDI and
  no calibration, and nothing on screen said so. This script makes that state visible.

  Each check reports PASS / WARN / FAIL with a concrete remedy. Exit code is 1 if anything FAILed, so
  it can gate CI or an install script.

.PARAMETER Mode
  runtime | dev | all   (default: all)

.PARAMETER Json
  Emit the results as JSON on stdout instead of a table (for CI or the installer's post-install report).

.PARAMETER OutFile
  Also write the JSON report to this path. The installer points this at %APPDATA%\artlux\preflight.json.

.PARAMETER Fix
  Attempt to install the two redistributables via winget (VC++ runtime, NDI Runtime). Nothing else is
  ever modified -- no firewall rules, no drivers.

.PARAMETER InstallDir
  Explicit ArtLux install directory. Auto-detected from the uninstall registry keys when omitted.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File preflight.ps1 -Mode runtime
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File preflight.ps1 -Mode all -Json -OutFile report.json
#>
[CmdletBinding()]
param(
  [ValidateSet('runtime', 'dev', 'all')]
  [string]$Mode = 'all',
  [switch]$Json,
  [string]$OutFile = '',
  [switch]$Fix,
  [string]$InstallDir = ''
)

$ErrorActionPreference = 'Continue'   # a broken individual check must never abort the whole report
$ProgressPreference = 'SilentlyContinue'

# ---------------------------------------------------------------------------------------------------
# Result collection
# ---------------------------------------------------------------------------------------------------

$script:Results = New-Object System.Collections.Generic.List[object]

function Add-Result {
  param(
    [string]$Group,
    [string]$Id,
    [string]$Name,
    [ValidateSet('PASS', 'WARN', 'FAIL', 'SKIP')][string]$Status,
    [string]$Detail = '',
    [string]$Remedy = ''
  )
  $script:Results.Add([pscustomobject]@{
      group  = $Group
      id     = $Id
      name   = $Name
      status = $Status
      detail = $Detail
      remedy = $Remedy
    })
}

# Ports ArtLux listens on / sends to. Kept in sync with:
#   Art-Net 6454, sACN 5568 (docs/OUTPUTS.md) - OSC 10000 (docs/OSC.md) - show-control 8788
#   (plugins/show-control/src/types.ts DEFAULT_PORT).
$script:Ports = @(
  @{ Port = 6454; Proto = 'UDP'; Name = 'Art-Net' },
  @{ Port = 5568; Proto = 'UDP'; Name = 'sACN (E1.31)' },
  @{ Port = 10000; Proto = 'UDP'; Name = 'OSC / LiDAR tracking' },
  @{ Port = 8788; Proto = 'TCP'; Name = 'Show-control tablet server' }
)

# The complete set of files electron-builder is declared to place in resources/. Sourced from
# package.json build.extraResources + build.win.extraResources -- keep in sync (verify-package-resources.cjs
# checks the build side of the same contract).
$script:ExpectedResources = @(
  @{ File = 'output-engine.node'; What = 'Art-Net / sACN output engine'; Critical = $true },
  @{ File = 'audio-engine.node'; What = 'JUCE audio engine (all sound)'; Critical = $true },
  @{ File = 'spout-receiver.node'; What = 'Spout GPU video receive'; Critical = $false },
  @{ File = 'hap.node'; What = 'HAP video codec'; Critical = $false },
  @{ File = 'ndi.node'; What = 'NDI send/receive'; Critical = $false },
  @{ File = 'calib.node'; What = 'OpenCV projector calibration'; Critical = $false },
  @{ File = 'opencv_world4110.dll'; What = 'OpenCV runtime (required by calib.node)'; Critical = $false },
  @{ File = 'nvwarp.node'; What = 'NVIDIA scanout warp/blend'; Critical = $false }
)

function Test-Admin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  return (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

# ---------------------------------------------------------------------------------------------------
# PE import-table reader
#
# The check that would have caught this whole class of bug: a native addon can be PRESENT and still fail
# to load because a DLL it imports is not resolvable -- exactly what happens to calib.node when
# opencv_world4110.dll was never staged, or to any .node when the VC++ runtime is absent. existsSync-style
# checks miss it entirely, and actually LoadLibrary'ing a .node outside Node fails for unrelated reasons
# (napi addons import from node.exe), so we read the import directory out of the PE header instead.
# ---------------------------------------------------------------------------------------------------

function Get-PEImports {
  param([string]$Path)
  try {
    $b = [System.IO.File]::ReadAllBytes($Path)
    if ($b.Length -lt 0x40 -or $b[0] -ne 0x4D -or $b[1] -ne 0x5A) { return $null }   # 'MZ'
    $peOff = [BitConverter]::ToInt32($b, 0x3C)
    if ($peOff -le 0 -or ($peOff + 24) -ge $b.Length) { return $null }
    if ($b[$peOff] -ne 0x50 -or $b[$peOff + 1] -ne 0x45) { return $null }            # 'PE'

    $numSections = [BitConverter]::ToUInt16($b, $peOff + 6)
    $sizeOptHdr = [BitConverter]::ToUInt16($b, $peOff + 20)
    $optOff = $peOff + 24
    $magic = [BitConverter]::ToUInt16($b, $optOff)
    # Data directories sit after the optional header's fixed part: 112 bytes for PE32+, 96 for PE32.
    $ddOff = if ($magic -eq 0x20B) { $optOff + 112 } elseif ($magic -eq 0x10B) { $optOff + 96 } else { return $null }
    $importRva = [BitConverter]::ToUInt32($b, $ddOff + 8)   # data directory [1] = import table
    if ($importRva -eq 0) { return @() }

    # Section table -> RVA-to-file-offset mapping.
    $secOff = $optOff + $sizeOptHdr
    $sections = @()
    for ($i = 0; $i -lt $numSections; $i++) {
      $s = $secOff + ($i * 40)
      if (($s + 40) -gt $b.Length) { break }
      $sections += [pscustomobject]@{
        VA  = [BitConverter]::ToUInt32($b, $s + 12)
        Sz  = [BitConverter]::ToUInt32($b, $s + 16)
        Raw = [BitConverter]::ToUInt32($b, $s + 20)
      }
    }
    function Convert-Rva([uint32]$rva) {
      foreach ($s in $sections) {
        if ($rva -ge $s.VA -and $rva -lt ($s.VA + [Math]::Max($s.Sz, 1))) { return [int]($s.Raw + ($rva - $s.VA)) }
      }
      return -1
    }

    $names = New-Object System.Collections.Generic.List[string]
    $desc = Convert-Rva $importRva
    if ($desc -lt 0) { return @() }
    # IMAGE_IMPORT_DESCRIPTOR is 20 bytes; the array ends at an all-zero entry. Name RVA is at +12.
    while (($desc + 20) -le $b.Length) {
      $nameRva = [BitConverter]::ToUInt32($b, $desc + 12)
      if ($nameRva -eq 0) { break }
      $n = Convert-Rva $nameRva
      if ($n -lt 0) { break }
      $sb = New-Object System.Text.StringBuilder
      while ($n -lt $b.Length -and $b[$n] -ne 0) { [void]$sb.Append([char]$b[$n]); $n++ }
      if ($sb.Length -gt 0) { [void]$names.Add($sb.ToString()) }
      $desc += 20
    }
    return $names.ToArray()
  } catch {
    return $null
  }
}

# Directories ArtLux itself adds to the DLL search path at runtime before loading an addon. Without
# these the NDI check is a false positive: ndiManager.ts's ensureNdiOnPath() prepends the NDI runtime
# dir to process.env.PATH precisely because the NDI installer does NOT put it on the system PATH, so
# Processing.NDI.Lib.x64.dll looks unresolvable to an outside observer while resolving fine in the app.
$script:ExtraDllDirs = New-Object System.Collections.Generic.List[string]

# Can Windows find this DLL? Mirrors the search order that matters for a Node addon: the addon's own
# directory (Node dlopens with LOAD_WITH_ALTERED_SEARCH_PATH, so this one counts), the dirs ArtLux
# injects itself, System32, then PATH.
function Test-DllResolvable {
  param([string]$Dll, [string]$NearDir)
  if ($NearDir -and (Test-Path (Join-Path $NearDir $Dll))) { return $true }
  foreach ($d in $script:ExtraDllDirs) {
    if ($d -and (Test-Path (Join-Path $d $Dll) -ErrorAction SilentlyContinue)) { return $true }
  }
  foreach ($d in @("$env:SystemRoot\System32", "$env:SystemRoot")) {
    if (Test-Path (Join-Path $d $Dll)) { return $true }
  }
  foreach ($d in ($env:PATH -split ';')) {
    if ($d -and (Test-Path (Join-Path $d $Dll) -ErrorAction SilentlyContinue)) { return $true }
  }
  return $false
}

# Imports every addon has and that are never a problem: the Node host provides its own exports, and
# api-ms-* are API-set contract stubs resolved by the loader, not real files on disk.
function Test-IgnorableImport {
  param([string]$Dll)
  $d = $Dll.ToLowerInvariant()
  return ($d -eq 'node.exe' -or $d -eq 'electron.exe' -or $d.StartsWith('api-ms-') -or $d.StartsWith('ext-ms-'))
}

# ---------------------------------------------------------------------------------------------------
# RUNTIME checks
# ---------------------------------------------------------------------------------------------------

function Find-ArtLuxInstall {
  if ($InstallDir) { return $InstallDir }
  # Each Uninstall hive paired with the SOFTWARE root holding electron-builder's PRODUCT key.
  #
  # WHY THE PRODUCT KEY, and why this used to be broken: electron-builder's NSIS writes the Uninstall
  # entry with an EMPTY InstallLocation, and puts the real path in
  #   HK__:\SOFTWARE\<product-guid>\InstallLocation
  # where <product-guid> is the Uninstall subkey's OWN NAME (a UUIDv5 of the appId, so it is stable
  # across versions). This function required a non-empty InstallLocation on the Uninstall entry, so
  # the registry branch never matched on ANY real install -- verified against a live 0.25.0 install,
  # where InstallLocation is '' and the product key reads 'C:\Program Files\ArtLux'.
  #
  # It "worked" only by falling through to the path guesses at the bottom, which is not the same
  # thing: those return the FIRST location that exists, so on a machine carrying both a legacy
  # per-user install and a current per-machine one (the double-install state docs/INSTALL.md warns
  # about) every res.*/imp.* check silently audited the WRONG directory.
  $roots = @(
    @{ Uninstall = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*';             Product = 'HKLM:\SOFTWARE' },
    @{ Uninstall = 'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*';             Product = 'HKCU:\SOFTWARE' },
    @{ Uninstall = 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'; Product = 'HKLM:\SOFTWARE\WOW6432Node' }
  )
  foreach ($r in $roots) {
    $hit = Get-ItemProperty $r.Uninstall -ErrorAction SilentlyContinue |
      Where-Object { $_.DisplayName -like 'ArtLux*' } | Select-Object -First 1
    if (-not $hit) { continue }
    # 1. InstallLocation on the Uninstall entry -- empty today, but honour it if it is ever populated.
    if ($hit.InstallLocation -and (Test-Path $hit.InstallLocation)) { return $hit.InstallLocation }
    # 2. The product key named after this Uninstall subkey. This is where the path actually lives.
    $prod = Get-ItemProperty (Join-Path $r.Product $hit.PSChildName) -ErrorAction SilentlyContinue
    if ($prod -and $prod.InstallLocation -and (Test-Path $prod.InstallLocation)) { return $prod.InstallLocation }
    # 3. DisplayIcon is '<dir>\ArtLux.exe,0' -- drop the icon index, take the directory.
    if ($hit.DisplayIcon) {
      $exe = ($hit.DisplayIcon -split ',')[0].Trim('"')
      if ($exe -and (Test-Path $exe)) { return (Split-Path -Parent $exe) }
    }
  }
  # Last resort only: the NSIS per-user default and the common per-machine location. Reaching here
  # means no registry entry matched, so this is a guess -- see the double-install caveat above.
  foreach ($p in @("$env:LOCALAPPDATA\Programs\ArtLux", "$env:LOCALAPPDATA\Programs\artlux", "$env:ProgramFiles\ArtLux")) {
    if (Test-Path $p) { return $p }
  }
  return ''
}

function Invoke-RuntimeChecks {
  # NOTE: named $Grp, not $G. PowerShell variable names are case-INSENSITIVE, so a $G here is the SAME
  # variable as the `foreach ($g in $real)` GPU loop below -- which silently overwrote the group name
  # with a CIM object and split the report into bogus sections.
  $Grp = 'Runtime'

  # --- OS ---
  $osi = Get-CimInstance Win32_OperatingSystem -ErrorAction SilentlyContinue
  if ($osi) {
    $build = [int]($osi.BuildNumber)
    $arch = $osi.OSArchitecture
    if ($arch -notlike '*64*') {
      Add-Result $Grp 'os.arch' 'Windows 64-bit' 'FAIL' "OS architecture is $arch" 'ArtLux ships x64 only.'
    } elseif ($build -lt 19044) {
      Add-Result $Grp 'os.version' 'Windows version' 'WARN' "$($osi.Caption) build $build" 'Electron 42 targets Windows 10 21H2 (19044) or newer. Older builds are untested.'
    } else {
      Add-Result $Grp 'os.version' 'Windows version' 'PASS' "$($osi.Caption) build $build, $arch"
    }
  } else {
    Add-Result $Grp 'os.version' 'Windows version' 'WARN' 'could not query Win32_OperatingSystem'
  }

  # --- VC++ 2015-2022 x64 redistributable ---
  # Every MSVC-built addon (all six .node files) and opencv_world4110.dll link the dynamic CRT.
  $vcKey = 'HKLM:\SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64'
  $vc = Get-ItemProperty $vcKey -ErrorAction SilentlyContinue
  if ($vc -and $vc.Installed -eq 1) {
    $ver = "$($vc.Major).$($vc.Minor).$($vc.Bld)"
    Add-Result $Grp 'vcredist' 'VC++ 2015-2022 x64 runtime' 'PASS' "v$ver"
  } elseif (Test-DllResolvable 'VCRUNTIME140_1.dll' '') {
    Add-Result $Grp 'vcredist' 'VC++ 2015-2022 x64 runtime' 'WARN' 'registry key absent but VCRUNTIME140_1.dll resolves' 'Probably fine; install the redistributable to be certain.'
  } else {
    Add-Result $Grp 'vcredist' 'VC++ 2015-2022 x64 runtime' 'FAIL' 'not installed' 'winget install --id Microsoft.VCRedist.2015+.x64  -- or let the ArtLux installer do it. Without it EVERY native addon fails to load.'
  }

  # --- NDI Runtime (failure #1 from the second-machine install) ---
  # Mirrors ensureNdiOnPath() in plugins/ndi/src/ndiManager.ts.
  $sdkBin = if ($env:NDI_SDK_DIR) { Join-Path $env:NDI_SDK_DIR 'Bin\x64' } else { $null }
  $ndiDirs = @($env:NDI_RUNTIME_DIR_V6, $env:NDI_RUNTIME_DIR_V5, 'C:\Program Files\NDI\NDI 6 Runtime\v6', $sdkBin) |
    Where-Object { $_ -and (Test-Path $_) }
  $ndiReg = (Get-ItemProperty 'HKLM:\SOFTWARE\NDI\NDI Runtime' -ErrorAction SilentlyContinue).Version
  $ndiDll = $null
  foreach ($d in $ndiDirs) {
    $c = Join-Path $d 'Processing.NDI.Lib.x64.dll'
    if (Test-Path $c) {
      $ndiDll = $c
      # The app injects this dir before require()ing ndi.node, so the import audit below must too.
      $script:ExtraDllDirs.Add($d)
      break
    }
  }
  if ($ndiDll) {
    Add-Result $Grp 'ndi.runtime' 'NDI Runtime' 'PASS' "$ndiDll$(if ($ndiReg) { " (v$ndiReg)" })"
  } elseif ($ndiDirs -or $ndiReg) {
    Add-Result $Grp 'ndi.runtime' 'NDI Runtime' 'WARN' 'registered but Processing.NDI.Lib.x64.dll not found' 'Reinstall the NDI 6 Runtime -- the registration is stale.'
  } else {
    Add-Result $Grp 'ndi.runtime' 'NDI Runtime' 'FAIL' 'not installed (no NDI_RUNTIME_DIR_V6, no registry entry)' 'winget install --id NDI.NDIRuntime  -- or https://ndi.link/NDIRedistV6. Without it ndi.node loads but runtimeAvailable() is false and all NDI sources/outputs disappear from the UI.'
  }

  # --- Installed ArtLux: resources audit (failure #2) ---
  $dir = Find-ArtLuxInstall
  if (-not $dir) {
    Add-Result $Grp 'install.found' 'ArtLux installation' 'SKIP' 'not installed yet' 'Re-run this check after installing to audit resources/.'
  } else {
    $res = Join-Path $dir 'resources'
    Add-Result $Grp 'install.found' 'ArtLux installation' 'PASS' $dir
    if (-not (Test-Path $res)) {
      Add-Result $Grp 'install.resources' 'resources/ directory' 'FAIL' "missing: $res" 'The install is corrupt -- reinstall.'
    } else {
      foreach ($r in $script:ExpectedResources) {
        $p = Join-Path $res $r.File
        if (Test-Path $p) {
          Add-Result $Grp "res.$($r.File)" "resources/$($r.File)" 'PASS' "$([Math]::Round((Get-Item $p).Length / 1MB, 1)) MB -- $($r.What)"
        } else {
          $st = if ($r.Critical) { 'FAIL' } else { 'WARN' }
          Add-Result $Grp "res.$($r.File)" "resources/$($r.File)" $st "MISSING -- $($r.What) is dead" 'This installer was built without the file (electron-builder skips a missing extraResources path silently). Rebuild with npm run fetch:opencv / fetch:redist, or install a newer release.'
        }
      }

      # PE import audit on every addon actually present.
      foreach ($r in $script:ExpectedResources) {
        if ($r.File -notlike '*.node') { continue }
        $p = Join-Path $res $r.File
        if (-not (Test-Path $p)) { continue }
        $imports = Get-PEImports $p
        if ($null -eq $imports) {
          Add-Result $Grp "imp.$($r.File)" "$($r.File) imports" 'WARN' 'could not parse the PE header'
          continue
        }
        $bad = @()
        foreach ($dll in $imports) {
          if (Test-IgnorableImport $dll) { continue }
          if (-not (Test-DllResolvable $dll $res)) { $bad += $dll }
        }
        if ($bad.Count -eq 0) {
          Add-Result $Grp "imp.$($r.File)" "$($r.File) imports" 'PASS' "$($imports.Count) imports, all resolvable"
        } else {
          $st = if ($r.Critical) { 'FAIL' } else { 'WARN' }
          Add-Result $Grp "imp.$($r.File)" "$($r.File) imports" $st "unresolvable: $($bad -join ', ')" 'The addon is present but will throw on require() and its feature will be silently disabled. Install the missing runtime (VC++ redist / NDI Runtime), or the DLL is missing from the installer.'
        }
      }
    }
  }

  # --- GPU / WebGPU ---
  # The whole frame pipeline is WebGPU compute (renderer/gpu/WebGPUMapper). A software adapter means
  # the app "works" at unusable frame rates.
  $gpus = @(Get-CimInstance Win32_VideoController -ErrorAction SilentlyContinue)
  if (-not $gpus) {
    Add-Result $Grp 'gpu.present' 'GPU' 'WARN' 'no video controller reported'
  } else {
    $real = $gpus | Where-Object { $_.Name -notmatch 'Basic Display|Basic Render|Remote Display|Standard VGA' }
    if (-not $real) {
      Add-Result $Grp 'gpu.present' 'GPU' 'FAIL' "only a fallback adapter: $($gpus[0].Name)" 'Install the vendor GPU driver. WebGPU compute (the entire pixel-mapping pipeline) needs a real D3D12 adapter.'
    } else {
      foreach ($g in $real) {
        $dd = $null
        if ($g.DriverDate) { try { $dd = [Management.ManagementDateTimeConverter]::ToDateTime($g.DriverDate) } catch { $dd = $null } }
        $age = if ($dd) { " driver $($g.DriverVersion) ($($dd.ToString('yyyy-MM-dd')))" } else { " driver $($g.DriverVersion)" }
        if ($dd -and $dd -lt (Get-Date).AddYears(-2)) {
          Add-Result $Grp "gpu.$($g.DeviceID)" 'GPU' 'WARN' "$($g.Name) --$age" 'Driver is over 2 years old; update it before trusting WebGPU behaviour.'
        } else {
          Add-Result $Grp "gpu.$($g.DeviceID)" 'GPU' 'PASS' "$($g.Name) --$age"
        }
      }
      if (($real | Where-Object { $_.Name -match 'NVIDIA|Quadro|RTX' }).Count -eq 0) {
        Add-Result $Grp 'gpu.nvidia' 'NVIDIA (nvwarp)' 'SKIP' 'no NVIDIA adapter' 'Hardware scanout warp/blend (nvwarp) needs a Quadro/RTX card; everything else works without it.'
      }
    }
  }

  # Remote sessions do not get a real GPU -- a very common way a "working" show PC fails when driven over RDP.
  if ($env:SESSIONNAME -like 'RDP-*') {
    Add-Result $Grp 'gpu.session' 'Session type' 'WARN' 'running inside an RDP session' 'GPU results above are the RDP adapter, not the physical one. Re-run at the console.'
  }

  # --- Audio output ---
  # plugins/audio degrades to silence with no error; no output device looks identical to a bug.
  $snd = @(Get-CimInstance Win32_SoundDevice -ErrorAction SilentlyContinue | Where-Object { $_.Status -eq 'OK' })
  if ($snd.Count -gt 0) {
    Add-Result $Grp 'audio.device' 'Audio output device' 'PASS' "$($snd.Count) active device(s): $(($snd | Select-Object -First 3 | ForEach-Object { $_.Name }) -join '; ')"
  } else {
    Add-Result $Grp 'audio.device' 'Audio output device' 'WARN' 'no enabled audio device found' 'The audio UI will render and play nothing, with no error. Enable an output device (WASAPI exclusive is the supported multichannel path).'
  }

  # --- Network posture ---
  $profiles = @(Get-NetConnectionProfile -ErrorAction SilentlyContinue)
  foreach ($p in $profiles) {
    if ($p.NetworkCategory -eq 'Public') {
      Add-Result $Grp "net.profile.$($p.InterfaceIndex)" "Network profile: $($p.Name)" 'WARN' 'Public' 'Windows Firewall blocks most inbound traffic on Public networks -- OSC and the show-control tablet page will not be reachable. Set the show network to Private.'
    } else {
      Add-Result $Grp "net.profile.$($p.InterfaceIndex)" "Network profile: $($p.Name)" 'PASS' $p.NetworkCategory
    }
  }

  $upNics = @(Get-NetIPConfiguration -ErrorAction SilentlyContinue | Where-Object { $_.NetAdapter.Status -eq 'Up' -and $_.IPv4Address })
  if ($upNics.Count -eq 0) {
    Add-Result $Grp 'net.nic' 'Network adapters' 'FAIL' 'no adapter with an IPv4 address is up' 'Art-Net/sACN output needs an IPv4 interface on the lighting network.'
  } elseif ($upNics.Count -gt 1) {
    $list = ($upNics | ForEach-Object { "$($_.InterfaceAlias)=$($_.IPv4Address.IPAddress)" }) -join ', '
    Add-Result $Grp 'net.nic' 'Network adapters' 'WARN' "$($upNics.Count) active: $list" 'Multiple interfaces make sACN multicast bind ambiguous -- Windows may send on the wrong NIC. Pin the output interface in ArtLux, or disable the unused adapter.'
  } else {
    Add-Result $Grp 'net.nic' 'Network adapters' 'PASS' "$($upNics[0].InterfaceAlias) = $($upNics[0].IPv4Address.IPAddress)"
  }

  # --- Firewall rules ---
  $fwRules = @(Get-NetFirewallRule -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -like '*ArtLux*' -and $_.Enabled -eq 'True' })
  if ($fwRules.Count -gt 0) {
    Add-Result $Grp 'fw.rules' 'Firewall rules for ArtLux' 'PASS' "$($fwRules.Count) enabled rule(s)"
  } else {
    Add-Result $Grp 'fw.rules' 'Firewall rules for ArtLux' 'WARN' 'none found' "The installer normally adds them. Without inbound rules, OSC ($($script:Ports[2].Port)/UDP) and the show-control tablet server ($($script:Ports[3].Port)/TCP) are unreachable; outbound Art-Net/sACN usually still works."
  }

  # Is anything already sitting on our ports? A second ArtLux, or an unrelated service, silently steals them.
  foreach ($p in $script:Ports) {
    $inUse = $false
    try {
      if ($p.Proto -eq 'TCP') { $inUse = [bool](Get-NetTCPConnection -LocalPort $p.Port -State Listen -ErrorAction SilentlyContinue) }
      else { $inUse = [bool](Get-NetUDPEndpoint -LocalPort $p.Port -ErrorAction SilentlyContinue) }
    } catch { $inUse = $false }
    if ($inUse) {
      Add-Result $Grp "port.$($p.Port)" "$($p.Name) port $($p.Port)/$($p.Proto)" 'WARN' 'already bound by another process' 'Another app (or a running ArtLux) holds it. ArtLux will fail to bind and the feature goes quiet.'
    } else {
      Add-Result $Grp "port.$($p.Port)" "$($p.Name) port $($p.Port)/$($p.Proto)" 'PASS' 'free'
    }
  }

  # --- Displays (projector outputs) ---
  try {
    Add-Type -AssemblyName System.Windows.Forms -ErrorAction SilentlyContinue
    $screens = [System.Windows.Forms.Screen]::AllScreens
    Add-Result $Grp 'display.count' 'Displays' 'PASS' "$($screens.Count) attached: $(($screens | ForEach-Object { "$($_.Bounds.Width)x$($_.Bounds.Height)" }) -join ', ')"
  } catch {
    Add-Result $Grp 'display.count' 'Displays' 'SKIP' 'could not enumerate'
  }

  # --- Disk + privileges ---
  $sys = Get-PSDrive -Name ($env:SystemDrive.TrimEnd(':')) -ErrorAction SilentlyContinue
  if ($sys) {
    $freeGB = [Math]::Round($sys.Free / 1GB, 1)
    if ($freeGB -lt 2) { Add-Result $Grp 'disk.free' 'Free disk space' 'FAIL' "$freeGB GB on $env:SystemDrive" 'Need ~2 GB for the install plus room for project assets.' }
    elseif ($freeGB -lt 10) { Add-Result $Grp 'disk.free' 'Free disk space' 'WARN' "$freeGB GB on $env:SystemDrive" 'Tight for a show machine holding video assets.' }
    else { Add-Result $Grp 'disk.free' 'Free disk space' 'PASS' "$freeGB GB on $env:SystemDrive" }
  }

  if (Test-Admin) { Add-Result $Grp 'priv.admin' 'Administrator' 'PASS' 'elevated' }
  else { Add-Result $Grp 'priv.admin' 'Administrator' 'WARN' 'not elevated' 'The ArtLux installer needs elevation to install the redistributables, add firewall rules and register the watchdog task.' }
}

# ---------------------------------------------------------------------------------------------------
# DEV checks
# ---------------------------------------------------------------------------------------------------

function Get-CmdVersion {
  # NOTE: the parameter is deliberately NOT named $Args -- that is a PowerShell automatic variable, and
  # shadowing it silently binds nothing, so `& $Exe @Args` invokes the tool with NO arguments (node
  # printed its REPL banner, npm printed its help text, and every version parse came back empty).
  param([string]$Exe, [string[]]$Arguments, [string]$Pattern = '(\d+)\.(\d+)\.(\d+)')
  $cmd = Get-Command $Exe -ErrorAction SilentlyContinue
  if (-not $cmd) { return $null }
  try {
    $out = & $Exe @Arguments 2>&1 | Out-String
    $m = [regex]::Match($out, $Pattern)
    return [pscustomobject]@{
      Path    = $cmd.Source
      Raw     = ($out -split "`n")[0].Trim()
      Version = if ($m.Success) { [version]("$($m.Groups[1].Value).$($m.Groups[2].Value).$($m.Groups[3].Value)") } else { $null }
    }
  } catch { return $null }
}

function Invoke-DevChecks {
  param([string]$Root)
  $Grp = 'Dev'

  # --- Toolchain ---
  $node = Get-CmdVersion 'node' @('--version')
  if (-not $node) { Add-Result $Grp 'dev.node' 'Node.js >= 20' 'FAIL' 'not on PATH' 'https://nodejs.org -- Node 20 LTS or newer.' }
  elseif ($node.Version -and $node.Version.Major -lt 20) { Add-Result $Grp 'dev.node' 'Node.js >= 20' 'FAIL' $node.Raw 'Upgrade to Node 20+ (electron-vite 5 / Electron 42 baseline).' }
  else { Add-Result $Grp 'dev.node' 'Node.js >= 20' 'PASS' "$($node.Raw) ($($node.Path))" }

  $npm = Get-CmdVersion 'npm' @('--version')
  if ($npm) { Add-Result $Grp 'dev.npm' 'npm' 'PASS' $npm.Raw } else { Add-Result $Grp 'dev.npm' 'npm' 'FAIL' 'not on PATH' 'Ships with Node.js.' }

  $git = Get-CmdVersion 'git' @('--version')
  if ($git) { Add-Result $Grp 'dev.git' 'git' 'PASS' $git.Raw } else { Add-Result $Grp 'dev.git' 'git' 'FAIL' 'not on PATH' 'https://git-scm.com' }

  # Rust -- builds output-engine, spout-receiver, hap, ndi, calib, nvwarp.
  $rustc = Get-CmdVersion 'rustc' @('-Vv')
  if (-not $rustc) {
    Add-Result $Grp 'dev.rust' 'Rust toolchain' 'FAIL' 'rustc not on PATH' 'https://rustup.rs -- install the stable MSVC toolchain.'
  } else {
    $hostLine = (& rustc -Vv 2>&1 | Select-String '^host:').ToString()
    if ($hostLine -notmatch 'pc-windows-msvc') {
      Add-Result $Grp 'dev.rust' 'Rust toolchain' 'FAIL' "$($rustc.Raw) -- $hostLine" 'The addons must be built with the MSVC toolchain (not GNU): rustup default stable-x86_64-pc-windows-msvc'
    } else {
      Add-Result $Grp 'dev.rust' 'Rust toolchain' 'PASS' "$($rustc.Raw) ($hostLine)"
    }
  }
  if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) { Add-Result $Grp 'dev.cargo' 'cargo' 'FAIL' 'not on PATH' 'Part of rustup; ensure %USERPROFILE%\.cargo\bin is on PATH.' }
  else { Add-Result $Grp 'dev.cargo' 'cargo' 'PASS' 'on PATH' }

  # MSVC C++ build tools -- the linker for every Rust addon, the compiler for spout-receiver's vendored
  # Spout2 C++ SDK and for the JUCE audio engine.
  $vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
  if (Test-Path $vswhere) {
    $vs = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationVersion 2>&1
    if ($LASTEXITCODE -eq 0 -and $vs) { Add-Result $Grp 'dev.msvc' 'MSVC C++ build tools' 'PASS' "VS $($vs -split "`n" | Select-Object -First 1)" }
    else { Add-Result $Grp 'dev.msvc' 'MSVC C++ build tools' 'FAIL' 'VS present but the C++ workload is not installed' 'Visual Studio Installer -> Desktop development with C++ (MSVC v143 + Windows SDK).' }
  } else {
    Add-Result $Grp 'dev.msvc' 'MSVC C++ build tools' 'FAIL' 'vswhere.exe not found -- no Visual Studio / Build Tools' 'Install VS 2022 Build Tools with the "Desktop development with C++" workload.'
  }

  # CMake >= 3.23 -- the JUCE audio engine only. Missing means `npm run package` HARD FAILS (by design:
  # a release must never ship a silent audio UI).
  $cmake = Get-CmdVersion 'cmake' @('--version')
  if (-not $cmake) {
    # cmake-js shells out to `cmake` by name, so it must be on PATH -- but VS ships its own copy that a
    # plain shell never sees. Distinguish "not installed" from "installed, wrong shell": the second is a
    # WARN you fix by opening a Developer Command Prompt, not by installing anything.
    # Both hives: VS Build Tools (as opposed to the full IDE) installs under Program Files (x86) even
    # on x64, which an x64-only glob silently misses -- it reported "CMake not installed" on a machine
    # that had built the audio engine minutes earlier.
    $vsRoots = @("${env:ProgramFiles}\Microsoft Visual Studio", "${env:ProgramFiles(x86)}\Microsoft Visual Studio")
    $vsCmake = @(foreach ($r in $vsRoots) {
        Get-ChildItem "$r\*\*\Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\cmake.exe" -ErrorAction SilentlyContinue
      })
    if ($vsCmake.Count -gt 0) {
      Add-Result $Grp 'dev.cmake' 'CMake >= 3.23' 'WARN' "not on PATH, but bundled with Visual Studio: $($vsCmake[0].FullName)" 'cmake-js invokes `cmake` by name. Build from a Developer Command Prompt, or add that bin dir to PATH.'
    } else {
      Add-Result $Grp 'dev.cmake' 'CMake >= 3.23' 'FAIL' 'not on PATH' 'Required for native/audio-engine (JUCE). Without it npm run build:audio and npm run package both fail. https://cmake.org'
    }
  }
  elseif ($cmake.Version -and $cmake.Version -lt [version]'3.23.0') { Add-Result $Grp 'dev.cmake' 'CMake >= 3.23' 'FAIL' $cmake.Raw 'Upgrade to 3.23 or newer.' }
  else { Add-Result $Grp 'dev.cmake' 'CMake >= 3.23' 'PASS' $cmake.Raw }

  # --- Optional toolchains (only needed to REBUILD the committed prebuilts) ---
  $opencvDir = if ($env:OPENCV_INCLUDE_PATHS) { Split-Path (Split-Path $env:OPENCV_INCLUDE_PATHS -Parent) -Parent } else { 'C:\opencv' }
  if (Test-Path (Join-Path $opencvDir 'build\x64\vc16\lib')) {
    Add-Result $Grp 'dev.opencv' 'OpenCV 4.11 (build:calib only)' 'PASS' $opencvDir
  } else {
    Add-Result $Grp 'dev.opencv' 'OpenCV 4.11 (build:calib only)' 'SKIP' "not found at $opencvDir" 'Only needed to REBUILD calib.node (it is a committed prebuilt). Its runtime DLL comes from npm run fetch:opencv.'
  }
  $llvm = if ($env:LIBCLANG_PATH) { $env:LIBCLANG_PATH } else { 'C:\Program Files\LLVM\bin' }
  if (Test-Path (Join-Path $llvm 'libclang.dll')) { Add-Result $Grp 'dev.llvm' 'LLVM/libclang (build:calib only)' 'PASS' $llvm }
  else { Add-Result $Grp 'dev.llvm' 'LLVM/libclang (build:calib only)' 'SKIP' "libclang.dll not in $llvm" 'Only needed to rebuild calib.node (the opencv crate uses bindgen).' }

  if ($env:NDI_SDK_DIR -and (Test-Path $env:NDI_SDK_DIR)) { Add-Result $Grp 'dev.ndisdk' 'NDI SDK (build:ndi only)' 'PASS' $env:NDI_SDK_DIR }
  else { Add-Result $Grp 'dev.ndisdk' 'NDI SDK (build:ndi only)' 'SKIP' 'NDI_SDK_DIR not set' 'Only needed to rebuild ndi.node (a committed prebuilt).' }

  # --- Repo artifacts: is this checkout actually able to produce a CORRECT installer? ---
  if (-not $Root -or -not (Test-Path (Join-Path $Root 'package.json'))) {
    Add-Result $Grp 'dev.repo' 'ArtLux repo' 'SKIP' 'not running from a repo checkout' 'Run this script from scripts/ inside the repo for the repo-artifact checks.'
    return
  }
  Add-Result $Grp 'dev.repo' 'ArtLux repo' 'PASS' $Root

  $artifacts = @(
    @{ P = 'native\output-engine\output-engine.node'; N = 'output-engine.node'; Fix = 'npm run build:native'; Crit = $true },
    @{ P = 'native\spout-receiver\spout-receiver.node'; N = 'spout-receiver.node'; Fix = 'npm run build:native'; Crit = $true },
    @{ P = 'native\hap\hap.node'; N = 'hap.node'; Fix = 'npm run build:native'; Crit = $true },
    @{ P = 'native\audio-engine\audio_engine.node'; N = 'audio_engine.node'; Fix = 'npm run build:audio  (REQUIRED for any sound)'; Crit = $true },
    @{ P = 'native\ndi\ndi.node'; N = 'ndi.node'; Fix = 'committed prebuilt -- restore from git'; Crit = $true },
    @{ P = 'native\calib\calib.node'; N = 'calib.node'; Fix = 'committed prebuilt -- restore from git'; Crit = $true },
    @{ P = 'native\nvwarp\nvwarp.node'; N = 'nvwarp.node'; Fix = 'committed prebuilt -- restore from git'; Crit = $true },
    @{ P = 'native\calib\opencv_world4110.dll'; N = 'opencv_world4110.dll'; Fix = 'npm run fetch:opencv  -- gitignored; WITHOUT IT THE INSTALLER SHIPS BROKEN CALIBRATION'; Crit = $true },
    @{ P = 'build\ndi\NDI-Runtime.exe'; N = 'NDI-Runtime.exe'; Fix = 'npm run fetch:redist  -- gitignored; without it the installer cannot auto-install the NDI Runtime'; Crit = $true },
    @{ P = 'build\vcredist\vc_redist.x64.exe'; N = 'vc_redist.x64.exe'; Fix = 'npm run fetch:redist'; Crit = $true }
  )
  foreach ($a in $artifacts) {
    $full = Join-Path $Root $a.P
    if (Test-Path $full) {
      Add-Result $Grp "art.$($a.N)" $a.P 'PASS' "$([Math]::Round((Get-Item $full).Length / 1MB, 1)) MB"
    } else {
      Add-Result $Grp "art.$($a.N)" $a.P 'FAIL' 'missing' $a.Fix
    }
  }

  # MediaPipe offline assets -- bundled into the renderer at build time; without them pose tracking
  # tries a CDN fetch that Electron's CSP blocks.
  $mpWasm = Join-Path $Root 'src\renderer\public\mediapipe\wasm'
  $mpModels = Join-Path $Root 'src\renderer\public\mediapipe\models'
  if ((Test-Path $mpWasm) -and (Test-Path $mpModels) -and (Get-ChildItem $mpModels -Filter '*.task' -ErrorAction SilentlyContinue)) {
    Add-Result $Grp 'dev.mediapipe' 'MediaPipe offline assets' 'PASS' "$((Get-ChildItem $mpModels -Filter '*.task').Count) model(s) staged"
  } else {
    Add-Result $Grp 'dev.mediapipe' 'MediaPipe offline assets' 'FAIL' 'not staged' 'npm run assets:mediapipe  -- otherwise pose tracking tries a CDN fetch that CSP blocks.'
  }

  if (-not (Test-Path (Join-Path $Root 'node_modules'))) {
    Add-Result $Grp 'dev.nodemodules' 'node_modules' 'FAIL' 'not installed' 'npm install'
  } else {
    Add-Result $Grp 'dev.nodemodules' 'node_modules' 'PASS' 'present'
  }

  # The stale-addon trap: a running Electron holds the .node files, MSVC fails LNK1104, and the OLD
  # addon stays on disk -- so you debug code that never linked.
  if (Get-Process electron -ErrorAction SilentlyContinue) {
    Add-Result $Grp 'dev.electron' 'Stray electron.exe' 'WARN' 'electron is running' 'Kill it before any native rebuild -- a held .node fails to link (LNK1104/EBUSY) and silently leaves the STALE addon in place.'
  } else {
    Add-Result $Grp 'dev.electron' 'Stray electron.exe' 'PASS' 'none running'
  }
}

# ---------------------------------------------------------------------------------------------------
# -Fix : the only two things we are willing to install automatically
# ---------------------------------------------------------------------------------------------------

function Invoke-Fix {
  if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
    Write-Host 'winget not available -- cannot auto-install. Install the redistributables manually.' -ForegroundColor Yellow
    return
  }
  $wanted = @()
  if (($script:Results | Where-Object { $_.id -eq 'vcredist' -and $_.status -eq 'FAIL' })) { $wanted += 'Microsoft.VCRedist.2015+.x64' }
  if (($script:Results | Where-Object { $_.id -eq 'ndi.runtime' -and $_.status -eq 'FAIL' })) { $wanted += 'NDI.NDIRuntime' }
  if (-not $wanted) { Write-Host 'Nothing to fix -- both redistributables are already present.' -ForegroundColor Green; return }
  foreach ($id in $wanted) {
    Write-Host "Installing $id via winget..." -ForegroundColor Cyan
    winget install --id $id --silent --accept-package-agreements --accept-source-agreements
  }
  Write-Host 'Re-run the preflight to confirm.' -ForegroundColor Cyan
}

# ---------------------------------------------------------------------------------------------------
# Render
# ---------------------------------------------------------------------------------------------------

function Write-Report {
  $colors = @{ PASS = 'Green'; WARN = 'Yellow'; FAIL = 'Red'; SKIP = 'DarkGray' }
  $glyphs = @{ PASS = '[ OK ]'; WARN = '[WARN]'; FAIL = '[FAIL]'; SKIP = '[skip]' }

  foreach ($group in ($script:Results | Select-Object -ExpandProperty group -Unique)) {
    Write-Host ''
    Write-Host "== $group " -ForegroundColor Cyan -NoNewline
    Write-Host ('=' * [Math]::Max(0, 76 - $group.Length)) -ForegroundColor DarkCyan
    foreach ($r in ($script:Results | Where-Object { $_.group -eq $group })) {
      Write-Host $glyphs[$r.status] -ForegroundColor $colors[$r.status] -NoNewline
      Write-Host " $($r.name)" -NoNewline
      if ($r.detail) { Write-Host " -- $($r.detail)" -ForegroundColor DarkGray } else { Write-Host '' }
      if ($r.remedy -and $r.status -in @('FAIL', 'WARN')) {
        Write-Host "        -> $($r.remedy)" -ForegroundColor DarkYellow
      }
    }
  }

  $fail = @($script:Results | Where-Object { $_.status -eq 'FAIL' }).Count
  $warn = @($script:Results | Where-Object { $_.status -eq 'WARN' }).Count
  $pass = @($script:Results | Where-Object { $_.status -eq 'PASS' }).Count
  Write-Host ''
  Write-Host ('-' * 80) -ForegroundColor DarkCyan
  Write-Host "  $pass passed, " -NoNewline -ForegroundColor Green
  Write-Host "$warn warning(s), " -NoNewline -ForegroundColor Yellow
  Write-Host "$fail failure(s)" -ForegroundColor $(if ($fail) { 'Red' } else { 'Green' })
  if ($fail) { Write-Host '  Resolve the FAILs above before installing / packaging.' -ForegroundColor Red }
  Write-Host ''
}

# ---------------------------------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------------------------------

if ($env:OS -ne 'Windows_NT') {
  Write-Error 'preflight.ps1 targets Windows. On macOS/Linux the Windows-only features (Spout, NDI runtime, nvwarp, calib) do not apply.'
  exit 2
}

# Repo root = parent of scripts/. Absent when the script runs from an installed resources/scripts dir,
# in which case the dev-mode repo checks report SKIP.
$repoRoot = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path (Join-Path $repoRoot 'package.json'))) { $repoRoot = '' }

# The banner is for a human reading a console. Suppressed under -Json because that switch means the
# caller is a PROGRAM parsing stdout, and three lines of prose in front of the document make it
# unparseable -- `preflight.ps1 -Json | ConvertFrom-Json` failed with "Invalid JSON primitive: ArtLux".
# Write-Host does not go to the success stream, so this is invisible when dot-sourced, but it lands
# squarely in stdout for a child process, which is the only way anything outside this repo runs it.
if (-not $Json) {
  Write-Host ''
  Write-Host '  ArtLux preflight' -ForegroundColor White
  Write-Host "  mode: $Mode   host: $env:COMPUTERNAME   $(Get-Date -Format 'yyyy-MM-dd HH:mm')" -ForegroundColor DarkGray
}

if ($Mode -eq 'runtime' -or $Mode -eq 'all') { Invoke-RuntimeChecks }
if ($Mode -eq 'dev' -or $Mode -eq 'all') { Invoke-DevChecks -Root $repoRoot }

# Built from precomputed scalars rather than as one nested literal: Windows PowerShell 5.1 throws
# "the argument types do not match" when a [pscustomobject] cast is nested inside another
# [pscustomobject] literal that also carries a generic List value. Flat construction is unambiguous.
$sumPass = @($script:Results | Where-Object { $_.status -eq 'PASS' }).Count
$sumWarn = @($script:Results | Where-Object { $_.status -eq 'WARN' }).Count
$sumFail = @($script:Results | Where-Object { $_.status -eq 'FAIL' }).Count
$sumSkip = @($script:Results | Where-Object { $_.status -eq 'SKIP' }).Count

$summary = [pscustomobject]@{ pass = $sumPass; warn = $sumWarn; fail = $sumFail; skip = $sumSkip }
$report = [pscustomobject]@{
  generatedAt = (Get-Date).ToString('o')
  host        = $env:COMPUTERNAME
  mode        = $Mode
  summary     = $summary
  results     = $script:Results.ToArray()
}

if ($OutFile) {
  try {
    $dir = Split-Path -Parent $OutFile
    if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    $report | ConvertTo-Json -Depth 6 | Out-File -FilePath $OutFile -Encoding utf8
  } catch { Write-Warning "could not write $OutFile : $_" }
}

if ($Json) { $report | ConvertTo-Json -Depth 6 } else { Write-Report }

if ($Fix) { Invoke-Fix }

exit $(if ($report.summary.fail -gt 0) { 1 } else { 0 })
