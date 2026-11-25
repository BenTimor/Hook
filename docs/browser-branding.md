# Hook Browser: the name, and what it carries

What it took to make Hook Browser present itself as Hook instead of Chromium, what it
still carries, and why each thing that was removed went. Written against
`159.0.8154.13`: every tier below is built and verified in that tree, except where a
line says otherwise.

Landed as seven patches — `0011-branding`, `0012-no-google-ai`,
`0013-no-google-services`, `0014-safe-browsing-off`, `0015-no-google-at-startup`,
`0016-wordmark`, `0017-component-allowlist` — plus one rule in
`browser/tools/patch.mjs` (`--binary`, so an icon replacement round-trips). The stack
is 17 patches.

## What this work is for

**The browser is not an anti-Google project, and nothing here should be read as one.**
The reason to remove anything is the reason to remove anything from any Hook product:
what nobody uses still costs memory, CPU, startup time, bytes on disk and attention,
and Google's services happened to be the largest single collection of such things —
installed by default, talking to servers we cannot inspect, serving features this
product does not present.

So the standard for a dependency is not *whose* it is. It is three questions:

1. **Does someone use it?** Translate does. Indigo's wallpaper catalogue, which this
   build shows nowhere, does not.
2. **What does it cost the people who don't?** A component that is registered but
   never used still polls, still reserves state, still appears in a list of things to
   keep working across a Chromium upgrade.
3. **Does it earn its keep when used?** Safe Browsing did not (it was a shield over a
   list that never updated), and the component updater's 20 extra components did not
   (they served AI models, hint lists and origin trials this build has no feature for).

That is why the work below exists, and it is what decides the next one. Consequences
already settled under it:

- **Translate stays.** It is a feature people ask for, it costs nothing until someone
  uses it, and when it runs it does exactly what was requested. It reaches Google
  because translation is a network service; that is the feature, not a leak.
- **Search stays Google** for now, on the same rule: the preconnect is a small cost,
  the engine is a large benefit (see "Default search engine" below).
- **Safe Browsing is off** because it was inert, not because of the name on it. The
  replacement is ours when it exists ("Safe Browsing replacement" below).
- **The updater is an allowlist of three** because 20 of its 23 components served
  features this build does not have; the three that remain decide whether a
  certificate is accepted ("The component updater" above).
- **Things that stay even though Google runs them**, once they pay for themselves: a
  Web Risk feed if it replaces Safe Browsing, Widevine once licensed, and Google's
  index as the search default while it is the best default.

The instrument is `--no-google`, and its name is historical. What it proves is that no
**new** traffic arrived without a decision — a budget on chatter, not a purity test.
When a Google service earns its place, the check's allowlist entry is where that
becomes visible, with the reason written next to it.

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

### The first run is not Chromium's

**`0018-skip-first-run`.** A fresh profile used to open `chrome://intro/welcome`:
"The browser that gets more done" over the Chromium mark, then a Google-account
sign-in pitch, bookmark import from other browsers, and "set as your default
browser". It also **plays a startup sound** — `FirstRunFlowController` owns a
`SoundsManager`, and it is the only non-ChromeOS sound the browser can make.

One line, at the decision point: `first_run::IsChromeFirstRun()` answers false, so
the picker's `kFirstRun` entry point is never taken and the sentinel is never
written (harmless — nothing reads it once it cannot answer true). Everything the
wizard exists to do is either already ours (the sign-in gate, the dock) or a promise
this product does not make (sync, defaults, import).

Deliberately **not translated** into a Hook wizard: a first-run page is a standing
obligation to keep Chrome's onboarding vocabulary in step across every Chromium
upgrade, and the product already has a first screen — the gate. The smoke now proves
it: a fresh profile's first tab is `chrome://hook-newtab`, not `chrome://intro/*`.

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

Measured, not assumed: a fresh profile, no browsing, `--log-net-log`. It is
automated now — `node browser/tools/smoke.mjs --no-google` fails on any Google host
that is not on a short, explained allowlist, so the next Chromium bump cannot start
phoning home quietly.

**Before this work**, a fresh profile made ~80 requests to about ten Google hosts,
for three unrelated reasons. One of them was not what it looked like: the requests
came from `chrome-untrusted://new-tab-page`, which is not a stray frame but
Chromium's **New Tab Page component extension** — a CRX that the component updater
downloads and runs a service worker for before the first window is drawn. Three
fixes, all in `0015-no-google-at-startup`:

