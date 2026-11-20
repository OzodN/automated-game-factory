# Playgama compliance standards (PG)

**Authority:** the live checklist (`get_game_checklist`, rule numbers are stable) and `get_bridge_sdk_docs` when the Playgama MCP is connected; otherwise `factory/knowledge/playgama-verified.md`. The research docs in `docs/playgama-research/` are secondary and contain known errors (see the errata).
Rule numbers below quote the public wiki (verified 2026-11-11).

| ID | Playgama rule | Requirement (MUST unless noted) | Check |
|---|---|---|---|
| PG-SDK | 1.1.x | Bridge SDK v2 (2.4.1 pinned) via the official Vite plugin; `playgama-bridge-config.json` next to `index.html`; `forciblySetPlatformId` empty. | validator (+official precheck) |
| PG-READY | SDK | `game_ready` once, when the first interactive screen shows — never during loading. | e2e, official precheck |
| PG-NET | 1.2.4–1.2.5 | No external requests except the Bridge itself; no third-party analytics; fonts self-hosted. | lint, e2e (request interception), validator |
| PG-LINKS | 1.2.6 | Links out only when `platform.isExternalLinksAllowed`. | lint (`window.open` banned), review |
| PG-BUILD | 1.3.1–1.3.2 | Relative paths; Latin file names; zip ≤ 300 MB (factory target ≤ 25 MB / ≤ 250 files); `index.html` at the archive root. | validator, cli (zip validation) |
| PG-DEVICES | 1.4.x | Desktop + mobile; no text selection, context menu or long-press callouts; no page scroll/zoom. | e2e, manual |
| PG-ESC | 1.5.2 | The Escape key is never used. | lint, e2e |
| PG-DISPLAY | 1.6.x | Works in any aspect incl. a square 1:1 window; no scrollbars; no black bars. | e2e |
| PG-INTER | 2.1.x | Interstitial at natural pauses only (level end, game over, return to menu); never during loading or active play; no game-side frequency timers (Bridge controls frequency); gameplay + audio paused while open. | unit (kit), e2e, review |
| PG-REWARD | 2.2.x | Rewarded only on explicit player action with a clear button; reward only on the `rewarded` state; nothing on early close/failure; revive ≤ 1 per attempt; hide when unsupported. | unit (kit), review |
| PG-SAVE | 3.2.1–3.2.3 | Progress only through Bridge storage; saves level progress or best score; survives reload, rotation and ads. | lint, unit, e2e |
| PG-SOUND | 3.3.1–3.3.5 | Music + SFX present; produced audio files (ogg/mp3), no code-synthesized sound; mute button; respects `isAudioEnabled` at startup and audio/pause events; silent when hidden; resumes correctly. | lint, validator (`--release`), e2e, manual |
| PG-LANG | 3.4.1–3.4.4 | English default + fallback; language only from `platform.language`; every declared language complete; language selector (if any) usable without knowing the current language. | lint, unit |
| PG-TITLE | 3.5.1 | In-game title equals the publication form title. | review (release-manager) |
| PG-CONTENT | 4.1–4.2 | No restricted content; no third-party copyrighted names, logos, music, characters. | review, assets ledger |
| PG-AI | 4.3.1–4.3.2 | AI-generated assets allowed but the game is not built entirely from them; no emoji in place of UI icons. | review |
| PG-DATA | 4.4 | No personal data collection. | review |
| PG-MEDIA | publication | Covers 800×800, 1080×1920, 1920×1080 (PNG/JPEG ≤ 10 MB) made from real gameplay; English title; description and how-to-play ≥ 100 characters. | cli (`publish prepare`) |

Before every upload the release-manager re-reads `get_game_checklist` and records, per numbered item, how it was verified (test name, validator line, or "manual — QA Tool").
