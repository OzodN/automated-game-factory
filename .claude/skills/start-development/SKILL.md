---
name: start-development
description: "Human gate: freeze the approved spec and authorize implementation (scaffold, plan, parallel development)."
argument-hint: "[game-id]"
disable-model-invocation: true
---

# /start-development

Arguments: $ARGUMENTS

This command is a human decision. The UserPromptSubmit hook has already recorded (or refused) a signed token — look for the `[factory-hook]` note in context. If it says the decision was NOT recorded, tell the user in the human's language (see `Human language` in the session context) exactly what to type instead and stop.

Then follow the `factory-dev-loop` playbook from step C1 (`node factory/cli/factory.mjs gate start-development`, plan, load, start the loop).
