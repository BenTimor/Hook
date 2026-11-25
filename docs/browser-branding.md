# De-Googling the browser

What it took to make Hook Browser stop presenting itself as Chromium and stop
carrying Google's AI, and what is still left. Written against `159.0.8154.13`:
every tier below is built and verified in that tree, except where a line says
otherwise.

Landed as four patches — `0011-branding`, `0012-no-google-ai`,
`0013-no-google-services`, `0014-safe-browsing-off` — plus one rule in
`browser/tools/patch.mjs` (`--binary`, so an icon replacement round-trips). The stack
is 14 patches.

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
| Safe Browsing | **off** — see "Safe Browsing, in full" | dead in a build with no key, and the free API is non-commercial only |
| Google sign-in / sync | **nothing to remove** | compiled in, but DICE cannot start without an OAuth client: `account_consistency_mode_manager.cc:46-77` needs `HasOAuthClientConfigured()`, so the avatar menu shows "Local profile" and `chrome://signin-internals` reports no accounts. `enable_dice_support = false` would delete dead code at compile time; it is an upstream-untested configuration (desktop with mirror also off) and buys no visible change, so it was not taken |
| Default search engine | **Google, by decision** | hard-coded in `GetPrepopulatedFallbackSearch()` (`template_url_prepopulate_data.cc:355-363`); branding has no say. Changing it is one hunk plus a choice of engine — deferred, not forgotten |
| Translate, Geolocation, optimization guide, enhanced spellcheck | already dead | no API key; requests are not made (geolocation uses the Windows provider) |
| Google Update (Omaha), crash upload, metrics/UKM, the variations seed | already off | `enable_updater = is_chrome_branded && …`, crash consent false in a non-official build, `kMetricsReportingEnabled` derives from Omaha, no seed fetch. **Omaha is not the component updater** — see below |
| Chrome Web Store links, CRX auto-update | still hard-coded | `extensions/common/extension_urls.cc:63-66`. We ship no extensions, so this is cosmetic until something does |
| `product_logo_name_22.png` (the wordmark) | still Chromium's | drawn in the payments sheet. It is a rendered word, not a scalable mark; it needs an asset nobody has drawn yet |

### What still talks to Google, measured

Measured, not assumed: a fresh profile, no browsing, `--log-net-log`, and the hosts
that appear anyway. Three separate things, and only one of them is Safe Browsing.

| What | Endpoints | Where it comes from |
| --- | --- | --- |
| **Chromium's own New Tab Page** | `www.google.com/` (8×), `/async/newtab_ogb`, `/async/folae`, `/async/ddljson`, `/complete/s?…sugkey=dummytoken`, `www.gstatic.com/og/_/js/…`, `fonts.gstatic.com/s/googlesans/…`, `ogads-pa.clients6.google.com/…GetAsyncData`, `play.google.com/log` | the net log names the initiator: **`chrome-untrusted://new-tab-page`**. Our page replaced what a new tab *shows* (patch 0009), but Google's NTP frame still loads at startup. It is the largest single leak, it happens on every launch, and it sends the placeholder `dummytoken` as `sugkey` |
| **The component updater** | `update.googleapis.com/service/update2/json` (20×), `clients2.google.com/time/1/current?cup2key=…`, `edgedl.me.gvt1.com/edgedl/{chrome_component,diffgen-puffin}/…` | it does not use the Google API key; it authenticates with its own `cup2key`, so "no keys" never switched it off. Switching it off is **not** free: CRLSet (revoked certificates), PKI metadata and the file-type policies that classify downloads arrive this way |
| **The default search engine** | `www.google.com/search/warmup.html` | a **preconnect** only (`"is_preconnect": true`) — no request body, but it does open a connection to Google at startup. It follows the default engine, so it goes away with the search-engine change |

Two consequences worth stating plainly:

- The browser is not "not talking to Google" today. It is not *asking* Google
  anything on the user's behalf, but it fetches a Google page frame, an update
  manifest and a warm-up connection.
- The NTP frame is the one to fix next, and it looks cheap: find what instantiates
  `chrome-untrusted://new-tab-page` once `chrome://newtab` is no longer Chromium's
  page. The component updater needs a decision (security components are in it), and
  the preconnect fixes itself when the default engine changes.

### Safe Browsing, in full

**Decision: off for now.** A replacement — ours, not Google's — is future work.

Safe Browsing is Chromium's protection against phishing, malware and unwanted
software. On Windows it is compiled in fully (`safe_browsing_mode = 1`), and it has
two halves: a **local** database of bad URLs and file hashes, checked as you navigate
and download, and **remote** lookups to `safebrowsing.googleapis.com`.

In a build with no API key it protects nobody while still making the requests. Unlike
Translate or Geolocation, it never consults `HasAPIKeyConfigured()` — it appends
whatever key it has (`sb_protocol_manager_util.cc:599-612`), and ours is the
placeholder `dummytoken`, so every list update and every lookup is refused. The
shield in the UI is decorative, and a browser that shows a protection shield over a
list that never updates is worse than one that says it has no protection.

**What changed: one pref default.**
`components/safe_browsing/core/common/safe_browsing_prefs.cc`,
`RegisterProfilePrefs()`: `kSafeBrowsingEnabled` is registered `false` instead of
`true`. That is the whole change, because that pref is the single gate —
`SafeBrowsingServiceImpl::RefreshState()` reads `IsSafeBrowsingEnabled(*prefs)` and
calls `Start()` or `Stop(false)`, and `services_delegate_->RefreshState()` follows. No
service, no list updates, no lookups, no download checks, no interstitials. Verified
with a net log: `safebrowsing.googleapis.com` does not appear at all, and the only
remaining "safebrowsing" string is a `base::Feature` name in the variations list.

