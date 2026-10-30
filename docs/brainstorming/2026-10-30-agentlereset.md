---
status: in-progress
---

# Brainstorming: agentlereset

## Context

Create a tiny separate TypeScript project in `/home/korty/dev/agentlereset`.
It packages exactly one local MCP tool as a Codex plugin, providing explicitly
requested banked resets without the desktop assistant tool's local 10% gate.
The user wants plugin enable/disable to be the availability control, with no
custom permissions system, CLI, native UI patches or threshold settings.

This is an architecture proposal only. The project directory and this document
exist; reset-tool implementation, plugin installation and live redemption have not been
authorized by the architecture request. Development tooling was authorized later. No real reset
may be used during design or automated testing.

## Current decisions

- Name and directory: `agentlereset`, `/home/korty/dev/agentlereset`.
- TypeScript, exactly one MCP tool, packaged as a Codex plugin. See Q1.
- No user-facing CLI and no custom permission/settings subsystem. See Q1.
- Use a maintained MCP library rather than writing MCP protocol handling. See Q1.
- Use the official local Codex CLI's `app-server` mode and its signed-in account,
  over private stdio. No desktop shared-socket backend. See Q2.
- Keep the existing reset PR and installed desktop app untouched.

## Q&A

### Q1: What should replace the desktop patch?

**Recommended**

The preceding research compared a CLI plus skill, MCP, existing direct-HTTP
utilities and keeping the native desktop patch. It favored a small helper
around the documented Codex app-server, optionally exposed through MCP.

**Resolved**

The user chose a separate, extremely small project named agentlereset: TypeScript,
one MCP tool, Codex plugin packaging and plugin on/off controls. They rejected a
CLI and a custom permissions design, and requested a library to keep code small.
They asked to see the architecture and structure before implementation.

**Rationale**

Remove recurring minified-bundle maintenance while retaining conversational use.
Plugin availability replaces the proposed helper-specific enable setting.

**Approaches considered**

- CLI plus skill: rejected by the user.
- Local MCP plugin: selected interface and packaging.
- Four-bundle desktop patch: existing work retained, not part of this new project.
- AURES/private HTTP clients: unnecessary auth/deployment or backend coupling.

### Q2: May the plugin use the local Codex CLI login instead of the desktop account?

**Recommended**

Start the official Codex CLI executable in `app-server` mode internally, exchange
documented JSON-RPC messages over private pipes, and close it afterward. The user
does not interact with a CLI. Codex owns authentication, using its local signed-in
account, which may differ from the desktop app's selected account.

**Resolved**

After asking whether this meant the Codex CLI and receiving the explanation above,
the user answered: "Yes, approved". Local CLI authentication and the private
app-server process are approved for v1.

**Rationale**

Keeps the project independent of desktop patches and shared-socket features,
without adding an authentication implementation or a second transport.

**Approaches considered**

- Local official Codex CLI app-server over stdio: approved.
- Desktop-owned shared socket: not selected for v1.

## Tooling setup discussion

The user requested local Git initialization and Oxlint/Oxfmt setup, with the
configuration agreed before applying it. The local repository is initialized on
`main`, with no remote. The user approved tooling configuration and requested lint-staged integration.
This does not authorize implementing the reset tool.

Approved tooling configuration:

- Native TypeScript config files (`oxlint.config.ts`, `oxfmt.config.ts`) using
  each tool's `defineConfig`; no shared-config package.
- Oxlint correctness rules as errors, explicit plugins `eslint`, `typescript`,
  `unicorn`, `oxc`, `import`, `promise`; suspicious rules as advisory warnings; Node environment without browser globals. No blanket pedantic
  or restriction categories.
- Type-aware linting with `oxlint-tsgolint`. Explicit errors for
  `typescript/no-floating-promises` with `ignoreVoid: false`,
  `typescript/no-misused-promises`, and `typescript/await-thenable`. These cover
  asynchronous RPC and child-process handling. A separate TypeScript type check
  is still needed when source is added.
- `no-console` as an error, allowing only `warn` and `error`: MCP stdout is the
  protocol channel. This catches common accidental console output, not every
  possible write to stdout.
- Minimal Oxfmt config containing only ignore patterns; inherit standard style: 100-column wrapping target, two spaces, double quotes,
  semicolons, trailing commas, LF. Preserve prose wrapping, keep automatic import
  sorting off and package.json sorting on.
- Cover the whole repository, including tests/config/docs as supported by each
  tool; exclude generated `dist/`, `coverage/`, dependencies and the lockfile
  from formatting.
- npm development dependencies pinned with a lockfile; scripts `lint`,
  `lint:fix`, `format`, `format:check`, `typecheck`, and `lint:staged`.