| Was | Why it happened | What removed it |
| --- | --- | --- |
| **Four component extensions** (`AddNewTabPageExtension`, `AddGlicExtension`, `AddContextualTasksExtension`, `AddAimEligibilityExtension`) | `ComponentLoader` starts their service workers for every profile; the New Tab Page one fetches `www.google.com/async/{newtab_ogb,ddljson}`, the One Google Bar from `gstatic.com`, Google Sans and `ogads-pa.clients6.google.com` | the four calls are behind `#if 0` with a comment naming each; re-enabling one is deleting its line |
| **Google's "AI Mode" eligibility check** | `AimEligibilityService` sends `/async/folae` to `www.google.com` at startup and again on every account change (`kAimEnabled`, `kAimServerRequestOnStartupEnabled`) | both features disabled in `aim_eligibility_service_features.cc`; the service's constructor returns before it registers anything |
| **The search prewarm** | `PrewarmTabHelper` prerenders the default search engine's warmup URL (`www.google.com/search/warmup.html`) as soon as a visible tab finishes painting — on this browser, a new tab, at startup, before anyone types | `preloading::features::kPrewarm` disabled. It was also the only thing that loaded a Google page and Google Sans |

**After**: three hosts and one preconnect.

| What remains | Endpoint | Status |
| --- | --- | --- |
| **The component updater** | `update.googleapis.com/service/update2/json`, `clients2.google.com/time/1/current`, `edgedl.me.gvt1.com/edgedl/{release2, diffgen-puffin}/…` | **narrowed to an allowlist** (`0017-component-allowlist`): three components, 23 before — see "The component updater" below. It authenticates with `cup2key`, not the Google API key, so "no keys" never switched it off |
| **A preconnect to `www.google.com`** | one TCP/TLS connection, no request with content | allowed *as a preconnect only*; the check fails if a Google host serves a page. It follows the default search engine, so it goes away with that change |
| **`dns.google`** | DoH | allowed: the machine's resolver is `8.8.8.8`, and Chromium upgrades known resolvers. Not a choice this build makes — a check running on a machine with a local resolver never sees it |

Two consequences worth stating plainly:

- "Unbranded" is not "quiet". None of the three fixed items was gated on
  `is_chrome_branded`, and one of them shipped a **downloaded** extension. This is
  the class of thing that only a net log finds.
- The remaining Google talker is the security updater, now on an allowlist of three
  components (below). That is the honest trade to finish with: what still arrives is
  data that decides whether this browser accepts a certificate — not a service.

### The component updater: an allowlist of three

**Decision: the allowlist, and it is done** (`0017-component-allowlist`).

The updater is one endpoint that fetches whatever Google's servers offer. Its
request carries the list of components this browser wants, so "we do not use that
service" and "we do not ask for it" are the same statement — and the second is the
one that can be checked. The list was **23 components** in this tag; it is **3**:

| Kept | Why it survives |
| --- | --- |
| `CRLSet` | Certificate revocation. Nothing else replaces it, and the alternative is pinning a list into the binary and re-shipping to revoke. |
| `PKI Metadata` (+ `PKI Metadata Fastpush`) | CT logs, pins and HSTS preload: data about which certificates this browser will accept. |
| `File Type Policies` | What a download's extension means — the policy half of download protection. |

The seam is `CrxUpdateService::RegisterComponent`
(`components/component_updater/component_updater_service.cc`) — the one door every
component passes through, including the component *extensions* (the NTP CRX, Glic,
contextual tasks) that `component_loader.cc` was already skipping by hand. A new
component therefore cannot arrive with a Chromium upgrade; it arrives only when
somebody adds a name to the list. That is the difference between a blocklist and
this: a blocklist is one upgrade away from being wrong, in the direction that ships
a new Google service to users who were promised none.

It is by **name**, so the list reads as a decision. Names are upstream strings, so a
rename fails *closed* — the component silently stops updating. Two things make that
visible instead of quiet: `VLOG(1)` on every refusal, and `pnpm browser:check`
(`smoke.mjs --components`) reading `chrome://components` and failing both ways — a
name that is listed but not allowed, and a required name that is missing.

What stops arriving, and what that costs:

