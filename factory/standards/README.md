# Factory standards

Rules every agent follows. Each rule has a stable ID, a level and how it is verified.
- **MUST** — mandatory; a violation is a `major` (or `critical`) review finding and blocks integration.
- **SHOULD** — recommendation; deviations need a reason in the task report; reviewers flag as `minor`.
- **Check** column: `lint` (ESLint rule in the template), `type` (tsc strict), `unit`, `e2e`, `validator` (`scripts/validate-build.mjs` + official Playgama precheck), `cli` (factory verify/integrate/release), `review` (independent reviewer), `manual` (human/QA in the QA Tool).

| File | Scope |
|---|---|
| [engineering.md](engineering.md) | Software engineering (ENG) |
| [game-engineering.md](game-engineering.md) | Game engineering (GE) |
| [playgama-compliance.md](playgama-compliance.md) | Playgama platform rules (PG) |
| [assets.md](assets.md) | Asset originality, licensing, formats (AS) |
| [security.md](security.md) | Credentials, requests, dependencies, publishing (SEC) |
| [game-quality.md](game-quality.md) | Player-facing quality bar (GQ) |
| [git-and-release.md](git-and-release.md) | Branching, integration, release governance (GIT) |
