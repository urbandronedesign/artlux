fn main() {
    // Only the Node addon needs napi's link setup; the native render engine builds this crate without it.
    if std::env::var_os("CARGO_FEATURE_NAPI").is_some() {
        napi_build::setup();
    }
}
