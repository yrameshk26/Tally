/**
 * Page bodies. Every institution-supplied string (account name, merchant,
 * security description) goes through the escaping template — see lib/html.ts
 * for why that matters here specifically.
 */
import { esc, html, join, money, raw, type SafeHtml } from '../lib/html.ts';
import { csrfField, notice } from './layout.ts';
import type { AccountView, HoldingsResult } from '../queries.ts';
import type { NetWorthTotals } from '../snapshots.ts';
import type { ManagedKey } from '../settings.ts';
import type { Profile } from '../profiles.ts';

const sign = (n: number): SafeHtml =>
  html`<span class="${n < 0 ? 'neg' : n > 0 ? 'pos' : 'muted'}">${money(n)}</span>`;

export function loginPage(opts: {
  csrf: string;
  totpEnabled: boolean;
  error?: string;
  username?: string;
}): SafeHtml {
  return html`<div class="login">
    <h1>tally</h1>
    <p class="sub">Sign in to manage connections and view your summary.</p>
    ${opts.error ? notice('err', opts.error) : raw('')}
    <section>
      <form method="post" action="/login">
        ${csrfField(opts.csrf)}
        <div class="field">
          <label for="u">Username</label>
          <input id="u" name="username" autocomplete="username" required value="${opts.username ?? ''}">
        </div>
        <div class="field">
          <label for="p">Password</label>
          <input id="p" name="password" type="password" autocomplete="current-password" required>
        </div>
        ${
          opts.totpEnabled
            ? html`<div class="field">
                <label for="c">Authenticator code</label>
                <input id="c" name="code" inputmode="numeric" autocomplete="one-time-code"
                       pattern="[0-9]*" maxlength="6" required>
              </div>`
            : raw('')
        }
        <button type="submit">Sign in</button>
      </form>
    </section>
  </div>`;
}

