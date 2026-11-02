fn main() {
    napi_build::setup();
    // macOS: ndi.node links libndi.dylib (the NDI SDK for Apple), and the app ships that dylib BESIDE
    // ndi.node in Contents/Resources (package.json `mac.extraResources`). grafton-ndi emits the link
    // directive but no runtime search path, so without this the loader looks for `@rpath/libndi.dylib`
    // with an empty rpath and `require('ndi.node')` fails on every Mac that has no NDI Tools installed.
    // @loader_path = the folder ndi.node itself was loaded from. scripts/stage-ndi-macos.cjs checks it.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        println!("cargo:rustc-cdylib-link-arg=-Wl,-rpath,@loader_path");
    }
}
