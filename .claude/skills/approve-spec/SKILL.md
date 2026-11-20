---
name: approve-spec
description: "Human gate: approve the final game specification."
argument-hint: "[game-id]"
disable-model-invocation: true
---

# /approve-spec

Arguments: $ARGUMENTS

This command is a human decision. The UserPromptSubmit hook has already recorded (or refused) a signed token — look for the `[factory-hook]` note in context. If it says the decision was NOT recorded, tell the user in the human's language (see `Human language` in the session context) exactly what to type instead and stop.

Then run `node factory/cli/factory.mjs gate approve-spec`. On success tell the user in the human's language (see `Human language` in the session context) that implementation starts only after they type `/start-development`.
