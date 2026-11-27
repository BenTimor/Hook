use serde_json::{json, Value};

use crate::agent::AgentManager;
use crate::config::HarnessConfig;
use crate::projects::ProjectsStore;
use crate::settings::SettingsStore;
use crate::store::{Chat, truncate};

/// The tools that only make sense for the chat agent, because they launch and
/// manage coding agents. A coding agent talking to the user directly has no
/// subagents, so it must not be offered them either (see
/// [`direct_bridge_definitions`]).
pub const AGENT_TOOLS: [&str; 8] = [
    "list_machines",
    "start_coding_agent",
    "list_agents",
    "agent_status",
    "steer_agent",
    "answer_agent",
    "stop_agent",
    "list_coding_sessions",
];

/// Tools that may have to travel to another machine. They are the only ones
/// the async dispatcher intercepts; everything else stays a local call.
pub const MACHINE_TOOLS: [&str; 10] = [
    "list_machines",
    "list_projects",
    "create_project",
    "start_coding_agent",
    "list_agents",
    "agent_status",
    "steer_agent",
    "answer_agent",
    "stop_agent",
    "list_coding_sessions",
];

/// The tools that reach a browser: a tab's address and title, its text, the
/// words inside it — and then everything the DevTools protocol can do to it.
/// A machine operation like the agent tools, and dispatched the same way: the
/// machine named in the call is the machine with the browser, and `this
/// computer` is only the right answer on the browser's own host.
///
/// `run_js` and `browser_cdp` are the two that are not a fixed vocabulary: the
/// first runs a script with [`crate::browser::AGENT_RUNTIME`] installed, the
/// second sends one raw protocol command. Everything a page can do is behind
/// one of them, which is why a new capability does not need a new tool here.
pub const BROWSER_TOOLS: [&str; 9] = [
    "list_tabs",
    "read_page",
    "find_in_page",
    "open_tab",
    "switch_tab",
    "close_tab",
    "navigate",
    "run_js",
    "browser_cdp",
];

/// The tools that reach a *folder on this computer*. A phone has no projects
/// directory — the folders live on the desktops signed into the account — so
/// these are removed together with the prompt section that explains them.
/// `remember_in_project` is here rather than in the memory set because what it
/// writes is a line in the project's own `AGENTS.md`; `look_at_picture` opens a
/// file, which is the same kind of thing.
pub const PROJECT_TOOLS: [&str; 4] = [
    "list_projects",
    "update_project_description",
    "remember_in_project",
    "look_at_picture",
];

/// The tools that make a picture or put one into the conversation. They need an
/// endpoint to ask (`[image]` in `harness.config.toml`); `attach_image` also
/// needs a folder on this machine to read the picture from, which a phone has
/// none of.
pub const IMAGE_TOOLS: [&str; 2] = ["generate_image", "attach_image"];

