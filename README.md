# SIMPANG

**You pick the direction at every fork.** *Simpang* is Indonesian for a place where
the road splits. While the agent thinks, you are its branch predictor.

Entry for the Commons hackathon · *Make the wait worth it*.

---

## Thesis

> Wait time is a second thread. Whatever happens there has to end up back in the
> main one.

Everyone puts **something beside** the loading screen. SIMPANG puts something
that **merges back into it**.

CPUs have a name for this problem: a *wait state*, the cycles a processor spends
idle waiting on slow memory. The fix in silicon is **speculative execution** and
**branch prediction**. AI agents have the same wait state — but no branch
predictor. The inversion: **the human is the branch predictor.**

## How it works

1. You hit Enter. The main run starts: the agent (Claude Sonnet 5) reads a real
   repo on disk and writes files into a per-run working copy.
2. **At the same time**, a cheap model runs a *divergence scan*: the decision
   points where a competent agent could reasonably go two ways.
3. Each branch is one row: label, files touched, cost, confidence.
4. You prune. `1-6` kill · `⇧1-6` pin · `space` ask then `y`/`n` · `esc` ignore ·
   `f` fork (when you were late) · `enter` pay for the 4th+ branch via x402 ·
   `tab` prune someone else's tree · `d` show the diff.
5. Every prune enters the steering queue, is **drained at the next tool-call
   boundary**, and overrides the agent's instructions — not on the next turn.
6. The branches you did not kill **do not die**: the alternative is really
   computed by a second model while you wait, and lands as a ready-to-use
   follow-up when the main answer arrives.
7. When it ends: a real diff (`git diff`), a calibration score for your guesses
   against what the main run actually took, and preferences you have killed 3×
   stop being offered (persisted in `.simpang/prior.json`).

There is no mock mode, no fake fixture, no demo payment. Everything you see is a
real model, a real file, a real facilitator.

## Run it

```bash
npm install
echo "VENICE_API_KEY=..." > .env.local     # or OPENROUTER_API_KEY / AI_GATEWAY_API_KEY
npm run dev                                 # http://localhost:3000
```

Port 3000 taken? `PORT=3100 npm run dev`. Other variables: see `.env.example`.
Next 16 allows only one dev server per folder.

**Models.** Main run `claude-sonnet-5`; scan `openai-gpt-56-luna`. Measured on
Venice (2026-09-06) with the real scan prompt: luna 18 s for 5 relevant
divergences; gpt-4o-mini 4 s but it offers choices the prompt had already made;
deepseek/gemma think for 10-30 s first; claude-sonnet-5 22 s and expensive.
Override with `SIMPANG_MAIN_MODEL` / `SIMPANG_SCAN_MODEL`.

**What the public deployment runs.** `claude-sonnet-5` is the best main run and the default here,
but at $3/$15 per million tokens one run costs roughly $0.30 — an open demo would spend its way
to a 503 in a day. So https://simpang.vercel.app sets `SIMPANG_MAIN_MODEL=deepseek-v4-flash`
($0.138/$0.275, about 35x cheaper) and a lower daily cap. It passes the same end-to-end test:
it calls the tools, writes real files, honours a kill, and scores 100% calibration — it is just
slower, around 4 minutes against sonnet's 2. Run it locally with the default for the better
answer.

**Repo.** Defaults to `examples/acme` (a small app with JWT auth). Point at
another repo with `SIMPANG_REPO_DIR`. The agent reads and writes in a per-run
copy (`.simpang/runs/<id>/`); the original repo is never touched.

