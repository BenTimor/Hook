//! Google sign-in through the phone's own account sheet.
//!
//! The work is native: on Android a Kotlin command opens Credential Manager,
//! the system sheet lists the Google accounts on the device, and the chosen one
//! comes back as an ID token. The app hands that token to its server, which is
//! the only side that can decide whether it is a real account — see
//! `POST /api/auth/google` in `server/auth.mjs`.
//!
//! This crate exists so the renderer can call that with an ordinary `invoke`
//! under a name the capability system knows (`plugin:google-signin|sign_in`).
//! There is no browser, no redirect, and no deep link: the ID token is the whole
//! answer.
//!
//! A desktop registers the plugin too, and `available` answers "no" there — a
//! product on a machine without an account sheet falls back to its device flow.

use tauri::{plugin::TauriPlugin, Runtime};

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    tauri::plugin::Builder::new("google-signin")
        .setup(|_app, _api| {
            // Tauri instantiates the Kotlin class itself, over JNI, and the
            // class has to be named here: nothing on the Android side scans for
            // `@TauriPlugin`, so an unregistered plugin answers "Plugin
            // google-signin not initialized" for every command.
            #[cfg(target_os = "android")]
            _api.register_android_plugin("app.hook.googlesignin", "GoogleSigninPlugin")
                .map_err(|error| -> Box<dyn std::error::Error> {
                    format!("Could not register Google sign-in: {error:?}").into()
                })?;
            Ok(())
        })
        .build()
}
