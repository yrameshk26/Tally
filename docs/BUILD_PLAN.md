# finmcp — Build Plan for Claude Code

Read `CLAUDE.md` first. It holds the rules. This file holds the work, in order.
Do one phase per session. Stop at each checkpoint and report before moving on.

---

## 0. Context (read once)

**What this is.** A personal, read-only net-worth MCP server for Claude. One owner, one household (owner + spouse). It aggregates:

| Source | What | Auth | Cost |
|---|---|---|---|
| SnapTrade Personal | Brokerages (Wealthsimple: RRSP, LIRA, TFSA, DPSP, group RRSP, crypto; Questrade; Coinbase) + holdings | Personal API key (clientId + consumerKey) | Free |
| Plaid Trial plan | Banks and cards, US + Canada (10 Items max) | client_id + secret, per-bank access_token via Link | Free |
| Wise | Multi-currency balances | Read-only API token | Free |
| Bank of Canada Valet | FX rates for CAD reporting | none | Free |

**Stack.** TypeScript ESM (NodeNext), Express, `@modelcontextprotocol/sdk` streamable HTTP (stateless), `better-sqlite3`, `plaid`, `snaptrade-typescript-sdk`. Docker on Hetzner via Dokploy. Nightly cron sync inside the container.

**Already done.** Repo scaffolded and smoke-tested: `tsc` clean, `npm run sync` completes with unconfigured sources returning `{skipped}`, MCP endpoint answers `tools/list`. No institution has been called for real yet.

**Current state of the household (for sanity-checking numbers later).**
Owner's Wealthsimple: RRSP ~$128.6k (XEQT), LIRA ~$31.3k (XEQT), self-directed TFSA ~$8.0k, DPSP ~$3.0k, group TFSA ~$3.0k, group RRSP ~$2.9k. Spouse's Wealthsimple: TFSA ~$4.7k, RRSP ~$2.8k. Household total should land near **$184k CAD**. If `get_net_worth` is wildly off from that, something is double-counted or mis-signed.

**Hard rules (repeated from CLAUDE.md because they matter).**
- Read-only. Never add trading, transfer, or account-setting tools. Never call SnapTrade order endpoints.
- Secrets only in `.env`. Never log access tokens. Never commit `data/`.
- Assets positive, liabilities negative in `accounts.balance`. Transactions stored Plaid-style (positive = money out), negated on read.
- All FX through `src/fx.ts`.

---

## Phase 1 — Verify the scaffold locally

**Goal:** confirm the repo builds and runs on the developer's machine, nothing else.

