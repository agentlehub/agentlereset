import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import * as z from "zod/v4";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { resetUsage } from "../src/codex.ts";
import { createServer } from "../src/server.ts";

const key = "8ae96ff3-3425-4f4c-8772-b6fd61502868";
const fixture = new URL("./fixtures/app-server.mjs", import.meta.url);

async function backend(mode: string, signal = new AbortController().signal) {
  const dir = await mkdtemp(join(tmpdir(), "agentlereset-test-"));
  const log = join(dir, "requests.jsonl");
  let launches = 0;
  const result = await resetUsage(key, signal, {
    launch: () => {
      launches++;
      return spawn(process.execPath, [fixture.pathname, mode, log], { stdio: "pipe" });
    },
    timeoutMs: 250,
    shutdownMs: 100,
  });
  const records: Record<string, unknown>[] = launches
    ? (await readFile(log, "utf8"))
        .trim()
        .split("\n")
        .map((line) => z.record(z.string(), z.unknown()).parse(JSON.parse(line)))
    : [];
  await rm(dir, { recursive: true, force: true });
  const pid = records[0]?.pid;
  if (typeof pid === "number") assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  return { result, records, launches };
}

for (const outcome of ["reset", "alreadyRedeemed", "nothingToReset", "noCredit"]) {
  await test(`preserves ${outcome} and sends the caller key exactly once`, async () => {
    const { result, records } = await backend(outcome);
    assert.equal(result.outcome, outcome);
    assert.equal(result.idempotencyKey, key);
    const methods = records.flatMap((item) =>
      typeof item.method === "string" ? [item.method] : [],
    );
    assert.deepEqual(methods, [
      "initialize",
      "initialized",
      "account/rateLimitResetCredit/consume",
      ...(["reset", "alreadyRedeemed"].includes(outcome) ? ["account/rateLimits/read"] : []),
    ]);
    const consume = records.find((item) => item.method === "account/rateLimitResetCredit/consume");
    assert.deepEqual(consume?.params, { idempotencyKey: key });
    if (["reset", "alreadyRedeemed"].includes(outcome)) assert.ok(result.usage);
  });
}

for (const mode of ["timeout", "exit", "malformed", "rpc-error", "unknown", "stubborn"]) {
  await test(`${mode} after dispatch is uncertain, is never retried and reaps the child`, async () => {
    const { result, records } = await backend(mode);
    assert.equal(result.status, "uncertain");
    assert.equal(result.idempotencyKey, key);
    assert.match(result.retry, /same.*key.*account/i);
    assert.equal(
      records.filter((item) => item.method === "account/rateLimitResetCredit/consume").length,
      1,
    );
  });
}

for (const mode of ["init-timeout", "init-malformed", "init-error"]) {
  await test(`${mode} never dispatches consume`, async () => {
    const { result, records } = await backend(mode);
    assert.equal(result.status, "notDispatched");
    assert.equal(
      records.some((item) => item.method === "account/rateLimitResetCredit/consume"),
      false,
    );
  });
}

await test("an already-cancelled call never launches a child", async () => {
  const { result, launches } = await backend("reset", AbortSignal.abort());
  assert.equal(result.status, "notDispatched");
  assert.equal(launches, 0);
});

await test("cancellation during initialization prevents dispatch", async () => {
  const controller = new AbortController();
  const pending = backend("init-timeout", controller.signal);
  const timer = setTimeout(() => controller.abort(), 100);
  try {
    assert.equal((await pending).result.status, "notDispatched");
  } finally {
    clearTimeout(timer);
  }
});

await test("cancellation after dispatch preserves uncertainty", async () => {
  const controller = new AbortController();
  const dir = await mkdtemp(join(tmpdir(), "agentlereset-cancel-"));
  const log = join(dir, "requests.jsonl");
  try {
    const pending = resetUsage(key, controller.signal, {
      launch: () => spawn(process.execPath, [fixture.pathname, "timeout", log], { stdio: "pipe" }),
      timeoutMs: 2000,
      shutdownMs: 100,
    });
    for (let i = 0; i < 100; i++) {
      const text = await readFile(log, "utf8").catch(() => "");
      if (text.includes("account/rateLimitResetCredit/consume")) break;
      await delay(10);
    }
    assert.match(await readFile(log, "utf8"), /account\/rateLimitResetCredit\/consume/);
    controller.abort();
    assert.equal((await pending).status, "uncertain");
  } finally {
    controller.abort();
    await rm(dir, { recursive: true, force: true });
  }
});