**Why not `safe_browsing_mode = 0`.** That is the honest removal — it takes the code
out — and it does not build in this tag. Six targets depend on
`//components/safe_browsing/…` unconditionally: `browser_tests` in
`chrome/browser/download`, `chrome/browser/ui/views/file_system_access`,
`chrome/browser/webshare` and `chrome/browser/feedback`, `interactive_ui_tests`, and
— the one that decides it — the shipping
`chrome/browser/feedback/report_unsafe_site`. `gn gen` fails on all of them. Guarding
six BUILD files that upstream never tests in that configuration is more rebase surface
than the flag is worth; the pref default costs one line and behaves correctly. If
someone later wants the code gone, those six are the list.

**What is left, and what it costs.**

- The **Settings toggle remains**: `chrome://settings/security` shows "No protection"
  by default, and a user can still switch protection on — at which point the service
  starts and makes the same refused requests. That is the pre-existing dead state, not
  something this change introduced, but it is a trap. Hiding the section means editing
  `chrome/browser/resources/settings/privacy_page/security/security_page.html.ts`
  (`#safeBrowsingSection`) and belongs with the replacement, not before it.
- The **code is still compiled in**: binary size and dead paths, the same trade as
  above.
- Users lose, concretely: **no phishing warning**, **no dangerous-download prompt** (a
  `.exe` lands with no interstitial), no unwanted-software blocking. The account, the
  chats and the rest of Hook are unaffected.
- Anyone asking "is Hook safer than Chrome" now has a real answer to hear: no, and
  this is why.

**Why not just get the free key.** The Safe Browsing API is free **for
non-commercial use only**, and its terms say it in the first clause: "unless you have
a separate agreement with Google, you may not use the Safe Browsing API for commercial
purposes" (<https://developers.google.com/safe-browsing/terms>). The usage page points
commercial users at **Web Risk**, priced per request. Hook has paid plans, so Hook is
commercial. Three clauses then shape the product:

- clause 2: telling users they are protected obliges a conspicuous notice, **on every
  warning**, that the reliability and accuracy cannot be guaranteed, attributed to
  Google;
- clause 4: a URL from Google's list may not be treated as unsafe unless the
  information arrived **within the past thirty minutes** — the local database becomes
  a live requirement, and offline means unprotected;
- clause 5: Google may use URLs submitted through the lookup method to improve its
  products **and share them with third parties**, including other customers.

And Chromium's `google_api_key` is a single build-wide key: setting it would also
revive Translate, the network geolocation fallback, enhanced spellcheck uploads and
autofill crowdsourcing, and remove the no-key state that keeps the optimization guide
quiet. Getting Safe Browsing alone would mean patching each of those back off.

**How this gets revisited.** Two options that fit Hook, in order of cost:

1. **Own the local half.** A list we host — curated or bought — checked in the download
   path and at navigation, with the endpoint on the account service. That is the
   version that can honestly say "we protect you", and it is where
   `safe_browsing_mode = 0` becomes attractive again: we would be writing the code,
   not removing it.
2. **Web Risk or an agreement with Google.** Paid per request or negotiated, plus the
   attribution and thirty-minute clauses. Legitimate, but it re-adds the dependency
   this work is removing.

Turning it back on today is reverting the pref default; the rest of the machinery is
untouched and still there.

## What a Chromium sync costs now

The stack is 14 patches. `0011-branding` is by far the largest (334 KB, ~700
changed messages) and is the one that needs a step after a sync:

1. `pnpm browser:sync` — rebase the tree.
2. `node browser/tools/brand-strings.py` — preview. Anything it finds is a message
   upstream added since the last rebase.
3. `--write`, then `patch.mjs add branding -- …` to fold it into `0011` (or drop
   `0011`, re-run the transformer on the clean file, and capture a fresh one).
4. `node browser/tools/verify.mjs` — it fails loudly if a patch stops applying,
   which is the moment to read it rather than trust it.

`0012`–`0014` are small and touch files that move slowly (`chrome_features.cc`,
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

- **Safe Browsing: off, and that is a debt.** The pref default is false, so there is
  no phishing warning and no dangerous-download prompt. A replacement is future work
  (own the local half; see "Safe Browsing, in full"), and the Settings toggle that
  can still turn the dead state back on disappears with it. Until then this is the
  one place Hook is plainly weaker than Chrome, and the Store listing has to say so.
- **Google's New Tab Page frame.** The net log puts
  `chrome-untrusted://new-tab-page` behind ~15 requests to `www.google.com`,
  `gstatic.com`, `fonts.gstatic.com` and `ogads-pa.clients6.google.com` on every
  launch, signed-out. Patch 0009 changed what a new tab shows, not what Chromium
  still loads for it. Finding the instantiation site is the next cheap win.
- **The component updater.** It runs without API keys (`cup2key`, not the Google
  key), and it is the biggest remaining talker: `update.googleapis.com`,
  `clients2.google.com`, `edgedl.me.gvt1.com`, `play.google.com/log`. Turning it off
  also stops CRLSet, PKI metadata and the download file-type policies, so it is a
  security decision, not a switch.
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
