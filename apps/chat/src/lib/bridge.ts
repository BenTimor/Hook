import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import { mock } from "./mock";
import type {
  AgentTranscript,
  AgentsOverview,
  AppInfo,
  AuthView,
  Chat,
  ChatEvent,
  ChatMeta,
  ContentReport,
  DeviceView,
  DevicesView,
  ImportPreview,
  ImportProgress,
  ImportSummary,
  MemoryView,
  PreviewEvent,
  PreviewView,
  RemoteProject,
  ReportRequest,
  SearchHit,
  SettingsView,
  StreamEvent,
  SyncEvent,
  SyncView,
  UpdateEvent,
  UpdateInfo,
} from "./types";

import { isTauri } from "@hook/ui";

export { isTauri, win } from "@hook/ui";

type ChatListener = (chatId: string, event: StreamEvent) => void;
type AgentsListener = (overview: AgentsOverview) => void;
type PreviewListener = (preview: PreviewEvent) => void;
type AuthListener = (view: AuthView) => void;
type UpdateListener = (event: UpdateEvent) => void;
type SyncListener = (event: SyncEvent) => void;
type DevicesListener = (view: DevicesView) => void;
type ImportListener = (event: ImportProgress) => void;

const chatListeners = new Set<ChatListener>();
const agentsListeners = new Set<AgentsListener>();
const previewListeners = new Set<PreviewListener>();
const authListeners = new Set<AuthListener>();
const updateListeners = new Set<UpdateListener>();
const syncListeners = new Set<SyncListener>();
const devicesListeners = new Set<DevicesListener>();
const importListeners = new Set<ImportListener>();

function dispatch(chatId: string, event: StreamEvent) {
  for (const listener of chatListeners) listener(chatId, event);
}

/**
 * Every turn — user-sent or woken by a coding agent — arrives on the same
 * app-wide event, so the UI never has to hold a per-call channel.
 */
export function onChatEvent(listener: ChatListener): () => void {
  if (!isTauri()) {
    chatListeners.add(listener);
    return () => chatListeners.delete(listener);
  }
  let off: (() => void) | null = null;
  let cancelled = false;
  void listen<ChatEvent>("hook://chat", (event) =>
    listener(event.payload.chatId, event.payload.event),
  ).then((unlisten) => {
    if (cancelled) unlisten();
    else off = unlisten;
  });
  return () => {
    cancelled = true;
    off?.();
  };
}

export function onAgentsEvent(listener: AgentsListener): () => void {
  if (!isTauri()) {
    agentsListeners.add(listener);
    return () => agentsListeners.delete(listener);
  }
  let off: (() => void) | null = null;
  let cancelled = false;
  void listen<AgentsOverview>("hook://agents", (event) =>
    listener(event.payload),
  ).then((unlisten) => {
    if (cancelled) unlisten();
    else off = unlisten;
  });
  return () => {
    cancelled = true;
    off?.();
  };
}

/**
 * The preview panel is a sidecar of the app, not of one chat: the backend
 * keeps at most one page open and announces the page being shown, every
 * refresh, the run settling (no more auto-refresh) and when the panel closes.
 */
export function onPreviewEvent(listener: PreviewListener): () => void {
  if (!isTauri()) {
    previewListeners.add(listener);
    return () => previewListeners.delete(listener);
  }
  let off: (() => void) | null = null;
  let cancelled = false;
  void listen<PreviewEvent>("hook://preview", (event) =>
    listener(event.payload),
  ).then((unlisten) => {
    if (cancelled) unlisten();
    else off = unlisten;
  });
  return () => {
    cancelled = true;
    off?.();
  };
}

/**
 * Sign-in state changes: pending while the browser approval is open, then
 * signed_in, cancelled or signed_out after a revocation.
 */
export function onAuthEvent(listener: AuthListener): () => void {
  if (!isTauri()) {
    authListeners.add(listener);
    return () => authListeners.delete(listener);
  }
  let off: (() => void) | null = null;
  let cancelled = false;
  void listen<AuthView>("hook://auth", (event) => listener(event.payload)).then(
    (unlisten) => {
      if (cancelled) unlisten();
      else off = unlisten;
    },
  );
  return () => {
    cancelled = true;
    off?.();
  };
}

