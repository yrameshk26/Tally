/**
 * Page shell. Server-rendered, no build step, no framework, no webfonts — the
 * only third-party script anywhere is Plaid Link, and only on the page that
 * needs it. Everything inline is nonce-allowed so the CSP can stay strict.
 */
import { html, raw, type SafeHtml } from '../lib/html.ts';

export type Nav = { href: string; label: string };

export const NAV: Nav[] = [
  { href: '/', label: 'Overview' },
  { href: '/connections', label: 'Connections' },
  { href: '/profiles', label: 'Profiles' },
  { href: '/settings', label: 'Settings' },
  { href: '/security', label: 'Security' },
];

const CSS = `
:root{color-scheme:light dark;
  --bg:#f7f7f5;--panel:#fff;--fg:#16181a;--muted:#5f6672;--line:#e4e4df;
  --accent:#1f6f4a;--accent-fg:#fff;--pos:#1f6f4a;--neg:#b3261e;--warn:#8a5a00;
  --radius:10px;--shadow:0 1px 2px rgba(0,0,0,.05),0 1px 8px rgba(0,0,0,.03)}
@media (prefers-color-scheme:dark){:root{
  --bg:#121417;--panel:#1a1d21;--fg:#e9ecef;--muted:#9aa3ad;--line:#2b3037;
  --accent:#6ec49a;--accent-fg:#0d1512;--pos:#6ec49a;--neg:#ef9a93;--warn:#d9a441;
  --shadow:0 1px 2px rgba(0,0,0,.4)}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);
  font:15px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
  -webkit-font-smoothing:antialiased}
header{border-bottom:1px solid var(--line);background:var(--panel)}
.bar{max-width:64rem;margin:0 auto;padding:.85rem 1.25rem;display:flex;gap:1.25rem;align-items:center;flex-wrap:wrap}
.brand{font-weight:700;letter-spacing:-.02em;font-size:1.05rem;text-decoration:none;color:inherit}
nav{display:flex;gap:.25rem;flex:1;flex-wrap:wrap}
nav a{padding:.35rem .7rem;border-radius:7px;text-decoration:none;color:var(--muted);font-weight:500}
nav a:hover{background:var(--bg);color:var(--fg)}
nav a[aria-current=page]{background:var(--bg);color:var(--fg);font-weight:600}
main{max-width:64rem;margin:0 auto;padding:1.75rem 1.25rem 4rem}
h1{font-size:1.5rem;letter-spacing:-.02em;margin:0 0 .35rem}
h2{font-size:1.05rem;margin:0 0 .9rem;letter-spacing:-.01em}
p.sub{color:var(--muted);margin:0 0 1.75rem}
section{background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);
  padding:1.25rem 1.4rem;margin-bottom:1.1rem;box-shadow:var(--shadow)}
table{width:100%;border-collapse:collapse}
th,td{text-align:left;padding:.5rem .55rem;border-bottom:1px solid var(--line);vertical-align:top}
th{font-size:.72rem;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);font-weight:600}
tr:last-child td{border-bottom:0}
td.num,th.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.pos{color:var(--pos)}.neg{color:var(--neg)}.muted{color:var(--muted)}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(11rem,1fr));gap:.9rem;margin-bottom:1.1rem}
.kpi{background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);padding:1rem 1.1rem;box-shadow:var(--shadow)}
.kpi .label{font-size:.72rem;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);font-weight:600}
.kpi .value{font-size:1.5rem;font-weight:650;letter-spacing:-.02em;font-variant-numeric:tabular-nums;margin-top:.3rem}
form{margin:0}
label{display:block;font-weight:600;font-size:.83rem;margin:0 0 .3rem}
input[type=text],input[type=password],input[type=email],select{
  font:inherit;width:100%;padding:.55rem .7rem;border:1px solid var(--line);border-radius:8px;
  background:var(--bg);color:inherit}
input:focus,select:focus{outline:2px solid var(--accent);outline-offset:1px}
.field{margin-bottom:.9rem}
.hint{color:var(--muted);font-size:.82rem;margin-top:.3rem}
button,.btn{font:inherit;font-weight:600;padding:.55rem 1.05rem;border-radius:8px;border:1px solid var(--accent);
  background:var(--accent);color:var(--accent-fg);cursor:pointer;text-decoration:none;display:inline-block}
button.secondary,.btn.secondary{background:transparent;color:var(--fg);border-color:var(--line)}
button.danger{background:transparent;color:var(--neg);border-color:var(--neg)}
button:disabled{opacity:.55;cursor:progress}
.row{display:flex;gap:.6rem;align-items:center;flex-wrap:wrap}
.pill{display:inline-block;padding:.12rem .5rem;border-radius:99px;font-size:.74rem;font-weight:600;border:1px solid var(--line)}
.pill.ok{color:var(--pos);border-color:currentColor}
.pill.bad{color:var(--neg);border-color:currentColor}
.pill.warn{color:var(--warn);border-color:currentColor}
.notice{padding:.7rem .9rem;border-radius:8px;border:1px solid var(--line);margin-bottom:1.1rem;font-size:.92rem}
.notice.err{border-color:var(--neg);color:var(--neg)}
.notice.ok{border-color:var(--pos);color:var(--pos)}
.notice.warn{border-color:var(--warn);color:var(--warn)}
code,.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.86em}
.code-block{background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:.7rem .8rem;
  word-break:break-all;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.82rem}
.login{max-width:22rem;margin:12vh auto}
@media(max-width:560px){main{padding:1.25rem .9rem 3rem}section{padding:1rem}th,td{padding:.45rem .35rem}}
`;

export function page(opts: {
  title: string;
  nonce: string;
  current?: string;
  chrome?: boolean;
  body: SafeHtml;
}): string {
  const { title, nonce, current, chrome = true, body } = opts;
  const nav = chrome
    ? html`<header><div class="bar">
        <a class="brand" href="/">tally</a>
        <nav>${raw(
          NAV.map(
            (n) =>
              `<a href="${n.href}"${n.href === current ? ' aria-current="page"' : ''}>${n.label}</a>`,
          ).join(''),
        )}</nav>
        <form method="post" action="/logout"><button class="secondary" type="submit">Sign out</button></form>
      </div></header>`
    : raw('');

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${title} · tally</title>
<style nonce="${nonce}">${CSS}</style>
</head><body>${nav.value}<main>${body.value}</main></body></html>`;
}

export function notice(kind: 'ok' | 'err' | 'warn', message: string): SafeHtml {
  return html`<div class="notice ${kind}">${message}</div>`;
}

export function csrfField(token: string): SafeHtml {
  return html`<input type="hidden" name="_csrf" value="${token}">`;
}
