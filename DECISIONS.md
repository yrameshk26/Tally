# Decisions

Dated, append-only. Each entry says what was chosen, what it was chosen over,
and why.

## 2026-09-26 — Six changes from a user running their own copy

- **PLAID_REDIRECT_URI is honoured by the web UI** when its path is
  `/connections/oauth`. The page built the URI from the address it was opened
  on and ignored the variable, so someone who registered one address and used
  another saw a mismatch that would only bite on the next OAuth bank. The
  helper's localhost address is still ignored there, with the reason shown.
- **Rent and Utilities are split** at write time using Plaid's detailed
  category, with a one-off migration for stored rows. A row with no detailed
  category keeps the combined label rather than being guessed into one side.
  Done in the store, not on read, so every total, rule and tool sees one value;
  hand corrections still win because they apply on read.
- **Bulk recategorise on Merchants** writes exactly what the single-row picker
  writes (merchant-match rules) for each ticked merchant, in one transaction.
  Its picker has no default: an empty choice is refused rather than read as
  "clear the category of everything selected".
- **A theme switch** (system, light, dark). Stored per browser in
  localStorage: it is a viewing preference, not household data, and two people
  on two devices can reasonably want different ones. Applied from `<head>` so
  there is no flash; print still forces light, now with a selector that
  outranks the theme rules.
- **Month to date** is the default window on Transactions and Merchants.
- **Reports uses Month and Year dropdowns** instead of a native month input,
  which some browsers render as a bare "2026-08" text box.

## 2026-09-25 — Merchants stops double counting card payments

Found while screenshotting the redesign: the Merchants page listed "Loan
payments" and "Transfer out" as expense categories and added them to its total,
so paying a card from chequing counted the card's purchases twice, which is the
bug fixed on the Transactions tab and in reports two days earlier. The page and
`get_spend_by_merchant` never picked up the shared exclusion. Both do now, via
`splitTransfers`, and both say how many rows they left out; the MCP tool takes
`include_transfers` like `get_cashflow`.

Both also capped their rows at 1,000 under a comment saying they read the whole
window. The Merchants page defaults to a year, and a dozen linked banks pass a
thousand transactions long before that, so the totals silently covered only the
newest ones. Rollups now read up to `ROLLUP_ROW_LIMIT`.

## 2026-09-25 — The UI moves to a sidebar app shell

A visual revamp: a fixed sidebar with grouped, icon-led navigation on desktop,
a gradient hero card for net worth with its change over the history window,
16px cards on a soft accent glow, filled inputs with custom select chevrons,
a segmented control for switching profile, and a glass sign-in card. Light and
dark are both redesigned rather than one derived from the other.

What did not change, on purpose: the chart palette (validated for colour-blind
separation in both modes; restyling a chart is not a reason to repaint its
series), server rendering with no framework and no webfonts, the nonce CSP with
no inline styles, the print path, and every id and class the scripts and tests
depend on.

The sidebar also retires yesterday's two-row header. That existed because a
single top row had about 120px to spare beside nine links and Sign out; a
sidebar has room for any app name, and below 1060px the same markup becomes a
top bar whose links scroll as one row of pills. Figures in the KPI cards are
sized to their card with container query units, so a seven-digit balance fits
however many cards share a row.

Found on the way: the chart tooltip sat in the page corner as an empty ring on
every page with a chart, because `.tip{display:flex}` overrode its `hidden`
attribute. It had been there since the tooltip was added.

## 2026-09-25 — A custom logo, raster only

Settings → Appearance takes a logo for the navigation, sign-in screen and tab
icon. PNG, JPEG and WebP only, identified by their first bytes; 256 KB at most;
stored in `brand_assets` so it is in every backup and needs no writable path.

SVG is refused even though it is the natural format for a logo. It is a
document, not a picture: it can carry script, and someone opening its URL
directly would run that script on this origin with the session cookie attached.
Sanitising SVG is a library and an arms race; not accepting it is neither. The
route is public, because the sign-in screen shows the logo before anyone signs
in, so it is served with the sniffed type, `nosniff` and a `sandbox` CSP. The
content hash in the URL lets it be cached for a year.

