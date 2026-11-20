---
name: factory-ideation
description: Orchestrator playbook for MODE A (ideation) — turning a human's game idea into a critically evaluated Game Concept Brief with designer, analyst and architect input. Load when a new idea is discussed or a game is in IDEATION.
---

# Mode A — Ideation playbook

Nothing is implemented in this mode. Only `games/<id>/design/concept|research|tech/` is writable (the guard enforces it).

## 1. Register the game (once the idea is concrete enough to name)
`node factory/cli/factory.mjs game new <kebab-id> --title "<Working Title>"` → creates the repo, sets focus.
Ask the human (in the human's language, see `Human language` in the session context) only for genuinely missing product intent: target feel, any must-haves/must-avoids. Do not ask technical questions.

## 2. Parallel analysis (one message, three agents)
- `game-designer`: "Draft `games/<id>/design/concept/concept-brief.md` (structure below) for this idea: <idea + human constraints>. Critique the idea and propose improvements."
- `market-analyst`: "Write `games/<id>/design/research/market-evaluation.md` for this idea: <idea>. Include originality vs. prior factory concepts."
- `tech-architect`: "Write `games/<id>/design/tech/feasibility.md`: feasibility on Phaser 4 + pg-kit, asset needs vs. CC0 library, scope in phases, technical risks, reuse."

## 3. Critique round
Give the designer the analyst + architect findings: "Revise the concept brief to address: <list>. Keep a 'Changes from critique' section." One revision round is normal; a second only for unresolved NO-GO issues.

## 4. Present to the human (in the human's language)
Short brief: core loop in one sentence, what makes it original, main risks with mitigations, analyst verdict, estimated phases, open questions, and the trade-offs you recommend. Include the file path of the brief.
Ask for changes or approval. Iterate on their feedback via the designer.
When the human is satisfied, tell them to type **`/approve-concept`** (it freezes the brief).
After the hook confirms: `node factory/cli/factory.mjs gate approve-concept`.
If the human drops the idea instead (superseded, not worth it), tell them to type **`/abandon-game <reason>`** and later **`/archive-game`**; after each hook confirmation run `factory gate abandon-game --game <id> --reason "<reason>"` / `factory gate archive-game --game <id>`. This works until `/start-development`, never later.

## Concept brief structure (`design/concept/concept-brief.md`)
1. Title, one-line pitch, genre
2. Core gameplay loop (moment-to-moment, session, meta)
3. Mechanics (each with intent)
4. Originality: what is new; 3+ closest references and differences
5. Target audience and session profile
6. Progression and replayability
7. Controls: desktop and touch (no Escape)
8. Monetization fit: interstitial points, rewarded offers (optional benefits only), economy sketch
9. Playgama fit and compliance risks
10. Visual and audio direction; asset needs and sourcing (library/vector/original)
11. Scope: estimated phases and tasks; reusable components
12. Risks (technical, commercial, production) with mitigations
13. Open questions
14. Changes from critique
