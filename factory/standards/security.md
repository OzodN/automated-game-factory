# Security standards (SEC)

| ID | Level | Rule | Check |
|---|---|---|---|
| SEC-01 | MUST | No credentials, tokens or keys in any repository, prompt, report or log. Playgama MCP auth is OAuth managed by Claude Code (never ask for passwords/tokens in chat). Optional API keys only via user environment variables. | cli (secret scan on every task diff), review |
| SEC-02 | MUST | Shipped game makes no network requests except loading the Bridge from Playgama's CDN. | lint, e2e, validator |
| SEC-03 | MUST | Dependencies pinned to exact versions; lockfile committed and installed with `--frozen-lockfile`; new dependencies need architect justification. | cli, review |
| SEC-04 | MUST | Downloaded archives are untrusted: extract into a fresh quarantine folder, admit only media/data types, never execute or `npm install` anything from them. | cli (`assets ingest`), review |
| SEC-05 | MUST | No dynamic code: `eval`, `new Function`, `innerHTML` with non-constant strings are forbidden in game code. | review |
| SEC-06 | MUST | Destructive operations (deleting state/repos/worktrees/archives, `git push`, history rewrites, `git reset --hard`, branch deletion) are blocked for agents; the human performs them manually if ever needed. | hooks (guard), permissions |
| SEC-07 | MUST | Every externally visible Playgama operation requires its own human `/authorize-publish <op>` bound to the packaged build hash; moderation, unpublish and delete are manual console actions. | hooks (guard) |
| SEC-08 | MUST | Agents never launch Claude Code sessions or otherwise simulate human input. | hooks (guard), permissions |
| SEC-09 | MUST | Factory state (`.factory/`) is written only by the CLI and hooks; agent outputs are accepted only with tracked provenance (Write tool by the expected agent type). | hooks, cli |

## Known limits (documented, not hidden)
The guard is a strong protection against accidental or instructed bypass, not a sandbox against a deliberately hostile process with shell access on the same machine (such a process could, e.g., read the approval key through an obfuscated script). Mitigations: deny rules, guard patterns, HMAC binding to artifact hashes, an append-only audit trail (`factory decisions`), and the human reviewing every phase.
