# Agent context: start here

This directory is the project's memory. It exists so that a different agent (or
a person), starting cold, can pick up exactly where the last one stopped without
reading a chat transcript. It is written for that reader, and it is kept current
by rule (see "Keeping it current" below).

Snapshot: **2026-10-02**, `main` at `f203e33` plus the commit that added this
directory. `npm run check` is green (typecheck plus the vitest suite).

## What Tally is, in four lines

- A personal, **read-only** net-worth and spending server for one household
  (up to five profiles). Open source, MIT, self-hosted, free.
- The **main purpose is the MCP server**: the owner connects it to Claude (any
  MCP client works) and asks questions about money. The web UI is secondary but
  is meant to be good enough that nobody needs an AI subscription to get value.
- Data comes from Plaid (banks and cards), SnapTrade (brokerages) and Wise,
  into one SQLite file. Everything is reported in CAD.
- It is deployed on the owner's own server and redeploys on every push to
  `main`. The repository is **public**.

## Read order

| If you want to | Read |
|---|---|
| Understand the system: architecture, data model, flows, tools, routes, config | [`PROJECT.md`](PROJECT.md) |
| Know what every feature does, where it lives, what pins it | [`FEATURES.md`](FEATURES.md) |
| Know how we got here, in order, with the reasons | [`HISTORY.md`](HISTORY.md) |
| Run it, test it, verify a change in a browser, deploy, avoid known traps | [`OPERATIONS.md`](OPERATIONS.md) |
| Know the owner's preferences, tone, standing constraints, and the community workflow | [`OWNER-AND-COMMUNITY.md`](OWNER-AND-COMMUNITY.md) |
| Know what is open, undecided, or broken | [`BACKLOG.md`](BACKLOG.md) |

Elsewhere in the repo (these stay authoritative for what they cover, and this
directory links to them instead of copying them):

- [`CLAUDE.md`](../../CLAUDE.md): the **hard rules** (read before changing
  anything) and the source layout. Rule 20 requires this directory to be kept
  current.
- [`DECISIONS.md`](../../DECISIONS.md): dated, append-only reasons for choices.
- [`README.md`](../../README.md): the user-facing documentation and the tool table.
- [`docs/SETUP.md`](../SETUP.md): provider credentials, sign-in, 2FA, proxies.
- [`DEPLOY.md`](../../DEPLOY.md): Docker and Dokploy.
- [`TODO.md`](../../TODO.md) and [`CHANGELOG.md`](../../CHANGELOG.md).

## Five-minute orientation for a new agent

1. Read `CLAUDE.md` (hard rules), then `PROJECT.md` sections 1 to 4.
2. `npm ci && npm run check` to see it green. Start the demo server with the
   recipe in `OPERATIONS.md` and click through it; that is the fastest way to
   learn the product.
3. Read `OWNER-AND-COMMUNITY.md`: tone and constraints matter as much as code.
4. Read `BACKLOG.md` to see what is open, then `HISTORY.md` (latest entries) to
   see what just happened.
5. Before every change: `npm run check` must be clean before you commit.

## Keeping it current (this is a rule, not a courtesy)

Every change that is committed updates the matching files here **in the same
commit**, exactly like `README.md` and `CLAUDE.md` (hard rule 18). The test
`test/context-docs.test.ts` fails when the code and `PROJECT.md` drift apart
(a new source file, table, MCP tool, environment variable or setting that is
not documented), and when a personal identifier appears in a tracked Markdown
file. It cannot judge prose, so use this table:

| You changed | Update |
|---|---|
| any behaviour a user can see | `FEATURES.md` (the feature's entry), `README.md` |
| a source file, table, column, tool, route, env var or setting | `PROJECT.md` (the matching table), and `CLAUDE.md` Layout if it is a `src/` module |
| anything, at all | append a dated entry to `HISTORY.md` (what, why, commit, how it was verified) |
| a choice with alternatives | `DECISIONS.md` (dated), and link it from `HISTORY.md` |
| something found but not fixed, or a decision left open | `BACKLOG.md` |
| something done that was in `BACKLOG.md` | move it out of `BACKLOG.md`, and say so in `HISTORY.md` |
| how to run, test, verify or deploy | `OPERATIONS.md` |
| the owner states a preference or constraint | `OWNER-AND-COMMUNITY.md` |
| the test count | `README.md` (Development table) and the snapshot line above |

Write for the next reader: say **why**, name the file, and record what you
**verified** and how, not only what you changed. Dates are absolute
(`2026-10-02`), never "yesterday".

## This repository is public: what must never be written here

Nothing in any tracked file, including these notes, may contain:

- a real balance, account number, contribution-room figure, institution login,
  API key, token, session link, or **the owner's live domain or any other
  personal domain**;
- real transaction, merchant or institution data from the owner's accounts, or
  anything that identifies the owner's household beyond the public GitHub
  handle that is already in the repository;
- screenshots of a live instance (`docs/screenshots/` is generated from the
  fictional `npm run demo` only).

Operational values that are needed to work on the live deployment (its address,
the deploy host's API credentials, the Plaid dashboard) are **not in the
repository**. `OPERATIONS.md` lists which ones exist and who holds them; ask the
owner for them at the start of a session that needs them.
