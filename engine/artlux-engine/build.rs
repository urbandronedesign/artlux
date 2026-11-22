// Item 2b: with the `ndi` feature, grafton-ndi links the NDI runtime's import library — so the engine's .exe
// would NOT START AT ALL (0xC0000135, DLL not found) on a machine without the NDI runtime on its PATH,
// taking the LED wire and the projectors down with it (measured on the first NDI build). The DLL is
// DELAY-LOADED instead: nothing loads at start-up, and ndi.rs loads it by full path before the first NDI call
// — or reports that it cannot, and the engine leaves NDI shows to the app.
fn main() {
    let ndi = std::env::var_os("CARGO_FEATURE_NDI").is_some();
    let msvc = std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc");
    if ndi && msvc {
        println!("cargo:rustc-link-arg-bins=/DELAYLOAD:Processing.NDI.Lib.x64.dll");
        println!("cargo:rustc-link-arg-bins=delayimp.lib");
    }
    println!("cargo:rerun-if-changed=build.rs");
}
