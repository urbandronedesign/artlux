; ArtLux NSIS customization -- everything a fresh Windows machine needs, done by the installer.
;
; Why this file does so much: every native module in ArtLux degrades gracefully when its runtime is
; missing (one console line, feature disabled, never a crash). That is right for robustness and awful
; for a venue install -- putting ArtLux on a second machine produced an app with no NDI and no
; calibration, and nothing on screen said so. So the installer provisions the machine itself.
;
; electron-builder runs `customInstall` during a fresh install AND during an electron-updater update
; (the updater re-runs this NSIS installer), so everything below is idempotent and re-asserted on every
; update. `customUnInstall` undoes only what is exclusively ours.
;
; What it does, in order:
;   1. NDI Runtime      -- installed silently if absent. Without it ndi.node loads but runtimeAvailable()
;                          is false and every NDI source/output silently vanishes from the UI.
;   2. VC++ 2015-2022   -- installed silently if absent. Every .node addon and opencv_world4110.dll link
;                          the dynamic CRT; without it they all fail to load.
;   3. Firewall rules   -- Art-Net / sACN / OSC / show-control. Inbound is blocked by default, so the
;                          OSC listener and the tablet remote are unreachable on a stock machine.
;   4. Preflight report -- runs scripts/preflight.ps1 and leaves a JSON report in %APPDATA%\artlux so a
;                          post-install problem is diagnosable without a terminal.
;
; The redistributables are staged into build/ by `npm run fetch:redist` and bundled via
; electron-builder extraResources (both gitignored). scripts/verify-package-resources.cjs fails the
; build if either is missing -- electron-builder itself would skip them SILENTLY, which is precisely
; how a release shipped with no OpenCV DLL behind calib.node.
;
; NDI(R) is a registered trademark of Vizrt NDI AB. Redistributing the NDI Runtime is permitted under
; the NDI SDK licence provided the attribution is kept -- see NOTICE.
;
; Ports below are kept in sync with scripts/preflight.ps1 and the app:
;   Art-Net 6454/UDP (docs/OUTPUTS.md) - sACN 5568/UDP - OSC 10000/UDP (docs/OSC.md)
;   show-control 8788/TCP (plugins/show-control/src/types.ts DEFAULT_PORT)

