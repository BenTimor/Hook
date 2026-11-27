import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "@fontsource-variable/inter";
import "@fontsource-variable/jetbrains-mono";
import "./styles/tailwind.css";
import "@hook/ui/tokens.css";
import "./styles/index.css";

import App from "./App";
import { isMac } from "./lib/utils";

// The macOS window keeps its native title bar and traffic lights as an overlay
// (tauri.macos.conf.json), so the CSS hides the Windows buttons and leaves the
// top-left corner to the system. Windows keeps the frameless custom chrome.
document.documentElement.dataset.platform = isMac ? "mac" : "other";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
