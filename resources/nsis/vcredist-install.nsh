; VC++ 2015-2022 Redistributable (x64) — silent install during app setup
; ONNX Runtime (used by embedding & speech) requires vcruntime140_1.dll etc.

!macro customInstall
  ; Check if VC++ 2015-2022 x64 runtime is already installed
  ReadRegDWORD $0 HKLM "SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64" "Installed"
  ${If} $0 == 1
    DetailPrint "Visual C++ Runtime already installed, skipping."
  ${Else}
    DetailPrint "Installing Visual C++ Redistributable..."
    File /oname=$PLUGINSDIR\vc_redist.x64.exe "${BUILD_RESOURCES_DIR}\vc_redist.x64.exe"
    ExecWait '"$PLUGINSDIR\vc_redist.x64.exe" /install /quiet /norestart' $0
    ${If} $0 == 0
      DetailPrint "Visual C++ Redistributable installed successfully."
    ${Else}
      DetailPrint "Visual C++ Redistributable install exited with code $0 (non-fatal)."
    ${EndIf}
    Delete "$PLUGINSDIR\vc_redist.x64.exe"
  ${EndIf}
!macroend
