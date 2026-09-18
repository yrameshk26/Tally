/**
 * Page bodies. Every institution-supplied string (account name, merchant,
 * security description) goes through the escaping template — see lib/html.ts
 * for why that matters here specifically.
 */
import { esc, html, join, money, raw, type SafeHtml } from '../lib/html.ts';
import { csrfField, notice } from './layout.ts';
import {
  isLiabilityAccount,
  type AccountView,
  type CategoryGroup,
  type HoldingsResult,
  type MerchantGroup,
  type TransactionView,
} from '../queries.ts';
import type { MerchantRule } from '../overrides.ts';
import { round2 } from '../lib/money.ts';
import { PLAID_ITEM_CAP } from '../sources/plaid.ts';
import type { NetWorthTotals } from '../snapshots.ts';
import type { ManagedKey } from '../settings.ts';
import type { Profile } from '../profiles.ts';
import { logoSvg } from './logo.ts';
import { areaChart, chartRuntime, groupedColumns, hBars, stackedBar } from './charts.ts';
import { renderMarkdown } from './markdown.ts';
import type { ChatRow, StoredMessage } from '../llm/store.ts';

const sign = (n: number): SafeHtml =>
  html`<span class="${n < 0 ? 'neg' : n > 0 ? 'pos' : 'muted'}">${money(n)}</span>`;

export function verifyPage(opts: {
  csrf: string;
  username: string;
  error?: string;
  next?: string | null;
}): SafeHtml {
  return html`<div class="login">
    <h1>Two-factor</h1>
    <p class="sub">Enter the current code for <strong>${opts.username}</strong> from your
      authenticator app.</p>
    ${opts.error ? notice('err', opts.error) : raw('')}
    <section>
      <form method="post" action="/login/verify">
        ${csrfField(opts.csrf)}
        ${opts.next ? html`<input type="hidden" name="next" value="${opts.next}">` : raw('')}
        <div class="field">
          <label for="code">Authenticator code</label>
          <input id="code" name="code" inputmode="numeric" autocomplete="one-time-code"
                 pattern="[0-9]*" maxlength="6" required autofocus
                 aria-describedby="codehelp" class="otp">
          <div class="hint" id="codehelp">Six digits, refreshed every 30 seconds.</div>
        </div>
        <button type="submit">Verify</button>
      </form>
    </section>
    <p class="hint mt-sm">
      <a href="/login/cancel">Sign in as someone else</a>
    </p>
  </div>`;
}

export function loginPage(opts: {
  csrf: string;
  totpEnabled: boolean;
  error?: string;
  username?: string;
  next?: string | null;
}): SafeHtml {
  return html`<div class="login">
    ${raw(logoSvg(56, 'mark'))}
    <h1>tally</h1>
    <p class="sub">Sign in to manage connections and view your summary.</p>
    ${opts.error ? notice('err', opts.error) : raw('')}
    <section>
      <form method="post" action="/login">
        ${csrfField(opts.csrf)}
        ${opts.next ? html`<input type="hidden" name="next" value="${opts.next}">` : raw('')}
        <div class="field">
          <label for="u">Username</label>
          <input id="u" name="username" autocomplete="username" required value="${opts.username ?? ''}">
        </div>
        <div class="field">
          <label for="p">Password</label>
          <input id="p" name="password" type="password" autocomplete="current-password" required>
        </div>
        <button type="submit">Continue</button>
        ${
          opts.totpEnabled
            ? html`<p class="hint mt-sm">You will be asked for your authenticator code next.</p>`
            : raw('')
        }
      </form>
    </section>
  </div>`;
}