```
npm install
cp .env.example .env        # set MCP_SECRET=$(openssl rand -hex 32), leave API keys blank
npm run db:init
npm run sync                 # expect: plaid {}, snaptrade {skipped}, wise {skipped}, fx rows written
npm run dev                  # in another terminal:
curl localhost:8787/health
curl -X POST localhost:8787/mcp/$MCP_SECRET -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

**Checkpoint:** paste the tool list. Confirm `fx_rates` has USDCAD/EURCAD/GBPCAD rows (`sqlite3 data/finmcp.db 'select * from fx_rates'`).

Fix anything that fails. Do not add features.

---

## Phase 2 — SnapTrade Personal, real data

**Goal:** `sync_now` returns every brokerage account with correct balances and holdings.

Prereqs the owner does by hand: SnapTrade dashboard → enable 2FA → create Personal API key → put `SNAPTRADE_CLIENT_ID` and `SNAPTRADE_CONSUMER_KEY` in `.env`. Wealthsimple, Questrade and Coinbase are already connected in the SnapTrade dashboard.

Known risk: `src/snaptrade.ts` passes an empty `{userId, userSecret}` object because Personal keys identify the user by the key itself (docs: https://docs.snaptrade.com/docs/personal-vs-commercial). The SDK types still mark those fields required.

Tasks:
1. Run `npm run sync`. If SnapTrade rejects the call, read the SDK's request-signing code and the Personal docs, then fix **only** `src/snaptrade.ts`. Acceptable fixes: omit the fields entirely, or drop the SDK for `listUserAccounts` / `getUserAccountPositions` and call REST directly with the documented Personal auth headers. Do not touch other files.
2. Verify `list_accounts` shows: two Wealthsimple authorizations (owner and spouse), Questrade TFSA, Coinbase. Closed accounts (status `closed`) must be excluded.
3. Verify `get_holdings` shows XEQT as the dominant symbol (~87% of invested value) and that USD-priced positions (TSLA, SPCX, VTI, GSWO, EEMV, IEFA, VOO) convert to CAD.
4. Chase credit cards come through SnapTrade with $0 balances. Mark them inactive: add an `EXCLUDE_SNAPTRADE_CARDS=true` env flag that sets `active=0` for `account_category=LOC` rows. Plaid will own cards.
5. Add a `registered_type` sanity print to the sync report: totals by RRSP / TFSA / LIRA / DPSP / NON_REG.

**Checkpoint:** `get_net_worth` total, `by_registered_type`, and top 5 holdings. Expected ballpark: ~$184k, RRSP ~$134k, LIRA ~$31k, TFSA ~$16k, DPSP ~$3k.

---

## Phase 3 — Plaid Trial plan and Link

**Goal:** 10 bank/card Items connected, transactions syncing, balances correct sign.

Prereqs the owner does by hand:
- New Plaid team at dashboard.plaid.com/signup using an email that has **never** had Plaid Production or Limited Production access. Apply at dashboard.plaid.com/trial-plan. Wait for approval.
- Team Settings → Keys → `PLAID_CLIENT_ID`, Production `PLAID_SECRET` into `.env`. `PLAID_ENV=production`.
- Dashboard → API → Allowed redirect URIs → add `http://localhost:8788/oauth-return`.

Tasks:
1. `npm run link` → http://localhost:8788. Connect institutions in this order and stop at 10:
   1. American Express (US) — OAuth
   2. Chase — OAuth
   3. Bank of America — OAuth
   4. RBC Bank (US cross-border)
   5. CIBC Bank USA (cross-border)
   6. RBC Royal Bank (Canada)
   7. TD Canada Trust
   8. Scotiabank
   9. Tangerine
   10. American Express Canada
   Skip: Capital One Canada, Neo, Bilt (coverage unclear; revisit if a slot frees). Wise uses its own API.
2. After each Link, confirm a row in `plaid_items` with `status='ok'` and accounts in `accounts` with `source='plaid'`.
3. Verify signs: credit cards and loans negative, chequing/savings positive. Fix `src/plaid.ts` if any card shows positive.
4. Verify `get_transactions` for the last 30 days returns rows from at least the OAuth banks, with `amount` negative for purchases.
5. If any Canadian bank returns `ITEM_LOGIN_REQUIRED` within the first week, exercise the relink path end to end: `plaid_status` → `plaid_relink_url` → paste token in the Link page → status back to `ok`. Fix anything rough.
6. Add a `liabilities` pull for cards (`liabilitiesGet`) when `PLAID_PRODUCTS` includes `liabilities`: store `statement_balance`, `minimum_payment`, `due_date` in a new `card_details` table and expose them in `list_accounts`.

**Checkpoint:** `plaid_status` output (10 rows, all `ok`), `get_net_worth` with liabilities now non-zero, and a `get_transactions` sample.

---

## Phase 4 — Wise

**Goal:** Wise balances included.

Prereq: Wise → Settings → API tokens → create a **read-only** token → `WISE_API_TOKEN`.

Tasks:
1. `npm run sync`, confirm `wise:` accounts appear with correct currency and balance.
2. If the owner has both personal and business profiles, both should appear, named `Wise <CCY> (personal|business)`.

**Checkpoint:** `list_accounts` filtered to `source='wise'`.

---

## Phase 5 — Household features

