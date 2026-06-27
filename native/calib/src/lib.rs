//! Native projector calibration for ArtLux (napi-rs + OpenCV). Loaded in the main process as
//! native/calib/calib.node; the sandboxed renderer drives the solves over IPC (see
//! src/main/calibManager.ts). Implements the hybrid pipeline:
//!
//!   * `detect_board`            — findChessboardCornersSB + cornerSubPix on a camera frame.
//!   * `map_corners_to_projector`— decode a captured Gray-code sequence → for each board corner, the
//!                                 sub-pixel projector pixel (local homography around the corner).
//!   * `calibrate_projector`     — calibrateCamera over all poses → projector intrinsics + distortion.
//!   * `solve_pnp`               — pose in the venue frame (intrinsics fixed).
//!
//! BUILD: requires an OpenCV install (main modules only — core/imgproc/calib3d; the Gray-code decode
//! below is hand-rolled, so no contrib module is needed) + LLVM/libclang. Build via
//! `npm run build:calib` and commit the prebuilt .node (NDI precedent). The OpenCV-Rust API surface
//! shifts across crate versions — verify the calls below against the pinned `opencv` version.

use napi::bindgen_prelude::Buffer;
use napi_derive::napi;
use opencv::core::{
    Mat, Point2f, Point3f, Size, TermCriteria, TermCriteria_Type, Vector,
};
use opencv::prelude::*;
use opencv::{calib3d, imgproc};

#[napi(object)]
pub struct BoardDetectResult {
    pub found: bool,
    pub corners: Vec<f64>, // flat camera-space [x0,y0, x1,y1, …]
}

#[napi(object)]
pub struct CornerProjMap {
    pub proj_corners: Vec<f64>, // flat projector-space [u,v, …], aligned with input corners
    pub valid: Vec<u32>,        // 1/0 per corner
}

#[napi(object)]
pub struct ProjectorIntrinsicsResult {
    pub k: Vec<f64>,    // 9, row-major 3×3
    pub dist: Vec<f64>, // 5: k1,k2,p1,p2,k3
    pub rms: f64,
}

#[napi(object)]
pub struct PnpResult {
    pub rotation: Vec<f64>,    // 9, row-major 3×3
    pub translation: Vec<f64>, // 3
    pub rms: f64,
}

// ---- helpers ---------------------------------------------------------------

// Build an owned single-channel 8-bit Mat (h×w) from an RGBA (4ch) or grayscale (1ch) byte buffer.
// RGBA is reduced to luminance by hand so we don't depend on cvt_color's signature (it gained a
// required AlgorithmHint arg in OpenCV 4.10). from_slice→reshape→try_clone is stable across versions.
fn gray_mat(buf: &[u8], w: i32, h: i32) -> opencv::Result<Mat> {
    let px = (w * h) as usize;
    let gray: Vec<u8> = if buf.len() == px {
        buf.to_vec()
    } else {
        let mut g = Vec::with_capacity(px);
        for i in 0..px {
            let r = buf[i * 4] as u32;
            let gg = buf[i * 4 + 1] as u32;
            let b = buf[i * 4 + 2] as u32;
            g.push(((r * 77 + gg * 150 + b * 29) >> 8) as u8); // BT.601-ish luma
        }
        g
    };
    Ok(Mat::from_slice::<u8>(&gray)?.reshape(1, h)?.try_clone()?)
}

// Owned row-major 3×3 from 9 f64.
fn k_mat(k: &[f64]) -> opencv::Result<Mat> {
    Ok(Mat::from_slice::<f64>(k)?.reshape(1, 3)?.try_clone()?)
}

// ---- 1. checkerboard detection --------------------------------------------