export function overviewPage(opts: {
  totals: NetWorthTotals;
  profiles: Profile[];
  nonce: string;
  accounts: AccountView[];
  holdings: HoldingsResult;
  history: Array<{ label: string; value: number }>;
  cashflow: Array<{ month: string; income: number; spend: number }>;
  lastSync: string | null;
  fxAsOf: string | null;
  csrf: string;
  flash?: SafeHtml;
}): SafeHtml {
  const { totals, accounts, holdings } = opts;
  const cards = accounts.filter(isLiabilityAccount);
  const assets = accounts.filter((a) => a.balance_cad >= 0);

  const profileName = (id: string): string => opts.profiles.find((p) => p.id === id)?.name ?? id;

  /**
   * Re-attribute an account. `data-autosubmit` rather than an inline onchange:
   * a nonce-based CSP blocks inline event handlers outright, so the handler
   * that used to live here never ran and the dropdown did nothing.
   */
  /**
   * Correct a currency the institution got wrong. Only offered where it could
   * be wrong — a CAD account with no override needs no control, and a row of
   * dropdowns on every account would invite exactly the mistake this fixes.
   */
  const currencyCell = (a: AccountView): SafeHtml => {
    if (a.currency === 'CAD' && !a.currency_override) return raw('');
    const choices = ['', 'CAD', 'USD', 'GBP', 'EUR'];
    return html`<form method="post" action="/accounts/currency" class="row tight">
      ${csrfField(opts.csrf)}
      <input type="hidden" name="account_id" value="${a.id}">
      <select name="currency" data-autosubmit aria-label="Currency for ${a.name ?? a.id}">
        ${join(
          choices.map((c) =>
            c === ''
              ? html`<option value=""${a.currency_override ? raw('') : raw(' selected')}>as reported (${a.currency})</option>`
              : html`<option value="${c}"${c === a.currency_override ? raw(' selected') : raw('')}>read as ${c}</option>`,
          ),
        )}
      </select>
      <noscript><button class="secondary" type="submit">Set</button></noscript>
    </form>`;
  };

  const profileCell = (a: AccountView): SafeHtml =>
    opts.profiles.length > 1
      ? html`<form method="post" action="/accounts/move" class="row tight">
          ${csrfField(opts.csrf)}
          <input type="hidden" name="account_id" value="${a.id}">
          <select name="profile" data-autosubmit aria-label="Profile for ${a.name ?? a.id}">
            ${join(
              opts.profiles.map(
                (pr) =>
                  html`<option value="${pr.id}"${pr.id === a.profile ? raw(' selected') : raw('')}>${pr.name}</option>`,
              ),
            )}
          </select>
          <noscript><button class="secondary" type="submit">Move</button></noscript>
        </form>`
      : html`<span class="muted">${profileName(a.profile)}</span>`;
  const bucket = (
    label: string,
    rec: Record<string, number>,
    labelFor: (k: string) => string = (k) => k,
  ): SafeHtml =>
    Object.keys(rec).length === 0
      ? raw('')
      : html`<section>
          <h2>${label}</h2>
          <div class="table-wrap"><table class="kv"><tbody>${join(
            Object.entries(rec)
              .sort((a, b) => b[1] - a[1])
              .map(
                ([k, v]) => html`<tr><td>${labelFor(k)}</td><td class="num">${sign(v)}</td></tr>`,
              ),
          )}</tbody></table></div>
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

    <div class="row mb">
      <form method="post" action="/sync">${csrfField(opts.csrf)}<button type="submit">Refresh now</button></form>
      <span class="muted">Pulls fresh balances, holdings and transactions. Read-only.</span>
    </div>

    <section>
      <h2>Net worth over time</h2>
      ${areaChart({
        title: 'Net worth over time',
        points: opts.history,
      })}
    </section>

    <div class="charts-grid">
      <section>
        <h2>Allocation by registered type</h2>
        ${
          Object.values(totals.by_registered_type).some((v) => v < 0)
            ? html`<p class="sub-line">Assets only — a liability cannot be a slice of a
                whole. See “Cards and loans” below.</p>`
            : raw('')
        }
        ${stackedBar({
          title: 'Allocation by registered type',
          segments: Object.entries(totals.by_registered_type).map(([label, value]) => ({
            label,
            value,
          })),
        })}
      </section>
      <section>
        <h2>Largest holdings</h2>
        ${hBars({
          title: 'Largest holdings',
          rows: holdings.positions.slice(0, 7).map((p) => ({
            label: p.symbol,
            value: p.market_value_cad,
            note: `${p.weight_pct.toFixed(1)}% of invested`,
          })),
        })}
      </section>
    </div>

    <section>
      <h2>Income vs spend</h2>
      ${groupedColumns({
        title: 'Income vs spend by month',
        groups: opts.cashflow.map((m) => ({ label: m.month.slice(2), a: m.income, b: m.spend })),
        seriesA: 'Income',
        seriesB: 'Spend',
      })}
    </section>

    <div class="split">
      ${bucket('By registered type', totals.by_registered_type)}
      ${bucket('By profile', totals.by_profile, profileName)}
    </div>

    ${
      cards.length
        ? html`<section>
            <h2>Cards and loans</h2>
            <div class="table-wrap"><table>
              <thead><tr><th>Account</th><th>Institution</th><th>Profile</th><th>Currency</th><th class="num">Balance</th><th class="num">Limit</th><th class="num">Used</th><th class="num">Statement</th><th class="num">Minimum</th><th>Due</th></tr></thead>
              <tbody>${join(
                cards.map(
                  (c) => html`<tr>
                    <td>${c.name ?? c.id}${c.mask ? html` <span class="muted">••${c.mask}</span>` : raw('')}</td>
                    <td class="muted">${c.institution ?? '—'}</td>
                    <td>${profileCell(c)}</td>
                    <td>${currencyCell(c)}</td>
                    <td class="num">${sign(c.balance_cad)}</td>
                    <td class="num">${c.credit_limit != null ? money(c.credit_limit) : html`<span class="muted">—</span>`}</td>
                    <td class="num">${c.utilization_pct != null ? html`${c.utilization_pct.toFixed(0)}%` : html`<span class="muted">—</span>`}</td>
                    <td class="num">${c.card?.['statement_balance'] != null ? money(Number(c.card['statement_balance'])) : html`<span class="muted">—</span>`}</td>
                    <td class="num">${c.card?.['minimum_payment'] != null ? money(Number(c.card['minimum_payment'])) : html`<span class="muted">—</span>`}</td>
                    <td>${c.card?.['due_date'] ? String(c.card['due_date']).slice(0, 10) : html`<span class="muted">—</span>`}</td>
                  </tr>`,
                ),
              )}</tbody>
            </table></div>
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
          : html`<div class="table-wrap"><table>
              <thead><tr><th>Account</th><th>Institution</th><th>Type</th><th>Profile</th><th>Currency</th><th class="num">Balance</th></tr></thead>
              <tbody>${join(
                assets.map(
                  (a) => html`<tr>
                    <td>${a.name ?? a.id}${a.mask ? html` <span class="muted">••${a.mask}</span>` : raw('')}</td>
                    <td class="muted">${a.institution ?? '—'}</td>
                    <td><span class="pill">${a.registered_type}</span></td>
                    <td>${profileCell(a)}</td>
                    <td>${currencyCell(a)}</td>
                    <td class="num">${sign(a.balance_cad)}${a.currency !== 'CAD' ? html`<div class="sub-line">${a.balance.toLocaleString()} ${a.currency}</div>` : raw('')}</td>
                  </tr>`,
                ),
              )}</tbody>
            </table></div>`
      }
    </section>

    ${raw(chartRuntime(opts.nonce))}

    ${
      opts.profiles.length > 1
        ? raw(
            `<script nonce="${opts.nonce}">` +
              `for(const el of document.querySelectorAll('select[data-autosubmit]'))` +
              `el.addEventListener('change',()=>el.form.submit());` +
              `</scr` +
              `ipt>`,
          )
        : raw('')
    }

    ${
      holdings.positions.length
        ? html`<section>
            <h2>Holdings</h2>
            <div class="table-wrap"><table>
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
            </table></div>
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
  LLM_PROVIDER: {
    label: 'Assistant provider',
    hint: 'anthropic, openai, openrouter, or custom for any OpenAI-compatible endpoint.',
  },
  LLM_API_KEY: {
    label: 'Assistant API key',
    hint: 'Secret. Turning this on sends balances and transactions to that provider on every message.',
  },
  LLM_MODEL: { label: 'Assistant model', hint: 'Blank uses the provider default.' },
  LLM_BASE_URL: { label: 'Assistant base URL', hint: 'Only for a custom or self-hosted endpoint.' },
};

export function settingsPage(opts: {
  settings: SettingView[];
  profiles: Profile[];
  activeProfile: Profile;
  csrf: string;
  isDefaultProfile: boolean;
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
      ${
        // Install-level, not per profile: llmConfig always reads the default
        // profile, so offering these fields elsewhere would silently write a key
        // nothing ever reads.
        opts.isDefaultProfile
          ? html`${group('Assistant — optional built-in chat', [
              'LLM_PROVIDER',
              'LLM_API_KEY',
              'LLM_MODEL',
              'LLM_BASE_URL',
            ])}
            <p class="hint">Leaving these blank keeps the assistant off, which is the default.
              Filling them in means this server sends balances and transactions to that provider
              on every message — a different trade from the rest of the app, where data only
              leaves in response to a request your own MCP client made.</p>`
          : raw('')
      }
      <input type="hidden" name="profile" value="${opts.activeProfile.id}">
      <div class="row"><button type="submit">Save credentials</button>
        <span class="muted">Secrets are encrypted at rest and never displayed again.</span></div>
    </form>

    <section class="mt">
      <h2>Check credentials</h2>
      <p class="hint mb-sm">Runs one cheap read-only call per provider, so a
        wrong key is found here rather than halfway through a bank login.</p>
      ${
        opts.checks && opts.checks.length
          ? html`<div class="table-wrap"><table>
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
            </table></div>`
          : raw('')
      }
      <form method="post" action="/settings/test" class="mt-sm">
        ${csrfField(opts.csrf)}
        <input type="hidden" name="profile" value="${opts.activeProfile.id}">
        <button class="secondary" type="submit">Test all providers</button>
      </form>
    </section>`;
}

