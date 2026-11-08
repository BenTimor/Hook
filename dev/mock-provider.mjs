/**
 * Local OpenAI-compatible provider used for development: `pnpm mock`.
 *
 * It streams plain Markdown, and it can also exercise the tool path: when the
 * request offers tools and the user message mentions "project" or "create", the
 * first round answers with a streamed `tool_calls` delta (arguments split across
 * frames, like a real provider), then the second round summarises the tool
 * result. That makes the whole agent loop testable without spending tokens.
 */
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
      /* ignore malformed body */
    }

    const messages = Array.isArray(payload.messages) ? payload.messages : [];
    const toolsOffered = Array.isArray(payload.tools) && payload.tools.length > 0;
    // Only tool traffic produced for the latest user message counts, otherwise
    // old results in the transcript would suppress a fresh tool round.
    const lastUserIndex = messages.map((m) => m.role).lastIndexOf("user");
    const toolResults = messages.slice(lastUserIndex + 1).filter((m) => m.role === "tool");
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    const userText = typeof lastUser?.content === "string" ? lastUser.content : "";

    console.log(
      "request:",
      payload.model,
      "msgs:",
      messages.length,
      "tools:",
      toolsOffered,
      "toolResults:",
      toolResults.length,
      "effort:",
      payload.reasoning_effort,
    );

    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });

    const id = "chatcmpl-mock";
    const write = (chunk) =>
      res.write(
        `data: ${JSON.stringify({
          id,
          object: "chat.completion.chunk",
          model: payload.model ?? "hook-mock",
          ...chunk,
        })}\n\n`,
      );
    const finish = () => {
      write({
        choices: [],
        usage: { prompt_tokens: 48, completion_tokens: 214 },
      });
      res.write("data: [DONE]\n\n");
      res.end();
    };

    // Round one: ask for a tool instead of answering.
    if (toolsOffered && toolResults.length === 0 && /\b(project|projects|create)\b/i.test(userText)) {
      const wantsCreate = /\bcreate\b/i.test(userText);
      const call = wantsCreate
        ? {
            name: "create_project",
            arguments: JSON.stringify({
              name: "mock-demo",
              description: "Created by the mock provider to exercise the tool loop.",
            }),
          }
        : { name: "list_projects", arguments: "{}" };

      write({
        choices: [
          {
            index: 0,
            delta: {
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: "call_mock_1",
                  type: "function",
                  function: { name: call.name, arguments: "" },
                },
              ],
            },
          },
        ],
      });

      const half = Math.ceil(call.arguments.length / 2);
      const parts = [call.arguments.slice(0, half), call.arguments.slice(half)];
      let step = 0;
      const pump = () => {
        if (step < parts.length) {
          write({
            choices: [
              {
                index: 0,
                delta: { tool_calls: [{ index: 0, function: { arguments: parts[step++] } }] },
              },
            ],
          });
          setTimeout(pump, 45);
          return;
        }
        write({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
        finish();
      };
      setTimeout(pump, 60);
      return;
    }

    // Round two: summarise whatever the tool returned.
    let reply = REPLY;
    if (toolResults.length) {
      const text = String(toolResults[toolResults.length - 1].content ?? "");
      try {
        const parsed = JSON.parse(text);
        if (Array.isArray(parsed.projects)) {
          const names = parsed.projects.map((p) => p.project ?? p.name).join(", ");
          reply = parsed.projects.length
            ? `You have ${parsed.projects.length} project${parsed.projects.length === 1 ? "" : "s"}: ${names}.\n\nWant me to start a coding agent in one of them?`
            : "You have no projects yet. Tell me what to build and I'll create one, then hand it to a coding agent.";
        } else if (parsed.created) {
          reply = `Created **${parsed.created}**. Want me to start a coding agent in it?`;
        } else if (parsed.error) {
          reply = `That did not work: ${parsed.error}`;
        }
      } catch {
        reply = "The tool returned something I could not read.";
      }
    }

    const tokens = reply.match(/\s+|\S+/g) ?? [];
    let i = 0;
    const send = () => {
      if (i >= tokens.length) {
        write({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
        finish();
        return;
      }
      write({ choices: [{ index: 0, delta: { content: tokens[i++] }, finish_reason: null }] });
      setTimeout(send, 14);
    };
    setTimeout(send, 250);
  });
});

server.listen(8787, "127.0.0.1", () => console.log("mock provider on http://127.0.0.1:8787/v1"));
