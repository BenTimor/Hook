# De-Googling the browser

What it took to make Hook Browser stop presenting itself as Chromium and stop
carrying Google's AI. Written against `159.0.8154.13`: the first three tiers are
built and verified in that tree, the rest is a map with costs.

Landed as three patches — `0011-branding`, `0012-no-google-ai`,
`0013-no-google-services` — plus one rule in `browser/tools/patch.mjs` (`--binary`,
so an icon replacement round-trips). The stack is 13 patches.

## What it says now

Measured against `out/Dev` after the change:

```
$ out/Dev/chrome.exe --version
Hook Browser 159.0.8154.13

VERSIONINFO     FileDescription   Hook Browser
                ProductName       Hook Browser
                CompanyName       The Hook Authors
                LegalCopyright    Copyright @LASTCHANGE_YEAR@ The Chromium Authors.
                                  All rights reserved. Copyright @LASTCHANGE_YEAR@
                                  The Hook Authors.
window title    New tab - Hook Browser
icon            the Hook mark, 7 sizes (16…256)
chrome://glic   "This site can't be reached"
```

`OriginalFilename` in the version resource is still `chrome.exe`. That is the
deliberate omission: the binary name is a week of work across the installer,
`chrome_elf`, the proxy, the elevation service and crashpad, and it buys nothing a
person sees. An MSIX package is named by its package identity, not by its file.

## The four dials

Everything user-visible about the name comes from four places, and only one of them
is a switch:

| Dial | Where | What it decides |
| --- | --- | --- |
| `branding_path_component` / `branding_path_product` | `build/config/chrome_build.gni:90-110` | which `theme/` directory and which `*_strings.grd` is compiled |
| `is_chrome_branded` | `build/config/chrome_build.gni:12` | the whole branded/non-branded split; `false`, and should stay `false` |
| `chrome/app/theme/chromium/BRANDING` | 9 lines | VERSIONINFO, `PRODUCT_NAME` at runtime, the crash reporter's name, mac bundle id |
| `chrome/app/chromium_strings.grd` | 907 messages, 591 mentioned "Chromium" | every sentence a person can read |

Two facts made the rest cheap:

- **`generated_resources.grd` (5,308 messages) is brand-neutral.** No
  `IDS_PRODUCT_NAME`, one mention of "Chromium". Only one string file matters.
- **The string set is swapped at file level**, `chrome/app/BUILD.gn:144-148`:
  `grit_strings("branded_strings") { source = "${branding_path_product}_strings.grd" }`.
  No id-level override exists, so a fork either patches messages in place or forks
  the whole file.

`is_chrome_branded = true` is not an option: the assets it needs are internal.
`chrome/app/theme/google_chrome/` is an **empty directory** in the public checkout
(strings are public, images are not) and `google_apis/internal/` does not exist, so
this tree cannot produce a branded build at all.

## Tier 1 — the name and the icon (done)

1. **`chrome/app/theme/chromium/BRANDING`** — four fields. One file feeds
   `chrome/app/chrome_version.rc.version` (`FileDescription`, `ProductName`),
   `base/version_info/version_info_values.h` (`PRODUCT_NAME`, which
   `chrome://version` and several dialogs report) and `build/util/branding.gni`.
   Highest ratio of effect to risk in this document. `COMPANY_*` became *The Hook
   Authors*, `PRODUCT_FULLNAME` *Hook Browser*, `PRODUCT_SHORTNAME` *Hook*,
   `MAC_BUNDLE_ID` `app.hook.browser`. The copyright keeps Chromium's line and
   appends ours.

2. **The strings.** `IDS_PRODUCT_NAME` / `IDS_SHORT_PRODUCT_NAME` /
   `IDS_BROWSER_WINDOW_TITLE_FORMAT` are three of **690** messages that named
   Chromium (569 in `chromium_strings.grd`, 121 in
   `settings_chromium_strings.grdp`). They are rewritten by
   `browser/tools/brand-strings.py`: a `<message>`-aware transformer with a
   blocklist for the places the word is genuinely Chromium's — the authors,
   ChromiumOS, Chromium Updater, a URL, a filesystem path — so the diff stays one
   hunk per message. Re-run it after a Chromium sync; a new release adds messages
   and this patch will not cover them.

