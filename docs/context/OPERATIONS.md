# Operations

How to run, test, verify, ship, and not trip over what already tripped us.
Product setup for end users is in [`docs/SETUP.md`](../SETUP.md) and
[`DEPLOY.md`](../../DEPLOY.md); this file is for whoever is changing the code.

## 1. Commands

```
npm ci                 install (Node >= 22)
npm run dev            run from TypeScript (reads .env if present)
npm run check          typecheck + all tests; must be clean before every commit
npm test               tests only (vitest)
npm run typecheck      tsc --noEmit
npm run build          tsc to dist/ (what the Docker image runs)
npm run demo           seed a fictional database (no network)
npm run hash-password  generate ADMIN_PASSWORD_HASH (12 character minimum)
npm run db:init | sync | backup | link
```

`npm run link` (the Plaid Link helper on :8788) runs on a developer machine only
and must never be deployed or exposed (hard rule 19).

## 2. Tests

- All under `test/`, vitest, `environment: node`. The suite is fast (a few
  seconds); run it often. One file per area; each file's header comment says what
  it pins and why.
- **HTTP tests** (`test/web.test.ts`, `test/server.test.ts`, `test/oauth.test.ts`)
  set environment variables first, then `await import` the app, start
  `createApp().listen(0)` and use `fetch` with a real session cookie and CSRF
  token (`login()` helper in `web.test.ts`).
- **Database tests** use `initDb(openDb(':memory:'))`. Settings that depend on the
  environment (`TOKEN_ENC_KEY`, `PLAID_CLIENT_ID`) are set before the dynamic
  imports.
- **Plaid is never called.** `test/plaid-history.test.ts` stubs
  `PlaidApi.prototype` methods with `vi.spyOn` and runs the real `syncPlaid`; use
  the same approach for anything that touches Plaid.
- `test/helpers.ts` exports `inlineHandlers(html)`, which every rendered page test
  uses to assert there are no inline `on*=` handlers (the CSP forbids them).
- **Source-level tests** pin invariants no behaviour test can see: statements are
  never persisted (`test/statements.test.ts`), link tokens keep their shape, no
  native `confirm`/`alert`/`prompt` under `src/web/` (`test/brand.test.ts`), and the
  context docs stay in step with the code (`test/context-docs.test.ts`).
- Test fixtures use obviously fake data (hard rule: public repository).

## 3. Run the app locally on the demo data

Tested recipe (do not skip `rm`: the database runs in WAL mode and leaves
`-wal`/`-shm` files that a plain `rm data/demo.db` misses, which makes the next
seed look empty):

```bash
pkill -f 'src/inde[x].ts'      # the bracket stops pkill matching its own command line
rm -f data/demo.db*
npm run demo                   # fictional household, refuses to overwrite without DEMO_FORCE
HASH=$(npm run --silent hash-password -- 'demo-password-123' | sed -n 's/^ADMIN_PASSWORD_HASH=//p')
DB_PATH=data/demo.db PORT=8810 UI_ENABLED=true CRON_ENABLED=false ADMIN_USERNAME=demo \
  ADMIN_PASSWORD_HASH="$HASH" MCP_SECRET=$(openssl rand -hex 32) \
  TOKEN_ENC_KEY=$(openssl rand -hex 32) COOKIE_SECURE=false npm run dev
```

Sign in at `http://localhost:8810` as `demo` / `demo-password-123`. Plaid
credentials are absent, so Connections shows setup state; add
`PLAID_CLIENT_ID=x PLAID_SECRET=y` to see the Plaid panel (nothing is called until
you press a button). To see handover or connection states without Plaid, insert
fake `plaid_items` rows into a copy of the demo database.

Traps seen: extracting the hash with `head -1` can break the pipe and corrupt it,
so use `sed -n` as above; `pkill -f "node.*src/index.ts"` kills its own shell.

## 4. Verify a change in a real browser