await test("a confirmed reset survives refresh failure", async () => {
  const { result } = await backend("refresh-error");
  assert.equal(result.outcome, "reset");
  assert.match(String(result.usageRefreshError), /Refresh unavailable/);
});

await test("a missing executable is notDispatched without an unhandled process error", async () => {
  const result = await resetUsage(key, new AbortController().signal, {
    launch: () => spawn("/nonexistent/agentlereset-fake", [], { stdio: "pipe" }),
    timeoutMs: 100,
    shutdownMs: 50,
  });
  assert.equal(result.status, "notDispatched");
});

async function connected(reset: typeof resetUsage) {
  const server = createServer(reset);
  const client = new Client({ name: "inert-tests", version: "0.0.0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  await client.connect(ct);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

await test("MCP lists exactly one mutating tool; discovery and invalid input do not invoke backend", async () => {
  let calls = 0;
  const { client, close } = await connected(async (idempotencyKey) => {
    calls++;
    return { idempotencyKey, outcome: "noCredit" };
  });
  try {
    const { tools } = await client.listTools();
    assert.deepEqual(
      tools.map((tool) => tool.name),
      ["reset_usage"],
    );
    assert.equal(tools[0].annotations?.readOnlyHint, false);
    assert.equal(tools[0].annotations?.destructiveHint, true);
    for (const args of [{}, { idempotencyKey: "bad" }, { idempotencyKey: key, threshold: 10 }]) {
      assert.equal((await client.callTool({ name: "reset_usage", arguments: args })).isError, true);
    }
    assert.equal(calls, 0);
    const result = await client.callTool({
      name: "reset_usage",
      arguments: { idempotencyKey: key },
    });
    assert.equal(
      z.record(z.string(), z.unknown()).parse(result.structuredContent).outcome,
      "noCredit",
    );
    assert.equal(calls, 1);
  } finally {
    await close();
  }
});

await test("MCP rejects overlap as busy, then releases the guard after failure", async () => {
  let release: (() => void) | undefined;
  let entered: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let calls = 0;
  const { client, close } = await connected(async () => {
    calls++;
    entered?.();
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    throw new Error("inert failure");
  });
  try {
    const first = client.callTool({ name: "reset_usage", arguments: { idempotencyKey: key } });
    await started;
    const second = await client.callTool({
      name: "reset_usage",
      arguments: { idempotencyKey: key },
    });
    assert.equal(z.record(z.string(), z.unknown()).parse(second.structuredContent).status, "busy");
    assert.equal(calls, 1);
    release?.();
    await first;
    const third = client.callTool({ name: "reset_usage", arguments: { idempotencyKey: key } });
    await delay(0);
    release?.();
    await third;
    assert.equal(calls, 2);
  } finally {
    release?.();
    await close();
  }
});

await test("caller can reconcile an uncertain request using the same UUID", async () => {
  const keys: string[] = [];
  const { client, close } = await connected(async (idempotencyKey) => {
    keys.push(idempotencyKey);
    return keys.length === 1
      ? {
          idempotencyKey,
          status: "uncertain",
          error: "Inert lost response",
          retry: "Retry using the same key and unchanged account context.",
        }
      : { idempotencyKey, outcome: "alreadyRedeemed" };
  });
  try {
    const first = await client.callTool({
      name: "reset_usage",
      arguments: { idempotencyKey: key },
    });
    assert.equal(first.isError, true);
    assert.equal(
      z.record(z.string(), z.unknown()).parse(first.structuredContent).status,
      "uncertain",
    );
    const retry = await client.callTool({
      name: "reset_usage",
      arguments: { idempotencyKey: key },
    });
    assert.equal(retry.isError, false);
    assert.equal(
      z.record(z.string(), z.unknown()).parse(retry.structuredContent).outcome,
      "alreadyRedeemed",
    );
    assert.deepEqual(keys, [key, key]);
  } finally {
    await close();
  }
});
