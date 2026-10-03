# tally (finmcp) — rules

A personal, **read-only** net-worth MCP server for Claude. One household, up to
five profiles. Read `docs/SETUP.md` for provider credentials, the admin password
hash and 2FA; `docs/BUILD_PLAN.md` for the phased plan; `DECISIONS.md` for why
things are the way they are.

**This repository is public.** Nothing committed here may contain a real
balance, account number, contribution-room figure, institution login, API key or
personal domain — not in code, not in docs, not in a test fixture, not in an
example file, **and not in a screenshot**. `docs/screenshots/` is generated from
`npm run demo`, which is entirely fictional; never replace one with a capture of
a live instance. Test fixtures use obviously fake values; `docs/BUILD_PLAN.md` and
`room.example.json` use illustrative ones. Check before you commit, because
history is public too.

## Hard rules

1. **Read-only, permanently.** Never add a tool, endpoint or code path that can
   place an order, transfer money, or change a setting at an institution. Never
   call SnapTrade order endpoints. Plaid products are limited to
   `transactions`, `liabilities` and `statements` — never `auth`, `transfer` or
   `payment`. Statements is read-only and off by default; see rule 3 for the
   only link-token shape Plaid accepts for it.
2. **Institution support is tri-state, and unknown is not no.** Plaid product
   support is per bank; `supportsStatements` returns true/false/null and null
   must still offer the action, because not having checked is not a no. A bank
   that returns false is never called and never told to re-consent — that is a
   limit of the bank, not the setup.
3. **Link tokens are the most fragile surface here; change them carefully.**
   Three shapes have been tried and two broke live flows: `products` in update
   mode kills Link with an opaque "internal error" and takes re-authentication
   with it, and `additional_consented_products` is refused for statements
   outright, which blocked adding *any* bank. Statements rides in
   `optional_products` only, and an existing Item that needs a newly enabled
   product is disconnected and added again. `test/statements.test.ts` pins the
   shape of both link paths — a change here cannot be verified by tests alone,
   so make it behind a setting that is off by default. `days_requested`
   (`transactions`) goes on a new link only, from `PLAID_TRANSACTION_DAYS` or
   the Connections "Get 2 years of history" action; Plaid never changes it for
   an existing Item, so update mode must not carry it.
4. **Assistant output is rendered by `src/web/markdown.ts`, never a library.**
   It renders text from a third-party model built on institution-supplied data.
   Input is escaped *first* and tags are only ever emitted by that file, so
   there is no HTML passthrough to misconfigure — every general-purpose renderer
   has one, a flag away from unsafe. Link schemes other than http(s) are
   refused. Do not swap it for a library, and do not add a raw-HTML escape
   hatch.
5. **Statement PDFs are never persisted.** `src/sources/statements.ts` streams
   them through memory and hands them to the caller. No cache, no temp file, no
   database column, no log of their contents — one file carries the full account
   number, the mailing address and every line item. `test/statements.test.ts`
   asserts this against the source; do not weaken it.
6. **Secrets live in `.env` only.** Never log an access token, consumer key or
   secret. `src/lib/logger.ts` redacts them; do not bypass it. Never commit
   `data/`, `.env` or `room.json`.
7. **Filing a merchant uses `match_type: 'merchant'`, never `contains`.**
   A contains rule for `Amazon` also captures `Amazon Web Services`, so
   assigning a category from the Merchants tab must match the directory's own
   key exactly. `contains` stays the right choice for deliberately merging
   misspellings. `setMerchantCategory` also updates the rule that produced a
   merchant's name rather than adding a second — a renamed merchant cannot be
   matched by a new rule on its new name, since rules see the raw bank text.
8. **Signs.** Assets positive, liabilities negative in `accounts.balance`.
   Transactions are stored Plaid-style (positive = money out) and negated on
   read. If you touch a source adapter, add a sign test.
