# Feature inventory

What exists, how it behaves, where it lives, and which test pins it. For the
system around these (tables, routes, config) see [`PROJECT.md`](PROJECT.md); for
why, see [`DECISIONS.md`](../../DECISIONS.md). Dates are when it shipped.

## 1. The MCP read model (from day one, 2026-09-17/18)

- **Net worth and history:** `get_net_worth` (by profile and registered type),
  `get_net_worth_history` from daily snapshots. A day with nothing linked is never
  recorded as a $0 day (`pruneEmptySnapshots`).
- **Accounts, holdings, activities:** `list_accounts` (cards carry statement
  balance, minimum, due date, limit, utilisation), `get_holdings` (optionally by
  account, invested value versus balance, concentration), `get_activities`
  (dividends, buys, sells, fees, contributions).
- **Contribution room:** `get_contribution_room`, `set_contributed`,
  `set_room_limit`. Detection from brokerage activity and from bank transfers that
  look like a brokerage top-up is **reported separately and never guessed**
  (DECISIONS 2026-09-17).
- **One-call picture:** `get_financial_summary` with a `sections` list
  (`src/summary.ts`; `test/summary.test.ts` pins that omitting sections really
  omits them).
- **Freshness:** `sync_report` returns `age_hours` and `stale`, so a model can say
  how old the numbers are before answering.
- Tests: `test/networth.test.ts` (invented but uneven fixtures so a sign flip or
  double count is obviously wrong), `test/server.test.ts` (tool list is pinned and
  must contain nothing that can move money), `test/plaid-signs.test.ts`.

## 2. Sources

- **Plaid** (`src/sources/plaid.ts`): banks and cards. Products `transactions`
  (required), `liabilities` (optional), `statements` (optional, off by default).
  Link happens either in the local helper (`npm run link`, `src/link-server.ts`) or
  in the web UI (Connections). Update mode repairs a login. OAuth banks return to
  `/connections/oauth`. Hard rules 2 and 3 describe two painful lessons about
  products and link-token shapes; read them before touching link tokens.
- **SnapTrade** (`src/sources/snaptrade.ts`): brokerages via a signed REST client
  that omits `userId`/`userSecret` for Personal keys. Closed accounts are excluded;
  `EXCLUDE_SNAPTRADE_CARDS` deactivates card rows so Plaid owns cards. USD
  positions convert to CAD; options are priced at 100 shares. Managed portfolios
  report a balance without positions, so invested value can sit below net worth.
- **Wise** (`src/sources/wise.ts`): standard balances and savings jars across the
  token's profiles, named `Wise <CCY> (personal|business)`.
- **Never scrape** Wealthsimple or anything else (hard rule 16).

## 3. Profiles