/// Tool surface offered to the chat model. The chat agent never touches files
/// directly: it organises projects and delegates all code work to a coding
/// agent, then reports back in prose.
pub fn definitions() -> Value {
    json!([
        {
            "type": "function",
            "function": {
                "name": "set_title",
                "description": "Name this conversation, or rename it. In your first reply, call it before anything else: the title is how the user finds the conversation in their list, and it is never written from their message. After that, call it again only when the user asks for a different name. Three to six words saying what the conversation is for, in the language the user writes in, with no quotes and no full stop.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "title": { "type": "string", "description": "A name for the conversation, e.g. 'Fixing the invoice totals'." }
                    },
                    "required": ["title"],
                    "additionalProperties": false
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "list_projects",
                "description": "List every project on the user's account with its description and whether it is a git repo. On a phone, name the machine whose projects you want; on a desktop you may omit it. Call this before deciding where a task belongs.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "machine": { "type": "string", "description": "The exact machine name from list_machines. Required on a phone; omit on a desktop to use this computer." }
                    },
                    "additionalProperties": false
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "create_project",
                "description": "Create a new, empty project folder on one of the user's machines and give it a description. Only use this when the work needs a brand new home. Name the machine, even on a desktop; call list_machines first.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "name": { "type": "string", "description": "Folder name, e.g. 'invoice-parser'. Letters, digits, spaces, dots, dashes and underscores." },
                        "description": { "type": "string", "description": "One or two sentences: what this project is and what belongs in it." },
                        "machine": { "type": "string", "description": "The exact machine name from list_machines. Use 'this computer' on the desktop that will hold the folder." }
                    },
                    "required": ["name", "description", "machine"],
                    "additionalProperties": false
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "update_project_description",
                "description": "Rewrite a project's description so you can find it again later. Keep it short and factual: what the project is, its stack, and what is worth knowing.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "project": { "type": "string", "description": "Project folder name." },
                        "description": { "type": "string", "description": "The new description, one or two sentences." }
                    },
                    "required": ["project", "description"],
                    "additionalProperties": false
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "remember_in_project",
                "description": "Write one short note into the project's AGENTS.md, the file every coding agent in that folder reads. Use it when the user tells you something that should shape all future work in that repository: the package manager, how the tests are run, a rule that keeps being broken, a deploy detail. Only from what the user said - never a guess about the codebase, and never a secret. The note stays in a marked block Hook owns; the rest of the file is untouched.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "project": { "type": "string", "description": "Project folder name." },
                        "note": { "type": "string", "description": "One short line, imperative, e.g. 'Use pnpm, not npm.' or 'Run the tests with pnpm test before committing.'" }
                    },
                    "required": ["project", "note"],
                    "additionalProperties": false
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "list_machines",
                "description": "Which of the user's computers are running Hook right now and which can run coding agents. Call this before choosing a machine when the conversation does not already name one. Every agent tool takes the exact machine name from this list, even when there is only one.",
                "parameters": { "type": "object", "properties": {}, "additionalProperties": false }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "start_coding_agent",
                "description": "Launch a coding agent on one of the user's computers, only for work the user asked for in their own message. `machine` is the exact name from list_machines; 'this computer' is allowed on Hook. The agent runs pi with full permissions inside a project folder on that machine and can read, edit and run code. It pulls the latest version from the user's account before it starts (the folder may be empty because the work began on another computer) and saves its work when it finishes. Write a complete brief: what to achieve, constraints, and how to verify. Also pass a short plan in plain, non-technical language - that checklist is shown to the user while the agent works. When the work has something to look at, tell the agent to build and keep an HTML preview page current and to call its show_preview tool early (see the preview panel instructions). Returns immediately - you are notified when it settles or asks a question. Never start work just because a coding-agent update arrived.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "machine": { "type": "string", "description": "The exact machine name from list_machines, or 'this computer'." },
                        "project": { "type": "string", "description": "Project folder name on that machine." },
                        "task": { "type": "string", "description": "Self-contained instructions for the coding agent." },
                        "title": { "type": "string", "description": "Short, plain-language name of the work shown at the top of the checklist, e.g. 'Fix the login redirect'." },
                        "plan": {
                            "type": "array",
                            "items": { "type": "string" },
                            "minItems": 2,
                            "maxItems": 8,
                            "description": "The steps the user will watch as a checklist. Plain, friendly language a non-technical person understands: 'Setting things up', 'Designing the front page', 'Integrating the payment service'. 3-6 steps, in order. No file names, tool names, package names, commands, or jargon. Same language the user writes in."
                        },
                        "resume_session_id": { "type": "string", "description": "Continue an earlier session from list_coding_sessions instead of starting fresh." }
                    },
                    "required": ["machine", "project", "task", "title", "plan"],
                    "additionalProperties": false
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "list_agents",
                "description": "List coding agents started from this chat on one machine, with state and progress.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "machine": { "type": "string", "description": "The exact machine name from list_machines." }
                    },
                    "required": ["machine"],
                    "additionalProperties": false
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "agent_status",
                "description": "Detailed status of one coding agent on one machine: state, steps, last step, latest message, any question it is waiting on.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "machine": { "type": "string", "description": "The exact machine name from list_machines." },
                        "agent_id": { "type": "string" }
                    },
                    "required": ["machine", "agent_id"],
                    "additionalProperties": false
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "steer_agent",
                "description": "Send guidance to a running coding agent when the user asks for a change while it works. Pass their instruction on instead of starting another agent. Delivered after its current tool calls finish. If the agent is waiting for an answer to a question, use answer_agent instead. Also starts a follow-up task in the same session when the agent is idle, but only when the user has asked for more work in their latest message - never from a coding-agent update.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "machine": { "type": "string", "description": "The exact machine name from list_machines." },
                        "agent_id": { "type": "string" },
                        "message": { "type": "string", "description": "What to change or do next." }
                    },
                    "required": ["machine", "agent_id", "message"],
                    "additionalProperties": false
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "answer_agent",
                "description": "Answer a question a coding agent is blocked on. For confirm questions answer yes or no; for select questions answer with one of the offered options.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "machine": { "type": "string", "description": "The exact machine name from list_machines." },
                        "agent_id": { "type": "string" },
                        "answer": { "type": "string" }
                    },
                    "required": ["machine", "agent_id", "answer"],
                    "additionalProperties": false
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "stop_agent",
                "description": "Stop a coding agent immediately. Use when it is going the wrong way, or the user asks to stop.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "machine": { "type": "string", "description": "The exact machine name from list_machines." },
                        "agent_id": { "type": "string" }
                    },
                    "required": ["machine", "agent_id"],
                    "additionalProperties": false
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "list_coding_sessions",
                "description": "Recent coding sessions in a project on one machine, newest first, with ids and previews. Use one of these ids with start_coding_agent to continue earlier work.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "machine": { "type": "string", "description": "The exact machine name from list_machines." },
                        "project": { "type": "string", "description": "Project folder name." }
                    },
                    "required": ["machine", "project"],
                    "additionalProperties": false
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "web_search",
                "description": "Search the live web and return titles, URLs, snippets and summaries. Use it when the answer depends on current information (recent releases, prices, news, people, documentation) rather than general reasoning or what the user already told you. Cite the URLs you use in your answer.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "query": { "type": "string", "description": "Search query, 1-128 characters. Supports site:, after:, before:, lang:, and \"exact phrase\"." },
                        "count": { "type": "integer", "minimum": 1, "maximum": 10, "description": "How many results to return. Default 6." }
                    },
                    "required": ["query"],
                    "additionalProperties": false
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "look_at_picture",
                "description": "Open a picture that is already on this computer and look at it yourself: a screenshot a coding agent saved, a photo or chart the user points at, an image inside a project. You get the picture, not a description of it, so use it whenever the answer depends on what is actually in the image.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": { "type": "string", "description": "Path to the image file on this computer, e.g. 'C:/Users/me/Pictures/shot.png' or a path an agent reported." }
                    },
                    "required": ["path"],
                    "additionalProperties": false
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "generate_image",
                "description": "Make a picture from a description. The picture appears in this conversation for the user to look at, and `save_to` writes a copy to a folder or file on this computer as well (a picture without `save_to` and with attach=false goes to Pictures/Hook). Describe what should be in the frame - subject, style, light, composition - and put any words that must appear in the image in quotes. Give `references` to work from a picture that already exists: a change to it, a style to carry over, two things to combine.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "prompt": { "type": "string", "description": "What the picture shows, in one or two sentences. Say the medium or style when it matters (a photo, a flat illustration, a watercolour)." },
                        "aspect_ratio": { "type": "string", "enum": ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "9:20", "20:9", "9:21", "21:9", "2.35:1"], "description": "Shape of the picture. A portrait for a person standing, 16:9 for a landscape or a slide, 1:1 for an icon or a profile picture. Omit for the model's own choice." },
                        "count": { "type": "integer", "minimum": 1, "maximum": 4, "description": "How many pictures to make. Default 1; each one costs the user money." },
                        "references": {
                            "type": "array",
                            "items": { "type": "string" },
                            "maxItems": 10,
                            "description": "Pictures to work from, at most 10. `#3` is the third picture in this conversation (they are numbered from 1 in the order they appear, and every picture tool says which number it was given), `#last` is the newest one, and anything else is the path of an image file on this computer. Use this to change, extend or restyle a picture instead of describing it again from scratch."
                        },
                        "save_to": { "type": "string", "description": "A folder or a file path on this computer to also write the picture to, e.g. 'C:/Users/me/Desktop/cover.png'. Omit to leave it in the conversation only." },
                        "attach": { "type": "boolean", "description": "Whether the picture belongs in this conversation. Default true. Use false when the user only asked for a file." }
                    },
                    "required": ["prompt"],
                    "additionalProperties": false
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "attach_image",
                "description": "Put a picture that is already on this computer into this conversation, so the user sees it. Use it for a screenshot or a file a coding agent produced, a picture the user points at, or a picture you generated earlier and want to show again. The picture is copied into the chat; the original stays where it is.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": { "type": "string", "description": "Path to the image file on this computer, e.g. 'C:/Users/me/Pictures/shot.png'." },
                        "caption": { "type": "string", "description": "One short line to show under the picture. Optional." }
                    },
                    "required": ["path"],
                    "additionalProperties": false
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "no_update",
                "description": "Say nothing to the user for this progress batch. Use this when there is nothing worth interrupting them for: routine steps, 'still working', 'building now', 'I'll report back', a run that merely settled, no new picture, no milestone.",
                "parameters": { "type": "object", "properties": {}, "additionalProperties": false }
            }
        }
    ])
}

