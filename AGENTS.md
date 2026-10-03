# Agent instructions

If you are an AI coding agent (or a person) picking this repository up, read these
in order before changing anything:

1. [`CLAUDE.md`](CLAUDE.md): the **hard rules** and the source layout. They exist
   because each one was learned the hard way.
2. [`docs/context/README.md`](docs/context/README.md): the project's memory (what
   Tally is, how it is built, every feature, the full history, how to run and
   verify it, the owner's preferences, and what is still open). Start there.

Non-negotiables in one breath: Tally is **read-only** forever; the repository is
**public**, so never write a real balance, account number, token, personal domain
or real transaction data into any file, test, screenshot or commit message; run
`npm run check` before every commit; **a push to `main` deploys** the owner's
instance; and **keep `docs/context/` current in the same commit as every change**
(hard rule 20 in `CLAUDE.md`). `test/context-docs.test.ts` fails when the code and
`docs/context/PROJECT.md` drift apart.
