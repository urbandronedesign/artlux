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
use opencv::videoio::{self, VideoCapture, VideoWriter};
use opencv::{calib3d, imgproc, objdetect};
use std::cell::RefCell;

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

#[napi(object)]
pub struct CameraFrame {
    pub w: u32,
    pub h: u32,
    pub data: Buffer, // grayscale, w*h bytes
}

#[napi(object)]
pub struct CameraSelfCal {
    pub cam_k: Vec<f64>,  // 9, recovered camera intrinsics
    pub proj_k: Vec<f64>, // 9, recovered projector intrinsics (bonus)
    pub ok: bool,         // estimate passed sanity gates (else keep the nominal profile)
    pub rms: f64,         // Sampson epipolar RMS over inliers (px) — quality indicator
    pub inliers: u32,
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

// ---- 1b. ArUco fiducial detection (one-click recalibration) ----------------
//
// Detect ArUco markers in a camera frame for marker-based camera-pose recovery. Each detected marker
// yields its id + 4 sub-pixel corners; the renderer looks the id up in the venue's registered marker
// map (id → 3D point) and feeds the corners as camera↔model correspondences into the SAME solvePnP
// the manual anchor picks use → no manual re-picking on re-align (VIOSO One-Click-Recalibration).
//
// ArUco lives in the MAIN `objdetect` module since OpenCV 4.7 (the build links opencv_world ≥4.7), so
// no contrib build is required — only re-enabling the objdetect headers in build-calib.ps1. As with the
// rest of this file, the exact opencv-rust signatures track the pinned crate version (verify on build).

#[napi(object)]
pub struct ArucoDetection {
    pub ids: Vec<u32>,       // detected marker ids
    pub corners: Vec<f64>,   // 8 per id: the 4 corners (x,y) in camera px, in detector order
}

#[napi]
pub fn detect_aruco(image: Buffer, w: u32, h: u32, dict: u32) -> napi::Result<ArucoDetection> {
    let res = (|| -> opencv::Result<ArucoDetection> {
        let gray = gray_mat(&image, w as i32, h as i32)?;
        let dict_type = match dict {
            1 => objdetect::PredefinedDictionaryType::DICT_5X5_50,
            2 => objdetect::PredefinedDictionaryType::DICT_6X6_50,
            3 => objdetect::PredefinedDictionaryType::DICT_7X7_50,
            _ => objdetect::PredefinedDictionaryType::DICT_4X4_50,
        };
        let dictionary = objdetect::get_predefined_dictionary(dict_type)?;
        let mut params = objdetect::DetectorParameters::default()?;
        // Sub-pixel corner refinement for solvePnP-grade precision.
        params.set_corner_refinement_method(objdetect::CornerRefineMethod::CORNER_REFINE_SUBPIX as i32);
        let refine = objdetect::RefineParameters::new(10.0, 3.0, true)?;
        let detector = objdetect::ArucoDetector::new(&dictionary, &params, refine)?;

        let mut corners: Vector<Vector<Point2f>> = Vector::new();
        let mut ids: Vector<i32> = Vector::new();
        let mut rejected: Vector<Vector<Point2f>> = Vector::new();
        detector.detect_markers(&gray, &mut corners, &mut ids, &mut rejected)?;

        let mut out_ids = Vec::with_capacity(ids.len());
        let mut out_corners = Vec::with_capacity(ids.len() * 8);
        for i in 0..ids.len() {
            out_ids.push(ids.get(i)? as u32);
            let quad = corners.get(i)?;
            for j in 0..4 {
                let p = quad.get(j)?;
                out_corners.push(p.x as f64);
                out_corners.push(p.y as f64);
            }
        }
        Ok(ArucoDetection { ids: out_ids, corners: out_corners })
    })();
    res.map_err(|e| napi::Error::from_reason(format!("detect_aruco: {e}")))
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
        // Dense per-camera-pixel projector (col,row) decode (shared with decode_dense_map).
        let (proj_x, proj_y) = decode_dense(&captures, capture_count, cam_w, cam_h, proj_w, proj_h, &white, &black)?;

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

// Decode the dense per-camera-pixel projector (col,row) map from a Gray-code capture sequence. Returns
// proj_x/proj_y of length cam_w*cam_h, -1 where the pixel is below the projector-contrast mask or
// decodes out of range. Shared by map_corners_to_projector (board corners) and decode_dense_map
// (markerless dense correspondences).
fn decode_dense(
    captures: &[u8], capture_count: u32, cam_w: u32, cam_h: u32, proj_w: u32, proj_h: u32,
    white: &[u8], black: &[u8],
) -> opencv::Result<(Vec<i32>, Vec<i32>)> {
    let (cw, ch) = (cam_w as usize, cam_h as usize);
    let px = cw * ch;
    let n_col_bits = bits_for(proj_w);
    let n_row_bits = bits_for(proj_h);
    let expected = 2 * (n_col_bits + n_row_bits);
    if capture_count as usize != expected {
        return Err(opencv::Error::new(0, format!("capture_count {capture_count} != expected {expected}")));
    }
    let plane = |i: usize| &captures[i * px..(i + 1) * px];
    const CONTRAST: i32 = 12; // skip pixels the projector doesn't reach
    let mut proj_x = vec![-1i32; px];
    let mut proj_y = vec![-1i32; px];
    for i in 0..px {
        if (white[i] as i32 - black[i] as i32) < CONTRAST { continue; }
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
    Ok((proj_x, proj_y))
}

#[napi(object)]
pub struct DenseMap {
    pub cam_x: Vec<u32>,  // camera pixel x (subsampled)
    pub cam_y: Vec<u32>,  // camera pixel y
    pub proj_x: Vec<f64>, // decoded projector pixel x, aligned with cam_x/cam_y
    pub proj_y: Vec<f64>, // decoded projector pixel y
}

// Markerless ground truth: dense camera-pixel → projector-pixel correspondences from a Gray-code
// capture, subsampled by `stride` and smoothness-filtered. The renderer raycasts each (cam_x,cam_y)
// onto the venue mesh to get a 3D point, pairing it with (proj_x,proj_y) to resection the projector.
// Smoothness filter: keep a sample only if ≥3 of its 8 stride-neighbors decoded AND the sample agrees
// with their mean within a generous jump bound — this rejects isolated speckle and silhouette/occlusion
// discontinuities while preserving smooth gradients (downstream RANSAC handles the rest).
#[napi]
pub fn decode_dense_map(
    captures: Buffer, capture_count: u32, cam_w: u32, cam_h: u32,
    proj_w: u32, proj_h: u32, white: Buffer, black: Buffer, stride: u32,
) -> napi::Result<DenseMap> {
    let res = (|| -> opencv::Result<DenseMap> {
        let (cw, ch) = (cam_w as usize, cam_h as usize);
        let (px, py) = decode_dense(&captures, capture_count, cam_w, cam_h, proj_w, proj_h, &white, &black)?;
        let s = (stride.max(1)) as usize;
        let jump = (proj_w.max(proj_h) / 16).max(16) as i32; // generous discontinuity bound
        let at = |x: usize, y: usize| -> (i32, i32) { let i = y * cw + x; (px[i], py[i]) };
        let (mut cam_x, mut cam_y, mut out_x, mut out_y) = (Vec::new(), Vec::new(), Vec::new(), Vec::new());
        let mut yy = s;
        while yy + s < ch {
            let mut xx = s;
            while xx + s < cw {
                let (cxp, cyp) = at(xx, yy);
                if cxp >= 0 {
                    let (mut sumx, mut sumy, mut tot) = (0i64, 0i64, 0i32);
                    for (dx, dy) in [(-1i32, 0i32), (1, 0), (0, -1), (0, 1), (-1, -1), (1, 1), (-1, 1), (1, -1)] {
                        let nx = (xx as i32 + dx * s as i32) as usize;
                        let ny = (yy as i32 + dy * s as i32) as usize;
                        let (npx, npy) = at(nx, ny);
                        if npx >= 0 { sumx += npx as i64; sumy += npy as i64; tot += 1; }
                    }
                    if tot >= 3 {
                        let mx = (sumx / tot as i64) as i32;
                        let my = (sumy / tot as i64) as i32;
                        if (cxp - mx).abs() <= jump && (cyp - my).abs() <= jump {
                            cam_x.push(xx as u32); cam_y.push(yy as u32);
                            out_x.push(cxp as f64); out_y.push(cyp as f64);
                        }
                    }
                }
                xx += s;
            }
            yy += s;
        }
        Ok(DenseMap { cam_x, cam_y, proj_x: out_x, proj_y: out_y })
    })();
    res.map_err(|e| napi::Error::from_reason(format!("decode_dense_map: {e}")))
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

// RANSAC pose (intrinsics fixed) — robust to outlier correspondences (model-vs-reality mismatch,
// silhouette raycast outliers). `reproj_err` is the inlier threshold in projector px. RMS is over
// inliers only.
#[napi]
pub fn solve_pnp_ransac(
    object_pts: Vec<f64>, image_pts: Vec<f64>, k: Vec<f64>, dist: Vec<f64>, reproj_err: f64,
) -> napi::Result<PnpResult> {
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
        let mut inliers = Mat::default();
        calib3d::solve_pnp_ransac(
            &obj, &img, &km, &dm, &mut rvec, &mut tvec, false,
            200, reproj_err as f32, 0.999, &mut inliers, calib3d::SOLVEPNP_ITERATIVE,
        )?;
        let mut rmat = Mat::default();
        calib3d::rodrigues(&rvec, &mut rmat, &mut Mat::default())?;
        let r_vec: Vec<f64> = (0..9).map(|i| *rmat.at_2d::<f64>(i / 3, i % 3).unwrap_or(&0.0)).collect();
        let t_vec: Vec<f64> = (0..3).map(|i| *tvec.at::<f64>(i).unwrap_or(&0.0)).collect();
        // Reprojection RMS over inliers.
        let mut proj: Vector<Point2f> = Vector::new();
        calib3d::project_points(&obj, &rvec, &tvec, &km, &dm, &mut proj, &mut Mat::default(), 0.0)?;
        let (mut sse, mut cnt) = (0.0f64, 0usize);
        let n_in = inliers.rows().max(0);
        for r in 0..n_in {
            let idx = *inliers.at::<i32>(r).unwrap_or(&0) as usize;
            if idx < proj.len() {
                let a = proj.get(idx).unwrap();
                let b = img.get(idx).unwrap();
                let dx = (a.x - b.x) as f64;
                let dy = (a.y - b.y) as f64;
                sse += dx * dx + dy * dy;
                cnt += 1;
            }
        }
        let rms = if cnt > 0 { (sse / cnt as f64).sqrt() } else { 0.0 };
        Ok(PnpResult { rotation: r_vec, translation: t_vec, rms })
    })();
    res.map_err(|e| napi::Error::from_reason(format!("solve_pnp_ransac: {e}")))
}

// Projector resection with an intrinsic guess + degeneracy guards. For markerless single-view
// resection against the venue, freeing all of K+distortion is ill-conditioned (planar regions);
// seed K (init_k 3×3, or a throw-ratio default fx=fy=proj_w, principal point centred) and optionally
// fix the principal point / aspect so the geometry only has to refine what it can constrain.
#[napi]
pub fn calibrate_projector_guided(
    object_points: Vec<f64>, image_points: Vec<f64>, point_counts: Vec<u32>,
    proj_w: u32, proj_h: u32, init_k: Vec<f64>, fix_principal_point: bool, fix_aspect: bool,
) -> napi::Result<ProjectorIntrinsicsResult> {
    let res = (|| -> opencv::Result<ProjectorIntrinsicsResult> {
        let mut obj_all: Vector<Vector<Point3f>> = Vector::new();
        let mut img_all: Vector<Vector<Point2f>> = Vector::new();
        let (mut o, mut p) = (0usize, 0usize);
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
        let seed = if init_k.len() == 9 {
            init_k
        } else {
            let f = proj_w as f64;
            vec![f, 0.0, proj_w as f64 / 2.0, 0.0, f, proj_h as f64 / 2.0, 0.0, 0.0, 1.0]
        };
        let mut k = k_mat(&seed)?;
        let mut dist = Mat::default();
        let mut rvecs: Vector<Mat> = Vector::new();
        let mut tvecs: Vector<Mat> = Vector::new();
        let crit = TermCriteria::new(
            TermCriteria_Type::COUNT as i32 + TermCriteria_Type::EPS as i32, 100, 1e-6,
        )?;
        let mut flags = calib3d::CALIB_USE_INTRINSIC_GUESS | calib3d::CALIB_RATIONAL_MODEL;
        if fix_principal_point { flags |= calib3d::CALIB_FIX_PRINCIPAL_POINT; }
        if fix_aspect { flags |= calib3d::CALIB_FIX_ASPECT_RATIO; }
        let rms = calib3d::calibrate_camera(
            &obj_all, &img_all, size, &mut k, &mut dist, &mut rvecs, &mut tvecs, flags, crit,
        )?;
        let k_vec: Vec<f64> = (0..9).map(|i| *k.at_2d::<f64>(i / 3, i % 3).unwrap_or(&0.0)).collect();
        let dn = dist.total() as i32;
        let dist_vec: Vec<f64> = (0..5).map(|i| if i < dn { *dist.at::<f64>(i).unwrap_or(&0.0) } else { 0.0 }).collect();
        Ok(ProjectorIntrinsicsResult { k: k_vec, dist: dist_vec, rms })
    })();
    res.map_err(|e| napi::Error::from_reason(format!("calibrate_projector_guided: {e}")))
}

// ---- 4b. board-free camera intrinsics from the scan (focal-from-F / Bougnoux) ----
//
// Treats the camera↔projector dense correspondences as an uncalibrated stereo pair: estimate the
// fundamental matrix F (RANSAC), then the Bougnoux closed-form focal from F + assumed principal points
// (image centres, square pixels). Recovers BOTH the camera and projector focal lengths. Notoriously
// noise/degeneracy-sensitive (planar scenes especially) — gated by inlier count + epipolar RMS +
// focal plausibility; on failure `ok=false` so the caller keeps the nominal profile. The 3D-relief
// venue is what makes this tractable. "3D mapping doesn't have to be perfect" (VIOSO).

fn m3v(m: &[f64; 9], v: &[f64; 3]) -> [f64; 3] {
    [m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[3] * v[0] + m[4] * v[1] + m[5] * v[2], m[6] * v[0] + m[7] * v[1] + m[8] * v[2]]
}
fn dot3(a: &[f64; 3], b: &[f64; 3]) -> f64 { a[0] * b[0] + a[1] * b[1] + a[2] * b[2] }
fn cross3(a: &[f64; 3], b: &[f64; 3]) -> [f64; 3] { [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]] }
fn skew3(e: &[f64; 3]) -> [f64; 9] { [0.0, -e[2], e[1], e[2], 0.0, -e[0], -e[1], e[0], 0.0] }
fn mm3(a: &[f64; 9], b: &[f64; 9]) -> [f64; 9] {
    let mut o = [0.0; 9];
    for r in 0..3 { for c in 0..3 { let mut s = 0.0; for k in 0..3 { s += a[r * 3 + k] * b[k * 3 + c]; } o[r * 3 + c] = s; } }
    o
}
fn tr3(m: &[f64; 9]) -> [f64; 9] { [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]] }

