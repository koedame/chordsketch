//! The window the preview pane draws into.
//!
//! A [`PreviewSurface`] owns one child window parented to the HWND the
//! shell hands us, plus the WebView2 control that fills it. The child
//! window is a plain `STATIC` control so that a failure to bring up
//! WebView2 still has somewhere to say so: on the happy path the
//! WebView2 control covers it completely, and on the unhappy path its
//! own text is what the user reads.

use std::num::NonZeroIsize;
use std::path::PathBuf;

use raw_window_handle::{
    HandleError, HasWindowHandle, RawWindowHandle, Win32WindowHandle, WindowHandle,
};
use windows::Win32::Foundation::{E_INVALIDARG, HWND, LPARAM, RECT, WPARAM};
use windows::Win32::Graphics::Gdi::{DEFAULT_GUI_FONT, GetStockObject};
use windows::Win32::System::Com::CoTaskMemFree;
use windows::Win32::UI::Input::KeyboardAndMouse::SetFocus;
use windows::Win32::UI::Shell::{FOLDERID_LocalAppDataLow, KF_FLAG_CREATE, SHGetKnownFolderPath};
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DestroyWindow, SWP_NOACTIVATE, SWP_NOZORDER, SendMessageW, SetParent,
    SetWindowPos, SetWindowTextW, WINDOW_EX_STYLE, WINDOW_STYLE, WM_SETFONT, WS_CHILD,
    WS_CLIPCHILDREN, WS_VISIBLE,
};
use windows::core::{HSTRING, PCWSTR, Result as WinResult, w};
use wry::dpi::{PhysicalPosition, PhysicalSize};
use wry::{Rect, WebContext, WebView, WebViewBuilder};

/// `SS_NOPREFIX` from `winuser.h`. The `STATIC` control styles are not
/// part of the Win32 metadata the `windows` crate is generated from, so
/// the one style we need is spelled out here. Without it an `&` in an
/// error message would be swallowed as a keyboard-mnemonic marker. The
/// remaining default (`SS_LEFT`, zero) is what word-wraps a message
/// that does not fit on one line.
const SS_NOPREFIX: u32 = 0x0000_0080;

/// Why the preview surface could not show a rendered document.
///
/// Both variants are shown to the user in the preview pane rather than
/// swallowed: a blank pane is indistinguishable from a broken install.
#[derive(Debug)]
pub(crate) enum SurfaceError {
    /// The per-user folder WebView2 keeps its profile in could not be
    /// resolved or created.
    UserDataFolder(windows::core::Error),
    /// The WebView2 control itself could not be created — most often
    /// because the WebView2 Runtime is missing.
    WebView(wry::Error),
}

impl std::fmt::Display for SurfaceError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::UserDataFolder(e) => {
                write!(f, "the WebView2 data folder is unavailable ({e})")
            }
            Self::WebView(e) => write!(f, "WebView2 could not start ({e})"),
        }
    }
}

/// Borrowed HWND in the shape `wry` expects.
struct HostWindowHandle(HWND);

impl HasWindowHandle for HostWindowHandle {
    fn window_handle(&self) -> std::result::Result<WindowHandle<'_>, HandleError> {
        let hwnd = NonZeroIsize::new(self.0.0 as isize).ok_or(HandleError::Unavailable)?;
        let handle = Win32WindowHandle::new(hwnd);
        // SAFETY: the HWND belongs to the `PreviewSurface` that built
        // this wrapper and stays valid for the borrow, which never
        // escapes the `WebViewBuilder::build_as_child` call below.
        Ok(unsafe { WindowHandle::borrow_raw(RawWindowHandle::Win32(handle)) })
    }
}

pub(crate) struct PreviewSurface {
    /// Declared first so it is dropped first: the WebView2 controller
    /// must go away before the environment it was created from and
    /// before the window it is parented to.
    webview: Option<WebView>,
    /// Built on the first `show_document` call, not on construction:
    /// resolving the profile folder can fail, and a failure there has
    /// to reach the user as text in the pane rather than as an error
    /// out of `DoPreview` (which Explorer renders as a bare "No
    /// preview available").
    context: Option<WebContext>,
    hwnd: HWND,
}

impl PreviewSurface {
    /// Create the child window, parented to the shell's preview window.
    ///
    /// # Errors
    ///
    /// Propagates the `CreateWindowExW` failure.
    pub(crate) fn new(parent: HWND, bounds: RECT) -> WinResult<Self> {
        let hwnd = unsafe {
            CreateWindowExW(
                WINDOW_EX_STYLE(0),
                w!("STATIC"),
                PCWSTR::null(),
                WS_CHILD | WS_VISIBLE | WS_CLIPCHILDREN | WINDOW_STYLE(SS_NOPREFIX),
                bounds.left,
                bounds.top,
                bounds.right - bounds.left,
                bounds.bottom - bounds.top,
                Some(parent),
                None,
                None,
                None,
            )?
        };
        // Without this the STATIC control falls back to the bitmap
        // system font, which looks broken next to the rest of the
        // shell. Only ever visible on the error path.
        let font = unsafe { GetStockObject(DEFAULT_GUI_FONT) };
        unsafe {
            SendMessageW(
                hwnd,
                WM_SETFONT,
                Some(WPARAM(font.0 as usize)),
                Some(LPARAM(1)),
            )
        };
        Ok(Self {
            webview: None,
            context: None,
            hwnd,
        })
    }

