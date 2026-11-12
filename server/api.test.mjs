import assert from "node:assert/strict";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { mock } from "node:test";
import express from "express";
import { OAuth2Client } from "google-auth-library";
import { createWaitlistApi } from "./api.mjs";

const secret = "hook-test-session-secret-with-at-least-32-characters";
const clientId = "hook-test.apps.googleusercontent.com";

test("waitlist onboarding preserves existing signups and authenticates preference updates", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "hook-waitlist-test-"));
  const dbPath = join(directory, "signups.sqlite");
  const seed = new DatabaseSync(dbPath);
  seed.exec(`CREATE TABLE waitlist_signups (
    google_subject TEXT PRIMARY KEY NOT NULL, email TEXT NOT NULL,
    joined_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  ) STRICT;
  INSERT INTO waitlist_signups VALUES ('existing', 'old@example.test', '2026-01-01T00:00:00Z');`);
  seed.close();

  const app = express();
  const server = createServer(app);
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const api = createWaitlistApi({
    WAITLIST_ORIGIN: origin,
    WAITLIST_DB_PATH: dbPath,
    GOOGLE_CLIENT_ID: clientId,
    GOOGLE_CLIENT_SECRET: "fixture",
    WAITLIST_SESSION_SECRET: secret,
  });
  app.use("/api/waitlist", api.router);
  const db = new DatabaseSync(dbPath);

  const tokenMock = mock.method(
    OAuth2Client.prototype,
    "getToken",
    async ({ code, codeVerifier }) => {
      const payload = JSON.parse(Buffer.from(code, "base64url").toString());
      assert.equal(
        createHash("sha256").update(codeVerifier).digest("base64url"),
        payload.challenge,
      );
      return { tokens: { id_token: JSON.stringify(payload.account) } };
    },
  );
  const verificationMock = mock.method(
    OAuth2Client.prototype,
    "verifyIdToken",
    async ({ idToken, audience }) => {
      assert.equal(audience, clientId);
      return { getPayload: () => JSON.parse(idToken) };
    },
  );

  async function request(
    path,
    { body, cookie, origin: requestOrigin = origin } = {},
  ) {
    return fetch(`${origin}/api/waitlist${path}`, {
      method: body === undefined ? "GET" : "POST",
      redirect: "manual",
      headers: {
        Origin: requestOrigin,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }
  async function signup(subject, preferences, overrides = {}) {
    const started = await request("/google", { body: preferences });
    assert.equal(started.status, 200);
    const authorize = new URL((await started.json()).url);
    assert.equal(authorize.searchParams.get("scope"), "openid email profile");
    const account = {
      sub: subject,
      email: `${subject}@example.test`,
      email_verified: true,
      name: "Test Member",
      nonce: authorize.searchParams.get("nonce"),
      ...overrides,
    };
    const code = Buffer.from(
      JSON.stringify({
        challenge: authorize.searchParams.get("code_challenge"),
        account,
      }),
    ).toString("base64url");
    const flow = started.headers.getSetCookie()[0].split(";")[0];
    const response = await request(
      `/google/callback?state=${authorize.searchParams.get("state")}&code=${code}`,
      { cookie: flow },
    );
    const receipt = response.headers
      .getSetCookie()
      .find((cookie) => cookie.startsWith("hook_joined="))
      ?.split(";")[0];
    return { response, receipt };
  }

  try {
    await t.test(
      "Google-first signup saves partial interests, price, and completion independently",
      async () => {
        const { response, receipt } = await signup("partial", {
          mode: "onboarding",
        });
        assert.equal(
          response.headers.get("location"),
          "/?signup=authenticated&lead=1",
        );
        const status = async () =>
          (await (await request("/status", { cookie: receipt })).json())
            .profile;
        let profile = await status();
        assert.equal(profile.email, "partial@example.test");
        assert.equal(profile.onboardingStep, "interests");
        assert.ok(profile.onboardingStartedAt);
        assert.equal(profile.onboardingCompletedAt, null);
        assert.equal(profile.planPreference, null);
        assert.equal(profile.selectedPrice, null);
        const session = randomUUID();
        let sequence = 0;
        const event = (action) => ({
          eventId: randomUUID(),
          clientId: session,
          sequence: ++sequence,
          ...action,
        });
        const save = (events, subject = "partial", cookie = receipt) =>
          request("/progress", { cookie, body: { subject, events } });
        const video = event({
          type: "interest_changed",
          interestId: "videos",
          selected: true,
        });
        assert.equal((await save([video])).status, 200);
        profile = await status();
        assert.deepEqual(profile.interests, ["videos"]);
        assert.equal(profile.planPreference, null);
        assert.equal(profile.onboardingCompletedAt, null);
        // A close/retry can send the same action repeatedly without duplicating it.
        assert.equal((await save([video])).status, 200);
        assert.equal(
          db
            .prepare(
              "SELECT COUNT(*) AS count FROM onboarding_events WHERE google_subject = 'partial'",
            )
            .get().count,
          1,
        );
        const deselect = event({
          type: "interest_changed",
          interestId: "videos",
          selected: false,
        });
        const reselect = event({
          type: "interest_changed",
          interestId: "videos",
          selected: true,
        });
        assert.equal((await save([reselect, deselect])).status, 200);
        assert.deepEqual((await status()).interests, ["videos"]);
        assert.equal(
          db
            .prepare("SELECT applied FROM onboarding_events WHERE event_id = ?")
            .get(deselect.eventId).applied,
          0,
        );
        // Independent interests merge even if they arrive in reverse order.
        const apps = event({
          type: "interest_changed",
          interestId: "apps",
          selected: true,
        });
        const design = event({
          type: "interest_changed",
          interestId: "design",
          selected: true,
        });
        assert.equal((await save([design, apps])).status, 200);
        assert.deepEqual(
          new Set((await status()).interests),
          new Set(["videos", "apps", "design"]),
        );
        assert.equal(
          (await save([event({ type: "step_changed", step: "pricing" })]))
            .status,
          200,
        );
        assert.equal((await status()).onboardingStep, "pricing");
        assert.equal(
          (await save([event({ type: "completed", planPreference: "pro" })]))
            .status,
          409,
        );
        const plan = event({ type: "plan_selected", planPreference: "pro" });
        assert.equal((await save([plan])).status, 200);
        profile = await status();
        assert.equal(profile.planPreference, "pro");
        assert.deepEqual(profile.selectedPrice, {
          amountCents: 8000,
          currency: "USD",
          period: "/month",
        });
        assert.equal(profile.onboardingCompletedAt, null);
        const details = JSON.parse(
          db
            .prepare("SELECT details FROM onboarding_events WHERE event_id = ?")
            .get(plan.eventId).details,
        );
        assert.deepEqual(details.price, profile.selectedPrice);
        const finish = event({ type: "completed", planPreference: "pro" });
        assert.equal((await save([finish])).status, 200);
        profile = await status();
        assert.equal(profile.onboardingStep, "completed");
        assert.ok(profile.onboardingCompletedAt);
        assert.equal((await save([finish])).status, 200);
        assert.equal(
          (await status()).onboardingCompletedAt,
          profile.onboardingCompletedAt,
        );
        assert.equal((await save([video], "existing")).status, 409);
        assert.equal((await save([video], "partial", "")).status, 401);
        const before = db
          .prepare("SELECT COUNT(*) AS count FROM onboarding_events")
          .get().count;
        assert.equal(
          (
            await save([
              event({
                type: "interest_changed",
                interestId: "videos",
                selected: false,
              }),
              event({
                type: "interest_changed",
                interestId: "unknown",
                selected: true,
              }),
            ])
          ).status,
          400,
        );
        assert.equal(
          db.prepare("SELECT COUNT(*) AS count FROM onboarding_events").get()
            .count,
          before,
        );
        assert.ok((await status()).interests.includes("videos"));
        const resumed = await request("/google", {
          cookie: receipt,
          body: { mode: "onboarding" },
        });
        assert.equal((await resumed.json()).authenticated, true);
      },
    );

    await t.test(
      "migrates an old row and retains its first signup timestamp on repeated signup",
      async () => {
        const original = db
          .prepare(
            "SELECT * FROM waitlist_signups WHERE google_subject = 'existing'",
          )
          .get();
        assert.equal(original.interests, "[]");
        assert.equal(original.waitlist_status, "waitlisted");
        const preferences = {
          interests: ["websites", "apps"],
          planPreference: "pro",
        };
        const { response, receipt } = await signup("existing", preferences);
        assert.equal(response.headers.get("location"), "/");
        const status = await (
          await request("/status", { cookie: receipt })
        ).json();
        assert.equal(status.profile.id, "existing");
        assert.equal(status.profile.name, "Test Member");
        assert.deepEqual(status.profile.interests, preferences.interests);
        assert.equal(status.profile.planPreference, "pro");
        assert.equal(status.profile.joinedAt, original.joined_at);
        await signup("existing", preferences, {
          email: "updated@example.test",
        });
        assert.equal(
          db
            .prepare(
              "SELECT COUNT(*) AS count FROM waitlist_signups WHERE google_subject = 'existing'",
            )
            .get().count,
          1,
        );
        assert.equal(
          db
            .prepare(
              "SELECT email FROM waitlist_signups WHERE google_subject = 'existing'",
            )
            .get().email,
          "updated@example.test",
        );
      },
    );

    await t.test(
      "skip records no interests and an authenticated visitor can change plans without another OAuth exchange",
      async () => {
        const { receipt } = await signup("skip", {
          interests: [],
          planPreference: "plus",
        });
        const before = tokenMock.mock.callCount();
        let profile = (
          await (await request("/status", { cookie: receipt })).json()
        ).profile;
        assert.deepEqual(profile.interests, []);
        assert.equal(profile.planPreference, "plus");
        const response = await request("/preferences", {
          cookie: receipt,
          body: { interests: ["study", "writing"], planPreference: "pro" },
        });
        assert.equal(response.status, 200);
        assert.equal(tokenMock.mock.callCount(), before);
        profile = (await (await request("/status", { cookie: receipt })).json())
          .profile;
        assert.deepEqual(profile.interests, ["study", "writing"]);
        assert.equal(profile.planPreference, "pro");
        const resumed = await request("/google", {
          cookie: receipt,
          body: { interests: ["apps"], planPreference: "plus" },
        });
        assert.deepEqual(await resumed.json(), { joined: true });
        assert.equal(tokenMock.mock.callCount(), before);
        assert.equal(
          (
            await request("/preferences", {
              body: { interests: [], planPreference: "plus" },
            })
          ).status,
          401,
        );
      },
    );

    await t.test(
      "rejects unknown preferences, cross-origin requests, invalid nonce, unverified email, and forged receipts",
      async () => {
        assert.equal(
          (
            await request("/google", {
              body: { interests: ["unknown"], planPreference: "plus" },
            })
          ).status,
          400,
        );
        assert.equal(
          (
            await request("/google", {
              body: { interests: [], planPreference: "unknown" },
            })
          ).status,
          400,
        );
        assert.equal(
          (
            await request("/google", {
              body: [],
              origin: "https://untrusted.example",
            })
          ).status,
          403,
        );
        assert.equal((await request("/google", { body: [] })).status, 400);
        for (const overrides of [
          { nonce: "wrong" },
          { email_verified: false },
        ]) {
          const { response } = await signup(
            "refused",
            { interests: [], planPreference: "plus" },
            overrides,
          );
          assert.equal(response.headers.get("location"), "/?signup=unverified");
        }
        assert.equal(
          db
            .prepare(
              "SELECT COUNT(*) AS count FROM waitlist_signups WHERE google_subject = 'refused'",
            )
            .get().count,
          0,
        );
        const forged = `hook_joined=eyJqb2luZWQiOnRydWV9.${"a".repeat(43)}`;
        assert.equal(
          (await (await request("/status", { cookie: forged })).json()).joined,
          false,
        );
        assert.equal(
          (
            await request("/google/callback?state=wrong&code=wrong")
          ).headers.get("location"),
          "/?signup=expired",
        );
      },
    );

    await t.test(
      "supports legacy signup requests and receipts without assigning invented interests or identities",
      async () => {
        const { response, receipt } = await signup("legacy", {});
        assert.equal(response.headers.get("location"), "/?lead=1");
        const profile = (
          await (await request("/status", { cookie: receipt })).json()
        ).profile;
        assert.deepEqual(profile.interests, []);
        assert.equal(profile.planPreference, null);
        const payload = Buffer.from(
          JSON.stringify({ joined: true, expires: Date.now() + 60000 }),
        ).toString("base64url");
        const signature = createHmac("sha256", secret)
          .update(payload)
          .digest("base64url");
        const legacy = `hook_joined=${payload}.${signature}`;
        assert.deepEqual(
          await (await request("/status", { cookie: legacy })).json(),
          { joined: true, profile: null },
        );
        assert.equal(
          (
            await request("/preferences", {
              cookie: legacy,
              body: { interests: [], planPreference: "plus" },
            })
          ).status,
          401,
        );
      },
    );
  } finally {
    tokenMock.mock.restore();
    verificationMock.mock.restore();
    db.close();
    await new Promise((done) => server.close(done));
    api.close();
    if (dirname(resolve(directory)) !== resolve(tmpdir()))
      throw new Error("Unexpected test cleanup directory");
    rmSync(directory, { recursive: true, force: true });
  }
});
