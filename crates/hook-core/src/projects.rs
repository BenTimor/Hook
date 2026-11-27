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

/// A project that was removed, kept in the product's trash until it expires.
///
/// The folder moves under `trash/projects/<id>`, so nothing of the user's is
/// destroyed at the moment they ask for it, and [`TRASH_DAYS`] later the copy
/// goes for good. The project's own git repository on the account keeps the
/// code either way, which is why a restore can also rebuild a folder that is no
/// longer here.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TrashNote {
    id: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    path: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    created_at: i64,
    #[serde(default)]
    updated_at: i64,
    #[serde(default)]
    deleted_at: i64,
}

#[derive(Debug, Serialize)]
struct TrashFile<'a> {
    projects: &'a [TrashNote],
}

#[derive(Debug, Default, Deserialize)]
struct TrashFileRead {
    #[serde(default)]
    projects: Vec<TrashNote>,
}

/// What the Settings sheet and an agent show for a removed project.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrashedProject {
    pub id: String,
    pub name: String,
    pub description: String,
    pub path: String,
    pub deleted_at: i64,
    /// When the copy in the trash is removed for good.
    pub expires_at: i64,
    /// True while the folder itself is here. False means only the project's git
    /// history on the account is left to restore from, which still works.
    pub has_folder: bool,
}

/// What a restore brought back.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoredProject {
    pub project: Project,
    /// True when the folder came back from the trash; false when it was already
    /// gone and the project returns as an empty folder for the sync engine to
    /// fill from the account's git copy.
    pub from_trash: bool,
}

pub struct ProjectsStore {
    path: PathBuf,
    notes: Mutex<Vec<ProjectNote>>,
    /// Notes whose folder disappeared, taken by the sync engine so the account
    /// hears about the deletion. Without that tombstone the next pull would
    /// create the folder again.
    dropped: Mutex<Vec<Project>>,
    /// `trash/projects/<id>` holds a removed project's folder, and
    /// `trash/projects.json` the list of what is recoverable.
    trash: PathBuf,
    trash_index: PathBuf,
    /// When the trash was last swept, so a listing does not sweep every time.
    swept: Mutex<i64>,
}

/// How long a removed project stays recoverable. Long enough to notice a
/// mistake, short enough that the disk is not held forever; the project's git
/// repository on the account outlives the copy either way.
pub const TRASH_DAYS: i64 = 7;
const TRASH_MS: i64 = TRASH_DAYS * 24 * 60 * 60 * 1000;
/// A sweep looks at the trash at most this often, however many listings happen.
const SWEEP_EVERY_MS: i64 = 60 * 60 * 1000;