/// A browser, on the machine that has one.
///
/// The message a browser sends already carries the active tab, its address and
/// its title; these tools are for everything else — the other tabs, the page
/// itself (which is far too large to travel with every message), and doing
/// something to it.
///
/// `run_js` and `browser_cdp` are deliberately the last two: a page can do
/// anything through them, so a capability that is missing here is a Rust change
/// and not a new schema.
pub fn browser_definitions() -> Vec<Value> {
    let list = json!([
        {
            "type": "function",
            "function": {
                "name": "list_tabs",
                "description": "List the tabs open in Hook Browser on a machine: number, title, address and which one is selected. On a machine whose user is browsing, this is how you find out what they are looking at. Pass `tab` to read one tab's row instead of the whole list.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "machine": { "type": "string", "description": "The machine with the browser, by name from list_machines. Always required, even for this computer: the conversation has to say where the browser is." },
                        "tab": { "type": "integer", "minimum": 1, "description": "One tab, numbered as list_tabs numbers it." }
                    },
                    "required": ["machine"],
                    "additionalProperties": false
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "read_page",
                "description": "Read a tab's text. Returns one slice and the page's headings; a long page is read in pieces, so pass `offset` (the `next` value from the previous read) instead of asking again. The numbers in `headings` are not offsets - to find a section, use find_in_page on its words.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "machine": { "type": "string", "description": "The machine with the browser, by name from list_machines." },
                        "tab": { "type": "integer", "minimum": 1, "description": "Which tab to read, as list_tabs numbers it." },
                        "offset": { "type": "integer", "minimum": 0, "description": "Characters to skip. Default 0; use the `next` value from the last read." },
                        "limit": { "type": "integer", "minimum": 1, "maximum": 40000, "description": "How many characters to return. Default 8000, which is usually enough to answer from." }
                    },
                    "required": ["machine", "tab"],
                    "additionalProperties": false
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "find_in_page",
                "description": "Search inside a tab for words or a pattern, without reading the whole page: returns up to ten short snippets with the character offset of each, which read_page can start from. Faster and cheaper than paging through a long page.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "machine": { "type": "string", "description": "The machine with the browser, by name from list_machines." },
                        "tab": { "type": "integer", "minimum": 1, "description": "Which tab to search, as list_tabs numbers it." },
                        "query": { "type": "string", "description": "The words to look for, case-insensitive. With `regex` set, a regular expression." },
                        "regex": { "type": "boolean", "description": "Treat `query` as a regular expression. Default false." }
                    },
                    "required": ["machine", "tab", "query"],
                    "additionalProperties": false
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "open_tab",
                "description": "Open a link in a new foreground tab and return the new tab's number, title and address so the next call can act on it. Use this instead of window.open in a script: a popup is blocked, and the tab it opens has no number to give back.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "machine": { "type": "string", "description": "The machine with the browser, by name from list_machines." },
                        "tab": { "type": "integer", "minimum": 1, "description": "The tab this request is sent from, as list_tabs numbers it. The new tab opens as the selected one." },
                        "url": { "type": "string", "description": "The address to open. Omit it for an empty tab." }
                    },
                    "required": ["machine", "tab"],
                    "additionalProperties": false
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "switch_tab",
                "description": "Select a tab and bring its window to the front, the way clicking it in the strip would. Do this before typing into or scrolling a tab the user is not looking at.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "machine": { "type": "string", "description": "The machine with the browser, by name from list_machines." },
                        "tab": { "type": "integer", "minimum": 1, "description": "Which tab to select, as list_tabs numbers it." }
                    },
                    "required": ["machine", "tab"],
                    "additionalProperties": false
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "close_tab",
                "description": "Close one tab. The strip renumbers afterwards, so take the next number from list_tabs rather than counting down.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "machine": { "type": "string", "description": "The machine with the browser, by name from list_machines." },
                        "tab": { "type": "integer", "minimum": 1, "description": "Which tab to close, as list_tabs numbers it." }
                    },
                    "required": ["machine", "tab"],
                    "additionalProperties": false
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "navigate",
                "description": "Send a tab to an address and wait for it to load, then answer where it landed, its title and whether it finished. Use this instead of assigning location in run_js: a navigation destroys the page's script, so a run_js that navigates never gets to answer.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "machine": { "type": "string", "description": "The machine with the browser, by name from list_machines." },
                        "tab": { "type": "integer", "minimum": 1, "description": "Which tab to navigate, as list_tabs numbers it." },
                        "url": { "type": "string", "description": "The address to open in that tab." }
                    },
                    "required": ["machine", "tab", "url"],
                    "additionalProperties": false
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "run_js",
                "description": "Run JavaScript in a tab and return what it evaluates to. `await` and `return` both work at the top level, and the page's own globals are in scope. A `__hook` helper is installed for you: snapshot() lists the interactive elements in reading order with a stable ref each; find(text) says where the words are and which element holds them; text(selector?) is the visible text; click(ref), type(ref, value), press(key), scroll({to:'bottom'|by:600|target:ref}) and waitFor('text'|'sel:css'|'url:fragment', {timeout_ms}) each act and return what happened; state(), frames(), errors() and sleep(ms) are there too. A ref belongs to the document that made it, so take a fresh snapshot after a navigation. Throw instead of guessing: the error comes back to you. Return a JSON-able value - the answer is capped at 60,000 characters. Use browser_cdp for trusted clicks and keys, screenshots, downloads and emulation.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "machine": { "type": "string", "description": "The machine with the browser, by name from list_machines." },
                        "tab": { "type": "integer", "minimum": 1, "description": "Which tab to run it in, as list_tabs numbers it." },
                        "code": { "type": "string", "description": "The JavaScript. A short script that returns JSON beats a long one that console.logs." },
                        "timeout_ms": { "type": "integer", "minimum": 1000, "maximum": 40000, "description": "How long the script may run before the browser stops it. Default 20000." }
                    },
                    "required": ["machine", "tab", "code"],
                    "additionalProperties": false
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "browser_cdp",
                "description": "Send one Chrome DevTools Protocol command to a tab and return its result object. This is the escape hatch for what run_js cannot do: trusted input (Input.dispatchMouseEvent and Input.dispatchKeyEvent are the only clicks and keys a page counts as the user's), navigation (Page.navigate, Page.reload, Page.navigateToHistoryEntry), emulation (Emulation.setDeviceMetricsOverride, setCPUThrottlingRate, setGeolocationOverride), files (DOM.setFileInputFiles), the accessibility tree (Accessibility.getFullAXTree), dialogs (Page.handleJavaScriptDialog), and the page's own tool registry (WebMCP.*). A binary result - a screenshot, a PDF - is dropped and reported as `omitted`: you cannot see pictures, so read the page with run_js instead.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "machine": { "type": "string", "description": "The machine with the browser, by name from list_machines." },
                        "tab": { "type": "integer", "minimum": 1, "description": "Which tab to send it to, as list_tabs numbers it." },
                        "method": { "type": "string", "description": "The protocol method, like `Page.captureScreenshot` or `Input.dispatchMouseEvent`." },
                        "params": { "type": "object", "description": "The command's own parameters, exactly as the protocol defines them." }
                    },
                    "required": ["machine", "tab", "method"],
                    "additionalProperties": false
                }
            }
        }
    ]);
    list.as_array().cloned().unwrap_or_default()
}

/// The chat agent's tools, minus the ones that manage coding agents, as a
/// schema list for a directly-driven coding agent.
///
/// The user talks to `pi` in that conversation, so it should be able to do
/// everything the chat agent can do with Hook's data — projects, memory,
/// Workspace — on top of its own file and shell tools. Creating another
/// coding agent from inside one is not one of those things.
///
/// `web_search` is left out on purpose: the guard already registers it with
/// the same account-backed implementation, and two tools of that name would
/// only shadow each other.
pub fn direct_bridge_definitions(
    cfg: &HarnessConfig,
    caps: crate::Capabilities,
    memory: bool,
) -> Vec<Value> {
    // Without tool calling there is nothing to advertise: pi would offer them
    // and the provider would refuse the request.
    if !cfg.provider.tools {
        return Vec::new();
    }
    let mut out: Vec<Value> = Vec::new();
    if let Some(list) = definitions().as_array() {
        for tool in list {
            let name = tool["function"]["name"].as_str().unwrap_or("");
            // A direct agent has no subagents, so the tools that launch and
            // steer them are gone. `list_machines` stays: it is how the agent
            // finds the machine a browser tool has to name.
            if (AGENT_TOOLS.contains(&name) && name != "list_machines")
                || name == "web_search"
                || name == "no_update"
                // The engine can already open a picture with its own `read`,
                // and the pictures it opens belong to its own turn: a bridge
                // call would only hand it text.
                || name == "look_at_picture"
            {
                continue;
            }
            if !caps.projects && (PROJECT_TOOLS.contains(&name) || name == "attach_image") {
                continue;
            }
            // No endpoint, no picture: a tool that can only fail is not offered.
            if !cfg.image.available(cfg.auth.required) && IMAGE_TOOLS.contains(&name) {
                continue;
            }
            out.push(tool.clone());
        }
    }
    if memory {
        out.extend(crate::memory::definitions());
    }
    if caps.workspace_tools {
        out.extend(crate::workspace::definitions());
    }
    // A coding agent that can look at the page it just built — and click it —
    // is worth more than one that cannot. Offered on the same rule the chat
    // agent gets: a browser on this machine, or machines to reach one on.
    if caps.browser || caps.remote_agents {
        out.extend(browser_definitions());
    }
    out
}

