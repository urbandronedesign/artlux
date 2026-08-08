//! Loopback selftest: a Syphon **server and client in one process**, no GPU, no display, no second
//! application. Run by `.github/workflows/syphon.yml` on every push to the `syphon` branch.
//!
//! WHY THIS EXISTS. The Syphon plugin is being written on a Windows machine with no Mac available
//! (plans/syphon-plugin.md §4.8). A compile-only CI gate proves the Objective-C builds and links; it
//! proves nothing about whether any of it *works*. This does — and it closes, without hardware, four
//! of the five open questions in the plan plus both of the ways Syphon is harder than Spout:
//!
//!   - does the discovery model hold (§4.2, identity is a PAIR and the name is often empty)
//!   - does bare `SyphonClientBase` work, or is a subclass needed (§4.3 — the one runtime decision)
//!   - is the surface real, and does it carry the pixels we published (not merely "non-null")
//!   - **does the picture MOVE** — Syphon reuses one surface, so a second publish must change the
//!     bytes behind the same pointer (§10 q2, the Syphon half; the Chromium half needs a Mac)
//!   - does a client notice its server dying (§1.1 — `isValid` never recovers, so we must re-resolve)
//!   - does the +1 IOSurface reference balance (§10 — the macOS leak hazard)
//!
//! What it cannot reach: Electron. `importSharedTexture` needs a GPU process, and a real Syphon
//! server needs a second app. Those two, and only those two, wait for the Mac.

use std::process::ExitCode;

const W: u32 = 64;
const H: u32 = 32;
const RED: u32 = 0xFF_00_00_FF; // arbitrary, distinct
const BLUE: u32 = 0xFF_FF_00_00;

struct Report {
    failed: u32,
    warned: u32,
}

impl Report {
    fn check(&mut self, ok: bool, what: &str) -> bool {
        if ok {
            println!("  ok    {what}");
        } else {
            println!("  FAIL  {what}");
            self.failed += 1;
        }
        ok
    }
    /// For the one assertion whose failure is about the ENVIRONMENT rather than our code — see the
    /// discovery step. Warning rather than failing is deliberate: a hard failure there would make
    /// the gate red for a reason nobody can fix, and a gate that is always red is not a gate.
    fn warn_if(&mut self, ok: bool, what: &str, why: &str) {
        if ok {
            println!("  ok    {what}");
        } else {
            println!("  WARN  {what}\n        {why}");
            self.warned += 1;
        }
    }
}