**Live-data tools (`lib/tools.ts`).** Prompts are not only about code. The agent
has `webSearch` (Venice web search, an answer plus citations, same key as the
model), `marketData` (daily crypto prices from CoinGecko, public), and
`paidFetch` (the x402 BUYER side: paid endpoints charged automatically to the
agent's wallet, `X402_BUYER_PRIVATE_KEY`, USDC on Base Sepolia). "analyse the
bitcoin price over the last 7 days" produces an analysis with real numbers, not
"I have no data access".

## The x402 pay gate

A scan yields up to 5 divergences. The first three are free; each one after that
costs 0.01 USDC through **x402 v2 with the official SDK**:

- Seller: `app/api/unlock/route.ts` wrapped in `withX402` from `@x402/next`;
  `x402ResourceServer` + `HTTPFacilitatorClient` + `ExactEvmScheme`.
- Buyer (browser): `lib/x402-client.ts` uses `@x402/fetch` + `@x402/evm` + viem.
  An EVM wallet (MetaMask, Rabby, Coinbase Wallet) signs an EIP-3009
  `TransferWithAuthorization`; `wrapFetchWithPayment` retries the request with
  `PAYMENT-SIGNATURE`; the facilitator settles the USDC transfer on-chain and
  answers with a `PAYMENT-RESPONSE` carrying the transaction hash.
- Defaults to **Base Sepolia** + testnet USDC + the `https://x402.org/facilitator`.
  Base mainnet: `X402_NETWORK=eip155:8453` and Coinbase's CDP facilitator.
- With no wallet in the browser the UI says so. There is no demo path.
- Steering a locked divergence is rejected with 402 on the server, not merely
  hidden by the UI.

## SIMPANG in the x402 market: buyer AND seller

- **Seller to other agents.** `POST /api/paid/scan` sells the divergence scan
  (0.02 USDC, Base Sepolia) behind `withX402`, and declares
  `declareDiscoveryExtension` (input/output schema) so it gets indexed in the
  **x402 Bazaar** when the facilitator settles a payment. Other agents can find
  and buy it knowing nothing about SIMPANG.
- **Buyer.** The `findPaidData` tool searches the Bazaar catalog through
  `BazaarClientExtension` from `@x402/extensions` (not a guessed URL), then
  `paidFetch` (GET, or POST with a JSON body) buys it with the agent's wallet.
  The loop closes in the tests: the agent's wallet buys SIMPANG's own scan and
  the facilitator settles the USDC transfer on-chain.
- **Network note.** Some Indonesian ISPs DNS-block `api.cdp.coinbase.com` (on
  the dev machine it resolves to `internetbaik.telkomsel.com`). From a Vercel
  Singapore server it is not blocked; `GET /api/health` reports whether the
  catalog is reachable from the instance that answered.
- `GET /api/health`: the real status of the model, the store (memory/redis), the
  facilitator (`/supported`), the Bazaar, the agent wallet, and the region.
- **Proven in production (2026-09-06).** Health from Vercel `sin1`: Bazaar
  reachable, 15,595 resources indexed. Prompt "search the x402 bazaar catalog for
  a paid data endpoint on eip155:84532 and buy one": the agent called
  `findPaidData`, picked CoinCap (Bitcoin price history, 0.01 USDC, Base
  Sepolia), bought it through `paidFetch`, and the USDC transfer is recorded
  on-chain (`0xf47eaae8…`). An outside buyer also bought SIMPANG's
  `/api/paid/scan` from production (`0x740acac7…`).

## Checks

Every test runs against real models and a real facilitator (~$0.03 per run with
`qwen3-coder` as the main run). Needs `VENICE_API_KEY`.

```bash
npm run test:unit # the deterministic core: no browser, no server, no spend (~1s)
npm test          # Playwright e2e: starts its own server on :3101 (stop any other dev server first)
```

`test:unit` covers `qualityGate`, the part of the scan that does not depend on a model behaving —
every rule the section above calls deterministic is asserted there, and CI runs it on each push
along with `tsc` and the build.

Five e2e scenarios (`tests/e2e.spec.ts`):

1. **A kill changes execution.** Press `1` → a toast carrying the constraint from
   the scan in under a second → the main run commits to the opposite branch →
   100% calibration → a real diff with `a/<file> b/<file>` headers. While
   waiting: ask mode walking the whole tree, collapse, the activity line.
2. **A late prune does not evaporate.** Kill a branch that already won → `late` →
   `f` → the agent revises in the same working copy, the diff is updated.
3. **The multiplayer tree.** Two browsers; `tab` in one picks up the other's
   tree; the prune lands in their run's steering queue.
4. **Phone, research prompt.** 390px viewport: tap the "analyse bitcoin" example,
   tap the `kill` button on a branch row, the directive panel shows `queued` then
   `✓ applied`, the activity line shows `fetching market data`, the answer is
   rendered as markdown with a table of real prices, and the agent's reason
   appears under the divergence.
5. **x402 with a real wallet.** `window.ethereum` is filled with a viem wallet
   (fresh key, zero balance). `enter` → 402 → a valid EIP-3009 signature → the
   x402.org facilitator rejects with `invalid_exact_evm_insufficient_balance`,
   not because of the signature. Fund that key with Base Sepolia USDC and the
   result is `paid`.

The API test with `X402_TEST_BUYER_KEY` holding testnet USDC proves the payment
settles on-chain: `PAYMENT-RESPONSE` carries a Base Sepolia transaction hash.

```bash
SIMPANG_FREE_BRANCHES=2 npx next dev -p 3101 &
BASE=http://localhost:3101 npm run test:api     # browserless: validation, scan, steer, x402, diff, calibration
```

## Deploy (Vercel)

Repo: https://github.com/PugarHuda/simpang · Production: https://simpang.vercel.app.
Run state (the tree, the steering queue, actions, commits, changed files) lives in
**Upstash Redis** (free tier, Singapore) via `UPSTASH_REDIS_REST_URL` /
`UPSTASH_REDIS_REST_TOKEN` (or `KV_REST_API_*` from the Vercel Marketplace);
without it the store is in-memory, fine for one process but **not** for
serverless. Proven in production: `/api/run` (a long SSE) and `/api/steer` land
on different instances; without Redis the steer 404s, with Redis it is drained at
the next step boundary and the agent changes its decision. The agent's working
copy lives in the instance's tmpdir; the changed files also go to Redis so a fork
on another instance can continue. The diff is computed with `jsdiff`, not `git`,
because the serverless runtime has no git.

```bash
vercel link
vercel integration add upstash/upstash-kv --metadata primaryRegion=sin1   # or fill the env from an Upstash account
vercel env add VENICE_API_KEY production
vercel deploy --prod
```

## File map

| File | What is in it |
|---|---|
| `lib/divergence.ts` | The plain schema + the scan prompt + the **deterministic quality gate** |
| `lib/store.ts` | Steering queue, user actions, unlock count, persistent prior |
| `lib/config.ts` | Cost and latency guards · model providers · x402 parameters |
| `lib/repo.ts` | The repo on disk, a working copy per run, a real `git diff` |
| `lib/x402.ts` | The x402 resource server (official SDK) |
| `lib/x402-client.ts` | The x402 buyer in the browser: EVM wallet + `@x402/fetch` |
| `app/api/run/route.ts` | SSE · parallel scan · agent loop · `prepareStep` = the injection point · prefetch · classifier |
| `app/api/steer/route.ts` | kill / pin — **no model call** |
| `app/api/fork/route.ts` | The correcting fork in the same working copy |
| `app/api/unlock/route.ts` | The x402 gate (`withX402`) for the 4th+ divergence |
| `app/api/others/route.ts` | Run state (polled by the UI) + the multiplayer tree |
| `components/tree.tsx` | The tree + hotkeys |
| `examples/acme/` | The example repo the agent works on |
| `tests/` | Playwright e2e + API tests |

## Design decisions that matter

**`constraintIfPinned` is written during the same scan; `constraintIfKilled` is
derived.** Pressing `1` triggers no model call at all — the constraint text
already exists. That is how the "visible effect in under a second" rule is met.
The prohibition is not asked of the model: scan models demonstrably swap the
prohibition between branches (in production, killing "database sessions" injected
"do not use encrypted cookies", and the agent kept using the database). Because
the two branches are mutually exclusive, a kill is `Do NOT choose "<label>"` plus
the instruction to pin the opposite branch, derived deterministically in
`qualityGate`.

**Steering enters through per-step `instructions`.** AI SDK 7 rejects a `system`
message in the middle of `messages`. `prepareStep` overrides `instructions` with
the system prompt plus every directive that has landed, so a directive holds until
the run ends.

**Committing is a tool call, with a classifier as backup.** The main run gets a
`decide` tool whose enum is the divergence ids. A model that ignores it (qwen)
still gets its commits: the scan model classifies the diff and the log with
structured output at the end of the run. Not keyword matching.

**The scan schema is deliberately plain.** No `.int()`, `.max()` or `z.tuple` —
strict structured-output backends (Anthropic, OpenAI, Gemini, vLLM grammars)
reject `minimum`/`maxLength`/`items[]`. The constraints are enforced in
`qualityGate`.

**A deterministic quality gate, not hope in the prompt.** A divergence is dropped
if the leading confidence is ≥ 0.85, if the two confidences do not sum to 1, if
the labels are identical, or if the id is a duplicate. Nothing survives → **the
panel does not appear.** The scan also estimates duration; a wait under 15 s →
no panel.

**The scan runs beside the agent, never in front of it.** It used to block, and that made the
first 25-40 seconds of every wait a spinner and nothing else — the emptiest stretch of a product
whose whole point is that waiting should be worth something. The agent now starts the moment you
press Enter and learns the tree's vocabulary at its next step boundary, through the same
`prepareStep` injection point steering uses. The scan keeps its 40 s budget; if it fails or runs
late you simply never get a panel, and the answer is unaffected. That includes its store: a Redis
hiccup in the scan path cannot take the main run down with it.

**No user action evaporates.** Three levels of degradation:

| Situation | Behaviour |
|---|---|
| The main run has steps left | Injected at the next step boundary |
| The main run already committed to that branch | `late` → `f` forks in the same working copy |
| The main run already finished | 409; the constraint is already in the prior for the next run |
| The run ended before the queue was drained | the directive flips to `✗ not applied · the run ended first` — it never sits there still claiming to be queued |

**Real prefetch.** The lower-confidence branch of the top two divergences is
computed by a second model while you wait (files touched plus the code). Dropped
if you kill it; hidden if the main run picks it after all.

**A passive user still wins.** `esc` collapses the panel; the prefetch keeps
running; the activity log shows the files read and written and the data fetched;
you still get the diff. The agent's answer is rendered as markdown (tables,
headings, code).

