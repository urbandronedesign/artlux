//! E0d — SPOUT INTO THE ENGINE (Windows). What the plan asked: can the engine take a Spout sender's
//! texture with no copy at all?
//!
//! A Spout sender shares a D3D11 texture through a LEGACY shared handle (`D3D11_RESOURCE_MISC_SHARED`,
//! `GetSharedHandle()`), not an NT handle — Spout's NT mode is an opt-in its senders rarely set (see
//! native/spout-receiver/src/share.rs, measured against a live sender). So `receive` tries, in order:
//!
//!   1. D3D12 `OpenSharedHandle` on the sender's handle — the true zero-copy. The answer is reported.
//!   2. Otherwise ONE GPU→GPU COPY on the engine's own adapter: a D3D11 device on the SAME adapter
//!      (matched by LUID) opens the sender's texture, and `CopyResource`s it into a texture the engine
//!      created shared (E0c's slot) and also opened in D3D11. The engine reads that. No CPU, no system
//!      memory — the same single copy Spout's own DX12 backend makes through D3D11On12.
//!
//! `send` is a REAL Spout sender (Spout's own library, through spout2-rs) publishing the test card with
//! the frame number in the bar, so the receiver is checked against the genuine protocol, not against
//! this file's idea of it.

use crate::card::Card;
use crate::share::{create_slot_as, Slot};
use crate::{describe, sample_points, AdapterPolicy, Gpu};
use spout2::dx::{Receiver, Sender};
use std::time::{Duration, Instant};
use windows::core::Interface;
use windows::Win32::Foundation::HANDLE;
use windows::Win32::Graphics::Direct3D::D3D_DRIVER_TYPE_UNKNOWN;
use windows::Win32::Graphics::Direct3D11::*;
use windows::Win32::Graphics::Direct3D12::ID3D12Resource;
use windows::Win32::Graphics::Dxgi::Common::DXGI_FORMAT;
use windows::Win32::Graphics::Dxgi::{CreateDXGIFactory1, IDXGIAdapter, IDXGIFactory4};

const W: u32 = 640;
const H: u32 = 360;

/// The test card on the CPU, BGRA8 (Spout's default format): what `Card` draws on the GPU.
fn card_bgra(n: u64) -> Vec<u8> {
    let bar = (n % 240) as f32 / 240.0;
    let mut v = Vec::with_capacity((W * H * 4) as usize);
    for y in 0..H {
        for x in 0..W {
            let (u, vv) = ((x as f32 + 0.5) / W as f32, (y as f32 + 0.5) / H as f32);
            let rgb = if vv < 0.125 {
                if (u - bar).rem_euclid(1.0) < 0.0625 { [255, 0, 255] } else { [0, 0, 0] }
            } else {
                match (u >= 0.5, vv >= 0.5625) {
                    (false, false) => [255, 0, 0],
                    (true, false) => [0, 255, 0],
                    (false, true) => [0, 0, 255],
                    (true, true) => [255, 255, 255],
                }
            };
            v.extend_from_slice(&[rgb[2], rgb[1], rgb[0], 255]);
        }
    }
    v
}

/// `--spout-send <name> [--seconds N]`: a real Spout sender of the test card.
pub fn send(name: &str, run_for: Option<Duration>) -> Result<(), String> {
    let _ = Card::new; // (the GPU card is the receiver-side twin; the sender draws it on the CPU)
    let mut tx = Sender::new(name).map_err(|e| format!("Spout sender: {e}"))?;
    tx.set_format(87); // DXGI_FORMAT_B8G8R8A8_UNORM
    let end = run_for.map(|d| Instant::now() + d);
    let mut n = 0u64;
    eprintln!("spout sender '{name}': {W}x{H} BGRA8");
    while end.map_or(true, |e| Instant::now() < e) {
        tx.send_image(&card_bgra(n), W, H).map_err(|e| format!("SendImage: {e}"))?;
        n += 1;
        std::thread::sleep(Duration::from_millis(16));
    }
    eprintln!("spout sender: {n} frames sent");
    Ok(())
}