Unit tests cannot see overflow, theme, print or focus problems. For any UI change,
run the demo server and drive it with a headless Chromium. In the Claude Code
sandbox Chromium lives at `/opt/pw-browsers/chromium-<n>/chrome-linux/chrome`
(`playwright-core` was resolvable there; it is **not** a repository dependency, so
do not add it; install it outside the repo with `--no-save` if needed). Never run
`playwright install`.

Checks worth doing every time: light and dark (`colorScheme`), a 390 px wide
viewport, no horizontal overflow
(`document.documentElement.scrollWidth > window.innerWidth`), no page errors, and
that a native dialog never opens (`page.on('dialog', ...)`).

Skeleton:

```js
import { chromium } from 'playwright-core';
import { readdirSync } from 'node:fs';
const dir = readdirSync('/opt/pw-browsers').find((d) => d.startsWith('chromium-'));
const browser = await chromium.launch({
  executablePath: `/opt/pw-browsers/${dir}/chrome-linux/chrome`,
  args: ['--no-sandbox'],
});
const base = 'http://localhost:8810';
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
const page = await ctx.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push(String(e)));
page.on('dialog', async (d) => { errs.push('native dialog: ' + d.message()); await d.dismiss(); });
await page.goto(`${base}/login`);
await page.fill('#u', 'demo');
await page.fill('#p', 'demo-password-123');
await page.click('form[action="/login"] button[type=submit]');
await page.waitForURL(`${base}/`);
// ... navigate, click, assert, screenshot ...
await browser.close();
```

An animated element (the dialog fades in over 0.16 s) looks washed out if you
screenshot instantly; wait a few hundred milliseconds.

### README screenshots

`docs/screenshots/{overview,transactions,merchants,report}.png` must be generated
from the demo server only. Viewport 1280x900, `deviceScaleFactor: 2`; Overview and
Report full page, Transactions (from 40 days ago) and Merchants (from 180 days ago)
viewport only. Regenerate them whenever the UI they show changes (rule 18 spirit),
after reseeding a clean demo database.

## 5. Shipping

- **Branch and deploy:** work on `main`; the owner's deployment redeploys on every
  push to `main`, so **a push is a deploy**. Run `npm run check` first. Do not
  open pull requests unless asked.
- **Commits:** conventional (`feat:`, `fix:`, `docs:`, `feat(ui):`), one per
  completed task, a body that says why, and the attribution trailer given in the
  session's system reminder. Docs ship in the same commit (rule 18, rule 20).
- **GitHub access:** use the GitHub MCP tools or `gh api`; there is no `gh` CLI.
  `origin` still points at the old lowercase repository name, so pushes print
  "This repository moved". It is harmless; `git remote set-url origin
  https://github.com/yrameshk26/Tally.git` silences it.
- **Verify after deploy:** do not trust "deployment done". Poll the deploy host's
  deployment list until the newest deployment shows your commit as `done`, then
  check behaviour on the live instance with a **read-only** call (an MCP read tool,
  or a page that shows the change). A sync after a deploy can take many minutes.
- **Private inputs for the live deployment (not in the repository, ask the owner):**
  the live address; the deploy host's URL and API key (read-only GETs were enough
  to poll deployments); the deployment application id; the name of the MCP
  connector in the agent's own client. In the previous sessions these were kept in
  a scratch file outside the repo; that file does not persist. A manual "deploy now"
  call was blocked by the sandbox's permission classifier and was unnecessary
  because autoDeploy handles it.

## 6. Working against the live instance

- The owner's MCP connector (tools named `mcp__Tally__*` in Claude Code) talks to
  the live data. **Read tools are safe. Write tools change the owner's real
  data** (`set_*`, `tag_transactions`, `add_category`, `rename_tag`, `delete_tag`,
  `move_account`, `*_profile`, `sync_now`, `backup_now`): use them only when asked.