Up to five. Each has its own provider credentials (which is how a household gets
past one Plaid team's 10-Item cap) and is also an attribution bucket. An account's
`profile_id` can be moved by hand and survives re-sync; `source_profile_id` stays
with the credentials. Deleting a profile is refused while anything points at it.
Tests: `test/profiles.test.ts`, `test/migration.test.ts` (built against a
pre-profiles schema filled like the live database).

## 4. Web UI shell

- **Sign-in:** username plus Argon2id password, optional TOTP, server-side
  sessions, "sign out everywhere", failure-only rate limit. Idle sign-out after
  `SESSION_IDLE_MINUTES` (default 30) with an on-screen sign-out and a heartbeat;
  absolute 7 days. Tests: `test/auth.test.ts`, `test/session.test.ts`, `test/web.test.ts`.
- **Layout** (`src/web/layout.ts`, 2026-09-25 revamp): sidebar app shell with
  groups Money (Overview, Transactions, Merchants, Reports), Ask (Assistant),
  Manage (Connections, Profiles, Settings, Security); top bar on mobile. OKLCH
  tokens, container queries for the KPI figures, `:has()` for form state, view
  transitions. **Theme**: light, dark or system via `data-theme` on `<html>`,
  stored per browser in `localStorage` (`tally-theme`), applied from `<head>`
  before paint. Print CSS forces the light theme.
- **Icons** are hand-drawn (`src/web/icons.ts`), no icon-set licence to track.
- **App name** is an install-wide display setting (`APP_NAME`); the MCP server,
  cookies and code stay "tally", and the footer keeps crediting the project.
  Tests: `test/appearance.test.ts`.
- **Custom logo** (`src/brand.ts`): PNG, JPEG or WebP up to 256 KB identified by
  magic bytes, never SVG; uploaded as a raw body from Settings; served at
  `/brand/logo?v=<hash>` sandboxed. Tests: `test/brand.test.ts`.
- **Themed dialogs** (2026-09-30): every confirmation uses the shell's own
  `<dialog>` via `tallyConfirm()` and `form[data-confirm]`; the browser's
  `confirm`/`alert`/`prompt` are banned and a test greps the source for them.
  Destructive confirmations are red with Cancel focused; Esc and a click outside
  cancel; message text is set with `textContent`.
- **No inline handlers or styles**; the CSP uses per-response nonces. A shared test
  helper (`test/helpers.ts`, `inlineHandlers`) asserts it on rendered pages.

## 5. Overview

KPI hero (net worth with change and span), assets, liabilities, invested; net
worth over time; allocation by registered type; largest holdings; income versus
spend; by registered type and by profile; cards and loans with due dates;
accounts (profile and currency editable inline); holdings. Charts are
server-rendered SVG (`src/web/charts.ts`) with a "table view" under each.
**Refresh now** starts a sync and returns at once (hard rule 13); the Overview
shows a progress banner and polls `GET /sync/status`, then reloads every widget.
Currency overrides exist because some accounts report in a currency that is not
what the balance is in.

## 6. Transactions

- Filters in the query string (a view is a bookmarkable URL): dates (default
  **month to date**), search, account, category, profile, tag, direction, minimum,
  transfers shown or hidden, group by merchant or category. Up to 1,000 rows per
  page, and the page says when it truncated.
- **Transfers and card or loan payments are hidden by default** so paying a card
  is not counted on top of its purchases; the page says how many are hidden and
  links to show them (DECISIONS 2026-09-23). Asking for a transfer category by
  name steps the filter aside.
- Each row can be edited in place: merchant, category (grouped picker) and tags.
  "Apply to all" turns a merchant rename and category into a rule.
- **Tag selected / Untag selected** with a checkbox per row (see section 11).
- Merchant rules table with how many rows each touches and a delete button.
- Tests: `test/overrides.test.ts`, `test/web.test.ts`.

## 7. Merchants

Every merchant seen, its category, which cards paid it, first and last seen; opens
on month to date. Categories are set per merchant from a picker (an exact-match
`merchant` rule, hard rule 7) or in bulk by ticking merchants and choosing a
category (an explicit choice is required, with an "Uncategorised" option as a
sentinel, so a blank can never mean "clear everything"). Filter by category or to
uncategorised only. Above the table: expenses by category (chart and table with
share). Transfers and card payments are excluded and counted in a note that links
to them. "Your categories" adds categories of your own, optionally under a parent.
Two earlier bugs worth knowing: card payments were once counted as spending here
(twice), and the directory once read only the newest 1,000 rows; both fixed with
tests that fail on the old code (DECISIONS 2026-09-25).

## 8. Corrections (always applied on read, so a sync never undoes them)

Precedence: per-transaction override, then the first matching merchant rule by
`position` then id, then the bank's value. Match types: `merchant` (exact
directory key; what the UI's filing uses), `exact`, `prefix`, `contains` (for
deliberately merging misspellings). Also: per-account currency override and user
categories. Rules see the raw bank text, so a renamed merchant cannot be matched
by a new rule on its new name; `setMerchantCategory` updates the rule that
produced the name instead. `src/overrides.ts`; `test/overrides.test.ts`.

## 9. Categories

- **Rent and utilities split** (2026-09-26): Plaid's combined `RENT_AND_UTILITIES`
  is stored as `RENT` or `UTILITIES` using its detailed code, at write time
  (`refineCategory` in `src/store.ts`) and once, by migration, for stored rows. A
  row with no detailed code keeps the combined label rather than being guessed.
