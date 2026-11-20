# Game quality standards (GQ)

Measurable targets for every release candidate. QA reports cite these IDs.

| ID | Level | Target | Check |
|---|---|---|---|
| GQ-01 | MUST | Complete loop: start → play → win/lose → result → retry/menu, with no dead ends (every screen has a way forward). | e2e |
| GQ-02 | MUST | First interactive screen ≤ 5 s on the e2e desktop profile; boot shows a progress indicator from the first frame. | e2e |
| GQ-03 | MUST | 0 uncaught errors and 0 console errors during scripted e2e flows. | e2e |
| GQ-04 | MUST | Onboarding: a first-time player understands the goal and controls within 30 s without reading more than 2 short sentences per screen. | manual (playtest), review |
| GQ-05 | MUST | Controls respond within one frame of input on desktop; touch targets ≥ 44 CSS px; no accidental ad clicks (ad triggers never under the finger). | review, manual |
| GQ-06 | MUST | Difficulty: first level/run winnable by a new player in ≥ 80 % of QA attempts; difficulty curve defined numerically in the GDD. | manual (QA), review |
| GQ-07 | MUST | Saving: progress, best score, settings and mute survive reload (e2e). | e2e |
| GQ-08 | MUST | Ads: no interstitial within the first 30 s of first play or during active gameplay; rewarded offers are optional benefits. | review, manual |
| GQ-09 | SHOULD | ≥ 55 fps median on the desktop e2e profile during core gameplay; no frame > 100 ms during normal play. | e2e (when instrumented), manual |
| GQ-10 | MUST | Build ≤ 25 MB, ≤ 250 files. | validator |
| GQ-11 | MUST | Readable text: ≥ 16 CSS px equivalent at 375×812; contrast ≥ 4.5:1 for body text. | review, manual |
| GQ-12 | SHOULD | Session length 2–10 minutes per run for casual titles; meta progression gives a reason to return. | review |
| GQ-13 | MUST | Originality: the analyst's clone-risk rating is low or medium with mitigations applied. | review (concept gate) |