The upload posts the raw file with the CSRF token in a header, from a few lines
of script on the Settings page. A multipart form would have needed a parser
dependency for one field.

## 2026-09-25 — The app name is a display setting; the header has two layouts

A user renamed "tally" in their copy and then could not take updates without
losing the change. The name is now `APP_NAME` under Settings → Appearance (or the
environment). It changes what a person reads: the sign-in screen, the
navigation, the tab title, the Claude connection prompt. Nothing a machine reads
changes: the MCP server name, the OAuth resource name, cookie and storage keys
stay "tally", so connectors, sessions and links survive a rename. The footer
still credits the project ("X runs on tally"), since the rename is the user's
and the link is how anyone else finds this.

It is install-wide, stored on the default profile, and cleaned before it is
stored (control characters out, whitespace collapsed, 40 characters). A blank
value is refused by `setSetting`; clearing the field in the form is how you go
back to "tally".

Measuring the header while doing this showed it had no room to spare: at the
widest, nine links and Sign out leave about 120px, enough for "tally" and not
much more, and below 1060px it was already wrapping link by link. So the header
has two layouts. One row when the name is six characters or fewer and the
screen is at least 1060px; otherwise two rows, name and Sign out on top and the
whole nav on one line beneath, scrolling sideways if it must, as phones already
did. The server picks, because it knows the name. Letting flex-wrap decide was
tried first and stranded Sign out on a line of its own at 1024px, and scrolled
the whole page sideways at 800px.

## 2026-09-25 — One place builds the public origin

The same user needed several attempts to get Plaid's redirect URI accepted
behind Caddy. The URI is built from the request, and five places read
`X-Forwarded-Proto` whole. Behind a chain of proxies that header is
`https, http`, which produced `https, http://host/connections/oauth`, a URI
nobody registers. `originOf` now takes the first entry and ignores anything that
is not a scheme, and everything that builds an absolute URL uses it. The
Connections page also warns when the redirect URI it is about to send starts
with `http://` on a real domain, which is what a proxy that does not pass the
scheme at all looks like, and the setup guide has Caddy and nginx examples and
a checklist for comparing the two strings.

## 2026-09-24 — Refresh returns at once; the Overview shows the run

Refresh used to await the whole sync inside the request, so the page sat on
the browser's spinner for as long as every bank took, a couple of minutes with
a dozen linked, and could outlast a proxy timeout. Nothing stopped a second run
either: clicking during the nightly job, or while Claude ran `sync_now`, began
another full pass over every bank in parallel.

Now `runSync` is single-flight and records which step it is on. `POST /sync`
starts it and redirects to the Overview, which dims every widget under a
shimmer, shows a progress bar naming the step, polls `/sync/status`, and
reloads when the run ends so every widget comes back fresh. The click shows
the loading state before the server answers; `?syncing=1` covers a run so short
it finished before the page rendered.

Alternatives rejected:

- **Swap the fresh widgets in without a reload.** The charts carry nonced
  scripts that do not run when inserted as HTML, so this needs a client-side
  renderer, which the project deliberately does not have. A reload is one
  round trip and cross-fades under the existing view transitions.
- **Server-sent events for progress.** A stream per open tab for a job that
  runs a few times a day; polling every 1.5s while a run is in flight, and not
  at all otherwise, is simpler and survives a proxy that buffers responses.

Found on the way: the old redirect decided success by looking for `error` on
the merged per-source entry, which with two profiles is keyed by profile, so a
failed bank reported "Sync complete." `failedSources` reads each profile.

## 2026-09-23 — The report's PDF is the browser's print dialog

A user asked for a monthly and annual summary they could keep as a PDF, like
the annual statements some banks send. The report page renders it, and "Save as
PDF" calls `window.print()`. A print stylesheet drops the navigation and the
controls, hides the collapsed chart-table twins (the report prints its tables
in full), keeps sections from splitting across pages, and restates the light
palette so a PDF printed from a dark-mode browser still comes out on white.

Alternatives rejected:

