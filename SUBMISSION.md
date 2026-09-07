# SIMPANG — hackathon submission

**Commons · "Make the wait worth it"**

| | |
|---|---|
| **Live** | https://simpang.vercel.app |
| **Code** | https://github.com/PugarHuda/simpang |
| **Demo video** | `video/out/simpang-demo.mp4` — 4:26, built by `video/` from a real production session (see `video/README.md`) |
| **Health** | https://simpang.vercel.app/api/health — real status of model, store, x402 facilitator, Bazaar, agent wallet |
| **Stack** | Next 16 (App Router, SSE) · AI SDK 7 · Venice · x402 v2 official SDK · Upstash Redis · Vercel `sin1` |
| **Models** | Scan `gpt-56-luna`, prefetch/classifier `gpt-4o-mini`. Main run defaults to `claude-sonnet-5`; the public deployment runs the ~35x cheaper `deepseek-v4-flash` so an open demo cannot spend itself into a 503 — it passes the same e2e test, just slower |
| **Networks** | Base Sepolia (USDC), facilitator `x402.org`, x402 Bazaar via Coinbase CDP |

---

## The one-line version

While an AI agent thinks, SIMPANG shows you the decision points it is about to
resolve and lets you kill the wrong branches — and the prune lands *inside the
running agent*, at its next tool-call boundary, not on the next turn.

## What problem this solves

Everyone building for a loading screen puts **something beside** it: a tip, a
skeleton, an animation, a mini-game. None of it changes the thing you are waiting
for. The wait stays dead time wearing a costume.

CPUs solved their own version of this decades ago. A *wait state* is the cycles a
processor burns idle on slow memory; the answer was **speculative execution** and
**branch prediction** — do the work that is probably next, before you know for
sure. AI agents have exactly the same wait state and no branch predictor.

SIMPANG's inversion: **the human is the branch predictor.** Your wait time becomes
the agent's steering signal. Whatever happens in the second thread merges back
into the main one.

## What actually happens

1. **You hit Enter.** The main run starts — the agent reads a real repo on disk
   and writes files into a per-run working copy.
2. **In parallel**, a cheap model runs a *divergence scan*: up to 5 decision
   points where a competent agent could reasonably go two ways. Each has two
   mutually exclusive branches with a label, files touched, cost, and confidence.
3. **You prune.** `1-6` kill, `⇧1-6` pin, `space` to walk the tree and answer
   `y`/`n`, click a row on a phone.
4. **The prune lands in the running agent.** It is queued, drained at the next
   tool-call boundary, and injected as an instruction override that holds for the
   rest of the run. The agent changes course mid-task.
5. **The branches you did not kill do not die.** A second model really computes
   the likely-not-taken branch while you wait. It arrives as a finished follow-up
   with an `apply` button that forks in the same working copy.
6. **You get scored.** Calibration = how often your prune agreed with what the
   agent actually chose. Kill the same thing 3× and the scan stops asking.

## Why it satisfies "make the wait worth it"

- The wait produces **a changed outcome**, not a distraction. The single
  unfakeable claim: kill branch 0, and the finished diff takes branch 1. That is
  asserted in an e2e test against real models, with 100% calibration required.
- The wait produces **work you keep**. The prefetched alternative is a real second
  computation, not a preview.
- The wait produces **memory**. Preferences you kill repeatedly stop being
  offered, visibly and reversibly.
- A **passive** user still wins: collapse the panel and you still get the
  prefetch, the activity log, and the diff. Nothing is gated on participating.

## What is real (no demo mode anywhere)

| Claim | How to check it |
|---|---|
| Real agent on a real repo | The output includes a unified diff with `a/<file> b/<file>` headers, computed with `jsdiff` (the serverless runtime has no git) |
| Steering lands mid-run | `prepareStep` drains the queue at each tool-call boundary and overrides `instructions`; the UI shows `… queued` → `✓ applied` |
| Sub-second effect | `constraintIfPinned` is generated during the scan, so kill/pin makes **no model call at all** — measured warm steer ~120 ms |
| Real payments | x402 v2 with the official SDK on both sides; EIP-3009 signatures verified and settled by the `x402.org` facilitator; `PAYMENT-RESPONSE` carries an on-chain tx hash |
| SIMPANG sells too | `POST /api/paid/scan` (0.02 USDC) behind `withX402`, declared to the x402 Bazaar so other agents discover it |
| Both sides proven in production | Agent bought a CoinCap endpoint from the Bazaar (tx `0xf47eaae8…`); an outside buyer bought SIMPANG's scan (tx `0x740acac7…`) |
| Multiplayer is real state | `/api/run` and `/api/steer` land on different serverless instances; Redis carries the queue between them |