/// A D3D11 device on the adapter the engine's D3D12 device runs on (a shared texture opens only there).
fn d3d11_on_engine_adapter(gpu: &Gpu) -> Result<(ID3D11Device, ID3D11DeviceContext), String> {
    let luid = {
        let hal = unsafe { gpu.device.as_hal::<wgpu::hal::api::Dx12>() }.ok_or("the engine device is not D3D12")?;
        unsafe { hal.raw_device().GetAdapterLuid() }
    };
    unsafe {
        let factory: IDXGIFactory4 = CreateDXGIFactory1().map_err(|e| format!("DXGI factory: {e}"))?;
        let adapter: IDXGIAdapter = factory.EnumAdapterByLuid(luid).map_err(|e| format!("adapter by LUID: {e}"))?;
        let (mut dev, mut ctx) = (None, None);
        D3D11CreateDevice(&adapter, D3D_DRIVER_TYPE_UNKNOWN, Default::default(), D3D11_CREATE_DEVICE_BGRA_SUPPORT, None,
            D3D11_SDK_VERSION, Some(&mut dev), None, Some(&mut ctx)).map_err(|e| format!("D3D11CreateDevice: {e}"))?;
        Ok((dev.ok_or("no D3D11 device")?, ctx.ok_or("no D3D11 context")?))
    }
}

fn wgpu_format(dxgi: u32) -> Option<wgpu::TextureFormat> {
    match dxgi {
        87 => Some(wgpu::TextureFormat::Bgra8Unorm),
        28 => Some(wgpu::TextureFormat::Rgba8Unorm),
        _ => None,
    }
}

pub struct ReceiveReport {
    pub direct_open: String,
    pub path: &'static str,
    pub frames_read: u32,
    pub quads_exact: u32,
    pub bar_positions: Vec<i32>,
    /// The ZERO-COPY read: the sender's own texture, opened in D3D12 and sampled as it is. None when
    /// D3D12 refused the handle.
    pub direct: Option<(u32, Vec<i32>)>,
}

