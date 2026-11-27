#![cfg_attr(
    not(feature = "desktop"),
    allow(
        dead_code,
        reason = "without the IPC surface the functions it calls have no caller, and that is the point: the host is the same backend with no window"
    )
)]

//! The backend every Hook product links.
//!
//! The account, the chat store and its sync engine, the coding-agent supervisor,
//! the preview server, the assistant turn, the tools and the IPC surface live
//! here, compiled once, so "the chat works the same in Workspace" is a property
//! of the build rather than of two implementations that must be kept in step.
//!
//! Two shapes link it, and only one of them has a window:
//!
//! * a Tauri product (`apps/chat`, `apps/workspace`, `apps/mobile`) calls
//!   `builder`, which starts the backend in `boot::start` and then adds a
//!   window, a tray and the IPC surface (`commands.rs`);
//! * Hook Browser's host (`crates/hook-host`) links this crate with
//!   `default-features = false` and calls [`start`] directly. It has no window,
//!   no Tauri types and no `commands.rs` at all — just the backend and the
//!   loopback channel the browser reads.
//!
//! Both pass a [`Product`] and a set of [`Capabilities`]. A capability trims the
//! prompt and the toolset; it never changes the data model.

mod agent;
mod analytics;
mod auth;
mod boot;
mod bridge;
mod browser;
mod channel;
mod coding;
#[cfg(feature = "desktop")]
mod commands;
mod compact;
mod config;
mod devices;
pub mod events;
mod git;
mod guard;
mod imagegen;
mod import;
mod markdown_edit;
mod memory;
#[cfg(feature = "desktop")]
mod pdf;
mod projects;
mod preview;
mod provider;
mod relay;
mod remote;
mod reports;
pub mod rt;
mod runtime;
mod session;
mod settings;
mod state;
mod slash;
mod store;
mod sync;
mod tools;
mod turn;
#[cfg(feature = "desktop")]
mod update;
mod version;
mod workspace;

use std::path::{Path, PathBuf};
#[cfg(feature = "desktop")]
use std::sync::Arc;

#[cfg(feature = "desktop")]
use tauri::Manager;

// What a process that is not a Tauri window starts the backend with. A window
// goes through `builder` instead, which calls the same `start`.
pub use crate::boot::{start, StartOptions};
pub use crate::events::{EventSink, NoopSink};
pub use crate::state::AppState;

// The release app has no console for background helpers to inherit.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

// Re-exported for the integration tests so they use the exact same guard text
// and command line as the runtime.
pub use crate::agent::agent_args;
pub fn guard_source() -> &'static str {
    crate::guard::GUARD_SOURCE
}

/// Which product this backend is serving.
///
/// The data folder comes from the Tauri identifier for a window, and from
/// `identifier()` for a plain binary (`hook-host`); this enum is about behaviour
/// that differs user-visibly (what the chat agent is told, which folder the
/// process owns, and which product-specific tools it gets).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Product {
    Chat,
    Workspace,
    /// Hook on a phone. The same conversation, no folder on this device.
    Mobile,
    /// Hook's host process for Hook Browser (`crates/hook-host`). Not a window:
    /// the browser starts it, it serves the channel, and it keeps running while
    /// the browser is open. Its own folder and its own descriptor, so it can run
    /// beside a Hook app in the tray.
    Browser,
}

impl Product {
    /// The one-word name used everywhere a product is named to a machine: the
    /// `hook://sync` and analytics payloads, `/health`, the app-info command and
    /// the channel descriptor's file name.
    pub fn slug(self) -> &'static str {
        match self {
            Product::Chat => "chat",
            Product::Workspace => "workspace",
            Product::Mobile => "mobile",
            Product::Browser => "browser",
        }
    }

    /// The folder this product keeps its own data in, which is also its Tauri
    /// identifier for the products that have a window. One product per folder is
    /// what makes "which chats" a property of the build rather than of whichever
    /// process happened to start first.
    pub fn identifier(self) -> &'static str {
        match self {
            Product::Chat => "app.hook.chat",
            Product::Workspace => "app.hook.workspace",
            Product::Mobile => "app.hook.mobile",
            Product::Browser => "app.hook.browser",
        }
    }
}

