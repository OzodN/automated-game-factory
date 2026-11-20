# Playgama — verified facts and errata (factory knowledge base)

Verified 2026-11-11 against primary sources: the official repos `Playgama/playgama-plugins` and `Playgama/developer-cabinet-mcp`, `playgama.com/mcp`, the live wiki (`wiki.playgama.com/playgama/game-requirements/*`), and the installed `@playgama/bridge@2.4.1` package (type definitions + runtime).
Status labels: **VERIFIED** (checked in a primary source), **UNVERIFIED** (claimed somewhere, not confirmed), **REQUIRES SUPPORT** (only Playgama can answer).

## 1. Official integration (VERIFIED)
- Claude Code plugin: marketplace `Playgama/playgama-plugins`, plugin `playgama-developer-cabinet` (v1.5.1 installed at project scope). Contents: MCP server `playgama` + skills `playgama-publish`, `playgama-bridge`, `playgama-game-video`.
- MCP server `https://developer.playgama.com/api/mcp`, streamable HTTP, **OAuth 2.1 in the browser** (no token). Sign in: run `/mcp` in Claude Code → `plugin:playgama-developer-cabinet:playgama` → authenticate. Connected agents are revocable at `developer.playgama.com/mcp`. Acts only on the signed-in organization's games.
- Tool names in Claude Code: `mcp__plugin_playgama-developer-cabinet_playgama__<tool>`.

### MCP tools (documented v1.9.0; authoritative list = server `tools/list`)
Read: `list_applications`, `get_application`, `get_game_categories`, `get_submission_state`, `list_moderation_comments`, `get_launch_steps`, `get_archive_status`, `list_in_app_products`, `list_leaderboards`, `get_archive_qa_tool_link`, `get_local_game_qa_tool_link`, `get_bridge_sdk_docs`, `get_game_checklist`, `get_game_guides`, `get_game_telemetry_guide`, `get_game_telemetry_analytics`, `get_game_telemetry_event_analytics`, `get_game_telemetry_timeseries`, `get_game_telemetry_session_facts`, `get_referral_program`, `get_sandbox_state`, `get_publications`, `get_sandbox_share`, `get_sandbox_traffic`.
Write (all `destructiveHint: true`; factory op in brackets): `create_application`, `update_application_form`, `start_archive_upload`, `confirm_archive_upload`, `start_cover_upload`, `confirm_cover_upload` [draft]; `replace_in_app_products` (replaces the whole catalog — omitted products are deleted), `create_leaderboard`, `update_leaderboard` [store-config]; `publish_sandbox` [sandbox — public, no moderation; 15 publishes/hour/game]; `start_sandbox_traffic` [traffic — irreversible]; `send_playgama_catalog_update` [catalog-update — all live players, no moderation]; `apply_referral_code` [referral].
**Not possible via MCP:** submit for moderation, delete anything, unpublish, roll back releases, read payouts, upload screenshots/videos. These are console actions at `developer.playgama.com`.

### Publication facts (VERIFIED)
- Covers: exactly **800×800, 1080×1920, 1920×1080**, PNG or JPEG, ≤ 10 MB each; all three required for sandbox publish and moderation submit; must come from real gameplay.
- Form: English title; `description` and `howToPlayText` ≥ 100 characters; `category` from `get_game_categories`; `story` follows the tool's rules; devices, languages, `isHorizontal`/`isVertical`.
- Build zip ≤ 300 MB; upload via one-hour PUT URL from `start_archive_upload` (use `curl.exe` on Windows); poll `get_archive_status` until not CHECKING; sandbox accepts Bridge ≥ 2.2.0.
- Catalog listing after moderation; updates to live catalog games can skip moderation via `send_playgama_catalog_update`.