// Bougnoux focal² for the "self" camera: F relates other^T F self = 0; e_other is the epipole in the
// OTHER image (left null of F). Ĩ = diag(1,1,0).
fn bougnoux_focal_sq(fmat: &[f64; 9], p_self: &[f64; 3], p_other: &[f64; 3], e_other: &[f64; 3]) -> f64 {
    let mut i_f = *fmat; i_f[6] = 0.0; i_f[7] = 0.0; i_f[8] = 0.0; // Ĩ F
    let a = mm3(&skew3(e_other), &i_f); // [e_other]× Ĩ F
    let a_ps = m3v(&a, p_self);
    let f_ps = m3v(fmat, p_self);
    let num1 = dot3(p_other, &a_ps);
    let num2 = dot3(&f_ps, p_other);
    let den = dot3(&f_ps, &a_ps);
    if den.abs() < 1e-12 { return f64::NAN; }
    -(num1 * num2) / den
}

#[napi]
pub fn self_calibrate_stereo(
    cam_x: Vec<f64>, cam_y: Vec<f64>, proj_x: Vec<f64>, proj_y: Vec<f64>,
    cam_w: u32, cam_h: u32, proj_w: u32, proj_h: u32,
) -> napi::Result<CameraSelfCal> {
    let fail = || CameraSelfCal { cam_k: vec![], proj_k: vec![], ok: false, rms: 0.0, inliers: 0 };
    let res = (|| -> opencv::Result<CameraSelfCal> {
        let n = cam_x.len().min(cam_y.len()).min(proj_x.len()).min(proj_y.len());
        if n < 50 { return Ok(fail()); }
        let mut p1: Vector<Point2f> = Vector::new();
        let mut p2: Vector<Point2f> = Vector::new();
        for i in 0..n {
            p1.push(Point2f::new(cam_x[i] as f32, cam_y[i] as f32));
            p2.push(Point2f::new(proj_x[i] as f32, proj_y[i] as f32));
        }
        // F such that p2ᵀ F p1 = 0 (camera = image 1, projector = image 2).
        let mut mask = Mat::default();
        let f = calib3d::find_fundamental_mat(&p1, &p2, calib3d::FM_RANSAC, 1.5, 0.99, 2000, &mut mask)?;
        if f.empty() || f.rows() != 3 || f.cols() != 3 { return Ok(fail()); }
        let fa = |r: i32, c: i32| *f.at_2d::<f64>(r, c).unwrap_or(&0.0);
        let fmat = [fa(0, 0), fa(0, 1), fa(0, 2), fa(1, 0), fa(1, 1), fa(1, 2), fa(2, 0), fa(2, 1), fa(2, 2)];

        // Sampson epipolar RMS over inliers (quality).
        let (mut sse, mut inl) = (0.0f64, 0u32);
        for i in 0..n {
            if *mask.at::<u8>(i as i32).unwrap_or(&0) == 0 { continue; }
            let x1 = [cam_x[i], cam_y[i], 1.0];
            let x2 = [proj_x[i], proj_y[i], 1.0];
            let fx1 = m3v(&fmat, &x1);
            let ftx2 = m3v(&tr3(&fmat), &x2);
            let num = dot3(&x2, &fx1);
            let den = fx1[0] * fx1[0] + fx1[1] * fx1[1] + ftx2[0] * ftx2[0] + ftx2[1] * ftx2[1];
            if den > 1e-12 { sse += (num * num) / den; inl += 1; }
        }
        if inl < 100 { return Ok(fail()); }
        let rms = (sse / inl as f64).sqrt();

        // Epipoles: e1 = right null (F e1=0, camera image), e2 = left null (Fᵀ e2=0, projector image).
        let r0 = [fmat[0], fmat[1], fmat[2]];
        let r1 = [fmat[3], fmat[4], fmat[5]];
        let e1 = cross3(&r0, &r1);
        let c0 = [fmat[0], fmat[3], fmat[6]];
        let c1 = [fmat[1], fmat[4], fmat[7]];
        let e2 = cross3(&c0, &c1);

        let pp_cam = [cam_w as f64 / 2.0, cam_h as f64 / 2.0, 1.0];
        let pp_proj = [proj_w as f64 / 2.0, proj_h as f64 / 2.0, 1.0];
        let f1sq = bougnoux_focal_sq(&fmat, &pp_cam, &pp_proj, &e2);   // camera
        let f2sq = bougnoux_focal_sq(&tr3(&fmat), &pp_proj, &pp_cam, &e1); // projector

        let plausible = |fsq: f64, w: f64| fsq.is_finite() && fsq > 0.0 && fsq.sqrt() > 0.3 * w && fsq.sqrt() < 6.0 * w;
        let ok = rms < 3.0 && plausible(f1sq, cam_w as f64) && plausible(f2sq, proj_w as f64);
        if !ok { return Ok(CameraSelfCal { cam_k: vec![], proj_k: vec![], ok: false, rms, inliers: inl }); }
        let f1 = f1sq.sqrt();
        let f2 = f2sq.sqrt();
        Ok(CameraSelfCal {
            cam_k: vec![f1, 0.0, pp_cam[0], 0.0, f1, pp_cam[1], 0.0, 0.0, 1.0],
            proj_k: vec![f2, 0.0, pp_proj[0], 0.0, f2, pp_proj[1], 0.0, 0.0, 1.0],
            ok: true, rms, inliers: inl,
        })
    })();
    res.map_err(|e| napi::Error::from_reason(format!("self_calibrate_stereo: {e}")))
}