- lint-staged uses non-overlapping source/document globs and sequential tasks.
  Source files receive ordinary lint fixes followed by formatting. Husky runs
  `npm run lint:staged` on pre-commit and is installed by npm prepare. No
  `--deny-warnings`, dangerous fixes, or new CI workflow.
- TypeScript and Node types support type-aware linting and a separate type check.
  The tooling requires Node >=24.19.0. Runtime compatibility is still to be defined.

Status: approved and implemented. The user explicitly accepted `ignoreVoid: false`,
advisory warnings without `--deny-warnings`, and the minimal formatter config,
then requested lint-staged and instructed implementation.

References: [Oxlint configuration](https://oxc.rs/docs/guide/usage/linter/config.html),
[type-aware linting](https://oxc.rs/docs/guide/usage/linter/type-aware.html),
[Oxfmt configuration](https://oxc.rs/docs/guide/usage/formatter/config.html).

### Tooling verification

Verified repository lint, formatting, and TypeScript checks. A disposable Git
repository using the same configuration and installed dependencies verified:

- The actual Husky pre-commit hook formats and stages source changes.
- An unhandled promise prefixed with `void` blocks the commit.
- A suspicious self-import warning is reported but does not block the commit.
- Formatting partially staged source preserves unrelated unstaged edits.
- An ignored lockfile does not cause a formatter selection failure or get rewritten.

These fixtures contain no reset code or backend calls. No application implementation,
plugin installation or publication was performed. The user subsequently authorized
committing the local project setup, including this proposal.

### Implementation readiness

The backend and tooling are approved. The architecture as a whole is still a
proposal, with two consequential behavior choices awaiting agreement:

1. Tool input and retry contract: recommend the proposed required
   `idempotencyKey` UUID, supplied by the caller and reused for the same logical
   request after an uncertain response. No automatic retries or local request
   journal. This relies on the caller preserving the key and the same account
   context; it does not guarantee deduplication across account changes.
   A zero-argument tool would require a different recovery design to avoid
   generating a fresh request identity after an ambiguous outcome.
2. Concurrent calls: recommend rejecting an overlapping call as busy instead of
   queueing it. Queueing a second redemption can spend another credit later,
   after the situation that prompted the request has changed. The busy guard is
   per server process, not a machine-wide lock.

Implementation can resolve routine details such as timeout values, error wording,
and exact compatible dependency versions. The installed Codex protocol and the
plugin packaging/disablement behavior still require verification with fake
backends. These are technical acceptance checks, not permission to use a real
reset or install into the live app. For initial local development, build the
bundle before installing the plugin; public distribution remains out of scope.

## Proposed architecture

```text
Codex chat
    | one MCP tool: reset_usage
    v
agentlereset (Node.js, MCP over stdio)
    | small JSONL client, private child-process pipes
    v
stock codex app-server
    | Codex-managed authentication and backend request
    v
OpenAI reset service
```

The official MCP SDK handles MCP framing, tool registration and input validation.
Codex app-server speaks its own JSON-RPC protocol, not MCP; its adapter uses
`node:child_process` and `node:readline`, not an MCP client masquerading as a
Codex client. No general-purpose JSON-RPC framework is proposed.

### One tool

Proposed contract: `reset_usage({ idempotencyKey: string })`.

- Use a fresh UUID for each explicitly requested logical reset, and reuse it if
  the same request needs reconciliation after an uncertain response.
- No threshold parameter, selected-percentage storage or client-side 10% gate.
  The backend selects an available credit and decides eligibility.
- The description requires an explicit user request; enabling the plugin merely
  makes this capability available. No custom confirmation token or permission UI.
- Return the backend outcome: `reset`, `alreadyRedeemed`, `nothingToReset`, or
  `noCredit`. Do not call a rejection a successful reset.
- A transport failure after dispatch is an uncertain outcome, not proof of failure.
  Include the same key in the error/result and never automatically send a fresh
  redemption. Caller-supplied stable keys avoid a new persistence subsystem.
- After a confirmed success, read fresh usage for reporting. If this read fails,
  preserve the successful redemption result and report the refresh failure.
- Serialize/reject overlapping calls within one server process. Check cancellation
  before dispatch, use bounded timeouts, and clean up the child process. Neither
  cancellation nor plugin disablement can undo a request already sent.
- MCP metadata must identify the operation as mutating, not read-only. Existing
  host approval policy remains applicable; the plugin does not override it.

This permits an attempt beyond 10%; it does not override OpenAI's service rules.
The current documented manual eligibility is strictly below 80% remaining in at
least one covered allowance. No local replacement for that server decision is
proposed, and the earlier configurable 1-79 range is not needed for this design.

### Two source files

- `src/server.ts`: MCP initialization, exactly one tool/schema, per-process busy
  guard, call orchestration and truthful outcome formatting.
- `src/codex.ts`: private stock app-server child lifecycle, initialization,
  correlated JSONL requests, timeout/error handling and cleanup. Expose only the
  small operations required by this tool, not an arbitrary RPC tool.

Use `@modelcontextprotocol/server`, currently the official stable v2 SDK server
package, plus Zod for the small input schema. Development dependencies: TypeScript,
Node typings and esbuild. Node's test runner is sufficient. Pin actual versions
and a lockfile when implementation starts; the approved development tooling is installed; runtime dependencies remain pending.

The SDK v1 package `@modelcontextprotocol/sdk` is a supported older line, but v2
is the current official stable line. A separate FastMCP-style framework would
add a wrapper without removing the Codex-specific work for this one-tool server.

### Proposed project structure

```text
agentlereset/
├── plugin.json                 # plugin identity
├── mcp.json                    # one stdio server, node dist/server.mjs
├── .agents/plugins/
│   └── marketplace.json        # discover/install this plugin from the repo
├── package.json                # dependencies and build/check/test scripts
├── package-lock.json
├── tsconfig.json
├── .gitignore
├── README.md
├── src/
│   ├── server.ts
│   └── codex.ts
├── test/
│   └── reset.test.ts           # fake app-server; no real account endpoints
├── dist/
│   └── server.mjs              # generated bundle, included in plugin package
└── docs/brainstorming/
    └── 2026-10-30-agentlereset.md
```

This application tree is proposed; the brainstorming document and development
tooling exist today, but no reset implementation or plugin package exists.
The package bundles runtime dependencies into the generated JavaScript. Node and
Codex remain host prerequisites. No dependency downloads on tool invocation,
custom CLI commands, skills, scheduler, plugin hooks, HTTP listener or database.

Use the current root `plugin.json` and `mcp.json` formats. The stdio launcher is
`node ${PLUGIN_ROOT}/dist/server.mjs`, with plugin-root cwd. Marketplace discovery
is packaging metadata, not a second running component. No public-directory
submission or publication is included in this proposal.

## Permission and disablement boundary

The user chose plugin enablement as the capability switch. Do not add another
master switch or make a model-supplied `confirmed: true` field pretend to enforce
authorization. The existing desktop Usage reset toggle does not govern this
separate tool. State that plainly in its README and tool description.

Official documentation supports disabling plugins/bundled MCP servers. It does
not establish an instantaneous cancellation guarantee for an already active call.
Tool catalog refresh and actual disable behavior must be checked against the host
with an inert fake redemption before claiming the switch is effective immediately
in existing chats. No custom permission framework is proposed to compensate.

## Approved authentication authority

Approved for v1: spawn the installed stock `codex app-server` over private
stdio and use its local Codex login. This requires no community socket feature,
no running desktop dependency and no copied tokens or private HTTP auth client.
There is no user-facing CLI, despite using the Codex executable internally.

This local login is not necessarily the desktop chat's current account/workspace,
especially with profile isolation or remote hosts. Do not silently assume equality.

Unselected alternative: connect to the desktop-owned shared app-server socket. This
better preserves the local desktop's auth ownership but adds a dependency on the
community socket feature and running app. It still does not inherit the native
reset permission gate. Supporting both transports is not proposed for tiny v1.

The backend selection is resolved in Q2. Do not add account switching, a desktop
socket fallback or automatic matching to a remote task host.

## Prerequisites and acceptance considerations

The authority/transport is approved. The remaining architecture details are still
proposals. For the local stdio package, require Node, a compatible
stock Codex executable and an existing ChatGPT login; agentlereset has no login UI.

Initial acceptance should use a fake app-server and the MCP SDK's in-memory/test
transport: exactly one tool; no consume on startup/listing/disable checks; one
consume for an invocation; stable supplied keys; truthful all-outcome handling;
no automatic retry after timeout; process cleanup and busy behavior. Confirm that
the packaged bundle starts without fetching dependencies. Any host toggle test
must use a fake backend. Real redemption remains prohibited in this work.

## Sources

- [Official MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)
- [Plugin packaging](https://developers.openai.com/plugins/build/plugins)
- [Local stdio plugin packaging](https://developers.openai.com/plugins/deploy/desktop-only)
- [Plugin-provided MCP policy](https://learn.chatgpt.com/docs/extend/mcp#plugin-provided-mcp-servers)
- [Codex reset RPC](https://learn.chatgpt.com/docs/app-server#8-earned-rate-limit-resets-chatgpt)
- [Reset service eligibility](https://help.openai.com/en/articles/20001498-how-resets-work-in-codex)
- [Prior alternatives research](/home/korty/dev/usage-reset-alternatives-research-20261030/OPTIONS.md)