/** Profile switcher shared by the pages that are scoped to one. */
export function profileTabs(profiles: Profile[], activeId: string, basePath: string): SafeHtml {
  if (profiles.length <= 1) return raw('');
  return html`<div class="row mb">${join(
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
      <div class="table-wrap"><table>
        <thead><tr><th>Name</th><th>Id</th><th class="num">Accounts</th><th class="num">Banks</th><th class="num">Credentials</th><th></th></tr></thead>
        <tbody>${join(
          opts.profiles.map(
            (p) => html`<tr>
              <td>
                <form method="post" action="/profiles/rename" class="row tight">
                  ${csrfField(opts.csrf)}
                  <input type="hidden" name="profile" value="${p.id}">
                  <input name="name" value="${p.name}" class="w-sm">
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
                    : html` <form method="post" action="/profiles/delete" class="inline-form">
                        ${csrfField(opts.csrf)}
                        <input type="hidden" name="profile" value="${p.id}">
                        <button class="danger" type="submit">Delete</button>
                      </form>`
                }
              </td>
            </tr>`,
          ),
        )}</tbody>
      </table></div>
    </section>

    ${
      opts.profiles.length < opts.max
        ? html`<section>
            <h2>Add a profile</h2>
            <form method="post" action="/profiles" class="row">
              ${csrfField(opts.csrf)}
              <input name="name" placeholder="e.g. Spouse, or Business" required class="w-lg">
              <button type="submit">Create</button>
            </form>
            <p class="hint mt-xs">Then add its Plaid and SnapTrade keys under
              Credentials, and link banks from Connections with that profile selected.</p>
          </section>`
        : html`<p class="hint">All ${String(opts.max)} profiles are in use.</p>`
    }`;
}