export function overviewPage(opts: {
  totals: NetWorthTotals;
  profiles: Profile[];
  accounts: AccountView[];
  holdings: HoldingsResult;
  lastSync: string | null;
  fxAsOf: string | null;
  csrf: string;
  flash?: SafeHtml;
}): SafeHtml {
  const { totals, accounts, holdings } = opts;
  const cards = accounts.filter((a) => a.category === 'LOC' || a.category === 'LOAN');
  const assets = accounts.filter((a) => a.balance_cad >= 0);

  const bucket = (label: string, rec: Record<string, number>): SafeHtml =>
    Object.keys(rec).length === 0
      ? raw('')
      : html`<section>
          <h2>${label}</h2>
          <table><tbody>${join(
            Object.entries(rec)
              .sort((a, b) => b[1] - a[1])
              .map(([k, v]) => html`<tr><td>${k}</td><td class="num">${sign(v)}</td></tr>`),
          )}</tbody></table>
        </section>`;

  const staleness =
    opts.lastSync === null
      ? notice('warn', 'No sync has completed yet. Add credentials under Settings, then sync.')
      : Date.now() - Date.parse(opts.lastSync) > 36 * 3_600_000
        ? notice('warn', `Data last refreshed ${esc(opts.lastSync.slice(0, 16).replace('T', ' '))} UTC — that is more than a day and a half ago.`)
        : raw('');

  return html`
    <h1>Overview</h1>
    <p class="sub">
      All figures in CAD. Assets positive, liabilities negative.
      ${opts.fxAsOf ? html`FX as of ${opts.fxAsOf}.` : raw('')}
      ${opts.lastSync ? html`Last sync ${opts.lastSync.slice(0, 16).replace('T', ' ')} UTC.` : raw('')}
    </p>
    ${opts.flash ?? raw('')}
    ${staleness}

    <div class="kpis">
      <div class="kpi"><div class="label">Net worth</div><div class="value">${money(totals.net_worth_cad)}</div></div>
      <div class="kpi"><div class="label">Assets</div><div class="value pos">${money(totals.total_assets_cad)}</div></div>
      <div class="kpi"><div class="label">Liabilities</div><div class="value ${totals.total_liabilities_cad < 0 ? 'neg' : 'muted'}">${money(totals.total_liabilities_cad)}</div></div>
      <div class="kpi"><div class="label">Invested</div><div class="value">${money(holdings.total_invested_cad)}</div></div>
    </div>

    <div class="row" style="margin-bottom:1.1rem">
      <form method="post" action="/sync">${csrfField(opts.csrf)}<button type="submit">Refresh now</button></form>
      <span class="muted">Pulls fresh balances, holdings and transactions. Read-only.</span>
    </div>

    ${bucket('By registered type', totals.by_registered_type)}
    ${bucket('By profile', totals.by_profile)}

    ${
      cards.length
        ? html`<section>
            <h2>Cards and loans</h2>
            <table>
              <thead><tr><th>Account</th><th>Institution</th><th class="num">Balance</th><th class="num">Statement</th><th class="num">Minimum</th><th>Due</th></tr></thead>
              <tbody>${join(
                cards.map(
                  (c) => html`<tr>
                    <td>${c.name ?? c.id}${c.mask ? html` <span class="muted">••${c.mask}</span>` : raw('')}</td>
                    <td class="muted">${c.institution ?? '—'}</td>
                    <td class="num">${sign(c.balance_cad)}</td>
                    <td class="num">${c.card?.['statement_balance'] != null ? money(Number(c.card['statement_balance'])) : html`<span class="muted">—</span>`}</td>
                    <td class="num">${c.card?.['minimum_payment'] != null ? money(Number(c.card['minimum_payment'])) : html`<span class="muted">—</span>`}</td>
                    <td>${c.card?.['due_date'] ? String(c.card['due_date']).slice(0, 10) : html`<span class="muted">—</span>`}</td>
                  </tr>`,
                ),
              )}</tbody>
            </table>
          </section>`
        : raw('')
    }

    <section>
      <h2>Accounts</h2>
      ${
        assets.length === 0
          ? html`<p class="muted">No accounts yet. Add provider credentials under
              <a href="/settings">Settings</a>, then link institutions under
              <a href="/connections">Connections</a>.</p>`
          : html`<table>
              <thead><tr><th>Account</th><th>Institution</th><th>Type</th><th>Owner</th><th class="num">Balance</th></tr></thead>
              <tbody>${join(
                assets.map(
                  (a) => html`<tr>
                    <td>${a.name ?? a.id}${a.mask ? html` <span class="muted">••${a.mask}</span>` : raw('')}</td>
                    <td class="muted">${a.institution ?? '—'}</td>
                    <td><span class="pill">${a.registered_type}</span></td>
                    <td>${
                      opts.profiles.length > 1
                        ? html`<form method="post" action="/accounts/move" class="row" style="gap:.3rem">
                            ${csrfField(opts.csrf)}
                            <input type="hidden" name="account_id" value="${a.id}">
                            <select name="profile" onchange="this.form.submit()">
                              ${join(
                                opts.profiles.map(
                                  (pr) =>
                                    html`<option value="${pr.id}"${pr.id === a.profile ? raw(' selected') : raw('')}>${pr.name}</option>`,
                                ),
                              )}
                            </select>
                          </form>`
                        : html`<span class="muted">${a.profile}</span>`
                    }</td>
                    <td class="num">${sign(a.balance_cad)}${a.currency !== 'CAD' ? html`<div class="muted" style="font-size:.78rem">${a.balance.toLocaleString()} ${a.currency}</div>` : raw('')}</td>
                  </tr>`,
                ),
              )}</tbody>
            </table>`
      }
    </section>

    ${
      holdings.positions.length
        ? html`<section>
            <h2>Holdings</h2>
            <table>
              <thead><tr><th>Symbol</th><th>Description</th><th class="num">Units</th><th class="num">Value</th><th class="num">Weight</th><th class="num">Unrealized</th></tr></thead>
              <tbody>${join(
                holdings.positions.slice(0, 25).map(
                  (p) => html`<tr>
                    <td><strong>${p.symbol}</strong></td>
                    <td class="muted">${p.description ?? '—'}</td>
                    <td class="num">${p.quantity.toLocaleString()}</td>
                    <td class="num">${money(p.market_value_cad)}</td>
                    <td class="num">${p.weight_pct.toFixed(1)}%</td>
                    <td class="num">${p.unrealized_pnl_cad === null ? html`<span class="muted">—</span>` : sign(p.unrealized_pnl_cad)}</td>
                  </tr>`,
                ),
              )}</tbody>
            </table>
          </section>`
        : raw('')
    }`;
}