- **Three read modes** (`CATEGORY_DETAIL`, Settings → Appearance), chosen on read:
  - `grouped` (default since 2026-09-28): a budgeting list modelled on a
    Fidelity-style taxonomy, 18 parents (Auto and transport, Bills and utilities,
    Business and services, Cash and ATM, Charity and gifts, Education,
    Entertainment, Family care, Fees and charges, Food, Home, Insurance premiums,
    Medical, Personal care, Pets, Shopping, Taxes, Travel and vacation) with
    subcategories, in `src/lib/taxonomy.ts`. Every spending code Plaid sends maps
    to one entry; entries Plaid cannot fill (insurance kinds, pet grooming, condo
    fees, fun money, cash and ATM) exist to be chosen by hand. Income, transfers
    and loan or card payments keep Plaid's names. Only codes the table knows move.
  - `detailed` (2026-09-27): Plaid's detailed code as sent (Groceries, Coffee,
    Fuel...).
  - `broad`: Plaid's sixteen primaries (Food and drink, Transportation...).
  All three give identical totals (`test/category.test.ts` pins it).
- **Families:** a category belongs to a family by its code prefix (`FOOD_GROCERIES`
  is in `FOOD`; `HOME_IMPROVEMENT_HARDWARE` is Plaid's `HOME_IMPROVEMENT`, not
  `HOME`; longest match wins). Filtering by a parent matches its members, in the
  UI and in MCP, and a filter written in Plaid's terms is translated in grouped
  mode. `get_cashflow` returns `by_category` and `by_category_group`.
- **Labels** (`categoryLabel`): drop the repeated parent ("Groceries"), keep
  direction for transfers ("Transfer out: account transfer"), `TRANSPORTATION_GAS`
  reads "Fuel". Pickers group members in `<optgroup>`; filters add "All food".
- **Subcategories of your own** (2026-10-01): `add_category` / the "Under" picker
  stores `PARENT_NAME` (Rent under Income is `INCOME_RENT`, shown "Income › Rent").
  A name that would spell another family is refused. Whether a row is income or
  spending still follows the direction of the money, so a deposit filed as
  Income › Rent counts as income.

## 10. What counts as spending

One definition (hard rule 12): after corrections, a row in a transfer or loan
payment family is neither income nor spending, in cashflow, the Transactions
totals, the report, Merchants, `get_spend_by_merchant` and tags alike. Rollups
read their whole window (`ROLLUP_ROW_LIMIT`, 50,000), never a page.
**Consequence worth knowing:** a mortgage payment is hidden by default, because
Plaid files it as `LOAN_PAYMENTS_MORTGAGE_PAYMENT`. To count it, file it under a
category of your own such as `HOME_MORTGAGE` (parent Home); exclusion is decided
after corrections, so the rule takes effect everywhere at once. Whether it should
count by default is an open decision (see `BACKLOG.md`).

## 11. Tags (2026-09-29, checkboxes 2026-10-01)

A free-text label on top of a category: a trip ("Italy 2026"), business spending
on a personal card. Untagged is the ordinary case. Names compare without case and
keep the first spelling; at most 40 characters; no commas.

- **Tagging:** on Transactions, set dates and card; every row starts ticked;
  untick the exceptions; **Tag selected** or **Untag selected** (disabled when
  none are ticked; a live count; a header box selects or clears all). A single
  row's field replaces that row's tags (comma list). The POST carries the ticked
  ids, so a row can be left out; parser limits were raised so 1,000 ticked rows
  are not truncated.
- **Viewing:** a Tag filter (one tag, or "Untagged only" = the ordinary month with
  trips and business set aside), tag chips that link to the tag's report,
  `get_cashflow`/`get_transactions` with `tag` or `untagged`.
- **Report:** Reports → Tag, or `get_period_report` with `period: "tag"`: spending
  by category, merchant and month over the tag's first to last date, however many
  months. No net worth (a tag is a slice of spending).
- **Never changes a total** or what counts as spending. Bulk tagging a range over
  MCP skips transfers and card payments.
- **Pending to posted:** the posted charge inherits tags (and an override) from
  its pending row (`replaces`). Removing a transaction removes its tags.
- Tests: `test/tags.test.ts`, `test/web.test.ts` (incl. a 1,000-row post).

## 12. Reports

One calendar month or year (Month and Year selects) or one tag: net worth at each
end and the change (from the daily snapshots; a period nobody measured says so
rather than reporting zero), income, spending, net saved and savings rate,
income and spending by month (year, or a tag crossing a month), spending by
category with share, top merchants, ten largest expenses, and a footnote stating
what was excluded (out and in separately, never added: both sides of a transfer
are the same money). "Save as PDF" is the browser's print dialog with a print
stylesheet (DECISIONS 2026-09-23). Defaults to the last complete month. Figures
come from `getCashflow` unchanged. Tests: `test/report.test.ts`. The owner said
the Reports screen will be revisited later.

