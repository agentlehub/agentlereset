import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import * as z from "zod/v4";

const consumeResponse = z.object({
  outcome: z.enum(["reset", "alreadyRedeemed", "nothingToReset", "noCredit"]),
});
const usageResponse = z.object({ rateLimits: z.record(z.string(), z.unknown()) }).loose();
const envelope = z.object({
  id: z.union([z.number(), z.string()]).optional(),
  method: z.string().optional(),
  result: z.unknown().optional(),
  error: z.object({ code: z.number(), message: z.string() }).optional(),
});

export const uncertainRetryGuidance = [
  "The outcome is unknown. You may retry this same request without asking again,",
  "but only with the exact same idempotency key and unchanged Codex account context.",
  "Do not generate a fresh UUID. Do not retry if the user cancelled the request.",
].join(" ");

type Outcome = z.infer<typeof consumeResponse>["outcome"];
export type ResetResult = { idempotencyKey: string; cleanupError?: string } & (
  | {
      outcome: Outcome;
      status?: never;
      error?: never;
      retry?: never;
      // Opaque backend reporting data, not a fully validated permission/eligibility model.
      usage?: z.infer<typeof usageResponse>;
      usageRefreshError?: string;
    }
  | {
      status: "uncertain";
      outcome?: never;
      error: string;
      retry: string;
      usage?: never;
      usageRefreshError?: never;
    }
  | {
      status: "notDispatched" | "busy";
      outcome?: never;
      error: string;
      retry?: never;
      usage?: never;
      usageRefreshError?: never;
    }
);
export type BackendOptions = {
  launch?: () => ChildProcessWithoutNullStreams;
  timeoutMs?: number;
  shutdownMs?: number;
};

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : "Unknown error");

// One private child per admitted invocation. Nothing is spawned by MCP discovery.
class CodexSession {
  private nextId = 0;
  private pending?: {
    id: number;
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
  };
  private failure?: Error;
  private readonly lines;
  private readonly closed: Promise<void>;
  private didClose = false;

  private readonly child: ChildProcessWithoutNullStreams;
  private readonly timeoutMs: number;

  constructor(child: ChildProcessWithoutNullStreams, timeoutMs: number) {
    this.child = child;
    this.timeoutMs = timeoutMs;
    this.closed = new Promise((resolve) =>
      child.once("close", () => {
        this.didClose = true;
        this.fail(new Error("Codex app-server closed"));
        resolve();
      }),
    );
    child.on("error", () =>
      this.fail(new Error("Could not start or communicate with Codex app-server")),
    );
    child.stdin.on("error", () => this.fail(new Error("Codex app-server input closed")));
    child.stdout.on("error", () => this.fail(new Error("Codex app-server output failed")));
    child.stderr.on("error", () =>
      this.fail(new Error("Codex app-server diagnostic stream failed")),
    );
    // Never forward backend diagnostics onto MCP stdout or copy credentials into errors.
    child.stderr.resume();
    this.lines = createInterface({ input: child.stdout });
    this.lines.on("close", () => this.fail(new Error("Codex app-server output closed")));
    this.lines.on("line", (line) => {
      try {
        const message = envelope.parse(JSON.parse(line));
        if (message.method) {
          // This client cannot satisfy interactive auth or approval requests.
          if (message.id !== undefined)
            this.write({
              id: message.id,
              error: { code: -32601, message: "Unsupported client request" },
            });
          return;
        }
        if (!this.pending || message.id !== this.pending.id) return;
        if (message.error) {
          this.pending.reject(
            new Error(`Codex RPC ${message.error.code}: ${message.error.message}`),
          );
        } else if (Object.hasOwn(message, "result")) {
          this.pending.resolve(message.result);
        } else {
          this.fail(new Error("Codex app-server returned an invalid response"));
        }
      } catch {
        this.fail(new Error("Codex app-server returned invalid JSONL"));
      }
    });
  }

