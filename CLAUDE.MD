# Basecamp Updates — Formatting Rules

This file governs how Claude drafts **every** Basecamp update in this folder. Match it exactly.
Source of the format: Colaberry onboarding requires updates **tied to a specific task**, following
**What → Progress → Decisions → Next**, with **screenshots**.

## The 3 rules that matter (Colaberry grading)
1. **Tie every update to ONE specific task** (a named backlog story / release / todo). No vague "worked on stuff."
2. **Always include screenshots** — call them out in the Attachments line even if I drag them in later.
3. **Momentum > perfection.** "I'm stuck" only counts if it names the next concrete step.

## File naming
`(C) YYYY-MM-DD — <ShortTaskName>.md` (e.g. `(C) 2026-07-12 — STORY-004 Daily Refresh Engine.md`)
All Claude-drafted files keep the `(C)` prefix.

## Required frontmatter
```yaml
---
type: basecamp-update
project: Colaberry Internship
sub-project: IPOS
release: <e.g. R1 — Core Build>
date: YYYY-MM-DD
task: <STORY-### or milestone name>
status: <draft | posted-ready | posted (comment #) — screenshots pending>
tags: [colaberry, basecamp-update, ipos, <story/release slug>]
---
```

## Required body structure (keep this order, keep the emoji headers)

```markdown
# (C) Basecamp Update — <Task Short Name> (YYYY-MM-DD)

> Format per Colaberry onboarding: tied to a specific task → **What → Progress → Decisions → Next**
> + screenshots. Linked PM detail: [[...link to the relevant PM Layer / case-study note...]].

---

**📌 Task:** <STORY-### or milestone> · pushed to GitHub `main` (commit `<hash>` if applicable)

**✅ What I did**
2–4 sentences, plain English, what got built/done end to end.

**📈 Progress**
- Bullet the concrete, verifiable results (tests passing, scenarios met, what a reviewer can see).
- Bold the acceptance-criteria hits. Note any live-verified behavior.
- Always surface the Trust-Before-Intelligence / audit-log evidence when relevant.

**🧠 Decisions & trade-offs**
- Each bullet = a decision + the *why* (the PM reasoning). This is the interview-gold section.
- Include a **Traceability:** line mapping the work to REQ-### / STORY-###.

**➡️ Next**
What's blocked on Ram's approval, what unlocks next, offer to record a walkthrough.

**📎 Attachments:** _[screenshot: X] · [screenshot: Y] · [README demo steps]_

---

## Demo notes / credentials (for reviewer)
- Exact steps or logins so the reviewer can reproduce it in under a minute.
```

## Tone & length
- **Concise, confident, specific.** Short sentences. No filler, no hype.
- Show the reviewer can *verify* it (steps, credentials, commit hash, passing scenarios).
- Bold the acceptance criteria and key decisions so a busy PM can scan in 15 seconds.
- Write decisions as trade-offs ("chose X over Y because…"), never just "did X."

## Simple Section
- In a seperate section, can you add a simpler section of what you have coded, in summary just write a dumbed down version of everything in the update, and coded
- Do not include this in the basecamp update

## Before marking `posted-ready`
- [ ] Tied to one named task
- [ ] Screenshots listed in Attachments
- [ ] Decisions section has a Traceability line
- [ ] Demo/repro steps included
- [ ] Next step is concrete (not "figuring it out")
- [ ] Do not update basecamp without my permission