9. **All FX goes through `src/fx.ts`.** No ad-hoc multiplication by a rate
   anywhere else. Missing rate → report it, never silently pass the native
   number off as CAD.
10. **One household, one process.** No multi-tenant code, no user table, no
   auth framework. One admin signs in; profiles are buckets within that
   household, not separate users. Auth for `/mcp` is OAuth 2.1 (see
   `src/oauth.ts`); the `/mcp/<MCP_SECRET>` path route is legacy and is turned
   off with `MCP_ALLOW_PATH_SECRET=false`.
11. **A browser session dies twice over: idle and absolute.** `getSession`
   enforces both and extends neither, so a session in daily use still ends a
   week after sign-in. The idle window comes from `SESSION_IDLE_MINUTES` (30
   by default, 0 off) and the page shell's heartbeat is what keeps a tab being
   read from looking abandoned — if you change one, change the other, and keep
   the `last_seen_at` write throttle well under the window or a session in
   continuous use will expire early. MCP is not covered by any of this: a
   connector holds an OAuth token, not this cookie, and signing the browser out
   must never break it.
12. **What counts as spending is defined once.** `NOT_SPENDING_CATEGORIES` in
   `src/queries.ts` (transfers in and out, and card/loan payments) is excluded
   by cashflow, the Transactions tab's totals, the period report, the Merchants
   page and `get_spend_by_merchant`, and all of them read categories *after*
   corrections, so a rule that files a row as
   a transfer removes it everywhere at once. A new surface that totals income
   or spending uses `getCashflow` or `isTransferLike`, never its own list:
   paying a card from chequing counted alongside the purchases it paid for is
   the double count this exists to prevent. The report's figures come from
   `getCashflow` unchanged, and `test/report.test.ts` pins that they agree to
   the cent. A detailed category belongs to its primary for this purpose
   (`TRANSFER_OUT_ACCOUNT_TRANSFER` is a transfer), so `isTransferLike` goes
   through `familyOf`, never an exact match, and all three modes must
   give the same totals; `test/category.test.ts` pins that. The mode
   (`CATEGORY_DETAIL`: grouped, detailed or broad) is settled on read in
   `corrector` and never written back: Plaid's detailed or broad code before
   rules and overrides, then, in grouped mode, `toGrouped` after them. The
   grouped list (`src/lib/taxonomy.ts`) never maps an income, transfer or
   payment code. The one deliberate exception is a mortgage payment:
   `countsAsMortgageSpend` (`src/lib/category.ts`) reads Plaid's
   `LOAN_PAYMENTS_MORTGAGE_PAYMENT` as `HOME_MORTGAGE`, which is spending, in
   every mode and before rules and overrides, when money leaves an account that
   is not the mortgage account itself (that account's own side of the payment,
   and any charge on it, stays excluded, so it is counted once). A card has
   purchases to count; a mortgage has nothing else, so excluding it understated
   spending. A rule or override can still file it as a transfer.
   Tags (`src/tags.ts`) narrow a view and never decide what is spending: a
   tagged or untagged cashflow runs the same exclusion, and bulk tagging a
   range skips transfers and card payments. A tag or override on a pending
   charge moves to the posted one through `replaces` (Plaid's
   `pending_transaction_id`) in `upsertTransactions`; a new source adapter that
   has pending rows sets it too. Relinking a bank for more history
   (`src/sources/plaid-history.ts`) must never count both connections: the new
   Item stays unread (no balances, no transactions, not in the catch-up sync)
   until Plaid reports `HISTORICAL_UPDATE_COMPLETE`, and the old one is removed
   at Plaid before anything of the new one is stored. Accounts pair by last
   four and type, then by name when two cards share a last four (American
   Express does), and only when unambiguous. Whatever a handover could not
   pair, and a bank disconnected and re-added by hand, is finished by
   `finishHandovers` at the end of every Plaid sync when exactly one live
   connection of that bank exists on the profile; a disconnect alone keeps
   its accounts' transactions, so without that the overlap counts twice.
   A rollup reads its whole window (`ROLLUP_ROW_LIMIT`), never a page
   of rows: a total over the newest thousand transactions is wrong, not partial.
   The report's PDF is the browser's print dialog, not a PDF library; keep it
   that way (see DECISIONS.md).
