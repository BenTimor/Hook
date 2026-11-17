//! Integration check that spawns the real coding engine.
//!
//! It never calls a model: only the RPC handshake, the guard extension load and
//! the sandbox flags are exercised, so it costs nothing to run. The bundled
//! runtime is preferred (that is what ships); a `pi` on PATH is the fallback.
//! The test skips itself when neither exists.

use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

fn detect_pi() -> Option<PathBuf> {
    let out = Command::new("where").arg("pi.cmd").output().ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    let line = text.lines().next()?.trim().to_string();
    let path = PathBuf::from(line);
    path.is_file().then_some(path)
}

/// How to launch the engine: the bundled runtime if it is present, else PATH.
fn engine() -> Option<(PathBuf, Vec<String>)> {
    let runtime = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("resources")
        .join("pi-runtime");
    let node = runtime.join("node.exe");
    let cli = runtime.join("pi").join("dist").join("bundle").join("cli.js");
    if node.is_file() && cli.is_file() {
        return Some((node, vec![cli.to_string_lossy().to_string()]));
    }
    detect_pi().map(|pi| (PathBuf::from("cmd"), vec!["/C".into(), pi.to_string_lossy().to_string()]))
}

#[test]
fn rpc_handshake_returns_state_without_calling_a_model() {
    let Some((program, prefix)) = engine() else {
        eprintln!("no coding engine available — skipping the RPC handshake test");
        return;
    };

    let base = std::env::temp_dir().join(format!("hook-rpc-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&base);
    std::fs::create_dir_all(&base).unwrap();

    let guard = base.join("hook-guard.mjs");
    std::fs::write(&guard, hook_core::guard_source()).unwrap();
    let sessions = base.join("sessions");
    let project = base.join("project");
    std::fs::create_dir_all(&sessions).unwrap();
    std::fs::create_dir_all(&project).unwrap();

    // Empty model: this test must never depend on a configured provider.
    let args = hook_core::agent_args(&sessions, "handshake01", "handshake", &guard, "", None);

    let mut child = Command::new(&program)
        .args(&prefix)
        .args(&args)
        .current_dir(&project)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .expect("pi should start");

    // Watchdog: never let a broken handshake hang the suite.
    let pid = child.id();
    let watchdog = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(40));
        let _ = Command::new("taskkill")
            .args(["/F", "/T", "/PID", &pid.to_string()])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    });

    let mut stdin = child.stdin.take().expect("stdin");
    stdin
        .write_all(b"{\"id\":\"probe\",\"type\":\"get_state\"}\n")
        .expect("write probe");
    stdin.flush().expect("flush probe");

    let mut reader = BufReader::new(child.stdout.take().expect("stdout"));
    let deadline = Instant::now() + Duration::from_secs(35);
    let mut answered = false;
    let mut line = String::new();

    while Instant::now() < deadline {
        line.clear();
        match reader.read_line(&mut line) {
            Ok(0) => break,
            Ok(_) => {
                if line.contains("\"command\":\"get_state\"") {
                    assert!(line.contains("\"success\":true"), "unexpected reply: {line}");
                    answered = true;
                    break;
                }
            }
            Err(_) => break,
        }
    }

    let _ = child.kill();
    let _ = child.wait();
    drop(watchdog);
    let _ = std::fs::remove_dir_all(&base);

    assert!(answered, "pi never answered get_state");
}