// ---- 5. native camera capture (OpenCV videoio, DirectShow) -----------------
//
// Some cameras — notably the PS3 Eye via its user-mode DirectShow source filter — deliver frames to
// OpenCV's videoio (CAP_DSHOW) but NOT to Chromium's getUserMedia (its DirectShow capture is stricter
// and fails to start the filter → NotReadableError). For those, the wizard captures here instead of in
// the renderer. OpenCV's DSHOW backend addresses devices by INDEX only (no device names), so the UI
// exposes an index picker like vvvv's "Device Index". The capture handle lives in a thread-local: all
// synchronous napi calls run on the JS main thread, so it persists across open/grab/close without any
// Send/Sync bound on VideoCapture.
thread_local! {
    static CAP: RefCell<Option<VideoCapture>> = const { RefCell::new(None) };
}

// Open camera `index` via the DirectShow backend, requesting (width, height, fps, fourcc) — e.g.
// "MJPG" at 1280×720/80 for the PS3 Eye (its working vvvv config). Width/height/fps/fourcc are hints;
// the driver picks the closest mode. Returns false if the device couldn't be opened.
#[napi]
pub fn camera_open(index: u32, width: u32, height: u32, fps: f64, fourcc: String) -> napi::Result<bool> {
    let res = (|| -> opencv::Result<bool> {
        let mut cap = VideoCapture::new(index as i32, videoio::CAP_DSHOW)?;
        if !cap.is_opened()? {
            return Ok(false);
        }
        let cc: Vec<char> = fourcc.chars().collect();
        if cc.len() == 4 {
            let f = VideoWriter::fourcc(cc[0], cc[1], cc[2], cc[3])?;
            cap.set(videoio::CAP_PROP_FOURCC, f as f64)?;
        }
        if width > 0 { cap.set(videoio::CAP_PROP_FRAME_WIDTH, width as f64)?; }
        if height > 0 { cap.set(videoio::CAP_PROP_FRAME_HEIGHT, height as f64)?; }
        if fps > 0.0 { cap.set(videoio::CAP_PROP_FPS, fps)?; }
        CAP.with(|c| *c.borrow_mut() = Some(cap));
        Ok(true)
    })();
    res.map_err(|e| napi::Error::from_reason(format!("camera_open: {e}")))
}

