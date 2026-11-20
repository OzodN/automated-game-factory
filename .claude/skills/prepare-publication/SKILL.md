---
name: prepare-publication
description: "Prepare the Playgama publication packet for a packaged game (no external changes)."
argument-hint: "[game-id]"
---

# /prepare-publication

Arguments: $ARGUMENTS

Follow `factory-release` F1 step 3: run `node factory/cli/factory.mjs publish covers` (real screenshots of the packaged build), dispatch release-manager for release notes and the publication packet that references those covers, then run `node factory/cli/factory.mjs publish prepare`. Make no Playgama write calls.
