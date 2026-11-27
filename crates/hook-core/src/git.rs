//! Git for coding agents.
//!
//! On Windows Hook ships MinGit (`scripts/fetch-git.mjs`) so a user never
//! installs git. macOS and Linux use the system `git` from Command Line Tools
//! (or the distribution), which is also the git a developer's terminal has.
//! Nothing about a project's remote is visible in the app: Hook writes one
//! managed global config into the agent home with the account's **git-only**
//! token and points `GIT_CONFIG_GLOBAL` at it. Plain `git pull` / `git push`
//! therefore work inside an agent, while the token never enters a project or a
//! URL, and it cannot be used for chats or model calls.
//!
//! Development and tests fall back to a `git` on `PATH` when the bundled copy
//! is absent, the same way `runtime.rs` falls back to a system pi.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use tokio::process::Command;

const RESOURCE_DIR: &str = "git";
const NETWORK_TIMEOUT: Duration = Duration::from_secs(120);

/// Patterns that stay out of every project's history. They go into
/// `.git/info/exclude`, which is local to the repository: a tracked `.gitignore`
/// arriving from another computer can never conflict with it, and the agent
/// still cannot commit node_modules by accident.
const EXCLUDE_MARKER: &str = "# Hook: dependencies and build output stay local";
const EXCLUDE_PATTERNS: &str = "\
node_modules/
.venv/
venv/
__pycache__/
dist/
build/
.next/
.cache/
.turbo/
target/
coverage/
*.log
.DS_Store
Thumbs.db
";

fn write_exclude(project_path: &Path) {
    let file = project_path.join(".git").join("info").join("exclude");
    let existing = std::fs::read_to_string(&file).unwrap_or_default();
    if existing.contains(EXCLUDE_MARKER) {
        return;
    }
    let _ = std::fs::create_dir_all(file.parent().unwrap_or(project_path));
    let mut text = existing;
    if !text.is_empty() && !text.ends_with('\n') {
        text.push('\n');
    }
    text.push_str(EXCLUDE_MARKER);
    text.push('\n');
    text.push_str(EXCLUDE_PATTERNS);
    let _ = std::fs::write(file, text);
}

#[derive(Clone, Debug)]
pub struct GitRuntime {
    pub program: PathBuf,
    /// Folders to put on the agent's `PATH` so `git` resolves to this copy.
    pub path_dirs: Vec<PathBuf>,
}

fn node_roots(resource_dir: Option<&Path>, data_dir: &Path) -> Vec<PathBuf> {
    let mut roots: Vec<PathBuf> = Vec::new();
    if let Some(dir) = resource_dir {
        roots.push(dir.to_path_buf());
        roots.push(dir.join("resources"));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            roots.push(dir.to_path_buf());
            roots.push(dir.join("resources"));
        }
    }
    roots.push(Path::new(env!("CARGO_MANIFEST_DIR")).join("resources"));
    roots.push(data_dir.to_path_buf());
    roots
}

