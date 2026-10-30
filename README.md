# agentlereset

A small TypeScript MCP plugin for explicitly requested Codex usage resets.
The reset tool is still being designed; this repository currently contains its
architecture proposal and development tooling.

## Development

Use Node.js 24.19 or newer and npm. Run `npm ci` to install the pinned development
dependencies and enable the local Husky pre-commit hook.

| Command                | Purpose                                           |
| ---------------------- | ------------------------------------------------- |
| `npm run lint`         | Check the repository with type-aware Oxlint rules |
| `npm run lint:fix`     | Apply ordinary lint fixes                         |
| `npm run format`       | Format supported repository files with Oxfmt      |
| `npm run format:check` | Check formatting without changing files           |
| `npm run typecheck`    | Check TypeScript types without emitting files     |
| `npm run lint:staged`  | Fix and format staged files                       |

Commits run lint-staged automatically. Source files receive lint fixes followed
by formatting; supported documentation and data files receive formatting only.
Tasks run sequentially. Lint errors block commits; warnings remain advisory.
Generated files and the dependency lockfile are excluded from formatting.
The hook checks staged files, so run the repository-wide commands before review.

No real resets may be used for automated validation.
