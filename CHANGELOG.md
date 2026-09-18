# Changelog

Notable changes. This project uses [semantic versioning](https://semver.org);
until 1.0 the database schema may change between minor versions, though
migrations are idempotent and run on boot.

## Unreleased

### Added
- **Demo mode** (`npm run demo`) — a fictional household so the app can be
  evaluated without Plaid Production access.
- **Built-in assistant** (optional, off by default) — a chat page answering from
  your accounts through the same read-only tools MCP exposes, with Anthropic and
  OpenAI-compatible providers.
- **Merchants tab** — every merchant, its category, which cards paid it, and
  expenses by category as a chart plus a table.
- **Transactions workspace** — filter by date, account, category, profile,
  direction, amount and free text; group by merchant or category; correct a
  merchant or category inline.
- **Hand corrections** — merchant rules, per-transaction overrides, account
  currency overrides and user-defined categories, applied on read so a nightly
  sync never undoes them.
- **`get_financial_summary`** — the whole picture in one call, with a `sections`
  list to narrow it.
- **`get_activities`** — brokerage dividends, buys, sells, fees and
  contributions.
- **Statement PDFs** (`list_statements`, `get_statement`) — fetched on demand
  and never written to disk. Off by default; Plaid's coverage is thin outside
  large US banks.
- **Credit limits and utilisation**, from Plaid's `balances.limit`.
- **Profiles** — up to five, each with its own provider credentials, which is
  how a household exceeds one Plaid team's Item cap.
- **OAuth 2.1 for `/mcp`** — dynamic client registration and mandatory PKCE,
  replacing the secret-in-URL route (still available behind
  `MCP_ALLOW_PATH_SECRET` until you turn it off).
- **Web UI** — overview with charts, Plaid Link, encrypted credentials, TOTP.

### Fixed
- Net-worth history no longer records a $0 day when nothing is linked, which
  drew as a fall to zero and a same-day recovery.
- Corrections reach `get_cashflow`, and the transfer exclusion runs after them.
- The per-profile Plaid Item allowance is reported as such, rather than as one
  pool that looks over its cap.
- An unreadable sync timestamp reads as stale rather than fresh.

[Unreleased]: https://github.com/yrameshk26/Tally/commits/main
