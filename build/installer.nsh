; ArtLux NSIS customization — auto-install the NDI Runtime (needed for NDI send/receive).
;
; electron-builder runs the `customInstall` macro during install AND during an
; electron-updater update (the updater re-runs this NSIS installer), so the runtime is
; ensured on first install and kept in place across updates.
;
; To enable bundled auto-install, drop the NDI Runtime redistributable at
;   build/ndi/NDI-Runtime.exe
; and add it to electron-builder `extraResources`:
;   { "from": "build/ndi/NDI-Runtime.exe", "to": "NDI-Runtime.exe" }
; (Redistributing the NDI Runtime is permitted under the NDI SDK license — keep the NDI
; attribution + trademark notice. If you don't bundle it, this macro is a no-op and the app
; degrades gracefully, showing an "Install NDI Tools" hint where NDI is used.)

!macro customInstall
  ; Already installed? NDI 6 runtime exports NDI_RUNTIME_DIR_V6; bail if present.
  ReadEnvStr $0 "NDI_RUNTIME_DIR_V6"
  StrCmp $0 "" 0 ndi_done
  ReadRegStr $0 HKLM "SOFTWARE\NDI\NDI Runtime" "Version"
  StrCmp $0 "" 0 ndi_done

  ; Run the bundled redistributable silently if present (flags cover Inno/NSIS installers).
  IfFileExists "$INSTDIR\resources\NDI-Runtime.exe" 0 ndi_done
  DetailPrint "Installing NDI Runtime…"
  ExecWait '"$INSTDIR\resources\NDI-Runtime.exe" /VERYSILENT /SUPPRESSMSGBOXES /NORESTART /S'

  ndi_done:
!macroend
