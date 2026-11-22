//! E0c — THE ENGINE'S PICTURE IN AN ELECTRON PAGE, WINDOWS PATH (plan §5 "embedded", §6 "Views in UI").
//!
//! The engine renders into D3D12 textures it creates SHAREABLE (an NT handle), and hands Electron main
//! a handle it can import with `sharedTexture.importSharedTexture` (Electron 42). An NT handle is
//! PROCESS-LOCAL, and Node cannot call DuplicateHandle, so the ENGINE duplicates each handle INTO main's
//! process (main passes its pid) and reports the value there.
//!
//! The protocol is newline-delimited JSON:
//!   engine → stdout  {"type":"slots","w":W,"h":H,"format":"bgra","handles":["0x…", …]}
//!   engine → stdout  {"type":"frame","n":N,"slot":I}        slot I holds frame N, GPU work complete
//!   main   → stdin   {"free":I}                             the page has drawn slot I; reuse it
//! A RING of slots, and a slot is rendered into again only once it is free: the engine never writes a
//! texture the page may still be reading. No keyed mutex (Electron's `bgra` import has none), so the
//! ordering IS the synchronisation: the engine waits for its GPU work before announcing a frame.
//!
//! The textures are created ALLOW_SIMULTANEOUS_ACCESS: such a texture decays to the COMMON state when
//! the engine's command list completes, which is the state another device (Chromium's D3D11) may open it in.

use crate::card::Card;
use crate::{describe, AdapterPolicy, Gpu};
use std::io::{BufRead, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use windows::core::PCWSTR;
use windows::Win32::Foundation::{CloseHandle, DuplicateHandle, DUPLICATE_SAME_ACCESS, GENERIC_ALL, HANDLE};
use windows::Win32::Graphics::Direct3D12::*;
use windows::Win32::Graphics::Dxgi::Common::{DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_SAMPLE_DESC};
use windows::Win32::System::Threading::{GetCurrentProcess, OpenProcess, PROCESS_DUP_HANDLE};

pub const SLOTS: usize = 3;

pub struct Slot {
    pub texture: wgpu::Texture,
    pub view: wgpu::TextureView,
    /// The handle in OUR process (closed when the slot goes).
    local: HANDLE,
}
impl Drop for Slot {
    fn drop(&mut self) {
        unsafe { let _ = CloseHandle(self.local); }
    }
}

/// A BGRA8 texture of `w`×`h` that another process can open, wrapped as a wgpu texture.
pub fn create_slot(gpu: &Gpu, w: u32, h: u32) -> Result<Slot, String> {
    let hal = unsafe { gpu.device.as_hal::<wgpu::hal::api::Dx12>() }.ok_or("the engine device is not D3D12")?;
    let d3d: &ID3D12Device = hal.raw_device();
    let desc = D3D12_RESOURCE_DESC {
        Dimension: D3D12_RESOURCE_DIMENSION_TEXTURE2D,
        Alignment: 0,
        Width: w as u64,
        Height: h,
        DepthOrArraySize: 1,
        MipLevels: 1,
        Format: DXGI_FORMAT_B8G8R8A8_UNORM,
        SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
        Layout: D3D12_TEXTURE_LAYOUT_UNKNOWN,
        Flags: D3D12_RESOURCE_FLAG_ALLOW_RENDER_TARGET | D3D12_RESOURCE_FLAG_ALLOW_SIMULTANEOUS_ACCESS,
    };
    let heap = D3D12_HEAP_PROPERTIES { Type: D3D12_HEAP_TYPE_DEFAULT, ..Default::default() };
    let mut res: Option<ID3D12Resource> = None;
    unsafe {
        d3d.CreateCommittedResource(&heap, D3D12_HEAP_FLAG_SHARED, &desc, D3D12_RESOURCE_STATE_COMMON, None, &mut res)
            .map_err(|e| format!("CreateCommittedResource (shared): {e}"))?;
    }
    let res = res.ok_or("CreateCommittedResource returned nothing")?;
    let local = unsafe { d3d.CreateSharedHandle(&res, None, GENERIC_ALL.0, PCWSTR::null()) }
        .map_err(|e| format!("CreateSharedHandle: {e}"))?;
    let size = wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 };
    let hal_tex = unsafe {
        wgpu::hal::dx12::Device::texture_from_raw(res, wgpu::TextureFormat::Bgra8Unorm, wgpu::TextureDimension::D2, size, 1, 1)
    };
    drop(hal);
    let texture = unsafe {
        gpu.device.create_texture_from_hal::<wgpu::hal::api::Dx12>(
            hal_tex,
            &wgpu::TextureDescriptor {
                label: Some("shared slot"),
                size,
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format: wgpu::TextureFormat::Bgra8Unorm,
                usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
                view_formats: &[],
            },
            wgpu::wgt::TextureUses::UNINITIALIZED,   // created in D3D12 COMMON
        )
    };
    let view = texture.create_view(&Default::default());
    Ok(Slot { texture, view, local })
}

