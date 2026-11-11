import { fileURLToPath } from "node:url";
import express from "express";
import { createWaitlistApi } from "./api.mjs";

const app = express();
app.disable("x-powered-by");

const api = createWaitlistApi(process.env);
app.use((_req, res, next) => {
  res.set({
    // style-src-attr is required by the letter-by-letter demo animation, which
    // sets a --type-at custom property through a style attribute.
    "Content-Security-Policy":
      "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; object-src 'none'; style-src 'self'; style-src-attr 'unsafe-inline'",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  });
  next();
});
app.use("/api/waitlist", api.router);
app.use(express.static(fileURLToPath(new URL("../dist-waitlist", import.meta.url))));

const port = Number(process.env.PORT ?? 5173);
const server = app.listen(port, () => console.log(`Hook waitlist listening on port ${port}`));
server.once("close", api.close);