/// `set_title`: the name the model gives its own conversation.
///
/// Applied by whoever holds the chat — the turn loop keeps it in memory, the
/// tool bridge loads it from disk — so the rule and the answer live here and
/// the caller only decides where the chat is saved.
pub fn title(chat: &mut Chat, args: &Value) -> Result<Value, String> {
    let title = args.get("title").and_then(Value::as_str).unwrap_or_default();
    let title = chat.set_agent_title(title)?;
    Ok(json!({
        "title": title,
        "note": "The conversation is named this now. Only change it again when the user asks.",
    }))
}

pub struct ToolEnv<'a> {
    pub agents: &'a AgentManager,
    pub projects: &'a ProjectsStore,
    pub settings: &'a SettingsStore,
    pub chat_id: &'a str,
    /// True only when the user asked for something and has not been answered
    /// yet. A turn woken by a coding-agent note is not user-initiated.
    pub user_initiated: bool,
    /// The app state, when this is a chat-agent turn. Direct coding agents and
    /// unit tests have no relay and therefore no machines.
    pub state: Option<&'a crate::state::AppState>,
}

/// Runs one tool call and returns the JSON text handed back to the model.
pub fn execute(env: &ToolEnv<'_>, name: &str, args: &Value) -> String {
    match run(env, name, args) {
        Ok(value) => value.to_string(),
        Err(message) => json!({ "error": message }).to_string(),
    }
}

/// Run a tool that may need another process or another machine. Local tools fall
/// through to the synchronous dispatcher, so their behaviour and tests are
/// unchanged.
pub async fn execute_async(env: &ToolEnv<'_>, name: &str, args: &Value) -> String {
    if !needs_async(name) {
        return execute(env, name, args);
    }
    let result = if BROWSER_TOOLS.contains(&name) {
        run_browser(env, name, args).await
    } else {
        run_machine(env, name, args).await
    };
    match result {
        Ok(value) => value.to_string(),
        Err(message) => json!({ "error": message }).to_string(),
    }
}

/// Whether a tool's answer may come from another process (a browser) or another
/// machine (an agent run). Those are the ones the turn loop and the coding
/// agent's bridge hand to [`execute_async`]; everything else stays a local call.
pub fn needs_async(name: &str) -> bool {
    BROWSER_TOOLS.contains(&name) || MACHINE_TOOLS.contains(&name)
}

#[derive(Debug, Clone)]
struct TargetMachine {
    id: String,
    name: String,
    /// This process can execute the work itself (it is Hook, and the machine is
    /// this one).
    local: bool,
    /// The machine runs Hook Browser, so a tab can be read there.
    can_read_pages: bool,
    /// This machine is the one this process runs on.
    is_self: bool,
}

pub(crate) fn machine_view(state: &crate::state::AppState) -> Value {
    let view = state.relay.view();
    let mut machines: Vec<Value> = view
        .devices
        .iter()
        .map(|device| {
            json!({
                "machine": device.name,
                "id": device.id,
                "kind": device.kind,
                "platform": device.platform,
                "online": device.online,
                "can_run_agents": device.host_online,
                "this_computer": device.id == view.self_id,
                "remote_allowed": device.remote_allowed,
                "projects": device.specs.as_ref().and_then(|specs| specs.get("projects")).cloned(),
                // A tab can be read where Hook Browser is *running*. Without
                // this the model has to try a machine to find out.
                "can_read_pages": device.browser_online,
            })
        })
        .collect();
    // The machine this process runs on, when it hosts a browser. A tab is local
    // work: it does not need the relay, and a chat on Hook Browser must not be
    // told "no computers are connected" while the browser is right here.
    if state.capabilities.browser && !machines.iter().any(|row| row["id"] == json!(view.self_id)) {
        machines.insert(
            0,
            json!({
                "machine": view.self_name,
                "id": view.self_id,
                "kind": "desktop",
                "platform": std::env::consts::OS,
                "online": true,
                "can_run_agents": false,
                "this_computer": true,
                "remote_allowed": false,
                "projects": Value::Null,
                "can_read_pages": true,
            }),
        );
    }
    json!({
        "machines": machines,
        "connected": view.state == "online" || state.capabilities.browser,
        "message": view.message,
        "hint": if machines.is_empty() {
            "No computers are connected. Ask the user to turn one on, or add a cloud machine."
        } else {
            "Pass the exact machine name to every agent tool."
        },
    })
}

/// Reads a browser: here when this process hosts the browser, over the relay
/// when another machine does. Both halves answer the same JSON, because both run
/// `browser::perform` — the difference is only which process can see the tabs.
async fn run_browser(env: &ToolEnv<'_>, name: &str, args: &Value) -> Result<Value, String> {
    let state = env
        .state
        .ok_or("This build cannot reach a browser.")?;
    let machine = arg_str(args, "machine")?;
    let target = resolve_machine(env, Some(machine), Need::Browser)?;
    let op = crate::browser::Op::parse(name).ok_or("That is not a page tool.")?;

    // The body of the call: everything the tool was given but the machine,
    // which is this call's addressing and not the browser's business. Passing it
    // through instead of naming each key is what keeps a new argument from
    // being silently dropped on the way to `browser::perform`.
    let mut params = serde_json::Map::new();
    for (key, value) in args.as_object().into_iter().flatten() {
        if key == "machine" {
            continue;
        }
        params.insert(key.clone(), value.clone());
    }
    let params = Value::Object(params);

    // Local means this process is the one hosting the browser, which is what
    // `Capabilities::browser` says. A Hook app on the same computer is not: it
    // reaches the browser's host over the relay, like any other machine.
    if target.is_self && state.capabilities.browser {
        return crate::browser::perform(state, op, &params).await;
    }
    if !target.can_read_pages {
        return Err(format!(
            "{} has no Hook Browser running. Any machine with one can answer; list_machines marks them.",
            target.name
        ));
    }
    // The controller waits a little longer than the host does, so a slow script
    // is answered by the machine that ran it instead of by this timeout.
    let wait = op.budget() + std::time::Duration::from_secs(5);
    state
        .relay
        .rpc(&target.id, op.method(), params, wait)
        .await
        .map_err(|error| error.message)
}

/// What the tool that is asking needs from a machine. The same name resolves to
/// a different verdict: `this computer` is the right answer for an agent only
/// where Hook hosts agents, and for a page only where Hook Browser runs. A
/// browser is a controller, so its machine is never a host — which is exactly
/// why this cannot be one function with one answer.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Need {
    /// Run a coding agent: the machine must accept work.
    Agents,
    /// Reach a browser: this machine has to be running Hook Browser.
    Browser,
}