#[napi]
pub fn detect_board(image: Buffer, w: u32, h: u32, cols: u32, rows: u32) -> napi::Result<BoardDetectResult> {
    let res = (|| -> opencv::Result<BoardDetectResult> {
        let gray = gray_mat(&image, w as i32, h as i32)?;
        let pattern = Size::new(cols as i32, rows as i32);
        let mut corners: Vector<Point2f> = Vector::new();
        let found = calib3d::find_chessboard_corners_sb(
            &gray, pattern, &mut corners, calib3d::CALIB_CB_NORMALIZE_IMAGE | calib3d::CALIB_CB_EXHAUSTIVE,
        )?;
        if !found {
            return Ok(BoardDetectResult { found: false, corners: vec![] });
        }
        // Sub-pixel refine (SB already refines, but tighten on the raw frame).
        let crit = TermCriteria::new(
            TermCriteria_Type::COUNT as i32 + TermCriteria_Type::EPS as i32, 40, 0.001,
        )?;
        imgproc::corner_sub_pix(&gray, &mut corners, Size::new(5, 5), Size::new(-1, -1), crit).ok();
        let mut flat = Vec::with_capacity(corners.len() * 2);
        for p in corners.iter() {
            flat.push(p.x as f64);
            flat.push(p.y as f64);
        }
        Ok(BoardDetectResult { found: true, corners: flat })
    })();
    res.map_err(|e| napi::Error::from_reason(format!("detect_board: {e}")))
}

// ---- 2. Gray-code decode → projector pixel per corner ----------------------

// Convention: `captures` holds `capture_count` grayscale planes (cam_w*cam_h each), laid out as
// pairs (pattern, inverse) — first the column-coding bits (MSB→LSB), then the row-coding bits. A
// camera pixel's bit is 1 where pattern > inverse. Gray code is converted to binary to get the
// projector column/row. `white`/`black` give the per-pixel contrast mask.
#[napi]
pub fn map_corners_to_projector(
    captures: Buffer, capture_count: u32, cam_w: u32, cam_h: u32,
    proj_w: u32, proj_h: u32, corners: Vec<f64>, white: Buffer, black: Buffer,
) -> napi::Result<CornerProjMap> {
    let res = (|| -> opencv::Result<CornerProjMap> {
        let (cw, ch) = (cam_w as usize, cam_h as usize);
        let px = cw * ch;
        let n_col_bits = bits_for(proj_w);
        let n_row_bits = bits_for(proj_h);
        let expected = 2 * (n_col_bits + n_row_bits);
        if capture_count as usize != expected {
            return Err(opencv::Error::new(0, format!("capture_count {capture_count} != expected {expected}")));
        }
        let plane = |i: usize| &captures[i * px..(i + 1) * px];

        // Contrast mask: skip pixels the projector doesn't reach.
        const CONTRAST: i32 = 12;
        let mut valid_px = vec![false; px];
        for i in 0..px {
            if (white[i] as i32 - black[i] as i32) >= CONTRAST {
                valid_px[i] = true;
            }
        }

        // Decode Gray code per camera pixel → projector (col,row).
        let mut proj_x = vec![-1i32; px];
        let mut proj_y = vec![-1i32; px];
        for i in 0..px {
            if !valid_px[i] { continue; }
            let mut gray_col = 0u32;
            for b in 0..n_col_bits {
                let pat = plane(2 * b)[i] as i32;
                let inv = plane(2 * b + 1)[i] as i32;
                gray_col = (gray_col << 1) | ((pat > inv) as u32);
            }
            let off = 2 * n_col_bits;
            let mut gray_row = 0u32;
            for b in 0..n_row_bits {
                let pat = plane(off + 2 * b)[i] as i32;
                let inv = plane(off + 2 * b + 1)[i] as i32;
                gray_row = (gray_row << 1) | ((pat > inv) as u32);
            }
            let col = gray_to_bin(gray_col);
            let row = gray_to_bin(gray_row);
            if col < proj_w && row < proj_h {
                proj_x[i] = col as i32;
                proj_y[i] = row as i32;
            }
        }

        // For each board corner, fit a local homography (camera → projector) over decoded pixels in a
        // window and evaluate it at the sub-pixel corner.
        const WIN: i32 = 18;       // half-window in camera px
        const MIN_PTS: usize = 12; // need enough decoded points to fit + be robust
        let n_corners = corners.len() / 2;
        let mut proj_corners = vec![0.0f64; n_corners * 2];
        let mut valid = vec![0u32; n_corners];
        for c in 0..n_corners {
            let cx = corners[c * 2] as f32;
            let cy = corners[c * 2 + 1] as f32;
            let mut src: Vector<Point2f> = Vector::new();
            let mut dst: Vector<Point2f> = Vector::new();
            let x0 = (cx as i32 - WIN).max(0);
            let x1 = (cx as i32 + WIN).min(cw as i32 - 1);
            let y0 = (cy as i32 - WIN).max(0);
            let y1 = (cy as i32 + WIN).min(ch as i32 - 1);
            for yy in y0..=y1 {
                for xx in x0..=x1 {
                    let idx = (yy as usize) * cw + xx as usize;
                    if proj_x[idx] >= 0 {
                        src.push(Point2f::new(xx as f32, yy as f32));
                        dst.push(Point2f::new(proj_x[idx] as f32, proj_y[idx] as f32));
                    }
                }
            }
            if src.len() < MIN_PTS {
                continue;
            }
            let mut inliers = Mat::default();
            let hom = calib3d::find_homography(
                &src, &dst, &mut inliers, calib3d::RANSAC, 2.0,
            )?;
            if hom.empty() {
                continue;
            }
            // Apply the 3×3 homography to the sub-pixel corner.
            let h = hom; // CV_64F 3×3
            let hx = |r: i32, col: i32| -> f64 { *h.at_2d::<f64>(r, col).unwrap_or(&0.0) };
            let u = hx(0, 0) * cx as f64 + hx(0, 1) * cy as f64 + hx(0, 2);
            let v = hx(1, 0) * cx as f64 + hx(1, 1) * cy as f64 + hx(1, 2);
            let wgt = hx(2, 0) * cx as f64 + hx(2, 1) * cy as f64 + hx(2, 2);
            if wgt.abs() < 1e-9 { continue; }
            proj_corners[c * 2] = u / wgt;
            proj_corners[c * 2 + 1] = v / wgt;
            valid[c] = 1;
        }
        Ok(CornerProjMap { proj_corners, valid })
    })();
    res.map_err(|e| napi::Error::from_reason(format!("map_corners_to_projector: {e}")))
}

