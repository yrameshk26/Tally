# tally (finmcp) — rules

A personal, **read-only** net-worth MCP server for Claude. One owner, one
household (owner + spouse). Read `docs/BUILD_PLAN.md` for the phased plan and
`DECISIONS.md` for why things are the way they are.

## Hard rules

1. **Read-only, permanently.** Never add a tool, endpoint or code path that can
   place an order, transfer money, or change a setting at an institution. Never
   call SnapTrade order endpoints. Plaid products are limited to
   `transactions` and `liabilities` — never `auth`, `transfer` or `payment`.
2. **Secrets live in `.env` only.** Never log an access token, consumer key or
   secret. `src/lib/logger.ts` redacts them; do not bypass it. Never commit
   `data/`, `.env` or `room.json`.
3. **Signs.** Assets positive, liabilities negative in `accounts.balance`.
   Transactions are stored Plaid-style (positive = money out) and negated on
   read. If you touch a source adapter, add a sign test.
4. **All FX goes through `src/fx.ts`.** No ad-hoc multiplication by a rate
   anywhere else. Missing rate → report it, never silently pass the native
   number off as CAD.
5. **One household, one process.** No multi-tenant code, no user table, no
   auth framework. The MCP secret in the URL path is the whole auth model.
6. **Never scrape.** Wealthsimple's private GraphQL API is off limits;
   SnapTrade only.
7. **After every task:** `npm run typecheck && npm test`. Both must be clean
   before committing. Conventional commits, one per completed task.
8. **The Link helper never deploys.** `src/link-server.ts` runs on the
   developer's machine only. Port 8788 must not be exposed and the file is
   deleted from the Docker image.

## Layout

```
src/
  index.ts        express + MCP streamable HTTP (stateless), rate limit, auth
  mcp.ts          the tool surface — the only place tools are declared
  config.ts       the only module that reads process.env
  db.ts           sqlite schema + idempotent migrations
  store.ts        upserts shared by every source adapter
  queries.ts      read models behind the tools
  fx.ts           Bank of Canada Valet rates + convert()
  sync.ts         orchestrator; one source failing never aborts the others
  snapshots.ts    net-worth totals + daily history rows
  scheduler.ts    in-process nightly sync
  backup.ts       nightly sqlite backup + prune
  link-server.ts  LOCAL ONLY Plaid Link helper
  sources/        snaptrade.ts, plaid.ts, wise.ts
  lib/            logger, money, registered-type classifier, token crypto
scripts/          db-init, sync, backup
test/             vitest — pure logic, fixtures, and the HTTP endpoint
```

## Commands

```
npm run db:init    create the database (seeds room.json if present)
npm run sync       one-shot sync, exits non-zero if a source errored
npm run dev        run the server from TypeScript
npm run link       Plaid Link helper on :8788 — local machine only
npm run check      typecheck + tests
npm run backup     manual sqlite backup + prune
```
