; VC++ 2015-2022 Redistributable (x64) — silent install during app setup
; ONNX Runtime (used by embedding & speech) requires vcruntime140_1.dll etc.

; 自动更新（--updated）时跳过「为所有用户 / 仅当前用户」页，沿用注册表中的既有安装模式
!macro customInstallMode
  ${if} ${isUpdated}
    ${if} $hasPerMachineInstallation == "1"
    ${andIf} $hasPerUserInstallation == "0"
      StrCpy $isForceMachineInstall "1"
    ${elseif} $hasPerUserInstallation == "1"
    ${andIf} $hasPerMachineInstallation == "0"
      StrCpy $isForceCurrentInstall "1"
    ${endif}
  ${endif}
!macroend

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
