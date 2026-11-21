//! The Android window around the phone shell.
//!
//! The WebView is the app; the only native concern left is the keyboard. Tauri
//! registers this plugin's Kotlin class when the phone product starts, and the
//! class trims the window by the IME inset. Nothing here has a command or a
//! permission: it is a window fix, not an API.

use tauri::{plugin::TauriPlugin, Runtime};

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    tauri::plugin::Builder::new("mobile-shell")
        .setup(|_app, _api| {
            // Nothing on the Android side scans for `@TauriPlugin`; the class
            // has to be named here or the Kotlin is never instantiated.
            #[cfg(target_os = "android")]
            _api.register_android_plugin("app.hook.mobileshell", "MobileShellPlugin")
                .map_err(|error| -> Box<dyn std::error::Error> {
                    format!("Could not register the mobile shell: {error:?}").into()
                })?;
            Ok(())
        })
        .build()
}
