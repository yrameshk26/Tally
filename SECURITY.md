# Security policy

tally is self-hosted software that holds credentials to bank and brokerage
accounts. Please read this before deploying it.

## Reporting a vulnerability

Report privately via [GitHub Security
Advisories](https://github.com/yrameshk26/tally/security/advisories/new).
Please do not open a public issue for a security problem.

Include what you did, what happened, and what you expected. A proof of concept
against your own deployment helps. Expect an acknowledgement within a few days;
this is a personal project maintained in spare time, so please be patient, and
please give a reasonable window before public disclosure.

## Supported versions

Only `main` is supported. There are no backported fixes.

## What this software does with your secrets

| Secret | Where it lives | Notes |
|---|---|---|
| `MCP_SECRET` | env, and in the connector URL path | Anyone holding the URL has full read access |
| `TOKEN_ENC_KEY` | env | Encrypts Plaid access tokens at rest (AES-256-GCM) |
| Plaid `access_token` | database, encrypted when `TOKEN_ENC_KEY` is set | Long-lived. Grants read access to that bank |
| `PLAID_SECRET`, `SNAPTRADE_CONSUMER_KEY`, `WISE_API_TOKEN` | env | Plaintext at rest in your host's env store |

`src/lib/logger.ts` redacts anything whose key looks like a token or secret
before writing a log line. Do not bypass it.

## Threat model — read this before you deploy

**The MCP URL is a bearer token.** Authentication is the unguessable secret in
the path. That means the full URL leaks the way URLs leak: browser history,
screen shares, clipboards, and **reverse-proxy access logs**. If you deploy
behind Traefik, nginx or Caddy with access logging on — which is the default in
many setups, including Dokploy — your secret is written to disk on every
request. Either disable path logging for that route, set aggressive log
rotation, or accept it and rotate `MCP_SECRET` periodically. Rotation is one env
change plus re-adding the connector.

**Encryption at rest is not encryption in use.** `TOKEN_ENC_KEY` protects the
database file — a leaked backup, a volume snapshot, a stolen disk. It does not
protect a running server: a process holding the key can decrypt everything. An
attacker with code execution on the host gets your Plaid tokens.

**Losing `TOKEN_ENC_KEY` is unrecoverable.** The encrypted Plaid tokens become
unreadable and you must re-link every institution. Back it up separately from
the database.

**Read-only is about the institutions, not about the server.** No code path here
can place an order or move money — that is enforced by which endpoints exist
(see rule 1 in `CLAUDE.md`). It is not a claim that the server itself is
impossible to compromise, and the stored tokens are still worth stealing.

**Rate limiting is per-process and in-memory.** It resets on restart and does
not coordinate across replicas. Set `TRUST_PROXY` to the number of proxy hops in
front of the app, or every request appears to come from the proxy and the limit
becomes one bucket shared by the whole internet.

**Third-party strings are untrusted.** Merchant names, transaction
descriptions and security names come from institutions and, ultimately, from
whoever typed the memo field on a transfer. They are safe as MCP text. If you
add an HTML UI, escape them — they are a stored-XSS vector.

## The web UI

`UI_ENABLED` defaults to false, and the UI refuses to mount without
`ADMIN_USERNAME`, an Argon2id `ADMIN_PASSWORD_HASH` and `TOKEN_ENC_KEY`.

What it enforces: Argon2id at the OWASP minimum (19 MiB, t=2, p=1); a
per-session CSRF token on every state-changing request; `HttpOnly`,
`SameSite=Lax` and (behind a proxy) `Secure` session cookies held server-side so
sign-out is real; a failure-only sign-in limiter checked before password
verification; TOTP that is never persisted until a code proves enrolment
succeeded, and that requires a current code to disable; and a CSP of
`default-src 'none'` with nonces, whose only third-party allowance is Plaid Link
on the one page that needs it.

What it does not do: there is one account, so there is no password reset, no
lockout recovery and no audit trail beyond the sessions list. If you lose the
password, change `ADMIN_PASSWORD_HASH` in the environment and restart.

**Consider not exposing it publicly at all.** Only the MCP endpoint needs to be
reachable from the internet; the UI only needs to be reachable by your browser.
Putting it behind a VPN or an identity-aware proxy removes most of the above
from your threat model.

## Hardening checklist

- [ ] `MCP_SECRET` at least 32 bytes from a CSPRNG (`openssl rand -hex 32`)
- [ ] `TOKEN_ENC_KEY` set, and backed up somewhere other than the server
- [ ] `TRUST_PROXY` matches your actual deployment
- [ ] HTTPS only; never expose port 8787 directly
- [ ] Port 8788 (the Plaid Link helper) never exposed — it is stripped from the
      Docker image, but do not run it on a public host
- [ ] Reverse-proxy access logs rotated, or path logging disabled
- [ ] Database volume backed up, and those backups treated as secret
- [ ] If `UI_ENABLED=true`: two-factor enrolled, `ADMIN_PASSWORD_HASH` is a real
      Argon2id hash, and the password is long and unique
