# Screenshots and diagrams

Every picture here was taken from the running app, not drawn. Nothing in them
comes from a real account: the UI was served by the bundled mock backend
(`pnpm dev`, `pnpm mobile:dev`), whose seeded conversations, project names and
board are fixtures in `apps/chat/src/lib/mock.ts` and `apps/mobile/src/lib/demo.ts`.

| File | What it shows | How it is produced |
| --- | --- | --- |
| `hook-chat.png` | The chat window: markdown, a code block, the composer | `pnpm dev`, one message typed, waited for the reply to finish |
| `hook-advanced.png` | Advanced mode: the agents tree, a fold of thinking and tool calls, a live plan above the composer | `http://127.0.0.1:1420/?advanced=1&agents=1`, then the "Build the launch page" chat |
| `hook-preview.png` | A Workspace board in the side panel, beside the conversation | `?advanced=1&preview=board` |
| `hook-document.png` | A document drawn as a page: callout, checklist, table, keys | `?advanced=1&preview=document` |
| `hook-phone.png` | HookCode's home screen | `pnpm mobile:dev` at a 430×932 viewport |
| `hook-phone-preview.png` | A board in the phone's preview sheet | the same, after asking for the board |
| `hook-demo.gif` / `.mp4` | Ten seconds: type, send, stream, answer | CDP screencast of the same first capture, encoded with ffmpeg |
| `architecture.svg` | Products → shared packages → `hook-core` → one account service | hand-written SVG |
| `sync.svg` | Two devices, one merge point, and the gate in front of it | hand-written SVG |

The other URL flags the mock understands are documented next to it
(`?login=1`, `?update=1`, `?agents=needs_input`, `?preview=waiting|done|task`,
`?plan=free`, `?sync=off`, `?byok=1`); they exist so a screen can be reviewed
without an account.

## Regenerating them

The captures were driven over the Chrome DevTools Protocol: launch a headless
Chromium with `--remote-debugging-port`, `Page.navigate` to one of the URLs
above, `Emulation.setDeviceMetricsOverride` for the size (2× device scale, then
downscaled to 1800px wide), and `Page.captureScreenshot`. For the video,
`Page.startScreencast` records a JPEG per paint; the frames are fed to ffmpeg
through a concat file built from the real timestamps, once as H.264 and once as
a palette-optimised GIF.

Two rules when replacing one of these:

- Keep the text in the picture short enough to read at the size it is displayed
  (the README shows them at ~840px).
- Never capture a signed-in account's real conversations, project paths or
  email. Use the mock backend, or a fresh profile.