export function connectionsPage(opts: {
  profiles: Profile[];
  activeProfile: Profile;
  unsynced: number;
  items: Array<Record<string, unknown>>;
  snaptradeReady: boolean;
  wiseReady: boolean;
  plaidReady: boolean;
  redirectUri: string;
  plaidEnv: string;
  products: string[];
  optionalProducts: string[];
  statementsEnabled: boolean;
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
      <div class="table-wrap"><table class="kv"><tbody>
        <tr><td>SnapTrade <span class="muted">— Wealthsimple, Questrade, Coinbase</span></td>
            <td class="num">${statusPill(opts.snaptradeReady)}</td></tr>
        <tr><td>Plaid <span class="muted">— banks and cards</span></td>
            <td class="num">${statusPill(opts.plaidReady)}</td></tr>
        <tr><td>Wise <span class="muted">— multi-currency balances</span></td>
            <td class="num">${statusPill(opts.wiseReady)}</td></tr>
      </tbody></table></div>
      ${opts.plaidReady ? raw('') : html`<p class="hint">Add Plaid credentials under <a href="/settings">Settings</a> to link a bank.</p>`}
    </section>

    <section>
      <h2>Plaid dashboard setup</h2>
      <p class="hint mb-sm">Everything below must match your Plaid dashboard
        before Link will start. These are the exact values this server sends.</p>
      <div class="table-wrap"><table class="kv"><tbody>
        <tr>
          <td>Allowed redirect URI<div class="sub-line">Team Settings → API (or Developers → API). Required for OAuth banks — Chase, Amex, Bank of America.</div></td>
          <td><div class="code-block">${opts.redirectUri}</div></td>
        </tr>
        <tr>
          <td>Environment<div class="sub-line">The secret must be the one for this environment.</div></td>
          <td><span class="pill">${opts.plaidEnv}</span></td>
        </tr>
        <tr>
          <td>Products requested<div class="sub-line">Optional products never block linking.</div></td>
          <td><span class="pill">${opts.products.join(', ')}</span>
            ${opts.optionalProducts.length ? html` <span class="pill warn">optional: ${opts.optionalProducts.join(', ')}</span>` : raw('')}</td>
        </tr>
        <tr>
          <td>Country codes</td>
          <td><span class="pill">${opts.countryCodes.join(', ')}</span></td>
        </tr>
      </tbody></table></div>
      <p class="hint mt-sm">Check the key pair itself under
        <a href="/settings">Settings → Test all providers</a>.</p>
    </section>

    <section>
      <h2>Banks and cards
        <span class="muted">(${String(opts.items.length)} of ${String(PLAID_ITEM_CAP)} Plaid Items
        for this profile)</span></h2>
      ${
        opts.statementsEnabled
          ? html`<p class="sub-line">Statements are requested when a bank is linked, so anything
              you connect from now on that supports them will serve them. Banks connected earlier
              will not: Plaid fixes the consented products at link time, and the only way to change
              that is to disconnect and add the bank again. Support is per institution and thin
              outside the large US banks, so check <code>list_statements</code> before going to the
              trouble.</p>`
          : raw('')
      }
      ${
        opts.unsynced > 0
          ? notice(
              'warn',
              `${opts.unsynced} connection(s) have not been read yet, so they show no accounts. ` +
                'This normally resolves itself within a minute of linking — if it persists, use ' +
                'Refresh now on the Overview.',
            )
          : raw('')
      }
      ${
        opts.items.length === 0
          ? html`<p class="muted">Nothing linked yet.</p>`
          : html`<div class="table-wrap"><table>
              <thead><tr><th>Institution</th><th>Status</th><th class="num">Accounts</th><th class="num">Balance</th><th>Last sync</th><th></th></tr></thead>
              <tbody>${join(
                opts.items.map((i) => {
                  const ok = i['status'] === 'ok';
                  return html`<tr>
                    <td>${String(i['institution'] ?? 'unknown')}</td>
                    <td>${ok ? html`<span class="pill ok">ok</span>` : html`<span class="pill bad">${String(i['status'])}${i['error_code'] ? html` ${String(i['error_code'])}` : raw('')}</span>`}</td>
                    <td class="num">${String(i['accounts'] ?? 0)}</td>
                    <td class="num">${money(Number(i['balance_cad'] ?? 0))}</td>
                    <td class="muted">${
                      i['last_synced_at']
                        ? String(i['last_synced_at']).slice(0, 16).replace('T', ' ')
                        : html`<span class="pill warn">never synced</span>`
                    }</td>
                    <td class="num"><div class="row tight">
                      <button class="secondary" type="button"
                        title="Re-authenticate this bank's login"
                        data-relink="${String(i['item_id'])}">Repair</button>

                      <form method="post" action="/connections/remove" class="inline-form"
                            data-confirm="Disconnect ${String(i['institution'] ?? 'this bank')}? Its access token is revoked at Plaid and its accounts leave your net worth. Transaction history is kept.">
                        ${csrfField(opts.csrf)}
                        <input type="hidden" name="item_id" value="${String(i['item_id'])}">
                        <input type="hidden" name="profile" value="${opts.activeProfile.id}">
                        <button class="danger" type="submit">Disconnect</button>
                      </form>
                    </div></td>
                  </tr>`;
                }),
              )}</tbody>
            </table></div>`
      }
      ${
        opts.plaidReady && opts.items.length < 10
          ? html`<div class="row mt">
              <button id="connect" type="button">Link a bank or card</button>
              <span id="status" class="muted"></span>
            </div>`
          : opts.items.length >= 10
            ? html`<p class="hint">All ${String(PLAID_ITEM_CAP)} Plaid Items are in use for this
                profile. Every profile has its own allowance, so you can add another profile
                instead of removing a connection here.</p>`
            : raw('')
      }
    </section>

    ${
      opts.plaidReady
        ? html`<script src="https://cdn.plaid.com/link/v2/stable/link-initialize.js" nonce="${opts.nonce}"></script>
    <script nonce="${opts.nonce}">
      const csrf = ${raw(JSON.stringify(opts.csrf))};
      const PROFILE = ${raw(JSON.stringify(opts.activeProfile.id))};
      const statusEl = document.getElementById('status');
      const say = (m) => { if (statusEl) statusEl.textContent = m; };
      // Every call carries the profile explicitly. The switcher changes the
      // page URL, but these are POSTs to a fixed path — without this the
      // server falls back to the default profile and the bank ends up linked
      // under the wrong Plaid team.
      async function api(path, body) {
        const res = await fetch(path, {
          method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
          body: JSON.stringify({ profile: resumeProfile(), ...(body || {}) }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || res.statusText);
        return data;
      }
      // Plaid's OAuth redirect comes back to a bare /connections/oauth with no
      // query string, so the profile has to survive the round trip.
      function resumeProfile() {
        if (location.pathname === '/connections/oauth') {
          return sessionStorage.getItem('tally_profile') || PROFILE;
        }
        return PROFILE;
      }
      function open(token) {
        Plaid.create({
          token,
          receivedRedirectUri: location.pathname === '/connections/oauth' ? location.href : undefined,
          onSuccess: async (publicToken) => {
            try { const r = await api('/api/plaid/exchange', { public_token: publicToken });
                  say('Linked ' + (r.institution_name || r.item_id) + ' — reloading…');
                  sessionStorage.removeItem('tally_lt');
                  sessionStorage.removeItem('tally_profile');
                  location.href = '/connections?profile=' + encodeURIComponent(resumeProfile()); }
            catch (e) { say('Could not save the connection: ' + e.message); }
          },
          onExit: (err) => { if (err) say('Exited: ' + (err.error_code || '') + ' ' + (err.error_message || '')); },
        }).open();
      }
      document.getElementById('connect')?.addEventListener('click', async (ev) => {
        ev.target.disabled = true; say('Preparing…');
        try { const r = await api('/api/plaid/link-token');
              sessionStorage.setItem('tally_lt', r.link_token);
              sessionStorage.setItem('tally_profile', PROFILE);
              say(''); open(r.link_token); }
        catch (e) { say('Could not start Plaid Link: ' + e.message); }
        ev.target.disabled = false;
      });
      for (const btn of document.querySelectorAll('[data-relink]')) {
        btn.addEventListener('click', async () => {
          say('Preparing repair…');
          try { const r = await api('/api/plaid/relink', { item_id: btn.dataset.relink });
                sessionStorage.setItem('tally_lt', r.link_token);
                sessionStorage.setItem('tally_profile', PROFILE);
                say(''); open(r.link_token); }
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
  mcpUrl: string;
  legacyEnabled: boolean;
  connectorUrl: string | null;
  clients: Array<{
    client_id: string;
    client_name: string | null;
    created_at: string;
    last_used_at: string | null;
    tokens: number;
  }>;
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
              <div class="field" class="w-sm">
                <label for="code">Code from your app</label>
                <input id="code" name="code" inputmode="numeric" pattern="[0-9]*" maxlength="6" required autofocus>
              </div>
              <button type="submit">Enable two-factor</button>
            </form>`
          : opts.totpEnabled
            ? html`<p><span class="pill ok">enabled</span> A code from your authenticator is required at sign-in.</p>
              <form method="post" action="/security/totp/disable">
                ${csrfField(opts.csrf)}
                <div class="field" class="w-sm">
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
      <h2>Connect to Claude</h2>
      <p class="hint mb-sm">Add this server to Claude as a custom connector and it can answer
        questions about your money directly — “what's my net worth”, “show holdings
        concentration”, “how much RRSP room is left”.</p>
      <ol class="steps">
        <li>In Claude, open <strong>Settings → Connectors → Add custom connector</strong>.</li>
        <li>Name it <strong>tally</strong> and paste this URL — it contains no secret:</li>
      </ol>
      <div class="code-block mt-xs">${opts.mcpUrl}</div>
      <ol class="steps mt-sm" start="3">
        <li>Claude will send you here to sign in with your password and authenticator code, then
          ask you to allow access. That's it.</li>
      </ol>
      <p class="hint">Nothing to copy, nothing to rotate. Access is granted per app below and can be
        revoked at any time without touching the server.</p>
    </section>

    <section>
      <h2>Authorized apps</h2>
      ${
        opts.clients.length === 0
          ? html`<p class="empty">No app has been authorized yet. Add the connector above and one
              will appear here after you approve it.</p>`
          : html`<div class="table-wrap"><table>
              <thead><tr><th>App</th><th>Authorized</th><th>Last used</th><th class="num">Tokens</th><th></th></tr></thead>
              <tbody>${join(
                opts.clients.map(
                  (c) => html`<tr>
                    <td><strong>${c.client_name ?? 'Unnamed app'}</strong>
                      <div class="sub-line mono">${c.client_id.slice(0, 12)}…</div></td>
                    <td class="muted">${c.created_at.slice(0, 16).replace('T', ' ')}</td>
                    <td class="muted">${c.last_used_at ? c.last_used_at.slice(0, 16).replace('T', ' ') : '—'}</td>
                    <td class="num">${String(c.tokens)}</td>
                    <td class="num">
                      <form method="post" action="/security/apps/revoke" class="inline-form"
                            data-confirm="Revoke access for ${c.client_name ?? 'this app'}? It will have to be authorized again.">
                        ${csrfField(opts.csrf)}
                        <input type="hidden" name="client_id" value="${c.client_id}">
                        <button class="danger" type="submit">Revoke</button>
                      </form>
                    </td>
                  </tr>`,
                ),
              )}</tbody>
            </table></div>`
      }
    </section>

    ${
      opts.legacyEnabled
        ? html`<section>
            <h2>Legacy secret URL</h2>
            ${notice(
              'warn',
              'The old /mcp/<secret> route is still enabled. A secret in a URL path is written to reverse-proxy access logs on every request. Once your connector is re-added using the URL above, set MCP_ALLOW_PATH_SECRET=false on the server and restart to close it.',
            )}
            ${
              opts.connectorUrl
                ? html`<div class="code-block">${opts.connectorUrl}</div>`
                : html`<form method="post" action="/security/connector">
                    ${csrfField(opts.csrf)}
                    <button class="secondary" type="submit">Show legacy URL</button>
                  </form>`
            }
          </section>`
        : raw('')
    }

    <section>
      <h2>Active sessions</h2>
      <div class="table-wrap"><table>
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
      </table></div>
      <form method="post" action="/security/sessions/revoke" class="mt">
        ${csrfField(opts.csrf)}
        <button class="danger" type="submit">Sign out everywhere</button>
      </form>
    </section>`;
}

// --- transactions -----------------------------------------------------------

export type TxFilters = {
  start: string;
  end: string;
  profile: string;
  account_id: string;
  category: string;
  search: string;
  direction: 'all' | 'out' | 'in';
  min_amount: string;
  group: 'none' | 'merchant' | 'category';
};

/** The filter bar. One row of controls above the results, per the viz method. */
function filterBar(f: TxFilters, accounts: AccountView[], categories: string[], profiles: Profile[]): SafeHtml {
  const opt = (value: string, label: string, selected: boolean): SafeHtml =>
    html`<option value="${value}"${selected ? raw(' selected') : raw('')}>${label}</option>`;
  return html`<form method="get" action="/transactions" class="filters">
    <label>From <input type="date" name="start" value="${f.start}"></label>
    <label>To <input type="date" name="end" value="${f.end}"></label>
    <label>Search
      <input type="search" name="search" value="${f.search}" placeholder="merchant or description">
    </label>
    <label>Account
      <select name="account_id">
        ${opt('', 'All accounts', f.account_id === '')}
        ${join(accounts.map((a) => opt(a.id, `${a.name ?? a.id}${a.mask ? ` ••${a.mask}` : ''}`, a.id === f.account_id)))}
      </select>
    </label>
    <label>Category
      <select name="category">
        ${opt('', 'All categories', f.category === '')}
        ${join(categories.map((c) => opt(c, c, c === f.category)))}
      </select>
    </label>
    ${
      profiles.length > 1
        ? html`<label>Profile
            <select name="profile">
              ${opt('', 'All profiles', f.profile === '')}
              ${join(profiles.map((p) => opt(p.id, p.name, p.id === f.profile)))}
            </select>
          </label>`
        : raw('')
    }
    <label>Direction
      <select name="direction">
        ${opt('all', 'In and out', f.direction === 'all')}
        ${opt('out', 'Money out', f.direction === 'out')}
        ${opt('in', 'Money in', f.direction === 'in')}
      </select>
    </label>
    <label>Min $ <input type="number" name="min_amount" value="${f.min_amount}" min="0" step="1" class="w-sm"></label>
    <label>Group
      <select name="group">
        ${opt('none', 'No grouping', f.group === 'none')}
        ${opt('merchant', 'By merchant', f.group === 'merchant')}
        ${opt('category', 'By category', f.group === 'category')}
      </select>
    </label>
    <button type="submit">Apply</button>
    <a class="btn-link" href="/transactions">Reset</a>
  </form>`;
}

export function transactionsPage(opts: {
  nonce: string;
  csrf: string;
  filters: TxFilters;
  rows: TransactionView[];
  merchants: MerchantGroup[];
  categoryGroups: CategoryGroup[];
  accounts: AccountView[];
  categories: string[];
  profiles: Profile[];
  rules: Array<MerchantRule & { matching_transactions: number }>;
  truncated: boolean;
  flash?: SafeHtml;
}): SafeHtml {
  const f = opts.filters;
  const spend = round2(opts.rows.filter((r) => r.amount_cad < 0).reduce((s, r) => s + -r.amount_cad, 0));
  const received = round2(opts.rows.filter((r) => r.amount_cad > 0).reduce((s, r) => s + r.amount_cad, 0));

  /** Edit one row in place. Same data-autosubmit pattern as the profile cell. */
  const editCell = (t: TransactionView): SafeHtml => html`<form method="post" action="/transactions/override" class="row tight">
    ${csrfField(opts.csrf)}
    <input type="hidden" name="transaction_id" value="${t.id}">
    <input type="hidden" name="back" value="${currentQuery(f)}">
    <input type="text" name="merchant" value="${t.merchant ?? ''}" aria-label="Merchant"
      placeholder="${t.name ?? 'merchant'}" class="cell-input">
    <select name="category" aria-label="Category">
      <option value="">—</option>
      ${join(
        opts.categories.map(
          (c) => html`<option value="${c}"${c === (t.category ?? '') ? raw(' selected') : raw('')}>${c}</option>`,
        ),
      )}
    </select>
    <button class="secondary" type="submit">Save</button>
  </form>`;

  const ruleForm = (merchant: string, category: string): SafeHtml => html`<form method="post" action="/transactions/rule" class="row tight">
    ${csrfField(opts.csrf)}
    <input type="hidden" name="pattern" value="${merchant}">
    <input type="hidden" name="back" value="${currentQuery(f)}">
    <input type="text" name="merchant" value="${merchant}" aria-label="Rename every match to" class="cell-input">
    <select name="category" aria-label="Category for every match">
      <option value="">keep category</option>
      ${join(opts.categories.map((c) => html`<option value="${c}"${c === category ? raw(' selected') : raw('')}>${c}</option>`))}
    </select>
    <button class="secondary" type="submit">Apply to all</button>
  </form>`;

  return html`
    <h1>Transactions</h1>
    <p class="sub">
      Every bank and card movement, after your corrections. Negative is money out.
      Brokerage dividends and trades live under Holdings, not here.
    </p>
    ${opts.flash ?? raw('')}

    ${filterBar(f, opts.accounts, opts.categories, opts.profiles)}

    <div class="kpis">
      <div class="kpi"><div class="label">Money out</div><div class="value neg">${money(-spend)}</div></div>
      <div class="kpi"><div class="label">Money in</div><div class="value pos">${money(received)}</div></div>
      <div class="kpi"><div class="label">Net</div><div class="value ${received - spend >= 0 ? 'pos' : 'neg'}">${money(round2(received - spend))}</div></div>
      <div class="kpi"><div class="label">Transactions</div><div class="value">${String(opts.rows.length)}</div></div>
    </div>

    ${
      opts.truncated
        ? notice(
            'warn',
            'Showing the first 1,000 matches. Narrow the date range or add a filter to see the rest — ' +
              'the totals above cover only what is shown.',
          )
        : raw('')
    }

    ${
      f.group === 'merchant'
        ? html`<section>
            <h2>By merchant <span class="muted">(${String(opts.merchants.length)})</span></h2>
            <p class="sub-line">Two spellings of one company appear as two rows. Rename either one
              and apply it to all to merge them, for this history and everything that arrives later.</p>
            <div class="table-wrap"><table>
              <thead><tr><th>Merchant</th><th class="num">Out</th><th class="num">In</th><th class="num">Count</th><th>Seen</th><th>Merge or rename</th></tr></thead>
              <tbody>${join(
                opts.merchants.map(
                  (m) => html`<tr>
                    <td>${m.merchant}${m.corrected ? html` <span class="pill">corrected</span>` : raw('')}</td>
                    <td class="num neg">${m.spend_cad ? money(-m.spend_cad) : html`<span class="muted">—</span>`}</td>
                    <td class="num pos">${m.received_cad ? money(m.received_cad) : html`<span class="muted">—</span>`}</td>
                    <td class="num">${String(m.count)}</td>
                    <td class="muted nowrap">${m.first === m.last ? m.first : `${m.first} → ${m.last}`}</td>
                    <td>${ruleForm(m.merchant, m.categories[0] ?? '')}</td>
                  </tr>`,
                ),
              )}</tbody>
            </table></div>
          </section>`
        : raw('')
    }

    ${
      f.group === 'category'
        ? html`<section>
            <h2>By category <span class="muted">(${String(opts.categoryGroups.length)})</span></h2>
            <div class="table-wrap"><table>
              <thead><tr><th>Category</th><th class="num">Out</th><th class="num">In</th><th class="num">Merchants</th><th class="num">Count</th></tr></thead>
              <tbody>${join(
                opts.categoryGroups.map(
                  (c) => html`<tr>
                    <td>${c.category}</td>
                    <td class="num neg">${c.spend_cad ? money(-c.spend_cad) : html`<span class="muted">—</span>`}</td>
                    <td class="num pos">${c.received_cad ? money(c.received_cad) : html`<span class="muted">—</span>`}</td>
                    <td class="num">${String(c.merchants)}</td>
                    <td class="num">${String(c.count)}</td>
                  </tr>`,
                ),
              )}</tbody>
            </table></div>
          </section>`
        : raw('')
    }

    <section>
      <h2>${f.group === 'none' ? 'Transactions' : 'All matching transactions'}</h2>
      ${
        opts.rows.length === 0
          ? html`<p class="muted">Nothing matches these filters.</p>`
          : html`<div class="table-wrap"><table>
              <thead><tr><th>Date</th><th>Merchant</th><th>Account</th><th class="num">Amount</th><th>Category and merchant</th></tr></thead>
              <tbody>${join(
                opts.rows.map(
                  (t) => html`<tr>
                    <td class="muted nowrap">${t.date}${t.pending ? html` <span class="pill">pending</span>` : raw('')}</td>
                    <td>
                      ${t.merchant ?? t.name ?? '—'}
                      ${t.corrected_by ? html`<span class="pill">${t.corrected_by === 'rule' ? 'rule' : 'edited'}</span>` : raw('')}
                      ${t.merchant && t.name && t.merchant !== t.name ? html`<div class="sub-line">${t.name}</div>` : raw('')}
                    </td>
                    <td class="muted">${t.account ?? '—'}${t.currency !== 'CAD' ? html` <span class="pill">${t.currency}</span>` : raw('')}</td>
                    <td class="num ${t.amount_cad < 0 ? 'neg' : 'pos'}">${money(t.amount_cad)}</td>
                    <td>${editCell(t)}</td>
                  </tr>`,
                ),
              )}</tbody>
            </table></div>`
      }
    </section>

    <section>
      <h2>Merchant rules <span class="muted">(${String(opts.rules.length)})</span></h2>
      <p class="sub-line">Applied in order, first match wins, to everything already stored and
        everything that arrives later. An edit to a single transaction still beats every rule.</p>
      ${
        opts.rules.length === 0
          ? html`<p class="muted">No rules yet. Group by merchant above and use “Apply to all”.</p>`
          : html`<div class="table-wrap"><table>
              <thead><tr><th>Matches</th><th>Becomes</th><th>Category</th><th class="num">Transactions</th><th></th></tr></thead>
              <tbody>${join(
                opts.rules.map(
                  (r) => html`<tr>
                    <td><code>${r.pattern}</code> <span class="muted">(${r.match_type})</span></td>
                    <td>${r.merchant ?? html`<span class="muted">unchanged</span>`}</td>
                    <td>${r.category ?? html`<span class="muted">unchanged</span>`}</td>
                    <td class="num">${String(r.matching_transactions)}</td>
                    <td class="num">
                      <form method="post" action="/transactions/rule/delete" class="inline-form"
                        data-confirm="Delete this rule? Matching transactions revert to what the bank reported.">
                        ${csrfField(opts.csrf)}
                        <input type="hidden" name="rule_id" value="${String(r.id)}">
                        <input type="hidden" name="back" value="${currentQuery(f)}">
                        <button class="secondary" type="submit">Delete</button>
                      </form>
                    </td>
                  </tr>`,
                ),
              )}</tbody>
            </table></div>`
      }
    </section>
  `;
}

/** Round-trips the current filters through a form post, so an edit returns here. */
function currentQuery(f: TxFilters): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(f)) if (v && v !== 'all' && v !== 'none') q.set(k, v);
  const s = q.toString();
  return s ? `/transactions?${s}` : '/transactions';
}