- A client caches the tool list when it connects; after adding or renaming tools the
  owner must reconnect the connector before the new ones appear. `sync_now` over MCP
  times out at 60 s while the sync keeps running; read `sync_report` later.
- **Never copy real figures, merchants, institutions, account ids or the live
  domain into the repository**: not into code, tests, docs, commit messages or
  screenshots. Describe live outcomes in general terms (see `HISTORY.md`).

## 7. Plaid and bank specifics

- Each profile is its own Plaid team; each allows 10 Items. A relink for history
  needs one free slot while both connections exist.
- `ITEM_LOGIN_REQUIRED` means Repair (update mode). If Repair's window says it
  cannot retrieve the account, the cause is on the bank's side of Link; a likely
  one (hypothesis, not confirmed) is that the bank's site signs in whoever is
  already logged in on that browser, so repair from a private window with the
  login that owns that connection, or disconnect if its cards are supplementary
  cards already visible through another connection.
- **Reading Plaid's own log.** The dashboard's Activity log shows each call Tally
  made, with a request id, the item id and Plaid's response. Use it to tell Plaid's
  error from Tally's: a `400 ITEM_LOGIN_REQUIRED` there is Plaid's answer. Its
  integration type matters: **Classic** institutions are signed in to with stored
  credentials and break when the bank challenges or refuses that sign-in; OAuth
  institutions do not. Tally's balance read (`/accounts/balance/get`) is a live
  bank check, so a bank that refuses live sign-ins fails there first. A fresh
  link that goes `ITEM_LOGIN_REQUIRED` on its first read is the bank refusing, not
  stale credentials; quote the request id and item id to Plaid support.
- **RBC (Royal Bank of Canada) and its 2-step push** (researched 2026-10-08; the
  owner's link failed at the push). Established: RBC is Plaid's `ins_39`; Plaid's
  OAuth guide says Canadian institutions do not use OAuth, so a Plaid link to RBC
  signs in with the customer's credentials from Plaid's servers, which RBC treats as
  a new device; RBC's 2-step sends one push to the single trusted device (current
  RBC app, notifications on), and it cannot be switched off. Wealthsimple does not
  say which provider it uses for RBC (it names Flinks, Plaid and its own tool), so
  "it worked there" does not show the same path. Not established: why this link
  fails; a 2022 RBC and Plaid announcement describes a direct API without
  credential sharing, which the docs do not reconcile. The Plaid Link session log
  (the exit or error code and the step it stopped at) is what decides it.
- OAuth banks need `https://<host>/connections/oauth` registered in the Plaid
  dashboard, and `PLAID_REDIRECT_URI` set to it when behind a proxy that rewrites
  the host. `TRUST_PROXY` must equal the number of proxy hops.
- A Plaid change cannot be proven by tests: put it behind a setting, off by
  default, and ask the owner to try one bank (hard rule 3).
- American Express reuses the last four digits across a business card family;
  anything that pairs accounts must tell them apart by name.

## 8. Backups and recovery

`/data/backups/finmcp-YYYY-MM-DD.db`, 14 days kept (`BACKUP_KEEP_DAYS`), written by
the nightly job and by `backup_now`. `TOKEN_ENC_KEY` must be kept: without it the
stored credentials and Plaid tokens cannot be decrypted and every bank must be
re-linked. Losing the Plaid access tokens means re-linking every bank by hand.

## 9. Before you say a task is done

1. `npm run check` clean.
2. For UI: demo server run in a browser, light, dark and 390 px, no overflow, no
   page errors, no native dialog; screenshots regenerated if they show the change.
3. Docs updated in the same commit: `README.md`, `CLAUDE.md` where a rule or the
   layout changed, **and the matching `docs/context/` files**, including a dated
   `HISTORY.md` entry.
4. No personal identifier, real figure or live domain anywhere you touched.
5. After the push: deployment confirmed and the change observed live (read-only).
