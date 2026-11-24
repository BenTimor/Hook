#!/usr/bin/env bash
#
# Build and publish a desktop release from this machine.
#
#   pnpm release                    # every product whose source changed
#   pnpm release -- --product chat  # just one
#   pnpm release -- --dry-run       # build, merge the index, upload nothing
#   pnpm release -- --store         # also package the MSIX and print the submit
#   pnpm release -- --force         # build even if the source is unchanged
#   pnpm release -- --skip-checks   # for a release that changes no code path
#
# Why here and not in CI: a release is a deliberate act, and the Windows build
# it replaces ran on every push whether or not anything shipped. The checks stay
# in `.github/workflows/checks.yml`; the website deploys on a `deploy-*` tag.
#
# It refuses to release from anything but a clean, pushed `main`, refuses a
# version the index already has with different source, and runs the checks
# first. The installer is uploaded under its versioned name, the index is
# swapped last, so downloads keep working against the previous version.
#
# Environment (the same key the website deploy uses):
#   DEPLOY_HOST     default root@167.233.58.139
#   DEPLOY_KEY      default ~/.ssh/hetzner_root
#   RELEASES_DIR    default /opt/hook-web/data/releases
#
set -euo pipefail

cd "$(dirname "$0")/.."

HOST="${DEPLOY_HOST:-root@167.233.58.139}"
RELEASES_DIR="${RELEASES_DIR:-/opt/hook-web/data/releases}"
SSH_KEY="${DEPLOY_KEY:-$HOME/.ssh/hetzner_root}"
SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=10)
if [ -f "$SSH_KEY" ]; then SSH_OPTS+=(-i "$SSH_KEY"); fi

step() { printf '\n\033[1m→ %s\033[0m\n' "$1"; }
fail() { printf '\033[31m!! %s\033[0m\n' "$1" >&2; exit 1; }

PRODUCTS=()
DRY_RUN=0
STORE=0
SKIP_CHECKS=0
FORCE=0
NOTES=""

while [ $# -gt 0 ]; do
  case "$1" in
    --product) PRODUCTS+=("$2"); shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --store) STORE=1; shift ;;
    --skip-checks) SKIP_CHECKS=1; shift ;;
    --force) FORCE=1; shift ;;
    --notes) NOTES="$2"; shift 2 ;;
    -h|--help) sed -n '3,24p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) fail "unknown argument: $1" ;;
  esac
done
[ ${#PRODUCTS[@]} -gt 0 ] || PRODUCTS=(chat workspace)

# --- preflight -------------------------------------------------------------

step "Preflight"
branch=$(git rev-parse --abbrev-ref HEAD)
[ "$branch" = "main" ] || fail "releases come from main, not '$branch'"
git fetch --quiet origin main
head=$(git rev-parse HEAD)
[ "$head" = "$(git rev-parse origin/main)" ] || fail "HEAD is not origin/main — push first (or pull)"
if [ -n "$(git status --porcelain)" ]; then
  git status --short
  fail "the tree is dirty; the installer would not match the commit"
fi
echo "  main @ ${head:0:7}, clean"

# The executable compiles `harness.config.toml` in (`include_str!`). CI copies
# the committed proxy config into that slot before building; a local release has
# to do the same or it ships whatever provider this machine develops against.
CONFIG=harness.config.toml
CONFIG_BACKUP=""
CONFIG_CREATED=0
restore_config() {
  if [ -n "$CONFIG_BACKUP" ]; then
    mv -f "$CONFIG_BACKUP" "$CONFIG"
  elif [ "$CONFIG_CREATED" = 1 ]; then
    rm -f "$CONFIG"
  fi
}
trap restore_config EXIT
if [ -f "$CONFIG" ] && ! cmp -s "$CONFIG" harness.config.ci.toml; then
  CONFIG_BACKUP=$(mktemp)
  cp "$CONFIG" "$CONFIG_BACKUP"
  echo "  building with harness.config.ci.toml (local harness.config.toml restored afterwards)"
elif [ ! -f "$CONFIG" ]; then
  CONFIG_CREATED=1
fi
cp harness.config.ci.toml "$CONFIG"

# --- checks ----------------------------------------------------------------

if [ "$SKIP_CHECKS" = 1 ]; then
  step "Checks skipped (--skip-checks)"
else
  step "Checks"
  pnpm typecheck
  pnpm test:release
  pnpm test:markdown
  cargo test -p hook-core
fi

# --- build and publish -----------------------------------------------------

upload_release() {
  local exe="$1" manifest_file="$2" index_file="$3" glob="$4" with_latest="$5"
  # `index_file` is the name the server stores; the copy to read is local, under
  # `release/`. Requiring it by its bare name resolved against the repo root and
  # failed before anything was uploaded.
  local index_path="release/$index_file"
  [ -f "$index_path" ] || fail "no release index at $index_path"
  local keep
  keep=$(node -e "const i=require('./${index_path}'); process.stdout.write(Object.values(i.releases).map((r) => r.file).join(' '))")
  [ -n "$keep" ] || fail "$index_path names no installers to keep"
  ssh "${SSH_OPTS[@]}" "$HOST" "mkdir -p '$RELEASES_DIR' && chmod 755 '$RELEASES_DIR'"
  scp "${SSH_OPTS[@]}" "release/$exe" "$HOST:$RELEASES_DIR/$exe.new"
  if [ "$with_latest" = 1 ]; then
    scp "${SSH_OPTS[@]}" "release/$manifest_file" "$HOST:$RELEASES_DIR/$manifest_file.new"
  fi
  scp "${SSH_OPTS[@]}" "release/$index_file" "$HOST:$RELEASES_DIR/$index_file.new"
  ssh "${SSH_OPTS[@]}" "$HOST" \
    "DIR='$RELEASES_DIR' EXE='$exe' INDEX='$index_file' MANIFEST='$manifest_file' KEEP='$keep' GLOB='$glob' WITH_LATEST='$with_latest' bash -s" <<'REMOTE'
set -euo pipefail
cd "$DIR"
chmod 644 "$EXE.new" "$INDEX.new"
mv "$EXE.new" "$EXE"
if [ "$WITH_LATEST" = 1 ]; then
  chmod 644 "$MANIFEST.new"
  mv "$MANIFEST.new" "$MANIFEST"
fi
# The atomic switch: from here on the new version is what /api/releases reports
# and what new downloads receive.
mv "$INDEX.new" "$INDEX"
# Keep exactly the installers the published index references. The other
# product's installers share this folder and are never touched here.
for file in $GLOB; do
  [ -e "$file" ] || continue
  case " $KEEP " in
    *" $file "*) ;;
    *) rm -f "$file" ;;
  esac
done
ls -lh "$INDEX" *.exe
REMOTE
}

