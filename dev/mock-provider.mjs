import http from "node:http";

const REPLY = `Here's the shape I'd reach for.

### One seam, one contract

Keep the transport behind an async generator so the UI never learns whether tokens arrived over a socket or from a fixture:

\`\`\`ts
async function* streamChat(req: Request): AsyncGenerator<Delta> {
  const res = await fetch(req.url, { signal: req.signal });
  for await (const frame of readSse(res.body!)) {
    yield parseDelta(frame);
  }
}
\`\`\`

### Things that actually bite

1. **Backpressure** — coalesce deltas per animation frame instead of per token.
2. **Partial UTF-8** — buffer bytes, not strings, when splitting frames.
3. **Reconnect** — never lose the partial reply on a dropped stream.

| Failure | Symptom |
| --- | --- |
| No byte buffer | Mojibake on emoji |
| Per-token render | Janky 60fps ceiling |

Handle those three and the rest is styling.`;

const server = http.createServer((req, res) => {
  if (req.method !== "POST") {
    res.writeHead(404).end();
    return;
  }
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    let payload = {};
    try {
      payload = JSON.parse(body || "{}");
    } catch {
      /* ignore */
    }
    console.log("request:", payload.model, "msgs:", payload.messages?.length, "effort:", payload.reasoning_effort);

    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });

    const tokens = REPLY.match(/\s+|\S+/g) ?? [];
    const id = "chatcmpl-mock";
    let i = 0;

    const send = () => {
      if (i >= tokens.length) {
        res.write(
          `data: ${JSON.stringify({
            id,
            object: "chat.completion.chunk",
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          })}\n\n`,
        );
        res.write(
          `data: ${JSON.stringify({
            id,
            object: "chat.completion.chunk",
            choices: [],
            usage: { prompt_tokens: 48, completion_tokens: 214 },
          })}\n\n`,
        );
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }
      const chunk = {
        id,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: payload.model ?? "hook-mock",
        choices: [{ index: 0, delta: { content: tokens[i++] }, finish_reason: null }],
      };
      res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      setTimeout(send, 16);
    };

    setTimeout(send, 250);
  });
});

server.listen(8787, "127.0.0.1", () => console.log("mock provider on http://127.0.0.1:8787/v1"));