**It works without a keyboard.** Clicking a branch row kills it, the `kill`/`pin`
buttons are always visible on a small screen, the x402 gate is clickable. The
*steering → agent* panel shows which directives are queued and which have been
applied, and under a resolved divergence the agent's own reason for its choice
appears (from the `decide` tool).

**Prefetch is applicable.** The alternative branch computed while you waited has
an `apply` button: a fork in the same working copy that uses that draft, so "the
surviving branch does not die" is not just a sentence. The fork understands
research tasks too: the deliverable is rewritten for the other branch with the
live-data tools.

**The multiplayer tree has a face.** Every client carries a random id
(`x-simpang-client`, not authentication). A prune from someone else's `[tab]` is
recorded as a `helper`, and the run's owner sees a 🤝 on their tree through the
`actions` event at the next step boundary, without polling. Learned preferences
are only taught by the owner: a helper cannot mark a constraint "settled" in
everyone else's scans.

**Learned preferences are visible.** The *learned preferences* panel lists the
constraints you have killed with their counts; `≥3×` means the next scan stops
offering it. The `forget` button undoes it (`/api/prefs`).

**A dropped connection does not lock the UI.** If the SSE breaks before `done`,
the page pulls the last state from the server (output, diff, commits) and says so.

**The agent stops on the clock, not on a step count.** The serverless ceiling is 300 s and cannot
be raised on this plan. A cheaper main model is a slower one — a measured production run took
270 s — so `stopWhen` carries a wall-clock condition alongside the step limit. Stopping at
`GUARDS.runBudgetMs` still runs `finish()`, so the user keeps the diff and the calibration and is
told the answer was cut short; being killed by the platform at 300 s would leave them with neither.

