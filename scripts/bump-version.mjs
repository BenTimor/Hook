#!/usr/bin/env node
/**
 * Bump the version everywhere a product is compiled from.
 *
 *   pnpm version:bump patch                        # the chat app
 *   pnpm version:bump minor --product workspace   # another product
 *   pnpm version:bump 1.4.0 --product workspace   # explicit
 *
 * Each product reports Cargo's version, names its installer after
 * tauri.conf.json's version, and the release manifest checks that package.json
 * agrees. All three (plus the matching Cargo.lock entry) move together here.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { productFromArgs } from "./products.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

function readVersion(product) {
  return JSON.parse(readFileSync(join(root, product.dir, "package.json"), "utf8"))
    .version;
}

function nextVersion(current, input) {
  if (/^\d+\.\d+\.\d+$/.test(input)) return input;
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(current);
  if (!match) throw new Error(`package.json version is not semver: ${current}`);
  const [major, minor, patch] = match.slice(1).map(Number);
  if (input === "patch") return `${major}.${minor}.${patch + 1}`;
  if (input === "minor") return `${major}.${minor + 1}.0`;
  if (input === "major") return `${major + 1}.0.0`;
  throw new Error("usage: pnpm version:bump <patch|minor|major|x.y.z> [--product id]");
}

function bumpProduct(product, next) {
  const packagePath = join(root, product.dir, "package.json");
  const cargoPath = join(root, product.dir, "src-tauri/Cargo.toml");
  const tauriPath = join(root, product.dir, "src-tauri/tauri.conf.json");

  const pkg = JSON.parse(readFileSync(packagePath, "utf8"));
  const current = pkg.version;
  pkg.version = next;
  writeFileSync(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);

  const cargoPattern = /(\[package\][\s\S]*?\r?\nversion\s*=\s*")[^"]+(")/;
  const cargo = readFileSync(cargoPath, "utf8");
  const cargoNext = cargo.replace(cargoPattern, `$1${next}$2`);
  if (cargoNext === cargo) {
    throw new Error(`could not find [package] version in ${cargoPath}`);
  }
  writeFileSync(cargoPath, cargoNext);

  const tauri = JSON.parse(readFileSync(tauriPath, "utf8"));
  tauri.version = next;
  writeFileSync(tauriPath, `${JSON.stringify(tauri, null, 2)}\n`);

  const crateName = /\[package\][\s\S]*?\r?\nname\s*=\s*"([^"]+)"/.exec(cargo)?.[1];
  const lockPath = join(root, "Cargo.lock");
  const lock = readFileSync(lockPath, "utf8");
  const lockNext = lock.replace(
    new RegExp(`(\\[\\[package\\]\\]\\r?\\nname = "${crateName}"\\r?\\nversion = ")[^"]+(")`),
    `$1${next}$2`,
  );
  if (lockNext === lock) {
    throw new Error(`could not find the ${crateName} package in ${lockPath}`);
  }
  writeFileSync(lockPath, lockNext);

  return { current, crateName };
}

const input = process.argv[2] ?? "";
const product = productFromArgs();
const current = readVersion(product);
const next = nextVersion(current, input);
if (next === current) throw new Error(`${product.name} is already at ${current}`);

const { crateName } = bumpProduct(product, next);

console.log(`${product.name} ${current} -> ${next} (${product.dir}, ${crateName})`);
console.log(
  "Next: update release.config.json if this release must force older builds, then commit and push.",
);
