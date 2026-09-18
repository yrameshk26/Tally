# TODO

Phases follow `docs/BUILD_PLAN.md`. Anything marked ⏸ needs a credential or a
dashboard action only the owner can do.

## Phase 1 — verify the scaffold ✅
- [x] Repo scaffolded, `tsc --noEmit` clean, 93 tests green
- [x] `npm run db:init` creates all 12 tables
- [x] `npm run sync` completes; unconfigured sources report `{skipped}`
- [x] `fx_rates` populated from Bank of Canada (19 pairs incl. USDCAD/EURCAD/GBPCAD)
- [x] `/health` and `POST /mcp/<secret>` answer `tools/list` (15 tools)

## Phase 2 — SnapTrade ⏸ needs `SNAPTRADE_CLIENT_ID` + `SNAPTRADE_CONSUMER_KEY`
- [x] Signed REST client that omits `userId`/`userSecret` for Personal keys
- [x] Closed/archived accounts excluded
- [x] `EXCLUDE_SNAPTRADE_CARDS` deactivates `LOC` rows so Plaid owns cards
- [x] `by_registered_type` totals in the sync report
- [x] USD positions converted to CAD; options priced at 100 shares
- [x] Balance-history backfill behind `SNAPTRADE_BALANCE_HISTORY`
- [x] Run against the live API — $184,391.90: RRSP $134,399.57, LIRA $31,313.42,
      TFSA $15,643.88, DPSP $3,028.36. Matches the plan's ballpark.
- [x] XEQT is 95.5% of invested value ($167,452 of $175,434). Invested sits ~$9k
      below net worth because managed portfolios report balance but no positions.

## Phase 3 — Plaid ⏸ needs Trial plan approval + `PLAID_CLIENT_ID`/`PLAID_SECRET`
- [x] Link helper on :8788 with OAuth return and one-click repair
- [x] `transactionsSync` with cursor persistence
- [x] Card/loan balances stored negative (tested)
- [x] `liabilitiesGet` → `card_details` (statement balance, minimum, due date)
- [x] `plaid_status` / `plaid_relink_url` relink path
- [ ] Connect the 10 Items in the order in the build plan
- [ ] Verify 30 days of transactions from the OAuth banks
- [ ] Exercise a real `ITEM_LOGIN_REQUIRED` relink end to end

## Phase 4 — Wise ⏸ needs `WISE_API_TOKEN`
- [x] Profiles + STANDARD and SAVINGS balances, named `Wise <CCY> (personal|business)`
- [ ] Run against the live API

## Phase 5 — household features ✅ (seeded data pending)
- [x] `set_account_owner`, `DEFAULT_OWNER`, tags survive re-sync
- [x] `room` table, `get_contribution_room`, `set_contributed`, `set_room_limit`
- [x] `get_cashflow` with transfers and card payments excluded by default
- [x] Snapshot backfill path
- [x] Tagged the spouse's accounts — me $176,880.01 / spouse $7,511.89
- [ ] Add the spouse's RRSP/TFSA limits to `room.json`

## Phase 6 — deploy ⏸ needs the Hetzner box
- [x] Dockerfile (multi-stage, non-root, healthcheck, Link helper stripped)
- [x] `docker-compose.yml` for local parity
- [x] `DEPLOY.md` — Dokploy application, `/data` volume, domain, connector URL
- [ ] Create the Dokploy application and paste env
- [ ] Copy `data/finmcp.db` to the volume once
- [ ] Confirm the first cron line in `/data/sync.log`
- [ ] Add the custom connector in Claude.ai

## Phase 8 — web UI ✅
- [x] Argon2id (OWASP params) + `npm run hash-password`; password never stored
- [x] TOTP implemented against RFC 6238 vectors, no dependency
- [x] Server-side sessions, real sign-out, "sign out everywhere"
- [x] CSRF on every state-changing route; CSP `default-src 'none'` with nonces
- [x] Failure-only sign-in limiter, checked before password verification
- [x] Settings page — provider credentials encrypted in DB, override env
- [x] Connections page — Plaid Link, item health, one-click repair, OAuth return
- [x] Overview — net worth, accounts, cards with due dates, holdings
- [x] Institution-supplied strings escaped (stored-XSS test)
- [ ] Register `https://<domain>/connections/oauth` in the Plaid dashboard
- [ ] Enrol two-factor on the deployed instance
- [ ] Rotate the temporary admin password

## Phase 7 — hardening ✅
- [x] Rate limit on `/mcp` (60/min per IP), 404 on wrong secret, constant-time compare
- [x] `TRUST_PROXY` — without it `req.ip` is the proxy and the limiter is one global bucket
- [x] AES-256-GCM encryption of `plaid_items.access_token`, idempotent migration
- [x] `npm test` — FX, classifier, sign normalisation, aggregation fixtures, HTTP
- [x] `sync_report` tool with `age_hours` and `stale`
- [x] Nightly backup to `/data/backups/`, 14 days retained

## Phase 8 — the complete picture ✅
- [x] `get_financial_summary` — every section in one call, `sections` to narrow
- [x] `get_activities` — brokerage dividends, buys, sells, fees, contributions
- [x] `get_holdings by_account` — positions under their account, invested vs balance
- [x] Credit limits and utilisation from Plaid `balances.limit`
- [x] Overview charts: net worth over time, allocation, largest holdings,
      income vs spend — each with a table view
- [x] README and CLAUDE.md rewritten for OAuth, profiles, the UI and the charts

## Discovered work
- [x] MCP endpoint auth: the secret-in-URL is written to Traefik's access log on
      every request (Dokploy enables request logging globally). Fixed by OAuth
      2.1; set `MCP_ALLOW_PATH_SECRET=false` to close the legacy route.
- [ ] Merchant names arrive unnormalised — "Primmum Insurance Co" and "Primmum
      Insurance Comp" are one merchant split across two rows in `top_merchants`.
- [ ] Two Items need re-auth: BMO (US) and Amex Canada under `spouse` are
      `login_required`, Tangerine is `INSTITUTION_NOT_RESPONDING`. `me` is at
      9 of its own 10; `spouse` at 3 of its own 10. The same institution under
      two profiles is two teams, not a duplicate — `plaid_status` now says so.
- [ ] Wise `/v2/profiles` response shape is assumed from the docs — confirm the
      `type` field really is `personal`/`business` on a live token.
- [ ] SnapTrade `/accounts/{id}/activities` pagination is assumed to be
      offset/limit with a bare array; confirm and drop the `{data}` fallback.
- [ ] Managed-portfolio holdings (DPSP, managed TFSA, group RRSP) have no
      position breakdown from SnapTrade. Check whether an add-on exposes them.
- [ ] Consider a `get_income_summary` tool once a year of activity has
      accumulated — `get_activities` now has the raw rows and a per-type
      rollup, so this is a shaping question, not a data one.
