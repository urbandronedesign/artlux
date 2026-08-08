// GPU-TO-GPU RE-SHARE: turn a Spout sender's texture into a handle Electron will accept.
//
// WHY THIS EXISTS AT ALL. The point of Spout is that the sender's frame already lives in GPU memory
// that another process may read directly. The CPU path in lib.rs throws that away: it reads the
// texture back to system memory (~9 ms of main-thread stall at 1080p), converts it, and ships 8.3 MB
// per frame across an IPC structured clone — so a picture that began on this GPU crosses to the CPU
// and back for no reason but the process boundary. Electron's `sharedTexture` API can import a
// D3D11 texture straight into the renderer as a `VideoFrame`, which removes both costs.
//
// SO WHY NOT HAND ELECTRON SPOUT'S OWN HANDLE? Because it will not take it. Electron requires an NT
// handle — it calls DuplicateHandle on what you give it — and Spout's NT-handle mode is an OPT-IN
// parameter its senders rarely set (`CreateSharedDX11Texture(..., bNThandle)`); the default branch is
// `D3D11_RESOURCE_MISC_SHARED` with `GetSharedHandle()`, a legacy DX9-style token that is not a kernel
// object at all. Measured against a live sender: handle 0x40002342, and importSharedTexture fails
// with "Unable to duplicate handle." We cannot fix that upstream either — Resolume, TouchDesigner and
// OBS choose it, not us.
//
// So we re-share. Open the sender's texture on our own device, copy it into a texture WE created with
// MISC_SHARED_NTHANDLE, and hand out a handle to that. The copy is GPU→GPU: it never touches system
// memory, and it costs a fraction of the readback it replaces.

use std::sync::Mutex;
use windows::core::Interface;
use windows::Win32::Foundation::{CloseHandle, HANDLE, HMODULE};
use windows::Win32::Graphics::Direct3D::{D3D_DRIVER_TYPE_HARDWARE, D3D_FEATURE_LEVEL_11_0};
use windows::Win32::Graphics::Direct3D11::{
    D3D11CreateDevice, ID3D11Device, ID3D11Device1, ID3D11DeviceContext, ID3D11Texture2D,
    D3D11_BIND_RENDER_TARGET, D3D11_BIND_SHADER_RESOURCE, D3D11_CREATE_DEVICE_BGRA_SUPPORT,
    D3D11_RESOURCE_MISC_SHARED_KEYEDMUTEX, D3D11_RESOURCE_MISC_SHARED_NTHANDLE, D3D11_SDK_VERSION,
    D3D11_TEXTURE2D_DESC, D3D11_USAGE_DEFAULT,
};
use windows::Win32::Graphics::Dxgi::Common::{DXGI_FORMAT, DXGI_SAMPLE_DESC};
use windows::Win32::Graphics::Dxgi::{IDXGIKeyedMutex, IDXGIResource1};

// The key both sides use. Dawn (Chromium's D3D backend) synchronises an imported shared texture on
// its keyed mutex with a FIXED key of 0 when no fence handle is supplied, so 0 is not a choice —
// it is the protocol.
const MUTEX_KEY: u64 = 0;

// How long to wait for the importer to hand the texture back before skipping a frame. This runs on
// the main process's thread, so an infinite wait would hang the whole app on a stalled compositor:
// dropping a frame is always the better failure.
const ACQUIRE_TIMEOUT_MS: u32 = 8;

// DXGI_SHARED_RESOURCE_READ / _WRITE. Not surfaced as constants by the windows crate's DXGI module,
// and they are plain access bits, so they are spelled out here rather than hunted for.
const DXGI_SHARED_RESOURCE_READ: u32 = 0x8000_0000;
const DXGI_SHARED_RESOURCE_WRITE: u32 = 0x0000_0001;

pub struct Shared {
    /// NT handle to OUR texture, valid in this process. Electron duplicates it on import.
    pub handle: isize,
    pub width: u32,
    pub height: u32,
    pub format: u32,
}

struct Ctx {
    device: ID3D11Device,
    context: ID3D11DeviceContext,
    /// Our NT-shared destination texture, and the handle onto it. Rebuilt on a size/format change.
    dest: Option<ID3D11Texture2D>,
    handle: Option<HANDLE>,
    w: u32,
    h: u32,
    fmt: u32,
    /// The sender handle `src` was opened from — reopened when the sender resizes and republishes.
    src_handle: isize,
    src: Option<ID3D11Texture2D>,
}