released=""
for id in "${PRODUCTS[@]}"; do
  case "$id" in
    chat)
      build_cmd=(pnpm app:build)
      stem=Hook
      manifest=release/latest.json
      index=release/releases.json
      glob='Hook-[0-9]*.exe'
      upload_latest=1
      gate_args=(--product chat)
      product_args=()
      ;;
    workspace)
      build_cmd=(pnpm workspace:app:build)
      stem=Hook-Workspace
      manifest=release/latest-workspace.json
      index=release/releases.workspace.json
      glob='Hook-Workspace-*.exe'
      upload_latest=0
      gate_args=(--product workspace)
      product_args=(--product workspace)
      ;;
    *) fail "unknown product: $id" ;;
  esac

  if [ "$FORCE" = 1 ]; then gate_args+=(--force); fi

  gate_out=$(mktemp)
  if ! GITHUB_OUTPUT="$gate_out" node scripts/release-gate.mjs "${gate_args[@]}"; then
    rm -f "$gate_out"
    fail "the release gate refused $id (see above)"
  fi
  publish=$(sed -n 's/^publish=//p' "$gate_out")
  version=$(sed -n 's/^version=//p' "$gate_out")
  hash=$(sed -n 's/^source_hash=//p' "$gate_out")
  rm -f "$gate_out"

  if [ "$publish" != "true" ]; then
    step "$id $version: nothing new to release"
    continue
  fi

  step "$id $version: building"
  "${build_cmd[@]}"

  mkdir -p release
  built=$(ls -t target/release/bundle/nsis/*.exe 2>/dev/null | head -1 || true)
  [ -n "$built" ] || fail "Tauri produced no NSIS installer for $id"
  exe_name="$stem-$version-setup.exe"
  cp -f "$built" "release/$exe_name"
  echo "  $(basename "$built") -> release/$exe_name ($(du -h "release/$exe_name" | cut -f1))"

  HOOK_COMMIT="$(git rev-parse HEAD)" \
  HOOK_RELEASE_NOTES="${NOTES:-$(git log -1 --format=%s)}" \
  HOOK_SOURCE_HASH="$hash" \
    node scripts/build-release-manifest.mjs "release/$exe_name" "$manifest" "${product_args[@]}"

  node scripts/merge-release-index.mjs \
    --manifest "$manifest" --out "$index" --server https://hookcode.io --keep 5 "${product_args[@]}"

  if [ "$DRY_RUN" = 1 ]; then
    step "$id $version: dry run, not uploading"
  else
    step "$id $version: publishing"
    upload_release "$exe_name" "$(basename "$manifest")" "$(basename "$index")" "$glob" "$upload_latest"
    released="$released $id@$version"
  fi

  if [ "$STORE" = 1 ]; then
    step "$id $version: Microsoft Store package"
    node scripts/build-msix.mjs --product "$id"
    msix="release/$stem-$version-x64.msix"
    if [ -f "$msix" ]; then
      echo "  submit it when you are ready (--noCommit keeps it a draft):"
      if [ "$id" = "chat" ]; then
        store_id=$(sed -n 's/^store_id = "\([^"]*\)"/\1/p' harness.config.ci.toml | head -1)
        echo "    msstore publish . --inputFile $msix --appId ${store_id:-<product-id>} --noCommit"
      else
        echo "    no Store product id yet — reserve the app in Partner Center first"
      fi
      echo "  after certification: set store.latest in release.config.json and push"
    fi
  fi
done

if [ -z "$released" ] && [ "$DRY_RUN" = 0 ]; then
  printf '\n\033[32m✓ Nothing to release\033[0m\n'
else
  printf '\n\033[32m✓%s\033[0m\n' "${released:- (dry run)}"
fi
