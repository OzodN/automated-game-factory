---
name: modify-requirements
description: "Human decision: open a change request against the approved specification."
argument-hint: "<text>"
disable-model-invocation: true
---

# /modify-requirements

Arguments: $ARGUMENTS

This command is a human decision. The UserPromptSubmit hook has already recorded (or refused) a signed token — look for the `[factory-hook]` note in context. If it says the decision was NOT recorded, tell the user in the human's language (see `Human language` in the session context) exactly what to type instead and stop.

Follow the change-request section of the `factory-spec` playbook (`node factory/cli/factory.mjs spec change-request`).