3. **The icon.** `chrome/app/chrome_exe.rc` and `chrome/app/chrome_dll.rc` pick the
   `.ico` in an `#else` branch, hardcoded — the one thing `branding_path_*` does
   not parameterise. Both now point at `..\..\hook\app\theme\hook.ico`, a new
   overlay path holding the mark at 16/24/32/48/64/128/256 (upstream had 7 images
   but no 24/64/128, so Windows was softening the taskbar and Alt-Tab).
   The mark itself comes from `apps/chat/src-tauri/icons/icon.png` (512 px), the
   same art the desktop products ship.

   The in-product logos cannot use that trick: `grit` resolves a `chrome_scaled_image`
   against `chrome/app` and refused `../../hook/app/theme/product_logo_32.png`
   (`Tried ..\..\chrome\app\hook\app\theme\product_logo_32.png`). They are the four
   files under `theme/default_100_percent/chromium/` and `…/default_200_percent/chromium/`
   (16 and 32 at both densities), replaced in place, which is why `patch.mjs add`
   now passes `--binary`.

**Two traps the first build taught**, both of which cost a build each:

- `rc.exe` interprets `\a` and `\t`. `..\..\hook\app\theme\hook.ico` written with
  single backslashes fails with `hookpp<TAB>heme\hook.ico: failed to open file`.
  Both `.rc` files need doubled backslashes — which is why upstream's
  `chrome_exe.rc` has them.
- `grit` will not walk out of `chrome/app`, as above.

## Tier 2 — the AI surfaces (done)

The good news was bigger than it looked: an unbranded build with no API keys cannot
turn most of this on, because Glic and Compose want a signed-in profile with an
optimization-guide hint, and without keys there is no variations seed, no
component-updater model and no sign-in. What was left was code in the binary and
pages that answered anyway.

| Surface | Gate now | What it does |
| --- | --- | --- |
| Glic / "Gemini in Chrome" | `kGlic` disabled (`chrome/common/chrome_features.cc`) **and** `GlicUIConfig::IsWebUIEnabled` returns false (`chrome/browser/glic/host/glic_ui.cc`) | the feature default alone was not enough: `IsInternalsWebUIEnabled()` is true in a non-official build, so `chrome://glic` kept drawing "Gemini is refreshing…". Two changes, one visible result |
| Compose / "Help me write" | `kEnableCompose` and `kComposeEligible` disabled (`components/compose/core/browser/compose_features.cc`) | `enable_compose = false` is the intended GN switch and **does not work in this tag**: ten `BUILD.gn` files depend on `//chrome/browser/compose` unconditionally and the target asserts on the flag, so `gn gen` fails. The feature defaults are the switch; `browser/args.gn` records why |
| Lens | `kLensOverlay` and `kLensStandalone` disabled (`components/lens/lens_features.cc`) | no omnibox or image-context-menu entry point. Region search, PDF Lens and the side panel never existed in an unbranded build (`components/lens/features.gni:31-38`) |
| On-device model / Prompt API | `AIPromptAPI` has no `status` in `runtime_enabled_features.json5` | was `"stable"` on Windows, i.e. `window.ai` exposed to pages. No status means disabled everywhere. An empty `status: ""` is a **build error**, not a default |
| Skills (`chrome://skills`) | `kSkillsEnabled` disabled (`components/skills/features.cc`) | Chrome's saved prompts; `IsWebUIEnabled` returns false, so the page is refused |
| `chrome://settings/ai`, tab-group Gemini, `chrome://contextual-tasks` | untouched | every contributor default is already off and the settings route is not registered |

Compile-time gifts of `is_chrome_branded == false`, kept: Lens region search, PDF
Lens, the branded half of the AI settings page, Google's iconography in the Lens
overlay.

## Tier 3 — the services