/// Duplicate `local` into process `pid`; the value is only meaningful THERE.
pub fn duplicate_into(local: HANDLE, pid: u32) -> Result<u64, String> {
    unsafe {
        let target = OpenProcess(PROCESS_DUP_HANDLE, false, pid).map_err(|e| format!("OpenProcess({pid}): {e}"))?;
        let mut out = HANDLE::default();
        let r = DuplicateHandle(GetCurrentProcess(), local, target, &mut out, 0, false, DUPLICATE_SAME_ACCESS);
        let _ = CloseHandle(target);
        r.map_err(|e| format!("DuplicateHandle: {e}"))?;
        Ok(out.0 as u64)
    }
}

/// `artlux-engine --share <pid> [--seconds N]`: the protocol above, frames of the test card.
pub fn run(pid: u32, w: u32, h: u32, run_for: Option<Duration>, policy: AdapterPolicy) -> Result<(), String> {
    let gpu = Gpu::open(policy).map_err(|e| e.to_string())?;
    eprintln!("engine device: {}", describe(&gpu.info));
    let slots: Vec<Slot> = (0..SLOTS).map(|_| create_slot(&gpu, w, h)).collect::<Result<_, _>>()?;
    let handles: Vec<String> = slots.iter().map(|s| duplicate_into(s.local, pid).map(|v| format!("0x{v:x}"))).collect::<Result<_, _>>()?;
    let card = Card::new(&gpu.device, wgpu::TextureFormat::Bgra8Unorm);
    let mut out = std::io::stdout().lock();
    writeln!(out, r#"{{"type":"slots","w":{w},"h":{h},"format":"bgra","handles":[{}]}}"#,
        handles.iter().map(|h| format!("\"{h}\"")).collect::<Vec<_>>().join(",")).map_err(|e| e.to_string())?;
    out.flush().ok();

    // Which slots main has handed back. All free at the start.
    let free = Arc::new(Mutex::new([true; SLOTS]));
    let eof = Arc::new(AtomicBool::new(false));
    {
        let (free, eof) = (free.clone(), eof.clone());
        std::thread::spawn(move || {
            for line in std::io::stdin().lock().lines() {
                let Ok(line) = line else { break };
                // {"free":I} — parsed by hand; the engine takes no JSON dependency for one field.
                if let Some(i) = line.split("\"free\":").nth(1).and_then(|r| r.trim_matches(|c: char| !c.is_ascii_digit()).parse::<usize>().ok()) {
                    if i < SLOTS { free.lock().unwrap()[i] = true; }
                }
            }
            eof.store(true, Ordering::SeqCst);   // main went away: stop
        });
    }
    let deadline = run_for.map(|d| Instant::now() + d);
    let (mut n, mut next): (u64, usize) = (0, 0);
    let tick = Duration::from_micros(16_667);   // a spike's pace; a view will follow its display
    while !eof.load(Ordering::SeqCst) && deadline.map_or(true, |d| Instant::now() < d) {
        let t0 = Instant::now();
        let slot = {
            let mut f = free.lock().unwrap();
            (0..SLOTS).map(|k| (next + k) % SLOTS).find(|&i| f[i]).map(|i| { f[i] = false; i })
        };
        let Some(i) = slot else { std::thread::sleep(Duration::from_millis(1)); continue };
        gpu.queue.submit([card.encode(&gpu, &slots[i].view, w, h, n)]);
        // The page may read the texture as soon as it hears of it: the GPU work must be COMPLETE.
        gpu.device.poll(wgpu::PollType::Wait { submission_index: None, timeout: None }).map_err(|e| e.to_string())?;
        if writeln!(out, r#"{{"type":"frame","n":{n},"slot":{i}}}"#).and_then(|_| out.flush()).is_err() { break; }
        n += 1;
        next = (i + 1) % SLOTS;
        if let Some(rest) = tick.checked_sub(t0.elapsed()) { std::thread::sleep(rest); }
    }
    eprintln!("engine: {n} frames shared");
    Ok(())
}
