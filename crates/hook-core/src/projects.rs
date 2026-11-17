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
        let wanted = folder_name(name, id);
        let mut notes = lock(&self.notes);

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
            folder = format!("{wanted} ({suffix})");
            suffix += 1;
        }
        let path = canonical(&root.join(&folder));
        fs::create_dir_all(&path).map_err(|e| format!("Could not create {folder}: {e}"))?;
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
        assert_eq!(again.description, "new notes");
        assert_eq!(store.resolve(&root, "from-other-machine").unwrap(), Path::new(&first.path));
    }

    #[test]
    fn a_name_collision_uses_a_suffixed_folder() {
        let (_base, root, store) = temp_store();
        store.create(&root, "same-name", "local one").unwrap();
        let bound = store
            .bind(&root, "pj_remote2", "same-name", "remote one", 10, 20)
            .unwrap();
        assert!(bound.path.ends_with("same-name (2)"));
        assert_eq!(bound.name, "same-name");
        // Both resolve through their own name; the local one stays first.
        assert!(store.resolve(&root, "same-name").is_ok());
    }
}
