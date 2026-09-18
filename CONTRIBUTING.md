# Contributing

Thanks for looking. This is a small, opinionated project — read this first so a
pull request doesn't hit a rule it couldn't have known about.

## The rules that are not negotiable

`CLAUDE.md` holds the full list; these are the ones that get PRs closed:

1. **Read-only, permanently.** Nothing here may place an order, move money, or
   change a setting at an institution. Plaid products stay limited to
   `transactions`, `liabilities` and `statements`.
2. **Statement PDFs are never persisted.** They are streamed through memory and
   handed to the caller — no cache, no temp file, no database column.
3. **Signs.** Assets positive, liabilities negative. Transactions are stored
   Plaid-style (positive = money out) and negated on read. Touching a source
   adapter means adding a sign test.
4. **All FX goes through `src/fx.ts`.** A missing rate is reported, never
   silently passed off as CAD.
5. **Never scrape.** Official APIs only.

## How to send a change

There is no write access to this repository for anyone else, and that is fine —
**fork it and open a pull request.** The whole loop:

```bash
# 1. Fork on GitHub (the Fork button, top right), then clone your fork
git clone https://github.com/<your-username>/Tally.git
cd Tally
git remote add upstream https://github.com/yrameshk26/Tally.git

# 2. Branch. Never work on main — it makes the next sync painful for you.
git checkout -b fix/wise-rate-rounding

# 3. Make the change, then prove it
npm run check      # typecheck + the full test suite; both must be clean

# 4. Push to your fork and open the PR against yrameshk26/Tally:main
git push -u origin fix/wise-rate-rounding
```

GitHub then offers a "Compare & pull request" button on your fork. In the
description, say what broke, what you changed, and how you tested it — against
`npm run demo` data is fine, and is the only way to show a bug publicly without
posting your own balances.

Small PRs get read and merged; a large one that rewrites a subsystem will sit,
so open an issue first for anything big and we'll agree the shape before you
spend an evening on it. Draft PRs are welcome if you want early feedback.

## Before you open a PR

Then, per `CLAUDE.md` rule 10, update `README.md` and `CLAUDE.md` in the *same*
commit: a new tool goes in the tool table, a new page in the Web UI section, a
new env var wherever its neighbours are documented, a new invariant as a hard
rule. The test is whether someone reading only those two files would be
surprised by your code.

Conventional commits, one per completed change.

## What makes a good issue

This project talks to real financial APIs, so "it doesn't work" is hard to act
on. Useful reports say which provider, what `sync_report` returned, and what you
expected instead. **Never paste an access token, API key, account number or a
real balance into an issue** — redact them. If a bug can only be shown with real
data, say so and we'll work out a minimal reproduction together.

## Things likely to be accepted

- Source adapters for other institutions or countries, behind the same
  read-only contract.
- Registered-account types for other tax regimes (the classifier in
  `src/lib/registered.ts` is Canada-shaped today).
- Correctness fixes with a test that fails before and passes after.
- Anything that removes a dependency.

## Things likely to be declined

- Write access to any institution, in any form.
- Multi-tenancy, a user table, or an auth framework. One household, one process.
- Budgeting rules engines — Claude does that conversationally, and the tools
  already expose the data.
- A charting library. `src/web/charts.ts` is a few hundred lines of SVG and
  keeps the CSP strict and the dependency count near zero.

## Security

Please don't open a public issue for a vulnerability. See
[SECURITY.md](SECURITY.md) — GitHub Security Advisories are enabled.