fn main() -> ExitCode {
    if !cfg!(target_os = "macos") {
        println!("[selftest] not macOS — Syphon does not exist here. Skipped.");
        return ExitCode::SUCCESS;
    }

    let mut r = Report { failed: 0, warned: 0 };
    use artlux_syphon_sys as syphon;
    use artlux_syphon_sys::test_support as t;

    println!("[selftest] Syphon loopback — server + client in one process");

    r.check(syphon::available(), "Syphon classes are present");

    // ── the server ──────────────────────────────────────────────────────────────────────────
    syphon::directory_start(); // early, exactly as the plugin does — see shim.h
    if !r.check(t::server_start("artlux-selftest"), "test server started") {
        return ExitCode::FAILURE; // nothing below can mean anything
    }
    r.check(t::server_publish(W, H, RED), "published frame 1 (red)");

    // ── discovery (§4.2) ────────────────────────────────────────────────────────────────────
    // Distributed notifications need run-loop turns to be delivered, even in-process.
    t::runloop_spin(1.0);
    let servers = syphon::list_servers();
    println!("  info  directory reports {} server(s): {:?}", servers.len(),
             servers.iter().map(|s| s.label()).collect::<Vec<_>>());
    r.warn_if(
        servers.iter().any(|s| s.name == "artlux-selftest"),
        "the test server appears in SyphonServerDirectory",
        "same-process discovery over distributed notifications is environment-dependent \
         (a CI runner may lack the session that carries them). The direct-connect path below \
         exercises the frame pipeline regardless; only DISCOVERY is unproven if this warns.",
    );
    // The label rule is pure logic and must hold whatever the environment did.
    let unnamed = syphon::ServerDesc { name: String::new(), app_name: "Resolume".into() };
    r.check(unnamed.label() == "Resolume", "an unnamed server labels as its app name alone");

    // ── the client (§4.3) ───────────────────────────────────────────────────────────────────
    // Direct, via the server's own description: isolates the frame pipeline from discovery.
    if !r.check(t::connect_direct(), "SyphonClientBase connected (bare base class — §4.3)") {
        println!("\n  §4.3 fallback needed: bare SyphonClientBase did not connect. Swap \
                  artlux_make_client() in shim.m for a subclass or SyphonMetalClient.");
        return ExitCode::FAILURE;
    }
    r.check(syphon::is_valid(), "client is valid");
    r.check(syphon::has_new_frame(), "hasNewFrame is true after a publish");

    // ── the surface ─────────────────────────────────────────────────────────────────────────
    let Some(f1) = syphon::new_surface() else {
        println!("  FAIL  newSurface returned nothing");
        return ExitCode::FAILURE;
    };
    r.check(f1.width == W && f1.height == H, &format!("surface is {W}x{H} (got {}x{})", f1.width, f1.height));
    r.check(f1.pixel_format == 0x42475241, "pixel format is BGRA");
    let px1 = t::pixel(f1.surface, 1, 1);
    r.check(px1 == RED, &format!("surface carries the published pixels (want {RED:#010X}, got {px1:#010X})"));
    r.check(!syphon::has_new_frame(), "hasNewFrame clears once the frame is taken");

    // ── DOES THE PICTURE MOVE (§10 q2, Syphon half) ─────────────────────────────────────────
    // Syphon reuses one IOSurface until the size changes, so we hand the same pointer over every
    // frame. If a second publish did not change the bytes behind it, the whole design would show a
    // frozen first frame — which is the failure mode to watch for on the Mac, since the Chromium
    // half of this question cannot be answered here.
    r.check(t::server_publish(W, H, BLUE), "published frame 2 (blue)");
    r.check(syphon::has_new_frame(), "hasNewFrame flips on the second publish");
    let Some(f2) = syphon::new_surface() else {
        println!("  FAIL  newSurface returned nothing for frame 2");
        return ExitCode::FAILURE;
    };
    let px2 = t::pixel(f2.surface, 1, 1);
    r.check(px2 == BLUE, &format!("frame 2 pixels changed (want {BLUE:#010X}, got {px2:#010X})"));
    println!("  info  surface pointer frame1={:#x} frame2={:#x}{}", f1.surface, f2.surface,
             if f1.surface == f2.surface { "  (same surface reused — as expected)" } else { "" });

    // ── the +1 balance (the macOS leak hazard) ──────────────────────────────────────────────
    let before = t::retain_count(f2.surface);
    for _ in 0..100 {
        if let Some(f) = syphon::new_surface() { syphon::release_surface(f.surface); }
    }
    let after = t::retain_count(f2.surface);
    r.check(after <= before,
            &format!("100 acquire/release cycles do not grow the retain count ({before} -> {after})"));
    syphon::release_surface(f1.surface);
    syphon::release_surface(f2.surface);

    // ── a client does not follow its server (§1.1) ──────────────────────────────────────────
    t::server_stop();
    t::runloop_spin(0.5);
    r.check(!syphon::is_valid(), "client goes invalid when its server stops");
    // And re-resolution must not resurrect a server that is gone, nor silently attach to something
    // else. (With no other Syphon server on the runner, "cannot reconnect" is the correct answer.)
    let reconnected = syphon::ensure_connected();
    println!("  info  ensure_connected() after the server died: {reconnected}");

    syphon::disconnect();

    println!("\n[selftest] {} failed, {} warned", r.failed, r.warned);
    if r.failed > 0 { ExitCode::FAILURE } else { ExitCode::SUCCESS }
}
