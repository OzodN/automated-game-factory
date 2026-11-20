---
name: resume
description: "Human decision: resume a paused game."
argument-hint: "[game-id]"
disable-model-invocation: true
---

# /resume

Arguments: $ARGUMENTS

This command is a human decision. The UserPromptSubmit hook has already recorded (or refused) a signed token — look for the `[factory-hook]` note in context. If it says the decision was NOT recorded, tell the user in the human's language (see `Human language` in the session context) exactly what to type instead and stop.

Run `node factory/cli/factory.mjs resume`, then `node factory/cli/factory.mjs recover` and continue from the next permitted actions.
