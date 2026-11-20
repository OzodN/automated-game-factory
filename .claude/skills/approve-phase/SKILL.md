---
name: approve-phase
description: "Human gate: approve the current phase checkpoint and let the next phase start."
argument-hint: "[game-id]"
disable-model-invocation: true
---

# /approve-phase

Arguments: $ARGUMENTS

This command is a human decision. The UserPromptSubmit hook has already recorded (or refused) a signed token — look for the `[factory-hook]` note in context. If it says the decision was NOT recorded, tell the user in the human's language (see `Human language` in the session context) exactly what to type instead and stop.

Then run `node factory/cli/factory.mjs gate approve-phase` and continue the `factory-dev-loop` playbook for the next phase (or `factory-release` if this was the last phase).
