# Setup

Every credential here is one you create yourself, in your own account. This
server never sees an institution login — the providers hold those, and hand back
read-only tokens.

Work through in this order. Each section stands alone: the SnapTrade, Wise and
FX halves work immediately, and you can leave Plaid until later.

**Before anything else, read [the safety rules](#keeping-it-all-out-of-git).**

---

## 0. Secrets, once

Two values you generate locally and never share:

```bash
openssl rand -hex 32     # MCP_SECRET     — legacy MCP route (see step 5)
openssl rand -hex 32     # TOKEN_ENC_KEY  — encrypts stored tokens at rest
```

`TOKEN_ENC_KEY` is the important one. It encrypts every provider secret and bank
access token in the database. **Back it up somewhere other than the server** — a
password manager is right, the same disk is not. Losing it means re-linking
every bank by hand.

Changing it later does *not* re-encrypt existing rows; they become unreadable.

---

## 1. Admin sign-in (needed for the web UI)

The UI is off unless `UI_ENABLED=true`. When it is on, one username and one
password are the whole account system — there is no registration, no reset
email, no second user.

### Hash the password

The password itself is never stored, and must never be put in an environment
variable. Only its Argon2id hash goes in `.env`:

```bash
npm run hash-password
# Password: (typing is hidden)
#
# ADMIN_PASSWORD_HASH=$argon2id$v=19$m=19456,p=1,t=2$Ej0s...$Uf3k...
```

Copy that whole line into `.env`:

```ini
UI_ENABLED=true
ADMIN_USERNAME=you
ADMIN_PASSWORD_HASH=$argon2id$v=19$m=19456,p=1,t=2$Ej0s...$Uf3k...
```

Three things that bite:

- **Quote it in a shell.** The hash contains `$`, which a shell expands. In
  `.env` it is read literally and needs no quotes; in a `docker run -e` or an
  inline `VAR=... command`, wrap it in **single** quotes or you will silently set
  an empty hash and lock yourself out.
- **12 characters minimum**, enforced by the script. This is the only thing
  between the public internet and every balance and stored bank token.
- `npm run hash-password -- 'mypassword'` works non-interactively but leaves the
  password in your shell history. Prefer the prompt.

To change the password later, run the script again and replace the value. The
old sessions stay valid until you sign out everywhere on the Security page.

### Behind a reverse proxy

```ini
TRUST_PROXY=1        # number of proxy hops (Traefik, nginx, Dokploy = 1)
COOKIE_SECURE=true   # defaults on when TRUST_PROXY > 0
```

Without `TRUST_PROXY`, every request looks like it came from the proxy, and the
per-IP rate limiter becomes one shared bucket for the whole internet.

---

## 2. Two-factor authentication

Do this immediately after your first sign-in. A single password guarding a
public URL with this much on it is not enough.

1. Sign in → **Security**.
2. **Start enrolment.** A secret and a QR-style `otpauth://` URI appear.
3. Add it to any authenticator app (Aegis, 1Password, Bitwarden, Google
   Authenticator — it is standard TOTP, 6 digits, 30 seconds).
4. Enter a current code to **confirm**.

The secret is not saved until a code proves your app holds the same one, so a
half-finished enrolment cannot lock you out. Once on, sign-in is two steps:
password, then code.

To turn it off you must supply a valid current code — someone with only your
password cannot remove it.

**Keep a recovery path.** There are no printed backup codes. If you lose the
authenticator, you need shell access to the server to clear the secret:

```bash
sqlite3 data/finmcp.db "DELETE FROM auth WHERE key = 'totp_secret';"
```

Store the TOTP secret in your password manager when you enrol, and that never
comes up.

---

## 3. SnapTrade — brokerages

Covers Wealthsimple, Questrade, Coinbase and others. Free for personal use.

1. Sign up at [snaptrade.com](https://snaptrade.com) and open the dashboard.
2. **Enable 2FA on your SnapTrade account.** Personal API keys are not offered
   until you do.
3. Create a **Personal** API key. You get a `clientId` and a `consumerKey`.
4. **Connect your brokerages inside the SnapTrade dashboard**, not here. That is
   where you log into Wealthsimple or Questrade; this server never sees it.

```ini
SNAPTRADE_CLIENT_ID=your-client-id
SNAPTRADE_CONSUMER_KEY=your-consumer-key
SNAPTRADE_TRANSPORT=rest
EXCLUDE_SNAPTRADE_CARDS=true
```

Notes:

- A **Personal** key identifies you by the key itself, so `userId`/`userSecret`
  are deliberately not sent. `SNAPTRADE_TRANSPORT=rest` is what omits them. Only
  set `SNAPTRADE_USER_ID`/`SNAPTRADE_USER_SECRET` if you hold a Commercial key.
- Some brokerages surface credit cards through SnapTrade with $0 balances.
  `EXCLUDE_SNAPTRADE_CARDS=true` deactivates them; Plaid owns cards.
- `SNAPTRADE_BALANCE_HISTORY=true` backfills daily net-worth history, which
  otherwise only starts accumulating the day you first sync. Requires the
  add-on on your account; harmless if unavailable.
- Personal keys are for **your own** data. Do not use one to hold anyone else's.

Verify: `npm run sync` should report accounts and holdings under `snaptrade`.

---

## 4. Plaid — banks and cards

The hardest one, and optional. Plaid grants Production access to companies under
a signed agreement; the **Trial** plan is an evaluation tier capped at **10
Items** (linked institutions) per team. Without your own Plaid access, the bank
and card half will not work — everything else still will.

1. Create a team at [dashboard.plaid.com](https://dashboard.plaid.com). Use an
   email that has never had Production or Limited Production access.
2. Apply for the **Trial** plan. You will be asked for a product description —
   it has a minimum length, so write a real paragraph about personal net-worth
   tracking.
3. Copy `client_id` and the **Production** secret (not Sandbox).
4. Under **API → Allowed redirect URIs**, add the URL Link returns to. For the
   local helper:
   `http://localhost:8788/oauth-return`
   For the web UI, add `https://your-host/connections/oauth` as well. Plaid
   rejects Link with `INVALID_FIELD` if the exact URI is not registered.

```ini
PLAID_CLIENT_ID=your-client-id
PLAID_SECRET=your-production-secret
PLAID_ENV=production
PLAID_PRODUCTS=transactions
PLAID_OPTIONAL_PRODUCTS=liabilities,statements
PLAID_COUNTRY_CODES=US,CA
PLAID_TRANSACTION_DAYS=730
PLAID_STATEMENT_MONTHS=24
PLAID_REDIRECT_URI=http://localhost:8788/oauth-return
```

**Required vs optional products matters.** Every product in `PLAID_PRODUCTS`
narrows which institutions Link will even offer — a bank that does not support
one disappears from the picker. Keep required minimal and put everything
nice-to-have in `PLAID_OPTIONAL_PRODUCTS`, which is fetched best-effort and never
blocks a link.

`statements` is handled differently again: naming it in either list would hide
unsupported institutions or bill it on every Item, so it is sent as
`additional_consented_products` — consent collected, nothing initialised until a
statements endpoint is actually called.

**Products are fixed when an Item is linked.** Enabling `statements` later does
nothing for banks you already have — every call returns
`ADDITIONAL_CONSENT_REQUIRED` until each one is re-consented.

To grant it, use **Connections → Enable statements** on each bank and complete
the bank flow. That is a separate button from **Repair**, which only
re-authenticates a broken login — they are kept apart so a consent configuration
Plaid rejects can never stop you fixing a login.

If the consent flow errors, **disconnect the bank and add it again**. A fresh
link always carries the full product set, and is the reliable path.

### Linking banks

Through the web UI: **Connections → Add a bank**. Each profile has its own Plaid
credentials and therefore its own 10-Item allowance, which is how a household
exceeds the cap.

Or locally, without deploying anything:

```bash
npm run link      # http://localhost:8788 — never expose this port
```

`plaid_status` shows every Item's health. One that goes `login_required` is
repaired from Connections, or with `plaid_relink_url`.

---

## 5. Wise — multi-currency balances

1. Wise → **Settings → API tokens** → create a token.
2. Choose **read-only**. This server never needs write access, and a write token
   on a server is a liability with no upside.

```ini
WISE_API_TOKEN=your-read-only-token
WISE_API_BASE=https://api.transferwise.com
```

---

## 6. FX rates

Nothing to configure. Rates come from the Bank of Canada Valet API, which needs
no key. Set `BASE_CURRENCY` if you report in something other than CAD.

---

## 7. Connecting Claude

With the UI on, add `https://your-host/mcp` as a custom connector. Claude sends
you to sign in (password, then authenticator code) and asks you to allow access.
Authorized apps are listed on the Security page and can be revoked there.

The legacy `/mcp/<MCP_SECRET>` route stays available until you set:

```ini
MCP_ALLOW_PATH_SECRET=false
```

Do that once the OAuth connector works. **A secret in a URL path is written to
reverse-proxy access logs on every single request** — Traefik and nginx both do
this by default.

---

## Keeping it all out of git

`.gitignore` already covers `.env`, `data/`, `*.db` and `room.json`. Beyond that:

- **Never commit a real balance, account number, contribution-room figure or
  institution login**, including in a test fixture, an example file or a
  screenshot. Fixtures here use obviously invented values on purpose.
- **Never paste a token, key or real figure into a GitHub issue.** `sync_report`
  output with institution names redacted is almost always enough to debug.
- If you fork this and commit a secret by accident, rotating the secret is the
  fix. Deleting the commit is not — git history is public too, and unreachable
  commits stay reachable by SHA.
- Rotate anything that has ever been in a URL, a shell history file, a CI log or
  a chat message.

## Verifying

```bash
npm run db:init
npm run sync         # unconfigured sources report {skipped}; FX still fetched
npm run check        # typecheck + tests
curl localhost:8787/health
```

`sync_report` tells you which sources are configured, which failed and how
stale the numbers are. An unconfigured source is never an error — it is skipped
and costs nothing.
