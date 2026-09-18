# tally

A personal, read-only **net-worth MCP server** for Claude. It aggregates
brokerages, banks, cards and multi-currency balances into one CAD picture and
exposes it to Claude as MCP tools. Ask Claude "how am I doing?" and it answers
from your own accounts.

There is also an optional web UI — sign-in, provider credentials, Plaid Link,
and an overview with charts — but it exists to *run* the server, not to replace
Claude. Everything the UI shows is available as a tool.

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

Start with **`get_financial_summary`** — it answers a broad question in one call
instead of six, and narrows to exactly what you asked for:

```jsonc
// the headline picture
{ }
// everything, two years of it
{ "sections": ["all"], "months": 24 }
// just one thing, for one person
{ "sections": ["cashflow"], "profile": "spouse", "start": "2026-01-01", "end": "2026-06-30" }
```

Its sections: `net_worth`, `profiles`, `accounts`, `cards`, `holdings`,
`holdings_by_account`, `activities`, `cashflow`, `transactions`, `history`,
`contribution_room`, `connections`, `fx`, `sync`. Omit `sections` and you get
the headline set; the response names what it left out so nothing is hidden, and
row sections are capped and say when they truncated.

The narrow tools are still there, and are the right call for a specific
question:

| Tool | Does |
|---|---|
| `get_financial_summary` | The whole picture in one call, `sections` to narrow it |
| `get_net_worth` | Total in CAD, split by profile, registered type, source, institution |
| `get_net_worth_history` | Daily snapshots |
| `list_accounts` | Every account with balance, currency, registered type, profile, card details |
| `get_holdings` | Positions by symbol with concentration % and unrealized P&L, or `by_account` |
| `get_transactions` | Bank and card transactions — negative is money out |
| `get_activities` | Brokerage movements: dividends, interest, buys, sells, fees, contributions |
| `get_cashflow` | Income vs spend by month, category, merchant, profile |
| `get_contribution_room` | Remaining RRSP/TFSA/FHSA room per person |
| `set_contributed`, `set_room_limit` | Correct the room figures by hand |
| `list_profiles`, `create_profile`, `rename_profile`, `delete_profile` | Manage profiles |
| `move_account` | Re-attribute an account to another profile |
| `plaid_status`, `plaid_relink_url` | Item health and one-click repair |
| `sync_now`, `sync_report` | Refresh on demand; tell the user how stale data is |
| `backup_now` | A consistent sqlite snapshot, safe against a live server |
| `fx_rates` | The rates every balance was converted at |

Two conventions worth knowing before reading a number:

- **Assets are positive, liabilities negative** in every balance. In
  `get_transactions` and `get_cashflow` a negative amount means money *left* the
  account; in `get_activities` the brokerage's own sign is kept, so a dividend
  is positive.
- **Invested can sit below balance.** A managed portfolio reports its value
  without breaking out positions, so its money shows up in net worth but not in
  holdings. `get_holdings` with `by_account: true` shows both side by side.

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

## Profiles

Plaid caps Items at **10 per team**, so a single set of credentials means at most
10 linked banks. A profile is both a person or bucket *and* its own set of
provider keys, so five profiles means up to 50.

Two fields keep this honest:

- a connection's **source profile** is fixed — an account cannot be re-homed to
  a different Plaid team without re-linking it, and a sync only ever deactivates
  accounts belonging to the credentials it just used;
- an account's **profile** is attribution, and is movable, so a card linked
  under one profile's Plaid team can still count towards another's net worth.

Sync runs every source once per profile. A profile with no credentials reports
`{skipped}` and costs nothing.

## Web UI (optional)

Off by default — with `UI_ENABLED=false` the server is a bare MCP endpoint with
no login surface at all. Turn it on to onboard credentials and link banks
without copying a database around:

```bash
npm run hash-password          # prints ADMIN_PASSWORD_HASH; the password is never stored
```

```
UI_ENABLED=true
ADMIN_USERNAME=you
ADMIN_PASSWORD_HASH=$argon2id$v=19$m=19456,p=1,t=2$...
TOKEN_ENC_KEY=...              # required: encrypts stored secrets and the TOTP seed
```

Five pages:

- **Overview** — net worth, assets, liabilities and invested; net worth over
  time; allocation by registered type; largest holdings; income vs spend by
  month; cards and loans with limit, utilisation, statement, minimum and due
  date; every account and every position. Each chart has a table view, so no
  number is gated behind a hover.
- **Connections** — Plaid Link to add banks and cards, Item health, one-click
  repair, disconnect.
- **Profiles** — up to 5, each with its own provider credentials; move an
  account between them.
- **Settings** — provider credentials, stored encrypted in the database and
  overriding the environment without a redeploy, with a "test all providers"
  check.
- **Security** — two-factor enrolment, active sessions, authorized MCP clients,
  sign out everywhere.

**Turn on two-factor authentication.** A single password is otherwise the only
thing between the public internet and every balance, transaction and stored
bank token. The Security page walks through it; any authenticator app works.

## Deploying

See [`DEPLOY.md`](DEPLOY.md) — Docker image, Dokploy application, persistent
volume at `/data`, HTTPS domain, and adding the server to Claude.ai as a custom
connector.

## Connecting Claude

With the web UI on, the MCP endpoint is `https://<host>/mcp` — **no secret in
the URL**. Add it as a custom connector; Claude sends you to sign in (password
plus authenticator code) and asks you to allow access. Authorized apps are
listed on the Security page and can be revoked there.

Under the hood it is OAuth 2.1 with dynamic client registration and mandatory
PKCE; tokens are stored only as hashes. The legacy `/mcp/<MCP_SECRET>` route
stays on until you set `MCP_ALLOW_PATH_SECRET=false`.

## Security

Read [SECURITY.md](SECURITY.md) before deploying. The short version:

- Prefer the OAuth endpoint. The legacy secret-in-URL route leaks the way URLs
  leak — including into reverse-proxy access logs — so turn it off once the
  connector has been re-added.
- Set `TRUST_PROXY` to the number of proxy hops in front of the app, or the
  per-IP rate limiter degrades into a single shared bucket.
- Back up `TOKEN_ENC_KEY` somewhere other than the server. Losing it means
  re-linking every bank.
- Report vulnerabilities privately via GitHub Security Advisories, not issues.

## Development

```bash
npm run check      # typecheck + 233 tests
npm test
npm run typecheck
```

Tests cover FX sign and rounding, the registered-type classifier, Plaid sign
normalisation, token encryption, SnapTrade request signing and holdings
mapping, fixture-based net-worth aggregation against the real household's
shape, profiles and the schema migrations, the OAuth authorization server
(PKCE, code replay, token rotation), the rendered pages (escaping, no inline
handlers under the CSP), the summary's section selection, and the HTTP endpoint
end to end (auth, 405 on GET, rate limiting, `tools/list`, a tool call).

## License

MIT — see [LICENSE](LICENSE). Provided as is, with no warranty. You are
responsible for your own credentials and for complying with the terms of every
data provider you connect.
