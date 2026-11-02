// Compiles the Objective-C shim and points the linker at Syphon.framework.
//
// On anything but macOS this does NOTHING and succeeds. That matters: the dev box for this feature
// is a Windows machine (plans/syphon-plugin.md §4.8), and a build script that failed there would
// make the whole branch unbuildable on the machine it is being written on.

use std::path::PathBuf;

fn main() {
    println!("cargo:rerun-if-changed=src/shim.m");
    println!("cargo:rerun-if-changed=src/shim.h");

    // TARGET_OS, not the host: cross-compiling to macOS from elsewhere is not a thing we do, but
    // asking the right question costs nothing and reads correctly.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("macos") {
        return;
    }

    // scripts/build-syphon.sh puts the framework one level up, beside the napi crate that ships it.
    let framework_dir: PathBuf = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("syphon-sys must live under native/syphon-receiver/")
        .to_path_buf();

    if !framework_dir.join("Syphon.framework").is_dir() {
        // A named, actionable failure. Without it the error is a wall of "unknown type name
        // SyphonClientBase" from clang, which reads like the source is broken rather than absent.
        panic!(
            "Syphon.framework not found at {}\n\
             Build it first:  bash scripts/build-syphon.sh   (or: npm run build:syphon)",
            framework_dir.display()
        );
    }
    let fw = framework_dir.display();

    cc::Build::new()
        .file("src/shim.m")
        // ARC. The shim holds Objective-C objects in statics and ARC is what keeps that honest;
        // the ONE thing it does not manage is the IOSurfaceRef, which is CoreFoundation and is
        // therefore released by hand — deliberately, since that +1 is what we hand to Electron.
        .flag("-fobjc-arc")
        .flag(&format!("-F{fw}"))
        .warnings(true)
        .compile("artlux_syphon_shim");

    println!("cargo:rustc-link-search=framework={fw}");
    println!("cargo:rustc-link-lib=framework=Syphon");
    println!("cargo:rustc-link-lib=framework=Foundation");
    println!("cargo:rustc-link-lib=framework=IOSurface");
    println!("cargo:rustc-link-lib=framework=CoreFoundation");

    // Examples only, and absolute on purpose. The selftest binary sits three directories deeper than
    // the shipped .node, so it cannot share the addon's relocatable @loader_path rpaths — and adding
    // a rpath to the SHIPPED addon just to satisfy a test would be the tail wagging the dog. A test
    // binary that never leaves the build machine is exactly where an absolute path is fine.
    println!("cargo:rustc-link-arg-examples=-Wl,-rpath,{fw}");
}