/// `--spout-receive <name> [--seconds N]`.
pub fn receive(name: &str, run_for: Duration, policy: AdapterPolicy) -> Result<ReceiveReport, String> {
    let gpu = Gpu::open(policy).map_err(|e| e.to_string())?;
    eprintln!("engine device: {}", describe(&gpu.info));
    let mut rx = Receiver::new(Some(name)).map_err(|e| format!("Spout receiver: {e}"))?;
    let t0 = Instant::now();
    let info = loop {
        if rx.receive() {
            if let Ok(i) = rx.sender_info(name) { if !i.share_handle.is_null() && i.width > 0 { break i; } }
        }
        if t0.elapsed() > Duration::from_secs(5) { return Err(format!("no Spout sender '{name}' within 5 s")); }
        std::thread::sleep(Duration::from_millis(20));
    };
    let fmt = wgpu_format(info.format).ok_or(format!("sender format {} not handled by this spike", info.format))?;
    eprintln!("sender '{name}': {}x{} DXGI format {}, share handle {:?}", info.width, info.height, info.format, info.share_handle);
    let handle = HANDLE(info.share_handle);

    // 1. THE ZERO-COPY QUESTION: can D3D12 open the sender's handle as it is?
    let (direct_open, direct_res) = {
        let hal = unsafe { gpu.device.as_hal::<wgpu::hal::api::Dx12>() }.ok_or("not D3D12")?;
        let mut res: Option<ID3D12Resource> = None;
        match unsafe { hal.raw_device().OpenSharedHandle(handle, &mut res) } {
            Ok(()) if res.is_some() => ("D3D12 OpenSharedHandle ACCEPTED the sender's handle".to_string(), res),
            Ok(()) => ("D3D12 OpenSharedHandle returned no resource".to_string(), None),
            Err(e) => (format!("D3D12 OpenSharedHandle refused the sender's handle: {e}"), None),
        }
    };
    // The sender's texture AS a wgpu texture — no copy of ours anywhere.
    let direct_tex: Option<wgpu::Texture> = direct_res.map(|res| unsafe {
        let size = wgpu::Extent3d { width: info.width, height: info.height, depth_or_array_layers: 1 };
        let ht = wgpu::hal::dx12::Device::texture_from_raw(res, fmt, wgpu::TextureDimension::D2, size, 1, 1);
        gpu.device.create_texture_from_hal::<wgpu::hal::api::Dx12>(ht, &wgpu::TextureDescriptor {
            label: Some("spout sender (direct)"), size, mip_level_count: 1, sample_count: 1,
            dimension: wgpu::TextureDimension::D2, format: fmt, usage: wgpu::TextureUsages::TEXTURE_BINDING, view_formats: &[],
        }, wgpu::wgt::TextureUses::UNINITIALIZED)
    });
    eprintln!("{direct_open}");

    // 2. ONE GPU→GPU COPY on the engine's adapter.
    let (d11, ctx) = d3d11_on_engine_adapter(&gpu)?;
    let src: ID3D11Texture2D = unsafe {
        let mut t: Option<ID3D11Texture2D> = None;
        d11.OpenSharedResource(handle, &mut t).map_err(|e| format!("D3D11 OpenSharedResource (legacy): {e}"))?;
        t.ok_or("no source texture")?
    };
    let slot: Slot = create_slot_as(&gpu, info.width, info.height, DXGI_FORMAT(info.format as i32), fmt,
        wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_SRC)?;
    let dst: ID3D11Texture2D = unsafe {
        let d1: ID3D11Device1 = d11.cast().map_err(|e| e.to_string())?;
        d1.OpenSharedResource1(slot.local).map_err(|e| format!("D3D11 OpenSharedResource1 (the engine's slot): {e}"))?
    };
    let query: ID3D11Query = unsafe {
        let mut q = None;
        d11.CreateQuery(&D3D11_QUERY_DESC { Query: D3D11_QUERY_EVENT, MiscFlags: 0 }, Some(&mut q)).map_err(|e| e.to_string())?;
        q.ok_or("no query")?
    };
    let (tw, th) = (info.width, info.height);
    let quads = [[0.25f32, 0.34], [0.75, 0.34], [0.25, 0.78], [0.75, 0.78]];
    let mut uvs: Vec<[f32; 2]> = quads.to_vec();
    let row_y = ((th as f32 * 0.06) as u32 as f32 + 0.5) / th as f32;
    for x in 0..tw { uvs.push([(x as f32 + 0.5) / tw as f32, row_y]); }
    let want = [255u8, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255];
    let mut rep = ReceiveReport { direct_open, path: "one GPU→GPU copy (D3D11 on the engine's adapter → the engine's shared texture)", frames_read: 0, quads_exact: 0, bar_positions: Vec::new(),
        direct: direct_tex.as_ref().map(|_| (0, Vec::new())) };
    let end = Instant::now() + run_for;
    while Instant::now() < end {
        rx.receive();
        unsafe {
            ctx.CopyResource(&dst, &src);
            ctx.End(&query);
            ctx.Flush();
            // The copy must be COMPLETE before the engine's queue reads the texture (another device).
            // An EVENT query writes TRUE once the GPU has passed it. (GetData's S_FALSE, "not yet", is a
            // success code, so the Result alone cannot tell — the written BOOL can.)
            loop {
                let mut done: i32 = 0;   // a Win32 BOOL
                let _ = ctx.GetData(&query, Some(&mut done as *mut _ as *mut core::ffi::c_void), std::mem::size_of_val(&done) as u32, 0);
                if done != 0 { break; }
                std::thread::yield_now();
            }
        }
        let px = sample_points(&gpu, &slot.texture, &uvs).map_err(|e| e.to_string())?;
        // sample_points returns R,G,B whatever the storage order, so BGRA reads back as RGB.
        rep.frames_read += 1;
        if px[..12] == want { rep.quads_exact += 1; }
        let bar = px[12..].chunks(3).position(|c| c[0] > 200 && c[1] < 50 && c[2] > 200).map_or(-1, |x| x as i32);
        rep.bar_positions.push(bar);
        if let (Some(t), Some((exact, bars))) = (&direct_tex, rep.direct.as_mut()) {
            let px = sample_points(&gpu, t, &uvs).map_err(|e| e.to_string())?;
            if px[..12] == want { *exact += 1; }
            bars.push(px[12..].chunks(3).position(|c| c[0] > 200 && c[1] < 50 && c[2] > 200).map_or(-1, |x| x as i32));
        }
        std::thread::sleep(Duration::from_millis(16));
    }
    Ok(rep)
}
