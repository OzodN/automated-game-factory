---
name: abandon-game
description: "Human gate: abandon a draft game before development (IDEATION, CONCEPT_APPROVED, SPEC_DRAFT or SPEC_APPROVED); then /archive-game."
argument-hint: "[game-id] <reason>"
disable-model-invocation: true
---

# /abandon-game

Arguments: $ARGUMENTS

This command is a human decision. The UserPromptSubmit hook has already recorded (or refused) a signed token — look for the `[factory-hook]` note in context. If it says the decision was NOT recorded, tell the user in the human's language (see `Human language` in the session context) exactly what to type instead and stop.

Then run `node factory/cli/factory.mjs gate abandon-game --game <id> --reason "<reason>"` with the game named in the note (the focused game unless the FIRST word was a game id) and the reason the user typed, quoted. On success tell the user in the human's language (see `Human language` in the session context) that the game is ABANDONED and that `/archive-game` archives it. On error show the CLI message and the hint. Games in development or later are never abandoned.