/// What this product's chat agent may do, and therefore what the prompt and the
/// toolset advertise.
///
/// Every field is a *place the answer can appear* or a *thing this device can
/// reach*, not a feature of the product. A capability trims the prompt and the
/// toolset; it must never change the data model. Getting this wrong is how a
/// phone ends up told to brief a coding agent it has no way to start, or to put
/// a page in a panel that is not there.
#[derive(Clone, Copy, Debug)]
pub struct Capabilities {
    /// A panel that can show an HTML page served from a coding agent's project.
    /// It needs files on this machine, so it is off wherever there are none.
    pub preview_pages: bool,
    /// The same panel, showing a Hook Workspace document, task or board. It is
    /// only data from the account, which is why a phone can have this half.
    pub preview_workspace: bool,
    /// Launch and steer `pi` coding agents inside project folders on this
    /// machine. Only Hook and the headless daemon host.
    pub coding_agents: bool,
    /// Drive coding agents on the account's other machines. A phone and Hook
    /// Workspace have this without `coding_agents`: they are controllers, not
    /// hosts.
    pub remote_agents: bool,
    /// Read and write Hook Workspace projects, boards, tasks and documents.
    pub workspace_tools: bool,
    /// Project folders on this machine: list, create, delete, describe,
    /// remember in. Without a projects directory these tools can only fail, so a
    /// device with no folder of its own must not advertise them.
    pub projects: bool,
    /// A Hook Browser on this machine, whose tabs the account's chats may read.
    /// Only the browser's own host has one; every other product reaches a
    /// browser through `remote_agents` and the relay.
    pub browser: bool,
}

impl Capabilities {
    /// The full chat product: everything on.
    pub const fn chat() -> Self {
        Self {
            preview_pages: true,
            preview_workspace: true,
            coding_agents: true,
            remote_agents: true,
            workspace_tools: true,
            projects: true,
            browser: false,
        }
    }

    /// Hook Workspace: the chat agent, the account's Workspace data and the
    /// other machines. It is not a host: Hook on the same computer runs the
    /// agents, and Workspace forwards a "this computer" start to it.
    pub const fn workspace() -> Self {
        Self {
            preview_pages: false,
            preview_workspace: false,
            coding_agents: false,
            remote_agents: true,
            workspace_tools: true,
            projects: true,
            browser: false,
        }
    }

    /// Hook Browser's host: the conversation, the account's Workspace data and
    /// *this machine's browser*. No engine and no project folder — the browser
    /// drives agents on the account's other computers — and no page served from
    /// disk, because there is no project to serve one from.
    ///
    /// `browser` is what makes a read local here and remote everywhere else: a
    /// tab belongs to the process that hosts it, so this is the only product
    /// that can answer `read_page` without the relay.
    pub const fn browser() -> Self {
        Self {
            preview_pages: false,
            preview_workspace: true,
            coding_agents: false,
            remote_agents: true,
            workspace_tools: true,
            projects: false,
            browser: true,
        }
    }

    /// Hook on a phone: the conversation and the account's Workspace data, no
    /// folder, no engine, no page served from disk. The preview surface exists
    /// and shows boards, tasks and documents, because those arrive over the API.
    pub const fn mobile() -> Self {
        Self {
            preview_pages: false,
            preview_workspace: true,
            coding_agents: false,
            remote_agents: true,
            workspace_tools: true,
            projects: false,
            browser: false,
        }
    }
}

/// Build the Tauri app: plugins, state, background loops and the IPC surface.
///
/// The caller supplies `generate_context!()`, the window configuration and its
/// own version, because all three belong to the product: `generate_context!()`
/// and the window come from its `tauri.conf.json`, and `version` — normally
/// `env!("CARGO_PKG_VERSION")` in the product crate — is what this build reports
/// as itself. It is a required argument so no product can silently fall back to
/// hook-core's version, which is not a release number (see `version.rs`).
#[cfg(feature = "desktop")]
pub fn builder(
    product: Product,
    capabilities: Capabilities,
    version: &'static str,
) -> tauri::Builder<tauri::Wry> {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(move |app| setup(app, product, capabilities, version))
        .invoke_handler(tauri::generate_handler![
            commands::app_info,
            commands::set_status_bar_style,
            commands::haptic_feedback,
            commands::list_chats,
            commands::get_chat,
            commands::rename_chat,
            commands::set_pinned,
            commands::delete_chat,
            commands::restore_chat,
            commands::search_chats,
            commands::send_message,
            commands::regenerate,
            commands::edit_message,
            commands::stop_stream,
            commands::get_settings,
            commands::slash_commands,
            commands::set_projects_dir,
            commands::delete_project,
            commands::restore_project,
            commands::set_advanced_mode,
            commands::set_custom_provider,
            commands::clear_custom_provider,
            commands::custom_models,
            commands::set_cloud_sync,
            commands::read_image,
            commands::open_image,
            commands::save_image_as,
            commands::save_image,
            commands::export_pdf,
            commands::open_path,
            commands::app_info,
            commands::auth_status,
            commands::auth_login,
            commands::auth_cancel_login,
            commands::auth_google_config,
            commands::auth_google,
            commands::auth_refresh,
            commands::auth_logout,
            commands::open_url,
            commands::agents_overview,
            commands::agent_transcript,
            commands::stop_chat_agents,
            commands::answer_coding_agent,
            commands::create_coding_chat,
            commands::set_coding_chat_folder,
            commands::create_remote_coding_chat,
            commands::fetch_remote_chat,
            commands::remote_projects,
            commands::remote_create_project,
            commands::remote_folders,
            commands::remote_pin_folder,
            commands::devices_list,
            commands::subscribe_chat,
            commands::unsubscribe_chat,
            commands::device_rename,
            commands::device_set_remote,
            commands::device_remove,
            commands::stop_remote_agent,
            commands::preview_state,
            commands::sync_status,
            commands::set_chat_context,
            commands::ws_request,
            commands::sync_now,
            commands::import_scan,
            commands::import_apply,
            commands::check_update,
            commands::install_update,
            commands::open_store_update,
            commands::report_message,
            commands::report_content,
            commands::memory_list,
            commands::memory_save,
            commands::memory_update,
            commands::memory_delete,
            commands::memory_clear,
            commands::memory_set_enabled,
        ])
}