fn bits_for(n: u32) -> usize {
    let mut b = 0;
    let mut v = 1u32;
    while v < n {
        v <<= 1;
        b += 1;
    }
    b.max(1)
}

fn gray_to_bin(mut g: u32) -> u32 {
    let mut b = 0u32;
    while g != 0 {
        b ^= g;
        g >>= 1;
    }
    b
}

// ---- 3. projector intrinsics (calibrateCamera over all poses) --------------

#[napi]
pub fn calibrate_projector(
    object_points: Vec<f64>, image_points: Vec<f64>, point_counts: Vec<u32>,
    proj_w: u32, proj_h: u32,
) -> napi::Result<ProjectorIntrinsicsResult> {
    let res = (|| -> opencv::Result<ProjectorIntrinsicsResult> {
        let mut obj_all: Vector<Vector<Point3f>> = Vector::new();
        let mut img_all: Vector<Vector<Point2f>> = Vector::new();
        let mut o = 0usize; // index into object_points (XYZ triples)
        let mut p = 0usize; // index into image_points (UV pairs)
        for &cnt in point_counts.iter() {
            let cnt = cnt as usize;
            let mut obj: Vector<Point3f> = Vector::new();
            let mut img: Vector<Point2f> = Vector::new();
            for _ in 0..cnt {
                obj.push(Point3f::new(object_points[o] as f32, object_points[o + 1] as f32, object_points[o + 2] as f32));
                o += 3;
                img.push(Point2f::new(image_points[p] as f32, image_points[p + 1] as f32));
                p += 2;
            }
            obj_all.push(obj);
            img_all.push(img);
        }
        let size = Size::new(proj_w as i32, proj_h as i32);
        let mut k = Mat::default();
        let mut dist = Mat::default();
        let mut rvecs: Vector<Mat> = Vector::new();
        let mut tvecs: Vector<Mat> = Vector::new();
        let crit = TermCriteria::new(
            TermCriteria_Type::COUNT as i32 + TermCriteria_Type::EPS as i32, 100, 1e-6,
        )?;
        let flags = calib3d::CALIB_RATIONAL_MODEL; // robust radial; tangential on by default
        let rms = calib3d::calibrate_camera(
            &obj_all, &img_all, size, &mut k, &mut dist, &mut rvecs, &mut tvecs, flags, crit,
        )?;
        let k_vec: Vec<f64> = (0..9).map(|i| *k.at_2d::<f64>(i / 3, i % 3).unwrap_or(&0.0)).collect();
        // Take the first 5 distortion coeffs (k1,k2,p1,p2,k3) even if RATIONAL_MODEL produced more.
        let dn = dist.total() as i32;
        let dist_vec: Vec<f64> = (0..5).map(|i| if i < dn { *dist.at::<f64>(i).unwrap_or(&0.0) } else { 0.0 }).collect();
        Ok(ProjectorIntrinsicsResult { k: k_vec, dist: dist_vec, rms })
    })();
    res.map_err(|e| napi::Error::from_reason(format!("calibrate_projector: {e}")))
}