| Dropped | What you lose |
| --- | --- |
| `Subresource Filter Rules`, `Crowd Deny`, `Actor Safety Lists`, `Safety Tips`, `Certificate Error Assistant` | Safe Browsing's lists — already inert while Safe Browsing is off. Revisit with the Web Risk replacement. |
| `Optimization Hints`, `OnDeviceHeadSuggest`, `Optimization Guide On DeviceModels Manifest`, `Commerce Heuristics`, `Amount Extraction Heuristic Regexes`, `Trust Token Key Commitments`, `Origin Trials`, `Indigo` | Google services and models with no user-visible feature in this build. |
| `SODA Library` / `SODA en-US Models` | Live Caption (on-device speech). |
| `WASM TTS Engine` | Web Speech synthesis fallback; Windows' own voices still work. |
| `Zxcvbn Data Dictionaries` | The password-strength meter gets less accurate. Re-add this one line if the vault lands before anything else. |
| `Hyphenation`, `Dictation Connector`, `Captcha Providers`, `MEI Preload`, `Chrome Improved Recovery` | Cosmetic or absent features: justified text in some locales, accessibility dictation, captcha rendering, prerender lists, Chrome's own installer recovery. |

Measured, in the same fresh profile: `chrome://components` went from **23 rows to 3**,
and `--no-google` from "73 urls, 4 Google hosts" to **62 urls, 2 hosts** — the
updater's clock and the search preconnect, with no request to `update.googleapis.com`
in the first 15 seconds at all (nothing is fetched eagerly any more). A 100-second
run then shows `update.googleapis.com` (×8) and the CRLSet id in the log: the updater
still works, it just has three things to ask about.

`Widevine Content Decryption Module` is a commented entry in the list, so the day the
licence is signed it is one uncommented line (see "Widevine" below).

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

The stack is 15 patches. `0011-branding` is by far the largest (334 KB, ~700
changed messages) and is the one that needs a step after a sync:

1. `pnpm browser:sync` — rebase the tree.
2. `node browser/tools/brand-strings.py` — preview. Anything it finds is a message
   upstream added since the last rebase.
3. `--write`, then `patch.mjs add branding -- …` to fold it into `0011` (or drop
   `0011`, re-run the transformer on the clean file, and capture a fresh one).
4. `node browser/tools/verify.mjs` — it fails loudly if a patch stops applying,
   which is the moment to read it rather than trust it.

`0012`–`0015` are small and touch files that move slowly (`chrome_features.cc`,
`lens_features.cc`, `infobar_utils.cc`). The likeliest conflicts over a year are
`chrome_exe.rc`/`chrome_dll.rc` (the icon `#if` blocks) and `glic_ui.cc` (a young
file).

Nothing here forks a subsystem, which is what keeps the 4-week train affordable
(`docs/browser-poc-plan.md`, "The release channel").

## What must stay

