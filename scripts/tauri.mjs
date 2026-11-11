import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";

const cargoBin = resolve(process.env.CARGO_HOME || join(homedir(), ".cargo"), "bin");
const cargoExecutable = process.platform === "win32" ? "cargo.exe" : "cargo";
const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === "path") || "PATH";

// Existing terminals can retain the PATH from before Rust was installed.
// Append the install location so any toolchain already on PATH keeps priority.
if (existsSync(join(cargoBin, cargoExecutable))) {
  process.env[pathKey] = [process.env[pathKey], cargoBin].filter(Boolean).join(delimiter);
}

await import("@tauri-apps/cli/tauri.js");