fn find_on_path(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        let candidate = dir.join(name);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

/// Locate the bundled MinGit tree (or a developer's git as a last resort).
pub fn resolve(resource_dir: Option<&Path>, data_dir: &Path) -> Option<GitRuntime> {
    let executable = if cfg!(windows) { "git.exe" } else { "git" };
    for root in node_roots(resource_dir, data_dir) {
        let dir = root.join(RESOURCE_DIR);
        // MinGit: cmd\git.exe is the launcher; the real binary and its DLLs
        // live in ucrt64\bin (newer releases) or mingw64\bin (older ones).
        let launcher = dir.join("cmd").join(executable);
        let real = dir.join("ucrt64").join("bin").join(executable);
        let legacy = dir.join("mingw64").join("bin").join(executable);
        let program = if real.is_file() {
            real
        } else if legacy.is_file() {
            legacy
        } else if launcher.is_file() {
            launcher
        } else {
            continue;
        };
        let mut path_dirs = Vec::new();
        for sub in ["ucrt64/bin", "mingw64/bin", "cmd", "bin"] {
            let candidate = dir.join(sub.replace('/', std::path::MAIN_SEPARATOR_STR));
            if candidate.is_dir() {
                path_dirs.push(crate::store::strip_verbatim(candidate));
            }
        }
        return Some(GitRuntime {
            program: crate::store::strip_verbatim(program),
            path_dirs,
        });
    }
    find_on_path(executable).map(|program| GitRuntime {
        program: crate::store::strip_verbatim(program),
        path_dirs: Vec::new(),
    })
}

/// The remote Hook manages. A project's own `origin` is never touched.
pub fn remote_url(base_url: &str, project_id: &str) -> String {
    format!(
        "{}/api/git/{project_id}.git",
        base_url.trim_end_matches('/')
    )
}


/// Write the single global config every agent (and Hook itself) uses for git.
/// The token is a git scope token: reading a project's `.git/config` or the
/// agent environment cannot reach conversations or the model.
pub fn write_agent_config(
    agent_home: &Path,
    base_url: &str,
    token: Option<&str>,
) -> Result<PathBuf, String> {
    let path = agent_home.join("gitconfig");
    let base = base_url.trim_end_matches('/');
    let auth = match token.filter(|t| !t.trim().is_empty()) {
        Some(token) => format!(
            "[http \"{base}/api/git/\"]\n\textraHeader = Authorization: Bearer {token}\n"
        ),
        None => String::new(),
    };
    let content = format!(
        "# Written by Hook before every agent run.\n\
         [user]\n\tname = Hook\n\temail = hook@users.noreply.hookcode.io\n\
         [init]\n\tdefaultBranch = main\n\
         [core]\n\tautocrlf = false\n\tlongpaths = true\n\tsymlinks = false\n\
         [safe]\n\tdirectory = *\n\
         [credential]\n\thelper =\n\
         [protocol]\n\tversion = 2\n\
         {auth}",
    );
    crate::store::write_atomic(&path, content.as_bytes())
        .map_err(|e| format!("Could not write git config: {e}"))?;
    Ok(path)
}

/// Environment every git invocation needs, so it can never prompt and finds
/// the bundled binary's DLLs.
///
/// `config` names Hook's managed file, and the run uses Hook's own copy of git
/// (`PATH` is prepended with it). `None` is a folder that is not one of the
/// account's projects but is inside a repository of the user's own: there the
/// `PATH` is left alone, so `git` is the one their terminal uses, with their
/// global config, their system config and their credential helper. A prompt is
/// refused either way, because the engine's stdin is the RPC channel and not a
/// place to ask a question.
pub fn env(
    git: &GitRuntime,
    config: Option<&Path>,
) -> Vec<(std::ffi::OsString, std::ffi::OsString)> {
    let mut values: Vec<(std::ffi::OsString, std::ffi::OsString)> = vec![
        ("GIT_TERMINAL_PROMPT".into(), "0".into()),
        ("GIT_OPTIONAL_LOCKS".into(), "0".into()),
    ];
    if let Some(config) = config {
        values.push(("GIT_CONFIG_GLOBAL".into(), config.as_os_str().to_owned()));
        values.push(("GIT_CONFIG_NOSYSTEM".into(), "1".into()));
        let mut path = git.path_dirs.clone();
        if let Some(existing) = std::env::var_os("PATH") {
            path.extend(std::env::split_paths(&existing));
        }
        if let Ok(joined) = std::env::join_paths(path) {
            values.push(("PATH".into(), joined));
        }
    }
    values
}

/// Whether a run should read the user's own git config instead of Hook's.
///
/// A folder that is inside a git repository and is not one of the account's
/// projects is the user's own clone: they pointed the agent at it and expect
/// `git` to behave the way it does in their terminal, credentials included. A
/// Hook project keeps the managed file, because its identity, its remote and
/// its token belong to the account.
pub fn uses_user_config(is_account_project: bool, path: &Path) -> bool {
    !is_account_project && inside_work_tree(path)
}

/// Whether the user's own git is there to run.
///
/// Hook ships MinGit, but the credentials in a terminal come from the user's
/// installation as much as from their config: on Windows the system gitconfig
/// (`C:\Program Files\Git\etc\gitconfig`) is where Git declares its credential
/// manager, and the bundled copy has no system config that could reach it. So a
/// repository of the user's runs the `git` on their `PATH`; only when they have
/// none does the run fall back to the bundled copy and Hook's own config.
pub fn user_git_available() -> bool {
    let executable = if cfg!(windows) { "git.exe" } else { "git" };
    find_on_path(executable).is_some()
}

/// Git walks up from the folder to find the repository, so a subfolder of a
/// clone is inside one too (and `.git` is a file in a worktree or submodule).
fn inside_work_tree(path: &Path) -> bool {
    path.ancestors().any(|dir| dir.join(".git").exists())
}

fn command(
    git: &GitRuntime,
    config: &Path,
    cwd: &Path,
    args: &[&str],
) -> std::process::Command {
    let mut command = std::process::Command::new(&git.program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // Git uses pipes and never prompts. Run it without attaching a
        // console, including when Hook was launched from a terminal.
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        command.creation_flags(DETACHED_PROCESS);
    }
    command
        .args(args)
        .current_dir(cwd)
        .envs(env(git, Some(config)))
        .stdin(Stdio::null());
    command
}

async fn run(
    git: &GitRuntime,
    config: &Path,
    cwd: &Path,
    args: &[&str],
    timeout: Duration,
) -> Result<String, String> {
    let mut command = Command::from(command(git, config, cwd, args));
    command
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let child = command
        .spawn()
        .map_err(|e| format!("Could not run git: {e}"))?;
    let output = match tokio::time::timeout(timeout, child.wait_with_output()).await {
        Ok(Ok(output)) => output,
        Ok(Err(error)) => return Err(format!("git failed: {error}")),
        Err(_) => return Err("git timed out".into()),
    };
    if output.status.success() {
        return Ok(String::from_utf8_lossy(&output.stdout).to_string());
    }
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    Err(if stderr.is_empty() { stdout } else { stderr })
}

fn ok_sync(
    git: &GitRuntime,
    config: &Path,
    cwd: &Path,
    args: &[&str],
) -> Result<String, String> {
    let output = command(git, config, cwd, args)
        .output()
        .map_err(|e| format!("Could not run git: {e}"))?;
    if output.status.success() {
        return Ok(String::from_utf8_lossy(&output.stdout).to_string());
    }
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    Err(if stderr.is_empty() { stdout } else { stderr })
}

/// Create the repository and point it at the account. Safe to call repeatedly;
/// it never commits, checks out or touches existing work.
pub fn prepare_project(
    git: &GitRuntime,
    config: &Path,
    project_path: &Path,
    base_url: &str,
    project_id: &str,
) -> Result<(), String> {
    let url = remote_url(base_url, project_id);
    if !project_path.join(".git").is_dir() {
        ok_sync(git, config, project_path, &["init", "-b", "main"])?;
    }

    write_exclude(project_path);

    let has_remote = ok_sync(git, config, project_path, &["remote", "get-url", "hook"]).is_ok();
    if !has_remote {
        ok_sync(git, config, project_path, &["remote", "add", "hook", &url])?;
    } else {
        ok_sync(git, config, project_path, &["remote", "set-url", "hook", &url])?;
    }

    // A new repository should push to Hook by default. An existing project
    // that already tracks its own remote (origin) keeps that upstream.
    let upstream = ok_sync(
        git,
        config,
        project_path,
        &["config", "--get", "branch.main.remote"],
    )
    .unwrap_or_default();
    if upstream.trim().is_empty() {
        let _ = ok_sync(
            git,
            config,
            project_path,
            &["config", "branch.main.remote", "hook"],
        );
        let _ = ok_sync(
            git,
            config,
            project_path,
            &["config", "branch.main.merge", "refs/heads/main"],
        );
    }
    Ok(())
}

/// Take one snapshot of an existing project the first time it joins the
/// account. Only runs when the repository has no commits yet.
pub fn initial_snapshot(
    git: &GitRuntime,
    config: &Path,
    project_path: &Path,
) -> Result<bool, String> {
    if ok_sync(git, config, project_path, &["rev-parse", "--verify", "HEAD"]).is_ok() {
        return Ok(false);
    }
    ok_sync(git, config, project_path, &["add", "-A"])?;
    let staged = ok_sync(git, config, project_path, &["diff", "--cached", "--name-only"])?;
    if staged.trim().is_empty() {
        return Ok(false);
    }
    ok_sync(
        git,
        config,
        project_path,
        &["commit", "-m", "Initial snapshot from Hook", "--no-verify"],
    )?;
    Ok(true)
}

/// Whether the local branch has at least one commit.
pub fn has_commits(git: &GitRuntime, config: &Path, project_path: &Path) -> bool {
    ok_sync(git, config, project_path, &["rev-parse", "--verify", "HEAD"]).is_ok()
}

/// Push the current branch to Hook. A failure is reported, never retried here:
/// the agent (or the next sync cycle) decides what to do.
pub async fn push(git: &GitRuntime, config: &Path, project_path: &Path) -> Result<String, String> {
    run(
        git,
        config,
        project_path,
        &["push", "-u", "hook", "HEAD:main"],
        NETWORK_TIMEOUT,
    )
    .await
}

/// Fill an empty project folder from the account (a project started on another
/// computer). An empty remote is a normal, silent no-op.
pub async fn pull_into_empty(
    git: &GitRuntime,
    config: &Path,
    project_path: &Path,
) -> Result<(), String> {
    match run(
        git,
        config,
        project_path,
        &["pull", "--ff-only", "hook", "main"],
        NETWORK_TIMEOUT,
    )
    .await
    {
        Ok(_) => Ok(()),
        Err(error) if error.contains("couldn't find remote ref") => Ok(()),
        Err(error) if error.contains("couldn't find remote ref \"main\"") => Ok(()),
        Err(error) => Err(error),
    }
}

/// Remove a local chat attachment? No: this module only deals with git.
#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    #[tokio::test]
    async fn background_git_commands_have_no_console() {
        let git = GitRuntime {
            program: std::env::current_exe().unwrap(),
            path_dirs: Vec::new(),
        };
        let cwd = std::env::temp_dir();
        let config = cwd.join("unused-hook-console-test-config");
        let args = ["--ignored", "--exact", "git::tests::console_probe"];
        ok_sync(&git, &config, &cwd, &args).expect("synchronous Git command attached a console");
        run(&git, &config, &cwd, &args, Duration::from_secs(10))
            .await
            .expect("asynchronous Git command attached a console");
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "spawned as the child process by background_git_commands_have_no_console"]
    fn console_probe() {
        #[link(name = "kernel32")]
        extern "system" {
            fn GetConsoleProcessList(processes: *mut u32, length: u32) -> u32;
        }
        let mut process = 0;
        // SAFETY: the pointer is writable and the length is one DWORD.
        let count = unsafe { GetConsoleProcessList(&mut process, 1) };
        assert_eq!(count, 0, "the child is attached to a Windows console");
    }

    #[test]
    fn remote_url_is_stable() {
        assert_eq!(
            remote_url("https://hookcode.io/", "pj_abc"),
            "https://hookcode.io/api/git/pj_abc.git"
        );
        assert_eq!(
            remote_url("https://example.test", "pj_abc"),
            "https://example.test/api/git/pj_abc.git"
        );
    }

    fn pairs(list: Vec<(std::ffi::OsString, std::ffi::OsString)>) -> Vec<(String, String)> {
        list.into_iter()
            .map(|(key, value)| {
                (
                    key.to_string_lossy().to_string(),
                    value.to_string_lossy().to_string(),
                )
            })
            .collect()
    }

    #[test]
    fn a_project_reads_hook_config_and_the_users_repository_reads_theirs() {
        let git = GitRuntime {
            program: PathBuf::new(),
            path_dirs: Vec::new(),
        };
        let config = std::env::temp_dir().join("hook-gitconfig-never-read");
        let managed = pairs(env(&git, Some(&config)));
        assert!(managed
            .iter()
            .any(|(key, value)| key == "GIT_CONFIG_GLOBAL" && *value == config.to_string_lossy()));
        assert!(managed.iter().any(|(key, _)| key == "GIT_CONFIG_NOSYSTEM"));
        // ... and Hook's own copy of git is what runs.
        assert!(managed.iter().any(|(key, _)| key == "PATH"));

        // The user's own repository: no override, so git finds their global and
        // system config - which is where their helper and SSH keys live - and
        // PATH is left alone, so it is the git their terminal uses.
        let inherited = pairs(env(&git, None));
        assert!(!inherited.iter().any(|(key, _)| key == "GIT_CONFIG_GLOBAL"));
        assert!(!inherited.iter().any(|(key, _)| key == "GIT_CONFIG_NOSYSTEM"));
        assert!(!inherited.iter().any(|(key, _)| key == "PATH"));
        // Neither of them may prompt: the engine's stdin is its RPC channel.
        for list in [&managed, &inherited] {
            assert!(list
                .iter()
                .any(|(key, value)| key == "GIT_TERMINAL_PROMPT" && value == "0"));
        }
    }

    #[test]
    fn a_repository_of_the_users_keeps_their_config() {
        let root = std::env::temp_dir().join(format!("hook-git-env-{}", uuid::Uuid::new_v4()));
        let repo = root.join("repo");
        std::fs::create_dir_all(repo.join("src")).unwrap();
        assert!(!uses_user_config(false, &repo), "no repository yet");
        std::fs::create_dir_all(repo.join(".git")).unwrap();
        assert!(uses_user_config(false, &repo));
        // Git walks up, so a subfolder of a clone is inside it too.
        assert!(uses_user_config(false, &repo.join("src")));
        // A Hook project keeps the managed file: its remote is the account's.
        assert!(!uses_user_config(true, &repo));
        // A `.git` file is a worktree or a submodule, and still a repository.
        let worktree = root.join("worktree");
        std::fs::create_dir_all(&worktree).unwrap();
        std::fs::write(worktree.join(".git"), "gitdir: ../repo/.git/worktrees/wt").unwrap();
        assert!(uses_user_config(false, &worktree));
        let plain = root.join("plain");
        std::fs::create_dir_all(&plain).unwrap();
        assert!(!uses_user_config(false, &plain));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn config_contains_the_scoped_header() {
        let dir = std::env::temp_dir().join(format!("hook-git-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = write_agent_config(&dir, "https://hookcode.io/", Some("hk_git_secret")).unwrap();
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.contains("[http \"https://hookcode.io/api/git/\"]"));
        assert!(text.contains("extraHeader = Authorization: Bearer hk_git_secret"));
        assert!(text.contains("defaultBranch = main"));
        let _ = std::fs::remove_dir_all(dir);
    }
}
