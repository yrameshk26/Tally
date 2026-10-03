# History

Chronological and **append-only**: add each new entry at the bottom, dated, with
what was asked or found, what was done, the commit, and how it was verified.
Reasons for choices live in [`DECISIONS.md`](../../DECISIONS.md); this file is the
story and the map between them. No real balances, merchants or personal data
(see [`README.md`](README.md)); describe real-data events in general terms.

Entry template:

```
## YYYY-MM-DD: short title
- Asked / found: ...
- Done: ... (commit `abc1234`)
- Verified: ... (tests added or changed; what was checked in a browser or live)
- Left open: ... (also in BACKLOG.md)
```

## 2026-09-17 to 2026-09-18: the first build

- Asked: a personal, read-only net-worth MCP server for Claude, following
  `docs/BUILD_PLAN.md` (phases 1 to 8).
- Done: scaffold, SnapTrade (signed REST client for Personal keys), Plaid
  (`transactionsSync`, liabilities, Link helper, update mode), Wise, profiles
  (migration tested against a live-shaped database), OAuth 2.1 for `/mcp`, the web
  UI (Argon2id, TOTP, sessions, CSRF, CSP), the encrypted settings store, hand
  corrections (rules, overrides, categories), `get_financial_summary`, the
  built-in assistant, the Merchants tab, statements (never persisted). First
  commit `fe42dc6`; the public-repo polish at `11d1501` and `1944299`.
- Lessons recorded in `DECISIONS.md` and `CLAUDE.md`: Plaid link-token shapes
  broke live flows three times (`5ab72a6`, `9443a4f`, `f07fcc4`; hard rule 3);
  institution support for statements is per bank and tri-state (`90d0a5d`,
  `023d1ec`); the MCP secret in a URL leaks into proxy logs, hence OAuth; verify
  deployed code, not deployment status.

## 2026-09-19: sign out an idle browser

- Asked by the owner: "since it's financial data, should we log out on
  inactivity?" The owner chose a 30 minute default.
- Done: idle clock plus an absolute 7 day lifetime that nothing extends, a page
  heartbeat, an on-screen sign-out, `SESSION_IDLE_MINUTES` (0 turns it off).
  Commit `ee2c364`. MCP is deliberately unaffected (hard rule 11).
- Verified: `test/session.test.ts`; then deployed.

## 2026-09-23: Reports, and hide transfers

- Asked (owner, from community feedback): a monthly and annual summary; card
  payments should not count as spending.
- Done: Reports page and `get_period_report` (print to PDF, DECISIONS 2026-09-23),
  transfers and card payments hidden by default on Transactions with a count and a
  link. Commit `fa3874d`.
- Verified: `test/report.test.ts` (agrees with cashflow to the cent). Browser
  checks of light, dark, mobile and print. Found and fixed during the work: the
  chart delta disagreed with the Change figure, the excluded total double counted
  both sides of each transfer, an empty table rendered, month names showed as
  numbers, the KPI overflowed Letter paper.

## 2026-09-24: Refresh shows every widget loading

- Asked: "when you click refresh the loading should load all widgets and show".
- Done: `POST /sync` starts the run and redirects at once; the Overview shows a
  progress banner and polls `/sync/status`, then reloads every widget (hard rule
  13). `runSync` is single-flight. Commit `74da4a4`.
- Verified: `test/sync.test.ts`; a bug where the old script replaced the button's
  icon with text was fixed.

## 2026-09-25: rename, proxy fix, logo, UI revamp, Merchants fix

- Asked (Reddit feedback and the owner): let the app be renamed; Plaid said the
  redirect URI did not match behind a Caddy or CDN chain; allow a custom logo;
  "completely revamp the UI, super modern".
- Done: `APP_NAME` setting and `originOf` (first `X-Forwarded-Proto` entry; five
  copies of the header read replaced by one) `cb2bf92`; raster-only logo upload
  `134db2b`; sidebar app shell, dark mode, theme switch, hand-drawn icons
  `03791e9`; Merchants no longer counts card payments as spending and no longer
  reads only the newest 1,000 rows `2f779eb`.
- Verified in Chromium (light, dark, mobile, print). Issues found and fixed on the
  way: KPI overflow (container queries), a stray empty tooltip ring
  (`.tip[hidden]`), a sidebar background that stopped partway down (sticky inner
  container), crushed table selects, theme buttons overridden by sidebar styles,
  print specificity under the dark theme, a TDZ bug (logo routes registered before
  `requireAuth` was defined).

## 2026-09-26: six changes from a user running their own copy

- Asked (eight points from a Reddit user, sent as screenshots because Reddit could
  not be fetched): redirect URI mismatch; a category filter and bulk
  recategorise on Merchants; Rent and Utilities should be separate; a back link
  from a hidden transaction; a light mode; thanks for the logo feature; the From date should default
  to the first of the month; a Month field on Reports. Six changes were proposed
  and the owner said yes.
- Done: `PLAID_REDIRECT_URI` honoured by the web UI, Rent/Utilities split, bulk
  recategorise (explicit choice required), month-to-date defaults, a Month and
  Year selector on Reports. Commit `e294f00`.