// The D3D11 device and its immediate context are used only from the JS thread (the poll runs there),
// exactly like the Receiver in lib.rs. COM pointers are not Send by default, so this asserts what the
// call pattern already guarantees.
unsafe impl Send for Ctx {}

static CTX: Mutex<Option<Ctx>> = Mutex::new(None);

fn make_ctx() -> windows::core::Result<Ctx> {
    let mut device: Option<ID3D11Device> = None;
    let mut context: Option<ID3D11DeviceContext> = None;
    unsafe {
        D3D11CreateDevice(
            None, // default adapter — must be the sender's adapter; a cross-GPU open fails below
            D3D_DRIVER_TYPE_HARDWARE,
            HMODULE::default(), // no software rasterizer
            // BGRA support: Spout's usual format is B8G8R8A8_UNORM, and without this flag device
            // creation can refuse it outright on some drivers.
            D3D11_CREATE_DEVICE_BGRA_SUPPORT,
            Some(&[D3D_FEATURE_LEVEL_11_0]),
            D3D11_SDK_VERSION,
            Some(&mut device),
            None,
            Some(&mut context),
        )?;
    }
    Ok(Ctx {
        device: device.unwrap(),
        context: context.unwrap(),
        dest: None,
        handle: None,
        w: 0,
        h: 0,
        fmt: 0,
        src_handle: 0,
        src: None,
    })
}

// Open the sender's texture. Spout may publish EITHER handle type, so try both — legacy first,
// because it is the default its senders actually ship with.
unsafe fn open_source(dev: &ID3D11Device, raw: isize) -> windows::core::Result<ID3D11Texture2D> {
    let h = HANDLE(raw as *mut _);
    let mut out: Option<ID3D11Texture2D> = None;
    let legacy = unsafe { dev.OpenSharedResource::<ID3D11Texture2D>(h, &mut out) };
    if legacy.is_ok() {
        if let Some(t) = out.take() {
            return Ok(t);
        }
    }
    // NT-handle sender (the opt-in path): needs the ...1 variant on ID3D11Device1, which — unlike
    // its predecessor above — returns the interface directly rather than through an out-param.
    let dev1: ID3D11Device1 = dev.cast()?;
    unsafe { dev1.OpenSharedResource1::<ID3D11Texture2D>(h) }
}

// (Re)create our destination texture and its NT handle for this size/format.
unsafe fn make_dest(ctx: &mut Ctx, w: u32, h: u32, fmt: u32) -> windows::core::Result<()> {
    // Release the previous handle first — these are kernel objects, and leaking one per sender
    // resize would bleed handles for the life of the process.
    if let Some(old) = ctx.handle.take() {
        let _ = unsafe { CloseHandle(old) };
    }
    ctx.dest = None;

    let desc = D3D11_TEXTURE2D_DESC {
        Width: w,
        Height: h,
        MipLevels: 1,
        ArraySize: 1,
        Format: DXGI_FORMAT(fmt as i32),
        SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
        Usage: D3D11_USAGE_DEFAULT,
        BindFlags: (D3D11_BIND_SHADER_RESOURCE.0 | D3D11_BIND_RENDER_TARGET.0) as u32,
        CPUAccessFlags: 0,
        // An NT handle is the only kind Electron can duplicate — and D3D11 will not create one
        // without a keyed mutex beside it (NTHANDLE alone returns E_INVALIDARG). That pairing is
        // convenient rather than merely obligatory: the mutex is exactly the interlock this path
        // needs, since we write the texture while the compositor reads it.
        MiscFlags: (D3D11_RESOURCE_MISC_SHARED_NTHANDLE.0 | D3D11_RESOURCE_MISC_SHARED_KEYEDMUTEX.0)
            as u32,
    };
    let mut tex: Option<ID3D11Texture2D> = None;
    unsafe { ctx.device.CreateTexture2D(&desc, None, Some(&mut tex))? };
    let tex = tex.unwrap();

    let res: IDXGIResource1 = tex.cast()?;
    let handle = unsafe {
        res.CreateSharedHandle(None, DXGI_SHARED_RESOURCE_READ | DXGI_SHARED_RESOURCE_WRITE, None)?
    };

    ctx.dest = Some(tex);
    ctx.handle = Some(handle);
    ctx.w = w;
    ctx.h = h;
    ctx.fmt = fmt;
    Ok(())
}

