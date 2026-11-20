---
name: archive-game
description: "Human gate: archive a released or abandoned game (production records into archive/ and the game repo)."
argument-hint: "[game-id]"
disable-model-invocation: true
---

# /archive-game

Arguments: $ARGUMENTS

This command is a human decision. The UserPromptSubmit hook has already recorded (or refused) a signed token — look for the `[factory-hook]` note in context. If it says the decision was NOT recorded, tell the user in the human's language (see `Human language` in the session context) exactly what to type instead and stop.

Then run `node factory/cli/factory.mjs gate archive-game` (add `--game <id>` if one was named) and report the archive path. Released games (PACKAGED, PUBLICATION_PREPARED) go to `archive/<id>/<version>/production/`; abandoned drafts go to `archive/<id>/abandoned-<YYYYMMDD>/` (production records + design). A draft that is not ABANDONED yet is refused: the user types `/abandon-game <reason>` first.