fn resolve_machine(
    env: &ToolEnv<'_>,
    requested: Option<&str>,
    need: Need,
) -> Result<TargetMachine, String> {
    let state = env
        .state
        .ok_or("This build cannot reach other machines.")?;
    let view = state.relay.view();
    let requested = requested.map(str::trim).unwrap_or("");
    let this_computer = matches!(
        requested.to_ascii_lowercase().as_str(),
        "this computer" | "this machine" | "this pc" | "local" | "here"
    );
    let mine = TargetMachine {
        id: view.self_id.clone(),
        name: view.self_name.clone(),
        local: state.capabilities.coding_agents,
        is_self: true,
        can_read_pages: state.capabilities.browser,
    };
    if this_computer {
        if need == Need::Browser {
            return if mine.can_read_pages {
                Ok(mine)
            } else if state.product == crate::Product::Mobile {
                Err("A phone has no browser. Name one of the user's computers, from list_machines.".into())
            } else {
                Err(format!(
                    "{} is not running Hook Browser, so it has no tabs to read. Name the machine that is.",
                    mine.name
                ))
            };
        }
        if state.product == crate::Product::Mobile {
            return Err(
                "A phone cannot run coding agents. Choose one of the user's computers."
                    .into(),
            );
        }
        return Ok(mine);
    }
    if requested.is_empty() {
        if need == Need::Browser {
            return Err(
                "Choose a machine with Hook Browser. Call list_machines: the ones that can be read are marked."
                    .into(),
            );
        }
        if state.capabilities.coding_agents {
            return Ok(mine);
        }
        return Err(
            "Choose a computer for this work. Call list_machines to see which ones are on."
                .into(),
        );
    }
    let exact: Vec<_> = view
        .devices
        .iter()
        .filter(|device| device.id == requested || device.name.eq_ignore_ascii_case(requested))
        .collect();
    let candidates: Vec<_> = if exact.is_empty() {
        let needle = requested.to_ascii_lowercase();
        view.devices
            .iter()
            .filter(|device| device.name.to_ascii_lowercase().contains(&needle))
            .collect()
    } else {
        exact
    };
    match candidates.as_slice() {
        [] => Err(format!(
            "There is no machine called \"{requested}\". Call list_machines for the current names."
        )),
        [one] => {
            let has_browser = one.browser_online;
            if need == Need::Browser {
                if !has_browser {
                    return Err(format!(
                        "{} has no Hook Browser, so there is nothing to read there.",
                        one.name
                    ));
                }
                if !one.online {
                    return Err(format!(
                        "{} is not running right now, so its browser cannot be read. Turn it on, then ask again.",
                        one.name
                    ));
                }
                return Ok(TargetMachine {
                    id: one.id.clone(),
                    name: one.name.clone(),
                    local: false,
                    is_self: one.id == view.self_id,
                    can_read_pages: true,
                });
            }
            if !one.can_host {
                return Err(format!(
                    "\"{}\" cannot run coding agents. Choose a computer running Hook.",
                    one.name
                ));
            }
            if !one.host_online {
                return Err(format!(
                    "\"{}\" is not running Hook right now. Turn it on, then ask again.",
                    one.name
                ));
            }
            Ok(TargetMachine {
                id: one.id.clone(),
                name: one.name.clone(),
                local: one.id == view.self_id && state.capabilities.coding_agents,
                is_self: one.id == view.self_id,
                can_read_pages: has_browser,
            })
        }
        many => Err(format!(
            "Which machine? {}",
            many.iter()
                .map(|device| device.name.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        )),
    }
}

async fn run_machine(env: &ToolEnv<'_>, name: &str, args: &Value) -> Result<Value, String> {
    if name == "list_machines" {
        let Some(state) = env.state else {
            return Ok(json!({ "machines": [], "connected": false }));
        };
        return Ok(machine_view(state));
    }

    // `list_projects` is optional on the machine: a desktop with a projects
    // folder can keep using it as before. A phone must name the machine whose
    // folders it wants, because it has none of its own.
    if name == "list_projects" && args.get("machine").is_none() {
        if env
            .state
            .map(|state| state.capabilities.projects)
            .unwrap_or(true)
        {
            return run(env, name, args);
        }
        return Err("Name the machine whose projects you want. Call list_machines first.".into());
    }

    let requested = args.get("machine").and_then(Value::as_str);
    let target = resolve_machine(env, requested, Need::Agents)?;
    if target.local {
        return run(env, name, args);
    }
    let state = env
        .state
        .ok_or("This build cannot reach other machines.")?;
    if !state.capabilities.remote_agents {
        return Err("This product cannot control other machines.".into());
    }

    let (method, params, timeout) = match name {
        "list_projects" => (
            "projects.list",
            json!({}),
            std::time::Duration::from_secs(20),
        ),
        "create_project" => (
            "projects.create",
            json!({
                "name": arg_str(args, "name")?,
                "description": arg_str(args, "description")?,
            }),
            std::time::Duration::from_secs(30),
        ),
        "list_agents" => (
            "agent.list",
            json!({ "chatId": env.chat_id }),
            std::time::Duration::from_secs(20),
        ),
        "agent_status" => (
            "agent.status",
            json!({ "agentId": arg_str(args, "agent_id")? }),
            std::time::Duration::from_secs(20),
        ),
        "steer_agent" => (
            "agent.steer",
            json!({
                "agentId": arg_str(args, "agent_id")?,
                "text": arg_str(args, "message")?,
            }),
            std::time::Duration::from_secs(30),
        ),
        "answer_agent" => (
            "agent.answer",
            json!({
                "agentId": arg_str(args, "agent_id")?,
                "answer": arg_str(args, "answer")?,
            }),
            std::time::Duration::from_secs(30),
        ),
        "stop_agent" => (
            "agent.stop",
            json!({ "agentId": arg_str(args, "agent_id")? }),
            std::time::Duration::from_secs(20),
        ),
        "start_coding_agent" => {
            let mut chat = state.store.load(env.chat_id)?;
            chat.refresh_meta();
            let project = arg_str(args, "project")?;
            let task = arg_str(args, "task")?;
            let title = arg_str(args, "title")?;
            let plan: Vec<String> = args
                .get("plan")
                .and_then(Value::as_array)
                .map(|items| {
                    items
                        .iter()
                        .filter_map(|item| item.as_str().map(str::trim))
                        .filter(|item| !item.is_empty())
                        .take(crate::agent::MAX_PLAN_STEPS)
                        .map(str::to_string)
                        .collect()
                })
                .unwrap_or_default();
            if plan.len() < 2 {
                return Err("Give the user at least two plain-language steps in \"plan\".".into());
            }
            (
                "agent.start",
                json!({
                    "chatId": env.chat_id,
                    "chat": chat,
                    "project": project,
                    "task": task,
                    "title": title,
                    "plan": plan,
                    "resumeSession": args.get("resume_session_id").and_then(Value::as_str),
                }),
                std::time::Duration::from_secs(60),
            )
        }
        "list_coding_sessions" => (
            "sessions.list",
            json!({ "project": arg_str(args, "project")? }),
            std::time::Duration::from_secs(20),
        ),
        other => return Err(format!("Unknown machine tool: {other}")),
    };

    let mut value = state
        .relay
        .rpc(&target.id, method, params, timeout)
        .await
        .map_err(|error| {
            if error.code == "device_offline" {
                format!(
                    "{} is not running Hook right now. Turn it on, then ask again.",
                    target.name
                )
            } else {
                error.message
            }
        })?;
    if let Some(object) = value.as_object_mut() {
        object
            .entry("machine")
            .or_insert_with(|| Value::String(target.name.clone()));
        if name == "start_coding_agent" {
            object.entry("note").or_insert_with(|| {
                Value::String(format!(
                    "Running on {}. The user can see the plan and stop it from this chat. You may end your turn; you will be woken when it settles, fails, or asks a question.",
                    target.name
                ))
            });
        }
    }
    Ok(value)
}

fn arg_str<'a>(args: &'a Value, key: &str) -> Result<&'a str, String> {
    args.get(key)
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .ok_or_else(|| format!("Missing \"{key}\"."))
}

