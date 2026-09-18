# Decisions

Dated, append-only. Each entry says what was chosen, what it was chosen over,
and why.

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

`get_holdings` returned zero against $184k of ETFs while balances were correct.
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
