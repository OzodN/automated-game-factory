---
name: approve-release
description: "Human gate: approve the release version (merge develop into main and tag), then package it."
argument-hint: "<x.y.z> [game-id]"
disable-model-invocation: true
---

# /approve-release

Arguments: $ARGUMENTS

This command is a human decision. The UserPromptSubmit hook has already recorded (or refused) a signed token — look for the `[factory-hook]` note in context. If it says the decision was NOT recorded, tell the user in the human's language (see `Human language` in the session context) exactly what to type instead and stop.

Then run `node factory/cli/factory.mjs gate approve-release --version <x.y.z>` followed by `node factory/cli/factory.mjs release package`, and continue with `factory-release` F1 step 3.