    /// The window the shell should treat as the preview.
    pub(crate) fn hwnd(&self) -> HWND {
        self.hwnd
    }

    /// Show `html` in a WebView2 control filling the child window.
    ///
    /// # Errors
    ///
    /// Returns [`SurfaceError::WebView`] when the WebView2 control
    /// cannot be created; the caller is expected to surface the message
    /// via [`Self::show_message`].
    pub(crate) fn show_document(
        &mut self,
        html: &str,
        bounds: RECT,
    ) -> std::result::Result<(), SurfaceError> {
        let mut context = WebContext::new(Some(
            webview2_user_data_dir().map_err(SurfaceError::UserDataFolder)?,
        ));
        let webview = WebViewBuilder::new_with_web_context(&mut context)
            // The document is self-contained and carries its own
            // Content Security Policy; nothing here should offer a
            // browser context menu or a web inspector.
            .with_devtools(false)
            .with_bounds(fill(bounds))
            .with_html(html)
            .build_as_child(&HostWindowHandle(self.hwnd))
            .map_err(SurfaceError::WebView)?;
        self.webview = Some(webview);
        self.context = Some(context);
        Ok(())
    }

    /// Replace the surface content with a plain-text message.
    ///
    /// Used for every failure path, so a preview that cannot be drawn
    /// says why instead of leaving an empty pane.
    pub(crate) fn show_message(&self, message: &str) {
        // SetWindowTextW cannot fail for a window we own; a failure
        // here would only mean the message is missing, and there is no
        // second channel to report that on.
        let _ = unsafe { SetWindowTextW(self.hwnd, &HSTRING::from(message)) };
    }

    /// Move / resize the child window and the WebView2 control in it.
    pub(crate) fn set_bounds(&self, bounds: RECT) {
        let _ = unsafe {
            SetWindowPos(
                self.hwnd,
                None,
                bounds.left,
                bounds.top,
                bounds.right - bounds.left,
                bounds.bottom - bounds.top,
                SWP_NOACTIVATE | SWP_NOZORDER,
            )
        };
        if let Some(webview) = &self.webview {
            let _ = webview.set_bounds(fill(bounds));
        }
    }

    /// Re-parent the child window after the shell moves the preview.
    pub(crate) fn reparent(&self, parent: HWND) {
        let _ = unsafe { SetParent(self.hwnd, Some(parent)) };
    }

    /// Give the surface keyboard focus.
    pub(crate) fn focus(&self) {
        if let Some(webview) = &self.webview {
            let _ = webview.focus();
            return;
        }
        // The return value is the previously focused window, not a
        // status; there is nothing to react to.
        let _ = unsafe { SetFocus(Some(self.hwnd)) };
    }
}

impl Drop for PreviewSurface {
    fn drop(&mut self) {
        // Tear the WebView2 control down before its host window: the
        // controller holds child windows of `self.hwnd`, and destroying
        // the parent first leaves it operating on dead handles.
        self.webview = None;
        let _ = unsafe { DestroyWindow(self.hwnd) };
    }
}

/// The WebView2 bounds that cover the whole child window.
///
/// `bounds` arrives in the parent's client coordinates; the child
/// window has already been positioned there, so the control inside it
/// starts at its own origin.
fn fill(bounds: RECT) -> Rect {
    Rect {
        position: PhysicalPosition::new(0, 0).into(),
        size: PhysicalSize::new(
            (bounds.right - bounds.left).max(0),
            (bounds.bottom - bounds.top).max(0),
        )
        .into(),
    }
}

/// Folder WebView2 keeps its profile in.
///
/// `LocalLow` rather than `LocalAppData` on purpose: Explorer runs
/// `prevhost.exe` at low integrity for files that came from an
/// untrusted zone, and `LocalLow` is the only per-user location such a
/// process may write to. WebView2 defaults the profile to the folder
/// of the hosting executable, which here is `prevhost.exe` inside
/// `System32` — not writable at any integrity level — so this is not
/// optional.
fn webview2_user_data_dir() -> WinResult<PathBuf> {
    let wide = unsafe { SHGetKnownFolderPath(&FOLDERID_LocalAppDataLow, KF_FLAG_CREATE, None)? };
    let decoded = unsafe { wide.to_string() };
    unsafe { CoTaskMemFree(Some(wide.0.cast())) };
    // A known-folder path that is not valid UTF-16 would mean the shell
    // handed back a malformed string; there is no more specific status
    // to report it with than "bad argument".
    let base = PathBuf::from(decoded.map_err(|_| windows::core::Error::from(E_INVALIDARG))?);
    Ok(base.join("ChordSketch").join("PreviewHandler"))
}
