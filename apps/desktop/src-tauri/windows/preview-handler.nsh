; Shell registration for the ChordPro preview handler DLL that ships
; next to the app executable (`bundle.resources` in
; `tauri.windows.conf.json`).
;
; Included by Tauri's NSIS template via
; `bundle.windows.nsis.installerHooks`; the macros below are inserted
; after the files have been copied (install) and before they are
; deleted (uninstall).
;
; SISTER SITE: `preview-handler.wxs` writes the same layout for the
; MSI. A value corrected here must be corrected there in the same
; commit — `apps/desktop/preview-handler/src/registration.rs` fails the
; build if the two drift. The key layout and the rationale for
; registering from the installer rather than from a `DllRegisterServer`
; export are documented in `apps/desktop/preview-handler/README.md`.
;
; SHCTX follows the installer's own scope, exactly as Tauri's file
; associations and deep links do: HKCU for the default per-user
; install (no admin rights needed), HKLM when the installer is built
; or run for all users. `SetRegView 64` keeps the writes out of
; `Wow6432Node` — NSIS itself is a 32-bit process, and Explorer looks
; the 64-bit in-process server up in the 64-bit view.

!define PREVIEW_HANDLER_CLSID "{32E65E30-8242-492F-9985-C7785BB38BC7}"
!define PREVIEW_HANDLER_IID "{8895b1c6-b41f-4c1c-a562-0d564250836f}"
!define PREVIEW_HOST_APPID "{6d2b5079-2f0b-48dd-ab7f-97cec514d30b}"
!define PREVIEW_HANDLER_NAME "ChordSketch ChordPro Preview Handler"
!define PREVIEW_HANDLER_DLL "chordsketch_preview_handler.dll"
!define PREVIEW_HANDLERS_KEY "Software\Microsoft\Windows\CurrentVersion\PreviewHandlers"

!macro NSIS_HOOK_POSTINSTALL
  SetRegView 64

  ; The COM class. AppID points at the 64-bit prevhost.exe surrogate so
  ; the shell loads this DLL into the isolated preview host, not into
  ; explorer.exe.
  WriteRegStr SHCTX "Software\Classes\CLSID\${PREVIEW_HANDLER_CLSID}" "" "${PREVIEW_HANDLER_NAME}"
  WriteRegStr SHCTX "Software\Classes\CLSID\${PREVIEW_HANDLER_CLSID}" "AppID" "${PREVIEW_HOST_APPID}"
  WriteRegStr SHCTX "Software\Classes\CLSID\${PREVIEW_HANDLER_CLSID}\InprocServer32" "" "$INSTDIR\${PREVIEW_HANDLER_DLL}"
  WriteRegStr SHCTX "Software\Classes\CLSID\${PREVIEW_HANDLER_CLSID}\InprocServer32" "ThreadingModel" "Apartment"

  ; One shellex subkey per ChordPro extension. The subkey name is the
  ; IID of IPreviewHandler; its presence marks the type as previewable.
  WriteRegStr SHCTX "Software\Classes\.cho\shellex\${PREVIEW_HANDLER_IID}" "" "${PREVIEW_HANDLER_CLSID}"
  WriteRegStr SHCTX "Software\Classes\.chopro\shellex\${PREVIEW_HANDLER_IID}" "" "${PREVIEW_HANDLER_CLSID}"
  WriteRegStr SHCTX "Software\Classes\.crd\shellex\${PREVIEW_HANDLER_IID}" "" "${PREVIEW_HANDLER_CLSID}"
  WriteRegStr SHCTX "Software\Classes\.chordpro\shellex\${PREVIEW_HANDLER_IID}" "" "${PREVIEW_HANDLER_CLSID}"

  ; The approved list the shell enumerates registered handlers from.
  WriteRegStr SHCTX "${PREVIEW_HANDLERS_KEY}" "${PREVIEW_HANDLER_CLSID}" "${PREVIEW_HANDLER_NAME}"

  SetRegView lastused
!macroend

; Removes only the entries this installer owns. Each extension's
; shellex value is compared against our own CLSID first, mirroring the
; guard Tauri's template uses for deep-link protocols: if another
; application has since claimed the extension, its registration must
; survive our uninstall.
!macro ChordSketchUnregisterExtension EXT
  ReadRegStr $R7 SHCTX "Software\Classes\${EXT}\shellex\${PREVIEW_HANDLER_IID}" ""
  ${If} $R7 == "${PREVIEW_HANDLER_CLSID}"
    DeleteRegKey SHCTX "Software\Classes\${EXT}\shellex\${PREVIEW_HANDLER_IID}"
    DeleteRegKey /ifempty SHCTX "Software\Classes\${EXT}\shellex"
    DeleteRegKey /ifempty SHCTX "Software\Classes\${EXT}"
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  SetRegView 64

  !insertmacro ChordSketchUnregisterExtension ".cho"
  !insertmacro ChordSketchUnregisterExtension ".chopro"
  !insertmacro ChordSketchUnregisterExtension ".crd"
  !insertmacro ChordSketchUnregisterExtension ".chordpro"

  DeleteRegKey SHCTX "Software\Classes\CLSID\${PREVIEW_HANDLER_CLSID}"
  DeleteRegValue SHCTX "${PREVIEW_HANDLERS_KEY}" "${PREVIEW_HANDLER_CLSID}"
  DeleteRegKey /ifempty SHCTX "${PREVIEW_HANDLERS_KEY}"

  SetRegView lastused
!macroend