/// Copy the sender's current texture into our shared one and return a handle to it.
///
/// `src_handle` is Spout's published share handle, `w`/`h`/`fmt` the sender's current description.
/// Returns None if anything fails — the caller falls back to the CPU path rather than dropping the
/// picture, because a black surface is a worse answer than a slow one.
pub fn reshare(src_handle: isize, w: u32, h: u32, fmt: u32) -> Option<Shared> {
    if src_handle == 0 || w == 0 || h == 0 {
        return None;
    }
    let mut g = CTX.lock().ok()?;
    if g.is_none() {
        match make_ctx() {
            Ok(c) => *g = Some(c),
            Err(e) => {
                eprintln!("[spout] D3D11 device for re-share failed: {e}");
                return None;
            }
        }
    }
    let ctx = g.as_mut()?;

    unsafe {
        // Reopen the source whenever the sender republishes (resize gives a new handle).
        if ctx.src.is_none() || ctx.src_handle != src_handle {
            match open_source(&ctx.device, src_handle) {
                Ok(t) => {
                    ctx.src = Some(t);
                    ctx.src_handle = src_handle;
                }
                Err(e) => {
                    eprintln!("[spout] open shared source failed: {e}");
                    ctx.src = None;
                    return None;
                }
            }
        }
        if ctx.dest.is_none() || ctx.w != w || ctx.h != h || ctx.fmt != fmt {
            if let Err(e) = make_dest(ctx, w, h, fmt) {
                eprintln!("[spout] create shared dest failed: {e}");
                return None;
            }
        }
        let (src, dest) = (ctx.src.clone()?, ctx.dest.clone()?);
        // Take the keyed mutex before writing. The importing side (Dawn) acquires the same key when
        // it reads, so this is what stops us overwriting a frame mid-composite — the tearing this
        // path would otherwise be prone to, since nothing else sequences the two processes.
        //
        // A timeout rather than INFINITE: this is the main process's thread. If the compositor is
        // wedged, dropping this frame keeps the app responsive; blocking would take everything down
        // with it.
        let mutex: IDXGIKeyedMutex = dest.cast().ok()?;
        if mutex.AcquireSync(MUTEX_KEY, ACQUIRE_TIMEOUT_MS).is_err() {
            return None; // reader still holds it — skip this frame, try the next poll
        }
        // The copy. Whole-resource, same format and size, so the driver takes its fastest path — and
        // it stays entirely in VRAM, which is the difference between this and the readback it replaces.
        ctx.context.CopyResource(&dest, &src);
        // Submit before releasing: the mutex orders access, but only work actually handed to the GPU
        // is ordered by it. Releasing with the copy still queued would let the reader in first.
        ctx.context.Flush();
        let _ = mutex.ReleaseSync(MUTEX_KEY);
    }

    Some(Shared {
        handle: ctx.handle?.0 as isize,
        width: w,
        height: h,
        format: fmt,
    })
}

/// Release a raw ID3D11Texture2D* that something else created and handed us ownership of.
///
/// Spout's ReceiveTexture creates its target texture and leaves the caller owning it, so this is how
/// that one gets freed. Taking it with `from_raw` transfers the reference into a Rust value whose
/// drop calls Release exactly once.
///
/// # Safety
/// `ptr` must be a live ID3D11Texture2D* we hold a reference to, and must not be used afterwards.
pub unsafe fn release_texture(ptr: *mut std::ffi::c_void) {
    if ptr.is_null() {
        return;
    }
    drop(unsafe { ID3D11Texture2D::from_raw(ptr) });
}

/// Drop the device, the textures and the NT handle. Called on disconnect.
pub fn reset() {
    if let Ok(mut g) = CTX.lock() {
        if let Some(ctx) = g.as_mut() {
            if let Some(h) = ctx.handle.take() {
                let _ = unsafe { CloseHandle(h) };
            }
        }
        *g = None;
    }
}