  private fail(error: Error) {
    this.failure ??= error;
    this.pending?.reject(this.failure);
  }

  private write(message: unknown) {
    if (this.failure) throw this.failure;
    this.child.stdin.write(JSON.stringify(message) + "\n");
  }

  async request(
    method: "initialize" | "account/rateLimitResetCredit/consume" | "account/rateLimits/read",
    params: unknown,
    signal: AbortSignal,
    onDispatch?: () => void,
  ): Promise<unknown> {
    signal.throwIfAborted();
    if (this.failure) throw this.failure;
    const id = this.nextId++;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const abort = () => this.pending?.reject(new Error("Request cancelled"));
    try {
      return await new Promise<unknown>((resolve, reject) => {
        this.pending = { id, resolve, reject };
        signal.addEventListener("abort", abort, { once: true });
        timer = setTimeout(() => reject(new Error(`Codex ${method} timed out`)), this.timeoutMs);
        // Mark before attempting the write: even a failed write may have partially dispatched.
        onDispatch?.();
        this.write({ id, method, params });
      });
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      this.pending = undefined;
    }
  }

  initialized() {
    this.write({ method: "initialized" });
  }

  async close(graceMs: number): Promise<string | undefined> {
    this.lines.close();
    this.child.stdin.destroy();
    if (!this.didClose) this.child.kill("SIGTERM");
    if (!this.didClose) await this.waitForClose(graceMs);
    if (!this.didClose) {
      this.child.kill("SIGKILL");
      await this.waitForClose(graceMs);
    }
    this.child.stdout.destroy();
    this.child.stderr.destroy();
    if (!this.didClose) {
      this.child.unref();
      return "Codex child did not close within the cleanup deadline after SIGKILL";
    }
    return undefined;
  }

  private async waitForClose(ms: number) {
    const controller = new AbortController();
    try {
      await Promise.race([this.closed, delay(ms, undefined, { signal: controller.signal })]);
    } finally {
      controller.abort();
    }
  }
}

export async function resetUsage(
  idempotencyKey: string,
  signal: AbortSignal,
  options: BackendOptions = {},
): Promise<ResetResult> {
  let session: CodexSession | undefined;
  let dispatched = false;
  let result: ResetResult;
  try {
    signal.throwIfAborted();
    const child = (
      options.launch ??
      (() => spawn("codex", ["app-server", "--listen", "stdio://"], { stdio: "pipe" }))
    )();
    session = new CodexSession(child, options.timeoutMs ?? 30_000);
    await session.request(
      "initialize",
      { clientInfo: { name: "agentlereset", version: "0.0.0" } },
      signal,
    );
    session.initialized();
    const response = consumeResponse.safeParse(
      await session.request(
        "account/rateLimitResetCredit/consume",
        { idempotencyKey },
        signal,
        () => {
          dispatched = true;
        },
      ),
    );
    if (!response.success) throw new Error("Codex returned an unrecognized reset outcome");
    result = { idempotencyKey, outcome: response.data.outcome };
    if (response.data.outcome === "reset" || response.data.outcome === "alreadyRedeemed") {
      try {
        const usage = usageResponse.safeParse(
          await session.request("account/rateLimits/read", null, signal),
        );
        if (!usage.success) throw new Error("Codex returned an invalid usage snapshot");
        result.usage = usage.data;
      } catch (error) {
        result.usageRefreshError = errorMessage(error);
      }
    }
  } catch (error) {
    const failure = { idempotencyKey, error: errorMessage(error) };
    result = dispatched
      ? {
          ...failure,
          status: "uncertain",
          retry: uncertainRetryGuidance,
        }
      : { ...failure, status: "notDispatched" };
  }
  if (session) {
    try {
      const cleanupError = await session.close(options.shutdownMs ?? 500);
      if (cleanupError) result.cleanupError = cleanupError;
    } catch {
      result.cleanupError = "Could not complete Codex child cleanup";
    }
  }
  return result;
}