fn run(env: &ToolEnv<'_>, name: &str, args: &Value) -> Result<Value, String> {
    // A note from a coding agent can wake the chat, but it is not a user
    // request. Refuse to start or redirect work from it: otherwise a model
    // can "helpfully" restart a run that had already finished.
    if !env.user_initiated && matches!(name, "start_coding_agent" | "steer_agent") {
        return Err(
            "Coding work can only start or change because the user asked for it. This turn was triggered by a coding-agent update, so report the update or call no_update and wait for the user."
                .into(),
        );
    }
    let root = env.settings.projects_dir();

    match name {
        "list_projects" => {
            let projects = env.projects.list(&root)?;
            let items: Vec<Value> = projects
                .iter()
                .map(|p| {
                    json!({
                        "project": p.name,
                        "description": if p.description.is_empty() { "(no description yet)" } else { p.description.as_str() },
                        "git": p.is_git,
                    })
                })
                .collect();
            Ok(json!({
                "projects": items,
                "hint": if items.is_empty() { "No projects yet. Create one with create_project." } else { "" },
            }))
        }
        "create_project" => {
            let name = arg_str(args, "name")?;
            let description = arg_str(args, "description")?;
            let project = env.projects.create(&root, name, description)?;
            Ok(json!({
                "created": project.name,
                "description": project.description,
            }))
        }
        "update_project_description" => {
            let project = arg_str(args, "project")?;
            let description = arg_str(args, "description")?;
            let updated = env.projects.describe(&root, project, description)?;
            Ok(json!({ "project": updated.name, "description": updated.description }))
        }
        "remember_in_project" => {
            let project = arg_str(args, "project")?;
            let note = arg_str(args, "note")?;
            let path = env.projects.resolve(&root, project)?;
            let file = ProjectsStore::append_agent_note(&path, note)?;
            let notes = ProjectsStore::agent_notes(&path);
            Ok(json!({
                "project": path
                    .file_name()
                    .map(|name| name.to_string_lossy().to_string())
                    .unwrap_or_else(|| project.to_string()),
                "file": file.to_string_lossy(),
                "notes": notes,
                "note": "Every coding agent in this project now reads it.",
            }))
        }
        "start_coding_agent" => {
            let project = arg_str(args, "project")?;
            let task = arg_str(args, "task")?;
            let title = arg_str(args, "title")?;
            let resume = args.get("resume_session_id").and_then(|v| v.as_str());
            let plan: Vec<String> = args
                .get("plan")
                .and_then(|v| v.as_array())
                .map(|items| {
                    items
                        .iter()
                        .filter_map(|item| item.as_str().map(str::trim))
                        .filter(|item| !item.is_empty())
                        .take(crate::agent::MAX_PLAN_STEPS)
                        .map(str::to_string)
                        .collect()
                })
                .unwrap_or_default();
            if plan.len() < 2 {
                return Err(
                    "Give the user at least two plain-language steps in \"plan\", e.g. [\"Setting things up\", \"Designing the page\"]".into(),
                );
            }
            let info = env
                .agents
                .start(env.chat_id, project, task, Some(title), resume, &plan)?;
            Ok(json!({
                "agent_id": info.id,
                "project": info.project,
                "state": info.state,
                "plan": info.plan,
                "resumed_session": resume.is_some(),
                "note": "Running in the background. The user can see the plan and stop it from the chat. You may end your turn; you will be woken when it settles, fails, or asks a question.",
            }))
        }
        "list_agents" => {
            let agents: Vec<Value> = env
                .agents
                .list()
                .into_iter()
                .filter(|a| a.chat_id == env.chat_id)
                .map(|a| {
                    json!({
                        "agent_id": a.id,
                        "project": a.project,
                        "title": a.title,
                        "state": a.state,
                        "steps": a.steps,
                        "last_step": a.last_step,
                        "plan": a.plan,
                    })
                })
                .collect();
            Ok(json!({ "agents": agents }))
        }
        "agent_status" => {
            let id = arg_str(args, "agent_id")?;
            let info = env
                .agents
                .get(id)
                .ok_or_else(|| format!("No agent {id}"))?;
            if info.chat_id != env.chat_id {
                return Err(format!("No agent {id} in this chat."));
            }
            Ok(json!({
                "agent_id": info.id,
                "project": info.project,
                "title": info.title,
                "task": info.task,
                "state": info.state,
                "steps": info.steps,
                "last_step": info.last_step,
                "plan": info.plan,
                "last_message": info.last_message.as_deref().map(|m| truncate(m, 2500)),
                "question": info.question.as_ref().map(|q| json!({
                    "method": q.method,
                    "title": q.title,
                    "message": q.message,
                    "options": q.options,
                })),
                "error": info.error,
                "session_id": info.session_id,
            }))
        }
        "steer_agent" => {
            let id = arg_str(args, "agent_id")?;
            let message = arg_str(args, "message")?;
            let info = env.agents.steer(id, message, &[])?;
            Ok(json!({ "agent_id": info.id, "state": info.state }))
        }
        "answer_agent" => {
            let id = arg_str(args, "agent_id")?;
            let answer = arg_str(args, "answer")?;
            let info = env.agents.answer(id, answer)?;
            Ok(json!({ "agent_id": info.id, "state": info.state }))
        }
        "stop_agent" => {
            let id = arg_str(args, "agent_id")?;
            let info = env.agents.stop(id)?;
            Ok(json!({ "agent_id": info.id, "state": info.state }))
        }
        "list_coding_sessions" => {
            let project = arg_str(args, "project")?;
            let path = env.projects.resolve(&root, project)?;
            let sessions: Vec<Value> = env
                .agents
                .sessions(&path.to_string_lossy())
                .into_iter()
                .map(|s| {
                    json!({
                        "session_id": s.id,
                        "title": s.title,
                        "preview": s.preview,
                    })
                })
                .collect();
            Ok(json!({ "project": project, "sessions": sessions }))
        }
        // Applied by the caller that holds the chat (the turn loop, the tool
        // bridge), so there is nothing to do here.
        "set_title" => Err("The conversation's title is set where the chat is held.".into()),
        // Intercepted by the turn loop before it gets here; the arm exists so
        // an unexpected call still behaves.
        "no_update" => Ok(json!({ "sent": false })),
        other => Err(format!("Unknown tool: {other}")),
    }
}

/// A compact note appended to the chat history when a coding agent needs
/// attention. Hidden from the user; the chat agent turns it into prose.
/// The progress notes a coding agent sent since the last batch, oldest first.
///
/// `local_pictures` says whether this product can open a file on the machine
/// the run happened on. A phone cannot: the paths would name files it has no
/// way to read, and a tool it was never given.
pub fn progress_block(updates: &[crate::agent::Update], local_pictures: bool) -> String {
    let mut block = String::from("progress:\n");
    let mut pictures: Vec<&std::path::Path> = Vec::new();
    for update in updates {
        pictures.extend(update.images.iter().map(std::path::PathBuf::as_path));
        if update.note.is_empty() {
            continue;
        }
        for line in update.note.lines().take(6) {
            let line = line.trim();
            if !line.is_empty() {
                block.push_str("- ");
                block.push_str(&truncate(line, 300));
                block.push('\n');
            }
        }
    }
    if !pictures.is_empty() {
        block.push_str(&format!(
            "pictures: {} attached to this update; they are shown to the user with your reply.\n",
            pictures.len()
        ));
        if !local_pictures {
            return block;
        }
        // The paths are what make the pictures the agent's own too: without
        // them it can only repeat what the note said, never what the screen
        // shows.
        block.push_str("pictures_on_disk: ");
        for (index, path) in pictures.iter().enumerate() {
            if index > 0 {
                block.push_str(", ");
            }
            block.push_str(&path.to_string_lossy());
        }
        block.push_str(
            "\nUse look_at_picture on one of these when what it shows decides what you say.\n",
        );
    }
    block
}

