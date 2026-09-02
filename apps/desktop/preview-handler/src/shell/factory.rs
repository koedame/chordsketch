//! Class factory for [`ChordProPreviewHandler`].
//!
//! COM asks the DLL for this object by CLSID (see
//! `DllGetClassObject`), then asks it for one preview handler per file
//! the shell wants drawn.

use std::ffi::c_void;

use windows::Win32::Foundation::{CLASS_E_NOAGGREGATION, E_POINTER};
use windows::Win32::System::Com::{IClassFactory, IClassFactory_Impl};
use windows::core::{GUID, IUnknown, Interface, Ref, Result, implement};
use windows_core::BOOL;

use crate::shell::handler::ChordProPreviewHandler;
use crate::shell::{object_created, object_destroyed};

#[implement(IClassFactory)]
pub(crate) struct PreviewHandlerFactory;

impl IClassFactory_Impl for PreviewHandlerFactory_Impl {
    fn CreateInstance(
        &self,
        punkouter: Ref<'_, IUnknown>,
        riid: *const GUID,
        ppvobject: *mut *mut c_void,
    ) -> Result<()> {
        if ppvobject.is_null() {
            return Err(E_POINTER.into());
        }
        unsafe { *ppvobject = std::ptr::null_mut() };
        if punkouter.ok().is_ok() {
            // Aggregation is never used for preview handlers, and
            // silently ignoring the outer object would produce a
            // handler the aggregator cannot control.
            return Err(CLASS_E_NOAGGREGATION.into());
        }
        let handler: IUnknown = ChordProPreviewHandler::new().into();
        unsafe { handler.query(riid, ppvobject).ok() }
    }

    /// Keeps the DLL loaded across the gap between one preview being
    /// torn down and the next being created.
    fn LockServer(&self, flock: BOOL) -> Result<()> {
        if flock.as_bool() {
            object_created();
        } else {
            object_destroyed();
        }
        Ok(())
    }
}
