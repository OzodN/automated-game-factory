---
name: approve-spec-change
description: "Human gate: approve an amended specification after a change request."
argument-hint: "[game-id]"
disable-model-invocation: true
---

# /approve-spec-change

Arguments: $ARGUMENTS

This command is a human decision. The UserPromptSubmit hook has already recorded (or refused) a signed token — look for the `[factory-hook]` note in context. If it says the decision was NOT recorded, tell the user in the human's language (see `Human language` in the session context) exactly what to type instead and stop.

Then run `node factory/cli/factory.mjs spec refreeze`. If tasks are affected, have tech-architect produce a plan amendment and load it with `node factory/cli/factory.mjs plan load <file> --amend`.
