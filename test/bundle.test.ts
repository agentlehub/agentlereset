import assert from "node:assert/strict";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import * as z from "zod/v4";

const key = "8ae96ff3-3425-4f4c-8772-b6fd61502868";
const object = z.record(z.string(), z.unknown());
const readJson = async (path: string) => object.parse(JSON.parse(await readFile(path, "utf8")));

async function isolated(mode = "reset", modern = false) {
  const dir = await mkdtemp(join(tmpdir(), "agentlereset-bundle-"));
  const bin = join(dir, "bin");
  const log = join(dir, "requests.jsonl");
  await mkdir(bin);
  await mkdir(join(dir, "dist"));
  await copyFile("dist/server.mjs", join(dir, "dist/server.mjs"));
  await copyFile("plugin.json", join(dir, "plugin.json"));
  await copyFile("mcp.json", join(dir, "mcp.json"));
  await copyFile("test/fixtures/app-server.mjs", join(bin, "app-server.mjs"));
  await symlink(process.execPath, join(bin, "node"));
  // PATH contains only Node and this inert Codex. No fallback to an installed CLI.
  await writeFile(
    join(bin, "codex"),
    `#!${process.execPath}\nimport assert from "node:assert/strict";\nassert.deepEqual(process.argv.slice(2), ["app-server", "--listen", "stdio://"]);\nprocess.argv.splice(2, 3, process.env.INERT_MODE, process.env.INERT_LOG);\nawait import("./app-server.mjs");\n`,
  );
  await chmod(join(bin, "codex"), 0o755);
  const config = z
    .object({
      mcpServers: z.object({
        agentlereset: z.object({
          type: z.literal("stdio"),
          command: z.literal("node"),
          args: z.array(z.string()),
          cwd: z.string(),
        }),
      }),
    })
    .parse(await readJson(join(dir, "mcp.json"))).mcpServers.agentlereset;
  const replaceRoot = (value: string) => value.replaceAll("${PLUGIN_ROOT}", dir);
  const transport = new StdioClientTransport({
    command: config.command,
    args: config.args.map(replaceRoot),
    cwd: replaceRoot(config.cwd),
    env: { PATH: bin, INERT_MODE: mode, INERT_LOG: log },
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const client = new Client(
    { name: "isolated-bundle-test", version: "0.0.0" },
    modern ? { versionNegotiation: { mode: "auto" } } : {},
  );
  try {
    await client.connect(transport);
  } catch (error) {
    await transport.close();
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
  return {
    client,
    log,
    stderr: () => stderr,
    close: async () => {
      await client.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

for (const modern of [false, true]) {
  await test(`isolated bundle uses metadata launcher and inert backend (${modern ? "modern" : "legacy"} MCP)`, async () => {
    const harness = await isolated("reset", modern);
    try {
      const tools = (await harness.client.listTools()).tools;
      assert.deepEqual(
        tools.map((tool) => tool.name),
        ["reset_usage"],
      );
      await assert.rejects(readFile(harness.log), { code: "ENOENT" });
      const result = await harness.client.callTool({
        name: "reset_usage",
        arguments: { idempotencyKey: key },
      });
      assert.equal(object.parse(result.structuredContent).outcome, "reset");
      const records = (await readFile(harness.log, "utf8"))
        .trim()
        .split("\n")
        .map((line) => object.parse(JSON.parse(line)));
      assert.equal(
        records.filter((record) => record.method === "account/rateLimitResetCredit/consume").length,
        1,
      );
      assert.equal(harness.stderr(), "");
    } finally {
      await harness.close();
    }
  });
}

await test("host disconnect aborts an in-flight fake call and reaps its child", async () => {
  const harness = await isolated("stubborn");
  const pending = harness.client
    .callTool({ name: "reset_usage", arguments: { idempotencyKey: key } })
    .catch(() => undefined);
  try {
    let records = "";
    for (let i = 0; i < 100; i++) {
      records = await readFile(harness.log, "utf8").catch(() => "");
      if (records.includes("account/rateLimitResetCredit/consume")) break;
      await delay(10);
    }
    assert.match(records, /account\/rateLimitResetCredit\/consume/);
    const pid = z.object({ pid: z.number() }).parse(JSON.parse(records.split("\n")[0])).pid;
    await harness.client.close();
    await pending;
    let reaped = false;
    for (let i = 0; i < 200; i++) {
      try {
        process.kill(pid, 0);
      } catch {
        reaped = true;
        break;
      }
      await delay(10);
    }
    assert.equal(reaped, true, "fake child must be reaped after MCP stdin closes");
  } finally {
    await harness.close();
  }
});

await test("marketplace points to the root plugin identity", async () => {
  const plugin = await readJson("plugin.json");
  const market = z
    .object({
      plugins: z.array(
        z.object({
          name: z.string(),
          source: z.object({ source: z.literal("local"), path: z.literal("./") }),
        }),
      ),
    })
    .parse(await readJson(".agents/plugins/marketplace.json"));
  assert.equal(market.plugins.length, 1);
  assert.equal(market.plugins[0].name, plugin.name);
});