## Architecture, briefly

```
POST /api/run  ──┬── divergence scan (cheap model, 40s budget, never blocks)
   SSE stream    │      └── quality gate (deterministic) → tree → prefetch (2nd model)
                 │
                 └── main agent loop (AI SDK 7, streamText)
                        prepareStep ──► drain steering queue ──► override instructions
                        tools: readFile · writeFile · decide · webSearch · marketData
                               · findPaidData (x402 Bazaar) · paidFetch (x402 buyer)

POST /api/steer  ── kill/pin, no model call, ~120ms warm  ──► Redis queue
POST /api/unlock ── x402 gate (withX402) for the 4th+ divergence
POST /api/fork   ── revise in the SAME working copy, not from scratch
POST /api/paid/scan ── SIMPANG's own paid product, indexed in the x402 Bazaar
```

Three design decisions carry most of the weight:

**The kill constraint is derived, not generated.** Asking the scan model to write
"what to forbid if this branch dies" produced swapped prohibitions in production —
killing "database sessions" injected "do not use encrypted cookies", and the agent
happily kept the database. Because the two branches are mutually exclusive, a kill
is computed deterministically as `Do NOT choose "<label>"` plus the opposite
branch's pin constraint. This is also why kill is instant: the text already exists.

**Committing is a tool call, with a classifier as backup.** The agent gets a
`decide` tool enumerating the divergence ids. Models that ignore it still get
scored: the scan model classifies the diff and log with structured output at the
end. Not keyword matching.

**A deterministic quality gate, not hope in the prompt.** A divergence is dropped
if the leading confidence is ≥ 0.85 (that is an assumption, not a decision), if the
confidences do not sum to 1, if the labels are twins, or if the id repeats. If
nothing survives, the panel does not appear at all. If the estimated wait is under
15 seconds, it does not appear either. A feature that shows up when it has nothing
to say is worse than no feature.

## x402: used in both directions

Most entries that touch x402 put a paywall on their own thing. SIMPANG is on both
sides of the market:

- **Selling.** The divergence scan is a product other agents can buy for 0.02
  USDC. It declares its input/output schema through `declareDiscoveryExtension`,
  so it is indexed in the x402 Bazaar when a payment settles — discoverable by
  agents that know nothing about SIMPANG.
- **Buying.** The agent's `findPaidData` tool searches the Bazaar catalog through
  the official `BazaarClientExtension` (not a guessed URL), and `paidFetch` buys
  the resource with the agent's own wallet. In production it found and bought a
  CoinCap price-history endpoint on its own.
- **Unlocking.** The 4th+ divergence in your own tree costs 0.01 USDC, paid from
  your browser wallet via EIP-3009. No wallet, no demo path — the UI says so.

The buyer tool validates URLs from the model as untrusted input: https only,
and private/loopback/link-local addresses are rejected *after* DNS resolution, so
`evil.example → 127.0.0.1` is caught too.

## Verification

Everything runs against real models and a real facilitator. There is no mock mode
in the codebase.

```bash
npm test                                       # 5 Playwright e2e scenarios, ~7 min, ~$0.15
BASE=http://localhost:3101 npm run test:api    # browserless: validation, scan, steer, x402, diff, calibration
```

The e2e scenarios: (1) a kill changes execution end to end, with 100% calibration
and a real diff; (2) a late prune is recovered by a fork in the same working copy;
(3) two browsers, one prunes the other's tree; (4) a phone-sized viewport doing a
research prompt with live market data; (5) x402 with a real EVM wallet — a
cryptographically valid EIP-3009 signature that the facilitator rejects only on
balance.

## Known limits

- The scan costs one cheap model call per run (~18 s on gpt-56-luna). It runs in
  parallel and is discarded if late, so it never delays the answer.
- The multiplayer tree polls every 2 seconds while the panel is open. SSE per tree
  is the upgrade if it ever becomes a main feature.
- Learned preferences are global to the deployment, taught only by run owners.
  Per-user priors need real accounts, which this does not have.
- `/api/steer` is unauthenticated by design (that is what makes `[tab]` work).
  It makes no model call and cannot teach preferences from a non-owner.
