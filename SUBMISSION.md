# SIMPANG — you are the agent's branch predictor

**Commons · "Make the wait worth it"**

| | |
|---|---|
| **Live** | https://simpang.vercel.app |
| **Code** | https://github.com/PugarHuda/simpang (MIT) |
| **Demo** | 4:26, recorded against production — every run, payment and diff in it is real |
| **Health** | https://simpang.vercel.app/api/health — live status of model, store, x402 facilitator, Bazaar, wallet |
| **Stack** | Next 16 (App Router, SSE) · AI SDK 7 · Venice · x402 v2 official SDK · Upstash Redis · Vercel `sin1` · Base Sepolia |

**In one line:** while the agent thinks, SIMPANG shows you the decision points it is about to
resolve and lets you kill the wrong branches — and the prune lands *inside the running agent*, at
its next tool-call boundary, not on the next turn.

---

## Waiting experience

Everyone building for a loading screen puts **something beside** it — a tip, a skeleton, a
mini-game. None of it changes the thing you are waiting for. The wait stays dead time in a costume.

SIMPANG's wait produces four things that outlive it:

**A changed outcome.** Kill branch 0 and the finished code takes branch 1. That is the one claim
that cannot be faked, and it is asserted in an end-to-end test against real models that fails if
the agent ever ignores a prune. The prune is queued, drained at the agent's next tool call, and
injected as an instruction override — the agent changes course mid-task.

**Work you keep.** While you wait, a second model really computes the branch the agent probably
*won't* take. Not a preview — actual work, with an `apply` button that forks it into the same
working copy when the answer lands.

**A score.** Calibration: how often your guess matched what the agent actually chose.

**Memory.** Kill the same thing three times and the scan stops offering it. Visibly, with a
forget button.

The panel also knows when to stay quiet. If the estimated wait is under 15 seconds, or if no
decision survives the quality gate, nothing appears at all. A feature that shows up with nothing
to say is worse than no feature.

**A passive user still wins.** Press `esc` and you still get the prefetch, the activity log and
the diff. Nothing is gated on participating.

## Originality

CPUs solved this exact problem decades ago. A *wait state* is the cycles a processor burns idle on
slow memory; the answer was **speculative execution** and **branch prediction** — do the work that
is probably next, before you know for sure. Agents have the same wait state and no branch
predictor.

The inversion: **the human is the branch predictor.** The wait stops being an output channel the
product decorates and becomes an *input* channel the agent reads. That is the surprising part —
not that something is shown during the wait, but that what you do there is consumed by the thing
you are waiting for.

The second turn: SIMPANG sells the waiting layer itself. Its divergence scan is an x402 product
other agents can buy, listed in the Bazaar. If waiting is a layer someone ends up owning, it
should have a market on both sides of it.

## Fit

The steering does not arrive "on the next turn" — that is chat's unit, not an agent's. It arrives
at the **tool-call boundary**, which is where an agent actually makes its decisions. AI SDK 7
forbids a system message mid-conversation, so `prepareStep` overrides `instructions` on each step;
the directive then holds for the rest of the run.

Committing is a tool call too. The agent gets a `decide` tool and calls it as it resolves each
point, so the tree fills in from the agent's own reasoning rather than from a parser guessing at
its prose. A model that ignores the tool still gets scored: the scan model classifies the diff and
the log afterwards with structured output.

The agent also spends its own money during the wait. `findPaidData` searches the x402 Bazaar and
`paidFetch` buys with the agent's wallet — the wait is when an agent does its shopping.

And this is not a code-only idea. Ask for a market analysis and the decision points are about the
analysis, with the agent pulling live prices while you prune.

## Repeatability

The tree is derived from *your* prompt against a real repo, not chosen from a fixed menu, so the
same request twice does not give the same decision points.

Three things carry across runs instead of resetting:

- **Calibration** is a running score of your judgement. It gives the tree the shape of something
  you can get better at, without turning it into a game.
- **The tree gets sharper.** Anything you have killed three times stops being offered, so the
  panel converges on the decisions you actually have an opinion about instead of asking the same
  settled question forever.
- **Someone else's tree.** Press `tab` and you are pruning a stranger's run instead of your own.
  Your wait improves their result; they see a 🤝 on the branch you killed, mid-run.

## Execution

Everything runs against real models, a real repo and a real facilitator. There is no mock mode in
the codebase — no fixtures, no demo payments, no simulated agent.

| Claim | How to check it |
|---|---|
| Real agent, real repo | The output carries a unified diff with `a/<file> b/<file>` headers, computed with `jsdiff` because the serverless runtime has no git |
| Steering lands mid-run | The UI shows `… queued` → `✓ applied`; if the run ends before the queue drains it says so rather than keeping the promise on screen |
| Sub-second effect | The kill constraint is written during the scan, so pressing a key makes **no model call at all** |
| Real payments | x402 v2, official SDK on both sides; EIP-3009 verified and settled by `x402.org`; `PAYMENT-RESPONSE` carries the tx hash |
| Both sides of the market | The agent bought a CoinCap endpoint from the Bazaar (`0xf47eaae8…`); an outside buyer bought SIMPANG's scan (`0x740acac7…`) |
| Distributed for real | `/api/run` and `/api/steer` land on different serverless instances; Redis carries the queue between them |

`npm run test:unit` covers the deterministic core in about a second. `npm test` runs five
end-to-end scenarios against live models, including the 100%-calibration proof and an x402 payment
signed by a real wallet. CI runs the free half on every push.

## How it is built

```
POST /api/run  ──┬── divergence scan (cheap model, beside the agent, never blocking it)
   SSE stream    │      └── deterministic quality gate → tree → prefetch (2nd model)
                 │
                 └── agent loop (AI SDK 7, streamText) — starts immediately
                        prepareStep ──► drain steering ──► override instructions
                        tools: readFile · writeFile · decide · webSearch · marketData
                               · findPaidData (x402 Bazaar) · paidFetch (x402 buyer)

POST /api/steer  ── kill/pin, no model call  ──► Redis queue
POST /api/unlock ── x402 gate for the 4th+ decision point
POST /api/fork   ── revise in the SAME working copy, not from scratch
POST /api/paid/scan ── SIMPANG's own product, indexed in the x402 Bazaar
```

Two decisions carry most of the weight.

**The kill constraint is derived, not generated.** Asking the scan model what to forbid produced
swapped prohibitions in production — killing "database sessions" injected "do not use encrypted
cookies", and the agent happily kept the database. Because the two branches are mutually
exclusive, a kill is computed deterministically as `Do NOT choose "<label>"` plus the opposite
branch's constraint. It is also why a keypress is instant: the text already exists.

**A deterministic gate, not hope in the prompt.** A decision point is dropped if the leading
confidence is ≥ 0.85 (that is an assumption, not a decision), if the confidences do not sum to 1,
if the labels are twins, or if the id repeats.

## Known limits

- Learned preferences are global to the deployment and are taught only by run owners. Per-user
  priors need real accounts, which this does not have.
- `/api/steer` is unauthenticated by design — that is what makes `[tab]` work. It makes no model
  call and cannot teach preferences from a non-owner.
- The public deployment runs a cheaper main model than the default so an open demo cannot spend
  itself into a 503. The same test suite passes against it; it is slower.
- The agent's wallet has a per-call and per-run budget, because Bazaar listings are text written
  by strangers and the model is asked to act on them.
