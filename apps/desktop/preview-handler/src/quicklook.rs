//! The macOS Quick Look preview extension's side of this crate.
//!
//! The extension itself is a small Swift bundle
//! (`apps/desktop/src-tauri/macos/quicklook/`) that
//! `apps/desktop/scripts/build-quicklook-extension.mjs` links against
//! this crate built as a static library, and that the Tauri bundle
//! embeds at `ChordSketch.app/Contents/PlugIns/`. This module holds:
//!
//! - the identifiers macOS looks the extension up by, with tests that
//!   assert the property lists agree with them — the macOS counterpart
//!   of [`crate::registration`];
//! - on macOS only, the C ABI the Swift code calls. It is the only
//!   code the extension runs on the Rust side, and it does nothing but
//!   move bytes into [`crate::document::render_preview`] and the HTML
//!   back out.
//!
//! See `apps/desktop/preview-handler/README.md` for the bundle layout,
//! the build, and how to verify the extension on a Mac.

/// Bundle identifier of the `.appex`.
///
/// Must start with the desktop app's own identifier
/// (`me.koeda.chordsketch.desktop` in `tauri.conf.json`): macOS only
/// accepts an embedded extension whose identifier is prefixed by its
/// host's. Frozen on first release for the same reason as
/// [`crate::registration::PREVIEW_HANDLER_CLSID`] — `pluginkit` keys the
/// user's enable / disable choice on it.
pub const EXTENSION_BUNDLE_ID: &str = "me.koeda.chordsketch.desktop.quicklook";

/// Uniform Type Identifier the desktop app exports for ChordPro files,
/// and the one type the extension declares it previews.
///
/// Exported (not imported) because ChordSketch is the application
/// defining it. It conforms to `public.plain-text`, so a Mac on which
/// the extension is disabled or cannot load still falls back to the
/// system's plain-text preview rather than to a blank icon.
pub const CHORDPRO_UTI: &str = "me.koeda.chordsketch.chordpro";

/// MIME type tagged on [`CHORDPRO_UTI`]; the same type the Linux
/// thumbnailer (`packaging/linux/chordsketch-mime.xml`) defines.
pub const CHORDPRO_MIME_TYPE: &str = "text/x-chordpro";

/// Name of the extension bundle inside `Contents/PlugIns/`, and of the
/// executable inside it.
pub const EXTENSION_NAME: &str = "ChordSketchQuickLook";

/// Objective-C name of the Swift class the extension point
/// instantiates. The Swift source pins it with `@objc(...)` so the
/// `NSExtensionPrincipalClass` entry does not depend on the Swift
/// module name.
pub const PRINCIPAL_CLASS: &str = "ChordSketchPreviewProvider";

#[cfg(target_os = "macos")]
pub use ffi::*;

/// The C ABI declared in
/// `apps/desktop/src-tauri/macos/quicklook/ChordSketchQuickLook.h`.
///
/// Only compiled for macOS so the Windows DLL does not grow exports
/// nothing there calls.
#[cfg(target_os = "macos")]
mod ffi {
    use crate::document::{MAX_PREVIEW_SOURCE_BYTES, render_preview};

    /// The largest number of bytes the extension needs to read from a
    /// file: one past [`MAX_PREVIEW_SOURCE_BYTES`], which is enough for
    /// [`chordsketch_quicklook_render`] to tell that the file is over
    /// the limit without the extension loading all of it.
    #[unsafe(no_mangle)]
    pub extern "C" fn chordsketch_quicklook_read_limit() -> usize {
        MAX_PREVIEW_SOURCE_BYTES + 1
    }