// --- merchants --------------------------------------------------------------

export type MerchantFilters = {
  start: string;
  end: string;
  profile: string;
  account_id: string;
  search: string;
  uncategorized: boolean;
};

function merchantQuery(f: MerchantFilters): string {
  const q = new URLSearchParams();
  if (f.start) q.set('start', f.start);
  if (f.end) q.set('end', f.end);
  if (f.profile) q.set('profile', f.profile);
  if (f.account_id) q.set('account_id', f.account_id);
  if (f.search) q.set('search', f.search);
  if (f.uncategorized) q.set('uncategorized', '1');
  const s = q.toString();
  return s ? `/merchants?${s}` : '/merchants';
}

export function merchantsPage(opts: {
  nonce: string;
  csrf: string;
  filters: MerchantFilters;
  merchants: MerchantGroup[];
  categoryGroups: CategoryGroup[];
  cards: AccountView[];
  categories: string[];
  customCategories: string[];
  profiles: Profile[];
  flash?: SafeHtml;
}): SafeHtml {
  const f = opts.filters;
  const back = merchantQuery(f);
  const totalSpend = round2(opts.categoryGroups.reduce((s, c) => s + c.spend_cad, 0));
  const uncategorized = opts.merchants.filter((m) => !m.category || m.category === 'UNCATEGORIZED');

  const opt = (value: string, label: string, selected: boolean): SafeHtml =>
    html`<option value="${value}"${selected ? raw(' selected') : raw('')}>${label}</option>`;

  /**
   * Assigning a category writes a merchant rule, so it covers this history and
   * everything that arrives later — the same mechanism the transactions page
   * uses, rather than a second parallel one that could disagree with it.
   */
  const categoryCell = (m: MerchantGroup): SafeHtml => html`<form method="post" action="/merchants/category" class="row tight">
    ${csrfField(opts.csrf)}
    <input type="hidden" name="merchant" value="${m.merchant}">
    <input type="hidden" name="back" value="${back}">
    <select name="category" data-autosubmit aria-label="Category for ${m.merchant}">
      ${opt('', 'uncategorised', !m.category || m.category === 'UNCATEGORIZED')}
      ${join(opts.categories.map((c) => opt(c, c, c === m.category)))}
    </select>
    <noscript><button class="secondary" type="submit">Set</button></noscript>
  </form>`;

  return html`
    <h1>Merchants</h1>
    <p class="sub">
      Every merchant seen on your cards and accounts, with the category its spend is filed under.
      Categories start as whatever the bank guessed; changing one here writes a rule that covers
      this history and everything that arrives later.
    </p>
    ${opts.flash ?? raw('')}

    <form method="get" action="/merchants" class="filters">
      <label>From <input type="date" name="start" value="${f.start}"></label>
      <label>To <input type="date" name="end" value="${f.end}"></label>
      <label>Search <input type="search" name="search" value="${f.search}" placeholder="merchant"></label>
      <label>Card or account
        <select name="account_id">
          ${opt('', 'All accounts', f.account_id === '')}
          ${join(
            opts.cards.map((a) =>
              opt(a.id, `${a.name ?? a.id}${a.mask ? ` ••${a.mask}` : ''}`, a.id === f.account_id),
            ),
          )}
        </select>
      </label>
      ${
        opts.profiles.length > 1
          ? html`<label>Profile
              <select name="profile">
                ${opt('', 'All profiles', f.profile === '')}
                ${join(opts.profiles.map((p) => opt(p.id, p.name, p.id === f.profile)))}
              </select>
            </label>`
          : raw('')
      }
      <label>Show
        <select name="uncategorized">
          ${opt('', 'All merchants', !f.uncategorized)}
          ${opt('1', 'Uncategorised only', f.uncategorized)}
        </select>
      </label>
      <button type="submit">Apply</button>
      <a class="btn-link" href="/merchants">Reset</a>
    </form>

    <div class="kpis">
      <div class="kpi"><div class="label">Merchants</div><div class="value">${String(opts.merchants.length)}</div></div>
      <div class="kpi"><div class="label">Categories</div><div class="value">${String(opts.categoryGroups.length)}</div></div>
      <div class="kpi"><div class="label">Uncategorised</div><div class="value ${uncategorized.length ? 'neg' : 'muted'}">${String(uncategorized.length)}</div></div>
      <div class="kpi"><div class="label">Total spend</div><div class="value neg">${money(-totalSpend)}</div></div>
    </div>

    <section>
      <h2>Expenses by category</h2>
      ${
        opts.categoryGroups.length === 0
          ? html`<p class="muted">No spending in this period.</p>`
          : hBars({
              title: 'Expenses by category',
              width: 900,
              empty: 'No spending in this period.',
              rows: opts.categoryGroups
                .filter((c) => c.spend_cad > 0)
                .slice(0, 10)
                .map((c) => ({
                  label: c.category,
                  value: c.spend_cad,
                  note: `${String(c.count)} transaction(s), ${String(c.merchants)} merchant(s)`,
                })),
            })
      }
    </section>

    ${
      opts.categoryGroups.length
        ? html`<section>
            <h2>Category totals</h2>
            <div class="table-wrap"><table>
              <thead><tr><th>Category</th><th class="num">Spend</th><th class="num">Share</th><th class="num">Merchants</th><th class="num">Transactions</th></tr></thead>
              <tbody>${join(
                opts.categoryGroups.map(
                  (c) => html`<tr>
                    <td>${c.category}</td>
                    <td class="num neg">${c.spend_cad ? money(-c.spend_cad) : html`<span class="muted">—</span>`}</td>
                    <td class="num">${totalSpend > 0 ? `${((c.spend_cad / totalSpend) * 100).toFixed(1)}%` : '—'}</td>
                    <td class="num">${String(c.merchants)}</td>
                    <td class="num">${String(c.count)}</td>
                  </tr>`,
                ),
              )}</tbody>
            </table></div>
          </section>`
        : raw('')
    }

    <section>
      <h2>Merchants <span class="muted">(${String(opts.merchants.length)})</span></h2>
      ${
        opts.merchants.length === 0
          ? html`<p class="muted">No merchants match these filters.</p>`
          : html`<div class="table-wrap"><table>
              <thead><tr><th>Merchant</th><th>Category</th><th class="num">Spend</th><th class="num">Count</th><th>Cards used</th><th>Seen</th></tr></thead>
              <tbody>${join(
                opts.merchants.map(
                  (m) => html`<tr>
                    <td>${m.merchant}${m.corrected ? html` <span class="pill">rule</span>` : raw('')}</td>
                    <td>${categoryCell(m)}</td>
                    <td class="num neg">${m.spend_cad ? money(-m.spend_cad) : html`<span class="muted">—</span>`}</td>
                    <td class="num">${String(m.count)}</td>
                    <td class="muted">${m.accounts.length ? m.accounts.join(', ') : '—'}</td>
                    <td class="muted nowrap">${m.first === m.last ? m.first : `${m.first} → ${m.last}`}</td>
                  </tr>`,
                ),
              )}</tbody>
            </table></div>`
      }
    </section>

    <section>
      <h2>Your categories</h2>
      <p class="sub-line">The bank's taxonomy is generic. Add your own and they appear in every
        category picker, including before anything is filed under them.</p>
      <form method="post" action="/categories" class="row mb">
        ${csrfField(opts.csrf)}
        <input type="hidden" name="back" value="${back}">
        <input type="text" name="name" placeholder="e.g. Childcare" aria-label="New category" required>
        <button type="submit">Add category</button>
      </form>
      ${
        opts.customCategories.length === 0
          ? html`<p class="muted">None yet — the pickers show what the banks sent.</p>`
          : html`<div class="table-wrap"><table>
              <thead><tr><th>Category</th><th class="num">In use</th><th></th></tr></thead>
              <tbody>${join(
                opts.customCategories.map((name) => {
                  const used = opts.categoryGroups.find((c) => c.category === name);
                  return html`<tr>
                    <td>${name}</td>
                    <td class="num">${used ? String(used.count) : html`<span class="muted">0</span>`}</td>
                    <td class="num">
                      <form method="post" action="/categories/delete" class="inline-form"
                        data-confirm="Remove this category? Transactions already filed under it keep it.">
                        ${csrfField(opts.csrf)}
                        <input type="hidden" name="name" value="${name}">
                        <input type="hidden" name="back" value="${back}">
                        <button class="secondary" type="submit">Remove</button>
                      </form>
                    </td>
                  </tr>`;
                }),
              )}</tbody>
            </table></div>`
      }
    </section>
  `;
}

