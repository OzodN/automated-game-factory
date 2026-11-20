---
name: abandon-task
description: "Human decision: abandon a BLOCKED task (its dependents must be re-planned)."
argument-hint: "<TASK-ID> [game-id]"
disable-model-invocation: true
---

# /abandon-task

Arguments: $ARGUMENTS

This command is a human decision. The UserPromptSubmit hook has already recorded (or refused) a signed token — look for the `[factory-hook]` note in context. If it says the decision was NOT recorded, tell the user in the human's language (see `Human language` in the session context) exactly what to type instead and stop.

Then run `node factory/cli/factory.mjs task abandon <TASK-ID>` and have tech-architect re-plan the dependent tasks (`plan load --amend`).
