# Project reference

How the system is built. Behaviour per feature is in [`FEATURES.md`](FEATURES.md);
the reasons behind choices are in [`DECISIONS.md`](../../DECISIONS.md). Everything
named in backticks in sections 3, 4, 8, 9 and 10 is checked against the code by
`test/context-docs.test.ts`, so this file cannot silently fall behind.

## 1. Purpose and shape

- **Tally** (package `tally`, historically `finmcp`) is a personal, read-only
  net-worth and spending server for one household. One process, one SQLite file,
  one admin who signs in. "Profiles" (up to 5) are buckets within the household
  and also separate sets of provider credentials, not separate users.
- **Why it exists:** no bank offers an MCP server and there is no free MCP
  connector for personal finance, so questions such as "how much did we spend on
  groceries last month" cannot be asked of an AI. Plaid cannot be called directly
  by an individual without developer access, so Tally wraps it (Plaid Trial plan,
  production environment), uses SnapTrade for brokerages and Wise for
  multi-currency balances, and exposes one tool surface over MCP.
- **Primary surface is MCP** (any MCP client, not only Claude). The **web UI** is
  secondary but complete enough to stand alone, and an optional **built-in
  assistant** (the owner's own LLM key) answers from the same tools.
- **Read-only, permanently.** No code path may place an order, move money or
  change anything at an institution (hard rule 1).
- Base currency is **CAD** (`BASE_CURRENCY`). Assets positive, liabilities negative.
- License MIT. Public repository, public GitHub handle `yrameshk26`.

## 2. Stack

Node >= 22, TypeScript (ESM, strict). Dev runs TypeScript directly with
`node --experimental-strip-types`; the Docker image runs `tsc` output from
`dist/`. Express 5. `@modelcontextprotocol/sdk` (streamable HTTP, **stateless**:
a fresh server and transport per request). `better-sqlite3` (WAL). `plaid` SDK 42.
`snaptrade-typescript-sdk` is installed but SnapTrade Personal keys go through a
signed REST client in `src/sources/snaptrade.ts` (DECISIONS 2026-09-17). `zod` for
tool schemas, `argon2` for the admin password, `vitest` for tests. No UI
framework, no webfonts, no chart library, no inline styles or scripts without a
CSP nonce: pages are server-rendered strings from `src/web/pages.ts`.

## 3. Source map

Every file, one line. `src/` is the server; `scripts/` are command-line tools.

| File | Role |
|---|---|
| `src/index.ts` | Express app: `/health`, `/favicon.svg`, MCP endpoints (`/mcp` OAuth bearer, `/mcp/:secret` legacy), mounts the OAuth and web routers, starts the scheduler |
| `src/mcp.ts` | Thin MCP binding over the tool registry (never holds a capability the registry lacks) |
| `src/tools/registry.ts` | **The tool surface**, declared once and served to MCP and to the built-in assistant |
| `src/config.ts` | The only reader of `process.env` for static config (section 10) |
| `src/db.ts` | SQLite schema (`SCHEMA`), idempotent migrations (`migrate`, `migrateProfiles`), token-encryption migration, `meta` helpers |
| `src/store.ts` | Upserts shared by every source adapter (accounts, holdings, activities, transactions, card details); sign convention and `refineCategory` at write time; pending to posted handover of tags and overrides |
| `src/queries.ts` | Read models: net worth, accounts, holdings, transactions, cashflow, merchant and category rollups, contribution room, `knownCategories`, spending definition (`isTransferLike`, `NOT_SPENDING_CATEGORIES`, `splitTransfers`, `ROLLUP_ROW_LIMIT`) |
| `src/overrides.ts` | Hand corrections applied on read: merchant rules, per-transaction overrides, currency override, user categories (`addCategory` with optional parent), the `corrector` |
| `src/tags.ts` | Tags on transactions: add, remove, set, rename, delete, list |
| `src/report.ts` | `buildPeriodReport` for a month, a year or a tag; `parsePeriod`, `periodBounds` |
| `src/summary.ts` | `get_financial_summary`: composes read models into sections |
| `src/sync.ts` | Orchestrator: FX, then each source per profile; single-flight `runSync`, progress, `failedSources` |
| `src/scheduler.ts` | In-process nightly sync, backup, catch-up for unread Items; appends `sync.log` |
| `src/snapshots.ts` | Net-worth totals and one snapshot row per day per origin |
| `src/backup.ts` | Online SQLite backup (`VACUUM INTO`) and pruning |
| `src/fx.ts` | Bank of Canada Valet rates, `convert()`; the only place currency maths happens |
| `src/profiles.ts` | Create, rename, delete (max 5), move an account, usage |
| `src/settings.ts` | Database-stored settings overriding the environment; secrets encrypted; install-wide keys; `categoryDetail`, `plaidHistoryDays`, `appName` |
| `src/credentials.ts` | Resolved provider credentials per profile and the "test all providers" check |
| `src/brand.ts` | Uploaded logo: raster only, sniffed by magic bytes, stored in the database |
| `src/oauth.ts` | OAuth 2.1 authorization server logic: dynamic client registration, PKCE, codes, token issue, rotation, revocation |
| `src/ratelimit.ts` | In-memory fixed-window limiter (MCP requests, failed sign-ins) |
| `src/link-server.ts` | **Local-only** Plaid Link helper on :8788; deleted from the Docker image |
| `src/auth/admin.ts` | The single household account from the environment |
| `src/auth/password.ts` | Argon2id hashing and verification |
| `src/auth/session.ts` | Server-side sessions: idle and absolute expiry, cookies, CSRF token |
| `src/auth/totp.ts` | TOTP (RFC 6238) implemented in-repo, no dependency |
| `src/sources/plaid.ts` | Plaid: client per profile, link tokens, exchange, balances, `transactionsSync`, liabilities, statements products, Item status, removal, `syncPlaid` |
| `src/sources/plaid-history.ts` | Two-year history: relink handover, account pairing, `finishHandovers` |
| `src/sources/snaptrade.ts` | SnapTrade brokerages: signed REST client, holdings, activities, registered-type totals |
| `src/sources/wise.ts` | Wise balances (standard and savings) across the token's profiles |
| `src/sources/statements.ts` | Plaid statement PDFs fetched on demand, **never persisted** |
| `src/lib/category.ts` | Category logic: Rent/Utilities split, Plaid primaries, the three read modes, family matching, labels |
| `src/lib/taxonomy.ts` | The grouped (Fidelity-style) category list and the Plaid codes that map into it |
| `src/lib/money.ts` | Rounding, dates, `monthStartISO` |
| `src/lib/html.ts` | HTML templating with escaping on by default (`html`, `raw`, `join`, `money`) |
| `src/lib/crypto.ts` | AES-256-GCM at-rest encryption for tokens and secrets |
| `src/lib/logger.ts` | stderr logger that redacts secrets |
| `src/lib/registered.ts` | Maps account names and types to a Canadian registered-account bucket |
| `src/llm/provider.ts` | Assistant providers (Anthropic, OpenAI, OpenRouter, custom OpenAI-compatible), configuration, readiness |
| `src/llm/chat.ts` | The agentic loop over the tool registry |
| `src/llm/store.ts` | Conversation persistence |
| `src/web/routes.ts` | All authenticated web routes, security headers, CSRF, page rendering glue |
| `src/web/pages.ts` | Every page's HTML (Overview, Transactions, Merchants, Reports, Assistant, Connections, Profiles, Settings, Security) |
| `src/web/layout.ts` | App shell, the one stylesheet (as tokens), theme switch, idle and confirm scripts, footer |
| `src/web/oauth.ts` | OAuth endpoints and sign-in pages; `originOf`, `plaidRedirectFor`, `safeNext` |
| `src/web/charts.ts` | Server-rendered SVG charts and the table-view and tooltip runtime |
| `src/web/markdown.ts` | The assistant's Markdown renderer (escape first; never a library) |
| `src/web/icons.ts` | Hand-drawn interface icons |
| `src/web/logo.ts` | The built-in tally mark and favicon |
| `scripts/db-init.ts` | Create the database and seed room limits |
| `scripts/sync.ts` | One-shot sync; non-zero exit if a source failed |
| `scripts/backup.ts` | Manual backup |
| `scripts/hash-password.ts` | Generates `ADMIN_PASSWORD_HASH` (12 character minimum) |
| `scripts/demo.ts` | Seeds a fully fictional household database; no network |

## 4. Data model

SQLite, one file (`DB_PATH`, default `data/finmcp.db`; `/data/finmcp.db` in the
image). Schema in `SCHEMA`; columns added later are in `migrate()` and
`migrateProfiles()`, all idempotent and run on boot. Money columns come in a
native currency (`amount`) and CAD (`amount_cad`).

| Table | Holds | Notes |
|---|---|---|
| `profiles` | id, name, position | Default profile id `me`; max 5 |
| `accounts` | one row per account, any source | Ids are source-prefixed (`plaid:<account_id>`). `profile_id` is attribution (movable by hand and survives re-sync); `source_profile_id` is which credentials own it. Added by migration: `profile_id`, `source_profile_id`, `available`, `credit_limit`, `currency_override`. `active=0`/`status='removed'` instead of delete |
| `holdings` | positions per account | Refreshed wholesale each sync |
| `transactions` | bank and card rows | **Stored Plaid-style: positive = money out**; negated on read. `category` (primary, with Rent/Utilities already split) and `category_detailed` (raw Plaid detailed code) are the bank's, never rewritten by corrections |
| `activities` | brokerage dividends, buys, sells, fees, contributions | Signed as the brokerage reports |
| `fx_rates` | `<CCY>CAD` pairs | From Bank of Canada |
| `snapshots` | daily net worth totals | Unique per day per `origin` (`sync`, `demo`, backfill) |
| `plaid_items` | one row per linked bank | `access_token` encrypted. Added by migration: `profile_id`, `consent_expiration`, `institution_products`, `history_days`, `replaces_item_id`, `history_status`, `history_checked_at`. Cap 10 per profile (`PLAID_ITEM_CAP`) |
| `card_details` | statement balance, minimum, due date, APR | From Plaid liabilities |
| `room` | RRSP/TFSA limits and manual contributions | Seeded from `room.json` (gitignored; see `room.example.json`) |
| `sync_runs` | each sync's report JSON | `/health` and `sync_report` read the latest |
| `settings` | provider credentials and install settings per profile | Secrets encrypted; DB wins over environment |
| `auth` | admin state keyed by name (the TOTP secret once enrolled) | |
| `sessions` | browser sessions | Two clocks: idle and absolute (7 days); `pending` while awaiting TOTP |
| `oauth_clients` | dynamically registered MCP clients | |
| `oauth_codes` | one-time authorization codes (PKCE S256) | |
| `oauth_tokens` | hashed access and refresh tokens | Raw tokens never stored |
| `tx_overrides` | per-transaction merchant, category, note | The note is MCP-only and not shown in the UI |
| `tx_tags` | tag per transaction | `COLLATE NOCASE`; primary key (transaction, tag) |
| `merchant_rules` | rewrite rules | `match_type` contains, prefix, exact or merchant; ordered by `position`, first match wins |
| `categories` | user-defined categories | A subcategory is its parent's code plus a suffix (`INCOME_RENT`) |
| `chats` | assistant conversations | |
| `chat_messages` | every turn including tool calls | The only record of what was sent to the LLM provider |
| `meta` | small key-value (`getMeta`, `setMeta`) | |
| `brand_assets` | the uploaded logo (blob, mime, hash) | |

## 5. Core flows

**Sync** (`runSync`, single-flight). FX first; then for each profile, SnapTrade,
Plaid and Wise independently (one failing never aborts the others); then a
net-worth snapshot and a `sync_runs` row. The nightly job (`CRON_HOUR:CRON_MINUTE`
local, default 04:15) also writes a backup and appends `sync.log`. The web
Refresh and MCP `sync_now` call the same function. A first run with brokerage
activity can take many minutes; MCP tool calls time out at 60 s while the run
continues in the background.

**Plaid per Item** (`syncPlaid`): look up what the institution offers; balances
into accounts; `transactionsSync` loop with a persisted cursor (added, modified,
removed); liabilities into `card_details`; accounts missing from a healthy run
are deactivated, accounts under a failed Item are left active. A replacement Item
(two-year relink) is probed first and left unread until Plaid reports
`HISTORICAL_UPDATE_COMPLETE`, then the old Item is removed at Plaid, and
`handOver` moves tags, overrides and account settings (section 6 of
`FEATURES.md`). `finishHandovers` runs at the end of every Plaid sync.

**Reading a transaction** (`corrector`, applied in `getTransactions`,
`getCashflow` and everything built on them): stored `category` and
`category_detailed` give the bank's category per the install's `CATEGORY_DETAIL`
mode (`broad` keeps the primary; `detailed` and `grouped` use the detailed code
when it is a well-formed code in a known family); then a per-transaction override
if there is one, otherwise the first matching merchant rule; then, in `grouped`
mode only, `toGrouped` maps the result into the grouped list. Switching mode
rewrites nothing.

**What counts as spending** (hard rule 12): after corrections, a row whose
category is in a transfer or loan-payment family (`TRANSFER_IN`, `TRANSFER_OUT`,
`LOAN_PAYMENTS`, including detailed codes under them) is neither income nor
spending. Everything else is income if money came in and spending if it went out.
Totals, the report, Merchants, `get_spend_by_merchant` and tags all share this.
So a **mortgage payment is hidden by default** (Plaid files it as
`LOAN_PAYMENTS_MORTGAGE_PAYMENT`); filing it under a category of your own
(`HOME_MORTGAGE`, made with `add_category`, parent `HOME`) counts it as spending.

**Signs and money.** Stored positive = out; read negative = out. Liabilities are
stored negative in `accounts.balance`. Every conversion goes through `src/fx.ts`;
a missing rate is reported, never passed off as CAD.

**Pending to posted.** Plaid gives a posted charge a new id and names the pending
one (`pending_transaction_id`, carried as `replaces`). `upsertTransactions` moves
the pending row's tags and, if the posted row has none, its override.

## 6. Security model (summary; `SECURITY.md` and `docs/SETUP.md` are fuller)

- Admin identity from the environment (`ADMIN_USERNAME`, Argon2id hash); optional
  TOTP; server-side sessions with idle (`SESSION_IDLE_MINUTES`, default 30) and
  absolute (7 days, no sliding) expiry; a heartbeat (`POST /session/ping`) keeps a
  tab being read alive.
- CSRF token on every state-changing web route (`_csrf` field or
  `x-csrf-token`); failed-sign-in limiter per IP; MCP rate limit per IP.
- CSP `default-src 'none'` with per-response nonces, `frame-ancestors 'none'`,
  `nosniff`, `Referrer-Policy: no-referrer`. No inline handlers (a test checks).
- Provider secrets and Plaid access tokens are encrypted at rest with
  `TOKEN_ENC_KEY`; logs redact secrets; statements are never persisted.
- MCP auth is OAuth 2.1 (`/mcp`, bearer token, PKCE mandatory, dynamic client
  registration); the legacy `/mcp/<MCP_SECRET>` path stays until
  `MCP_ALLOW_PATH_SECRET=false`. A wrong secret returns 404, not 401.
- Uploaded logos are raster only (never SVG), served sandboxed.
- Every absolute URL is built by `originOf(req)` (first `X-Forwarded-Proto`
  entry); behind a proxy `TRUST_PROXY` must be the number of hops.

## 7. Deployment topology (generic; the live values are not in the repo)

Docker image (multi-stage, non-root, `tini`, `HEALTHCHECK` on `/health`); the Plaid
Link helper is stripped from it. A `/data` volume holds the database, `sync.log`
and `backups/`. The owner runs it on their own server behind Traefik via Dokploy,
with **autoDeploy on every push to `main`**, so a push is a deploy. Details for
setting up your own: [`DEPLOY.md`](../../DEPLOY.md).

## 8. MCP tools

All declared in `src/tools/registry.ts`. Marked **W** if it writes to Tally's own
database (never to an institution). The full descriptions the model sees are in
the registry; the user-facing table is in `README.md`.

| Tool | | Purpose |
|---|---|---|
| `get_net_worth` | | Totals, with breakdowns by profile and registered type |
| `get_net_worth_history` | | Daily snapshot series |
| `list_accounts` | | Every account with balance, type, profile, card limit and utilisation |
| `get_holdings` | | Positions, optionally by account |
| `get_transactions` | | Bank and card transactions; filters incl. `tag`, `untagged`; rows carry `tags` |
| `get_cashflow` | | Income and spend by month, category (`by_category`, `by_category_group`), merchant, profile; `tag`, `untagged` |
| `get_period_report` | | A month, a year, or a tag (`period: "tag"`) summarised |
| `get_financial_summary` | | Everything in one call, `sections` to narrow |
| `get_activities` | | Brokerage dividends, trades, fees, contributions |
| `get_contribution_room` | | RRSP/TFSA room with detection reported separately |
| `set_contributed` | W | Manual contribution amount |
| `set_room_limit` | W | Annual limit |
| `list_profiles` | | Profiles and their usage |
| `create_profile` | W | Add a profile (max 5) |
| `rename_profile` | W | |
| `delete_profile` | W | Refused while any account or linked bank still points at it, and for the default profile `me` |
| `move_account` | W | Attribute an account to another profile |
| `get_spend_by_merchant` | | Rollup by merchant or category over the whole window |
| `set_transaction_category` | W | Per-transaction merchant, category, note |
| `list_tags` | | Tags with count, first and last date, spend |
| `tag_transactions` | W | Add or remove a tag by ids or a date range (skips transfers) |
| `rename_tag` | W | Rename or merge |
| `delete_tag` | W | Remove from everything |
| `set_merchant_rule` | W | Rewrite merchant and category for a pattern, past and future |
| `list_merchant_rules` | | Rules with how many rows each touches |
| `delete_merchant_rule` | W | |
| `set_merchant_category` | W | File a merchant (exact-match rule, hard rule 7) |
| `list_categories` | | All categories in use and offered, and the mode |
| `add_category` | W | Own category, optionally under a `parent` |
| `delete_category` | W | |
| `set_account_currency` | W | Currency override for an account |
| `plaid_status` | | Item health and per-profile allowance, with each Item's history |
| `plaid_relink_url` | | Update-mode link token for a broken Item (used with the local helper) |
| `list_statements` | | Plaid statements (off by default) |
| `get_statement` | | One statement, streamed, never stored |
| `sync_now` | W | Start or join a sync |
| `sync_report` | | Last sync with `age_hours` and `stale` |
| `backup_now` | W | Write a backup file |
| `fx_rates` | | Current rates |

## 9. Web routes

Everything below needs a session except the sign-in pages, `GET /brand/logo`,
`/health` and `/favicon.svg`. State-changing routes are POST with CSRF.

| Page | Routes |
|---|---|
| Sign in | `GET /login`, `POST /login`, `GET/POST /login/verify`, `GET /login/cancel`, `POST /logout`, `POST /session/ping` |
| Overview | `GET /`, `POST /sync`, `GET /sync/status`, `POST /accounts/currency`, `POST /accounts/move` |
| Transactions | `GET /transactions`, `POST /transactions/override`, `POST /transactions/tags`, `POST /transactions/rule`, `POST /transactions/rule/delete` |
| Merchants | `GET /merchants`, `POST /merchants/category`, `POST /merchants/category/bulk`, `POST /categories`, `POST /categories/delete` |
| Reports | `GET /report` (`period` month, year or tag) |
| Assistant | `GET /chat`, `GET /chat/:id`, `POST /chat`, `POST /chat/delete` |
| Connections | `GET /connections`, `GET /connections/oauth`, `POST /connections/remove`, `POST /api/plaid/link-token`, `POST /api/plaid/relink`, `POST /api/plaid/history-token`, `POST /api/plaid/exchange` |
| Profiles | `GET /profiles`, `POST /profiles`, `POST /profiles/rename`, `POST /profiles/delete` |
| Settings | `GET /settings`, `POST /settings`, `POST /settings/test`, `POST /settings/logo` (raw upload), `POST /settings/logo/delete` |
| Security | `GET /security`, `POST /security/totp/start`, `/confirm`, `/disable`, `POST /security/sessions/revoke`, `POST /security/apps/revoke`, `POST /security/connector` (reveals the connector URL and legacy secret only on an explicit POST) |
| OAuth (MCP) | discovery documents under `/.well-known/`, `POST /oauth/register`, `/oauth/authorize`, `/oauth/token`, `/oauth/revoke` |

The form parser is configured for a full page of ticked rows (256 KB,
3000 fields) because bulk tagging posts one field per transaction.

## 10. Configuration

**Environment** (parsed only in `src/config.ts`; `.env.example` is the annotated
template). Defaults in parentheses.

| Group | Variables |
|---|---|
| Server | `PORT` (8787), `MCP_SECRET` (required, 24+ chars), `DB_PATH`, `MCP_RATE_LIMIT` (60/min), `MCP_ALLOW_PATH_SECRET` (true), `TRUST_PROXY` (0), `LOG_LEVEL`, `BASE_CURRENCY` (CAD), `DEFAULT_OWNER` (me) |
| Schedule | `CRON_ENABLED` (true), `CRON_HOUR` (4), `CRON_MINUTE` (15), `BACKUP_KEEP_DAYS` (14) |
| SnapTrade | `SNAPTRADE_CLIENT_ID`, `SNAPTRADE_CONSUMER_KEY`, `SNAPTRADE_TRANSPORT` (rest), `SNAPTRADE_USER_ID`, `SNAPTRADE_USER_SECRET`, `EXCLUDE_SNAPTRADE_CARDS` (true), `SNAPTRADE_BALANCE_HISTORY` (false), `SNAPTRADE_BASE_URL` |
| Plaid | `PLAID_CLIENT_ID`, `PLAID_SECRET`, `PLAID_ENV` (production), `PLAID_PRODUCTS` (transactions), `PLAID_OPTIONAL_PRODUCTS` (liabilities), `PLAID_COUNTRY_CODES` (US,CA), `PLAID_LINK_PORT` (8788), `PLAID_REDIRECT_URI`, `PLAID_STATEMENT_MONTHS` (24) |
| Wise | `WISE_API_TOKEN`, `WISE_API_BASE` |
| Assistant | `LLM_PROVIDER` (anthropic), `LLM_API_KEY`, `LLM_MODEL`, `LLM_BASE_URL`, `LLM_MAX_STEPS` (8), `LLM_TIMEOUT_MS` (120000) |
| Web UI | `UI_ENABLED` (false), `ADMIN_USERNAME`, `ADMIN_PASSWORD_HASH`, `COOKIE_SECURE`, `LOGIN_RATE_LIMIT` (10/15 min), `SESSION_IDLE_MINUTES` (30; 0 off) |
| Crypto | `TOKEN_ENC_KEY` (required to store secrets or encrypt tokens) |

**Managed settings** (`MANAGED_KEYS` in `src/settings.ts`, editable on the
Settings page; the database wins over the environment; the environment fallback
applies to the default profile only). Install-wide keys are stored on the default
profile and offered only there.

| Key | Scope | Meaning |
|---|---|---|
| `SNAPTRADE_CLIENT_ID`, `SNAPTRADE_CONSUMER_KEY` (secret), `SNAPTRADE_TRANSPORT` | per profile | Brokerage credentials |
| `PLAID_CLIENT_ID`, `PLAID_SECRET` (secret), `PLAID_ENV` | per profile | Bank credentials (each profile is its own Plaid team) |
| `WISE_API_TOKEN` (secret) | per profile | |
| `LLM_PROVIDER`, `LLM_API_KEY` (secret), `LLM_MODEL`, `LLM_BASE_URL` | install | Built-in assistant; off until a key is set |
| `APP_NAME` | install | What the UI calls itself (default `tally`); display only |
| `CATEGORY_DETAIL` | install | `grouped` (default), `detailed` or `broad` |
| `PLAID_TRANSACTION_DAYS` | install | Days of history for **newly linked** banks, 30 to 730; unset is Plaid's 90 |

Also read from the environment outside `src/config.ts`: `DEMO_FORCE` (lets
`scripts/demo.ts` overwrite an existing demo database).