!macro customInstall

  ; ---------------------------------------------------------------------------------------------
  ; 1. NDI Runtime
  ; ---------------------------------------------------------------------------------------------
  ; NDI 6 exports NDI_RUNTIME_DIR_V6 and registers a version key; either one means "already there".
  ReadEnvStr $0 "NDI_RUNTIME_DIR_V6"
  StrCmp $0 "" 0 ndi_done
  ReadRegStr $0 HKLM "SOFTWARE\NDI\NDI Runtime" "Version"
  StrCmp $0 "" 0 ndi_done

  IfFileExists "$INSTDIR\resources\NDI-Runtime.exe" 0 ndi_missing
  DetailPrint "Installing NDI Runtime..."
  ; The redistributable is an Inno Setup installer; the flags cover Inno and NSIS-packaged variants.
  ExecWait '"$INSTDIR\resources\NDI-Runtime.exe" /VERYSILENT /SUPPRESSMSGBOXES /NORESTART /S' $0
  DetailPrint "NDI Runtime installer exited with $0"
  Goto ndi_done

  ndi_missing:
  ; Not fatal: NDI is one feature among many and the app degrades gracefully. Record it in the install
  ; log rather than failing an otherwise good install.
  DetailPrint "NDI Runtime redistributable not bundled - NDI features will be unavailable."

  ndi_done:

  ; ---------------------------------------------------------------------------------------------
  ; 2. Visual C++ 2015-2022 x64 runtime
  ; ---------------------------------------------------------------------------------------------
  ; This one is load-bearing for the whole app: every native addon links the dynamic CRT.
  SetRegView 64
  ReadRegDWORD $0 HKLM "SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64" "Installed"
  SetRegView lastused
  IntCmp $0 1 vc_done

  IfFileExists "$INSTDIR\resources\vc_redist.x64.exe" 0 vc_done
  DetailPrint "Installing Microsoft Visual C++ 2015-2022 x64 runtime..."
  ExecWait '"$INSTDIR\resources\vc_redist.x64.exe" /install /quiet /norestart' $0
  ; 0 = ok, 1638 = a newer version is already present, 3010 = success with a reboot pending.
  DetailPrint "VC++ redistributable installer exited with $0"

  vc_done:

  ; ---------------------------------------------------------------------------------------------
  ; 3. Windows Firewall rules
  ; ---------------------------------------------------------------------------------------------
  ; Deleted first so an update refreshes them instead of stacking duplicates. The program-scoped rules
  ; cover the app's own traffic; the explicit port rules keep OSC and the tablet remote reachable even
  ; when the sender is a device whose traffic Windows cannot attribute to ArtLux.exe.
  DetailPrint "Configuring Windows Firewall rules for ArtLux..."
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="ArtLux"'
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="ArtLux - Art-Net"'
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="ArtLux - sACN"'
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="ArtLux - OSC"'
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="ArtLux - Show Control"'

  nsExec::ExecToLog 'netsh advfirewall firewall add rule name="ArtLux" dir=in action=allow program="$INSTDIR\ArtLux.exe" enable=yes profile=any'
  nsExec::ExecToLog 'netsh advfirewall firewall add rule name="ArtLux" dir=out action=allow program="$INSTDIR\ArtLux.exe" enable=yes profile=any'
  nsExec::ExecToLog 'netsh advfirewall firewall add rule name="ArtLux - Art-Net" dir=in action=allow protocol=UDP localport=6454 profile=any'
  nsExec::ExecToLog 'netsh advfirewall firewall add rule name="ArtLux - sACN" dir=in action=allow protocol=UDP localport=5568 profile=any'
  nsExec::ExecToLog 'netsh advfirewall firewall add rule name="ArtLux - OSC" dir=in action=allow protocol=UDP localport=10000 profile=any'
  nsExec::ExecToLog 'netsh advfirewall firewall add rule name="ArtLux - Show Control" dir=in action=allow protocol=TCP localport=8788 profile=any'

  ; ---------------------------------------------------------------------------------------------
  ; 4. Post-install preflight report
  ; ---------------------------------------------------------------------------------------------
  ; Non-blocking and never fails the install -- it only records what the machine looks like, so a
  ; "feature X does nothing" report later has an answer already sitting on disk.
  IfFileExists "$INSTDIR\resources\scripts\preflight.ps1" 0 preflight_done
  DetailPrint "Running dependency preflight..."
  nsExec::ExecToLog 'powershell -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\resources\scripts\preflight.ps1" -Mode runtime -Json -OutFile "$APPDATA\artlux\preflight.json" -InstallDir "$INSTDIR"'
  DetailPrint "Preflight report written to $APPDATA\artlux\preflight.json"
  preflight_done:

!macroend

!macro customUnInstall

  ; Remove only the firewall rules we created. The NDI Runtime and the VC++ redistributable are shared
  ; system components other applications may depend on -- uninstalling them here would be hostile.
  DetailPrint "Removing ArtLux firewall rules..."
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="ArtLux"'
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="ArtLux - Art-Net"'
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="ArtLux - sACN"'
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="ArtLux - OSC"'
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="ArtLux - Show Control"'

  ; The watchdog Scheduled Task (docs/WATCHDOG.md) outlives the app otherwise -- it would keep trying
  ; to relaunch a binary that no longer exists, once a minute, forever.
  IfFileExists "$INSTDIR\resources\scripts\uninstall-watchdog-task.ps1" 0 wd_done
  nsExec::ExecToLog 'powershell -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\resources\scripts\uninstall-watchdog-task.ps1"'
  wd_done:

!macroend
