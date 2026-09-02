//! The identifiers Explorer looks the handler up by.
//!
//! These constants are the single source of truth for the shell
//! registration. The DLL itself only needs [`PREVIEW_HANDLER_CLSID`]
//! (to answer `DllGetClassObject`); the remaining values describe the
//! registry layout that the two installers write, and the unit tests at
//! the bottom of this file assert that both installer definitions agree
//! with them. See `apps/desktop/preview-handler/README.md` for the full
//! key layout and why registration lives in the installers rather than
//! in a `DllRegisterServer` export.

/// CLSID of the ChordPro preview handler COM class.
///
/// Frozen on first release: changing it orphans the registry entries
/// written by every installer already in the field.
pub const PREVIEW_HANDLER_CLSID: &str = "{32E65E30-8242-492F-9985-C7785BB38BC7}";

/// AppID of the 64-bit `prevhost.exe` surrogate.
///
/// Documented by Microsoft in "How to Register a Preview Handler";
/// pointing the CLSID at it is what makes the shell load this DLL into
/// the isolated preview host instead of into `explorer.exe` itself.
/// The 32-bit surrogate (`{534A1E02-D58F-44f0-B58B-36CBED287C7C}`) is
/// deliberately not used — this DLL only ships as a 64-bit binary.
pub const PREVIEW_HOST_APPID: &str = "{6d2b5079-2f0b-48dd-ab7f-97cec514d30b}";

/// IID of `IPreviewHandler`, used as the `shellex` subkey name.
///
/// The presence of this subkey under a file type is what tells the
/// shell that the type has a preview handler.
pub const PREVIEW_HANDLER_SHELLEX_IID: &str = "{8895b1c6-b41f-4c1c-a562-0d564250836f}";

/// File name extensions the handler is registered for.
///
/// The same four extensions the Linux thumbnailer
/// (`packaging/linux/chordsketch-mime.xml`) maps to `text/x-chordpro`.
pub const SUPPORTED_EXTENSIONS: [&str; 4] = [".cho", ".chopro", ".crd", ".chordpro"];

/// File name of the DLL as it is installed next to the app executable.
///
/// Derived from the crate name by cargo; the installers hard-code the
/// same string, and the tests below keep the two in step.
pub const DLL_FILE_NAME: &str = "chordsketch_preview_handler.dll";

/// Human-readable name written as the default value of the CLSID key
/// and of the entry in the `PreviewHandlers` approved list.
pub const DISPLAY_NAME: &str = "ChordSketch ChordPro Preview Handler";

#[cfg(test)]
mod tests {
    use super::*;

    /// WiX fragment merged into the MSI via `wix.fragmentPaths`.
    const WIX_FRAGMENT: &str = include_str!("../../src-tauri/windows/preview-handler.wxs");
    /// NSIS macros merged into the `.exe` installer via
    /// `nsis.installerHooks`.
    const NSIS_HOOKS: &str = include_str!("../../src-tauri/windows/preview-handler.nsh");

    /// The MSI and the NSIS installer are sister sites in the sense of
    /// `.claude/rules/fix-propagation.md`: they write the same registry
    /// layout in two different languages, and a value corrected in one
    /// is worthless if the other keeps the old one. Nothing at runtime
    /// reads both, so only a test can catch the drift.
    #[test]
    fn test_both_installers_register_the_crate_clsid() {
        assert!(WIX_FRAGMENT.contains(PREVIEW_HANDLER_CLSID));
        assert!(NSIS_HOOKS.contains(PREVIEW_HANDLER_CLSID));
    }

    #[test]
    fn test_both_installers_point_the_clsid_at_the_prevhost_surrogate() {
        assert!(WIX_FRAGMENT.contains(PREVIEW_HOST_APPID));
        assert!(NSIS_HOOKS.contains(PREVIEW_HOST_APPID));
    }

    #[test]
    fn test_both_installers_use_the_ipreviewhandler_shellex_subkey() {
        assert!(WIX_FRAGMENT.contains(PREVIEW_HANDLER_SHELLEX_IID));
        assert!(NSIS_HOOKS.contains(PREVIEW_HANDLER_SHELLEX_IID));
    }

    #[test]
    fn test_both_installers_cover_every_supported_extension() {
        for ext in SUPPORTED_EXTENSIONS {
            assert!(
                WIX_FRAGMENT.contains(&format!("Software\\Classes\\{ext}\\shellex\\")),
                "WiX fragment does not register {ext}"
            );
            assert!(
                NSIS_HOOKS.contains(&format!("Software\\Classes\\{ext}\\shellex\\")),
                "NSIS hooks do not register {ext}"
            );
        }
    }

    #[test]
    fn test_both_installers_name_the_installed_dll() {
        assert!(WIX_FRAGMENT.contains(DLL_FILE_NAME));
        assert!(NSIS_HOOKS.contains(DLL_FILE_NAME));
    }

    #[test]
    fn test_both_installers_write_the_display_name() {
        assert!(WIX_FRAGMENT.contains(DISPLAY_NAME));
        assert!(NSIS_HOOKS.contains(DISPLAY_NAME));
    }

    #[test]
    fn test_both_installers_add_the_handler_to_the_approved_list() {
        let approved = "Microsoft\\Windows\\CurrentVersion\\PreviewHandlers";
        assert!(WIX_FRAGMENT.contains(approved));
        assert!(NSIS_HOOKS.contains(approved));
    }

    /// The MSI removes its registry entries automatically — every key
    /// in the fragment carries `ForceDeleteOnUninstall`, and Windows
    /// Installer reverses a component wholesale. The NSIS side has to
    /// spell each removal out by hand, so that is where an extension
    /// added to the install path can be forgotten.
    #[test]
    fn test_the_nsis_uninstall_hook_covers_every_supported_extension() {
        for ext in SUPPORTED_EXTENSIONS {
            assert!(
                NSIS_HOOKS.contains(&format!(
                    "!insertmacro ChordSketchUnregisterExtension \"{ext}\""
                )),
                "NSIS uninstall hook does not unregister {ext}"
            );
        }
        assert_eq!(
            NSIS_HOOKS
                .matches("!insertmacro ChordSketchUnregisterExtension")
                .count(),
            SUPPORTED_EXTENSIONS.len(),
        );
    }

    #[test]
    fn test_the_nsis_uninstall_hook_removes_the_com_class() {
        assert!(
            NSIS_HOOKS.contains(
                "DeleteRegKey SHCTX \"Software\\Classes\\CLSID\\${PREVIEW_HANDLER_CLSID}\""
            )
        );
        assert!(NSIS_HOOKS.contains(
            "DeleteRegValue SHCTX \"${PREVIEW_HANDLERS_KEY}\" \"${PREVIEW_HANDLER_CLSID}\""
        ));
    }

    #[test]
    fn test_the_dll_file_name_matches_the_cargo_lib_name() {
        // cargo derives the cdylib file name from the package name by
        // replacing `-` with `_`; if the package is ever renamed, the
        // installers would keep registering a path that no longer
        // exists and the preview would silently stop working.
        let expected = format!("{}.dll", env!("CARGO_PKG_NAME").replace('-', "_"));
        assert_eq!(DLL_FILE_NAME, expected);
    }
}