- **A PDF library (pdfkit and friends).** The charts are hand-written SVG; a
  library would need a second renderer for them, or an SVG-to-PDF shim, and
  would be the largest dependency in the tree for one button. Rejected for the
  same reason a charting library is.
- **Headless Chromium on the server.** Produces a file directly, but adds a
  browser to a Docker image that currently has none, and a process that renders
  HTML with every balance in the household to a path on disk.
- **Generating the file server-side at all.** Nothing about the report needs a
  server-made file: the browser already has the page, prints vectors, and puts
  the file where the user chooses. The page title is set to `Summary <period>`,
  which is the file name the dialog offers.

The cost is one extra click in the print dialog. The figures come from
`buildPeriodReport`, which `get_period_report` returns over MCP as JSON, so an
agent gets the same numbers without any of this.

## 2026-09-23 — Transfers are hidden on the Transactions tab by default

The tab listed every row and totalled all of it, so paying a card from chequing
showed up as money out alongside the purchases it paid for. Cashflow and the
Overview already excluded transfers and card payments; the tab was the one
surface that did not, and a user reading it reasonably concluded the whole app
double counted. Now it applies the same exclusion by default, says how many
rows it hid with a link to show them, and steps aside when a transfer category
is asked for by name. Hiding silently was rejected: a ledger that drops rows
without saying so is one people stop trusting.

## 2026-09-19 — Browser sessions expire on two clocks; MCP keeps its own

The session cookie used to carry a 7-day lifetime that slid forward on every
request, so a session in weekly use never expired, and a laptop closed with a
tab open stayed signed in for a week. For a page showing every balance and
transaction in the household, that is too generous.

Now two clocks run and neither extends the other: `SESSION_IDLE_MINUTES`
(default 30) since the last request, and the unchanged 7 days since sign-in,
fixed at creation. `purgeExpiredSessions` sweeps both.

The server only sees requests, so reading a page for half an hour looks exactly
like abandoning it. The page shell therefore posts to `/session/ping` while
there is activity, and submits the sign-out form when there is none. The server
remains the authority; the script only supplies the signal the server cannot
observe and closes the screen.

`last_seen_at` is written at most once per sixth of the idle window rather than
on every request. That throttle is also the error bar: a session can outlive
the timeout by that much, never expire before it.

Alternatives rejected:

- **A shorter bank-style 15 minutes.** Correct for a bank with millions of
  users on shared machines; here it interrupts reading a long transactions page.
  The setting exists for anyone who wants it.
- **Writing `last_seen_at` on every request.** Simpler and exact, but it is a
  write per request for a benefit measured in minutes of precision.
- **Applying the same timeout to MCP.** A connector holds an OAuth token with
  its own lifetime and rotation. Tying it to browser activity would disconnect
  Claude mid-conversation because nobody had the web UI open, which is
  backwards: the UI exists to run the server, not to gate it.

## 2026-09-17 — SnapTrade Personal keys go through a signed REST client, not the SDK