// Set a capture property on the open camera (manual exposure / gain / gamma for decode SNR — VIOSO
// tunes these explicitly). `prop` is a short name mapped to a CAP_PROP_* id; `value` is the raw driver
// value. Returns false if no camera is open or the driver rejects the set. NOTE (DirectShow quirk):
// manual exposure only takes effect once auto-exposure is disabled — set "autoexposure" to 0.25 first
// (the DSHOW "manual" sentinel on most UVC drivers), then "exposure" to the log2-seconds value. Units
// are driver-specific, so the UI exposes the raw value + an auto toggle.
#[napi]
pub fn camera_set_prop(prop: String, value: f64) -> napi::Result<bool> {
    let prop_id = match prop.as_str() {
        "exposure" => videoio::CAP_PROP_EXPOSURE,
        "autoexposure" => videoio::CAP_PROP_AUTO_EXPOSURE,
        "gain" => videoio::CAP_PROP_GAIN,
        "gamma" => videoio::CAP_PROP_GAMMA,
        "brightness" => videoio::CAP_PROP_BRIGHTNESS,
        "contrast" => videoio::CAP_PROP_CONTRAST,
        _ => return Ok(false),
    };
    let res = CAP.with(|c| -> opencv::Result<bool> {
        let mut guard = c.borrow_mut();
        match guard.as_mut() {
            Some(cap) => cap.set(prop_id, value),
            None => Ok(false),
        }
    });
    res.map_err(|e| napi::Error::from_reason(format!("camera_set_prop: {e}")))
}

