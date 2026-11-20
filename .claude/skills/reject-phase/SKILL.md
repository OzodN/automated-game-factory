---
name: reject-phase
description: "Human decision: reject the current phase checkpoint with a reason."
argument-hint: "<reason>"
disable-model-invocation: true
---

# /reject-phase

Arguments: $ARGUMENTS

This command is a human decision. The UserPromptSubmit hook has already recorded (or refused) a signed token — look for the `[factory-hook]` note in context. If it says the decision was NOT recorded, tell the user in the human's language (see `Human language` in the session context) exactly what to type instead and stop.

Then run `node factory/cli/factory.mjs phase reject --reason "<reason>"`, have tech-architect write corrective tasks for the current phase, load them with `plan load --amend` and continue the dev loop.
