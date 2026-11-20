---
name: authorize-publish
description: "Human gate: authorize exactly ONE Playgama external operation for the packaged build (draft | sandbox | catalog-update | traffic | store-config | referral)."
argument-hint: "<op> [game-id]"
disable-model-invocation: true
---

# /authorize-publish

Arguments: $ARGUMENTS

This command is a human decision. The UserPromptSubmit hook has already recorded (or refused) a signed token — look for the `[factory-hook]` note in context. If it says the decision was NOT recorded, tell the user in the human's language (see `Human language` in the session context) exactly what to type instead and stop.

The token covers only the named operation for the current packaged build. Dispatch `release-manager` to perform exactly that operation (see `factory-release` F2) and report the real tool results. Do not perform any other operation.
