import { Workspace } from "../../workspace/src/App";
import type { AuthView } from "../../workspace/src/lib/bridge";

import { isMac } from "./lib/utils";
import type { AuthView as ChatAuthView } from "./lib/types";

/**
 * Hook Workspace, rendered inside the chat window.
 *
 * This is the Workspace product's own `Workspace` tree — its store, boards,
 * documents, properties, templates, editor and preferences — not a second
 * implementation of any of them. What the chat product adds is the window it
 * lives in: the Windows buttons stay on Windows, the native traffic lights are
 * left to macOS, and a Chat row tops the rail so the halves switch in place.
 */
export function WorkspaceView({
  auth,
  maximized,
  onChat,
  onAuth,
}: {
  auth: ChatAuthView;
  maximized: boolean;
  onChat: () => void;
  onAuth: (view: ChatAuthView) => void;
}) {
  return (
    <Workspace
      auth={auth}
      setAuth={(view: AuthView) => onAuth(view as ChatAuthView)}
      maximized={maximized}
      windowControls={!isMac}
      onChat={onChat}
    />
  );
}
