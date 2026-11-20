fn main() {
    tauri_build::build();

    // Android 15 refuses to load a shared library whose LOAD segments are
    // 4 KB aligned, and Play rejects uploads built without this. The linker's
    // default page size comes from the target API level in the NDK, which is
    // still 4 KB on r27 — r28 makes 16 KB the default, but this has to work on
    // whichever NDK is installed. `cargo:rustc-link-arg` is used rather than
    // `.cargo/config.toml` because `cargo-ndk` sets `CARGO_TARGET_*_RUSTFLAGS`
    // in the environment, and an environment value wins over the config file.
    let target = std::env::var("TARGET").unwrap_or_default();
    if target.contains("android") {
        println!("cargo:rustc-link-arg=-Wl,-z,max-page-size=16384");
    }
}
