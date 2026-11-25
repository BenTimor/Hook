#!/usr/bin/env python3
"""Rewrite the product name in Chromium's Chromium-branded string files.

The branding patch (0011) renames every place a person can read "Chromium";
these two files carry 690 of them. Doing that by hand is unmaintainable, and a
blind sed breaks the messages that talk about Chromium itself (the authors,
ChromiumOS, a filesystem path, a URL), so this is the transformer, with the
blocklist.

  python browser/tools/brand-strings.py            # preview: a sample per file
  python browser/tools/brand-strings.py --write    # edit the checkout
  node browser/tools/patch.mjs add branding -- chrome/app/chromium_strings.grd \\
      chrome/app/settings_chromium_strings.grdp    # capture the result

Run it again after a Chromium sync. A new release adds messages, this patch does
not cover them, and the product quietly calls itself Chromium in a dialog nobody
looked at. The files are edited in place because the alternative — a
`hook_strings.grd` of our own — is a thousand strings to keep in step with
upstream every four weeks.

Only message *bodies* change, and only outside the blocklist, so what the patch
carries stays one hunk per message. Line endings are preserved (`newline=""`):
on Windows the Python default would rewrite the file as CRLF and bury the real
diff under 4,000 changed lines.
"""
import re
import sys
from pathlib import Path

SRC = Path("C:/Dev/cr/src")

FILES = [
    SRC / "chrome/app/chromium_strings.grd",
    SRC / "chrome/app/settings_chromium_strings.grdp",
]

# Ids whose body is the product name itself, not a sentence around it.
SPECIAL = {
    "IDS_PRODUCT_NAME": "Hook Browser",
    "IDS_SHORT_PRODUCT_NAME": "Hook",
    "IDS_APP_MENU_YOUR_CHROME_HEADER": "Your Hook",
    "IDS_PRODUCT_OS_NAME": "Hook",
}

# Phrases that are Chromium's, not ours. A message containing one is left alone.
KEEP = [
    "Chromium Authors",
    "ChromiumOS",
    "Chromium OS",
    "Chromium Updater",
    "Chromium project",
    "Chromium Embedded",
    "chromium.org",
    "googlesource",
    "crbug",
    "Application Support",
    "%LOCALAPPDATA%",
    ".chromium",
]

MESSAGE = re.compile(r'(<message\b[^>]*name="([^"]+)"[^>]*>)(.*?)(</message>)', re.S)


def rewrite(body: str, name: str) -> str:
    if name in SPECIAL:
        # The whole body is the name ("Your Chromium" would otherwise become
        # "Your Your Hook"); keep the surrounding indentation.
        stripped = body.strip()
        start = body.index(stripped) if stripped else 0
        return body[:start] + SPECIAL[name] + body[start + len(stripped):]
    # A path or a URL in the message means the word is load-bearing.
    if "\\" in body or "chrome://" in body:
        return body
    return re.sub(r"\bChromium\b", "Hook Browser", body)


def transform(path: Path, write: bool) -> list[tuple[str, str, str]]:
    with open(path, encoding="utf-8", errors="surrogateescape", newline="") as handle:
        text = handle.read()
    changed: list[tuple[str, str, str]] = []

    def repl(match: re.Match) -> str:
        head, name, body, tail = match.groups()
        if "Chromium" not in body or any(phrase in body for phrase in KEEP):
            return match.group(0)
        updated = rewrite(body, name)
        if updated != body:
            changed.append((name, body.strip(), updated.strip()))
        return head + updated + tail

    result = MESSAGE.sub(repl, text)
    if write and result != text:
        with open(path, "w", encoding="utf-8", errors="surrogateescape", newline="") as handle:
            handle.write(result)
    return changed


def main() -> int:
    write = "--write" in sys.argv
    for path in FILES:
        changed = transform(path, write)
        print(f"\n{path.name}: {len(changed)} messages")
        for name, before, after in changed[:6]:
            print(f"  {name}\n    - {re.sub(chr(10), ' ', before)[:110]}\n    + {re.sub(chr(10), ' ', after)[:110]}")
        if len(changed) > 6:
            print(f"  ... {len(changed) - 6} more")
    if not write:
        print("\n(preview; pass --write to edit the checkout)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
