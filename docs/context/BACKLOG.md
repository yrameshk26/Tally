# Backlog: what is open

Anything found but not fixed, anything undecided, anything promised. Move an item
out when it is done and say so in [`HISTORY.md`](HISTORY.md). Older phase
checklists remain in [`TODO.md`](../../TODO.md) (still the source for the
credential-dependent items there).

## 1. Decisions waiting for the owner

1. **Reports screen.** The owner said the Reports screen will be revisited after
   more use. Wait for their notes before changing it.
2. **The leaked domain in git history.** Commit `7c35752` added the live domain to
   `DECISIONS.md` (removed from the current tree on 2026-10-02). Removing it from
   history needs a force-push of a public repository, which the agent will not do
   without the owner's explicit say. Low impact if the domain is already public.

## 2. Open work and ideas (none promised)

- **Linked mortgage: count the payment, or treat it as debt paydown?** A user
  (2026-10-03) suggested two setups: connect the mortgage account, where the
  paying account's transaction stays hidden (a transfer to a liability the
  household owns, so net worth already moves), or, if not connecting it, count the
  payment as an expense. Today the payment is counted once as Home › Mortgage in
  both cases (the loan account's own side is excluded). The user's version is
  defensible: when the loan is linked, principal is a liability paydown and only
  interest is a true expense. Options: (a) leave as is; (b) when a loan account is
  linked on the same profile, hide the payment instead (a setting or automatic);
  (c) split interest and principal when the loan account reports them. Today a
  rule or override filing the lender as a transfer gives the user's version. Not
  decided; the owner said they are thinking about it.
- **Interest versus principal on a mortgage.** A mortgage payment counts in full
  as spending (Home › Mortgage); Plaid does not split it. If a linked loan account
  reports interest, a future split could count only interest (and escrow) as an
  expense, which some users prefer. Not requested.

- **Cash follow-ups (not requested):** several named wallets, a receipt photo,
  CSV import, and splitting one withdrawal across entries. Cash withdrawals are only
  recognised where the bank labels them `TRANSFER_OUT_WITHDRAWAL`.
- **Costco gas versus the warehouse.** Suggested to a user: a `contains` rule on
  the gas station's bank text set to Fuel. Unverified in practice: rules apply in
  `position` order and the first match wins, so an earlier exact-merchant rule for
  the same company would win over a later `contains` rule. If it comes up, check
  the order and consider showing rule conflicts or a reorder control.
- **Tag management in the UI.** Tags can be renamed, merged and deleted only over
  MCP; the UI can add, remove and filter. A small "Tags" panel (count, date range,
  rename, delete) would close the gap.
- **Transaction notes** exist (`tx_overrides.note`, set over MCP) but are not shown
  or searchable in the UI.
- **Rule ordering and conflicts** are not visible in the UI.
- **A staleness banner** for a connection that has been broken for days (from
  `TODO.md`): `login_required` and `INSTITUTION_NOT_RESPONDING` currently wait until
  someone looks at Connections or `plaid_status`.
- **Handover reporting.** `unmatched_annotated` (tagged or corrected rows with no
  match in the new history, whose notes are dropped) and `unmatched_accounts` are in
  the sync report but not shown in the UI.
- **Grouped list gaps:** insurance has no Plaid detail (a bank row lands on the
  parent), Cash and ATM maps nothing automatically (cash withdrawals are transfers),
  Pets and Home have mostly hand-pick entries, tax payments map only to the Taxes
  parent.
- **`get_income_summary`** once a year of activity exists (`TODO.md`).
- Older assumptions to confirm on live tokens (`TODO.md`): Wise `/v2/profiles`
  shape, SnapTrade activities pagination, managed-portfolio holdings with no
  positions.

## 3. Known issues and limits

- **A connection on the second profile needs its login repaired** (status
  `login_required`). Repair from a private window with that bank login owner's
  credentials, or disconnect if its cards are already visible through another
  connection. Not a Tally defect.
- **One SnapTrade sync took about 17 minutes** after a deploy and the next about
  30 seconds; the cause was not established. MCP `sync_now` times out at 60 s while
  the run continues, so read `sync_report` afterwards.
- A Transactions page shows at most 1,000 rows and says when it truncated; totals
  cover only what is shown. Rollups (Merchants, reports, cashflow) read the whole
  window.
- A tag report omits net worth by design.
- Items linked before the history columns existed show "History: 90 days" until
  relinked, which is correct for them.
- Connections need one free Item slot (10 per profile) while a two-year relink is in
  progress.
- `origin` points at the old lowercase repository URL (harmless "repository moved"
  notice on push).
- The context-docs drift test (`test/context-docs.test.ts`) checks source files,
  tables, tools, environment variables and settings against `PROJECT.md`; it cannot
  judge prose, so `FEATURES.md`, `HISTORY.md` and this file rely on discipline.

## 3b. The spouse's Amex Canada link (open, owner side)

Status on 2026-10-07: the old 90 day connection and the two-year replacement were
both `login_required`, so the owner disconnected both and linked the card fresh.
The fresh link showed `ok`, zero accounts, never synced (no sync had run yet);
the first sync then got `ITEM_LOGIN_REQUIRED` from Plaid, on the first read, with
nothing fetched. Plaid's own dashboard log for that call says the same, with only
the generic message ("login details have changed ... use update mode") and the
integration type **Classic** (Plaid signs in with stored credentials, so the bank
can refuse or challenge it). It happened to the replacement link too, so a login
that Link accepts is being rejected when Plaid reads it. Not a Tally defect; the
reason is Amex's and is not visible from Tally.

Owner-side next steps, in order: (1) open a Plaid support ticket with the request
id and item id from the dashboard log (Plaid can see the bank's real response);
(2) look at the item's earlier log entries (`PRODUCT_NOT_READY` means it was only
not ready, `ITEM_LOGIN_REQUIRED` from the start means the bank refused it);
(3) sign in to Amex Canada by hand as that cardholder and clear any security
prompt, then Repair from a private window. `finishHandovers` pairs old rows with a
new link once exactly one live connection of the bank exists, so a working relink
does not count anything twice.

Possible experiment, **not built and unproven**: Tally reads balances with
`/accounts/balance/get` (`src/sources/plaid.ts`, in the sync and in `syncNewItem`),
which makes Plaid sign in to the bank live. Plaid's cached `/accounts/get` does
not. If a bank refuses live sign-ins but serves cached data, a setting (off by
default, hard rule 3) that reads cached balances would keep it syncing, at the
cost of slightly stale balances; a connection the bank truly rejects would still
fail on the transaction read. Only worth building if Plaid support points at it.

## 3c. RBC link fails at the 2-step push (open, owner side)

The owner's RBC link through Plaid did not complete: RBC's 2-step push did not
resolve. See OPERATIONS section 7 for what is and is not established. Next: read the
Link session log in the Plaid dashboard for the failing step and code; retry from
the phone that holds the RBC app, approving at once; ask Plaid support whether RBC
connects by API or by credentials for this account. Nothing to change in Tally
until that is known (hard rule 3: link behaviour cannot be proved by tests).

## 3d. Flinks as a second bank aggregator (researched 2026-10-09, not built)

Asked whether Tally can use Flinks (Canadian aggregator) for banks Plaid cannot
connect, such as RBC. Not practical for a personal install: Flinks' pricing page
lists plans "designed for production use cases" with a monthly minimum and a one
year term (Connect starts at 500 USD a month for 200 connections), no pay as you
go, no self-serve production, and sandbox access only (a test institution, no live
banks). Nothing on the page addresses individuals or personal projects; a pilot
would need a sales conversation. An adapter would be ordinary work (a
`src/sources/` file like the others, read-only, hard rules 1, 6, 9) if access were
ever granted. Not checked: Wealthica's developer access, which may suit an
individual better.

## 3e. Cursor connector: Allow did nothing (open)

See DECISIONS 2026-10-09. The cause on the owner's phone was not reproduced. If it
recurs after the new page, the page itself says where the browser is being sent:
a `127.0.0.1` or `localhost` destination means the app runs on another device and the
approval must be done there; an `https` destination that fails points at the client.
The Security page lists each client's allowed redirect URI. Open question: accept
custom-scheme redirect URIs (RFC 8252 allows them for native apps; a hostile app
could claim the same scheme), so far deliberately refused.

## 4. Owner-side items still open

See `OWNER-AND-COMMUNITY.md` section 6, and in `TODO.md`: register the OAuth
redirect URI in the Plaid dashboard, enrol two-factor and rotate the temporary
admin password on the live instance, seed RRSP and TFSA limits into `room.json`.