pub fn agent_event_note(info: &crate::agent::AgentInfo, quiet: bool) -> String {
    let mut note = String::from("[coding agent update]\n");
    note.push_str(&format!("agent_id: {}\n", info.id));
    note.push_str(&format!("project: {}\n", info.project));
    note.push_str(&format!("state: {}\n", info.state));
    note.push_str(&format!("outcome: {}\n", outcome_line(info)));
    if quiet {
        // Everything this run produced has already been said. Lead with that,
        // and say nothing that invites a retelling: no last_message, no step.
        note.push_str("new_since_last_update: none\n");
        note.push_str(
            "You already sent at least one update about this run. If your messages already said how it ended, call no_update and say nothing. If they did not, say in one sentence how it ended - no repeating of earlier detail, no re-describing the work.\n",
        );
        return note;
    }
    note.push_str(&format!("task: {}\n", truncate(&info.task, 240)));
    if !info.plan.is_empty() {
        note.push_str("plan:\n");
        for step in &info.plan {
            note.push_str(&format!("- [{}] {}\n", step.status, step.title));
        }
    }
    note.push_str(&format!("steps: {}\n", info.steps));
    if let Some(step) = &info.last_step {
        note.push_str(&format!("last_step: {step}\n"));
    }
    if let Some(question) = &info.question {
        note.push_str(&format!("question: {}\n", truncate(&question.title, 400)));
        if !question.message.is_empty() {
            note.push_str(&format!("question_detail: {}\n", truncate(&question.message, 600)));
        }
        if !question.options.is_empty() {
            note.push_str(&format!("options: {}\n", question.options.join(" | ")));
        }
        note.push_str("next: answer with answer_agent, or ask the user first.\n");
    }
    if let Some(error) = &info.error {
        note.push_str(&format!("error: {}\n", truncate(error, 600)));
    }
    if let Some(message) = &info.last_message {
        note.push_str("last_message:\n");
        note.push_str(&truncate(message, 2000));
        note.push('\n');
    }
    note.push_str(
        "Decide whether the user needs to hear this. If it is news - something new happened, a problem, a picture, work finishing - tell them. If the run merely settled and nothing is new, call no_update and say nothing. Do not mention agent ids, sessions or tooling.\n",
    );
    note
}

