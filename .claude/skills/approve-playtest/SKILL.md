---
name: approve-playtest
description: "Human gate: approve the release candidate after personal playtesting."
argument-hint: "[game-id]"
disable-model-invocation: true
---

# /approve-playtest

Arguments: $ARGUMENTS

This command is a human decision. The UserPromptSubmit hook has already recorded (or refused) a signed token — look for the `[factory-hook]` note in context. If it says the decision was NOT recorded, tell the user in the human's language (see `Human language` in the session context) exactly what to type instead and stop.

Then run `node factory/cli/factory.mjs gate approve-playtest` and ask the user to type `/approve-release <x.y.z>` (suggest 1.0.0 for a first release).