// --- assistant --------------------------------------------------------------

/**
 * A chart the assistant asked for. Rendered through the same module the rest of
 * the app uses, so a model-drawn chart obeys the same palette, mark specs and
 * table-twin rule as every other chart here.
 */
function assistantChart(body: string): SafeHtml | null {
  let spec: { type?: string; title?: string; rows?: Array<{ label?: unknown; value?: unknown }> };
  try {
    spec = JSON.parse(body) as typeof spec;
  } catch {
    return null;
  }
  const rows = (spec.rows ?? [])
    .map((r) => ({ label: String(r.label ?? ''), value: Number(r.value) }))
    .filter((r) => r.label !== '' && Number.isFinite(r.value));
  if (rows.length === 0) return null;

  const title = spec.title ?? 'Chart';
  if (spec.type === 'line') {
    return html`<figure class="chart-card">
      <figcaption>${title}</figcaption>
      ${areaChart({ title, points: rows })}
    </figure>`;
  }
  if (spec.type === 'stack') {
    return html`<figure class="chart-card">
      <figcaption>${title}</figcaption>
      ${stackedBar({ title, segments: rows })}
    </figure>`;
  }
  return html`<figure class="chart-card">
    <figcaption>${title}</figcaption>
    ${hBars({ title, width: 760, rows, empty: 'Nothing to plot.' })}
  </figure>`;
}

