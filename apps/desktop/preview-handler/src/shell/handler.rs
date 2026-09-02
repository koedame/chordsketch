//! The `IPreviewHandler` implementation Explorer drives.
//!
//! Lifecycle, in the order the shell calls it: `Initialize` (file
//! contents arrive as an `IStream`), `SetWindow` / `SetRect` (where to
//! draw), `DoPreview` (draw it), `Unload` (tear it down, possibly
//! followed by another `Initialize` on the same object).

use std::cell::RefCell;
use std::ffi::c_void;

use windows::Win32::Foundation::{E_FAIL, E_NOTIMPL, E_UNEXPECTED, HWND, RECT, S_FALSE};
use windows::Win32::System::Com::IStream;
use windows::Win32::System::Ole::{IObjectWithSite, IObjectWithSite_Impl};
use windows::Win32::System::Ole::{IOleWindow, IOleWindow_Impl};
use windows::Win32::UI::Shell::PropertiesSystem::{
    IInitializeWithStream, IInitializeWithStream_Impl,
};
use windows::Win32::UI::Shell::{IPreviewHandler, IPreviewHandler_Impl, IPreviewHandlerFrame};
use windows::Win32::UI::WindowsAndMessaging::MSG;
use windows::core::{GUID, IUnknown, Interface, Ref, Result, implement};

use crate::document::{self, MAX_PREVIEW_SOURCE_BYTES, SourceError, decode_source};
use crate::shell::host::PreviewSurface;
use crate::shell::{object_created, object_destroyed};

/// Size of one `IStream::Read` call. Large enough that a typical song
/// arrives in a single read, small enough to stay off the stack limit
/// of the preview host's UI thread — hence the heap buffer.
const READ_CHUNK_BYTES: usize = 64 * 1024;

/// Shown when the shell asks for a preview it never handed a file to.
const NO_CONTENT_MESSAGE: &str = "No file to preview.";

/// What `DoPreview` decided to put on screen.
enum Planned {
    /// A rendered ChordPro document.
    Document(String),
    /// A plain-text explanation of why there is no document.
    Message(String),
}

#[derive(Default)]
struct State {
    /// Window the shell wants the preview drawn inside.
    parent: HWND,
    /// Where inside `parent`, in its client coordinates.
    bounds: RECT,
    /// Decoded file contents, or why they could not be decoded.
    /// `None` until `Initialize` runs.
    content: Option<std::result::Result<String, SourceError>>,
    /// Live only between `DoPreview` and `Unload`.
    surface: Option<PreviewSurface>,
    /// Set by `IObjectWithSite`; the shell's `IPreviewHandlerFrame`
    /// lives behind it and owns accelerator handling.
    site: Option<IUnknown>,
}

#[implement(IPreviewHandler, IInitializeWithStream, IObjectWithSite, IOleWindow)]
pub(crate) struct ChordProPreviewHandler {
    state: RefCell<State>,
}

impl ChordProPreviewHandler {
    pub(crate) fn new() -> Self {
        object_created();
        Self {
            state: RefCell::new(State::default()),
        }
    }
}

impl Drop for ChordProPreviewHandler {
    fn drop(&mut self) {
        object_destroyed();
    }
}

impl IPreviewHandler_Impl for ChordProPreviewHandler_Impl {
    fn SetWindow(&self, hwnd: HWND, prc: *const RECT) -> Result<()> {
        let mut state = self.state.borrow_mut();
        state.parent = hwnd;
        if let Some(rect) = unsafe { prc.as_ref() } {
            state.bounds = *rect;
        }
        if let Some(surface) = &state.surface {
            surface.reparent(state.parent);
            surface.set_bounds(state.bounds);
        }
        Ok(())
    }

    fn SetRect(&self, prc: *const RECT) -> Result<()> {
        let mut state = self.state.borrow_mut();
        let Some(rect) = (unsafe { prc.as_ref() }) else {
            return Err(E_UNEXPECTED.into());
        };
        state.bounds = *rect;
        if let Some(surface) = &state.surface {
            surface.set_bounds(state.bounds);
        }
        Ok(())
    }

    fn DoPreview(&self) -> Result<()> {
        let mut state = self.state.borrow_mut();
        if state.surface.is_some() {
            // The shell only calls DoPreview once per Initialize; a
            // second call with a live surface would leak the first.
            return Ok(());
        }
        if state.parent.is_invalid() {
            return Err(E_UNEXPECTED.into());
        }

        // Decide what to draw before creating any window, so the
        // rendering step does not hold a borrow of `state` across the
        // window and WebView2 construction below.
        let planned = match &state.content {
            None => Planned::Message(NO_CONTENT_MESSAGE.to_string()),
            Some(Err(error)) => Planned::Message(error.to_string()),
            Some(Ok(source)) => Planned::Document(document::render_document(source)),
        };

        let bounds = state.bounds;
        let mut surface = PreviewSurface::new(state.parent, bounds)?;
        match planned {
            Planned::Message(message) => surface.show_message(&message),
            Planned::Document(html) => {
                if let Err(error) = surface.show_document(&html, bounds) {
                    surface.show_message(&format!("This file cannot be previewed: {error}"));
                }
            }
        }
        state.surface = Some(surface);
        Ok(())
    }