## 2. Bridge SDK 2.4.1 (VERIFIED from the installed package)
- npm `@playgama/bridge@2.4.1` (latest); exports `.`, `./vite`, `./constants`, `./global`, `./dist/playgama-bridge.js`. The ESM entry is a thin proxy to the global `bridge` injected by the script tag.
- Vite plugin `playgamaBridge({ mode: 'cdn' | 'local' })`: `cdn` (default) injects `https://bridge.playgama.com/v2/stable/playgama-bridge.js` plus a local fallback, and always emits the runtime file into the build.
- Messages: `game_ready`, `gameplay_started`, `gameplay_stopped`, `level_started|completed|failed|paused|resumed`, `in_game_loading_started|stopped`, `player_got_achievement`.
- Events (on `bridge.platform`): `audio_state_changed`, `pause_state_changed`, `visibility_state_changed`; ads (on `bridge.advertisement`): `interstitial_state_changed` (loading/opened/closed/failed), `rewarded_state_changed` (+ `rewarded`).
- Advertisement has `minimumDelayBetweenInterstitial` / `setMinimumDelayBetweenInterstitial` (default 60) — the SDK enforces frequency; games add no timers.
- Config file `./playgama-bridge-config.json` loaded beside `index.html`; keys present in the runtime: `forciblySetPlatformId`, `sendAnalyticsEvents`, `advertisement.{interstitial,rewarded,banner}.placements[]`, `platforms`.
- Platform ids include `playgama`, `playgama_sandbox`, `qa_tool`, `mock`, `youtube`, `msn`, `gamesnacks`, … (29 total).

## 3. Requirements quoted from the live wiki (VERIFIED)
- 3.2.1 Progress only through Bridge storage — never localStorage, sessionStorage, IndexedDB, cookies or engine save systems.
- 3.2.2 Save level/story progress; endless/high-score games save the best score. 3.2.3 Survives reload, rotation and an ad.
- 3.3.1 Not silent: background music + SFX for actions and UI. 3.3.2 Recorded/produced audio shipped as ogg or mp3; "Sound synthesized in code, such as procedural Web Audio tones generated by an AI coding agent, is not accepted." 3.3.3 Mute button. 3.3.4 Respect `isAudioEnabled` at startup and audio/pause events; stays muted after reload if the platform muted. 3.3.5 Silent when hidden; resumes correctly.
- 3.4.1 English required (default + fallback). 3.4.2 Language only from `platform.language`. 3.4.3 All declared languages complete. 3.4.4 Language selector usable without knowing the current language.
- 3.5.1 In-game title matches the publication title.
- 4.2.1/4.2.3 Rights: no third-party names, logos, music, characters. 4.3.1 AI assets allowed but not entirely AI-built. 4.3.2 No emoji in place of icons.

## 4. Errata in `docs/playgama-research/` (do not rely on these statements)
| Doc | Claim | Reality |
|---|---|---|
| 07, README | MCP tools `create_game`, `upload_build`, `upload_asset`, `update_game_version`, `submit_game_version`, `create_new_game_version`, `get_games_analytics` | Do not exist. See §1 for real tools. Moderation submission is **not** available via MCP. |
| 07 | "Personal Access Token (PAT)" for MCP | Current flow is browser OAuth; legacy `pgm_mcp_` tokens deprecated. |
| 07 | Icon 512×512, cover 800×500, portrait 600×900 | Covers are 800×800, 1080×1920, 1920×1080 (all mandatory). |
| 07 | Screenshots/video uploaded via MCP `upload_asset` | Not possible via MCP; console only. |
| 03 | Config key `disableBrowserDefaults` | Not present in the 2.4.1 runtime — UNVERIFIED; the factory does not use it. |
| 03 | `$schema` URL in the config | Not needed; omitted (avoids an outside address). |
| README | "Unpublishing via support email" | Plausible but UNVERIFIED; treat as manual console/support action. |
Other numeric claims in the research docs (revenue shares, partner quotas such as YouTube < 30 MB, Facebook ≤ 500 files) are kept as **UNVERIFIED planning assumptions**; the factory's stricter build target (≤ 25 MB, ≤ 250 files) satisfies them anyway.

## 5. Open questions (REQUIRES SUPPORT)
See `docs/playgama-research/15-unresolved-questions.md` (revenue tiers, YouTube nomination benchmarks, payout methods and KYC, ad placement analytics granularity).

## 6. Known precheck warnings for template builds
The official precheck WARNs on Phaser's bundled code: an outside address `phaser.io` (a string in Phaser, not a request) and `localStorage` mentions inside Phaser. Game code itself is lint-blocked from both. Mention this in the publication notes if a moderator asks.