// ---- 4. pose in venue frame (solvePnP, intrinsics fixed) -------------------

#[napi]
pub fn solve_pnp(object_pts: Vec<f64>, image_pts: Vec<f64>, k: Vec<f64>, dist: Vec<f64>) -> napi::Result<PnpResult> {
    let res = (|| -> opencv::Result<PnpResult> {
        let n = object_pts.len() / 3;
        let mut obj: Vector<Point3f> = Vector::new();
        let mut img: Vector<Point2f> = Vector::new();
        for i in 0..n {
            obj.push(Point3f::new(object_pts[i * 3] as f32, object_pts[i * 3 + 1] as f32, object_pts[i * 3 + 2] as f32));
            img.push(Point2f::new(image_pts[i * 2] as f32, image_pts[i * 2 + 1] as f32));
        }
        let km = k_mat(&k)?;
        let dm = Mat::from_slice::<f64>(&dist)?.try_clone()?;
        let mut rvec = Mat::default();
        let mut tvec = Mat::default();
        calib3d::solve_pnp(&obj, &img, &km, &dm, &mut rvec, &mut tvec, false, calib3d::SOLVEPNP_ITERATIVE)?;
        // Rodrigues → rotation matrix.
        let mut rmat = Mat::default();
        calib3d::rodrigues(&rvec, &mut rmat, &mut Mat::default())?;
        let r_vec: Vec<f64> = (0..9).map(|i| *rmat.at_2d::<f64>(i / 3, i % 3).unwrap_or(&0.0)).collect();
        let t_vec: Vec<f64> = (0..3).map(|i| *tvec.at::<f64>(i).unwrap_or(&0.0)).collect();
        // Reprojection RMS.
        let mut proj: Vector<Point2f> = Vector::new();
        calib3d::project_points(&obj, &rvec, &tvec, &km, &dm, &mut proj, &mut Mat::default(), 0.0)?;
        let mut sse = 0.0f64;
        for i in 0..proj.len() {
            let a = proj.get(i).unwrap();
            let b = img.get(i).unwrap();
            let dx = (a.x - b.x) as f64;
            let dy = (a.y - b.y) as f64;
            sse += dx * dx + dy * dy;
        }
        let rms = if proj.len() > 0 { (sse / proj.len() as f64).sqrt() } else { 0.0 };
        Ok(PnpResult { rotation: r_vec, translation: t_vec, rms })
    })();
    res.map_err(|e| napi::Error::from_reason(format!("solve_pnp: {e}")))
}