- Verified: new tests in `test/appearance.test.ts`, `test/category.test.ts`,
  `test/web.test.ts`; 404 tests at that point.

## 2026-09-27: Plaid's detailed categories

- Asked (a Reddit user comparing with Fidelity): the categories are too coarse;
  "let's try Plaid detailed categories".
- Done: `CATEGORY_DETAIL` setting, effective category computed on read before rules
  and overrides, prefix-aware transfer exclusion, grouped pickers, labels, demo data
  with detailed codes. Commit `5ea123c`.
- Verified: totals identical in both modes (tests), live data checked through the
  owner's MCP connector (the deployed instance reported the new `by_category_group`).

## 2026-09-28: grouped categories modelled on Fidelity's list

- Asked: the same user pasted Fidelity's full category list ("exactly like my
  manual list"). The owner chose to build it as the default.
- Done: `src/lib/taxonomy.ts` (18 parents, mapping Plaid codes in), third mode
  `grouped`, parent-aware families, hand-pick entries Plaid cannot fill. Commit
  `14b7651`. Income, transfers and payments keep Plaid's codes so all modes agree.
- Verified: `test/category.test.ts` (every live-seen code maps; no income or
  transfer is mapped; totals identical in all three modes); checked live.

## 2026-09-29: tags

- Asked: a way to mark vacation and business spending without changing its
  category, and still drill down by category inside a trip, including trips that
  cross a month end. The owner asked to be told about anything that already
  existed and to build only if really worth it. Concluded it was worth it (it
  helps the MCP side as much as the UI) and built it. Commit `d6c6225`.
- Done: `tx_tags`, tag filter, chips, bulk tagging, tag report period, MCP tools,
  and pending-to-posted inheritance. A latent bug found: hand overrides were being
  lost when a pending charge posted; fixed for tags and overrides.
- Verified: `test/tags.test.ts`, a browser run on the demo.

## 2026-09-30: two years of history, themed dialogs, a handover bug

- Asked: transactions from January (Reddit user); "how long does the takeover
  take"; "no default browser alerts, everything themed"; why a Repair fails.
- Done: `PLAID_TRANSACTION_DAYS` finally sent to Plaid; relink handover
  `1c97545`; themed `<dialog>` and visible handover progress `7c35752`; name
  pairing for same-last-four cards and `finishHandovers` `7d80a7e`.
- Live outcome: the owner relinked most banks for two years; the first handovers
  left two same-last-four cards unpaired and their old rows counted twice; fixed,
  deployed, and confirmed on the live data (duplicate charges disappeared from the
  merchant list). One connection on the second profile still needs its login
  repaired.
- Verified: `test/plaid-history.test.ts` (stubs Plaid's API, runs the real sync),
  a browser run of the dialog in both themes (Esc cancels, confirm submits).
- A real gap: a leaked personal domain appeared in `DECISIONS.md` in `7c35752`
  (removed in 2026-10-02; it remains in git history).

## 2026-10-01: subcategories, and tick the rows to tag

- Asked (Reddit): a "Rent" subcategory under Income; checkboxes so a tag can skip
  one transaction in the middle.
- Done: "Under" picker and `add_category(parent)` `469b9bb`; per-row checkboxes with
  select-all and a live count, parser limits raised for 1,000 ticked rows
  `f203e33`.
- Verified: tests, plus a browser run that unticked the middle row of a 14 row trip
  (13 tagged, that one left out) on desktop and mobile.
- Short Reddit replies were drafted for each (the owner posts them).

## 2026-10-02: agent context directory

- Asked by the owner: keep the complete project context in Markdown files in the
  repo so another agent can pick up, and keep them up to date on every change.
- Done: this directory (`docs/context/`), `AGENTS.md`, hard rule 20 in `CLAUDE.md`,
  and `test/context-docs.test.ts` which fails when `PROJECT.md` drifts from the
  code or a personal identifier appears in tracked Markdown.
- Found: the live domain in `DECISIONS.md` (fixed in this commit).
- Answered for the owner, a Reddit question: a mortgage payment is hidden from
  spending by default (Plaid files it under loan payments); it can be counted by
  filing it under a category of your own (`HOME_MORTGAGE`). Verified with a
  scratch script against the real code before answering. Whether it should count by
  default is an open decision (`BACKLOG.md`).

## Lessons that apply to future work

- A change to link tokens cannot be proved by tests; keep it behind a setting that
  is off by default and ask the owner to try one bank first.
- Anything that reads categories for a total must read them **after** corrections
  and go through `isTransferLike`; a list of its own re-creates the double count.
- Pairing by a guess moves history onto the wrong card; pair only when
  unambiguous and say what was left alone.
- Verify with the real app: a headless browser run catches overflow, theme and
  print problems that unit tests do not. Verify deployed code, not deployment
  status.
- Edits made with scripted string replacement fail loudly when the text differs;
  re-read the exact lines before retrying. A newline escape inside a TypeScript
  template literal that builds an inline script becomes a real newline and breaks
  the script.
- Every MCP client caches the tool list at connect time; after adding tools the
  owner must reconnect the connector to see them.
