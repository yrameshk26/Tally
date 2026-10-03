# The owner, the community, and how to work with them

Everything here is a working preference or constraint stated by the owner (the
repository owner, public handle `yrameshk26`), or the record of community feedback
that shaped the product. Update it when the owner states something new.

## 1. What the owner wants from Tally

- **MCP first.** Tally was started mainly so the owner could ask Claude about
  money ("where did my money go this month", "how much did we spend eating out",
  "how is net worth trending"). Claude has been very useful for budget and
  net-worth questions on the owner's own data. The MCP is not Claude-only: any AI
  app that supports MCP connectors can use it.
- **The UI is secondary, but real.** The owner is happy for the UI to improve and
  wants it to stand on its own (a person without an AI subscription should still get
  value), at least comparable to a bank's own budgeting view. A built-in assistant
  with the user's own API key covers people who do not want an outside app.
- **Open source, free to self-host,** with community contribution welcome. The
  owner asks users to fork and open pull requests, star the repository, and
  suggests hosting it somewhere always on (a small VPS, a home server, a PaaS) rather
  than only locally, so the nightly sync runs and MCP works from a phone.
- The owner welcomes suggestions and counter-suggestions and does not want the
  product bent by one voice. When feedback arrives, **say honestly whether it
  already exists, whether it is really worth building, and push back where it does
  not fit** (the tag design is an example: per-trip tags rather than one "vacation"
  tag). Build only what is really worth it.

## 2. How to work with the owner

- **Short, direct replies.** No long preambles. Report what changed, what was
  verified, and what is left, in that order.
- **"Don't change right away" means draft first.** When the owner asks for an
  analysis or a reply to a user and says not to change anything, do not touch code
  until they say go ("go ahead and build ...").
- **Decide conventional things; ask about real forks.** Pick the obvious default and
  say so. The owner has been asked, via a structured question, for genuine product
  decisions (the idle-timeout default, whether to build a category list as the
  default). Do not ask about things the code or sensible defaults answer.
- **Ship it.** After a verified change, commit, push to `main` (which deploys), and
  confirm the deploy. The owner said "deploy it" and relies on autoDeploy.
- **Verify before claiming.** The owner's real data is behind the live instance;
  check behaviour there with read-only calls and report real outcomes plainly,
  including failures and what was not verified.
- **Explain consequences, not just changes**: e.g. why a total moved, what a button
  will do to existing connections.

## 3. Voice for posts and replies (Reddit, LinkedIn, comments)

The owner posts these themselves; the agent drafts them.

- **No em dashes. Short, plain, human-sounding. Not AI-sounding.** Straight to the
  point. For Reddit replies: "keep it simple, keep it short", usually a few
  sentences, in a block quote so it can be pasted.
- Say what was done and how to get it ("pull the latest"), not a changelog.
- Where it fits: thank them, say keep the feedback coming, invite a fork and pull
  request on GitHub, ask for a star, mention **MCP works with any AI app**, mention
  the **built-in assistant uses your own API key (Anthropic, OpenAI or
  OpenRouter)**, say the main focus was the MCP, suggest hosting it always on.
- The owner's other app (a credit-card churning tracker, available on both app
  stores) may be mentioned as a short, light plug when the person is into it. The
  owner supplies the link when wanted; **do not store it in the repository** and do
  not invent features for it.
- Early LinkedIn and Reddit posts were drafted around: why it was built; the main
  purpose being a financial MCP; no bank offers an MCP and there is no free MCP
  connector; you cannot ask an AI "how much did I spend on groceries" today; Plaid
  cannot be used directly by an individual; free to self-host; the UI with stats and
  a chatbot using your own key; ask for contributions; MCP stated in the title.
- Reddit cannot be fetched by the agent (the request is refused), so the owner pastes
  the comment text or screenshots.

## 4. Standing constraints (never relax these without the owner saying so)

- **Read-only, permanently.** Never order, transfer, or change an institution's
  settings; never call SnapTrade order endpoints (hard rule 1).
- Statement PDFs are never persisted. Secrets live in `.env` or the encrypted
  settings store, never in git or logs. Never commit `data/`, `.env`, `room.json`.
- **The repository is public.** No real balance, account number, contribution-room
  figure, institution login, API key, session link, or personal domain, in any
  file, test fixture, screenshot or commit message. Screenshots come only from the
  fictional demo.
- Never scrape Wealthsimple (or anything). The Plaid Link helper never deploys.
- Posts and replies: no em dashes, short, human.
- Keep the project documentation current in the same commit, including
  `docs/context/` (hard rules 18 and 20).

## 5. Community feedback ledger

All of the below shipped unless marked. Requests came through Reddit comments
(relayed by the owner as text or screenshots) and the owner's own use.

| Request | Outcome |
|---|---|
| Monthly and annual summary, printable | Reports page and `get_period_report` (`fa3874d`) |
| Card payments and transfers should not count as spending | Hidden by default, one definition everywhere (`fa3874d`, `2f779eb`) |
| Rename the app | `APP_NAME` setting (`cb2bf92`) |
| Plaid redirect URI mismatch behind a proxy chain | `originOf`, `PLAID_REDIRECT_URI` honoured (`cb2bf92`, `e294f00`) |
| Custom logo | Raster upload (`134db2b`) |
| Modern UI | Sidebar shell, dark mode (`03791e9`) |
| Merchants: category filter, bulk categorise | `e294f00` |
| Separate Rent and Utilities | `e294f00` |
| Back link from a hidden transaction; first-of-month default date; Month field on Reports | `e294f00` |
| Light mode | Theme switch (`03791e9`, `e294f00`) |
| Fidelity-like categories | Detailed (`5ea123c`), grouped list (`14b7651`) |
| A trip or business tag on top of a category | Tags (`d6c6225`); checkboxes to skip rows (`f203e33`) |
| Transactions back to January 2026 | Two-year history, `PLAID_TRANSACTION_DAYS`, relink handover (`1c97545`, `7d80a7e`) |
| "Rent" under Income | Subcategories of your own (`469b9bb`) |
| Tally should not need a Claude subscription to be useful | Principle: the UI keeps getting the basics; see section 1 |
| Costco gas versus the warehouse club | Advised: a `contains` rule on the gas station's bank text; not yet confirmed by the user (`BACKLOG.md`) |
| Is a mortgage payment an expense or hidden? | It was hidden as a loan payment, which understated spending; now counted as Home › Mortgage by default (2026-10-03) |

## 6. Things only the owner can do

- Enable GitHub Discussions, tag a `v0.1.0` release, set up GitHub Sponsors
  (`.github/FUNDING.yml` exists), set repository topics and description (the agent's
  tools could not).
- Anything in a provider's dashboard: the Plaid redirect URI, credentials, plan
  limits; the deployment host's settings.
- Repairing or re-authenticating a bank connection with the right bank login.
- Rotating the temporary admin password and enrolling two-factor on the live
  instance (open items in `TODO.md`).
- Posting replies, and deciding open product questions in `BACKLOG.md`.
