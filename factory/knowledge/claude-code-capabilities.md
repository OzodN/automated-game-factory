# Claude Code capabilities — verified evidence (version 2.1.322, Windows 11)

Platform note (FX-19): the evidence was collected on Windows 11. The Git Bash / MSYS rows apply to Windows only; on macOS and Linux hooks and the Bash tool use the default POSIX shell and no path conversion happens. `CLAUDE_PROJECT_DIR` is set for hook commands; it is NOT set in the Bash tool of subagents (observed in a factory subagent), so agent prompts must not rely on it.

Spike run 2026-11-11 in an isolated scratch project with logging hooks; headless runs via `claude -p` (model haiku).

| Capability | Result | Evidence | Factory use / fallback |
|---|---|---|---|
| Main thread as custom agent (`"agent"` setting) | VERIFIED | Reply began with the agent's mandated prefix; hooks received `agent_type: "spike-orch"` on main-thread events | `"agent": "game-orchestrator"` in `.claude/settings.json` |
| UserPromptSubmit sees literal slash text | VERIFIED | Hook `prompt` = `"/spike-approve gate-x game-42"` | Approval tokens minted only from human-typed commands |
| `disable-model-invocation: true` skills | VERIFIED | Model's Skill call refused: "can only be run by the user" | All gate/decision commands are human-only |
| Parallel subagents (two Agent calls in one message) | VERIFIED | Both SubagentStart events before either finished | Parallel task dispatch |
| Subagent hook inputs include `agent_id` + `agent_type` | VERIFIED | PreToolUse from subagents carried both; SubagentStop also carries `agent_transcript_path`, `last_assistant_message` | Per-agent write scoping via `task claim`; token metrics |
| Subagents restricted to listed tools (no nesting) | VERIFIED | Workers with `tools: Bash, Write, Read` reported no Agent/Task tool | Single-level delegation |
| Hooks run in Git Bash with `CLAUDE_PROJECT_DIR` set | VERIFIED | Hook env `SHELL=C:\Program Files\Git\bin\bash.exe`, `CLAUDE_PROJECT_DIR=<forward-slash path>` | Hook commands `node "$CLAUDE_PROJECT_DIR/…"` |
| Project-scoped plugin install | VERIFIED | `claude plugin install playgama-developer-cabinet@playgama-plugins --scope project` wrote `enabledPlugins` to `.claude/settings.json` | Official Playgama integration |
| Git Bash MSYS path conversion | GOTCHA | `claude -p "/cmd"` from Git Bash became `C:/Program Files/Git/cmd` | Use `MSYS_NO_PATHCONV=1` when scripting slash commands from Git Bash |
| Native `isolation: worktree` for game repos | NOT USED | Native isolation branches the session repo from HEAD; game code lives in separate per-game repos needing a fixed base (`develop`) and preserved failed worktrees | Factory-managed worktrees (`factory task start`) |
| claude.ai connector instructions leak into subagents | OBSERVED | A worker reported a tool output asking it to create a Claude Docs document; it ignored it | Agents' tool allowlists exclude unrelated MCP tools |
