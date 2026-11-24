# Web waitlist

The landing page at hookcode.io: running it locally, its copy, its pixel, and the Google client behind sign-in.

The public landing page runs separately from the Tauri desktop app. Use Node
22.13+ and run `pnpm install` followed by `pnpm waitlist:dev`. Open
[http://localhost:5173](http://localhost:5173) to preview the page.

To enable signup locally:

1. Copy `.env.waitlist.example` to `.env.waitlist.local`.
2. In Google Cloud, create a **Web application** OAuth client and register
   `http://localhost:5173/api/waitlist/google/callback` as an authorized redirect URI.
   Add your Google account as a test user if the consent screen is in testing mode.
3. Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` in `.env.waitlist.local`.
   Generate `WAITLIST_SESSION_SECRET` with `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`.
4. Restart `pnpm waitlist:dev`.

To preview onboarding without Google or saving any details, set
`WAITLIST_DEV_MODE=true` in `.env.waitlist.local` and restart `pnpm waitlist:dev`.
“Hook Me In” then opens interests directly. Choices stay in memory only; refreshing
resets the preview. This mode does not read existing signup cookies, open the
database, send progress requests, or save choices to browser storage. It works on
localhost/loopback in the Vite dev server only and is disabled in production
builds, even if the flag is set. Set it to `false` and restart to test real signup.

The onboarding screens, interests, proposed prices, and planned features use
`waitlist/content.json`. Mobile pricing paginates the feature lists to keep all
controls inside the viewport. “Hook Me In” opens Google sign-in first and saves the
verified email immediately. The flow then shows interests, pricing, and the
“You caught us a little early” confirmation. Each interest change and navigation
step saves immediately, including incomplete onboarding. A plan selection saves
its ID and price before completion is recorded separately. Pending changes are
kept locally and retried for the same signed-in account, with an unload delivery
attempt when the visitor leaves. Returning visitors resume their saved step;
older receipts require sign-in to associate new preferences with an identity.

`VITE_WAITLIST_UNLIMITED_USAGE` defaults to `false`. Set it to `true` only after the
usage policy supports the claim, then rebuild. The default copy says “More freedom
to create.” Prices are proposed preferences, and the flow takes no payment.

## Meta Pixel

The production site loads the Meta Pixel (`1156718026779225`) for ad measurement.
`waitlist/metaPixel.ts` owns the loader and activates it only in production builds,
so `pnpm waitlist:dev` never sends events to Meta. Every page load sends `PageView`.
The Google callback redirects a genuinely new signup to
`/?signup=authenticated&lead=1` (or back to the `/authorize` page it came from),
which sends the standard `Lead` event once; a returning sign-in is not counted
again. The CSP in
`server/waitlist.mjs` and `infra/hookcode.caddy` allows the pixel's script and beacon
domains, and `public/privacy.html` documents the pixel and its cookies.

Run `pnpm waitlist:test` for the API, device-login, proxy, usage, download,
private-git and conversation-sync regression checks.

## Google Cloud

The OAuth client lives in its own project so the consent screen is branded for
Hook rather than for the other sites on this box:

| | |
|---|---|
| Project | `hookcode-waitlist` (display name `Hook`) |
| Consent screen | External, **In production** — anyone with a Google Account can join, no cap |
| Scopes | `openid`, `email`, `profile` |
| Client | `Web application` → `Hook Waitlist` |
| Redirect URIs | `https://hookcode.io/api/waitlist/google/callback`, `http://localhost:5173/api/waitlist/google/callback` |
| Branding | app name `Hook`, support/contact `support@hookcode.io`, authorised domain `hookcode.io`, home `https://hookcode.io`, policy links to `/privacy` and `/terms` |

The app name is not brand-verified, so Google's account chooser says “continue to
hookcode.io” instead of “continue to Hook”. Verifying `hookcode.io` in Search
Console (a DNS TXT or the HTML file it gives you, dropped into `public/`) is what
switches that to the app name; nothing else depends on it.

To rotate the client secret: Clients → `Hook Waitlist` → add a new secret, copy it
into `/opt/hook-web/.env`, then `docker compose up -d waitlist`.

`/privacy` and `/terms` are static pages in `public/`, served through
`try_files {path} {path}.html …` and linked from the consent screen.

The landing CTA stays “Hook Me In” and starts Google sign-in. Public
copy and the usage flag are baked into the static build, so rebuild the site
after changing them.

---

[Documentation](README.md) · [Hook](../README.md)