13. **One sync at a time, and the web UI never waits on it.** `runSync`
   is single-flight: a second caller (the Refresh button, the nightly job, MCP
   `sync_now`) gets the run already in progress. Start syncs only through it —
   a second path would run every bank twice and race the writes. The web UI
   never awaits it: `POST /sync` starts the run and redirects, and the Overview
   polls `/sync/status`, because a dozen banks take minutes and would outlast
   a proxy timeout. Report failures with `failedSources`, not by looking for
   `error` on the merged per-source entry, which with two profiles is keyed by
   profile and never matches.
14. **Every absolute URL comes from `originOf`.** The Plaid redirect URI, the
   MCP connector URL, the OAuth issuer and the protected-resource metadata are
   all built from `originOf(req)` in `src/web/oauth.ts`, which takes the first
   entry of `X-Forwarded-Proto` (a chain of proxies sends `https, http`) and
   ignores a value that is not a scheme. Five copies of the header read used to
   exist and all took it whole, which built `https, http://host/…` and made
   Plaid refuse Link. Do not read the header anywhere else. The one exception is
   the Plaid redirect: `plaidRedirectFor` prefers `PLAID_REDIRECT_URI` when its
   path is `/connections/oauth`, since what was registered in the dashboard is
   what Plaid accepts, and a built value that differs only fails on the first
   OAuth bank.
15. **An uploaded logo is a raster image, decided by its bytes.** `src/brand.ts`
   accepts PNG, JPEG and WebP only, identified by magic bytes, never by the
   file name or the type the browser claimed; 256 KB at most. Never SVG: it is a
   document that can run script, and opened at its own URL it would run on this
   origin inside a signed-in session. `/brand/logo` is public (the sign-in screen
   needs it) and is served with the sniffed type, `nosniff` and
   `default-src 'none'; sandbox`. Keep all three.
16. **Never scrape.** Wealthsimple's private GraphQL API is off limits;
   SnapTrade only.
17. **After every task:** `npm run typecheck && npm test`. Both must be clean
   before committing. Conventional commits, one per completed task.
18. **Docs ship with the change, in the same commit.** Any new or changed
   feature updates `README.md` and this file before the commit — never "later",
   never a follow-up commit. Concretely:
   - a new or renamed MCP tool → the tool table in README.md
   - a new page, route or UI surface → the Web UI section
   - a new env var or setting → wherever the surrounding vars are documented
   - a new invariant, constraint or rule someone could unknowingly break → a
     hard rule here
   - a new `src/` module → the Layout tree here
   - a changed test count → the Development section
   - any change at all → rule 20 (the agent context)
   The test is whether someone reading only these two files would be surprised
   by the code. If yes, the docs are not done.
19. **The Link helper never deploys.** `src/link-server.ts` runs on the
   developer's machine only. Port 8788 must not be exposed and the file is
   deleted from the Docker image.
20. **The agent context in `docs/context/` is kept current, in the same commit.**
   It is the project's memory: another agent must be able to pick the work up
   from it alone. Every commit that changes behaviour, structure, configuration,
   a decision, or what is open updates the matching file (the table in
   `docs/context/README.md` says which) and appends a dated entry to
   `docs/context/HISTORY.md` saying what was done, why, and how it was
   verified. `test/context-docs.test.ts` fails when a source file, table, MCP
   tool, environment variable or setting is missing from `PROJECT.md`; it cannot
   judge prose, so the rest is on you. Those files are in a **public**
   repository: never write a real balance, account number, token, session link,
   merchant or institution from the owner's accounts, or the owner's live domain
   or any personal domain into them (the same test scans every Markdown file).

