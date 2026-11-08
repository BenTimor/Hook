// Minimal pi RPC stand-in used by the agent lifecycle test. It speaks just
// enough of the protocol to prove Hook's supervisor, state machine and wake
// plumbing, without spawning a real model.
import { createInterface } from "node:readline";

const send = (record) => process.stdout.write(JSON.stringify(record) + "\n");

// Prove the sandbox flags arrived (Hook always passes them).
const flags = process.argv.slice(2).join(" ");
if (!flags.includes("--mode rpc")) {
  process.stderr.write("fake-pi: expected --mode rpc, got: " + flags + "\n");
  process.exit(2);
}

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let command;
  try {
    command = JSON.parse(line);
  } catch {
    return;
  }

  if (command.type === "get_state") {
    send({ id: command.id, type: "response", command: "get_state", success: true, data: { isStreaming: false } });
    return;
  }

  if (command.type === "prompt") {
    send({ id: command.id, type: "response", command: "prompt", success: true, data: { disposition: "started" } });
    send({ type: "agent_start" });
    send({ type: "turn_start" });
    send({
      type: "tool_execution_start",
      toolCallId: "call_fake_1",
      toolName: "bash",
      args: { command: "echo hello", timeout: 30 },
    });
    send({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Done: added three files and the tests pass." }],
        stopReason: "stop",
      },
    });
    send({ type: "agent_settled", aborted: false });
    return;
  }

  if (command.type === "steer") {
    send({ id: command.id ?? "steer", type: "response", command: "steer", success: true, data: { disposition: "queued" } });
    return;
  }

  if (command.type === "abort") {
    send({ type: "agent_settled", aborted: true });
    return;
  }
});

// Stay alive like a real pi process until stdin closes.
rl.on("close", () => process.exit(0));
