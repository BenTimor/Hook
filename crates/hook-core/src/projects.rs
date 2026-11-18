use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

use serde::{Deserialize, Serialize};

use crate::store::now_ms;

/// A folder inside the configured projects root.
///
/// Directories on disk are the source of truth for what exists here. The id is
/// what makes a project the *same* project on another computer: it names the
/// account's git repository and the sync row, while the local folder (and the
/// projects root itself) may differ per machine.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub name: String,
    pub path: String,
    #[serde(default)]
    pub description: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub is_git: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectNote {
    /// Empty in files written before projects synced; assigned on first list.
    #[serde(default)]
    id: String,
    #[serde(default)]
    name: String,
    path: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    created_at: i64,
    #[serde(default)]
    updated_at: i64,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct NotesFile {
    #[serde(default)]
    projects: Vec<ProjectNote>,
}

pub struct ProjectsStore {
    path: PathBuf,
    notes: Mutex<Vec<ProjectNote>>,
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// Windows rejects these as file names no matter the extension.
const RESERVED: [&str; 22] = [
    "con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8",
    "com9", "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
];

pub fn new_id() -> String {
    format!("pj_{}", uuid::Uuid::new_v4().simple())
}

/// The block Hook maintains in a project's `AGENTS.md`. Everything outside it
/// belongs to the user, and everything inside it is regenerated on every write.
const NOTES_START: &str = "<!-- hook:memory";
const NOTES_END: &str = "<!-- /hook:memory -->";
/// How many notes one project keeps. A long list stops being read.
const MAX_AGENT_NOTES: usize = 40;

fn has_agent_block(text: &str) -> bool {
    text.contains(NOTES_START) && text.contains(NOTES_END)
}

/// Split `AGENTS.md` into what comes before the block, the bullets in it, and
/// what comes after. Without a block the whole file is "before".
fn split_agent_block(text: &str) -> (String, Vec<String>, String) {
    if !has_agent_block(text) {
        return (text.to_string(), Vec::new(), String::new());
    }
    let start = text.find(NOTES_START).unwrap_or(0);
    let line_start = text[..start].rfind('\n').map(|at| at + 1).unwrap_or(0);
    let end_at = text[start..]
        .find(NOTES_END)
        .map(|at| start + at)
        .unwrap_or(text.len());
    let end = end_at + NOTES_END.len();
    let bullets = text[start..end_at]
        .lines()
        .skip(1)
        .map(str::trim)
        .filter_map(|line| line.strip_prefix("- "))
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(str::to_string)
        .collect();
    (
        text[..line_start].to_string(),
        bullets,
        text[end..].trim_start_matches('\n').to_string(),
    )
}

fn render_agent_block(bullets: &[String]) -> String {
    let mut out = String::from(NOTES_START);
    out.push_str(" Hook keeps these for coding agents; edits inside these markers are overwritten -->\n");
    for bullet in bullets {
        out.push_str("- ");
        out.push_str(bullet);
        out.push('\n');
    }
    out.push_str(NOTES_END);
    out.push('\n');
    out
}

pub fn validate_name(raw: &str) -> Result<String, String> {
    let name = raw.trim();
    if name.is_empty() {
        return Err("Project name is empty.".into());
    }
    if name.chars().count() > 64 {
        return Err("Project name is too long (max 64 characters).".into());
    }
    if name == "." || name == ".." {
        return Err("That is not a valid project name.".into());
    }
    if name.ends_with('.') || name.ends_with(' ') {
        return Err("Project names cannot end with a dot or space.".into());
    }
    if name.starts_with('.') {
        return Err("Project names cannot start with a dot.".into());
    }
    if name
        .chars()
        .any(|c| c.is_control() || matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*'))
    {
        return Err("Project names cannot contain < > : \" / \\ | ? *".into());
    }
    if RESERVED.contains(&name.to_ascii_lowercase().as_str()) {
        return Err(format!("\"{name}\" is reserved by Windows."));
    }
    Ok(name.to_string())
}

/// A server-provided name still has to be a legal folder name on this machine.
/// `base (n)`, kept inside the 64-character name the account accepts. Without
/// the clamp a collision that repeats grows "name (2) (2) (2)…" until the
/// project can never sync again.
fn numbered_folder(base: &str, suffix: u32) -> String {
    const LIMIT: usize = 64;
    let tail = format!(" ({suffix})");
    let mut head: String = base.chars().take(LIMIT - tail.chars().count()).collect();
    head = head.trim_end().to_string();
    if head.is_empty() {
        return format!("project{tail}");
    }
    format!("{head}{tail}")
}

fn folder_name(raw: &str, fallback: &str) -> String {
    validate_name(raw).unwrap_or_else(|_| {
        let cleaned: String = raw
            .trim()
            .chars()
            .map(|c| {
                if c.is_control() || matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*')
                {
                    '-'
                } else {
                    c
                }
            })
            .take(48)
            .collect();
        let cleaned = cleaned.trim().trim_end_matches('.').trim();
        if cleaned.is_empty() || cleaned.starts_with('.') {
            fallback.to_string()
        } else {
            cleaned.to_string()
        }
    })
}

fn name_of(path: &Path) -> String {
    path.file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default()
}

fn key_of(path: &Path) -> String {
    path.to_string_lossy().to_string()
}

fn modified_ms(path: &Path) -> i64 {
    fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn canonical(path: &Path) -> PathBuf {
    crate::store::strip_verbatim(path.canonicalize().unwrap_or_else(|_| path.to_path_buf()))
}

impl ProjectsStore {
    pub fn new(app_data_dir: &Path) -> Self {
        let path = app_data_dir.join("projects.json");
        let notes = fs::read_to_string(&path)
            .ok()
            .and_then(|raw| serde_json::from_str::<NotesFile>(&raw).ok())
            .map(|f| f.projects)
            .unwrap_or_default();
        Self {
            path,
            notes: Mutex::new(notes),
        }
    }

    fn save_locked(&self, notes: &[ProjectNote]) -> Result<(), String> {
        let raw = serde_json::to_string_pretty(&NotesFile {
            projects: notes.to_vec(),
        })
        .map_err(|e| e.to_string())?;
        let tmp = self.path.with_extension("json.tmp");
        fs::write(&tmp, raw).map_err(|e| format!("Could not save projects: {e}"))?;
        fs::rename(&tmp, &self.path).map_err(|e| format!("Could not save projects: {e}"))
    }

    fn project_from(note: &ProjectNote) -> Project {
        Project {
            id: note.id.clone(),
            name: if note.name.is_empty() {
                name_of(Path::new(&note.path))
            } else {
                note.name.clone()
            },
            path: note.path.clone(),
            description: note.description.clone(),
            created_at: note.created_at,
            updated_at: note.updated_at,
            is_git: Path::new(&note.path).join(".git").exists(),
        }
    }

    /// Every directory directly under `root`, newest activity first.
    ///
    /// Notes written before sync existed have no id; one is assigned here and
    /// persisted, which is the only migration an existing install needs.
    pub fn list(&self, root: &Path) -> Result<Vec<Project>, String> {
        if !root.is_dir() {
            return Ok(Vec::new());
        }
        let entries = fs::read_dir(root)
            .map_err(|e| format!("Could not read {}: {e}", root.display()))?;
        let mut folders: Vec<(PathBuf, String)> = Vec::new();
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let name = name_of(&path);
            if name.is_empty() || name.starts_with('.') {
                continue;
            }
            folders.push((path, name));
        }

        let mut changed = false;
        let mut out = Vec::with_capacity(folders.len());
        {
            let mut notes = lock(&self.notes);
            let used_ids: HashSet<String> =
                notes.iter().filter(|n| !n.id.is_empty()).map(|n| n.id.clone()).collect();
            let mut seen_ids: HashSet<String> = HashSet::new();

            for (path, folder) in folders {
                let canonical = canonical(&path);
                let key = key_of(&canonical);
                let existing = notes
                    .iter()
                    .position(|n| n.path.eq_ignore_ascii_case(&key));
                let index = match existing {
                    Some(index) => index,
                    None => {
                        // A renamed folder keeps its identity: re-bind the note
                        // whose recorded path no longer exists.
                        let renamed = notes.iter().position(|n| {
                            !n.path.is_empty()
                                && !Path::new(&n.path).exists()
                                && !n.name.is_empty()
                                && n.name.eq_ignore_ascii_case(&folder)
                        });
                        match renamed {
                            Some(index) => {
                                notes[index].path = key.clone();
                                changed = true;
                                index
                            }
                            None => {
                                let fallback = modified_ms(&path);
                                notes.push(ProjectNote {
                                    id: String::new(),
                                    name: folder.clone(),
                                    path: key.clone(),
                                    description: String::new(),
                                    created_at: fallback,
                                    updated_at: fallback,
                                });
                                changed = true;
                                notes.len() - 1
                            }
                        }
                    }
                };
                let note = &mut notes[index];
                if note.id.is_empty() || !seen_ids.insert(note.id.clone()) {
                    let mut id = new_id();
                    while used_ids.contains(&id) || seen_ids.contains(&id) {
                        id = new_id();
                    }
                    seen_ids.insert(id.clone());
                    note.id = id;
                    changed = true;
                }
                if note.name.is_empty() {
                    note.name = folder;
                    changed = true;
                } else if note.name != folder && !suffixed_folder(&folder, &note.name) {
                    // The folder is the user's name for the project unless this
                    // is a "name (2)" folder created by a cross-device collision.
                    note.name = folder;
                    changed = true;
                }
                if note.created_at <= 0 {
                    note.created_at = modified_ms(&path);
                    changed = true;
                }
                if note.updated_at <= 0 {
                    note.updated_at = note.created_at;
                    changed = true;
                }
                out.push(Self::project_from(note));
            }
            if changed {
                self.save_locked(&notes)?;
            }
        }
        out.sort_by(|a, b| {
            b.updated_at
                .cmp(&a.updated_at)
                .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
        });
        Ok(out)
    }

    pub fn create(&self, root: &Path, raw_name: &str, description: &str) -> Result<Project, String> {
        let root = &canonical(root);
        let name = validate_name(raw_name)?;
        let path = root.join(&name);
        if path.exists() {
            return Err(format!("A folder named \"{name}\" already exists."));
        }
        fs::create_dir_all(&path).map_err(|e| format!("Could not create {name}: {e}"))?;
        let canonical = canonical(&path);
        let now = now_ms();
        let key = key_of(&canonical);
        let mut notes = lock(&self.notes);
        let id = new_id();
        notes.retain(|n| !n.path.eq_ignore_ascii_case(&key));
        notes.push(ProjectNote {
            id: id.clone(),
            name: name.clone(),
            path: key.clone(),
            description: description.trim().to_string(),
            created_at: now,
            updated_at: now,
        });
        self.save_locked(&notes)?;
        Ok(Project {
            id,
            name,
            path: key,
            description: description.trim().to_string(),
            created_at: now,
            updated_at: now,
            is_git: false,
        })
    }

    /// Store the agent's running notes about a project.
    pub fn describe(
        &self,
        root: &Path,
        reference: &str,
        description: &str,
    ) -> Result<Project, String> {
        let path = self.resolve(root, reference)?;
        let key = key_of(&path);
        let now = now_ms();
        let text = description.trim().to_string();
        if text.is_empty() {
            return Err("Description is empty.".into());
        }
        let mut notes = lock(&self.notes);
        let index = match notes.iter().position(|n| n.path.eq_ignore_ascii_case(&key)) {
            Some(index) => index,
            None => {
                let id = new_id();
                notes.push(ProjectNote {
                    id,
                    name: name_of(&path),
                    path: key.clone(),
                    description: String::new(),
                    created_at: now,
                    updated_at: now,
                });
                notes.len() - 1
            }
        };
        notes[index].description = text.clone();
        notes[index].updated_at = now;
        let project = Self::project_from(&notes[index]);
        self.save_locked(&notes)?;
        Ok(project)
    }

    /// Point a local project at the id the account already uses for it. The
    /// folder does not move: only the note's identity changes.
    pub fn adopt_id(&self, from: &str, to: &str) -> Result<bool, String> {
        if from.is_empty() || to.is_empty() || from == to {
            return Ok(false);
        }
        let mut notes = lock(&self.notes);
        if notes.iter().any(|note| note.id == to) {
            return Ok(false);
        }
        let Some(note) = notes.iter_mut().find(|note| note.id == from) else {
            return Ok(false);
        };
        note.id = to.to_string();
        note.updated_at = now_ms();
        self.save_locked(&notes)?;
        Ok(true)
    }

    pub fn id_for_path(&self, path: &Path) -> Option<String> {
        let key = key_of(&canonical(path));
        lock(&self.notes)
            .iter()
            .find(|n| n.path.eq_ignore_ascii_case(&key))
            .map(|n| n.id.clone())
    }

    /// Forget every note, used when a different account signs in. The folders
    /// themselves stay; they are the user's files, not Hook's.
    pub fn clear_notes(&self) -> Result<(), String> {
        let mut notes = lock(&self.notes);
        notes.clear();
        self.save_locked(&notes)
    }

    /// Bind a project that arrived from the account to a folder on this
    /// machine. Creates the folder when this is the first time the project is
    /// seen here; an existing folder with the same name is reused only when it
    /// is not already another project.
    pub fn bind(
        &self,
        root: &Path,
        id: &str,
        name: &str,
        description: &str,
        created_at: i64,
        updated_at: i64,
    ) -> Result<Project, String> {
        // A short (8.3) root such as C:/Users/RUNNER~1 would otherwise be
        // stored as the folder's path while resolve() returns the long form.
        let root = &canonical(root);
        let wanted = folder_name(name, id);
        let mut notes = lock(&self.notes);

        // The same folder seen with a different id: the other Hook product on
        // this machine, or a reinstall. The account's id wins and the folder
        // stays where it is. Adding a "(2)" here is what turned one collision
        // into ten renamed copies of the same project.
        let root_key = key_of(root);
        let same_folder = notes.iter().position(|n| {
            n.id != id
                && !n.path.is_empty()
                && Path::new(&n.path)
                    .parent()
                    .map(|parent| parent.to_string_lossy().eq_ignore_ascii_case(&root_key))
                    .unwrap_or(false)
                && Path::new(&n.path)
                    .file_name()
                    .map(|folder| folder.to_string_lossy().eq_ignore_ascii_case(&wanted))
                    .unwrap_or(false)
        });
        if let Some(index) = same_folder {
            let note = &mut notes[index];
            note.id = id.to_string();
            note.name = wanted.clone();
            note.description = description.to_string();
            note.created_at = if created_at > 0 { created_at } else { note.created_at };
            note.updated_at = updated_at.max(note.updated_at);
            if !Path::new(&note.path).is_dir() {
                fs::create_dir_all(&note.path)
                    .map_err(|e| format!("Could not create the project folder: {e}"))?;
            }
            let project = Self::project_from(note);
            self.save_locked(&notes)?;
            return Ok(project);
        }

        if let Some(index) = notes.iter().position(|n| n.id == id) {
            notes[index].name = wanted.clone();
            notes[index].description = description.to_string();
            notes[index].updated_at = updated_at.max(notes[index].updated_at);
            if notes[index].created_at <= 0 {
                notes[index].created_at = created_at;
            }
            if !Path::new(&notes[index].path).is_dir() {
                fs::create_dir_all(&notes[index].path)
                    .map_err(|e| format!("Could not create the project folder: {e}"))?;
            }
            let project = Self::project_from(&notes[index]);
            self.save_locked(&notes)?;
            return Ok(project);
        }

        // Pick a folder: the project's name, or a suffixed variant when that
        // name belongs to a different project on this machine.
        let mut folder = wanted.clone();
        let mut suffix = 2;
        loop {
            let candidate = root.join(&folder);
            let key = key_of(&canonical(&candidate));
            let taken = notes.iter().any(|n| n.path.eq_ignore_ascii_case(&key));
            if !taken && (!candidate.exists() || is_reusable(&candidate)) {
                break;
            }
            if suffix > 50 {
                return Err(format!(
                    "There are too many folders named \"{wanted}\"; rename one of them."
                ));
            }
            folder = numbered_folder(&wanted, suffix);
            suffix += 1;
        }
        let created = root.join(&folder);
        fs::create_dir_all(&created).map_err(|e| format!("Could not create {folder}: {e}"))?;
        // Canonicalize after creating it: before that, canonicalize() falls back
        // to whatever form the root was given in.
        let path = canonical(&created);
        let now = now_ms();
        let note = ProjectNote {
            id: id.to_string(),
            name: wanted,
            path: key_of(&path),
            description: description.to_string(),
            created_at: if created_at > 0 { created_at } else { now },
            updated_at: if updated_at > 0 { updated_at } else { now },
        };
        let project = Self::project_from(&note);
        notes.push(note);
        self.save_locked(&notes)?;
        Ok(project)
    }

    /// Add one line to the notes Hook keeps for coding agents in this project.
    ///
    /// The notes live in the repository itself, in a marked block inside
    /// `AGENTS.md`, because that is the file the coding agent already reads: the
    /// note travels with the code to every computer and reaches `pi` without
    /// anything extra. Only the block is ours — the rest of the file is the
    /// user's and is left alone.
    pub fn append_agent_note(path: &Path, note: &str) -> Result<PathBuf, String> {
        let note = note.split_whitespace().collect::<Vec<_>>().join(" ");
        let note = note.trim_start_matches("- ").to_string();
        if note.chars().count() < 3 {
            return Err("A note needs a few words.".into());
        }
        let file = path.join("AGENTS.md");
        let existing = fs::read_to_string(&file).unwrap_or_default();
        let (before, mut bullets, after) = split_agent_block(&existing);
        // The same rule twice is one rule. Compared case-insensitively because
        // the agent rewrites these in slightly different words.
        if !bullets.iter().any(|bullet| bullet.eq_ignore_ascii_case(&note)) {
            bullets.push(note);
        }
        if bullets.len() > MAX_AGENT_NOTES {
            let drop = bullets.len() - MAX_AGENT_NOTES;
            bullets.drain(..drop);
        }
        let block = render_agent_block(&bullets);
        let text = if has_agent_block(&existing) {
            format!("{before}{block}{after}")
        } else {
            let head = existing.trim_end();
            if head.is_empty() {
                block
            } else {
                format!("{head}

{block}")
            }
        };
        crate::store::write_atomic(&file, text.as_bytes())?;
        Ok(file)
    }

    /// What the block currently says, for the tool result and the UI.
    pub fn agent_notes(path: &Path) -> Vec<String> {
        fs::read_to_string(path.join("AGENTS.md"))
            .map(|text| split_agent_block(&text).1)
            .unwrap_or_default()
    }

    /// Resolve a project by folder name (case-insensitive), account id or
    /// absolute path. The result is always a direct child of `root`.
    pub fn resolve(&self, root: &Path, reference: &str) -> Result<PathBuf, String> {
        let root_canonical = root
            .canonicalize()
            .map_err(|e| format!("Projects folder is unavailable: {e}"))?;
        let raw = reference.trim();
        if raw.is_empty() {
            return Err("No project specified.".into());
        }
        let candidate = {
            let as_path = PathBuf::from(raw);
            if as_path.is_absolute() {
                as_path
            } else {
                root_canonical.join(raw)
            }
        };
        let direct = candidate.canonicalize().ok().map(|p| (candidate.clone(), p));
        // A project synced onto a machine with a name collision lives in
        // "name (2)", but the chat agent still refers to it by its own name.
        let by_note = || {
            let notes = lock(&self.notes);
            let note = notes
                .iter()
                .find(|n| n.id == raw)
                .or_else(|| {
                    notes
                        .iter()
                        .find(|n| !n.name.is_empty() && n.name.eq_ignore_ascii_case(raw))
                })
                .map(|n| PathBuf::from(&n.path))?;
            note.canonicalize().ok()
        };
        let canonical = match direct {
            Some((_, resolved)) => resolved,
            None => by_note().ok_or_else(|| format!("Project \"{raw}\" does not exist."))?,
        };
        if canonical.parent() != Some(root_canonical.as_path()) {
            return Err(format!("\"{raw}\" is not a project in your projects folder."));
        }
        if !canonical.is_dir() {
            return Err(format!("\"{raw}\" is not a folder."));
        }
        Ok(crate::store::strip_verbatim(canonical))
    }
}

/// True for the "name (2)" folders `bind` makes when two projects want the
/// same name on one machine.
fn suffixed_folder(folder: &str, base: &str) -> bool {
    if !folder.starts_with(base) || !folder.ends_with(')') {
        return false;
    }
    let rest = &folder[base.len()..];
    rest.starts_with(" (")
        && rest.len() > 3
        && rest[2..rest.len() - 1]
            .chars()
            .all(|c| c.is_ascii_digit())
}

/// A folder with nothing but a `.git` directory (created by a previous bind or
/// by hand) is safe to adopt. A folder with files is somebody's work.
fn is_reusable(path: &Path) -> bool {
    let entries = match fs::read_dir(path) {
        Ok(entries) => entries,
        Err(_) => return false,
    };
    for entry in entries.flatten() {
        if entry.file_name() != ".git" {
            return false;
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_store() -> (PathBuf, PathBuf, ProjectsStore) {
        let base = std::env::temp_dir().join(format!("hook-projects-{}", uuid::Uuid::new_v4()));
        let root = base.join("projects");
        fs::create_dir_all(&root).unwrap();
        let store = ProjectsStore::new(&base);
        (base, root, store)
    }

    #[test]
    fn rejects_path_traversal_names() {
        assert!(validate_name("../evil").is_err());
        assert!(validate_name("a/b").is_err());
        assert!(validate_name("con").is_err());
        assert!(validate_name(" leading").is_ok());
        assert!(validate_name("fine-name_1").is_ok());
    }

    #[test]
    fn agent_notes_land_in_a_marked_block() {
        let (_base, root, store) = temp_store();
        let project = store.create(&root, "alpha", "a demo project").unwrap();
        let path = PathBuf::from(&project.path);

        let file = ProjectsStore::append_agent_note(&path, "Uses pnpm, not npm.").unwrap();
        assert_eq!(file.file_name().unwrap(), "AGENTS.md");
        let text = fs::read_to_string(&file).unwrap();
        assert!(text.contains(NOTES_START), "{text}");
        assert!(text.contains(NOTES_END), "{text}");
        assert!(text.contains("- Uses pnpm, not npm."), "{text}");

        // The same rule said twice is one rule, in any case.
        ProjectsStore::append_agent_note(&path, "uses pnpm, not npm.").unwrap();
        let text = fs::read_to_string(&file).unwrap();
        assert_eq!(text.matches("pnpm").count(), 1, "{text}");
        assert_eq!(ProjectsStore::agent_notes(&path).len(), 1);
    }

    #[test]
    fn agent_notes_leave_the_users_file_alone() {
        let (_base, root, _store) = temp_store();
        let dir = root.join("site");
        fs::create_dir_all(&dir).unwrap();
        let original = "# Site\n\nAlways run the tests with `npm test`.\n";
        fs::write(dir.join("AGENTS.md"), original).unwrap();

        ProjectsStore::append_agent_note(&dir, "The build needs Node 22.").unwrap();
        let text = fs::read_to_string(dir.join("AGENTS.md")).unwrap();
        assert!(text.starts_with(original.trim_end()), "{text}");
        assert_eq!(text.matches("npm test").count(), 1);
        assert!(text.contains("- The build needs Node 22."));

        // A second note replaces the block, not the file.
        ProjectsStore::append_agent_note(&dir, "Deploys from main.").unwrap();
        let text = fs::read_to_string(dir.join("AGENTS.md")).unwrap();
        assert_eq!(text.matches(NOTES_START).count(), 1, "{text}");
        assert_eq!(text.matches("npm test").count(), 1);
        assert!(text.contains("- The build needs Node 22."));
        assert!(text.contains("- Deploys from main."));
    }

    #[test]
    fn agent_notes_stop_at_the_cap() {
        let (_base, root, _store) = temp_store();
        let dir = root.join("big");
        fs::create_dir_all(&dir).unwrap();
        for i in 0..(MAX_AGENT_NOTES + 5) {
            ProjectsStore::append_agent_note(&dir, &format!("Rule number {i}.")).unwrap();
        }
        let notes = ProjectsStore::agent_notes(&dir);
        assert_eq!(notes.len(), MAX_AGENT_NOTES);
        assert_eq!(notes.last().unwrap(), "Rule number 44.");
        assert!(!notes.iter().any(|note| note == "Rule number 0."));
    }

    #[test]
    fn a_note_that_says_nothing_is_refused() {
        let (_base, root, _store) = temp_store();
        let dir = root.join("empty");
        fs::create_dir_all(&dir).unwrap();
        assert!(ProjectsStore::append_agent_note(&dir, "   ").is_err());
        assert!(!dir.join("AGENTS.md").exists());
    }

    #[test]
    fn creates_lists_and_describes() {
        let (_base, root, store) = temp_store();
        let project = store.create(&root, "alpha", "a demo project").unwrap();
        assert_eq!(project.name, "alpha");
        assert!(project.id.starts_with("pj_"));
        assert!(Path::new(&project.path).is_dir());

        let listed = store.list(&root).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, project.id);
        assert_eq!(listed[0].description, "a demo project");

        store.describe(&root, "alpha", "now with more notes").unwrap();
        let listed = store.list(&root).unwrap();
        assert_eq!(listed[0].description, "now with more notes");
    }

    #[test]
    fn resolve_stays_inside_root() {
        let (base, root, store) = temp_store();
        store.create(&root, "inside", "").unwrap();
        assert!(store.resolve(&root, "inside").is_ok());
        assert!(store.resolve(&root, "../").is_err());
        assert!(store.resolve(&root, base.to_string_lossy().as_ref()).is_err());
        assert!(store.resolve(&root, "missing").is_err());
    }

    #[test]
    fn refuses_duplicate_project() {
        let (_base, root, store) = temp_store();
        store.create(&root, "dup", "").unwrap();
        assert!(store.create(&root, "dup", "").is_err());
    }

    #[test]
    fn resolved_paths_are_not_verbatim() {
        let (_base, root, store) = temp_store();
        let project = store.create(&root, "plain", "").unwrap();
        assert!(!project.path.starts_with(r"\\?\\"), "got {}", project.path);
        let resolved = store.resolve(&root, "plain").unwrap();
        assert!(!resolved.to_string_lossy().starts_with(r"\\?\\"));
    }

    #[test]
    fn descriptions_survive_restart() {
        let (base, root, store) = temp_store();
        store.create(&root, "persist", "notes here").unwrap();
        drop(store);
        let reopened = ProjectsStore::new(&base);
        let listed = reopened.list(&root).unwrap();
        assert_eq!(listed[0].description, "notes here");
        assert!(listed[0].id.starts_with("pj_"));
    }

    #[test]
    fn existing_folders_get_stable_ids() {
        let (base, root, store) = temp_store();
        fs::create_dir_all(root.join("legacy")).unwrap();
        let first = store.list(&root).unwrap();
        let id = first[0].id.clone();
        assert!(id.starts_with("pj_"));
        drop(store);
        let reopened = ProjectsStore::new(&base);
        let second = reopened.list(&root).unwrap();
        assert_eq!(second[0].id, id);
    }

    #[test]
    fn binding_a_project_creates_its_folder_once() {
        let (_base, root, store) = temp_store();
        let first = store
            .bind(&root, "pj_remote1", "from-other-machine", "notes", 10, 20)
            .unwrap();
        assert!(Path::new(&first.path).is_dir());
        let again = store
            .bind(&root, "pj_remote1", "from-other-machine", "new notes", 10, 30)
            .unwrap();
        assert_eq!(first.path, again.path);
        // Stored in the long form even when the root was given as a short
        // (8.3) name: resolve() canonicalizes, so the two must agree.
        assert_eq!(canonical(Path::new(&first.path)), Path::new(&first.path));
        assert_eq!(again.description, "new notes");
        assert_eq!(store.resolve(&root, "from-other-machine").unwrap(), Path::new(&first.path));
    }

    #[test]
    fn two_products_over_one_folder_share_the_projects_id() {
        // Hook and Hook Workspace have separate data directories but the same
        // projects folder. Binding the account's copy must adopt the folder,
        // not create "shared (2)" — the bug that renamed a project ten times.
        let (base, root, first) = temp_store();
        let project = first.create(&root, "shared", "ours").unwrap();
        assert!(project.path.ends_with("shared"));

        let other = base.join("other-product");
        fs::create_dir_all(&other).unwrap();
        let second = ProjectsStore::new(&other);
        let bound = second.bind(&root, "pj_from_account", "shared", "theirs", 1, 2).unwrap();
        assert_eq!(bound.path, project.path);
        assert_eq!(bound.description, "theirs");
        assert!(!root.join("shared (2)").exists());
        assert_eq!(
            second.id_for_path(&root.join("shared")).as_deref(),
            Some("pj_from_account")
        );
    }

    #[test]
    fn a_name_collision_stays_inside_the_accounts_limit() {
        let long = "a".repeat(60);
        let numbered = numbered_folder(&long, 2);
        assert_eq!(numbered.chars().count(), 64);
        assert!(numbered.ends_with(" (2)"));

        // The same folder, created twice: the second gets a suffix that still
        // fits, so it can be pushed instead of being rejected as too long.
        let (_base, root, store) = temp_store();
        fs::create_dir_all(root.join(&long)).unwrap();
        fs::write(root.join(&long).join("notes.txt"), "mine").unwrap();
        let bound = store.bind(&root, "pj_long", &long, "", 1, 1).unwrap();
        let folder = Path::new(&bound.path)
            .file_name()
            .unwrap()
            .to_string_lossy()
            .to_string();
        assert!(folder.chars().count() <= 64, "{folder}");
        assert!(folder.ends_with(" (2)"), "{folder}");
    }

    #[test]
    fn a_name_collision_uses_a_suffixed_folder() {
        // A folder the user filled by hand is not the account's project with
        // the same name, so the incoming copy gets its own folder.
        let (_base, root, store) = temp_store();
        fs::create_dir_all(root.join("same-name")).unwrap();
        fs::write(root.join("same-name").join("notes.txt"), "mine").unwrap();
        let bound = store
            .bind(&root, "pj_remote2", "same-name", "remote one", 10, 20)
            .unwrap();
        assert!(bound.path.ends_with("same-name (2)"), "{}", bound.path);
        assert_eq!(bound.name, "same-name");
        // Both resolve through their own name; the local one stays first.
        assert!(store.resolve(&root, "same-name").is_ok());
    }
}