export type SettingView = {
  key: ManagedKey;
  source: 'database' | 'environment' | 'default' | 'unset';
  secret: boolean;
  value: string | null;
  effective: string | null;
  configured: boolean;
};

export type CredentialCheckView = {
  provider: string;
  configured: boolean;
  ok: boolean;
  detail: string;
};

const LABELS: Record<string, { label: string; hint: string }> = {
  SNAPTRADE_CLIENT_ID: { label: 'SnapTrade client ID', hint: 'SnapTrade dashboard → Personal API key.' },
  SNAPTRADE_CONSUMER_KEY: { label: 'SnapTrade consumer key', hint: 'Secret. Stored encrypted; never shown again.' },
  SNAPTRADE_TRANSPORT: { label: 'SnapTrade transport', hint: '“rest” omits userId/userSecret, which Personal keys require.' },
  PLAID_CLIENT_ID: { label: 'Plaid client ID', hint: 'Plaid dashboard → Team Settings → Keys.' },
  PLAID_SECRET: { label: 'Plaid secret', hint: 'Secret. Use the Production secret when PLAID_ENV is production.' },
  PLAID_ENV: { label: 'Plaid environment', hint: 'production or sandbox.' },
  WISE_API_TOKEN: { label: 'Wise API token', hint: 'Secret. Create a read-only token in Wise settings.' },
};