    /// Render the bytes of a ChordPro file into a UTF-8 HTML document.
    ///
    /// Returns an owned buffer and writes its length to `html_len`. The
    /// caller must hand both back to [`chordsketch_quicklook_free`].
    /// Never returns null: a file that cannot be rendered produces a
    /// document explaining why.
    ///
    /// # Safety
    ///
    /// - `source` must point to `source_len` readable bytes, or
    ///   `source_len` must be 0 (in which case `source` may be null).
    /// - `html_len` must be a valid, writable pointer.
    #[unsafe(no_mangle)]
    pub unsafe extern "C" fn chordsketch_quicklook_render(
        source: *const u8,
        source_len: usize,
        html_len: *mut usize,
    ) -> *mut u8 {
        let bytes: &[u8] = if source_len == 0 {
            // Swift's `Data.withUnsafeBytes` may hand over a null base
            // address for an empty file; `from_raw_parts` forbids null
            // even for a zero length.
            &[]
        } else {
            // SAFETY: the caller guarantees `source` points to
            // `source_len` readable bytes.
            unsafe { core::slice::from_raw_parts(source, source_len) }
        };
        let html = render_preview(bytes).into_bytes().into_boxed_slice();
        // SAFETY: the caller guarantees `html_len` is writable.
        unsafe { html_len.write(html.len()) };
        Box::into_raw(html).cast::<u8>()
    }

