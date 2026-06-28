// Builds the C++ NVAPI shim (src/shim.cpp) and links it into the napi addon. NVAPI is resolved at
// build time from the NVIDIA NVAPI SDK, located via the NVAPI_SDK_DIR env var (the SDK root that
// contains nvapi.h + amd64/nvapi64.lib). When NVAPI_SDK_DIR is unset (e.g. a non-NVIDIA dev box), the
// shim compiles in STUB mode — every entry point reports "unavailable" — so the addon still builds and
// loads, and ArtLux falls back to its GLSL warp/blend. Set NVAPI_SDK_DIR on the Quadro/RTX-pro machine
// to produce the real hardware path.
fn main() {
    napi_build::setup();

    let mut build = cc::Build::new();
    build.cpp(true).file("src/shim.cpp");

    match std::env::var("NVAPI_SDK_DIR") {
        Ok(sdk) if !sdk.trim().is_empty() => {
            let sdk = sdk.trim_end_matches(['/', '\\']).to_string();
            build.include(&sdk);                 // nvapi.h at the SDK root
            build.define("NVWARP_HAVE_NVAPI", None);
            // nvapi64.lib is a small static stub; the real functions live in the driver's nvapi64.dll.
            println!("cargo:rustc-link-search=native={sdk}/amd64");
            println!("cargo:rustc-link-lib=static=nvapi64");
            println!("cargo:warning=nvwarp: building REAL NVAPI path (NVAPI_SDK_DIR={sdk})");
        }
        _ => {
            println!("cargo:warning=nvwarp: NVAPI_SDK_DIR unset — building STUB (available()=false). Set it on the Quadro machine for the real path.");
        }
    }

    build.compile("nvwarp_shim");
    println!("cargo:rerun-if-changed=src/shim.cpp");
    println!("cargo:rerun-if-env-changed=NVAPI_SDK_DIR");
}