/// One plain sentence the wake note leads with, so the chat agent does not have
/// to decode a state name - or invent one.
fn outcome_line(info: &crate::agent::AgentInfo) -> &'static str {
    use crate::agent::{
        STATE_DONE, STATE_FAILED, STATE_IDLE, STATE_INTERRUPTED, STATE_NEEDS_INPUT, STATE_STOPPED,
    };
    if info.error.is_some() || info.state == STATE_FAILED {
        "stopped with an error"
    } else if info.question.is_some() || info.state == STATE_NEEDS_INPUT {
        "waiting for an answer before it can continue"
    } else if info.state == STATE_STOPPED {
        "stopped because it was told to"
    } else if info.state == STATE_INTERRUPTED {
        "interrupted"
    } else if info.state == STATE_DONE {
        "finished the task"
    } else if info.state == STATE_IDLE {
        "finished its run"
    } else {
        "still running"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_agent() -> crate::agent::AgentInfo {
        crate::agent::AgentInfo {
            id: "ag_1".into(),
            chat_id: "c1".into(),
            project: "demo".into(),
            project_path: "C:/tmp/demo".into(),
            title: "t".into(),
            task: "build the site".into(),
            session_id: "s1".into(),
            state: crate::agent::STATE_RUNNING.into(),
            created_at: 0,
            updated_at: 0,
            finished_at: None,
            steps: 9,
            last_step: Some("bash: ls".into()),
            last_message: Some("A long final report about the whole build.".into()),
            error: None,
            question: None,
            plan: Vec::new(),
            direct: false,
            device_id: String::new(),
            device_name: String::new(),
        }
    }

    #[test]
    fn a_progress_picture_is_something_the_chat_agent_can_open() {
        let update = crate::agent::Update {
            note: "the menu is in place".into(),
            images: vec![std::path::PathBuf::from("C:/hook/files/shot.png")],
        };
        let local = progress_block(&[update.clone()], true);
        assert!(local.contains("pictures: 1 attached"));
        assert!(local.contains("pictures_on_disk: C:/hook/files/shot.png"));
        assert!(local.contains("look_at_picture"));
        // A phone has no tool and no file: naming a path it cannot read would
        // only invite the model to describe a picture it never saw.
        let remote = progress_block(&[update], false);
        assert!(remote.contains("pictures: 1 attached"));
        assert!(!remote.contains("pictures_on_disk"));
        assert!(!remote.contains("look_at_picture"));
    }

    #[test]
    fn a_settle_with_nothing_new_hides_the_report_and_asks_for_silence() {
        let mut info = sample_agent();
        info.state = crate::agent::STATE_IDLE.into();

        let quiet = agent_event_note(&info, true);
        assert!(quiet.contains("new_since_last_update: none"));
        assert!(quiet.contains("outcome: finished its run"));
        assert!(!quiet.contains("A long final report"));
        assert!(!quiet.contains("last_step"));
        assert!(quiet.contains("no_update"));

        let loud = agent_event_note(&info, false);
        assert!(!loud.contains("new_since_last_update: none"));
        assert!(loud.contains("A long final report"));
    }

    #[test]
    fn the_wake_note_carries_the_plan_so_status_questions_can_be_answered() {
        let mut info = sample_agent();
        info.plan = crate::agent::plan_from_titles(&[
            "Setting things up".into(),
            "Designing the front page".into(),
        ]);
        let note = agent_event_note(&info, false);
        assert!(note.contains("plan:"));
        assert!(note.contains("[active] Setting things up"));
        assert!(note.contains("[pending] Designing the front page"));
    }

    #[test]
    fn schemas_cover_every_implemented_tool() {
        let defs = definitions();
        let names: Vec<&str> = defs
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|d| d.pointer("/function/name").and_then(|n| n.as_str()))
            .collect();
        for expected in [
            "set_title",
            "list_projects",
            "create_project",
            "update_project_description",
            "start_coding_agent",
            "list_agents",
            "agent_status",
            "steer_agent",
            "answer_agent",
            "stop_agent",
            "list_coding_sessions",
            "web_search",
            "look_at_picture",
            "generate_image",
            "attach_image",
        ] {
            assert!(names.contains(&expected), "{expected} missing");
        }
    }

    #[test]
    fn the_title_tool_names_the_chat() {
        let mut chat = Chat::new();
        chat.messages.push(crate::store::Message::new("user", "hi", "complete"));
        let answer = title(&mut chat, &json!({ "title": "Setting up the invoice parser" })).unwrap();
        assert_eq!(answer["title"], "Setting up the invoice parser");
        assert_eq!(chat.meta.title, "Setting up the invoice parser");
        // When the user asks for a different name the tool answers the same
        // way: they can ask the agent to rename a conversation at any time.
        let renamed = title(&mut chat, &json!({ "title": "Invoice parser" })).unwrap();
        assert_eq!(renamed["title"], "Invoice parser");
        assert_eq!(chat.meta.title, "Invoice parser");
        // A missing argument is a sentence, not a blank title.
        let mut fresh = Chat::new();
        fresh.messages.push(crate::store::Message::new("user", "hi", "complete"));
        assert!(title(&mut fresh, &json!({})).is_err());
    }

    #[test]
    fn every_agent_tool_names_a_machine() {
        let defs = definitions();
        for name in [
            "create_project",
            "start_coding_agent",
            "list_agents",
            "agent_status",
            "steer_agent",
            "answer_agent",
            "stop_agent",
            "list_coding_sessions",
        ] {
            let tool = defs
                .as_array()
                .unwrap()
                .iter()
                .find(|tool| tool["function"]["name"] == name)
                .unwrap_or_else(|| panic!("{name} is defined"));
            let required = tool["function"]["parameters"]["required"]
                .as_array()
                .unwrap();
            assert!(
                required.contains(&json!("machine")),
                "{name} must require a machine"
            );
        }
        let machines = defs
            .as_array()
            .unwrap()
            .iter()
            .find(|tool| tool["function"]["name"] == "list_machines");
        assert!(machines.is_some(), "list_machines is advertised");
    }

    #[test]
    fn the_chat_agent_must_pass_a_plain_language_plan() {
        // The checklist is only as good as the schema that demands it: a
        // missing plan would leave the board empty, technical steps would
        // defeat the point.
        let defs = definitions();
        let tool = defs
            .as_array()
            .unwrap()
            .iter()
            .find(|tool| tool["function"]["name"] == "start_coding_agent")
            .expect("start_coding_agent is defined");
        let parameters = &tool["function"]["parameters"];
        let required = parameters["required"].as_array().unwrap();
        assert!(required.contains(&json!("title")));
        assert!(required.contains(&json!("plan")));
        let plan = &parameters["properties"]["plan"];
        assert_eq!(plan["minItems"], 2);
        assert_eq!(plan["maxItems"], 8);
        assert!(plan["description"]
            .as_str()
            .unwrap()
            .contains("No file names"));
    }

    #[test]
    fn a_direct_agent_gets_the_chat_agents_tools_but_no_subagents() {
        let cfg = crate::config::get().expect("config");
        let defs = direct_bridge_definitions(cfg, crate::Capabilities::chat(), true);
        let names: Vec<&str> = defs
            .iter()
            .filter_map(|tool| tool["function"]["name"].as_str())
            .collect();
        for expected in [
            "set_title",
            "list_projects",
            "create_project",
            "update_project_description",
            "remember_in_project",
            "remember",
            "memory_search",
            "forget",
            "workspace_projects",
            // The agent has to be able to name a machine before a browser tool
            // will answer, so the directory of machines goes with them.
            "list_machines",
            "list_tabs",
            "read_page",
            "run_js",
            "browser_cdp",
        ] {
            assert!(names.contains(&expected), "{expected} missing");
        }
        // No subagents in this direction, and two tools the engine already has
        // (or has nothing to say to): a duplicate name would shadow it.
        for refused in [
            "start_coding_agent",
            "list_agents",
            "agent_status",
            "steer_agent",
            "answer_agent",
            "stop_agent",
            "list_coding_sessions",
            "web_search",
            "no_update",
            // The engine opens pictures with its own `read`; the bridge would
            // answer this one with text and no picture.
            "look_at_picture",
        ] {
            assert!(!names.contains(&refused), "{refused} must not be offered");
        }
        // Pictures are an account request, so a build signed in to the service
        // offers them: the key behind them is the server's, not this binary's.
        assert!(names.contains(&"generate_image"));
        assert!(names.contains(&"attach_image"));

        // Without memory or Workspace, only the project tools remain.
        let bare = direct_bridge_definitions(
            cfg,
            crate::Capabilities {
                preview_pages: false,
                preview_workspace: false,
                coding_agents: true,
                remote_agents: true,
                workspace_tools: false,
                projects: true,
                browser: false,
            },
            false,
        );
        let bare: Vec<&str> = bare
            .iter()
            .filter_map(|tool| tool["function"]["name"].as_str())
            .collect();
        assert!(!bare.contains(&"remember"));
        assert!(!bare.contains(&"workspace_projects"));
        assert!(bare.contains(&"list_projects"));
    }

    #[test]
    fn picture_tools_follow_the_endpoint_and_the_folder() {
        let mut cfg = crate::config::get().expect("config").clone();
        cfg.image.enabled = false;
        assert!(!direct_bridge_definitions(&cfg, crate::Capabilities::chat(), false)
            .iter()
            .any(|tool| tool["function"]["name"] == "generate_image"));
        cfg.image.enabled = true;
        let names = |caps: crate::Capabilities| -> Vec<String> {
            direct_bridge_definitions(&cfg, caps, false)
                .iter()
                .filter_map(|tool| tool["function"]["name"].as_str())
                .map(str::to_string)
                .collect()
        };
        // A coding agent that can reach a chat can make a picture and put one
        // into the conversation.
        let chat = names(crate::Capabilities::chat());
        assert!(chat.contains(&"generate_image".to_string()));
        assert!(chat.contains(&"attach_image".to_string()));
        // No folder on this machine means nothing to attach from.
        let phone = names(crate::Capabilities::mobile());
        assert!(phone.contains(&"generate_image".to_string()));
        assert!(!phone.contains(&"attach_image".to_string()));
    }

    #[test]
    fn unknown_tools_report_an_error_instead_of_panicking() {
        let base = std::env::temp_dir().join(format!("hook-tools-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&base).unwrap();
        let settings = SettingsStore::new(&base);
        let projects = ProjectsStore::new(&base);
        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
        let agents = AgentManager::new(
            &base,
            std::sync::Arc::new(crate::config::get().expect("config").clone()),
            std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
            Ok(crate::runtime::PiRuntime {
                program: std::path::PathBuf::from("pi"),
                cli: None,
                agent_home: base.join("agent-home"),
            }),
            std::sync::Arc::new(SettingsStore::new(&base)),
            std::sync::Arc::new(ProjectsStore::new(&base)),
            tx,
        );
        let env = ToolEnv {
            agents: &agents,
            projects: &projects,
            settings: &settings,
            chat_id: "c1",
            user_initiated: true,
            state: None,
        };
        let out = execute(&env, "nope", &json!({}));
        assert!(out.contains("Unknown tool"));
    }

    #[test]
    fn missing_arguments_are_reported() {
        let base = std::env::temp_dir().join(format!("hook-tools-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&base).unwrap();
        let settings = SettingsStore::new(&base);
        let projects = ProjectsStore::new(&base);
        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
        let agents = AgentManager::new(
            &base,
            std::sync::Arc::new(crate::config::get().expect("config").clone()),
            std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
            Ok(crate::runtime::PiRuntime {
                program: std::path::PathBuf::from("pi"),
                cli: None,
                agent_home: base.join("agent-home"),
            }),
            std::sync::Arc::new(SettingsStore::new(&base)),
            std::sync::Arc::new(ProjectsStore::new(&base)),
            tx,
        );
        let env = ToolEnv {
            agents: &agents,
            projects: &projects,
            settings: &settings,
            chat_id: "c1",
            user_initiated: true,
            state: None,
        };
        let out = execute(&env, "create_project", &json!({}));
        assert!(out.contains("Missing"));
    }

    #[test]
    fn a_coding_agent_note_cannot_restart_work() {
        let base = std::env::temp_dir().join(format!("hook-tools-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&base).unwrap();
        let settings = SettingsStore::new(&base);
        let projects = ProjectsStore::new(&base);
        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
        let agents = AgentManager::new(
            &base,
            std::sync::Arc::new(crate::config::get().expect("config").clone()),
            std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
            Ok(crate::runtime::PiRuntime {
                program: std::path::PathBuf::from("pi"),
                cli: None,
                agent_home: base.join("agent-home"),
            }),
            std::sync::Arc::new(SettingsStore::new(&base)),
            std::sync::Arc::new(ProjectsStore::new(&base)),
            tx,
        );
        let env = ToolEnv {
            agents: &agents,
            projects: &projects,
            settings: &settings,
            chat_id: "c1",
            user_initiated: false,
            state: None,
        };
        for tool in ["start_coding_agent", "steer_agent"] {
            let out = execute(&env, tool, &json!({}));
            assert!(
                out.contains("only start or change because the user asked"),
                "{tool}: {out}"
            );
        }
    }
}