/// How many dropped notes are remembered for the sync engine. A bulk delete is
/// one listing; anything larger means the projects folder itself went away and
/// is not a deletion to upload at all.
const MAX_DROPPED: usize = 500;

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
        // The chat trash lives in the same folder (`trash/<chat id>.json`), so
        // removed project folders get a subfolder of their own.
        let trash = app_data_dir.join("trash");
        Self {
            path,
            notes: Mutex::new(notes),
            dropped: Mutex::new(Vec::new()),
            trash_index: trash.join("projects.json"),
            trash: trash.join("projects"),
            swept: Mutex::new(0),
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
        // A listing is the one thing that happens on every sync cycle, so it is
        // also where the trash notices that a copy has outlived its week.
        self.sweep(now_ms());
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
            // A folder removed outside Hook (Explorer, a `git clean`, a project
            // moved away) is a project that no longer exists, so its note goes
            // too. Keeping the note would leave the account's row alive forever
            // and let the next pull create the folder again — a project that
            // cannot be deleted. Notes for another projects folder are left
            // alone: switching the folder is not a deletion.
            let root_key = key_of(&canonical(root));
            let mut gone: Vec<Project> = Vec::new();
            notes.retain(|note| {
                let inside = Path::new(&note.path)
                    .parent()
                    .map(|parent| parent.to_string_lossy().eq_ignore_ascii_case(&root_key))
                    .unwrap_or(false);
                if !inside || Path::new(&note.path).is_dir() {
                    return true;
                }
                // A note without an id was never on the account, so there is no
                // row to remove for it.
                if !note.id.is_empty() {
                    gone.push(Self::project_from(note));
                }
                changed = true;
                false
            });
            if changed {
                self.save_locked(&notes)?;
            }
            if !gone.is_empty() {
                // The folder is gone, but the work may still be in the project's
                // git history on the account: an entry with nothing to move lets
                // `restore` rebuild the folder and pull the commits into it.
                let now = now_ms();
                let mut trash = self.trash_notes();
                for project in &gone {
                    trash.retain(|entry| entry.id != project.id);
                    trash.push(TrashNote {
                        id: project.id.clone(),
                        name: project.name.clone(),
                        path: project.path.clone(),
                        description: project.description.clone(),
                        created_at: project.created_at,
                        updated_at: project.updated_at,
                        deleted_at: now,
                    });
                }
                let _ = self.save_trash(&trash);
                let mut queue = lock(&self.dropped);
                queue.extend(gone);
                if queue.len() > MAX_DROPPED {
                    let excess = queue.len() - MAX_DROPPED;
                    queue.drain(..excess);
                }
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

    /// Remove the project the user or an agent knows by `reference`: a folder
    /// name, an account id or an absolute path, resolved the way [`resolve`]
    /// resolves it. This is what a tool or a controller deletes one by; the
    /// folder moves into the trash, so the rules in [`delete`] are the ones that
    /// say what a delete means.
    ///
    /// [`resolve`]: Self::resolve
    /// [`delete`]: Self::delete
    pub fn delete_reference(&self, root: &Path, reference: &str) -> Result<Project, String> {
        let path = self.resolve(root, reference)?;
        let id = self
            .id_for_path(&path)
            .filter(|id| !id.is_empty())
            .ok_or_else(|| format!("\"{reference}\" is not one of your projects."))?;
        self.delete(&id)
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
        lock(&self.dropped).clear();
        self.save_locked(&notes)
    }

    /// The notes `list` dropped because their folders are gone. Taken once, so
    /// the sync engine can send a tombstone for each.
    pub fn take_dropped(&self) -> Vec<Project> {
        std::mem::take(&mut *lock(&self.dropped))
    }

    /// Remove a project from this computer, keeping it recoverable for
    /// [`TRASH_DAYS`].
    ///
    /// The folder moves into this product's trash — nothing of the user's is
    /// destroyed when they ask — and the note goes, so the project leaves Hook
    /// and, through the tombstone the caller queues, the account. [`restore`]
    /// brings it back while the copy is there, and rebuilds it from the
    /// project's git history on the account when it is not.
    ///
    /// [`restore`]: Self::restore
    pub fn delete(&self, id: &str) -> Result<Project, String> {
        if id.is_empty() {
            return Err("No project specified.".into());
        }
        let note = {
            let notes = lock(&self.notes);
            notes.iter().find(|note| note.id == id).cloned()
        };
        let Some(note) = note else {
            return Err("That project is not on this computer.".into());
        };
        let project = Self::project_from(&note);
        let path = PathBuf::from(&note.path);
        // The folder first: a failed move then leaves the note (and the
        // project) exactly as it was, instead of orphaning a folder that the
        // next listing would bring back as a new project.
        if path.is_dir() {
            let into = self.trash.join(&project.id);
            if into.exists() {
                fs::remove_dir_all(&into).map_err(|e| {
                    format!("Could not clear an older copy of {}: {e}", project.name)
                })?;
            }
            move_dir(&path, &into)
                .map_err(|e| format!("Could not move {} to the trash: {e}", project.name))?;
            let mut trash = self.trash_notes();
            trash.retain(|entry| entry.id != project.id);
            trash.push(TrashNote {
                id: project.id.clone(),
                name: project.name.clone(),
                path: note.path.clone(),
                description: project.description.clone(),
                created_at: project.created_at,
                updated_at: project.updated_at,
                deleted_at: now_ms(),
            });
            // A trash nobody can list is worse than no trash: put the folder
            // back where it was rather than leave it unlisted.
            if let Err(error) = self.save_trash(&trash) {
                let _ = move_dir(&into, &path);
                return Err(error);
            }
        }
        {
            let mut notes = lock(&self.notes);
            notes.retain(|note| note.id != id);
            self.save_locked(&notes)?;
        }
        Ok(project)
    }

    /// The projects removed in the last [`TRASH_DAYS`], newest first. Expired
    /// copies are deleted on the way past, which is the whole of the retainer.
    pub fn trashed(&self) -> Vec<TrashedProject> {
        let now = now_ms();
        let mut notes = self.notes_in_trash(now);
        if self.expire(&mut notes, now) {
            let _ = self.save_trash(&notes);
        }
        let mut out: Vec<TrashedProject> = notes
            .iter()
            .map(|note| TrashedProject {
                id: note.id.clone(),
                name: if note.name.is_empty() {
                    name_of(Path::new(&note.path))
                } else {
                    note.name.clone()
                },
                description: note.description.clone(),
                path: note.path.clone(),
                deleted_at: note.deleted_at,
                expires_at: note.deleted_at.saturating_add(TRASH_MS),
                has_folder: self.trash.join(&note.id).is_dir(),
            })
            .collect();
        out.sort_by(|a, b| {
            b.deleted_at
                .cmp(&a.deleted_at)
                .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
        });
        out
    }

    /// Bring a removed project back: by account id, or by the name it had.
    ///
    /// A folder still in the trash goes back to the path it came from (or a
    /// free name under `root`, if the projects folder has moved since). After
    /// the copy is gone the project returns as an empty folder instead, and the
    /// sync engine pulls the code back from the account's git repository — the
    /// repository outlives the account row, so a delete is never a loss of the
    /// pushed history.
    pub fn restore(&self, root: &Path, reference: &str) -> Result<RestoredProject, String> {
        let raw = reference.trim();
        if raw.is_empty() {
            return Err("Name the project to restore.".into());
        }
        let now = now_ms();
        let mut notes = self.notes_in_trash(now);
        let found = notes
            .iter()
            .position(|entry| entry.id == raw || entry.name.eq_ignore_ascii_case(raw));
        let Some(index) = found else {
            return Err(format!(
                "\"{raw}\" is not in the trash. A removed project is kept for {TRASH_DAYS} days."
            ));
        };
        if now.saturating_sub(notes[index].deleted_at) >= TRASH_MS {
            self.expire(&mut notes, now);
            let _ = self.save_trash(&notes);
            return Err(format!(
                "\"{raw}\" was removed more than {TRASH_DAYS} days ago, so its copy is gone."
            ));
        }
        let entry = notes.remove(index);
        if lock(&self.notes).iter().any(|note| note.id == entry.id) {
            let _ = self.save_trash(&notes);
            return Err(format!(
                "\"{}\" is already one of your projects.",
                if entry.name.is_empty() { entry.id.as_str() } else { entry.name.as_str() }
            ));
        }
        let name = if entry.name.is_empty() {
            name_of(Path::new(&entry.path))
        } else {
            entry.name.clone()
        };
        let root = &canonical(root);
        let root_key = key_of(root);
        let came_from = PathBuf::from(&entry.path);
        let inside = came_from
            .parent()
            .map(|parent| parent.to_string_lossy().eq_ignore_ascii_case(&root_key))
            .unwrap_or(false);
        let mut target = if inside {
            came_from
        } else {
            // The projects folder moved while this was in the trash: put the
            // project back under the name it has, not at yesterday's path.
            root.join(folder_name(&name, &entry.id))
        };
        if target.exists() {
            let base = target
                .file_name()
                .map(|value| value.to_string_lossy().to_string())
                .unwrap_or_else(|| name.clone());
            let mut suffix = 2;
            loop {
                if suffix > 50 {
                    return Err(format!(
                        "There are too many folders named \"{base}\"; rename one of them."
                    ));
                }
                let next = root.join(numbered_folder(&base, suffix));
                if !next.exists() {
                    target = next;
                    break;
                }
                suffix += 1;
            }
        }
        let folder = self.trash.join(&entry.id);
        let from_trash = folder.is_dir();
        if from_trash {
            move_dir(&folder, &target)
                .map_err(|e| format!("Could not put {name} back: {e}"))?;
        } else {
            // Nothing local to move: leave an empty folder for the sync engine,
            // which pulls the project's commits into it.
            fs::create_dir_all(&target)
                .map_err(|e| format!("Could not create {name}: {e}"))?;
        }
        let path = canonical(&target);
        let key = key_of(&path);
        let restored = ProjectNote {
            id: entry.id,
            name,
            path: key,
            description: entry.description,
            created_at: if entry.created_at > 0 { entry.created_at } else { now },
            updated_at: now,
        };
        let project = Self::project_from(&restored);
        {
            let mut live = lock(&self.notes);
            live.retain(|note| !note.path.eq_ignore_ascii_case(&project.path));
            live.push(restored);
            self.save_locked(&live)?;
        }
        self.save_trash(&notes)?;
        Ok(RestoredProject { project, from_trash })
    }

    /// What the trash holds, with the expired copies already gone.
    fn notes_in_trash(&self, now: i64) -> Vec<TrashNote> {
        self.sweep(now);
        let mut notes = self.trash_notes();
        if self.expire(&mut notes, now) {
            let _ = self.save_trash(&notes);
        }
        notes
    }

    fn trash_notes(&self) -> Vec<TrashNote> {
        fs::read_to_string(&self.trash_index)
            .ok()
            .and_then(|raw| serde_json::from_str::<TrashFileRead>(&raw).ok())
            .map(|file| file.projects)
            .unwrap_or_default()
    }

    fn save_trash(&self, notes: &[TrashNote]) -> Result<(), String> {
        let raw = serde_json::to_string_pretty(&TrashFile { projects: notes })
            .map_err(|e| e.to_string())?;
        if let Some(parent) = self.trash_index.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("Could not create the trash: {e}"))?;
        }
        let tmp = self.trash_index.with_extension("json.tmp");
        fs::write(&tmp, raw).map_err(|e| format!("Could not save the trash: {e}"))?;
        fs::rename(&tmp, &self.trash_index)
            .map_err(|e| format!("Could not save the trash: {e}"))
    }

    /// Drop the entries that are past [`TRASH_DAYS`], with their folders.
    /// Answers true when something went, so the caller writes the index back.
    fn expire(&self, notes: &mut Vec<TrashNote>, now: i64) -> bool {
        let before = notes.len();
        notes.retain(|note| {
            if now.saturating_sub(note.deleted_at) < TRASH_MS {
                return true;
            }
            let _ = fs::remove_dir_all(self.trash.join(&note.id));
            false
        });
        notes.len() != before
    }

    /// Sweep at most once an hour: `list` runs on every sync cycle.
    fn sweep(&self, now: i64) {
        {
            let mut last = lock(&self.swept);
            if now.saturating_sub(*last) < SWEEP_EVERY_MS {
                return;
            }
            *last = now;
        }
        let mut notes = self.trash_notes();
        if self.expire(&mut notes, now) {
            let _ = self.save_trash(&notes);
        }
    }

    /// Forget a project whose folder is already gone, because the account says
    /// it was deleted on another computer. A folder that is still here is the
    /// user's copy: its note stays, and the next push puts the project back on
    /// the account instead of deleting somebody's work by proxy.
    pub fn forget_missing(&self, id: &str) -> bool {
        let mut notes = lock(&self.notes);
        let before = notes.len();
        notes.retain(|note| note.id != id || Path::new(&note.path).is_dir());
        if notes.len() == before {
            return false;
        }
        let _ = self.save_locked(&notes);
        true
    }

    /// Bind a project that arrived from the account to a folder on this
    /// machine. Creates the folder when this is the first time the project is
    /// seen here; a folder at the project's own name is reused whenever no
    /// note of this product claims it, because the account's names are unique.
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

        // The folder the project already has on this machine, or a suffixed
        // variant when that name belongs to a different project.
        //
        // A folder sitting at the project's own name that no note here claims
        // *is* this project's copy: each product keeps its own notes, so the
        // other window made it, and the account's names are unique, so it
        // cannot be a different project of the same name. Adopting it is what
        // keeps one project in one folder — suffixing it is what turned one
        // collision into ten renamed copies: the other product listed "name
        // (2)" as a project of its own, pushed it as a new one, and both sides
        // then made "name (3)" from that. A folder with work in it is still
        // the user's, so it is adopted, never emptied or moved.
        let mut folder = wanted.clone();
        let mut suffix = 2;
        loop {
            let candidate = root.join(&folder);
            let key = key_of(&canonical(&candidate));
            let taken = notes.iter().any(|n| n.path.eq_ignore_ascii_case(&key));
            if !taken && (folder == wanted || !candidate.exists() || is_reusable(&candidate)) {
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

/// A folder with nothing but a `.git` directory (an empty clone from a previous
/// bind, or one made by hand) is safe to reuse under a *suffixed* name —
/// `name (2)` and its kind. A folder with files in it is somebody's work, so the
/// folder at a project's own name is adopted instead of a copy being placed
/// beside it (see `bind`).
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

/// Move a folder, falling back to a copy when the two paths are on different
/// volumes — the projects folder can live on `D:` while the trash is on `C:`.
fn move_dir(from: &Path, to: &Path) -> Result<(), String> {
    if let Some(parent) = to.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Could not create {}: {e}", parent.display()))?;
    }
    if fs::rename(from, to).is_ok() {
        return Ok(());
    }
    copy_dir_all(from, to).map_err(|e| {
        format!(
            "Could not copy {} to {}: {e}",
            from.display(),
            to.display()
        )
    })?;
    fs::remove_dir_all(from)
        .map_err(|e| format!("Could not remove {}: {e}", from.display()))
}

fn copy_dir_all(from: &Path, to: &Path) -> std::io::Result<()> {
    fs::create_dir_all(to)?;
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        let path = entry.path();
        let target = to.join(entry.file_name());
        if path.is_dir() {
            copy_dir_all(&path, &target)?;
        } else if path.is_file() {
            fs::copy(&path, &target)?;
        }
    }
    Ok(())
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
    fn a_folder_removed_outside_hook_is_dropped_for_the_sync_engine() {
        // Deleting the folder in Explorer is how a project is deleted. The note
        // has to go with it: kept, the account's row survives forever and the
        // next pull creates the folder again, so the project cannot be removed.
        let (base, root, store) = temp_store();
        let project = store.create(&root, "gone", "notes").unwrap();
        fs::remove_dir_all(root.join("gone")).unwrap();

        assert!(store.list(&root).unwrap().is_empty());
        assert_eq!(
            store
                .take_dropped()
                .iter()
                .map(|project| project.id.as_str())
                .collect::<Vec<_>>(),
            [project.id.as_str()]
        );
        // The folder is gone, but the week still runs: the project can come
        // back, as a folder the repository fills in.
        let trashed = store.trashed();
        assert_eq!(trashed.len(), 1);
        assert!(!trashed[0].has_folder);
        let restored = store.restore(&root, "gone").unwrap();
        assert!(!restored.from_trash);
        assert_eq!(restored.project.id, project.id);
        assert_eq!(restored.project.description, "notes");

        // Taken once, and the note really is gone: a restart must not turn the
        // folder into a new project.
        assert!(store.take_dropped().is_empty());
        drop(store);
        let reopened = ProjectsStore::new(&base);
        assert_eq!(reopened.list(&root).unwrap().len(), 1);
    }

    #[test]
    fn switching_the_projects_folder_is_not_a_deletion() {
        // Notes for another root are not this root's projects, and dropping them
        // would tombstone every project on the account when the folder moves.
        let (base, root, store) = temp_store();
        store.create(&root, "kept", "").unwrap();
        let other = base.join("elsewhere");
        fs::create_dir_all(&other).unwrap();

        assert!(store.list(&other).unwrap().is_empty());
        assert!(store.take_dropped().is_empty());
        assert_eq!(store.list(&root).unwrap().len(), 1);
    }

    #[test]
    fn deleting_an_empty_clone_removes_its_folder() {
        // The folder Hook makes for a project from another computer is an empty
        // clone on disk; that one is Hook's to remove.
        let (_base, root, store) = temp_store();
        let bound = store.bind(&root, "pj_clone", "clone", "", 1, 2).unwrap();
        fs::create_dir_all(Path::new(&bound.path).join(".git")).unwrap();

        let removed = store.delete("pj_clone").unwrap();
        assert_eq!(removed.id, bound.id);
        assert!(!Path::new(&bound.path).exists());
        assert!(store.list(&root).unwrap().is_empty());
    }

    #[test]
    fn deleting_a_folder_with_work_keeps_it_in_the_trash() {
        // Nothing of the user's is destroyed on the spot: the folder moves into
        // the trash, listed with the day it goes for good.
        let (_base, root, store) = temp_store();
        let project = store.create(&root, "real", "notes").unwrap();
        fs::write(Path::new(&project.path).join("index.html"), "<h1>hi</h1>").unwrap();

        let removed = store.delete(&project.id).unwrap();
        assert_eq!(removed.id, project.id);
        assert!(!Path::new(&project.path).exists());
        assert!(store.list(&root).unwrap().is_empty());

        let trash = store.trashed();
        assert_eq!(trash.len(), 1);
        assert_eq!(trash[0].name, "real");
        assert!(trash[0].has_folder);
        assert_eq!(
            trash[0].expires_at - trash[0].deleted_at,
            TRASH_DAYS * 24 * 60 * 60 * 1000
        );

        // And it comes back with the file the user left in it.
        let restored = store.restore(&root, "real").unwrap();
        assert!(restored.from_trash);
        assert_eq!(restored.project.id, project.id);
        assert!(
            Path::new(&restored.project.path).join("index.html").exists(),
            "the file came back"
        );
        assert!(store.trashed().is_empty());
        assert_eq!(store.list(&root).unwrap().len(), 1);
    }

    #[test]
    fn a_trashed_project_expires_after_a_week() {
        let (base, root, store) = temp_store();
        let project = store.create(&root, "old", "").unwrap();
        fs::write(Path::new(&project.path).join("notes.txt"), "mine").unwrap();
        store.delete(&project.id).unwrap();

        // Backdate the entry: the folder and its entry are both gone once the
        // week is up, and a restore says so instead of bringing back half.
        let index = base.join("trash").join("projects.json");
        let mut file: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&index).unwrap()).unwrap();
        file["projects"][0]["deletedAt"] =
            serde_json::json!(now_ms() - (TRASH_DAYS + 1) * 24 * 60 * 60 * 1000);
        fs::write(&index, file.to_string()).unwrap();

        assert!(store.trashed().is_empty());
        assert!(!base.join("trash").join("projects").join(&project.id).exists());
        assert!(store.restore(&root, "old").is_err());
    }

    #[test]
    fn a_restore_after_the_copy_is_gone_leaves_the_folder_for_git() {
        // The trash copy is discarded (or was never made): the project still
        // comes back, as an empty folder the sync engine fills from the
        // account's repository.
        let (base, root, store) = temp_store();
        let project = store.create(&root, "from-git", "what it was").unwrap();
        store.delete(&project.id).unwrap();
        fs::remove_dir_all(base.join("trash").join("projects").join(&project.id)).unwrap();

        let trashed = store.trashed();
        assert_eq!(trashed.len(), 1);
        assert!(!trashed[0].has_folder);

        let restored = store.restore(&root, &project.id).unwrap();
        assert!(!restored.from_trash);
        assert_eq!(restored.project.description, "what it was");
        assert!(Path::new(&restored.project.path).is_dir());
        assert!(store.list(&root).unwrap().iter().any(|p| p.id == project.id));
    }

    #[test]
    fn a_delete_on_another_computer_keeps_a_folder_that_is_still_here() {
        // The account says the project went away elsewhere. This machine still
        // has the folder, so the files stay and the project returns on the next
        // push; only a note whose folder is gone is forgotten.
        let (_base, root, store) = temp_store();
        let here = store.create(&root, "here", "").unwrap();
        let gone = store.create(&root, "gone", "").unwrap();
        fs::remove_dir_all(root.join("gone")).unwrap();

        assert!(!store.forget_missing(&here.id));
        assert!(store.forget_missing(&gone.id));
        assert!(store.list(&root).unwrap().iter().any(|p| p.id == here.id));
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
        // The suffix never grows past the account's limit, whatever the base.
        let number: String = std::iter::repeat_n('2', 60).collect();
        let numbered = numbered_folder(&format!("{long} ({number})"), 3);
        assert!(numbered.chars().count() <= 64, "{numbered}");
        assert!(numbered.ends_with(" (3)"), "{numbered}");
    }

    #[test]
    fn a_folder_the_other_product_filled_is_the_projects_folder() {
        // The reported bug: Hook and Hook Workspace share one projects folder
        // but keep their own notes, so the second product saw the folder with
        // work in it and made "name (2)" beside it. It then listed that new
        // folder as a project of its own, pushed it as a new one, and both
        // sides made "name (3)" from that — ten levels, until a name was too
        // long for the account and sync failed for good.
        let (base, root, chat) = temp_store();
        let project = chat.create(&root, "site", "ours").unwrap();
        fs::write(root.join("site").join("index.html"), "<h1>mine</h1>").unwrap();

        let workspace_dir = base.join("workspace");
        fs::create_dir_all(&workspace_dir).unwrap();
        let workspace = ProjectsStore::new(&workspace_dir);
        let bound = workspace
            .bind(&root, &project.id, "site", "ours", 1, 2)
            .unwrap();
        assert_eq!(bound.path, project.path);
        assert!(!root.join("site (2)").exists());

        // Each product lists the one project, and the one folder is the work.
        assert_eq!(chat.list(&root).unwrap().len(), 1);
        let listed = workspace.list(&root).unwrap();
        assert_eq!(listed.len(), 1, "{listed:?}");
        assert!(Path::new(&listed[0].path).join("index.html").exists());
    }

    #[test]
    fn a_folder_with_work_is_not_suffixed_for_the_same_project() {
        // A folder the user filled by hand, that no note here claims, is at the
        // project's own name — and the account cannot have a second project by
        // that name. Adopting it keeps the work where it is and gives the
        // project one folder; making "same-name (2)" gave the same project two
        // folders and made the second one a project of its own.
        let (_base, root, store) = temp_store();
        fs::create_dir_all(root.join("same-name")).unwrap();
        fs::write(root.join("same-name").join("notes.txt"), "mine").unwrap();
        let bound = store
            .bind(&root, "pj_remote2", "same-name", "remote one", 10, 20)
            .unwrap();
        assert!(bound.path.ends_with("same-name"), "{}", bound.path);
        assert_eq!(bound.name, "same-name");
        assert!(!root.join("same-name (2)").exists());
        // The note is the account's, and the user's file is untouched.
        assert_eq!(
            store.id_for_path(Path::new(&bound.path)).as_deref(),
            Some("pj_remote2")
        );
        assert!(root.join("same-name").join("notes.txt").exists());
        assert_eq!(store.list(&root).unwrap().len(), 1);
    }

    #[test]
    fn a_project_is_deleted_by_the_name_a_tool_knows_it_by() {
        let (_base, root, store) = temp_store();
        let bound = store.bind(&root, "pj_dup", "dupe (2)", "", 1, 2).unwrap();
        let removed = store.delete_reference(&root, "dupe (2)").unwrap();
        assert_eq!(removed.id, bound.id);
        assert!(!Path::new(&bound.path).exists());
        assert!(store.list(&root).unwrap().is_empty());
        assert!(store.delete_reference(&root, "dupe (2)").is_err());
    }
}