    fn Unload(&self) -> Result<()> {
        let mut state = self.state.borrow_mut();
        // Dropping the surface destroys the WebView2 control and the
        // child window; the object itself stays alive because the shell
        // may Initialize it again with a different file.
        state.surface = None;
        state.content = None;
        Ok(())
    }

    fn SetFocus(&self) -> Result<()> {
        let state = self.state.borrow();
        let Some(surface) = &state.surface else {
            return Err(S_FALSE.into());
        };
        surface.focus();
        Ok(())
    }

    fn QueryFocus(&self) -> Result<HWND> {
        let focused = unsafe { windows::Win32::UI::Input::KeyboardAndMouse::GetFocus() };
        if focused.is_invalid() {
            // Documented answer for "no window on this thread holds
            // focus" — there is no HWND to report.
            return Err(E_FAIL.into());
        }
        Ok(focused)
    }

    fn TranslateAccelerator(&self, pmsg: *const MSG) -> Result<()> {
        let site = self.state.borrow().site.clone();
        let Some(site) = site else {
            // S_FALSE is the documented "not handled, please route it
            // yourself" answer. `windows-rs` models an HRESULT-only
            // method as `Result<()>`, where `Ok` is hard-wired to
            // S_OK — returning the non-error S_FALSE has to go through
            // the `Err` arm to reach the caller unchanged.
            return Err(S_FALSE.into());
        };
        let Ok(frame) = site.cast::<IPreviewHandlerFrame>() else {
            return Err(S_FALSE.into());
        };
        // `windows-rs` collapses an HRESULT-only method to `Result<()>`
        // and treats every non-error code as `Ok`, so an S_FALSE from
        // the frame ("I did not handle it either") reaches the shell as
        // S_OK. Forwarding verbatim is what the platform sample does;
        // the lost distinction only affects which component performs
        // the default handling of an unclaimed key.
        unsafe { frame.TranslateAccelerator(pmsg) }
    }
}

impl IInitializeWithStream_Impl for ChordProPreviewHandler_Impl {
    fn Initialize(&self, pstream: Ref<'_, IStream>, _grfmode: u32) -> Result<()> {
        let stream = pstream.ok()?;
        let bytes = read_stream(stream)?;
        self.state.borrow_mut().content = Some(decode_source(&bytes));
        Ok(())
    }
}

impl IObjectWithSite_Impl for ChordProPreviewHandler_Impl {
    fn SetSite(&self, punksite: Ref<'_, IUnknown>) -> Result<()> {
        self.state.borrow_mut().site = punksite.ok().ok().cloned();
        Ok(())
    }

    fn GetSite(&self, riid: *const GUID, ppvsite: *mut *mut c_void) -> Result<()> {
        if ppvsite.is_null() {
            return Err(windows::Win32::Foundation::E_POINTER.into());
        }
        unsafe { *ppvsite = std::ptr::null_mut() };
        let site = self.state.borrow().site.clone();
        let Some(site) = site else {
            // Documented answer for "no site has been set".
            return Err(E_FAIL.into());
        };
        unsafe { site.query(riid, ppvsite).ok() }
    }
}

impl IOleWindow_Impl for ChordProPreviewHandler_Impl {
    fn GetWindow(&self) -> Result<HWND> {
        let state = self.state.borrow();
        match &state.surface {
            Some(surface) => Ok(surface.hwnd()),
            // The window is created by `DoPreview`; there is nothing to
            // report before then.
            None => Err(E_FAIL.into()),
        }
    }

    fn ContextSensitiveHelp(&self, _fentermode: windows_core::BOOL) -> Result<()> {
        Err(E_NOTIMPL.into())
    }
}

/// Drain the shell's stream, stopping at most one [`READ_CHUNK_BYTES`]
/// chunk past the preview size limit.
///
/// The cap is what keeps a stray multi-gigabyte file from being pulled
/// into the preview host's address space; [`decode_source`] turns the
/// overshoot into the user-visible message.
fn read_stream(stream: &IStream) -> Result<Vec<u8>> {
    let mut out = Vec::new();
    let mut chunk = vec![0u8; READ_CHUNK_BYTES];
    loop {
        let mut read: u32 = 0;
        unsafe {
            stream
                .Read(
                    chunk.as_mut_ptr().cast(),
                    chunk.len() as u32,
                    Some(&mut read),
                )
                .ok()?;
        }
        if read == 0 {
            return Ok(out);
        }
        out.extend_from_slice(&chunk[..read as usize]);
        if out.len() > MAX_PREVIEW_SOURCE_BYTES {
            return Ok(out);
        }
    }
}