## 13. Two years of history and the handover (2026-09-30)

Plaid fixes how much history an Item gets when it is linked (90 days by default,
730 at most) and never changes it. Before this, `PLAID_TRANSACTION_DAYS` was
documented but never sent, so every Item had 90 days. Now:

- New links send `days_requested` from `PLAID_TRANSACTION_DAYS` (unset = 90).
- On Connections each bank shows its history and, under two years, a **Get 2 years
  of history** button that links the same bank again with 730 days. Choosing a
  different bank in Link, another profile's connection, or one already mid-handover
  is never treated as a replacement. It needs one free Item slot (10 per profile)
  while both exist.
- The replacement is saved with `replaces_item_id` and **not read at all** until a
  probe shows Plaid's `HISTORICAL_UPDATE_COMPLETE` (or three days of an unknown
  status). Each sync records Plaid's status (`history_status`) and Connections
  shows it in words. Then the old Item is removed at Plaid (a refusal changes
  nothing locally), the new one's accounts and history are stored, and
  `handOver` runs: old accounts pair with new by last four digits and type, then by
  name when two cards share a last four (Amex does); only unambiguous pairs. Per
  old transaction: a matching new one (same day and amount and bank text, else
  within three days on amount alone, each claimed once) receives the old tags and
  override and the old row is removed; rows older than the new history are moved to
  the new account. Profile and currency override carry over.
- `finishHandovers` runs at the end of every Plaid sync: a removed connection whose
  accounts still hold transactions is handed to the one live connection of the same
  bank on that profile. It pairs only what it can, so it is safe every run, and it
  also mends the double count left by disconnecting a bank and adding it by hand.
- Live lesson (2026-09-30): the first handovers left two same-last-four Amex
  business cards unpaired and their old rows counted twice (a quarter's spending read
  materially too high) until name pairing and `finishHandovers` shipped.
- Tests: `test/plaid-history.test.ts` (pairing, handover, the sync with a stubbed
  Plaid API, relink guards, the Connections rendering), `test/statements.test.ts`
  (update-mode tokens never carry `days_requested`).

## 14. Connections, Profiles, Settings, Security

- **Connections:** Plaid Link in the browser, Item health with Repair (update
  mode) and Disconnect (revokes at Plaid; accounts deactivate and keep their
  history, or "purge" deletes them), per-profile allowance, the redirect URI in use
  with a warning when it will not match (http on a real domain behind a
  TLS-terminating proxy), "never synced" and handover status. Plaid's redirect URI
  honours `PLAID_REDIRECT_URI` when its path is `/connections/oauth`, else is built
  from the request (hard rule 14).
- **Profiles:** create, rename, delete (guarded), usage per profile.
- **Settings:** provider credentials per profile (secrets encrypted, never shown
  again), "Test all providers" (one cheap read-only call each), Appearance (app
  name, categories mode), Plaid history days, assistant provider, Logo upload.
  Install-wide keys are only offered on the default profile.
- **Security:** connector URL (the legacy secret is revealed only on an explicit
  POST), authorized MCP apps with revoke, TOTP enrol and disable, active sessions
  and "sign out everywhere".

## 15. Built-in assistant (optional, off by default)

A chat page answering from the same tools MCP exposes (no private capability), over
Anthropic, OpenAI, OpenRouter or any OpenAI-compatible endpoint with the owner's
own key (`LLM_*`, in Settings). Turning it on means the server sends balances and
transactions to that provider on every message; everything else only leaves in
answer to a request the owner's own MCP client made. Replies are rendered by
`src/web/markdown.ts` (escape first, tags only ever emitted there, no raw HTML,
http(s) links only). Transcripts, tool calls included, are stored. Tests:
`test/assistant.test.ts`.

## 16. Demo mode

`npm run demo` (`scripts/demo.ts`) seeds a fully fictional household (balances at
household scale, merchants with detailed Plaid codes, card payments and savings
transfers, a tagged week-long trip, one merchant rule, six months of net worth) and
refuses to run against an existing database unless `DEMO_FORCE` is set. The README
screenshots are generated from it (recipe in `OPERATIONS.md`).

## 17. Operations features

Nightly in-process sync and backup (14 days kept), `sync.log` next to the database,
`/health` (accounts, last sync), a `sync_report` with staleness, idempotent
migrations on boot, an Item that needs attention surfaced in `plaid_status`.