**Goal:** the numbers Claude reports match how the household thinks about money.

Tasks:
1. **Owner tagging.** Run `set_account_owner` for each spouse account (`snaptrade:` ids under the second Wealthsimple authorization) → `spouse`. Everything else → `me`. Persist a `DEFAULT_OWNER=me` env so new accounts get tagged automatically.
2. **Contribution room tracker.** New table `room` with rows `(person, account_type, year, limit, contributed)`. Seed from env or a `room.json`:
   - me / RRSP / 2026 / 115568
   - me / TFSA / 2026 / 80676.52
   - spouse rows once known
   Add tool `get_contribution_room` that subtracts YTD contributions detected in transactions (Plaid transfers into Wealthsimple, and SnapTrade `CONTRIBUTION`/`DEPOSIT` activity if available) and returns remaining room per person per account type. Be conservative: if detection is uncertain, report `contributed_detected` and `contributed_manual` separately and let the user override via a `set_contributed` tool.
3. **Cashflow summary.** Tool `get_cashflow(start, end)`: income vs spend by month, top merchants, transfers excluded (category `TRANSFER_IN`/`TRANSFER_OUT`), broken down by owner if card ownership is tagged.
4. **Snapshot backfill.** SnapTrade has an experimental balance-history endpoint (1 year lookback, must be enabled in the SnapTrade dashboard add-ons). If enabled, import it into `snapshots` so `get_net_worth_history` has history from day one instead of starting empty.

**Checkpoint:** `get_net_worth` split by owner, `get_contribution_room` output, one month of `get_cashflow`.

---

## Phase 6 — Deploy to Hetzner via Dokploy

**Goal:** HTTPS endpoint usable as a Claude.ai custom connector, nightly sync running.

Tasks:
1. Push repo to a private Git remote. In Dokploy: new Application from the repo, Dockerfile build.
2. Environment: paste every `.env` value. Set `DB_PATH=/data/finmcp.db`, `PORT=8787`.
3. Mount a persistent volume at `/data`.
4. Domain + HTTPS (Dokploy/Traefik). Health check `/health`.
5. Copy the local `data/finmcp.db` to the volume once so Plaid access tokens carry over. Do not re-Link on the server. The Link helper (`link-server.ts`) is never deployed; port 8788 must not be exposed.
6. Confirm cron fires: check `/data/sync.log` the next morning.
7. Claude.ai → Settings → Connectors → Add custom connector → `https://<domain>/mcp/<MCP_SECRET>`. Test: "what's my net worth", "show holdings concentration", "plaid status".

**Checkpoint:** screenshot of Claude answering `get_net_worth` from the deployed server, and the first cron log line.

---

## Phase 7 — Hardening (only after everything above works)

- Rate-limit the MCP route (e.g. 60 req/min) and return 404 on wrong secret without timing leaks.
- Encrypt `plaid_items.access_token` at rest with a key from env (`TOKEN_ENC_KEY`, AES-256-GCM). Migration must be idempotent.
- Add `npm test`: unit tests for `convert()` sign/rounding, `guessRegistered()`, transaction sign normalisation, and a fixture-based test for `get_net_worth` aggregation.
- Add a `sync_report` tool that returns the last sync's per-source status and timing, so Claude can tell the user when data is stale.
- Backup: nightly `sqlite3 .backup` to `/data/backups/` keeping 14 days.

---

## Definition of done

1. `get_net_worth` in Claude matches the Wealthsimple app within FX rounding.
2. All 10 Plaid Items `ok`, or `login_required` with a working one-click relink.
3. Household split by owner works.
4. Contribution room reported per person.
5. Deployed, HTTPS, nightly sync, no secrets in git.
6. Zero code paths that can move money.

## Out of scope (do not build)

- Budgeting UI, categorisation rules, dashboards. Claude is the UI.
- Any write action against any institution.
- Multi-user / multi-tenant. One household.
- Scraping Wealthsimple's private GraphQL API. SnapTrade only.
