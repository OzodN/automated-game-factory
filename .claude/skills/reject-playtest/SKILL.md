---
name: reject-playtest
description: "Human decision: reject the release candidate with the issues found in playtesting."
argument-hint: "<issues>"
disable-model-invocation: true
---

# /reject-playtest

Arguments: $ARGUMENTS

This command is a human decision. The UserPromptSubmit hook has already recorded (or refused) a signed token — look for the `[factory-hook]` note in context. If it says the decision was NOT recorded, tell the user in the human's language (see `Human language` in the session context) exactly what to type instead and stop.

Run `node factory/cli/factory.mjs playtest reject --reason "<issues>"` (adds a corrective phase) and follow `factory-release` step E5.
