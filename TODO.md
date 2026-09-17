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
- [ ] Run against the live API; confirm ~$184k, RRSP ~$134k, LIRA ~$31k, TFSA ~$16k
- [ ] Confirm XEQT is ~87% of invested value

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
- [ ] Tag the spouse's accounts once SnapTrade is live
- [ ] Add the spouse's RRSP/TFSA limits to `room.json`

## Phase 6 — deploy ⏸ needs the Hetzner box
- [x] Dockerfile (multi-stage, non-root, healthcheck, Link helper stripped)
- [x] `docker-compose.yml` for local parity
- [x] `DEPLOY.md` — Dokploy application, `/data` volume, domain, connector URL
- [ ] Create the Dokploy application and paste env
- [ ] Copy `data/finmcp.db` to the volume once
- [ ] Confirm the first cron line in `/data/sync.log`
- [ ] Add the custom connector in Claude.ai

## Phase 7 — hardening ✅
- [x] Rate limit on `/mcp` (60/min per IP), 404 on wrong secret, constant-time compare
- [x] AES-256-GCM encryption of `plaid_items.access_token`, idempotent migration
- [x] `npm test` — FX, classifier, sign normalisation, aggregation fixtures, HTTP
- [x] `sync_report` tool with `age_hours` and `stale`
- [x] Nightly backup to `/data/backups/`, 14 days retained

## Discovered work
- [ ] Wise `/v2/profiles` response shape is assumed from the docs — confirm the
      `type` field really is `personal`/`business` on a live token.
- [ ] SnapTrade `/accounts/{id}/activities` pagination is assumed to be
      offset/limit with a bare array; confirm and drop the `{data}` fallback.
- [ ] Consider a `get_income_summary` tool once a year of activity has
      accumulated (dividends + interest by account).