export function settingsPage(opts: {
  settings: SettingView[];
  profiles: Profile[];
  activeProfile: Profile;
  csrf: string;
  flash?: SafeHtml;
  encryptionReady: boolean;
  checks?: CredentialCheckView[] | null;
}): SafeHtml {
  const field = (s: SettingView): SafeHtml => {
    const meta = LABELS[s.key] ?? { label: s.key, hint: '' };
    const badge =
      s.source === 'database'
        ? html`<span class="pill ok">saved</span>`
        : s.source === 'environment'
          ? html`<span class="pill warn">from env</span>`
          : s.source === 'default'
            ? html`<span class="pill warn">using default</span>`
            : html`<span class="pill">not set</span>`;
    // An unset field that silently falls back to a default is shown as a
    // placeholder, so the page never implies "nothing is configured" when the
    // code is in fact about to use a real value.
    const placeholder = s.secret
      ? s.configured
        ? '•••••••• (unchanged)'
        : ''
      : (s.source === 'default' ? `${s.effective} (default)` : '');
    return html`<div class="field">
      <label for="${s.key}">${meta.label} ${badge}</label>
      <input id="${s.key}" name="${s.key}"
             type="${s.secret ? 'password' : 'text'}"
             autocomplete="off" spellcheck="false"
             value="${s.secret ? '' : (s.value ?? '')}"
             placeholder="${placeholder}">
      <div class="hint">${meta.hint}${s.secret && s.configured ? ' Leave blank to keep the current value.' : ''}${s.source === 'default' ? ` Nothing is set, so “${s.effective}” is being used.` : ''}</div>
    </div>`;
  };

  const group = (title: string, keys: string[]): SafeHtml => html`<section>
    <h2>${title}</h2>
    ${join(opts.settings.filter((s) => keys.includes(s.key)).map(field))}
  </section>`;

  return html`
    <h1>Settings</h1>
    <p class="sub">Provider credentials for <strong>${opts.activeProfile.name}</strong>. Each
      profile has its own keys — that is what gives it a separate bank-connection allowance.
      Saved values override the environment and take effect on the next sync without a redeploy.</p>
    ${profileTabs(opts.profiles, opts.activeProfile.id, '/settings')}
    ${opts.flash ?? raw('')}
    ${
      opts.encryptionReady
        ? raw('')
        : notice('err', 'TOKEN_ENC_KEY is not set, so secrets cannot be stored in the database. Set it and restart before saving.')
    }
    <form method="post" action="/settings">
      ${csrfField(opts.csrf)}
      ${group('SnapTrade — brokerages', ['SNAPTRADE_CLIENT_ID', 'SNAPTRADE_CONSUMER_KEY', 'SNAPTRADE_TRANSPORT'])}
      ${group('Plaid — banks and cards', ['PLAID_CLIENT_ID', 'PLAID_SECRET', 'PLAID_ENV'])}
      ${group('Wise — multi-currency', ['WISE_API_TOKEN'])}
      <input type="hidden" name="profile" value="${opts.activeProfile.id}">
      <div class="row"><button type="submit">Save credentials</button>
        <span class="muted">Secrets are encrypted at rest and never displayed again.</span></div>
    </form>

    <section style="margin-top:1.1rem">
      <h2>Check credentials</h2>
      <p class="hint" style="margin-bottom:.9rem">Runs one cheap read-only call per provider, so a
        wrong key is found here rather than halfway through a bank login.</p>
      ${
        opts.checks && opts.checks.length
          ? html`<table>
              <thead><tr><th>Provider</th><th>Result</th></tr></thead>
              <tbody>${join(
                opts.checks.map(
                  (c) => html`<tr>
                    <td>${c.provider}</td>
                    <td>${
                      !c.configured
                        ? html`<span class="pill">not configured</span>`
                        : c.ok
                          ? html`<span class="pill ok">ok</span> <span class="muted">${c.detail}</span>`
                          : html`<span class="pill bad">failed</span> <span class="muted">${c.detail}</span>`
                    }</td>
                  </tr>`,
                ),
              )}</tbody>
            </table>`
          : raw('')
      }
      <form method="post" action="/settings/test" style="margin-top:.9rem">
        ${csrfField(opts.csrf)}
        <input type="hidden" name="profile" value="${opts.activeProfile.id}">
        <button class="secondary" type="submit">Test all providers</button>
      </form>
    </section>`;
}

/** Profile switcher shared by the pages that are scoped to one. */
export function profileTabs(profiles: Profile[], activeId: string, basePath: string): SafeHtml {
  if (profiles.length <= 1) return raw('');
  return html`<div class="row" style="margin-bottom:1.1rem">${join(
    profiles.map(
      (p) =>
        html`<a class="btn ${p.id === activeId ? '' : 'secondary'}"
              href="${basePath}?profile=${encodeURIComponent(p.id)}">${p.name}</a>`,
    ),
  )}</div>`;
}

