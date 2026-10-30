// Inert protocol double. It has no network client, credentials or real Codex fallback.
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const write = (text) => {
  process.stdout.write(text);
};
const [mode = "reset", log] = process.argv.slice(2);
const record = (value) => {
  if (log) appendFileSync(log, JSON.stringify(value) + "\n");
};
record({ pid: process.pid });
if (mode === "stubborn") {
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 1000);
}
const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const request = JSON.parse(line);
  record(request);
  const reply = (result) => write(JSON.stringify({ id: request.id, result }) + "\n");
  if (request.method === "initialize") {
    if (mode === "init-timeout") return;
    if (mode === "init-malformed") {
      write("not-json\n");
      return;
    }
    if (mode === "init-error") {
      write(
        JSON.stringify({ id: request.id, error: { code: -1, message: "Unsupported client" } }) +
          "\n",
      );
      return;
    }
    // Notifications and unrelated responses must not resolve the pending initialization.
    process.stdout.write(JSON.stringify({ method: "account/updated", params: {} }) + "\n");
    process.stdout.write(JSON.stringify({ id: 999, result: {} }) + "\n");
    reply({ userAgent: "inert-fake" });
    return;
  }
  if (request.method === "account/rateLimitResetCredit/consume") {
    if (["timeout", "stubborn"].includes(mode)) return;
    if (mode === "exit") {
      process.exit(0);
    }
    if (mode === "malformed") {
      write("not-json\n");
      return;
    }
    if (mode === "rpc-error") {
      write(
        JSON.stringify({ id: request.id, error: { code: -32000, message: "Backend timed out" } }) +
          "\n",
      );
      return;
    }
    if (mode === "unknown") {
      reply({ outcome: "futureOutcome" });
      return;
    }
    reply({
      outcome: ["noCredit", "nothingToReset", "alreadyRedeemed"].includes(mode) ? mode : "reset",
    });
    return;
  }
  if (request.method === "account/rateLimits/read") {
    if (mode === "refresh-error") {
      write(
        JSON.stringify({ id: request.id, error: { code: -1, message: "Refresh unavailable" } }) +
          "\n",
      );
      return;
    }
    reply({ rateLimits: { primary: { usedPercent: 0 } }, ordinaryUsageAllowed: true });
    return;
  }
});