/**
 * The relay's view changed: a machine connected or went away, or this device
 * lost its own connection. The Settings sheet and the machine picker read it.
 */
export function onDevicesEvent(listener: DevicesListener): () => void {
  if (!isTauri()) {
    devicesListeners.add(listener);
    return () => devicesListeners.delete(listener);
  }
  let off: (() => void) | null = null;
  let cancelled = false;
  void listen<DevicesView>("hook://devices", (event) =>
    listener(event.payload),
  ).then((unlisten) => {
    if (cancelled) unlisten();
    else off = unlisten;
  });
  return () => {
    cancelled = true;
    off?.();
  };
}

/**
 * The background sync applied something from the account. `chats` means the
 * list or a conversation changed; `projects` means a project was created here.
 */
export function onSyncEvent(listener: SyncListener): () => void {
  if (!isTauri()) {
    syncListeners.add(listener);
    return () => syncListeners.delete(listener);
  }
  let off: (() => void) | null = null;
  let cancelled = false;
  void listen<SyncEvent>("hook://sync", (event) => listener(event.payload)).then(
    (unlisten) => {
      if (cancelled) unlisten();
      else off = unlisten;
    },
  );
  return () => {
    cancelled = true;
    off?.();
  };
}

/**
 * How far an import has got. One event per hundred conversations, plus a final
 * `done`, so a big export does not flood the window.
 */
export function onImportEvent(listener: ImportListener): () => void {
  if (!isTauri()) {
    importListeners.add(listener);
    return () => importListeners.delete(listener);
  }
  let off: (() => void) | null = null;
  let cancelled = false;
  void listen<ImportProgress>("hook://import", (event) =>
    listener(event.payload),
  ).then((unlisten) => {
    if (cancelled) unlisten();
    else off = unlisten;
  });
  return () => {
    cancelled = true;
    off?.();
  };
}

/** Download progress for an in-app update. The app exits when it is installed. */
export function onUpdateEvent(listener: UpdateListener): () => void {
  if (!isTauri()) {
    updateListeners.add(listener);
    return () => updateListeners.delete(listener);
  }
  let off: (() => void) | null = null;
  let cancelled = false;
  void listen<UpdateEvent>("hook://update", (event) => listener(event.payload)).then(
    (unlisten) => {
      if (cancelled) unlisten();
      else off = unlisten;
    },
  );
  return () => {
    cancelled = true;
    off?.();
  };
}

/** Browser preview: the in-memory backend replays turns through the same bus. */
async function streamMock(
  command: string,
  args: Record<string, unknown>,
): Promise<string> {
  let chatId = typeof args.chatId === "string" ? args.chatId : "";
  return mock.stream(command, args, (event) => {
    if ("meta" in event) chatId = event.meta.id;
    dispatch(chatId, event);
  });
}