export function profilesPage(opts: {
  profiles: Array<Profile & { usage: { accounts: number; plaid_items: number; settings: number } }>;
  max: number;
  csrf: string;
  flash?: SafeHtml;
}): SafeHtml {
  return html`
    <h1>Profiles</h1>
    <p class="sub">A profile is a person or bucket <em>and</em> its own set of provider
      credentials. Plaid caps Items at 10 per team, so a second profile with its own Plaid keys
      is a second allowance — ${String(opts.max)} profiles means up to ${String(opts.max * 10)} linked banks.</p>
    ${opts.flash ?? raw('')}

    <section>
      <h2>Your profiles <span class="muted">(${String(opts.profiles.length)} of ${String(opts.max)})</span></h2>
      <table>
        <thead><tr><th>Name</th><th>Id</th><th class="num">Accounts</th><th class="num">Banks</th><th class="num">Credentials</th><th></th></tr></thead>
        <tbody>${join(
          opts.profiles.map(
            (p) => html`<tr>
              <td>
                <form method="post" action="/profiles/rename" class="row" style="gap:.35rem">
                  ${csrfField(opts.csrf)}
                  <input type="hidden" name="profile" value="${p.id}">
                  <input name="name" value="${p.name}" style="max-width:11rem">
                  <button class="secondary" type="submit">Rename</button>
                </form>
              </td>
              <td class="mono muted">${p.id}</td>
              <td class="num">${String(p.usage.accounts)}</td>
              <td class="num">${String(p.usage.plaid_items)}</td>
              <td class="num">${p.usage.settings > 0 ? html`<span class="pill ok">set</span>` : html`<span class="pill">none</span>`}</td>
              <td class="num">
                <a class="btn secondary" href="/settings?profile=${encodeURIComponent(p.id)}">Credentials</a>
                ${
                  p.id === 'me'
                    ? raw('')
                    : html` <form method="post" action="/profiles/delete" style="display:inline">
                        ${csrfField(opts.csrf)}
                        <input type="hidden" name="profile" value="${p.id}">
                        <button class="danger" type="submit">Delete</button>
                      </form>`
                }
              </td>
            </tr>`,
          ),
        )}</tbody>
      </table>
    </section>

    ${
      opts.profiles.length < opts.max
        ? html`<section>
            <h2>Add a profile</h2>
            <form method="post" action="/profiles" class="row">
              ${csrfField(opts.csrf)}
              <input name="name" placeholder="e.g. Spouse, or Business" required style="max-width:18rem">
              <button type="submit">Create</button>
            </form>
            <p class="hint" style="margin-top:.6rem">Then add its Plaid and SnapTrade keys under
              Credentials, and link banks from Connections with that profile selected.</p>
          </section>`
        : html`<p class="hint">All ${String(opts.max)} profiles are in use.</p>`
    }`;
}

