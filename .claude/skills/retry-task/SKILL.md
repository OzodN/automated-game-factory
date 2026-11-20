---
name: retry-task
description: "Human decision: grant a BLOCKED task two more attempts."
argument-hint: "<TASK-ID> [game-id]"
disable-model-invocation: true
---

# /retry-task

Arguments: $ARGUMENTS

This command is a human decision. The UserPromptSubmit hook has already recorded (or refused) a signed token — look for the `[factory-hook]` note in context. If it says the decision was NOT recorded, tell the user in the human's language (see `Human language` in the session context) exactly what to type instead and stop.

Then run `node factory/cli/factory.mjs task retry <TASK-ID>` and restart it in the dev loop with `node factory/cli/factory.mjs task start <TASK-ID>`: dispatch exactly the agent it prints as `Dispatch to` (the `-retry` variant for attempts >= 2), never pass model or effort, and include the agreed resolution in the agent prompt.
