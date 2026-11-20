const COMMANDS: &[&str] = &["available", "sign_in"];

fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .android_path("android")
        .build();
}
