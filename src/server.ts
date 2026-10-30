import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import * as z from "zod/v4";
import { resetUsage, uncertainRetryGuidance, type ResetResult } from "./codex.ts";

export function createServer(reset = resetUsage): McpServer {
  const server = new McpServer({ name: "agentlereset", version: "0.0.0" });
  let busy = false;
  server.registerTool(
    "reset_usage",
    {
      title: "Reset Codex usage",
      description: [
        "Redeem one banked Codex reset. New resets require an explicit user request.",
        "Uses the local CLI account, possibly different from desktop; desktop reset toggle does not apply.",
        "Use a fresh UUID per new request. Unknown outcome: retry without reconfirmation",
        "using the exact same UUID and account context. Never retry confirmed outcomes or after user cancellation.",
        "Backend eligibility applies. Cancellation/disablement cannot undo dispatch.",
      ].join(" "),
      inputSchema: z.strictObject({ idempotencyKey: z.uuid() }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ idempotencyKey }, ctx) => {
      let result: ResetResult;
      if (busy) {
        result = {
          idempotencyKey,
          status: "busy",
          error:
            "Another reset request is active in this server process. This request was not dispatched or queued.",
        };
      } else {
        busy = true;
        try {
          result = await reset(idempotencyKey, ctx.mcpReq.signal);
        } catch {
          // A backend bug must not encourage a fresh reset after a possibly sent request.
          result = {
            idempotencyKey,
            status: "uncertain",
            error: "Unexpected reset adapter failure",
            retry: uncertainRetryGuidance,
          };
        } finally {
          busy = false;
        }
      }
      return {
        isError: result.status !== undefined,
        content: [{ type: "text", text: JSON.stringify(result) }],
        structuredContent: result,
      };
    },
  );
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const handle = serveStdio(() => createServer(), {
    onerror: () => console.error("MCP transport error"),
  });
  const close = () => {
    handle.close().catch(() => {
      console.error("Could not close MCP transport");
      process.exitCode = 1;
    });
  };
  process.once("SIGTERM", close);
  process.once("SIGINT", close);
}