| Item | Today | Why |
| --- | --- | --- |
| "Google API keys are missing" infobar | **removed** (`chrome/browser/ui/startup/infobar_utils.cc`) | `HasAPIKeyConfigured()` is false in every run of this build, so stock Chromium greeted each new profile with a yellow bar about Google keys. It was the most Google-branded thing on screen and a warning about us |
| Google sign-in / sync | **nothing to remove** | compiled in, but DICE cannot start without an OAuth client: `account_consistency_mode_manager.cc:46-77` needs `HasOAuthClientConfigured()`, so the avatar menu shows "Local profile" and `chrome://signin-internals` reports no accounts. `enable_dice_support = false` would delete dead code at compile time; it is an upstream-untested configuration (desktop with mirror also off) and buys no visible change, so it was not taken |
| Default search engine | **Google, by decision** | hard-coded in `GetPrepopulatedFallbackSearch()` (`template_url_prepopulate_data.cc:355-363`); branding has no say. Changing it is one hunk plus a choice of engine — deferred, not forgotten |
| Safe Browsing | **unchanged, awaiting a decision** | dead in a build with no keys, and the free API is non-commercial only — see below |
| Omnibox suggestions | to Google | follows from the default search engine |
| Translate, Geolocation, optimization guide, enhanced spellcheck | already dead | no API key; requests are not made (geolocation uses the Windows provider) |
| Google Update, crash upload, metrics/UKM, the variations seed | already off | `enable_updater = is_chrome_branded && …`, crash consent false in a non-official build, `kMetricsReportingEnabled` derives from Omaha, no seed fetch |
| Chrome Web Store links, CRX auto-update | still hard-coded | `extensions/common/extension_urls.cc:63-66`. We ship no extensions, so this is cosmetic until something does |
| `product_logo_name_22.png` (the wordmark) | still Chromium's | drawn in the payments sheet. It is a rendered word, not a scalable mark; it needs an asset nobody has drawn yet |

### Safe Browsing, in full

Safe Browsing is Chromium's protection against phishing, malware and unwanted
software. On Windows it is compiled in fully (`safe_browsing_mode = 1`, the default
for desktop), and it works in two halves:

- **Local**: a database of bad URLs and file hashes, checked as you navigate and
  download. Updated by request, but usable offline.
- **Remote**: lookups to `safebrowsing.googleapis.com` for URLs the local database
  cannot vouch for (the "real time" checks), plus download reputation.

The problem is not that it protects you — it is that **in this build the protection
is dead while the requests still happen**. Unlike Translate, Geolocation or the
optimization guide, Safe Browsing does not test
`google_apis::HasAPIKeyConfigured()`. It appends whatever key it has
(`sb_protocol_manager_util.cc:599-612`), and ours is the literal placeholder
`dummytoken`, so every update and every lookup is refused by Google. The user pays
the request and the privacy cost; the database never updates; the shield in the UI
is decorative.

`safe_browsing_mode = 0` removes that: no requests, no half-populated database, and
it is one GN argument rather than a patch. What it also removes is the *local* half
— download protection, the dangerous-file prompt, the interstitial for a known-bad
site. So the question is not "do we keep Google's service": we do not have it. It is
**what a shipped browser owes its users in its place**, and there are three honest
answers:

1. **Turn it off, say so.** `safe_browsing_mode = 0`, and the docs and the Store
   listing say plainly that Hook Browser has no built-in safe browsing. Cheapest,
   truthful, and a real regression against Chrome for a non-technical user.
2. **Turn it off and own the half that does not need Google.** Local-only blocking
   from a list we host, or a file-reputation call to the account service. Real work
   — a small server endpoint plus the download path — and a decision about who
   curates the list.
3. **Get keys.** This is the option that sounds free and is not. The Safe Browsing API
   is free **for non-commercial use only**, and its terms say so twice: "unless
   you have a separate agreement with Google, you may not use the Safe Browsing
   API for commercial purposes" (<https://developers.google.com/safe-browsing/terms>,
   clause 1), and the usage page points commercial users at **Web Risk**, which is
   priced per request. Hook has paid plans, so Hook is commercial. Beyond the
   licence, three clauses bite:
   - clause 2: telling users they are protected obliges us to show, **on every
     warning**, a conspicuous notice that the reliability and accuracy cannot be
     guaranteed, attributed to Google;
   - clause 4: a URL from Google's list may not be treated as unsafe unless the
     list information was received **within the past thirty minutes** — the local
     database stops being a database and becomes a live requirement;
   - clause 5: Google may use URLs submitted through the lookup method to improve
     its products **and share them with third parties**, including other customers.

   There is one more cost that applies to any of this: Chromium's `google_api_key`
   is a single build-wide key, not a per-service one. Setting it makes
   `HasAPIKeyConfigured()` true, which does not only revive Safe Browsing — it also
   revives Translate, the network geolocation fallback, enhanced spellcheck uploads
   and autofill crowdsourcing, and removes the no-key state that keeps the
   optimization guide quiet. Undoing that means patching each of them back off,
   i.e. re-doing part of this work to keep one feature.

