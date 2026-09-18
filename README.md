# tally

A personal, read-only **net-worth MCP server** for Claude. It aggregates
brokerages, banks, cards and multi-currency balances into one CAD picture and
exposes it to Claude as MCP tools — no dashboard, no budgeting UI. Claude is
the UI.

| Source | What it covers | Auth | Cost |
|---|---|---|---|
| SnapTrade Personal | Wealthsimple (RRSP, LIRA, TFSA, DPSP, group plans), Questrade, Coinbase — balances, positions, activity | clientId + consumerKey | free |
| Plaid (Trial plan) | Banks and cards, US + Canada, 10 Items max — balances, transactions, card statement details | client_id + secret, one access_token per bank | free |
| Wise | Multi-currency balances and jars | read-only API token | free |
| Bank of Canada Valet | FX rates for CAD reporting | none | free |

## Before you start

Two things gate how far you get:

- **Plaid Production access is the hard part.** Plaid grants it to companies
  under a signed agreement, and the Trial plan is an evaluation tier capped at
  10 Items. If you cannot get your own Plaid access, the bank and card half of
  this will not work for you.
- **SnapTrade Personal keys are for personal use.** They identify *you*. Do not
  use them to hold anyone else's data.

The SnapTrade, Wise and Bank of Canada halves work immediately with credentials
anyone can create. This is self-hosted, single-household software: you run it,
you hold the tokens, you agree to your own providers' terms. See
[SECURITY.md](SECURITY.md) before deploying it anywhere.

## Tools

| Tool | Does |
|---|---|
| `get_net_worth` | Total in CAD, split by owner, registered type, source, institution |
| `get_net_worth_history` | Daily snapshots |
| `list_accounts` | Every account with balance, currency, registered type, owner, card details |
| `get_holdings` | Positions rolled up by symbol with concentration % and unrealized P&L |
| `get_transactions` | Bank/card transactions — negative is money out |
| `get_cashflow` | Income vs spend by month, category, merchant, owner |
| `get_contribution_room` | Remaining RRSP/TFSA/FHSA room per person |
| `set_contributed`, `set_room_limit` | Correct the room figures by hand |
| `set_account_owner` | Tag an account `me` / `spouse` / `joint` |
| `plaid_status`, `plaid_relink_url` | Item health and one-click repair |
| `sync_now`, `sync_report` | Refresh on demand; tell the user how stale data is |
| `fx_rates` | The rates every balance was converted at |

Nothing here can move money. See rule 1 in `CLAUDE.md`.

## Quick start

```bash
npm install
cp .env.example .env
sed -i "s/^MCP_SECRET=$/MCP_SECRET=$(openssl rand -hex 32)/" .env

npm run db:init     # creates data/finmcp.db, seeds room.json if present
npm run sync        # unconfigured sources report {skipped}; FX rates are fetched
npm run dev         # server on :8787
```

```bash
curl localhost:8787/health
curl -X POST localhost:8787/mcp/$MCP_SECRET \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

## Connecting the sources

**SnapTrade.** Dashboard → enable 2FA → create a Personal API key → set
`SNAPTRADE_CLIENT_ID` and `SNAPTRADE_CONSUMER_KEY`. Connect Wealthsimple,
Questrade and Coinbase in the SnapTrade dashboard itself. Personal keys
identify the user by the key, so `userId`/`userSecret` are not sent — see
`DECISIONS.md`. Chase cards arrive through SnapTrade with $0 balances and are
deactivated by `EXCLUDE_SNAPTRADE_CARDS=true`; Plaid owns cards.

**Plaid.** Create a team at dashboard.plaid.com with an email that has never had
Production or Limited Production access, apply for the Trial plan, then set
`PLAID_CLIENT_ID`, `PLAID_SECRET`, `PLAID_ENV=production`. Add
`http://localhost:8788/oauth-return` under Allowed redirect URIs. Then:

```bash
npm run link        # http://localhost:8788 — local only
```

Connect up to 10 Items. The suggested order is in `docs/BUILD_PLAN.md` §3. Each
successful link writes a row to `plaid_items`; `plaid_status` shows their health
and `plaid_relink_url` repairs one that goes `login_required`.

**Wise.** Settings → API tokens → create a **read-only** token → `WISE_API_TOKEN`.

## Contribution room

Seed limits from a CRA notice of assessment:

```bash
cp room.example.json room.json   # edit, then:
npm run db:init
```

Detection is conservative on purpose. Brokerage activity tagged
`CONTRIBUTION`/`DEPOSIT` is attributable to a specific registered account and
counts. A bank transfer into Wealthsimple cannot be split across RRSP and TFSA
from the bank side, so it is reported as
`unattributed_brokerage_transfers_cad` and never silently subtracted. Set the
real number with `set_contributed` and it wins over detection.

## Deploying

See [`DEPLOY.md`](DEPLOY.md) — Docker image, Dokploy application, persistent
volume at `/data`, HTTPS domain, and adding the server to Claude.ai as a custom
connector.

## Security

Read [SECURITY.md](SECURITY.md) before deploying. The short version:

- The MCP URL **is** a bearer token. It leaks the way URLs leak — including into
  reverse-proxy access logs, which are on by default in many setups. Rotate
  `MCP_SECRET` periodically.
- Set `TRUST_PROXY` to the number of proxy hops in front of the app, or the
  per-IP rate limiter degrades into a single shared bucket.
- Back up `TOKEN_ENC_KEY` somewhere other than the server. Losing it means
  re-linking every bank.
- Report vulnerabilities privately via GitHub Security Advisories, not issues.

## Development

```bash
npm run check      # typecheck + 93 tests
npm test
npm run typecheck
```

Tests cover FX sign and rounding, the registered-type classifier, Plaid sign
normalisation, token encryption, SnapTrade request signing and holdings
mapping, fixture-based net-worth aggregation against the real household's
shape, and the HTTP endpoint end to end (auth, 405 on GET, rate limiting,
`tools/list`).

## License

MIT — see [LICENSE](LICENSE). Provided as is, with no warranty. You are
responsible for your own credentials and for complying with the terms of every
data provider you connect.
