---
name: request-changes
description: "Human decision: request corrections or additional testing in the current phase."
argument-hint: "<text>"
disable-model-invocation: true
---

# /request-changes

Arguments: $ARGUMENTS

This command is a human decision. The UserPromptSubmit hook has already recorded (or refused) a signed token — look for the `[factory-hook]` note in context. If it says the decision was NOT recorded, tell the user in the human's language (see `Human language` in the session context) exactly what to type instead and stop.

If the phase is at CHECKPOINT run `node factory/cli/factory.mjs phase reject --reason "<text>"` first. Have tech-architect convert the request into corrective/test tasks (`plan load --amend`), continue the dev loop, and checkpoint again.
