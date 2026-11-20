---
name: game-status
description: "Show production status of the factory or one game, with the next permitted actions."
argument-hint: "[game-id]"
---

# /game-status

Arguments: $ARGUMENTS

Run `node factory/cli/factory.mjs status` (or `node factory/cli/factory.mjs status --game <id>`) and summarize in the human's language (see `Human language` in the session context): mode, phase, running tasks and agents, failed/blocked tasks, pending reviews, pending human decisions, next permitted action. Quote numbers from the output only.
