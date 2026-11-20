---
name: pause
description: "Human decision: pause the focused game (no new tasks start)."
argument-hint: "[game-id]"
disable-model-invocation: true
---

# /pause

Arguments: $ARGUMENTS

This command is a human decision. The UserPromptSubmit hook has already recorded (or refused) a signed token — look for the `[factory-hook]` note in context. If it says the decision was NOT recorded, tell the user in the human's language (see `Human language` in the session context) exactly what to type instead and stop.

Run `node factory/cli/factory.mjs pause`. Running agents may finish; submit their work but start nothing new. Confirm in the human's language (see `Human language` in the session context).
