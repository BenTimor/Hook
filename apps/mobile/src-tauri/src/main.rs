// Prevents an additional console window on Windows in release builds, where
// `tauri android dev` / `ios dev` also start this binary on the host.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    hook_mobile_lib::run()
}