Removing a product identity is not removing a licence. Chromium is BSD-3: every
redistribution keeps the copyright notice and the disclaimer, which is why
`chrome://credits` and `LICENSES.chromium.html` are part of the build and are not
candidates for removal, and why `BRANDING`'s `COPYRIGHT` still carries *The Chromium
Authors* beside ours. What went is the *product identity* — a name, an icon, a set of
sentences — and the parts of Chromium whose features this build does not present. No
attribution was removed and `THIRD_PARTY_NOTICES.md` does not change (see "Hard
constraints" in `AGENTS.md`).

`is_chrome_branded` stays `false`. Turning it on is not "more branded", it is a
build that needs assets we cannot have — and it is the flag that would *add*
Google's services rather than remove them.

## Decisions recorded

Settled while the browser was still a proof of concept, so that the next session
starts from them instead of re-arguing them.

### Default search engine: Google stays, out of scope

Not permanent — deliberately deferred. Two futures are on the table: a distribution
**deal** with one of the engines, or **our own** engine backed by a search service
(Exa is the name that came up). Note for the second option: Exa is an answer and
retrieval API, not a general web index — a browser default engine needs index
coverage, locale handling, safe-search and a suggestion stream, so "our own" means
a front end over *someone's* index plus a deal, not a weekend project.

What staying costs: the preconnect in `--no-google` stays allowed, the omnibox sends
suggestions to Google (with `client=chrome-omni` in the URL), and the "no Google
traffic" claim keeps one documented exception. That is the price of the deferral, and
it is small.

### Translate: stays, and it is not a de-Googling exception

Settled by the rule at the top of this document rather than case by case: Translate is
a feature a person asks for, it costs nothing until asked, and when it answers it
answers with what was requested. It sends page text to
`translate.googleapis.com/translate_a/element.js`, and that is what the feature *is* —
not a background call nobody chose.

The earlier framing ("remove the feature, or leave it and say so") was the wrong test:
it treated a used feature as a compromise. The test that replaces it is in **What this
work is for**, and Translate is the first entry that fails it in the direction of
*keeping* something Google runs.

What would change the answer: if a translation model ran on-device (WASM or the OS) at
comparable quality, the network call becomes optional — but that is a feature
decision, not a hygiene one, and the bar is "as good as what people have now".

### Component updater: narrow to the security set

Decided, not yet implemented. Keep what carries a security obligation:

| Keep | Why |
| --- | --- |
| CRLSet | revoked certificates — without it a compromised cert keeps working |
| PKI metadata | the Certificate Transparency log list |
| FileTypePolicies | classifies file types for the download path |

Drop the rest: the NTP/Glic CRX payloads (already not registered, `0015`),
`diffgen-puffin`, optimization hints, Screen AI, autofill models, Zxcvbn data,
subresource-filter and crowd-deny lists — unless the Safe Browsing replacement wants
the last two, which is worth deciding with it.

Two things to weigh while doing it: the updater **downloads and runs code** (the NTP
component extension arrived that way), and a malformed component can break the
browser without a release. Narrowing cuts both ways. After it, `--no-google` should
allow `update.googleapis.com` and `edgedl.me.gvt1.com` only.

### Safe Browsing replacement: Web Risk, deferred but designed

Skipped for now, with the shape already picked. Google publishes the numbers, and
they favour a **local list** over per-URL calls:

| Call | Price |
| --- | --- |
| `threatLists.computeDiff` (Update API — download a diff of the threat lists) | **free, unlimited** |
| `uris.search` (Lookup API) | free to 100,000 calls/month, then $0.50/1,000 |
| `hashes.search` (confirm a hash against Google) | **$50/1,000** — the one to avoid |

So the design is: `computeDiff` on a schedule → our own local hash database →
lookups answered locally, no per-page call at all. That is also how Chromium's own
Safe Browsing list works, which is why it scales.

Three things to check when this is picked up:

- **Protocol, not configuration.** Chromium 159's Safe Browsing is v5
  (`SafeBrowsingLocalListsUseSBv5` is in the variations list). Web Risk's Update API
  is the v4 `computeDiff` shape. Pointing one at the other is code, not a flag.
- **Terms.** Web Risk is the commercial product, so it is *allowed* for a paid Hook —
  but it has its own terms (attribution, and the local database has to be handled as
  sensitive and refreshed on a schedule). Read them before building on it.
- **What it does not cover.** A URL list is not download protection. The file path
  needs FileTypePolicies plus a verdict, and that is the half users notice when a
  `.exe` lands.

### Widevine (DRM): free, accepted, and a Google binary we would run

**Decision: pursue it.** A closed module inside the browser is acceptable for this
product; what is not acceptable is running it *illegally* or pretending it is not
there. The facts:

- **The licence costs nothing.** Google's own overview: "A license agreement is
  required for the use of Widevine products or services. **Widevine does not assess
  any fee** for use of its products and services," and **Chromium is a listed
  supported platform**.
- **But there must be an agreement, signed before use.**
  `third_party/widevine/LICENSE` in the tree: "You may not use, modify, sell, or
  otherwise distribute the Software without a separate license agreement with Google.
  The Software is not open source software."
- **The CDM is delivered as a component.** `enable_widevine` is false for an
  unbranded build (`third_party/widevine/cdm/widevine.gni`), and turning it on
  registers `WidevineCdmComponent` with the component updater
  (`component_updater/registration.cc`) — a closed-source binary fetched from Google
  at runtime, not something we can bundle.
- **It collides with the narrowed updater, mildly, and that is fine.** The allowlist
  is written as an allowlist so the CDM is one uncommented line — it is already in
  the list, commented (`0017-component-allowlist`) — and `--no-google` needs a
  documented carve-out for the CDM download, which is the same updater host it
  already allows. What it must not become is a second download path that the check
  cannot see: the CDM arrives through the component updater or not at all.

### Getting the agreement: the four steps Google documents

From `developers.google.com/widevine/access` (last updated 2025-09-29), the route is
narrow and procedural:

1. **A corporate Google account.** Access to the partner repository requires a Google
   account on a company address; gmail, outlook and yahoo are refused. So the first
   step is an email at the product's domain, not a form.
2. **Contact Widevine through `www.widevine.com`** — the docs point there, "General
   Questions" for new inquiries ("Support" is for existing licensees).
3. **Technical discussion, then the Widevine Master License Agreement.** Repository
   access is contingent on signing it. This is the step with a calendar attached: a
   legal agreement between a company and Google, and Google may ask for technical
   detail to decide what to grant.
4. **Repository access is approved per repository**, not as a package — client/device
   code and server SDKs are separate lists. We want the client side.

What that unlocks, and what we cannot get any other way:

- **The CDM itself, legitimately.** Google ships it, the browser fetches it as a
  component on first use, and `chrome://components` shows "Widevine Content Decryption
  Module". Copying the module out of an installed Chrome — what most small forks do —
  is what the licence does not contemplate, and it breaks whenever either side's major
  version moves.
- **VMP (Verified Media Path) signing.** This is the part worth the paperwork. Without
  it, the CDM has no way to hide the machine's **device certificate**: research from a
  browser team ([Mosaic](https://mosaicbrowser.com/blog/widevine-device-certificate))
  measured the first licence message at 1,704 bytes with the certificate in the clear,
  against 2 bytes from Chrome, which asks for a service certificate first and encrypts
  it. That certificate is identical for every profile on the machine and any page can
  read it by starting a media-key session — a join key across accounts. With VMP the
  CDM uses privacy mode; without it, DRM quietly becomes a fingerprinting surface.
  Some services also refuse, or drop to lower quality, when the signature is missing.

What it costs operationally, so nobody is surprised:

- **Version pairing.** The CDM and the browser want matching major versions; the
  component updater handles the CDM, so the browser must not lag.
- **`.sig` files beside the binary and a re-sign per build.** VMP is a signature over
  the thing that runs; every release is a new conversation, and that is the reason a
  small fork rarely has it.
- **L3 is what a desktop browser gets** — software decryption, so Netflix caps browser
  playback at 720p on desktops, Chrome included. L1 needs chipset vendor code
  (OEMCrypto), not a licence.
- **An AGPL exception to publish**: the module is proprietary, listed separately in
  `THIRD_PARTY_NOTICES.md` and the About panel.

**What we would do first**, in order: corporate email + contact form (a day of
writing); the Master License Agreement (weeks, legal); then integration (`enable_widevine`,
keep the Widevine component in the narrowed allowlist, ship the signatures) — which is
the small part.

**What "a Google binary in the stack" means, concretely.** It is
`widevinecdm.dll`: a closed-source, Google-signed module the browser loads into its own
process tree and calls to decrypt media. Not a request to a service — code executing
inside the browser. Four consequences worth naming:

- **Trust boundary.** We would run bytes nobody here can read, audit or rebuild; the
  only checks on them are Google's signature and our sandbox. Everything else in this
  browser is source we can read.
- **The licence story gets an exception.** Hook is AGPL-3.0-only and dual-licensed; the
  CDM is proprietary and may not be redistributed by us. It has to appear as a separate
  component in `THIRD_PARTY_NOTICES.md` and in the About list, the way every Chromium
  fork that ships DRM does it.
- **It updates out of our hands** — through the component updater, the one Google path
  we decided to narrow. A stale CDM is also how playback breaks.
- **It provisions.** A CDM may fetch device certificates from Google to work at all, so
  adopting Widevine adds more than one host to `--no-google`, each needing a
  documented line.

The distinction to hold on to: a Google *service* is traffic we can measure, list and
turn off. A Google *binary* is a piece of the browser we cannot verify. Both can be
acceptable; only the second cannot be inspected.

**What Firefox does, and the model to copy.** Firefox has shipped DRM since 2014 under
exactly this constraint:

- **Nothing is bundled.** "Widevine Content Decryption Module provided by Google Inc."
  arrives as a separate download through Firefox's media-plugin updater and is listed
  in the add-ons manager as Google's, not Mozilla's;
- **it is a setting** — "Play DRM-controlled content" (`media.eme.enabled`) — and the
  download only happens for a profile that wants it;
- **without it, a DRM page plays nothing**, and Firefox says so rather than failing
  silently.

That is the design to adopt if we license Widevine: **off by default, downloaded on
first use, removable, never in the installer** — which keeps "the browser contains no
Google binary" true until a user chooses otherwise, and keeps the installer free of a
component we may not redistribute. Firefox's weak spot is the nag bar it shows on every
DRM page once DRM is switched off; ours would ask once.

What is lost without it (today): Netflix, Disney+, Prime Video, HBO Max, Hulu and
Spotify web refuse to play; YouTube works (its normal videos are not DRM). L3
(software) is what a desktop browser gets, which is what Chrome uses.

Alternatives, briefly: **PlayReady** (Microsoft, used by Edge) is a separate licence
and a CDM nobody has written for this tree — months of work, not a switch;
**ClearKey** is free and useless for real content; **FairPlay** is Safari-only. So the
real choice is Widevine or no DRM, and Widevine being free means the cost is legal
process plus one Google dependency.

### The rest

- **Password vault.** Synced through the account, and ours: likely our own manager on
  an open implementation (Bitwarden was the name). Ignored for now; the browser keeps
  Chromium's local password store until then.
- **Safe Browsing settings toggle.** Stays until the replacement lands, so a user can
  still see and turn the state on. Removing it is part of that work, not before.
- **Wordmark.** The product name drawn as a **picture**, because one place needs an
  image rather than text. Four files, all in the Chromium checkout
  (`C:/Dev/cr/src/chrome/app/theme/`), shipped as **`0016-wordmark`**:

  | File | Size |
  | --- | --- |
  | `default_100_percent/chromium/product_logo_name_22.png` | 67x22, ink `#24241e` |
  | `default_100_percent/chromium/product_logo_name_22_white.png` | 67x22, white + hairline ring |
  | `default_200_percent/chromium/product_logo_name_22.png` | 134x44 (the 2x) |
  | `default_200_percent/chromium/product_logo_name_22_white.png` | 134x44 |

  One caller: `ChromeLogoImageView` in
  `chrome/browser/ui/views/payments/payment_request_views_util.cc:55-76`, the payment
  sheet's header, whose tooltip is `IDS_PRODUCT_NAME` — so the tooltip already said Hook
  Browser while the artwork still said Chromium. Height is what matters (22 px and 44 px);
  the width is free, 97 px being how wide "chromium" is in that face and 67 px how wide
  "Hook" is.

  **Done, option (a)**: a lockup of the app icon and "Hook" in **Inter** — the face
  `--font-sans` already names, OFL-1.1, so no new licence line, and the `.woff2` comes
  from `node_modules/@fontsource-variable/inter`, not from the tree. Rendered by the built
  browser rather than an imaging library, so the type is the renderer's own. The page that
  does it is `browser/tools/wordmark.html`; its header carries the four commands, and
  re-rendering it reproduces the shipped files byte for byte.

  Geometry, in units of the 1x (u): mark 22 u square at x=0, gap 5.5 u, word 15.5 u at
  weight 550, baseline at 16.6 u — which puts the cap band 10–33 of 44 at 2x, the same
  proportions as Chromium's. Two traps, both worth keeping:

  - **The 2x must be exactly twice the 1x**, or grit raises a scale mismatch and the
    resource build fails. So the canvas is cropped to the ink box (67x22), not to the
    97x22 the upstream file used.
  - **The tile is near-black**, so on a dark sheet it disappears and the lockup loses its
    shape. The white files carry a 1 px ring at 30 % white, derived from the icon's own
    alpha channel (`alpha - erode(alpha)`), so the outline follows its rounded corners
    exactly. Without it the dark-mode header is a floating white hook.

  Design may still replace all four; the geometry and those two rules are the spec.
  Otherwise: transparent PNG, no matting, no shadow, legible at 22 px on both sheets.
- **The new tab page's mark.** `browser/overlay/src/hook/resources/newtab_mark.png`
  (96 px, generated from `apps/chat/src-tauri/icons/icon.png`) is the tile above the
  greeting. It was a black rounded rectangle with nothing in it, because the CSS drew
  the tile and no asset was ever put inside. It is a *copy* of the app icon, so a
  change to the icon means regenerating this file, and a change to the tile's
  rounding means changing both.
- **`chrome.exe`.** Skipped on purpose. Revisit only if an installer registers ProgIDs.

## Still open

- Widevine: the Master License Agreement (decided to pursue, not started).
- A proper wordmark from design (the interim lockup is in place, `0016-wordmark`).
- Start-menu tiles (`win/tiles/{Logo,SmallLogo}.png`), which matter only once an
  installer or MSIX exists.
- Non-English locales: the transformer only rewrites the English source, and the tree
  ships no `.xtb` translations, so every locale falls back to English today. The day
  a translated build exists, the same pass has to cover the translations.

