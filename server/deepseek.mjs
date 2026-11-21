import { json, Router } from "express";
import {
  FREE_MESSAGE_LIMIT,
  isFreePlan,
  planOf,
  quotaUsed,
} from "./plans.mjs";
import { apiError, requireApiUser } from "./tokens.mjs";

/**
 * A transparent OpenAI-compatible endpoint in front of DeepSeek.
 *
 * Hook (and the pi coding agent Hook ships) send the same shape they would
 * send to DeepSeek: `{ messages, tools?, stream? }`. The `model` field is
 * accepted for compatibility but ignored — this deployment serves exactly one
 * upstream model, chosen by the server. The request is forwarded with the
 * server's key, the SSE stream is relayed byte-for-byte, and the usage block
 * is mirrored into `usage_events` so token counts and cache hits can be
 * analysed per user, per chat and per coding-agent run.
 */

const DEFAULT_MODEL = "deepseek-flash";
const MAX_CONCURRENT = 8;
const MAX_PER_MINUTE = 240;

function upstreamBase(env) {
  const base = (env.DEEPSEEK_BASE_URL || "https://api.deepseek.com").replace(
    /\/+$/,
    "",
  );
  return base.replace(/\/(chat\/completions|completions)$/, "");
}

function upstreamUrl(env) {
  const base = upstreamBase(env);
  if (base.endsWith("/chat/completions")) return base;
  return `${base}/chat/completions`;
}

/** DeepSeek's standalone Search API lives under /v1/tools/search. */
function searchUrl(env) {
  const base = upstreamBase(env);
  return base.endsWith("/v1")
    ? `${base}/tools/search`
    : `${base}/v1/tools/search`;
}

function headerId(req, name, max = 120) {
  const raw = req.get(name);
  if (typeof raw !== "string") return null;
  const value = raw.trim().slice(0, max);
  return value || null;
}

function parseUsage(value) {
  if (!value || typeof value !== "object") return null;
  const prompt = Number(value.prompt_tokens) || 0;
  const completion = Number(value.completion_tokens) || 0;
  const hit =
    Number(value.prompt_cache_hit_tokens) ||
    Number(value.prompt_tokens_details?.cached_tokens) ||
    0;
  const miss =
    value.prompt_cache_miss_tokens === undefined
      ? Math.max(prompt - hit, 0)
      : Number(value.prompt_cache_miss_tokens) || 0;
  return {
    prompt,
    completion,
    hit,
    miss,
    reasoning: Number(value.completion_tokens_details?.reasoning_tokens) || 0,
  };
}

/**
 * Keep the proxy from being an unbounded fan-out if a token leaks. This is a
 * per-process guard; the real spend control is the approval list.
 */
function createLimiter(maxConcurrent = MAX_CONCURRENT, maxPerMinute = MAX_PER_MINUTE) {
  const buckets = new Map();
  return {
    acquire(subject) {
      const now = Date.now();
      let bucket = buckets.get(subject);
      if (!bucket) {
        bucket = { window: now, count: 0, active: 0 };
        buckets.set(subject, bucket);
      }
      if (now - bucket.window >= 60_000) {
        bucket.window = now;
        bucket.count = 0;
      }
      if (bucket.active >= maxConcurrent)
        return { ok: false, message: "Too many requests in flight. Wait for one to finish." };
      if (bucket.count >= maxPerMinute)
        return { ok: false, message: "Too many requests. Try again in a minute." };
      bucket.count += 1;
      bucket.active += 1;
      if (buckets.size > 10_000) buckets.clear();
      return { ok: true, release: () => (bucket.active = Math.max(0, bucket.active - 1)) };
    },
  };
}

