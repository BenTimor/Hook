import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tauri expects a fixed port and no screen clearing so Rust logs stay visible.
// 1421 rather than 1420 so the phone and the desktop app can run at once.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1421,
    strictPort: true,
    host: "127.0.0.1",
    watch: { ignored: ["**/src-tauri/**"] },
  },
  build: {
    // WebView on Android is Chrome 110+ on the supported floor (Android 10);
    // iOS 15+ WKWebView tracks Safari, which is newer still.
    target: "chrome110",
    sourcemap: false,
    chunkSizeWarningLimit: 1500,
  },
});
