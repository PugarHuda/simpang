# Submitting SIMPANG

Operational notes for the Commons entry. The build is done; this is the paperwork.

## Before anything else

**The entry is not submitted.** The dashboard says *"Your entry — Nothing yet"* and *"No public
builds yet — publish one from its manage page first."* The board settles to submitted builds only,
so until this is done the work scores nothing. Entries are changeable up to the deadline — submit
the current state now and refine it afterwards.

**The deadline contradicts itself on the dashboard**: the dates panel says Sep 18, the rules body
says "Entries close Sep 17". Treat **Sep 17** as the deadline.

## Links to paste

| field | value |
|---|---|
| Live | `https://simpang.vercel.app` |
| Code | `https://github.com/PugarHuda/simpang` |
| Video | *upload `video/out/simpang-demo.mp4` (16.5 MB, 4:26) to YouTube unlisted or Drive and paste the link* |
| Health | `https://simpang.vercel.app/api/health` |

## Copy, at the lengths forms usually ask for

**Name**

```
SIMPANG — you are the agent's branch predictor
```

**Tagline (≤ 80)**

```
Kill the agent's wrong branches while it thinks. The prune lands mid-run.
```

**Short (≈ 280)**

```
While an AI agent thinks, SIMPANG shows the decision points it is about to resolve and lets you
kill the wrong branches. The prune lands inside the running agent at its next tool-call boundary,
not on the next turn — so the wait changes the answer instead of decorating it.
```

**Medium (≈ 700)**

```
Everyone building for a loading screen puts something beside it — a tip, a skeleton, a mini-game.
None of it changes the thing you are waiting for.

CPUs solved this decades ago: when a processor stalls on slow memory it does branch prediction and
runs the work that is probably next. Agents have the same wait state and no branch predictor.
SIMPANG's inversion is that the human is the branch predictor.

While the agent works on a real repo, a second model scans the task for the decision points where
a competent agent could reasonably go two ways. You kill the wrong branches. Each prune is queued
and drained at the agent's next tool call, overriding its instructions mid-task. Kill branch 0 and
the finished diff takes branch 1 — asserted by an end-to-end test against live models.

The branches you spare are not discarded: a second model really computes the likely-not-taken one
while you wait, and one button forks it into the same working copy. You get a calibration score,
and anything you kill three times stops being offered.
```

**Long** — paste `SUBMISSION.md`, which is written against the five judging criteria in their
weighted order.

## What a judge can check in two minutes

- Open the live site, type anything, press Enter. The agent starts reading files immediately while
  the scan runs beside it; the tree lands a few seconds later.
- Press `1`. The toast carries the constraint instantly — no model call happens.
- Watch `… queued` flip to `✓ applied`. That is the prune entering the running agent.
- When it finishes: the killed branch is struck through, the other one won, calibration is scored,
  and there is a real unified diff.
- `GET /api/health` reports every integration live, including which models are actually in force.

## Still open

**The 50 x402 credits are unused.** Commons gives each builder 50 x402 calls against a curated
catalog of paid data and AI endpoints. SIMPANG's agent already speaks the protocol on both sides —
`findPaidData` searches a catalog, `paidFetch` buys from it with the agent's wallet under a spend
budget. If the Commons catalog implements x402 Bazaar discovery, wiring it is one environment
variable:

```bash
vercel env add X402_BAZAAR_URL production   # the Commons catalog endpoint
```

If it exposes a different shape, it needs a small adapter in `lib/bazaar.ts` — send the URL and
the response shape.

**The tokens-spent board reads 0, and now we know why.** The dashboard counts "all-time *Commons*
model usage" — tokens spent through Commons' own runtime, not tokens spent anywhere. This entry runs
on a personal Venice key, so the board will read 0 however often it runs.

Commons hosts an OpenAI-compatible API: an unauthenticated `GET https://api.commonsmade.com/v1/models`
answers `{"detail":{"message":"Missing Commons token"}}`. The code is already pointed at it —
set `COMMONS_API_KEY` and it takes priority over Venice, `/api/health` reports `provider: "commons"`.
Two things are still unknown:

- **Where a builder gets that token.** There is no API-keys route in the dashboard bundle, and the
  API rejects unauthenticated calls with "Missing Privy token" elsewhere, so the token may be the
  session JWT rather than something a user provisions. `/oauth/authorize` and
  `/oidc/authorize/finalize` both exist, which suggests third-party token issuance is possible.
- **The model ids.** `/v1/models` needs the token. The defaults in `lib/config.ts` are read off the
  dashboard's model picker, where one id appeared in full as `deepseek/deepseek-v4-pro`; the other
  two are guesses. Check them on the first authenticated call and override with `SIMPANG_*_MODEL`.

Switching would also stop the Venice balance (~$6) draining and use the 600 free credits per month
that reset on 1 Oct, plus the 150/day sitting unused.

**Where the entry is submitted.** The dashboard SPA routes include `/hackathons`, `/hackathon2` and
`/submissions2`; `GET https://api.commonsmade.com/hackathons` needs auth, but
`/hackathons/public/release` answers publicly and currently returns a *different* event
(`{"slug":"group-chats-2026","status":"open"}`). Whether an externally hosted build (this one lives
on Vercel, not in the Commons builder library) can be registered as a public build is the open
question, and it decides whether this entry can be submitted at all.