export const api = {
  appInfo: (): Promise<AppInfo> =>
    isTauri() ? invoke<AppInfo>("app_info") : mock.appInfo(),

  authStatus: (): Promise<AuthView> =>
    isTauri() ? invoke<AuthView>("auth_status") : mock.authStatus(),

  authLogin: (): Promise<AuthView> =>
    isTauri() ? invoke<AuthView>("auth_login") : mock.authLogin(),

  authCancelLogin: (): Promise<AuthView> =>
    isTauri() ? invoke<AuthView>("auth_cancel_login") : mock.authCancelLogin(),

  authRefresh: (): Promise<AuthView> =>
    isTauri() ? invoke<AuthView>("auth_refresh") : mock.authRefresh(),

  authLogout: (): Promise<AuthView> =>
    isTauri() ? invoke<AuthView>("auth_logout") : mock.authLogout(),

  listChats: (): Promise<ChatMeta[]> =>
    isTauri() ? invoke<ChatMeta[]>("list_chats") : mock.listChats(),

  getChat: (chatId: string): Promise<Chat> =>
    isTauri() ? invoke<Chat>("get_chat", { chatId }) : mock.getChat(chatId),

  renameChat: (chatId: string, title: string): Promise<ChatMeta> =>
    isTauri()
      ? invoke<ChatMeta>("rename_chat", { chatId, title })
      : mock.renameChat(chatId, title),

  setPinned: (chatId: string, pinned: boolean): Promise<ChatMeta> =>
    isTauri()
      ? invoke<ChatMeta>("set_pinned", { chatId, pinned })
      : mock.setPinned(chatId, pinned),

  deleteChat: (chatId: string): Promise<void> =>
    isTauri() ? invoke<void>("delete_chat", { chatId }) : mock.deleteChat(chatId),

  restoreChat: (chatId: string): Promise<ChatMeta> =>
    isTauri()
      ? invoke<ChatMeta>("restore_chat", { chatId })
      : mock.restoreChat(chatId),

  searchChats: (query: string): Promise<SearchHit[]> =>
    isTauri()
      ? invoke<SearchHit[]>("search_chats", { query })
      : mock.searchChats(query),

  sendMessage: (
    chatId: string | null,
    text: string,
    images: { dataUrl: string; width: number; height: number }[] = [],
  ): Promise<string> =>
    isTauri()
      ? invoke<string>("send_message", { chatId, text, images })
      : streamMock("send_message", { chatId, text, images }),

  readImage: (chatId: string, attachmentId: string): Promise<string> =>
    isTauri()
      ? invoke<string>("read_image", { chatId, attachmentId })
      : mock.readImage(chatId, attachmentId),

  openImage: (chatId: string, attachmentId: string): Promise<void> =>
    isTauri()
      ? invoke<void>("open_image", { chatId, attachmentId })
      : Promise.resolve(),

  saveImageAs: (
    chatId: string,
    attachmentId: string,
    suggestedName: string,
  ): Promise<boolean> =>
    isTauri()
      ? invoke<boolean>("save_image_as", { chatId, attachmentId, suggestedName })
      : Promise.resolve(false),

  regenerate: (chatId: string): Promise<void> =>
    isTauri()
      ? invoke<void>("regenerate", { chatId })
      : streamMock("regenerate", { chatId }).then(() => undefined),

  editMessage: (chatId: string, messageId: string, text: string): Promise<void> =>
    isTauri()
      ? invoke<void>("edit_message", { chatId, messageId, text })
      : streamMock("edit_message", { chatId, messageId, text }).then(() => undefined),

  stopStream: (chatId: string): Promise<void> =>
    isTauri()
      ? invoke<void>("stop_stream", { chatId })
      : mock.stopStream(chatId),

  getSettings: (): Promise<SettingsView> =>
    isTauri() ? invoke<SettingsView>("get_settings") : mock.getSettings(),

  setProjectsDir: (path: string): Promise<SettingsView> =>
    isTauri()
      ? invoke<SettingsView>("set_projects_dir", { path })
      : mock.setProjectsDir(path),

  setAdvancedMode: (enabled: boolean): Promise<SettingsView> =>
    isTauri()
      ? invoke<SettingsView>("set_advanced_mode", { enabled })
      : mock.setAdvancedMode(enabled),

  /**
   * The account-wide cloud-sync switch. It is stored on the account, so this
   * also turns sync off in Hook Workspace and on the phone.
   */
  setCloudSync: (enabled: boolean): Promise<SettingsView> =>
    isTauri()
      ? invoke<SettingsView>("set_cloud_sync", { enabled })
      : mock.setCloudSync(enabled),

  /**
   * Save the user's own model endpoint for this product. The key is written to
   * this product's settings file only; leave `apiKey` empty to keep the key
   * already stored.
   */
  setCustomProvider: (
    baseUrl: string,
    apiKey: string,
    model: string,
  ): Promise<SettingsView> =>
    isTauri()
      ? invoke<SettingsView>("set_custom_provider", { baseUrl, apiKey, model })
      : mock.setCustomProvider(baseUrl, apiKey, model),

  clearCustomProvider: (): Promise<SettingsView> =>
    isTauri()
      ? invoke<SettingsView>("clear_custom_provider")
      : mock.clearCustomProvider(),

  /** Ask a personal endpoint which models it offers. Errors are shown inline. */
  customModels: (baseUrl: string, apiKey: string): Promise<string[]> =>
    isTauri()
      ? invoke<string[]>("custom_models", {
          baseUrl: baseUrl || null,
          apiKey: apiKey || null,
        })
      : mock.customModels(baseUrl, apiKey),

  openPath: (path: string): Promise<void> =>
    isTauri() ? invoke<void>("open_path", { path }) : Promise.resolve(),

  agentsOverview: (): Promise<AgentsOverview> =>
    isTauri() ? invoke<AgentsOverview>("agents_overview") : mock.agentsOverview(),

  agentTranscript: (agentId: string): Promise<AgentTranscript> =>
    isTauri()
      ? invoke<AgentTranscript>("agent_transcript", { agentId })
      : mock.agentTranscript(agentId),

  checkUpdate: (): Promise<UpdateInfo> =>
    isTauri() ? invoke<UpdateInfo>("check_update") : mock.checkUpdate(),

  installUpdate: (): Promise<void> =>
    isTauri() ? invoke<void>("install_update") : mock.installUpdate(),

  openStoreUpdate: (): Promise<void> =>
    isTauri() ? invoke<void>("open_store_update") : mock.openStoreUpdate(),

  reportMessage: (payload: ReportRequest): Promise<void> =>
    isTauri()
      ? invoke<void>("report_message", { payload })
      : mock.reportMessage(),

  /** Flag a task, document or board shown in the preview (user-generated text). */
  reportContent: (payload: ContentReport): Promise<void> =>
    isTauri()
      ? invoke<void>("report_content", { payload })
      : mock.reportContent(),

  previewState: (): Promise<PreviewView | null> =>
    isTauri()
      ? invoke<PreviewView | null>("preview_state")
      : mock.previewState(),

  memoryList: (): Promise<MemoryView> =>
    isTauri() ? invoke<MemoryView>("memory_list") : mock.memoryList(),

  memorySave: (text: string, pinned: boolean): Promise<MemoryView> =>
    isTauri()
      ? invoke<MemoryView>("memory_save", { text, pinned })
      : mock.memorySave(text, pinned),

  memoryUpdate: (
    id: string,
    text: string | null,
    pinned: boolean | null,
  ): Promise<MemoryView> =>
    isTauri()
      ? invoke<MemoryView>("memory_update", { id, text, pinned })
      : mock.memoryUpdate(id, text, pinned),

  memoryDelete: (id: string): Promise<MemoryView> =>
    isTauri()
      ? invoke<MemoryView>("memory_delete", { id })
      : mock.memoryDelete(id),

  memoryClear: (): Promise<MemoryView> =>
    isTauri() ? invoke<MemoryView>("memory_clear") : mock.memoryClear(),

  memorySetEnabled: (enabled: boolean): Promise<MemoryView> =>
    isTauri()
      ? invoke<MemoryView>("memory_set_enabled", { enabled })
      : mock.memorySetEnabled(enabled),

  syncStatus: (): Promise<SyncView> =>
    isTauri() ? invoke<SyncView>("sync_status") : mock.syncStatus(),

  /** The account's machines and this device's relay state. */
  devices: (): Promise<DevicesView> =>
    isTauri() ? invoke<DevicesView>("devices_list") : mock.devices(),

  subscribeChat: (chatId: string): Promise<void> =>
    isTauri() ? invoke<void>("subscribe_chat", { chatId }) : Promise.resolve(),

  unsubscribeChat: (chatId: string): Promise<void> =>
    isTauri() ? invoke<void>("unsubscribe_chat", { chatId }) : Promise.resolve(),

  renameDevice: (deviceId: string, name: string): Promise<DeviceView> =>
    isTauri()
      ? invoke<DeviceView>("device_rename", { deviceId, name })
      : mock.renameDevice(deviceId, name),

  setDeviceRemote: (deviceId: string, allowed: boolean): Promise<DeviceView> =>
    isTauri()
      ? invoke<DeviceView>("device_set_remote", { deviceId, allowed })
      : mock.setDeviceRemote(deviceId, allowed),

  removeDevice: (deviceId: string): Promise<void> =>
    isTauri()
      ? invoke<void>("device_remove", { deviceId })
      : mock.removeDevice(deviceId),

  syncNow: (): Promise<void> =>
    isTauri() ? invoke<void>("sync_now") : mock.syncNow(),


  stopChatAgents: (chatId: string): Promise<AgentsOverview> =>
    isTauri()
      ? invoke<AgentsOverview>("stop_chat_agents", { chatId })
      : mock.stopChatAgents(),

  stopRemoteAgent: (deviceId: string, agentId: string): Promise<void> =>
    isTauri()
      ? invoke<void>("stop_remote_agent", { deviceId, agentId })
      : Promise.resolve(),

  /** Start a conversation with a coding agent in a folder the user picked. */
  createCodingChat: (folder: string): Promise<ChatMeta> =>
    isTauri()
      ? invoke<ChatMeta>("create_coding_chat", { folder })
      : mock.createCodingChat(folder),

  /** Point an existing coding chat at a different folder. */
  setCodingChatFolder: (chatId: string, folder: string): Promise<ChatMeta> =>
    isTauri()
      ? invoke<ChatMeta>("set_coding_chat_folder", { chatId, folder })
      : mock.setCodingChatFolder(chatId, folder),

  /** Create a direct coding chat on another machine. */
  createRemoteCodingChat: (
    deviceId: string,
    project: string,
  ): Promise<ChatMeta> =>
    isTauri()
      ? invoke<ChatMeta>("create_remote_coding_chat", { deviceId, project })
      : mock.createRemoteCodingChat(deviceId, project),

  /** Read the transcript from the machine that owns a cached chat. */
  fetchRemoteChat: (chatId: string): Promise<Chat> =>
    isTauri()
      ? invoke<Chat>("fetch_remote_chat", { chatId })
      : mock.fetchRemoteChat(chatId),

  /** The projects a machine offers for a direct coding chat. */
  remoteProjects: (deviceId: string): Promise<RemoteProject[]> =>
    isTauri()
      ? invoke<RemoteProject[]>("remote_projects", { deviceId })
      : mock.remoteProjects(deviceId),

  /** Create a project folder on another machine. */
  createRemoteProject: (
    deviceId: string,
    name: string,
    description = "",
  ): Promise<RemoteProject> =>
    isTauri()
      ? invoke<RemoteProject>("remote_create_project", {
          deviceId,
          name,
          description,
        })
      : mock.createRemoteProject(deviceId, name, description),

  /** Answer a question a directly-driven coding agent is blocked on. */
  answerCodingAgent: (chatId: string, answer: string): Promise<void> =>
    isTauri()
      ? invoke<void>("answer_coding_agent", { chatId, answer })
      : mock.answerCodingAgent(),

  /** Read an export and report what importing it would do. Writes nothing. */
  importScan: (path: string): Promise<ImportPreview> =>
    isTauri()
      ? invoke<ImportPreview>("import_scan", { path })
      : mock.importScan(path),

  /** Write the conversations a scan counted. */
  importApply: (path: string): Promise<ImportSummary> =>
    isTauri()
      ? invoke<ImportSummary>("import_apply", { path })
      : mock.importApply(path),

  async pickImportFile(vendor: "chatgpt" | "claude"): Promise<string | null> {
    if (!isTauri()) return `${vendor}-export.zip`;
    const { open } = await import("@tauri-apps/plugin-dialog");
    const picked = await open({
      multiple: false,
      directory: false,
      title: "Choose the export you downloaded",
      filters: [{ name: "Conversation export", extensions: ["zip", "json"] }],
    });
    return typeof picked === "string" ? picked : null;
  },

  async pickFolder(title = "Choose a folder for your projects"): Promise<string | null> {
    if (!isTauri()) return "C:/Users/you/Documents/Hook/site";
    const { open } = await import("@tauri-apps/plugin-dialog");
    const picked = await open({
      directory: true,
      multiple: false,
      title,
    });
    return typeof picked === "string" ? picked : null;
  },
};


export async function openExternal(url: string): Promise<void> {
  if (!isTauri()) {
    window.open(url, "_blank", "noopener,noreferrer");
    return;
  }
  try {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url);
  } catch {
    /* ignore malformed or blocked links */
  }
}