function assistantBody(markdown: string): SafeHtml {
  return renderMarkdown(markdown, (block) =>
    block.lang === 'tally-chart' ? assistantChart(block.body) : null,
  );
}

export function chatPage(opts: {
  nonce: string;
  csrf: string;
  ready: boolean;
  provider: string;
  model: string;
  chats: ChatRow[];
  chat: ChatRow | null;
  messages: StoredMessage[];
  pending?: string;
  error?: string;
  flash?: SafeHtml;
}): SafeHtml {
  if (!opts.ready) {
    return html`
      <h1>Assistant</h1>
      ${notice(
        'warn',
        'No LLM provider is configured, so the assistant is off. Add a provider, model and API key ' +
          'under Settings to turn it on.',
      )}
      <section>
        <h2>Before you turn this on</h2>
        <p>Every other part of tally keeps your data on this server: Claude reaches it through MCP,
          with your consent, one request at a time. A built-in assistant is different — it sends
          balances and transactions to whichever provider holds the key, on every message. That is a
          real trade, and it is off until you make it.</p>
        <p class="sub-line">If you already use Claude, the MCP connector gives you the same answers
          without a second copy of your data leaving the box. This exists for people who would
          rather not, or who want a different model.</p>
      </section>`;
  }

  const threads = html`<aside class="chat-threads">
    <a class="btn btn-new-chat" href="/chat?new=1">New chat</a>
    ${
      opts.chats.length === 0
        ? html`<p class="muted">No chats yet.</p>`
        : html`<ul class="thread-list">${join(
            opts.chats.map(
              (c) => html`<li${c.id === opts.chat?.id ? raw(' class="current"') : raw('')}>
                <a href="/chat/${c.id}">${c.title}</a>
                <span class="sub-line">${c.updated_at.slice(0, 10)}</span>
              </li>`,
            ),
          )}</ul>`
    }
  </aside>`;

  const bubble = (m: StoredMessage): SafeHtml => {
    if (m.role === 'user') {
      return html`<article class="msg user"><div class="msg-body">${m.content}</div></article>`;
    }
    const tools = [...new Set(m.runs.map((r) => r.name))];
    const failed = m.runs.filter((r) => !r.ok);
    return html`<article class="msg assistant">
      <div class="msg-body">${assistantBody(m.content)}</div>
      ${
        tools.length
          ? html`<details class="msg-tools">
              <summary>${String(m.runs.length)} lookup${m.runs.length === 1 ? '' : 's'}${
                failed.length ? html` · ${String(failed.length)} failed` : raw('')
              }</summary>
              <div class="table-wrap"><table>
                <thead><tr><th>Tool</th><th>Arguments</th><th>Result</th></tr></thead>
                <tbody>${join(
                  m.runs.map(
                    (r) => html`<tr>
                      <td><code>${r.name}</code>${r.ok ? raw('') : html` <span class="pill bad">error</span>`}</td>
                      <td><code>${JSON.stringify(r.args)}</code></td>
                      <td class="muted">${r.result.slice(0, 400)}</td>
                    </tr>`,
                  ),
                )}</tbody>
              </table></div>
            </details>`
          : raw('')
      }
      <div class="msg-actions">
        <details class="msg-source">
          <summary>Markdown</summary>
          <pre class="code-block"><code>${m.content}</code></pre>
        </details>
        ${m.model ? html`<span class="sub-line">${m.model}</span>` : raw('')}
      </div>
    </article>`;
  };

  return html`
    <div class="row mb chat-head">
      <h1>Assistant</h1>
      <span class="muted">${opts.provider} · ${opts.model}</span>
      ${
        opts.chat
          ? html`<form method="post" action="/chat/delete" class="inline-form"
              data-confirm="Delete this conversation? The transcript is removed from this server.">
              ${csrfField(opts.csrf)}
              <input type="hidden" name="chat_id" value="${opts.chat.id}">
              <button class="secondary" type="submit">Delete chat</button>
            </form>`
          : raw('')
      }
    </div>
    ${opts.flash ?? raw('')}
    ${opts.error ? notice('err', opts.error) : raw('')}

    <div class="chat-layout">
      ${threads}
      <div class="chat-main">
        ${
          opts.messages.length === 0
            ? html`<div class="chat-empty">
                <p class="muted">Ask about your accounts. The assistant reads them through the same
                  read-only tools the MCP server exposes — it can look anything up, and it cannot
                  move money.</p>
                <ul class="suggestions">
                  <li>How am I doing this year?</li>
                  <li>What did I spend on groceries last month?</li>
                  <li>Which cards have a balance right now?</li>
                  <li>How much did I get in dividends this year?</li>
                </ul>
              </div>`
            : join(opts.messages.filter((m) => m.role !== 'tool').map(bubble))
        }
        ${
          opts.pending
            ? html`<article class="msg user"><div class="msg-body">${opts.pending}</div></article>
              <article class="msg assistant"><div class="msg-body muted">Thinking…</div></article>`
            : raw('')
        }

        <form method="post" action="/chat" class="chat-input">
          ${csrfField(opts.csrf)}
          ${opts.chat ? html`<input type="hidden" name="chat_id" value="${opts.chat.id}">` : raw('')}
          <textarea name="message" rows="3" required
            placeholder="Ask about your accounts…" aria-label="Message"></textarea>
          <button type="submit">Send</button>
        </form>
        <p class="sub-line">Sent to ${opts.provider}. Balances and transactions leave this server
          with every message.</p>
      </div>
    </div>`;
}
