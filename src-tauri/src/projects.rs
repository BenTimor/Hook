use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

use serde::{Deserialize, Serialize};

use crate::store::now_ms;

/// A folder inside the configured projects root. Directories on disk are the
/// source of truth; Hook only keeps the notes the chat agent writes about them.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
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

fn name_of(path: &Path) -> String {
    path.file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default()
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

    /// Every directory directly under `root`, newest activity first.
    pub fn list(&self, root: &Path) -> Result<Vec<Project>, String> {
        if !root.is_dir() {
            return Ok(Vec::new());
        }
        let notes = lock(&self.notes).clone();
        let mut out = Vec::new();
        let entries = fs::read_dir(root).map_err(|e| format!("Could not read {}: {e}", root.display()))?;
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let name = name_of(&path);
            if name.is_empty() || name.starts_with('.') {
                continue;
            }
            let canonical = path.canonicalize().unwrap_or_else(|_| path.clone());
            let canonical = crate::store::strip_verbatim(canonical);
            let key = canonical.to_string_lossy().to_string();
            let note = notes.iter().find(|n| n.path.eq_ignore_ascii_case(&key));
            let fallback = fs::metadata(&path)
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as i64)
                .unwrap_or(0);
            out.push(Project {
                name,
                path: key,
                description: note.map(|n| n.description.clone()).unwrap_or_default(),
                created_at: note.map(|n| n.created_at).filter(|v| *v > 0).unwrap_or(fallback),
                updated_at: note
                    .map(|n| n.updated_at)
                    .filter(|v| *v > 0)
                    .unwrap_or(fallback),
                is_git: path.join(".git").exists(),
            });
        }
        out.sort_by(|a, b| {
            b.updated_at
                .cmp(&a.updated_at)
                .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
        });
        Ok(out)
    }

    pub fn create(
        &self,
        root: &Path,
        raw_name: &str,
        description: &str,
    ) -> Result<Project, String> {
        let name = validate_name(raw_name)?;
        let path = root.join(&name);
        if path.exists() {
            return Err(format!("A folder named \"{name}\" already exists."));
        }
        fs::create_dir_all(&path).map_err(|e| format!("Could not create {name}: {e}"))?;
        let canonical = crate::store::strip_verbatim(
            path.canonicalize().map_err(|e| e.to_string())?,
        );
        let now = now_ms();
        let key = canonical.to_string_lossy().to_string();
        {
            let mut notes = lock(&self.notes);
            notes.retain(|n| !n.path.eq_ignore_ascii_case(&key));
            notes.push(ProjectNote {
                path: key.clone(),
                description: description.trim().to_string(),
                created_at: now,
                updated_at: now,
            });
            self.save_locked(&notes)?;
        }
        Ok(Project {
            name,
            path: key,
            description: description.trim().to_string(),
            created_at: now,
            updated_at: now,
            is_git: canonical.join(".git").exists(),
        })
    }

    /// Store the agent's running notes about a project.
    pub fn describe(&self, root: &Path, reference: &str, description: &str) -> Result<Project, String> {
        let path = self.resolve(root, reference)?;
        let key = path.to_string_lossy().to_string();
        let now = now_ms();
        let text = description.trim().to_string();
        if text.is_empty() {
            return Err("Description is empty.".into());
        }
        {
            let mut notes = lock(&self.notes);
            if let Some(note) = notes.iter_mut().find(|n| n.path.eq_ignore_ascii_case(&key)) {
                note.description = text.clone();
                note.updated_at = now;
            } else {
                notes.push(ProjectNote {
                    path: key.clone(),
                    description: text.clone(),
                    created_at: now,
                    updated_at: now,
                });
            }
            self.save_locked(&notes)?;
        }
        Ok(Project {
            name: name_of(&path),
            path: key,
            description: text,
            created_at: now,
            updated_at: now,
            is_git: path.join(".git").exists(),
        })
    }

    /// Resolve a project by folder name (case-insensitive) or absolute path.
    /// The result is always a direct child of `root`.
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
        let canonical = candidate
            .canonicalize()
            .map_err(|_| format!("Project \"{raw}\" does not exist."))?;
        if canonical.parent() != Some(root_canonical.as_path()) {
            return Err(format!("\"{raw}\" is not a project in your projects folder."));
        }
        if !canonical.is_dir() {
            return Err(format!("\"{raw}\" is not a folder."));
        }
        Ok(crate::store::strip_verbatim(canonical))
    }
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
        assert!(Path::new(&project.path).is_dir());

        let listed = store.list(&root).unwrap();
        assert_eq!(listed.len(), 1);
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
    }
}