There is a fourth option that is not on the table: leave it as it is. A browser that
shows a protection shield while its list never updates is worse than one that says
it has no protection.

**Status: waiting on the decision above.** Nothing has been changed. Recommendation:
option 1 now (one line in `browser/args.gn`, plus a paragraph saying so in the docs
and the Store listing), option 2 written down as what makes a shipped browser
honest — and note that whichever is chosen, the browser currently has **no download
protection at all** in a build with no keys, because the same key gates it.

## What a Chromium sync costs now

The stack is 13 patches. `0011-branding` is by far the largest (334 KB, ~700
changed messages) and is the one that needs a step after a sync:

1. `pnpm browser:sync` — rebase the tree.
2. `node browser/tools/brand-strings.py` — preview. Anything it finds is a message
   upstream added since the last rebase.
3. `--write`, then `patch.mjs add branding -- …` to fold it into `0011` (or drop
   `0011`, re-run the transformer on the clean file, and capture a fresh one).
4. `node browser/tools/verify.mjs` — it fails loudly if a patch stops applying,
   which is the moment to read it rather than trust it.

`0012` and `0013` are small and touch files that move slowly (`chrome_features.cc`,
`lens_features.cc`, `infobar_utils.cc`). The likeliest conflicts over a year are
`chrome_exe.rc`/`chrome_dll.rc` (the icon `#if` blocks) and `glic_ui.cc` (a young
file).

Nothing here forks a subsystem, which is what keeps the 4-week train affordable
(`docs/browser-poc-plan.md`, "The release channel").

## What must stay

De-Googling is not de-licensing. Chromium is BSD-3: every redistribution keeps the
copyright notice and the disclaimer, which is why `chrome://credits` and
`LICENSES.chromium.html` are part of the build and are not candidates for removal,
and why `BRANDING`'s `COPYRIGHT` still carries *The Chromium Authors* beside ours.
What went is the *product identity* — a name, an icon, a set of sentences — and the
Google services we do not want to talk to. No attribution was removed and
`THIRD_PARTY_NOTICES.md` does not change (see "Hard constraints" in `AGENTS.md`).

`is_chrome_branded` stays `false`. Turning it on is not "more branded", it is a
build that needs assets we cannot have — and it is the flag that would *add*
Google's services rather than remove them.

## Open, for whoever picks this up

Nothing here blocks anything else. Each line is a decision or a small piece of
polish, not an unbuilt feature.

- **Safe Browsing.** The one decision this document is waiting on (four options
  above; option 1 recommended). Until it is made, the browser has no download
  protection and no phishing warning, and nothing says so.
- **Default search engine.** Deliberately still Google. The hunk is
  `GetPrepopulatedFallbackSearch()` in
  `components/search_engines/template_url_prepopulate_data.cc` — one line pointing
  at another `*.id`, plus the question of which engine. Changing it also quiets the
  omnibox suggestion traffic, which currently goes to Google on every keystroke.
- **The wordmark.** `product_logo_name_22.png` (and `_white`) is still Chromium's
  word, drawn in the payments sheet. It needs an asset: "Hook" set in the UI face
  on a transparent background, 22 px tall and its 2× variant.
- **Start-menu and jump-list tiles.** `theme/chromium/win/tiles/{Logo,SmallLogo}.png`
  (600×600, 176×176) only matter once there is an installer or an MSIX, and there is
  neither yet.
- **Dead Google sign-in code.** `enable_dice_support = false` in
  `components/signin/features.gni` would delete it at compile time. It changes no
  behaviour (see the table above) and is an upstream-untested configuration, so it
  was not taken. Worth doing only if binary size or dead code becomes a topic.
- **Chrome Web Store URLs.** `extensions/common/extension_urls.cc:63-66` is still
  hard-coded, and so is the CRX auto-update host. Cosmetic until we ship an
  extension that has to update.
- **Non-English locales.** The transformer only rewrites the English source
  (`chromium_strings.grd` and its settings part). There are no `.xtb` translations
  in this tree, so every locale currently falls back to English and the point is
  moot — the day we ship a translated build, the same pass has to cover the `.xtb`
  files or non-English users will read "Chromium" next to the Hook icon.
- **`chrome.exe`.** Skipped on purpose (see the top). Revisit only if we ever ship
  an installer that registers ProgIDs or needs the file name to be ours.