/// Hook is the machine host, so closing its window must not stop the work: the
/// window hides to the tray and the agent processes keep running. Quit lives in
/// the tray menu, and `on_exit` still kills every child.
#[cfg(feature = "tray")]
fn install_tray(app: &mut tauri::App) -> tauri::Result<()> {
    use tauri::menu::{Menu, MenuItem};
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

    let open = MenuItem::with_id(app, "open", "Open Hook", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Hook", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &quit])?;
    let Some(icon) = app.default_window_icon().cloned() else {
        return Ok(());
    };
    TrayIconBuilder::with_id("hook")
        .icon(icon)
        .tooltip("Hook — agents keep working while this window is closed")
        .menu(&menu)
        // A Windows tray icon opens its menu on right-click; a macOS menu-bar
        // icon opens it on the left click, as every other menu-bar app does.
        .show_menu_on_left_click(cfg!(target_os = "macos"))
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.unminimize();
                    let _ = window.set_focus();
                }
            }
            "quit" => {
                on_exit(app);
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            // macOS already opened the menu above; there is no second gesture
            // to give the window. Windows keeps its left-click-to-show.
            if cfg!(target_os = "macos") {
                return;
            }
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let app = tray.app_handle();
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.unminimize();
                    let _ = window.set_focus();
                }
            }
        })
        .build(app)?;

    if let Some(window) = app.get_webview_window("main") {
        let handle = app.handle().clone();
        window.on_window_event(move |event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                if let Some(window) = handle.get_webview_window("main") {
                    let _ = window.hide();
                }
            }
        });
    }
    Ok(())
}

/// Where this process keeps its own data: chats, settings, the agent home.
///
/// The account file, memory and the browser-channel descriptor live one level
/// up from a product's folder (`auth.rs`, `memory.rs`, `channel.rs`), so two
/// running builds of the *same* product would share all of it — the chats, the
/// sync cursor and the device id. That is exactly what a debug build must not
/// do to an installed one: `coding::recover` turns a running agent's "streaming"
/// reply into an error the next time either process starts, and the relay would
/// see one machine connected twice.
///
/// A debug build (`pnpm app`, `cargo run`) therefore keeps its data one folder
/// deeper, in `%APPDATA%\hook-dev\<identifier>`, which moves the account file
/// with it: its own sign-in, its own device id, its own chats. A release build
/// is the installed product and keeps `%APPDATA%\<identifier>`.
///
/// `HOOK_DATA_DIR` overrides both: point it at an installed product's folder to
/// read its data from a debug build, or at an empty folder to walk through a
/// fresh install.
#[cfg(feature = "desktop")]
fn resolve_data_dir(app: &tauri::App) -> Result<PathBuf, Box<dyn std::error::Error>> {
    Ok(in_place(app.path().app_data_dir()?))
}

/// The two things every product does to the folder the platform gave it:
/// `HOOK_DATA_DIR` wins outright, and a debug build nests one level deeper so it
/// cannot join an installed product's account, device id and chats.
fn in_place(dir: PathBuf) -> PathBuf {
    if let Some(dir) = std::env::var_os("HOOK_DATA_DIR").filter(|value| !value.is_empty()) {
        return PathBuf::from(dir);
    }
    if !cfg!(debug_assertions) {
        return dir;
    }
    dev_data_dir(&dir).unwrap_or(dir)
}

/// Where a product that is not a Tauri window keeps its own data.
///
/// A Tauri product answers this from its identifier (`app.path().app_data_dir()`);
/// a plain binary has no such context, so the same folder is named here —
/// `%APPDATA%\<identifier>` on Windows — and then goes through the identical
/// `HOOK_DATA_DIR` and debug-nesting rules. `hook-host` is the only caller: it
/// must land in the folder the browser's gate already reads the account from, or
/// the card would say "signed in" while the channel served nothing.
pub fn product_data_dir(identifier: &str) -> Result<PathBuf, std::io::Error> {
    Ok(in_place(appdata_dir()?.join(identifier)))
}

