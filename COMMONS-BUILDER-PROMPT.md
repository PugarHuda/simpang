# Prompt for the Commons builder

Paste the block below into "What are we building?". It produces SIMPANG's scan — the part of the
entry that is portable, needs no long-running state, and is where the 30%-weighted "waiting
experience" actually lives. The full agent stays on Vercel and is linked from the result.

Derived from `lib/divergence.ts` (SCAN_PROMPT + qualityGate) and `components/tree.tsx`, so the
clone renders the same tree as production rather than an invented one.

---

Build **SIMPANG** — a single-page app called "the branch predictor for AI agents".

**The idea.** When you give an AI agent a task, it silently resolves a series of decisions while you
stare at a spinner. SIMPANG shows you those decisions *before* they are made and lets you kill the
branches you don't want. Tagline for the header: "you pick the direction at every fork".

**Look.** Terminal aesthetic. Near-black background (#0a0a0a), monospace throughout, 13px body text,
tight 24px row height, thin dark-grey borders (#262626), muted grey text with only two accent colours:
emerald for pinned/won, red for killed. No cards, no shadows, no rounded-everything. Dense and calm,
like a build log. Fully responsive; on narrow screens hide the file-count, cost and sketch columns.

**Screen 1 — input.** One textarea, placeholder "task for the agent…", and a "run" button. One
example prompt below it the user can click to fill in: "refactor the auth system to use sessions".

**Screen 2 — the scan.** On submit, make ONE model call that returns JSON matching this shape:

```
{
  "etaSeconds": number,
  "divergences": [
    {
      "id": "snake_case_slug",
      "axis": "1-3 word noun phrase",
      "question": "at most 10 words",
      "branches": [
        {
          "label": "at most 4 words, concrete",
          "sketch": "at most 12 words",
          "filesTouched": number,
          "costUsd": number,
          "confidence": number,
          "constraintIfPinned": "plain-English imperative sentence forcing THIS branch"
        },
        { ...exactly one more branch, same shape... }
      ]
    }
  ]
}
```

Use this as the system prompt for that call, verbatim:

> You are a branch predictor for an AI coding agent, not an assistant.
>
> Identify the DECISION POINTS the agent must resolve to answer the user's prompt — places where a
> competent engineer could reasonably go two ways.
>
> A divergence is INVALID unless ALL hold:
> 1. The two branches are mutually exclusive. Doing A forbids B.
> 2. Both are defensible. If one is obviously right, it is not a decision.
> 3. Leading branch confidence < 0.85. Higher means assumption, not decision.
> 4. The axis is visible in the final output. If the user could not tell which branch was taken by
>    reading the result, drop it.
> 5. Never offer a choice the prompt already made (prompt says "use sessions" → "sessions vs tokens"
>    is NOT a decision). Go one level deeper instead.
> 6. Max 5 divergences, ranked by how expensive the wrong choice is to undo.
>
> The confidences of the two branches in a divergence must sum to 1.0. axis is a noun phrase like
> "storage" or "session expiry", never a question. Be terse everywhere; latency matters.
> constraintIfPinned forces THIS SAME branch, e.g. for branch "redis": "Use redis for session
> storage." No code, no comment markers. etaSeconds is an honest estimate of how long a coding agent
> needs for the whole task. Write labels, questions and constraints in the language of the user's
> prompt.
>
> Output only decisions the user would be annoyed to discover 90 seconds from now. Output an empty
> list if the prompt has no real decision points.

While the call is in flight show a single line that reads "⑂ scanning for decision points…" with a
blinking cursor. Nothing else — no skeleton cards, no progress bar.

**Filter the response before rendering.** Drop any divergence where: it does not have exactly two
branches, the two confidences do not sum to 1.0 (±0.06), the higher confidence is 0.85 or above, or
the two labels are identical. Keep at most 5. If everything is filtered out, say "no real decision
points in this one" rather than showing an empty box.

**The tree.** Each divergence is a block with a header row: a `⑂` glyph, the axis in light grey, and
on the right either "2 futures" or, once acted on, "killed · waiting" / "pinned · waiting".

Under it, one row per branch, in this column order:
- a key hint: `1` `2` for the first divergence, `3` `4` for the second, and so on
- the label, fixed width, truncated
- `~N files`
- `$X.XX`
- a confidence bar drawn with block characters: `▓` repeated `round(confidence * 6)` times, then `░`
  to fill 6 total, then the percentage — e.g. `▓▓▓░░░ 55%`
- the sketch, truncated, taking the remaining width

**Interaction — this is the whole point, make it instant.**
- Pressing a number key kills that branch. Shift+number pins it instead.
- Clicking a row kills it; shift+click pins it. (Phones have no number row.)
- A killed row goes to 25% opacity with a line through it, animated over 500ms.
- A pinned row turns emerald.
- The moment a branch is killed, show a toast at the bottom with the constraint that was generated
  during the scan. Build it yourself, do not call the model again: `Do NOT choose "<killed label>".
  <the OTHER branch's constraintIfPinned>`. **There must be no network request when a key is
  pressed** — the whole claim is that steering is instant because the constraints were written
  during the scan.
- Below the tree, a legend line: `[1-4] kill · [⇧1-4] pin · click a row = kill`

**Screen 3 — the handoff.** Under the tree, once at least one branch has been killed, show the
constraints the user has accumulated as a list headed "steering → agent", then a button:
**"run it for real →"** linking to `https://simpang.vercel.app`, with one line under it: "the full
version runs a real agent on a real repo — your prunes land mid-run, at the agent's next tool call".

**Keep it to one page.** No routing, no accounts, no database, no persistence. State lives in memory.

---

## Notes

- Model: **DeepSeek V4 Flash** or **Quick** is enough — this is one structured-output call. Do not
  reach for an expensive tier; the scan is cheap and latency is the thing that matters.
- Whatever it generates, the two things to check before publishing: pressing a number key fires no
  network request, and the killed row's toast quotes the *opposite* branch's constraint.
- Publishing this also fixes "0 public builds" and puts the first tokens on the board, which has read
  0 all along because it counts Commons model usage only.