`snaptrade-typescript-sdk` marks `userId` and `userSecret` as required on every
call, but a Personal API key identifies the user by the key itself and the two
fields should not be sent at all
([docs](https://docs.snaptrade.com/docs/personal-vs-commercial)). Passing empty
strings is a guess at how the server treats them.

`src/sources/snaptrade.ts` therefore implements the documented auth directly:
`Signature: base64(HMAC-SHA256(encodeURI(consumerKey), stableJSON({content, path, query})))`,
with `clientId` and `timestamp` in the query string. This is byte-for-byte the
scheme the SDK's own `requestAfterHook` uses — `test/snaptrade-sign.test.ts`
asserts that against an independent implementation — so we are not inventing a
protocol, only choosing which fields to omit.

`SNAPTRADE_TRANSPORT=sdk` plus `SNAPTRADE_USER_ID`/`SNAPTRADE_USER_SECRET`
remains available for a Commercial key, where the fields are real.

Alternative rejected: keep the SDK and cast `{} as never`. It compiles, but it
sends `userId=&userSecret=` on the wire, which is a different request from the
one the docs describe.

## 2026-09-17 — Nightly sync runs in-process, not as a cron daemon

The container runs one process. Adding busybox cron means a second process, a
second copy of the environment to keep in step, and a failure mode where the
daemon is alive but the sync never fires and nothing notices.

`src/scheduler.ts` schedules a `setTimeout` to the next `CRON_HOUR:CRON_MINUTE`
and re-arms after each run. Every run appends a line to `sync.log` next to the
database, which is the file the build plan says to check the morning after a
deploy, so the observable contract is unchanged.

Cost: a container restart between the scheduled time and the next tick skips
that night's run. Acceptable for a personal server that can also be refreshed
on demand with `sync_now`.

## 2026-09-17 — Transactions are stored Plaid-style and negated on read

Storage keeps exactly what Plaid sent (positive = money out) so that re-syncing
is idempotent and a stored row can be compared against the API without
reasoning about who flipped what. Every read model in `src/queries.ts` negates,
so Claude and the user only ever see the intuitive convention: negative is money
leaving. `accounts.balance` uses the opposite, also intuitive, convention —
assets positive, liabilities negative — so that `SUM(balance_cad)` is net worth
with no CASE expression.

Both conventions are asserted in tests rather than only documented.

## 2026-09-17 — Contribution detection reports, it does not guess

A bank transfer into Wealthsimple is visible from the Plaid side but carries no
information about which registered account received it. Subtracting it from
RRSP room would be wrong whenever it was a TFSA top-up, and over-reporting
remaining room is the expensive direction of the error (CRA penalties).

So `get_contribution_room` returns three separate numbers:
`contributed_detected_cad` (brokerage activity tagged `CONTRIBUTION`/`DEPOSIT`,
attributable to a specific account), `contributed_manual_cad` (set by the user)
and `unattributed_brokerage_transfers_cad` (the bank-side heuristic, shown but
never subtracted). A manual figure always wins, and `confidence` says which
basis was used.

## 2026-09-17 — Owner tags are written on insert only

`upsertAccount` sets `owner` from `DEFAULT_OWNER` when a row is created and
never touches it again. A nightly sync that clobbered a hand-set `spouse` tag
would silently corrupt every by-owner number, and the corruption would look
like a market move rather than a bug.

## 2026-09-17 — Accounts are deactivated, never deleted

A closed brokerage account, a removed Plaid Item or a failed sync sets
`active = 0`. History, owner tags and past transactions survive, and
`list_accounts` can still show them with `include_inactive`. Accounts under an
Item that failed *this* run are deliberately left active — a `login_required`
bank still holds real money, and dropping it from net worth would report a
sudden fictional loss.

## 2026-09-17 — A wrong MCP secret returns 404, not 401

The secret in the URL path is the entire auth model, so the endpoint should not
advertise that it exists. Comparison is over SHA-256 digests via
`timingSafeEqual`, which is constant time and does not leak length.

## 2026-09-17 — Separators are flattened before classifying account types

Found by a test, not in production: SnapTrade reports raw types like `CA_TFSA`
and `CREDIT_CARD`, and `_` is a word character, so `/\btfsa\b/` does not match.
`guessRegistered()` and `classifyAccount()` now flatten `_ - / . ,` to spaces
first. Without this, every Wealthsimple account would have been filed as `NA`
and `by_registered_type` would have been one useless bucket.

## 2026-09-17 — TypeScript is stripped at dev time and compiled for the image

`node --experimental-strip-types` runs `.ts` directly for `npm run dev` and the
scripts, while `tsc` emits `dist/` for the Docker image. That needs
`allowImportingTsExtensions` + `rewriteRelativeImportExtensions`, so source
imports say `./db.ts` and the build rewrites them to `./db.js`.
`erasableSyntaxOnly` is on so nothing that type stripping cannot handle (enums,
parameter properties) can creep in.

## 2026-09-18 — The MCP secret leaks into reverse-proxy access logs

Found on the live deployment, not in review: Dokploy ships Traefik with request
logging enabled (`settings.haveActivateRequests` returns `true`), so every call
writes `/mcp/<secret>` to disk. The secret in the URL path is the whole auth
model, which means the access log is a list of working credentials.

Mitigated for now by rotating `MCP_SECRET` and relying on Dokploy's daily log
cleanup (02:00) to age the old one out. Documented in SECURITY.md as a
deployment hazard rather than silently fixed, because it is a property of
putting a secret in a URL, not of this server.

This moves the case for OAuth on the MCP endpoint up the list. Earlier reasoning
assumed access logging could simply be turned off; on a shared Dokploy instance
it is a global setting that other applications legitimately want. Until then:
rotate periodically, and treat the connector URL as a credential.

## 2026-09-18 — `trust proxy` must be configured, or the rate limiter is a lie

`req.ip` in Express is the socket address unless `trust proxy` is set. Behind
Traefik that is the proxy's container IP for *every* request, so the "60 requests
per minute per IP" limiter was really one global bucket — and an attacker could
exhaust it to lock out the legitimate user.

Now configurable via `TRUST_PROXY` (hop count, default 0). It is deliberately
not defaulted to a trusting value: with `trust proxy` enabled, `X-Forwarded-For`
is attacker-controlled unless a proxy you actually run is rewriting it, so the
safe default is to trust nothing and make the operator opt in.

## 2026-09-18 — SnapTrade positions: right endpoint, wrong field name

`get_holdings` returned zero while account balances were correct.
Three separate mistakes, worth recording because each looked like the last one
was fixed:

1. `/accounts/{id}/holdings` returned nothing usable. The data is at
   `/accounts/{id}/positions/all`, with cash from `/accounts/{id}/balances`.
2. The position shape is not what the SDK's older types describe. The security
   is under `instrument`, numerics arrive as **strings**, and `cost_basis` is
   **per unit**, not a position total.
3. The envelope field is **`results`**, not `positions`. A tool that
   re-serialises SnapTrade responses had renamed it, and reading that rendering
   as if it were the API cost an extra round trip.

The lesson generalised into code: `extractPositions()` accepts `results`,
`positions`, `data` or a bare array and never throws, and the sync report now
counts which endpoint served each account so an empty result is diagnosable
from the report rather than from container logs.

Related: an account with a balance but no position detail is **not** an error.
Wealthsimple's managed portfolios, crypto wallets and cards do not expose the
older per-asset endpoint. Their balances are right; only the breakdown is
missing. This is why invested value sits about $9k below net worth — the DPSP,
managed TFSA and group RRSP contribute balance with no holdings.

## 2026-09-18 — Verify deployed code, not deployment status

Twice during this work a "deploy=done" response was followed by a sync that hit
the previous container, producing results that looked like a failed fix. Worse,
an attempt to check the container's code grepped a base64-encoded response and
concluded — wrongly — that the deploy was stale.

Deployment status is not evidence that new code is running. Read the artefact:
`docker.readContainerFile` on `/app/dist/...`, base64-decoded, grepped for a
symbol that only exists in the new version. Then sync.


## 2026-09-18 — Profiles are a credential tenancy and an attribution bucket, kept as two fields

Plaid's 10-Item cap is per team, so more connections means more credential sets.
The obvious model — "a profile owns its accounts" — breaks as soon as you try to
move an account: its Plaid Item belongs to the team that linked it, and no
amount of database editing changes that.

So an account carries two profile references:

- `source_profile_id` — whose credentials fetched it. Immutable, and the scope
  for deactivation. Without it, one profile's sync would deactivate every other
  profile's accounts, which reads as the household losing most of its money
  overnight. There is a test for exactly that.
- `profile_id` — attribution, written on INSERT only and movable by hand. A card
  linked under one profile's Plaid team can count towards another's net worth.

`owner` (me/spouse/joint) was folded into this rather than kept alongside:
two overlapping groupings would both need maintaining and would disagree. The
migration turns existing owner tags into profiles, so a household that had
already tagged a spouse keeps the split.

One deliberate asymmetry: the environment is a single global fallback and
belongs to the **default profile only**. A second profile inheriting the first's
`PLAID_CLIENT_ID` from env would silently link its banks to the wrong team,
which is the kind of bug you would only notice at the 11th Item.

Deleting a profile is refused while accounts or connections still point at it,
rather than cascading. There is no undo for a deleted Plaid access token — it
means re-linking the bank by hand.
