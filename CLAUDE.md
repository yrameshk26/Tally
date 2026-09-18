# tally (finmcp) — rules

A personal, **read-only** net-worth MCP server for Claude. One household, up to
five profiles. Read `docs/SETUP.md` for provider credentials, the admin password
hash and 2FA; `docs/BUILD_PLAN.md` for the phased plan; `DECISIONS.md` for why
things are the way they are.

**This repository is public.** Nothing committed here may contain a real
balance, account number, contribution-room figure, institution login, API key or
personal domain — not in code, not in docs, not in a test fixture, not in an
example file. Test fixtures use obviously fake values; `docs/BUILD_PLAN.md` and
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
   so make it behind a setting that is off by default.
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
11. **Never scrape.** Wealthsimple's private GraphQL API is off limits;
   SnapTrade only.
12. **After every task:** `npm run typecheck && npm test`. Both must be clean
   before committing. Conventional commits, one per completed task.
13. **Docs ship with the change, in the same commit.** Any new or changed
   feature updates `README.md` and this file before the commit — never "later",
   never a follow-up commit. Concretely:
   - a new or renamed MCP tool → the tool table in README.md
   - a new page, route or UI surface → the Web UI section
   - a new env var or setting → wherever the surrounding vars are documented
   - a new invariant, constraint or rule someone could unknowingly break → a
     hard rule here
   - a new `src/` module → the Layout tree here
   - a changed test count → the Development section
   The test is whether someone reading only these two files would be surprised
   by the code. If yes, the docs are not done.
14. **The Link helper never deploys.** `src/link-server.ts` runs on the
   developer's machine only. Port 8788 must not be exposed and the file is
   deleted from the Docker image.

## Layout

```
src/
  index.ts        express + MCP streamable HTTP (stateless), rate limit, auth
  mcp.ts          MCP transport — a thin adapter over tools/registry.ts
  tools/registry  THE tool surface: declared once, served over MCP and to the
                  built-in assistant, so neither can hold a capability the
                  other lacks
  summary.ts      composes the read models into one picture (get_financial_summary)
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
  sync.ts         orchestrator; one source failing never aborts the others
  snapshots.ts    net-worth totals + daily history rows
  scheduler.ts    in-process nightly sync
  backup.ts       nightly sqlite backup + prune
  oauth.ts        OAuth 2.1 AS: DCR, PKCE, code/token issuance and rotation
  credentials.ts  provider secrets, encrypted at rest, per profile
  profiles.ts     up to 5 profiles; create/rename/delete, move an account
  settings.ts     DB-stored settings that override the environment
  link-server.ts  LOCAL ONLY Plaid Link helper
  sources/        snaptrade.ts, plaid.ts, wise.ts, statements.ts (never persisted)
  web/            routes, pages, layout (CSS tokens), charts, markdown, OAuth
                  pages, logo
  auth/           password, TOTP, sessions
  lib/            logger, money, registered-type classifier, token crypto, html
scripts/          db-init, sync, backup
test/             vitest — pure logic, fixtures, and the HTTP endpoint
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