export function createProxyRouter({ env, db }) {
  const router = Router();
  router.use(json({ limit: "64mb" }));
  const limiter = createLimiter();
  // Search is a separate upstream API with its own account-level QPS. Keep it
  // from fanning out faster than a user can reasonably type.
  const searchLimiter = createLimiter(4, 60);
  const modelId = env.HOOK_MODEL_ID || "hook";
  const upstreamModel = env.DEEPSEEK_MODEL || DEFAULT_MODEL;
  const apiKey = env.DEEPSEEK_API_KEY || "";
  const url = upstreamUrl(env);

  function record(req, row, status, usage, started, ttft, model) {
    const elapsed = Date.now() - started;
    try {
      db.prepare(
        `INSERT INTO usage_events
           (google_subject, chat_id, agent_id, surface, model, status,
            prompt_tokens, completion_tokens, cache_hit_tokens,
            cache_miss_tokens, reasoning_tokens, duration_ms, ttft_ms,
            plan, message_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        row.google_subject,
        headerId(req, "x-hook-chat-id"),
        headerId(req, "x-hook-agent-id"),
        headerId(req, "x-hook-surface", 32) || "api",
        model,
        status,
        usage?.prompt ?? 0,
        usage?.completion ?? 0,
        usage?.hit ?? 0,
        usage?.miss ?? 0,
        usage?.reasoning ?? 0,
        elapsed,
        ttft,
        // Kept per event, not read from the account later: a plan change must
        // not rewrite what an old request was served under.
        planOf(row),
        headerId(req, "x-hook-message-id", 64),
      );
    } catch (error) {
      // Usage must never take a reply down with it.
      console.error("hook: could not record model usage", error.message);
    }
  }

  /**
   * `/models` is what Hook asks at startup to learn whether the model can see
   * images. The proxy answers for the one model it serves.
   */
  router.get("/models", (req, res) => {
    const row = requireApiUser(db, req, res);
    if (!row) return;
    res.json({
      object: "list",
      data: [
        {
          id: modelId,
          object: "model",
          owned_by: "hook",
          name: "Hook",
          context_window: Number(env.HOOK_CONTEXT_WINDOW) || 1_048_576,
          max_output_tokens: Number(env.HOOK_MAX_OUTPUT_TOKENS) || 393_216,
          // deepseek-flash accepts image parts; the app asks this card at
          // startup and only sends pictures when the card says so.
          input_modalities: ["text", "image"],
        },
      ],
    });
  });

  /**
   * DeepSeek's standalone Search API, exposed to Hook's agents as a regular
   * function tool. The built-in `deepseek_web_search` server tool cannot be
   * mixed with the agents' own function tools, so they call this instead.
   */
  router.post("/search", async (req, res) => {
    const row = requireApiUser(db, req, res);
    if (!row) return;
    if (!apiKey)
      return apiError(
        res,
        503,
        "The model service is not configured yet.",
        "upstream_unavailable",
      );

    const query = typeof req.body?.query === "string" ? req.body.query.trim() : "";
    if (!query || query.length > 128)
      return apiError(
        res,
        400,
        "`query` must be between 1 and 128 characters.",
        "invalid_query",
      );
    const count = Number.isInteger(req.body?.count)
      ? Math.min(10, Math.max(1, req.body.count))
      : 6;
    const upstream = { query, count };
    if (typeof req.body?.ori_question === "string") {
      const question = req.body.ori_question.trim();
      if (question && question.length <= 128)
        upstream.ori_question = question;
    }
    if (typeof req.body?.need_content === "boolean")
      upstream.need_content = req.body.need_content;

    const slot = searchLimiter.acquire(row.google_subject);
    if (!slot.ok) return apiError(res, 429, slot.message, "rate_limited");
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    res.on("close", () => {
      if (!res.writableEnded) controller.abort();
    });
    try {
      const response = await fetch(searchUrl(env), {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
          "user-agent": "Hook-Proxy/1.0",
        },
        body: JSON.stringify(upstream),
        signal: controller.signal,
      });
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          console.error(
            `hook: the upstream search service rejected the server credentials (${response.status})`,
          );
          return apiError(
            res,
            502,
            "Web search is unavailable right now. Please try again shortly.",
            "upstream_auth",
          );
        }
        const raw = (await response.text()).slice(0, 2_000);
        let message = raw;
        try {
          const parsed = JSON.parse(raw);
          message = parsed?.error?.message || parsed?.message || raw;
        } catch {
          // Keep the provider's text.
        }
        return apiError(
          res,
          response.status === 429 ? 429 : 502,
          `Web search failed: ${message || response.status}`,
          "search_failed",
        );
      }
      const payload = await response.json();
      const results = Array.isArray(payload?.results) ? payload.results : [];
      console.log(
        `hook: web search for ${row.google_subject} (${results.length} results, ${Date.now() - started}ms)`,
      );
      res.json({ query, results });
    } catch (error) {
      if (controller.signal.aborted && !res.headersSent)
        return apiError(res, 504, "Web search timed out. Try again.", "search_timeout");
      if (!res.headersSent)
        return apiError(
          res,
          502,
          `Web search failed: ${error.message}`,
          "search_failed",
        );
    } finally {
      clearTimeout(timer);
      slot.release();
    }
  });

  router.post("/chat/completions", async (req, res) => {
    const row = requireApiUser(db, req, res);
    if (!row) return;

    const body = req.body;
    if (!body || typeof body !== "object" || Array.isArray(body))
      return apiError(res, 400, "Expected a JSON object.", "invalid_body");
    if (!Array.isArray(body.messages) || body.messages.length === 0)
      return apiError(res, 400, "`messages` must be a non-empty array.", "invalid_messages");

    // A free account has no coding agents: its own endpoint is the only way to
    // run one, and hook-core refuses to start one before this is reached. This
    // is the server half, for a token used by something other than Hook.
    const surface = headerId(req, "x-hook-surface", 32) || "api";
    if (isFreePlan(row) && surface === "coding")
      return apiError(
        res,
        403,
        "Coding agents are part of a paid plan. Add your own model provider in Settings to use one.",
        "coding_not_included",
      );

    // The free limit counts user messages, not model requests: one turn with
    // tools makes several calls and must cost one of the hundred.
    if (isFreePlan(row) && quotaUsed(db, row.google_subject) >= FREE_MESSAGE_LIMIT)
      return apiError(
        res,
        429,
        `You have used all ${FREE_MESSAGE_LIMIT} free messages in the last 24 hours. Add your own model provider in Settings, or upgrade to keep going.`,
        "message_limit",
      );

    if (!apiKey)
      return apiError(
        res,
        503,
        "The model service is not configured yet.",
        "upstream_unavailable",
      );

    const slot = limiter.acquire(row.google_subject);
    if (!slot.ok) return apiError(res, 429, slot.message, "rate_limited");

    const started = Date.now();
    const controller = new AbortController();
    let clientGone = false;
    res.on("close", () => {
      if (!res.writableEnded) {
        clientGone = true;
        controller.abort();
      }
    });

    const upstream = {
      ...body,
      model: upstreamModel,
      stream: body.stream !== false,
    };
    upstream.stream_options = {
      ...(body.stream_options && typeof body.stream_options === "object"
        ? body.stream_options
        : {}),
      include_usage: true,
    };

    let usage = null;
    let ttft = null;
    let status = 502;
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
          accept: upstream.stream ? "text/event-stream" : "application/json",
          "user-agent": "Hook-Proxy/1.0",
        },
        body: JSON.stringify(upstream),
        signal: controller.signal,
      });
      status = response.status;
      const contentType = response.headers.get("content-type") || "";

      if (!response.ok) {
        // A bad server-side provider key must not look like a revoked Hook
        // session: the app signs out on 401/403 from this proxy. Surface those
        // as a 502 instead.
        if (response.status === 401 || response.status === 403) {
          console.error(
            `hook: the upstream model service rejected the server credentials (${response.status})`,
          );
          status = 502;
          return apiError(
            res,
            502,
            "The model service is unavailable right now. Please try again shortly.",
            "upstream_auth",
          );
        }
        const raw = (await response.text()).slice(0, 16_384);
        let payload = raw;
        try {
          payload = JSON.parse(raw);
        } catch {
          // Relay the provider's text as-is; it is already an error.
        }
        res.status(response.status);
        if (typeof payload === "string")
          return res.type(contentType || "text/plain").send(payload);
        return res.type("application/json").json(payload);
      }

      if (!contentType.includes("text/event-stream")) {
        const payload = await response.json();
        usage = parseUsage(payload.usage);
        res.status(200).json(payload);
        return;
      }

      res.status(200);
      res.set({
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-store",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });
      res.flushHeaders?.();

      const decoder = new TextDecoder();
      let buffer = "";
      for await (const chunk of response.body) {
        if (res.writableEnded) break;
        if (ttft === null) ttft = Date.now() - started;
        res.write(chunk);
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;
          const data = trimmed.slice(5).trim();
          if (!data || data === "[DONE]") continue;
          try {
            const frame = JSON.parse(data);
            if (frame.usage) usage = parseUsage(frame.usage);
          } catch {
            // A partial or non-JSON frame is not ours to interpret.
          }
        }
      }
      res.end();
    } catch (error) {
      if (clientGone) {
        status = 499;
      } else {
        status = 502;
        if (res.headersSent) {
          // The reply has started; finish the SSE stream with an error frame
          // rather than leaving the client waiting forever.
          if (!res.writableEnded) {
            res.write(
              `data: ${JSON.stringify({
                error: { message: `Upstream stream failed: ${error.message}` },
              })}\n\n`,
            );
            res.end();
          }
        } else {
          apiError(res, 502, `Could not reach the model service: ${error.message}`, "upstream_error");
        }
      }
    } finally {
      slot.release();
      // A client abort still represents work the provider may have billed for;
      // the usage frame usually arrived before the abort.
      record(req, row, status, usage, started, ttft, upstreamModel);
    }
  });

  return router;
}
