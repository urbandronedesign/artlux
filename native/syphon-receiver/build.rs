fn main() {
    napi_build::setup();

    // The shipped addon's rpaths. Two of them, because the framework sits in a different place in
    // development than it does in the installed app:
    //   @loader_path            — dev: Syphon.framework beside native/syphon-receiver/*.node
    //   @loader_path/../Frameworks — packaged: the .node is in Contents/Resources, the framework in
    //                                Contents/Frameworks (build.mac.extraFiles puts it there, and
    //                                that is where codesign expects nested code to live)
    //
    // ⚠ RELOCATABLE ON PURPOSE. The failure this prevents is an absolute path to the build machine's
    // checkout baked into the load command: it works forever here and fails at dlopen everywhere
    // else, surfacing in JS as "[syphon] native receiver unavailable" — which reads exactly like
    // "you forgot to build it". scripts/build-syphon.sh asserts the result with otool for that
    // reason; this is the half that makes the assertion pass.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        println!("cargo:rustc-link-arg-cdylib=-Wl,-rpath,@loader_path");
        println!("cargo:rustc-link-arg-cdylib=-Wl,-rpath,@loader_path/../Frameworks");
    }
}
