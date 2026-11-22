// `cargo test` runs the same headless self-test as `artlux-engine --selftest --allow-software`.
// The goldens are the CPU references (checked first, so a golden can never drift from them), and the
// GPU must match them byte for byte on whatever adapter the runner has (§6b: WARP, lavapipe, Metal).
use artlux_engine::*;

#[test]
fn goldens_are_the_cpu_reference() {
    assert_eq!(GOLDEN_FRAME, frame_reference().as_slice(), "frame golden drifted from its CPU reference");
    assert_eq!(GOLDEN_LEDS, leds_reference().as_slice(), "LED golden drifted from its CPU reference");
}

#[test]
fn gpu_matches_the_goldens() {
    let gpu = Gpu::open(AdapterPolicy { allow_software: true, force_software: std::env::var("ARTLUX_ENGINE_SOFTWARE").is_ok() })
        .expect("a GPU device (any adapter, software allowed in tests)");
    match selftest(&gpu) {
        Ok(lines) => for l in lines { println!("{l}"); },
        Err(lines) => panic!("{}", lines.join("\n")),
    }
}