// Grab one frame as a single-channel grayscale buffer at the negotiated resolution. Returns null until
// a frame is available (or if no camera is open). OpenCV decodes to BGR; we reduce to BT.601-ish luma
// by hand (same as gray_mat) so the result drops straight into detect_board / map_corners_to_projector.
#[napi]
pub fn camera_grab_gray() -> napi::Result<Option<CameraFrame>> {
    let res = CAP.with(|c| -> opencv::Result<Option<CameraFrame>> {
        let mut guard = c.borrow_mut();
        let cap = match guard.as_mut() {
            Some(c) => c,
            None => return Ok(None),
        };
        let mut frame = Mat::default();
        if !cap.read(&mut frame)? || frame.empty() {
            return Ok(None);
        }
        let w = frame.cols();
        let h = frame.rows();
        let ch = frame.channels();
        let frame = if frame.is_continuous() { frame } else { frame.try_clone()? };
        let bytes = frame.data_bytes()?;
        let px = (w * h) as usize;
        let mut gray = Vec::with_capacity(px);
        match ch {
            1 => gray.extend_from_slice(&bytes[..px.min(bytes.len())]),
            3 | 4 => {
                let stride = ch as usize;
                for i in 0..px {
                    let b = bytes[i * stride] as u32;
                    let g = bytes[i * stride + 1] as u32;
                    let r = bytes[i * stride + 2] as u32;
                    gray.push(((r * 77 + g * 150 + b * 29) >> 8) as u8); // BGR → luma
                }
            }
            _ => return Ok(None),
        }
        Ok(Some(CameraFrame { w: w as u32, h: h as u32, data: gray.into() }))
    });
    res.map_err(|e| napi::Error::from_reason(format!("camera_grab_gray: {e}")))
}

// Release the open camera (drops the VideoCapture → frees the device).
#[napi]
pub fn camera_close() {
    CAP.with(|c| *c.borrow_mut() = None);
}
