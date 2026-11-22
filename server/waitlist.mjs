import { fileURLToPath } from "node:url";
import express from "express";
import { createPlatform } from "./platform.mjs";
import { createRelay } from "./relay.mjs";

const app = express();
app.disable("x-powered-by");

const api = createPlatform(process.env);
app.use((_req, res, next) => {
  res.set({
    // style-src-attr is required by the letter-by-letter demo animation, which
    // sets a --type-at custom property through a style attribute. The Meta Pixel
    // needs connect.facebook.net for fbevents.js and www.facebook.com for its
    // event beacon; everything else stays first-party.
    "Content-Security-Policy":
      "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; object-src 'none'; script-src 'self' https://connect.facebook.net; img-src 'self' https://www.facebook.com; connect-src 'self' https://www.facebook.com https://connect.facebook.net; style-src 'self'; style-src-attr 'unsafe-inline'",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  });
  next();
});
// A preview page arrives on its own subdomain, not under /api. The tunnel
// answers those requests over the machine's outbound socket; everything else
// falls through to the site.
app.use(api.previewTunnel.middleware);
app.use("/api", api.router);
app.use(express.static(fileURLToPath(new URL("../dist-waitlist", import.meta.url))));

const port = Number(process.env.PORT ?? 5173);
const server = app.listen(port, () => console.log(`Hook waitlist listening on port ${port}`));
// The live half of the account: presence, remote commands and chat fan-out.
// It shares the same HTTP server so Caddy has one upstream and one TLS origin.
const relay = createRelay({
  server,
  db: api.db,
  presence: api.presence,
  previewTunnel: api.previewTunnel,
});
server.once("close", () => {
  relay.close();
  api.previewTunnel.close();
  api.close();
});