export function connectionsPage(opts: {
  profiles: Profile[];
  activeProfile: Profile;
  items: Array<Record<string, unknown>>;
  snaptradeReady: boolean;
  wiseReady: boolean;
  plaidReady: boolean;
  redirectUri: string;
  plaidEnv: string;
  products: string[];
  optionalProducts: string[];
  countryCodes: string[];
  csrf: string;
  nonce: string;
  flash?: SafeHtml;
}): SafeHtml {
  const statusPill = (ok: boolean, okText = 'configured'): SafeHtml =>
    ok ? html`<span class="pill ok">${okText}</span>` : html`<span class="pill">not configured</span>`;

  return html`
    <h1>Connections</h1>
    <p class="sub">Linking as <strong>${opts.activeProfile.name}</strong>. Banks link against this
      profile's Plaid keys and count against its own 10-Item allowance. Brokerages are connected in
      the SnapTrade dashboard itself and appear once credentials are set.</p>
    ${profileTabs(opts.profiles, opts.activeProfile.id, '/connections')}
    ${opts.flash ?? raw('')}

    <section>
      <h2>Providers</h2>
      <table><tbody>
        <tr><td>SnapTrade <span class="muted">— Wealthsimple, Questrade, Coinbase</span></td>
            <td class="num">${statusPill(opts.snaptradeReady)}</td></tr>
        <tr><td>Plaid <span class="muted">— banks and cards</span></td>
            <td class="num">${statusPill(opts.plaidReady)}</td></tr>
        <tr><td>Wise <span class="muted">— multi-currency balances</span></td>
            <td class="num">${statusPill(opts.wiseReady)}</td></tr>
      </tbody></table>
      ${opts.plaidReady ? raw('') : html`<p class="hint">Add Plaid credentials under <a href="/settings">Settings</a> to link a bank.</p>`}
    </section>

    <section>
      <h2>Plaid dashboard setup</h2>
      <p class="hint" style="margin-bottom:.9rem">Everything below must match your Plaid dashboard
        before Link will start. These are the exact values this server sends.</p>
      <table><tbody>
        <tr>
          <td>Allowed redirect URI<div class="muted" style="font-size:.8rem">Team Settings → API (or Developers → API). Required for OAuth banks — Chase, Amex, Bank of America.</div></td>
          <td><div class="code-block">${opts.redirectUri}</div></td>
        </tr>
        <tr>
          <td>Environment<div class="muted" style="font-size:.8rem">The secret must be the one for this environment.</div></td>
          <td><span class="pill">${opts.plaidEnv}</span></td>
        </tr>
        <tr>
          <td>Products requested<div class="muted" style="font-size:.8rem">Optional products never block linking.</div></td>
          <td><span class="pill">${opts.products.join(', ')}</span>
            ${opts.optionalProducts.length ? html` <span class="pill warn">optional: ${opts.optionalProducts.join(', ')}</span>` : raw('')}</td>
        </tr>
        <tr>
          <td>Country codes</td>
          <td><span class="pill">${opts.countryCodes.join(', ')}</span></td>
        </tr>
      </tbody></table>
      <p class="hint" style="margin-top:.9rem">Check the key pair itself under
        <a href="/settings">Settings → Test all providers</a>.</p>
    </section>

    <section>
      <h2>Banks and cards <span class="muted">(${String(opts.items.length)} of 10 Plaid Items)</span></h2>
      ${
        opts.items.length === 0
          ? html`<p class="muted">Nothing linked yet.</p>`
          : html`<table>
              <thead><tr><th>Institution</th><th>Status</th><th class="num">Accounts</th><th class="num">Balance</th><th>Last sync</th><th></th></tr></thead>
              <tbody>${join(
                opts.items.map((i) => {
                  const ok = i['status'] === 'ok';
                  return html`<tr>
                    <td>${String(i['institution'] ?? 'unknown')}</td>
                    <td>${ok ? html`<span class="pill ok">ok</span>` : html`<span class="pill bad">${String(i['status'])}${i['error_code'] ? html` ${String(i['error_code'])}` : raw('')}</span>`}</td>
                    <td class="num">${String(i['accounts'] ?? 0)}</td>
                    <td class="num">${money(Number(i['balance_cad'] ?? 0))}</td>
                    <td class="muted">${i['last_synced_at'] ? String(i['last_synced_at']).slice(0, 16).replace('T', ' ') : '—'}</td>
                    <td class="num"><button class="secondary" type="button"
                        data-relink="${String(i['item_id'])}">Repair</button></td>
                  </tr>`;
                }),
              )}</tbody>
            </table>`
      }
      ${
        opts.plaidReady && opts.items.length < 10
          ? html`<div class="row" style="margin-top:1rem">
              <button id="connect" type="button">Link a bank or card</button>
              <span id="status" class="muted"></span>
            </div>`
          : opts.items.length >= 10
            ? html`<p class="hint">All 10 Plaid Items are in use. Remove one before adding another.</p>`
            : raw('')
      }
    </section>

    ${
      opts.plaidReady
        ? html`<script src="https://cdn.plaid.com/link/v2/stable/link-initialize.js" nonce="${opts.nonce}"></script>
    <script nonce="${opts.nonce}">
      const csrf = ${raw(JSON.stringify(opts.csrf))};
      const statusEl = document.getElementById('status');
      const say = (m) => { if (statusEl) statusEl.textContent = m; };
      async function api(path, body) {
        const res = await fetch(path, {
          method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
          body: JSON.stringify(body || {}),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || res.statusText);
        return data;
      }
      function open(token) {
        Plaid.create({
          token,
          receivedRedirectUri: location.pathname === '/connections/oauth' ? location.href : undefined,
          onSuccess: async (publicToken) => {
            try { const r = await api('/api/plaid/exchange', { public_token: publicToken });
                  say('Linked ' + (r.institution_name || r.item_id) + ' — reloading…');
                  sessionStorage.removeItem('tally_lt'); location.reload(); }
            catch (e) { say('Could not save the connection: ' + e.message); }
          },
          onExit: (err) => { if (err) say('Exited: ' + (err.error_code || '') + ' ' + (err.error_message || '')); },
        }).open();
      }
      document.getElementById('connect')?.addEventListener('click', async (ev) => {
        ev.target.disabled = true; say('Preparing…');
        try { const r = await api('/api/plaid/link-token');
              sessionStorage.setItem('tally_lt', r.link_token); say(''); open(r.link_token); }
        catch (e) { say('Could not start Plaid Link: ' + e.message); }
        ev.target.disabled = false;
      });
      for (const btn of document.querySelectorAll('[data-relink]')) {
        btn.addEventListener('click', async () => {
          say('Preparing repair…');
          try { const r = await api('/api/plaid/relink', { item_id: btn.dataset.relink });
                sessionStorage.setItem('tally_lt', r.link_token); say(''); open(r.link_token); }
          catch (e) { say('Could not start repair: ' + e.message); }
        });
      }
      if (location.pathname === '/connections/oauth') {
        const t = sessionStorage.getItem('tally_lt');
        if (t) { say('Resuming…'); open(t); } else { say('No pending connection — start again.'); }
      }
    </script>`
        : raw('')
    }`;
}

export function securityPage(opts: {
  username: string;
  totpEnabled: boolean;
  sessions: Array<{ id: string; created_at: string; last_seen_at: string; ip: string | null }>;
  currentSessionId: string;
  enrolling?: { secret: string; uri: string } | null;
  csrf: string;
  flash?: SafeHtml;
}): SafeHtml {
  return html`
    <h1>Security</h1>
    <p class="sub">Signed in as <strong>${opts.username}</strong>.</p>
    ${opts.flash ?? raw('')}

    <section>
      <h2>Two-factor authentication</h2>
      ${
        opts.enrolling
          ? html`
            <p>Add this secret to your authenticator app, then confirm with a code to finish.</p>
            <div class="field">
              <label>Secret (manual entry)</label>
              <div class="code-block">${opts.enrolling.secret}</div>
            </div>
            <div class="field">
              <label>Or open this URI on the device with your authenticator</label>
              <div class="code-block">${opts.enrolling.uri}</div>
            </div>
            <form method="post" action="/security/totp/confirm">
              ${csrfField(opts.csrf)}
              <input type="hidden" name="secret" value="${opts.enrolling.secret}">
              <div class="field" style="max-width:12rem">
                <label for="code">Code from your app</label>
                <input id="code" name="code" inputmode="numeric" pattern="[0-9]*" maxlength="6" required autofocus>
              </div>
              <button type="submit">Enable two-factor</button>
            </form>`
          : opts.totpEnabled
            ? html`<p><span class="pill ok">enabled</span> A code from your authenticator is required at sign-in.</p>
              <form method="post" action="/security/totp/disable">
                ${csrfField(opts.csrf)}
                <div class="field" style="max-width:12rem">
                  <label for="dcode">Confirm with a current code</label>
                  <input id="dcode" name="code" inputmode="numeric" pattern="[0-9]*" maxlength="6" required>
                </div>
                <button class="danger" type="submit">Disable two-factor</button>
              </form>`
            : html`<p><span class="pill bad">not enabled</span>
                This server is reachable from the internet and a single password is the only thing
                protecting every balance, transaction and stored bank token. Enable a second factor.</p>
              <form method="post" action="/security/totp/start">
                ${csrfField(opts.csrf)}<button type="submit">Set up two-factor</button>
              </form>`
      }
    </section>

    <section>
      <h2>Active sessions</h2>
      <table>
        <thead><tr><th>Started</th><th>Last seen</th><th>Address</th><th></th></tr></thead>
        <tbody>${join(
          opts.sessions.map(
            (s) => html`<tr>
              <td>${s.created_at.slice(0, 16).replace('T', ' ')}</td>
              <td>${s.last_seen_at.slice(0, 16).replace('T', ' ')}</td>
              <td class="muted">${s.ip ?? '—'}</td>
              <td class="num">${s.id === opts.currentSessionId ? html`<span class="pill ok">this device</span>` : raw('')}</td>
            </tr>`,
          ),
        )}</tbody>
      </table>
      <form method="post" action="/security/sessions/revoke" style="margin-top:1rem">
        ${csrfField(opts.csrf)}
        <button class="danger" type="submit">Sign out everywhere</button>
      </form>
    </section>`;
}