#[cfg(windows)]
fn appdata_dir() -> Result<PathBuf, std::io::Error> {
    std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .ok_or_else(|| std::io::Error::other("APPDATA is not set"))
}

#[cfg(target_os = "macos")]
fn appdata_dir() -> Result<PathBuf, std::io::Error> {
    std::env::var_os("HOME")
        .map(|home| {
            PathBuf::from(home)
                .join("Library")
                .join("Application Support")
        })
        .ok_or_else(|| std::io::Error::other("HOME is not set"))
}

#[cfg(not(any(windows, target_os = "macos")))]
fn appdata_dir() -> Result<PathBuf, std::io::Error> {
    std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .or_else(|| {
            std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".local").join("share"))
        })
        .ok_or_else(|| std::io::Error::other("HOME is not set"))
}

/// `%APPDATA%\app.hook.chat` → `%APPDATA%\hook-dev\app.hook.chat`.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn dev_data_dir(dir: &Path) -> Option<PathBuf> {
    let parent = dir.parent()?;
    Some(parent.join("hook-dev").join(dir.file_name()?))
}

/// A phone's data folder is its own container and its parent belongs to the
/// system (`auth.rs`), so there is no sibling folder to nest under.
#[cfg(any(target_os = "android", target_os = "ios"))]
fn dev_data_dir(_dir: &Path) -> Option<PathBuf> {
    None
}

#[cfg(feature = "desktop")]
fn setup(
    app: &mut tauri::App,
    product: Product,
    capabilities: Capabilities,
    version: &'static str,
) -> Result<(), Box<dyn std::error::Error>> {
    // The runtime is the window's. An async command and the background work it
    // starts then share one thread pool, and `rt::spawn` from a synchronous
    // command thread still works (`Handle::spawn` needs no reactor).
    crate::rt::set(tauri::async_runtime::handle().inner().clone());

    let state = boot::start(boot::StartOptions {
        data_dir: resolve_data_dir(app)?,
        resource_dir: app.path().resource_dir().ok(),
        product,
        capabilities,
        events: Arc::new(events::TauriSink::new(app.handle().clone())),
        version,
    })?;
    app.manage(state.clone());

    // `--headless` is the host without a face: the window is never shown and no
    // tray icon is installed, so a script or a shortcut can start the process
    // that serves the browser's channel and keeps agents running, and nothing
    // appears on the desktop. It is the interim sidecar: the same account, the
    // same turn, and the same channel the browser already talks to, in a process
    // that is not the window someone is using. `hook-host` is the real one.
    if std::env::args().any(|argument| argument == "--headless") {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.hide();
        }
        eprintln!("hook: headless host, channel {}", state.channel.describe());
        return Ok(());
    }

    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_focus();
    }

    // Only the chat product hosts machines today. Workspace and the phone have
    // no agents to keep alive, so closing their window is still closing them.
    #[cfg(feature = "tray")]
    if product == Product::Chat {
        if let Err(error) = install_tray(app) {
            eprintln!("hook: could not install the tray icon: {error}");
        }
    }

    Ok(())
}

/// Kill everything that would otherwise outlive the window.
#[cfg(feature = "desktop")]
pub fn on_exit(app: &tauri::AppHandle) {
    if let Some(state) = app.try_state::<Arc<AppState>>() {
        shutdown(&state);
    }
}

/// Stop the work that outlives everything else: agent children and the preview
/// server. A window calls it as it exits; `hook-host` calls it when it is asked
/// to stop. Both leave a machine with nothing of theirs still running.
pub fn shutdown(state: &AppState) {
    state.agents.kill_all_sync();
    state.preview.stop();
}

#[cfg(all(test, not(any(target_os = "android", target_os = "ios"))))]
mod tests {
    use super::dev_data_dir;
    use std::path::Path;

    /// The dev folder has to sit *below* the roaming folder that holds the
    /// products, not beside `app.hook.chat`: `auth.rs` and `memory.rs` take the
    /// parent of the data folder as the shared `app.hook` one, which is what
    /// keeps a debug build's account file away from the installed one.
    #[test]
    fn a_debug_build_keeps_its_data_beside_the_products() {
        let installed = Path::new("roaming").join("app.hook.chat");
        let dev = dev_data_dir(&installed).expect("a dev folder");
        assert_eq!(dev, Path::new("roaming").join("hook-dev").join("app.hook.chat"));
        // The account file follows the parent, so it lands in hook-dev too.
        assert_eq!(dev.parent(), Some(Path::new("roaming/hook-dev")));
    }
}
