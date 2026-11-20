---
name: approve-concept
description: "Human gate: approve and freeze the Game Concept Brief of the focused (or named) game."
argument-hint: "[game-id]"
disable-model-invocation: true
---

# /approve-concept

Arguments: $ARGUMENTS

This command is a human decision. The UserPromptSubmit hook has already recorded (or refused) a signed token — look for the `[factory-hook]` note in context. If it says the decision was NOT recorded, tell the user in the human's language (see `Human language` in the session context) exactly what to type instead and stop.

Then run `node factory/cli/factory.mjs gate approve-concept` (add `--game <id>` if one was named). On success: summarize in the human's language (see `Human language` in the session context) and continue with the `factory-spec` playbook (start the specification). On error: show the CLI message and the hint.
