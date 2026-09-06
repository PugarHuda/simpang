# SIMPANG — demo video script (5:00)

Target: 5 minutes. Screen recording with voice-over. Shoot in this order; the two
long agent runs (§2 and §5) are the only parts you cannot speed up, so start them
early and talk over them.

**Before you hit record**

- `https://simpang.vercel.app` open in a clean profile, browser zoom 110%, dark OS theme.
- MetaMask/Rabby installed, on **Base Sepolia**, funded with a few testnet USDC.
  Check the tiny paywall row appears (needs a scan with ≥ 4 divergences; the
  `refactor the auth system to use sessions` prompt reliably produces them).
- A second browser window (different profile, so it gets its own client id) for §4.
- One terminal, large font, for `curl .../api/health` and the tx hash lookups.
- `https://sepolia.basescan.org` open in a tab for the on-chain proof.

---

## 0:00 — 0:35 · The problem, stated once

**On screen:** any well-known app's loading spinner, then the SIMPANG idle page.

> "Every product with a loading screen puts something *beside* it. A tip. A
> skeleton. A little game. None of it changes the thing you're waiting for.
>
> CPUs solved this decades ago. When a processor stalls waiting on memory, it
> doesn't show you a spinner — it does **branch prediction** and executes the work
> that's probably next.
>
> AI agents have the same wait state and no branch predictor. So: **you** are the
> branch predictor."

**Cut sharply at 0:35.** Do not linger on the philosophy — the rest of the video
is the proof.

---

## 0:35 — 1:10 · Start the run, tree appears

**Do:** type `refactor the auth system to use sessions`, hit Enter. Let the
`scanning…` line sit for a beat, then the tree fills in.

> "The agent starts on a real repo on disk. At the same time, a cheap model scans
> for decision points — places where a competent engineer could reasonably go two
> ways. Not questions the prompt already answered. Each row is a branch: what it
> is, files touched, cost, confidence."

**Point at:** the est-time counter in the header, and the confidence bars.

> "Two things it refuses to do: if the leading branch is over 85% confident,
> that's an assumption, not a decision — dropped. If the whole wait is under 15
> seconds, the panel never appears at all."

---

## 1:10 — 2:05 · The kill, and the proof it landed

**Do:** press `1`. The toast appears immediately.

> "Watch the toast — that's the constraint being injected. No model call happened.
> The instruction text was written during the scan, which is why this is instant:
> about 120 milliseconds warm."

**Point at:** the `steering → agent` panel showing `… queued`.

> "It's queued. Now it waits for the agent's next tool call."

**Wait for it to flip to `✓ applied`.** This is the money shot — do not talk over it.

> "There. It was drained at the tool-call boundary and it overrode the agent's
> instructions, mid-task. Not the next turn — *this* one."

**While the run finishes**, narrate the activity log (reading/writing files) and
the prefetch line.

> "Meanwhile a second model is really computing the branch the agent probably
> *won't* take. Not a preview — actual work, so if you'd rather have it, it's
> ready when the answer lands."

---

## 2:05 — 2:45 · The unfakeable claim

**Do:** when the result panel appears, point at the killed row (struck through,
`lost`) and the winner (`won`), then `calibration 100%`.

> "This is the one claim that can't be faked. I killed branch zero. The finished
> code took branch one. That's asserted in an end-to-end test against real
> models — if the agent ever ignored a prune, the test fails."

**Do:** press `d` to open the diff. Scroll it briefly.

> "And here's the actual diff. Real files, real unified diff — computed with
> jsdiff, because the serverless runtime doesn't have git."

**Do:** click `apply` on a prefetched follow-up (optional if time is tight — it
takes another ~90 s; you can cut back to it later).

> "The surviving branch has an apply button. It forks in the *same* working copy —
> it doesn't start over."

---

## 2:45 — 3:15 · It learns, and it degrades gracefully

**Do:** scroll to the *learned preferences* panel.

> "The constraint I just killed is remembered. Kill the same thing three times and
> the scan stops offering it — visibly, with a forget button, so the learning
> isn't a black box."

**Say over the b-roll of the tree:**

> "And nothing you do evaporates. If the agent already committed to that branch,
> you get `late` and one key forks the correction. If the run already finished,
> the constraint still goes into your preferences for next time."

---

## 3:15 — 3:50 · Multiplayer

**Do:** switch to the second browser window, start a run, press `Tab`.

> "Your wait time doesn't have to be spent on your own problem. Tab picks up
> someone else's running tree."

**Do:** press `1` in the helper window. **Cut to the first window** and point at
the 🤝 appearing on that row.

> "That prune went into *their* agent's steering queue. They see who did it. And
> this is real distributed state — the SSE stream and the steer request land on
> different serverless instances; Redis carries the queue between them."

---

## 3:50 — 4:40 · x402, both directions

**Do:** point at the paywall row at the bottom of the tree.

> "The scan finds up to five decision points. Three are free. The rest cost a cent
> each, paid with x402."

**Do:** press `Enter`. Wallet pops up. Sign it.

> "That's a real EIP-3009 signature from my browser wallet. The facilitator
> verifies it and settles USDC on Base Sepolia."

**Do:** when the toast shows `paid · … · tx 0x…`, copy the hash into
`sepolia.basescan.org`. **Show the confirmed transaction.**

> "On-chain. Not a mock."

**Do:** cut to the terminal, `curl https://simpang.vercel.app/api/health`.

> "But here's the part I actually care about. Most x402 entries put a paywall on
> their own thing. SIMPANG is on *both* sides of the market."

**Point at** `bazaar.total` in the health output.

> "The agent has a tool that searches the x402 Bazaar catalog — fifteen thousand
> paid endpoints — and buys from it with its own wallet. In production it found a
> CoinCap price endpoint and bought it unprompted.
>
> And SIMPANG sells: the divergence scan itself is a product, two cents, declared
> to the Bazaar with its input schema. Another agent already bought it. Both
> transactions are on-chain."

**On screen:** the two tx hashes from the README (`0xf47eaae8…`, `0x740acac7…`).

---

## 4:40 — 5:00 · Close

**On screen:** back to the finished run — tree, diff, calibration all visible.

> "No mock mode. No fake fixtures. No demo payments. Real models, real files, real
> money moving on-chain.
>
> Wait time is a second thread. Everything that happens there ends up back in the
> main one. That's the whole idea."

**End card:** `simpang.vercel.app` · `github.com/PugarHuda/simpang`

---

## If you have to cut to 3 minutes

Drop in this order: §3 (learns/degrades) → the `apply` beat in §2:45 → the
multiplayer section §4. Never cut §1:10-2:45 — the queued→applied flip and the
100% calibration are the entire argument.

## Things to have on screen but not explain

- The est-time bar under the header (shows the panel knows how long the wait is).
- `2 futures` → `killed · waiting` → `resolved` on the divergence status.
- The agent's own reason (`↳ …`) under a resolved divergence.