## Layout

```
src/
  index.ts        express + MCP streamable HTTP (stateless), rate limit, auth
  mcp.ts          MCP transport — a thin adapter over tools/registry.ts
  tools/registry  THE tool surface: declared once, served over MCP and to the
                  built-in assistant, so neither can hold a capability the
                  other lacks
  summary.ts      composes the read models into one picture (get_financial_summary)
  brand.ts        uploaded logo: raster only, sniffed by its bytes, in the database
  report.ts       one month or one year: net worth at each end, cashflow, top
                  merchants, largest expenses — the Reports page and
                  get_period_report both read this
  overrides.ts    hand corrections (merchant rules, per-transaction, currency,
                  user categories), applied on read so a sync never undoes them
  llm/            optional built-in assistant: provider adapters (Anthropic and
                  OpenAI-compatible), the agentic loop over tools/registry, and
                  conversation storage
  config.ts       the only module that reads process.env
  db.ts           sqlite schema + idempotent migrations
  store.ts        upserts shared by every source adapter
  queries.ts      read models behind the tools
  fx.ts           Bank of Canada Valet rates + convert()
  sync.ts         orchestrator; one source failing never aborts the others;
                  one run at a time, with progress for the Overview
  snapshots.ts    net-worth totals + daily history rows
  scheduler.ts    in-process nightly sync
  backup.ts       nightly sqlite backup + prune
  oauth.ts        OAuth 2.1 AS: DCR, PKCE, code/token issuance and rotation
  credentials.ts  provider secrets, encrypted at rest, per profile
  profiles.ts     up to 5 profiles; create/rename/delete, move an account
  tags.ts         your own labels on transactions (a trip, business); never
                  part of what counts as spending
  settings.ts     DB-stored settings that override the environment; APP_NAME
                  is install-wide and display-only (the MCP server, cookies and
                  code stay "tally")
  link-server.ts  LOCAL ONLY Plaid Link helper
  sources/        snaptrade.ts, plaid.ts, wise.ts, statements.ts (never persisted),
                  plaid-history.ts (relink a bank for two years and hand over
                  tags, corrections and account settings)
  web/            routes, pages, layout (app shell + the one stylesheet, as
                  tokens; the theme choice is per browser, in localStorage,
                  applied from <head>), icons (hand-drawn), charts, markdown,
                  OAuth pages, logo. Confirmation is the shell's themed
                  tallyConfirm() / form[data-confirm], never the browser's
                  confirm/alert/prompt (test/brand.test.ts checks the source)
  auth/           password, TOTP, sessions
  lib/            logger, money, registered-type classifier, token crypto, html,
                  category (Plaid's RENT_AND_UTILITIES split into RENT and
                  UTILITIES at write time, from its detailed category; the
                  grouped/detailed/broad read, families and labels),
                  taxonomy (the grouped list and the Plaid codes that map
                  into it)
scripts/          db-init, sync, backup, demo (fictional data, no network)
test/             vitest — pure logic, fixtures, and the HTTP endpoint
docs/context/     the agent context: PROJECT (architecture, data model, tools,
                  routes, config), FEATURES, HISTORY (append-only), OPERATIONS,
                  OWNER-AND-COMMUNITY, BACKLOG. Rule 20. AGENTS.md points here
.github/          CI, dependabot, issue templates, FUNDING.yml
```

Community files: `CONTRIBUTING.md` (what gets accepted and what does not),
`CODE_OF_CONDUCT.md`, `SECURITY.md` (private disclosure via GitHub Security
Advisories), `LICENSE` (MIT).

## Commands

```
npm run db:init    create the database (seeds room.json if present)
npm run sync       one-shot sync, exits non-zero if a source errored
npm run dev        run the server from TypeScript
npm run link       Plaid Link helper on :8788 — local machine only
npm run check      typecheck + tests
npm run backup     manual sqlite backup + prune
```
