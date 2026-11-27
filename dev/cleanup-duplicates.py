"""One-off cleanup of the duplicated project folders a pre-0.3.1 sync bug left
behind ("site", "site (2)", "site (2) (2)", …). Dry run by default.

    python dev/cleanup-duplicates.py           # print what it would do
    python dev/cleanup-duplicates.py --apply   # remove empty folders, notes, rows

Only a folder that holds no files is removed, the keeper of each group is the
folder at the project's own name, and the account rows that belong to the
duplicates are deleted through /api/sync/projects so no product rebuilds them.
"""

import json
import os
import re
import shutil
import sys
import urllib.request

APPLY = "--apply" in sys.argv
APPDATA = os.environ["APPDATA"]
PROJECTS = os.path.join(os.environ["USERPROFILE"], "Documents", "Hook")
PRODUCTS = [
    "app.hook.chat",
    "app.hook.workspace",
    "app.hook.browser",
    "hook-dev/app.hook.chat",
    "hook-dev/app.hook.workspace",
]
API = "https://hookcode.io/api"


def base_name(folder):
    return re.sub(r"( \(2\))+$", "", folder)


def folder_of(note):
    return os.path.basename(note["path"])


def account_projects(token):
    live, since = [], 0
    while True:
        request = urllib.request.Request(
            f"{API}/sync/changes?since={since}&limit=100",
            headers={"Authorization": f"Bearer {token}"},
        )
        with urllib.request.urlopen(request, timeout=60) as response:
            page = json.load(response)
        for change in page["changes"]:
            if change["kind"] == "project" and not change.get("deleted"):
                live.append({"id": change["id"], "name": change.get("name") or ""})
        cursor = page.get("cursor", since)
        if not page.get("hasMore") or cursor == since:
            return live
        since = cursor


def tombstones(token, ids):
    landed, failed = [], []
    for start in range(0, len(ids), 10):
        batch = ids[start : start + 10]
        body = json.dumps(
            {"projects": [{"id": item, "deleted": True} for item in batch]}
        ).encode()
        request = urllib.request.Request(
            f"{API}/sync/projects",
            data=body,
            method="POST",
            headers={
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json",
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                answer = json.load(response)
        except Exception as error:  # noqa: BLE001 - report, do not half-delete
            failed.extend(batch)
            print(f"  ! batch failed: {error}")
            continue
        for result in answer.get("results", []):
            if result.get("ok"):
                landed.append(result["id"])
            else:
                failed.append(result["id"])
    return landed, failed


def main():
    token = json.load(open(os.path.join(APPDATA, "app.hook.chat", "auth.json")))["token"]
    live = account_projects(token)
    by_id = {project["id"]: project for project in live}
    by_name = {project["name"]: project for project in live}

    # The folder at the project's own name is the keeper; every "name (n)"
    # beside it is a duplicate the bug made.
    folders = {}
    for entry in sorted(os.listdir(PROJECTS)):
        path = os.path.join(PROJECTS, entry)
        if os.path.isdir(path) and not entry.startswith("."):
            folders.setdefault(base_name(entry), []).append(entry)
    keepers = {base: base for base, names in folders.items() if base in names}
    doomed = {
        name: os.path.join(PROJECTS, name)
        for base, names in folders.items()
        for name in names
        if keepers.get(base) != name
    }

    print(f"{len(folders)} project groups, {len(keepers)} keepers, {len(doomed)} duplicates")
    unsafe = [name for name, path in doomed.items() if os.listdir(path)]
    if unsafe:
        print("refusing: these duplicates are not empty:", unsafe)
        return 1

    # Which account rows belong to the duplicates: the notes that point at each
    # doomed folder. A note's id is what the account knows the project by.
    doomed_ids = {}
    repairs = []
    for product in PRODUCTS:
        path = os.path.join(APPDATA, product, "projects.json")
        if not os.path.exists(path):
            continue
        with open(path, encoding="utf-8") as handle:
            notes = json.load(handle)["projects"]
        for note in notes:
            folder = folder_of(note)
            if folder in doomed and note.get("id") in by_id:
                doomed_ids.setdefault(note["id"], set()).add(product)
            if folder in keepers:
                wanted = by_name.get(folder)
                if wanted and note.get("id") != wanted["id"]:
                    repairs.append((product, folder, note.get("id"), wanted["id"]))
    # A keeper's own row is never deleted, whichever note happened to hold it:
    # the chat product's note for "site" was bound to a local-only id, while the
    # account's "site" row was held by the empty "site (2)" note beside it.
    keeper_ids = {by_name[folder]["id"] for folder in keepers if folder in by_name}
    for project_id in list(doomed_ids):
        if project_id in keeper_ids:
            doomed_ids.pop(project_id, None)
    print(f"{len(doomed_ids)} account rows to delete")
    for product, folder, old, new in repairs:
        print(f"  repair {product}: {folder} {old} -> {new}")

    if not APPLY:
        for name in doomed:
            print(f"  would remove {name}")
        for project_id, products in doomed_ids.items():
            print(f"  would delete row {project_id} ({by_id[project_id]['name']}) from {sorted(products)}")
        return 0

    landed, failed = tombstones(token, sorted(doomed_ids))
    print(f"deleted {len(landed)} account rows, {len(failed)} failed")
    if failed:
        print("  queued locally instead:", failed)

    # The folders, then the notes that point at them, then the stale ids each
    # product remembered about them.
    for name, path in doomed.items():
        try:
            os.rmdir(path)
        except OSError as error:
            print(f"  ! could not remove {name}: {error}")
            continue
        print(f"  removed folder {name}")
    gone = set(doomed)
    for product in PRODUCTS:
        path = os.path.join(APPDATA, product, "projects.json")
        if not os.path.exists(path):
            continue
        with open(path, encoding="utf-8") as handle:
            document = json.load(handle)
        before = len(document["projects"])
        kept = []
        for note in document["projects"]:
            folder = folder_of(note)
            if folder in gone:
                continue
            if folder in keepers:
                wanted = by_name.get(folder)
                if wanted and note.get("id") != wanted["id"]:
                    note["id"] = wanted["id"]
            kept.append(note)
        document["projects"] = kept
        backup = path + ".bak-cleanup"
        if not os.path.exists(backup):
            shutil.copy2(path, backup)
        temporary = path + ".tmp"
        with open(temporary, "w", encoding="utf-8") as handle:
            json.dump(document, handle, indent=2, ensure_ascii=False)
        os.replace(temporary, path)
        print(f"  {product}: {before} -> {len(kept)} notes")

        state_path = os.path.join(APPDATA, product, "sync.json")
        if not os.path.exists(state_path):
            continue
        with open(state_path, encoding="utf-8") as handle:
            state = json.load(handle)
        versions = state.get("projectVersions") or {}
        for project_id in doomed_ids:
            versions.pop(project_id, None)
        state["projectVersions"] = versions
        if state.get("prepared"):
            state["prepared"] = [p for p in state["prepared"] if p not in doomed_ids]
        if failed:
            pending = state.get("pendingProjectDeletes") or []
            state["pendingProjectDeletes"] = sorted(set(pending) | set(failed))
        with open(state_path + ".tmp", "w", encoding="utf-8") as handle:
            json.dump(state, handle, indent=2, ensure_ascii=False)
        os.replace(state_path + ".tmp", state_path)
    return 0


if __name__ == "__main__":
    sys.exit(main())
