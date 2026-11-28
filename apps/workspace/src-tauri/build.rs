fn main() {
    // The executable's window and taskbar icon is compiled in from here. Tauri
    // watches its config, but not this file: without the line, a new icon can
    // sit in the tree while the running binary keeps drawing the old one.
    println!("cargo:rerun-if-changed=icons/icon.ico");
    println!("cargo:rerun-if-changed=icons/icon.png");
    tauri_build::build()
}