**Endpoints that burn money are capped.** `/api/run` and `/api/fork` use
`@upstash/ratelimit` (a per-IP sliding window plus a global daily quota, shared
across instances through Redis; in-memory without it). The limit is checked
before body validation, so even a malformed request cannot trigger a paid run.
x402 payments go to the agent's wallet (`X402_PAY_TO`), not a throwaway address.

**The agent's wallet has a budget it cannot argue with.** `findPaidData` returns Bazaar listings
whose description, service name and tags were written by whoever registered the resource — text the
model is then asked to act on, while holding a funded wallet for up to 30 steps. So `paidFetch`
asks each URL unpaid first, reads the price out of the 402 challenge, and refuses before any
signature if it exceeds `X402_MAX_CALL_USD` (default $0.10) or what is left of
`X402_RUN_BUDGET_USD` (default $0.50). A challenge it cannot parse is priced as infinite, not free.

## Roadmap

- [x] Divergence scan + quality gate
- [x] Steering queue + injection in `prepareStep`
- [x] Commit via the `decide` tool + post-hoc classifier + calibration + persistent prior
- [x] Real prefetch while you wait
- [x] Correcting fork in the working copy
- [x] x402 with the official SDK, a browser wallet, the x402.org facilitator
- [x] The multiplayer tree (`[tab]`)
- [x] A real repo + `git diff`
- [x] Playwright e2e against real models
- [x] Multi-instance store (Redis) for the serverless deploy
- [x] x402 Bazaar on both sides: SIMPANG buys from the catalog and sells into it
- [ ] Wire the hackathon's curated x402 catalog. Commons gives each builder 50 x402 credits
      against it; `findPaidData` / `paidFetch` already speak the protocol, so this is a catalog
      URL away
