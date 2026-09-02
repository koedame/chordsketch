//! COM plumbing for the Explorer preview pane.
//!
//! Explorer loads this DLL into `prevhost.exe`, asks it for the class
//! object of [`registration::PREVIEW_HANDLER_CLSID`], and drives the
//! resulting object through `IInitializeWithStream` → `IPreviewHandler`.
//! Everything here is glue: the rendering contract lives in
//! [`crate::document`].

mod factory;
mod handler;
mod host;

use std::ffi::c_void;
use std::sync::atomic::{AtomicUsize, Ordering};

use windows::Win32::Foundation::{CLASS_E_CLASSNOTAVAILABLE, E_POINTER, S_FALSE, S_OK};
use windows::Win32::System::Com::IClassFactory;
use windows::core::{GUID, HRESULT, Interface};

/// CLSID of the preview handler class, as a [`GUID`].
///
/// Must stay byte-identical to
/// [`crate::registration::PREVIEW_HANDLER_CLSID`], which is what the
/// installers write into the registry;
/// `test_the_guid_matches_the_registered_clsid` below is the guard.
const CLSID_CHORDPRO_PREVIEW_HANDLER: GUID =
    GUID::from_u128(0x32e6_5e30_8242_492f_9985_c778_5bb3_8bc7);

/// Number of live COM objects served by this DLL.
///
/// `DllCanUnloadNow` reports "unloadable" only at zero, so the shell
/// cannot pull the module out from under a preview that is still on
/// screen.
static OBJECT_COUNT: AtomicUsize = AtomicUsize::new(0);

/// Registers the creation of a COM object served by this DLL.
pub(crate) fn object_created() {
    OBJECT_COUNT.fetch_add(1, Ordering::Relaxed);
}

/// Registers the destruction of a COM object served by this DLL.
pub(crate) fn object_destroyed() {
    OBJECT_COUNT.fetch_sub(1, Ordering::Relaxed);
}

/// COM entry point: hand out the class factory for our CLSID.
///
/// # Safety
///
/// Called by COM with a valid `rclsid` / `riid` pair and a writable
/// `ppv`. The pointers are dereferenced exactly as the COM contract
/// specifies.
#[unsafe(no_mangle)]
pub unsafe extern "system" fn DllGetClassObject(
    rclsid: *const GUID,
    riid: *const GUID,
    ppv: *mut *mut c_void,
) -> HRESULT {
    if ppv.is_null() {
        return E_POINTER;
    }
    // COM requires `*ppv` to be NULL on every failure path, not just
    // on the ones that get far enough to touch it.
    unsafe { *ppv = std::ptr::null_mut() };
    if rclsid.is_null() || riid.is_null() {
        return E_POINTER;
    }
    if unsafe { *rclsid } != CLSID_CHORDPRO_PREVIEW_HANDLER {
        return CLASS_E_CLASSNOTAVAILABLE;
    }
    let factory: IClassFactory = factory::PreviewHandlerFactory.into();
    unsafe { factory.query(riid, ppv) }
}

/// COM entry point: may the loader unload this DLL?
#[unsafe(no_mangle)]
pub extern "system" fn DllCanUnloadNow() -> HRESULT {
    if OBJECT_COUNT.load(Ordering::Relaxed) == 0 {
        S_OK
    } else {
        S_FALSE
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::registration::PREVIEW_HANDLER_CLSID;

    /// Renders a [`GUID`] in the braced, upper-case form the registry
    /// uses. Written out by hand rather than leaning on `Debug`, so a
    /// formatting change upstream cannot quietly turn this guard into a
    /// no-op.
    fn braced(guid: &GUID) -> String {
        format!(
            "{{{:08X}-{:04X}-{:04X}-{:02X}{:02X}-{:02X}{:02X}{:02X}{:02X}{:02X}{:02X}}}",
            guid.data1,
            guid.data2,
            guid.data3,
            guid.data4[0],
            guid.data4[1],
            guid.data4[2],
            guid.data4[3],
            guid.data4[4],
            guid.data4[5],
            guid.data4[6],
            guid.data4[7],
        )
    }

    #[test]
    fn test_the_guid_matches_the_registered_clsid() {
        assert_eq!(
            braced(&CLSID_CHORDPRO_PREVIEW_HANDLER),
            PREVIEW_HANDLER_CLSID
        );
    }

    #[test]
    fn test_dll_can_unload_now_reports_unloadable_while_no_object_is_alive() {
        assert_eq!(OBJECT_COUNT.load(Ordering::Relaxed), 0);
        assert_eq!(DllCanUnloadNow(), S_OK);
    }

    #[test]
    fn test_dll_can_unload_now_reports_busy_while_an_object_is_alive() {
        object_created();
        assert_eq!(DllCanUnloadNow(), S_FALSE);
        object_destroyed();
        assert_eq!(DllCanUnloadNow(), S_OK);
    }

    #[test]
    fn test_dll_get_class_object_rejects_a_null_out_pointer() {
        let clsid = CLSID_CHORDPRO_PREVIEW_HANDLER;
        let iid = IClassFactory::IID;
        let hr = unsafe { DllGetClassObject(&clsid, &iid, std::ptr::null_mut()) };
        assert_eq!(hr, E_POINTER);
    }

    #[test]
    fn test_dll_get_class_object_rejects_an_unknown_clsid() {
        let other = GUID::from_u128(0xdead_beef_0000_0000_0000_0000_0000_0001);
        let iid = IClassFactory::IID;
        let mut ppv = std::ptr::null_mut();
        let hr = unsafe { DllGetClassObject(&other, &iid, &mut ppv) };
        assert_eq!(hr, CLASS_E_CLASSNOTAVAILABLE);
        assert!(ppv.is_null());
    }

    #[test]
    fn test_dll_get_class_object_returns_the_class_factory_for_our_clsid() {
        let clsid = CLSID_CHORDPRO_PREVIEW_HANDLER;
        let iid = IClassFactory::IID;
        let mut ppv = std::ptr::null_mut();
        let hr = unsafe { DllGetClassObject(&clsid, &iid, &mut ppv) };
        assert!(hr.is_ok());
        assert!(!ppv.is_null());
        // Balance the reference the factory handed out.
        drop(unsafe { IClassFactory::from_raw(ppv) });
    }
}
