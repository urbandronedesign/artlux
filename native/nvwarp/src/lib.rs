//! Native NVIDIA scanout warp + intensity for ArtLux (napi-rs → C++ NVAPI shim). Loaded in the main
//! process as native/nvwarp/nvwarp.node; the renderer drives it over IPC (see src/main/nvwarpManager.ts).
//! On non-NVIDIA / non-Quadro hosts (or a stub build), `available()` returns false and ArtLux uses its
//! GLSL warp/blend instead. NVAPI scanout warp is a 2D framebuffer resample — geometry for 3D mapping
//! comes from the calibrated 3D render; NVAPI's role is edge blend + lens distortion + persistence.

use napi_derive::napi;

extern "C" {
    fn nvw_init() -> i32;
    #[allow(dead_code)]
    fn nvw_unload();
    fn nvw_list_displays(ids: *mut u32, rects: *mut i32, max: i32) -> i32;
    fn nvw_set_warping(display_id: u32, verts: *const f32, num_verts: i32, sl: i32, st: i32, sw: i32, sh: i32) -> i32;
    fn nvw_set_intensity(display_id: u32, w: i32, h: i32, rgb: *const f32) -> i32;
    fn nvw_clear(display_id: u32) -> i32;
}

#[napi(object)]
pub struct NvDisplay {
    pub display_id: f64,    // NVAPI displayId (host maps to Electron display by bounds)
    pub x: i32,             // scanout source-desktop rect (virtual-desktop pixels)
    pub y: i32,
    pub w: i32,
    pub h: i32,
}

/// Is NVAPI present + a warp-capable GPU available? False on stub builds / non-pro GPUs.
#[napi]
pub fn available() -> bool {
    unsafe { nvw_init() == 1 }
}

/// Enumerate NVAPI displays (id + source-desktop rect) for mapping to Electron displays.
#[napi]
pub fn list_displays() -> Vec<NvDisplay> {
    unsafe {
        if nvw_init() != 1 {
            return vec![];
        }
        const MAX: usize = 16;
        let mut ids = vec![0u32; MAX];
        let mut rects = vec![0i32; MAX * 4];
        let n = nvw_list_displays(ids.as_mut_ptr(), rects.as_mut_ptr(), MAX as i32).max(0) as usize;
        (0..n)
            .map(|i| NvDisplay {
                display_id: ids[i] as f64,
                x: rects[i * 4],
                y: rects[i * 4 + 1],
                w: rects[i * 4 + 2],
                h: rects[i * 4 + 3],
            })
            .collect()
    }
}

/// Push a warp mesh to a display. `verts` = numVerts*6 (X,Y,U,V,R,Q); `src` = [x,y,w,h] source rect.
#[napi]
pub fn set_warping(display_id: f64, verts: Vec<f64>, src: Vec<i32>) -> bool {
    let v32: Vec<f32> = verts.iter().map(|&x| x as f32).collect();
    let num = (v32.len() / 6) as i32;
    let s = if src.len() >= 4 { [src[0], src[1], src[2], src[3]] } else { [0, 0, 0, 0] };
    unsafe { nvw_set_warping(display_id as u32, v32.as_ptr(), num, s[0], s[1], s[2], s[3]) == 1 }
}

/// Push an intensity/blend map (w*h*3 floats 0..1, RGB) to a display.
#[napi]
pub fn set_intensity(display_id: f64, w: i32, h: i32, rgb: Vec<f64>) -> bool {
    let r32: Vec<f32> = rgb.iter().map(|&x| x as f32).collect();
    unsafe { nvw_set_intensity(display_id as u32, w, h, r32.as_ptr()) == 1 }
}

/// Remove warp + intensity from a display.
#[napi]
pub fn clear(display_id: f64) -> bool {
    unsafe { nvw_clear(display_id as u32) == 1 }
}
