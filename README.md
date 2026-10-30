# agentlereset

Ask Codex to use a banked usage reset directly from chat.
Each successful reset spends one banked reset credit. Your account must have a
credit available and be eligible for a reset.

## Requirements

- Codex with plugin support.
- The official Codex CLI installed and signed in to your ChatGPT account.
  Run `codex login` if you have not signed in yet.
- Node.js 24.19 or newer, npm, and Git to install from source.

## Install

Clone and build the plugin:

```sh
git clone https://github.com/agentlehub/agentlereset.git
cd agentlereset
npm ci
npm run build
```

Then install it using [Codex's plugin manager](https://learn.chatgpt.com/docs/developer-commands#codex-plugin):

```sh
codex plugin marketplace add "$PWD"
codex plugin add agentlereset@agentlereset-local
```

In Codex's plugin browser, make sure **agentlereset** is enabled, then start a
new chat. Build before installing: the plugin uses a copy of the built files.

## Use

Ask Codex directly:

> Use agentlereset to reset my Codex usage now.

Codex calls the `reset_usage` tool and reports the result. It will tell you
whether a reset was used, the same request had already succeeded, no credit was
available, or your usage was not eligible. The service decides eligibility;
agentlereset does not impose a percentage threshold or override service rules.

If the outcome is unclear, Codex may retry the original request without asking
again. It reuses the same request ID and account to avoid spending another credit.

## Account and controls

**Resets use the account signed in to the local Codex CLI.** This may differ from
the account selected in the desktop app. Make sure the CLI is signed in to the
account you want to reset.

Enable or disable **agentlereset** in the plugin browser to control its availability.
The desktop app's separate Usage reset toggle does not control this plugin.
Cancelling a request or disabling the plugin cannot undo a reset already sent.

## Troubleshooting

- **Tool not available:** check that the plugin is enabled and try a new chat.
- **Node or Codex not found:** both `node` and `codex` must be accessible to the
  app, including when it is launched from your desktop.
- **No credit or nothing to reset:** your account has no available reset credit
  or no eligible usage to reset. Repeating the request does not bypass this.
- **Busy:** another reset request is still running. No additional request was queued.
