# Backlog: what is open

Anything found but not fixed, anything undecided, anything promised. Move an item
out when it is done and say so in [`HISTORY.md`](HISTORY.md). Older phase
checklists remain in [`TODO.md`](../../TODO.md) (still the source for the
credential-dependent items there).

## 1. Decisions waiting for the owner

1. **Should a mortgage payment count as spending by default?** Today it does not:
   Plaid files it as `LOAN_PAYMENTS_MORTGAGE_PAYMENT`, which is in the excluded set
   in every category mode, so it is hidden from spending and income (it shows on the
   Transactions tab when transfers are shown). A user asked whether it counts as an
   expense or is hidden because both sides cancel. Honest answer: it is hidden by
   design for card payments (the purchases are counted one by one) but a mortgage
   has no purchases to count, so excluding it **understates** spending; both sides
   do not cancel unless the mortgage account is also linked. Workaround that works
   today and is verified: `add_category` "Mortgage" under Home gives `HOME_MORTGAGE`;
   file the lender under it and it counts everywhere at once.
   Options: (a) leave as is and document; (b) add "Home › Mortgage" to the grouped
   list as a hand-pick entry; (c) a setting to count mortgage payments as spending,
   which needs thought about a linked mortgage account (its credit side must stay
   excluded) and about interest versus principal. Recommendation: (b) now, (c) if
   more people ask.
2. **Reports screen.** The owner said the Reports screen will be revisited after
   more use. Wait for their notes before changing it.
3. **The leaked domain in git history.** Commit `7c35752` added the live domain to
   `DECISIONS.md` (removed from the current tree on 2026-10-02). Removing it from
   history needs a force-push of a public repository, which the agent will not do
   without the owner's explicit say. Low impact if the domain is already public.

## 2. Open work and ideas (none promised)

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

## 4. Owner-side items still open

See `OWNER-AND-COMMUNITY.md` section 6, and in `TODO.md`: register the OAuth
redirect URI in the Plaid dashboard, enrol two-factor and rotate the temporary
admin password on the live instance, seed RRSP and TFSA limits into `room.json`.
