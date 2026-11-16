#!/usr/bin/env node
/**
 * Bump the version everywhere it is compiled from.
 *
 *   pnpm version:bump patch     # 0.1.0 -> 0.1.1
 *   pnpm version:bump minor     # 0.1.0 -> 0.2.0
 *   pnpm version:bump 1.4.0     # explicit
 *
 * The desktop app reports Cargo's version, the installer is named after
 * tauri.conf.json's version, and the release manifest validates that
 * package.json agrees. All three (plus Cargo.lock) move together here.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const packagePath = resolve(root, "package.json");
const cargoPath = resolve(root, "src-tauri/Cargo.toml");
const lockPath = resolve(root, "src-tauri/Cargo.lock");
const tauriPath = resolve(root, "src-tauri/tauri.conf.json");

const pkg = JSON.parse(readFileSync(packagePath, "utf8"));
const current = pkg.version;

function nextVersion(input) {
  if (/^\d+\.\d+\.\d+$/.test(input)) return input;
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(current);
  if (!match) throw new Error(`package.json version is not semver: ${current}`);
  const [major, minor, patch] = match.slice(1).map(Number);
  if (input === "patch") return `${major}.${minor}.${patch + 1}`;
  if (input === "minor") return `${major}.${minor + 1}.0`;
  if (input === "major") return `${major + 1}.0.0`;
  throw new Error("usage: pnpm version:bump <patch|minor|major|x.y.z>");
}

const next = nextVersion(process.argv[2] ?? "");
if (next === current) throw new Error(`already at ${current}`);

pkg.version = next;
writeFileSync(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);

const cargoPattern = /(\[package\][\s\S]*?\r?\nversion\s*=\s*")[^"]+(")/;
const cargo = readFileSync(cargoPath, "utf8");
const cargoNext = cargo.replace(cargoPattern, `$1${next}$2`);
if (cargoNext === cargo) throw new Error(`could not find [package] version in ${cargoPath}`);
writeFileSync(cargoPath, cargoNext);

const tauri = JSON.parse(readFileSync(tauriPath, "utf8"));
tauri.version = next;
writeFileSync(tauriPath, `${JSON.stringify(tauri, null, 2)}\n`);

const lock = readFileSync(lockPath, "utf8");
const lockNext = lock.replace(
  /(\[\[package\]\]\r?\nname = "hook"\r?\nversion = ")[^"]+(")/,
  `$1${next}$2`,
);
if (lockNext === lock) throw new Error(`could not find the hook package in ${lockPath}`);
writeFileSync(lockPath, lockNext);

console.log(`Hook ${current} -> ${next}`);
console.log(
  "Next: update release.config.json if this release must force older builds, then commit and push.",
);