    /// Release a buffer returned by [`chordsketch_quicklook_render`].
    ///
    /// # Safety
    ///
    /// `html` and `html_len` must be exactly a pointer and length
    /// returned by one call to [`chordsketch_quicklook_render`], and
    /// the buffer must not be used or freed again afterwards.
    #[unsafe(no_mangle)]
    pub unsafe extern "C" fn chordsketch_quicklook_free(html: *mut u8, html_len: usize) {
        // SAFETY: the caller guarantees this is the boxed slice
        // `chordsketch_quicklook_render` leaked, with its length.
        drop(unsafe { Box::from_raw(core::ptr::slice_from_raw_parts_mut(html, html_len)) });
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        fn render(source: &[u8]) -> String {
            let mut len = 0;
            // SAFETY: `source` is a live slice and `len` a local.
            let ptr =
                unsafe { chordsketch_quicklook_render(source.as_ptr(), source.len(), &mut len) };
            // SAFETY: `ptr` / `len` came from the call above.
            let html = String::from_utf8(unsafe { core::slice::from_raw_parts(ptr, len) }.to_vec())
                .expect("the renderer only produces UTF-8");
            // SAFETY: freed exactly once, with the length it came with.
            unsafe { chordsketch_quicklook_free(ptr, len) };
            html
        }

        #[test]
        fn test_render_returns_the_same_document_as_the_rust_api() {
            let source = b"{title: Hey}\n[Am]Hello\n";
            assert_eq!(render(source), render_preview(source));
        }

        #[test]
        fn test_render_accepts_a_null_pointer_for_an_empty_file() {
            let mut len = 0;
            // SAFETY: a zero length makes a null `source` valid.
            let ptr = unsafe { chordsketch_quicklook_render(core::ptr::null(), 0, &mut len) };
            assert!(!ptr.is_null());
            assert!(len > 0);
            // SAFETY: freed exactly once, with the length it came with.
            unsafe { chordsketch_quicklook_free(ptr, len) };
        }

        #[test]
        fn test_reading_up_to_the_read_limit_is_enough_to_detect_an_oversized_file() {
            let oversized = vec![b'x'; chordsketch_quicklook_read_limit()];
            assert!(render(&oversized).contains("too large to preview"));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::registration::SUPPORTED_EXTENSIONS;

    /// `Info.plist` of the `.appex`.
    const EXTENSION_PLIST: &str = include_str!("../../src-tauri/macos/quicklook/Info.plist");
    /// Keys Tauri merges into the desktop app's own `Info.plist`.
    const APP_PLIST: &str = include_str!("../../src-tauri/Info.plist");
    /// The header the Swift code imports the C ABI through.
    const HEADER: &str = include_str!("../../src-tauri/macos/quicklook/ChordSketchQuickLook.h");
    /// The Swift principal class.
    const SWIFT_SOURCE: &str =
        include_str!("../../src-tauri/macos/quicklook/PreviewProvider.swift");
    /// Bundle config that places the `.appex` inside the app.
    const TAURI_MACOS_CONFIG: &str = include_str!("../../src-tauri/tauri.macos.conf.json");

    fn plist_string(key: &str, value: &str) -> String {
        format!("<key>{key}</key>\n\t<string>{value}</string>")
    }

    #[test]
    fn test_the_app_exports_the_chordpro_uti_for_every_supported_extension() {
        assert!(APP_PLIST.contains("<key>UTExportedTypeDeclarations</key>"));
        assert!(APP_PLIST.contains(&format!("<string>{CHORDPRO_UTI}</string>")));
        assert!(APP_PLIST.contains(&format!("<string>{CHORDPRO_MIME_TYPE}</string>")));
        assert!(APP_PLIST.contains("<string>public.plain-text</string>"));
        for ext in SUPPORTED_EXTENSIONS {
            let bare = ext.trim_start_matches('.');
            assert!(
                APP_PLIST.contains(&format!("<string>{bare}</string>")),
                "the app's Info.plist does not tag {ext} with {CHORDPRO_UTI}"
            );
        }
    }

    /// The UTI is the only thing tying the extension to a file: the
    /// app declares which extensions map to it, the extension declares
    /// it previews it. A typo on either side leaves Finder showing the
    /// plain-text preview with nothing reporting an error.
    #[test]
    fn test_the_extension_previews_the_uti_the_app_exports() {
        assert!(EXTENSION_PLIST.contains("<key>QLSupportedContentTypes</key>"));
        assert!(EXTENSION_PLIST.contains(&format!("<string>{CHORDPRO_UTI}</string>")));
    }

    #[test]
    fn test_the_extension_is_a_data_based_quick_look_preview() {
        assert!(EXTENSION_PLIST.contains("<string>com.apple.quicklook.preview</string>"));
        assert!(EXTENSION_PLIST.contains("<key>QLIsDataBasedPreview</key>\n\t\t\t<true/>"));
    }

    #[test]
    fn test_the_extension_identifier_is_prefixed_by_the_app_identifier() {
        let app_id = "me.koeda.chordsketch.desktop";
        assert!(
            include_str!("../../src-tauri/tauri.conf.json")
                .contains(&format!("\"identifier\": \"{app_id}\""))
        );
        assert!(EXTENSION_BUNDLE_ID.starts_with(&format!("{app_id}.")));
        assert!(EXTENSION_PLIST.contains(&plist_string("CFBundleIdentifier", EXTENSION_BUNDLE_ID)));
    }

    #[test]
    fn test_the_principal_class_is_the_one_the_swift_source_declares() {
        assert!(EXTENSION_PLIST.contains(&format!("<string>{PRINCIPAL_CLASS}</string>")));
        assert!(SWIFT_SOURCE.contains(&format!("@objc({PRINCIPAL_CLASS})")));
    }

    #[test]
    fn test_the_bundle_places_the_extension_under_plugins_with_its_executable_name() {
        assert!(EXTENSION_PLIST.contains(&plist_string("CFBundleExecutable", EXTENSION_NAME)));
        assert!(TAURI_MACOS_CONFIG.contains(&format!("\"PlugIns/{EXTENSION_NAME}.appex\"")));
    }

    #[test]
    fn test_the_header_declares_every_exported_function() {
        for name in [
            "chordsketch_quicklook_read_limit",
            "chordsketch_quicklook_render",
            "chordsketch_quicklook_free",
        ] {
            assert!(
                HEADER.contains(&format!("{name}(")),
                "header does not declare {name}"
            );
            assert!(
                include_str!("quicklook.rs").contains(&format!("extern \"C\" fn {name}(")),
                "{name} is declared in the header but not exported"
            );
        }
    }
}
