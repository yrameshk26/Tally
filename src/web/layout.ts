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
/* ---------------------------------------------------------------------------
   Colour is defined in OKLCH: perceptually uniform, so a lightness step looks
   like the same step on every hue, and the dark theme is a genuine re-mix
   rather than the light theme with the brightness turned down.
   Hover/active/tint states derive from the tokens with color-mix(), which
   keeps the palette to a handful of sources of truth.
--------------------------------------------------------------------------- */
:root{
  color-scheme:light dark;
  --hue:255;            /* cool neutral */
  --accent-hue:172;     /* jade — money, without the traffic-light green */

  --bg:oklch(98.6% .004 var(--hue));
  --bg-sunk:oklch(96.6% .006 var(--hue));
  --panel:oklch(100% 0 0);
  --line:oklch(91.5% .006 var(--hue));
  --line-strong:oklch(85% .008 var(--hue));
  --fg:oklch(24% .018 var(--hue));
  --fg-muted:oklch(52% .016 var(--hue));
  --fg-faint:oklch(64% .012 var(--hue));

  --accent:oklch(52% .11 var(--accent-hue));
  --accent-fg:oklch(99% .01 var(--accent-hue));
  --pos:oklch(52% .11 var(--accent-hue));
  --neg:oklch(54% .18 25);
  --warn:oklch(58% .13 75);

  --radius:12px;
  --radius-sm:8px;
  --shadow:0 1px 2px oklch(24% .02 var(--hue)/.05), 0 2px 10px oklch(24% .02 var(--hue)/.04);
  --shadow-lift:0 2px 4px oklch(24% .02 var(--hue)/.06), 0 12px 28px oklch(24% .02 var(--hue)/.08);
  --ring:0 0 0 3px color-mix(in oklch, var(--accent) 28%, transparent);
  /* Derived from the foreground, so it darkens a light panel and lightens a
     dark one. Reusing --bg-sunk here punched a black hole through dark rows. */
  --hover:color-mix(in oklch, var(--fg) 5%, transparent);

  --step--1:clamp(.78rem,.76rem + .1vw,.83rem);
  --step-0:clamp(.92rem,.9rem + .12vw,.97rem);
  --step-1:clamp(1.05rem,1rem + .25vw,1.16rem);
  --step-2:clamp(1.4rem,1.28rem + .6vw,1.75rem);
  --step-3:clamp(1.75rem,1.5rem + 1.2vw,2.4rem);
}
@media (prefers-color-scheme:dark){:root{
  --bg:oklch(17.5% .012 var(--hue));
  --bg-sunk:oklch(14.5% .012 var(--hue));
  --panel:oklch(21.5% .014 var(--hue));
  --line:oklch(28.5% .016 var(--hue));
  --line-strong:oklch(36% .02 var(--hue));
  --fg:oklch(94% .008 var(--hue));
  --fg-muted:oklch(72% .016 var(--hue));
  --fg-faint:oklch(58% .014 var(--hue));
  --accent:oklch(76% .13 var(--accent-hue));
  --accent-fg:oklch(18% .04 var(--accent-hue));
  --pos:oklch(78% .14 var(--accent-hue));
  --neg:oklch(72% .15 25);
  --warn:oklch(80% .13 80);
  --shadow:0 1px 2px oklch(0% 0 0/.35);
  --shadow-lift:0 2px 6px oklch(0% 0 0/.4), 0 16px 32px oklch(0% 0 0/.35);
}}

/* Cross-document view transitions: page changes crossfade instead of
   flashing white, which is what makes a multi-page app feel like an SPA
   without shipping one. */
@view-transition{navigation:auto}
@media (prefers-reduced-motion:reduce){
  @view-transition{navigation:none}
  *,*::before,*::after{animation-duration:.01ms !important;transition-duration:.01ms !important}
}

*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{
  margin:0;background:var(--bg);color:var(--fg);
  font:var(--step-0)/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
  -webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility;
  font-variant-numeric:tabular-nums;
}
::selection{background:color-mix(in oklch,var(--accent) 28%,transparent)}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:4px}

/* --- chrome --------------------------------------------------------------- */
header{
  position:sticky;top:0;z-index:20;
  background:color-mix(in oklch,var(--panel) 82%,transparent);
  backdrop-filter:saturate(180%) blur(12px);
  border-bottom:1px solid var(--line);
  view-transition-name:header;
}
.bar{max-width:68rem;margin:0 auto;padding:.7rem 1.25rem;display:flex;gap:1rem;align-items:center;flex-wrap:wrap}
.brand{
  display:inline-flex;align-items:center;gap:.5rem;font-weight:660;font-size:var(--step-1);
  letter-spacing:-.022em;text-decoration:none;color:inherit;
}
.brand .dot{width:.66rem;height:.66rem;border-radius:50%;
  background:linear-gradient(140deg,var(--accent),color-mix(in oklch,var(--accent) 45%,var(--warn)));
  box-shadow:0 0 0 3px color-mix(in oklch,var(--accent) 16%,transparent)}
nav{display:flex;gap:.15rem;flex:1;flex-wrap:wrap}
nav a{
  padding:.38rem .72rem;border-radius:var(--radius-sm);text-decoration:none;
  color:var(--fg-muted);font-weight:520;font-size:var(--step--1);
  transition:background .16s ease,color .16s ease;
}
nav a:hover{background:var(--hover);color:var(--fg)}
nav a[aria-current=page]{background:color-mix(in oklch,var(--accent) 12%,transparent);color:var(--accent);font-weight:600}
main{max-width:68rem;margin:0 auto;padding:1.9rem 1.25rem 5rem}

h1{font-size:var(--step-3);letter-spacing:-.03em;margin:0 0 .3rem;font-weight:660;text-wrap:balance}
h2{font-size:var(--step-1);margin:0 0 1rem;letter-spacing:-.018em;font-weight:620}
p.sub{color:var(--fg-muted);margin:0 0 1.8rem;max-width:62ch;text-wrap:pretty}
.hint{color:var(--fg-muted);font-size:var(--step--1);margin-top:.35rem;text-wrap:pretty}

section{
  background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);
  padding:1.25rem 1.4rem;margin-bottom:1.1rem;box-shadow:var(--shadow);
}

/* --- KPIs ----------------------------------------------------------------- */
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(11.5rem,1fr));gap:.85rem;margin-bottom:1.1rem}
.kpi{
  background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);
  padding:1.05rem 1.15rem;box-shadow:var(--shadow);
  transition:transform .18s cubic-bezier(.2,.7,.3,1),box-shadow .18s ease,border-color .18s ease;
}
.kpi:hover{transform:translateY(-2px);box-shadow:var(--shadow-lift);border-color:var(--line-strong)}
.kpi .label{font-size:.7rem;text-transform:uppercase;letter-spacing:.075em;color:var(--fg-faint);font-weight:640}
.kpi .value{font-size:var(--step-2);font-weight:640;letter-spacing:-.03em;margin-top:.35rem;line-height:1.1}

/* --- tables --------------------------------------------------------------- */
.table-wrap{overflow-x:auto;margin:0 -.35rem;padding:0 .35rem}
table{width:100%;border-collapse:collapse;font-size:var(--step--1)}
th,td{text-align:left;padding:.62rem .6rem;border-bottom:1px solid var(--line);vertical-align:middle}
/* Deliberately NOT sticky. A sticky thead inside the horizontal scroll
   container overlapped and hid the first row of every table — the largest
   holding and the biggest account were both invisible. These tables are short;
   stickiness bought nothing and cost data. */
thead th{
  background:var(--panel);
  font-size:.68rem;text-transform:uppercase;letter-spacing:.075em;color:var(--fg-faint);font-weight:640;
  border-bottom-color:var(--line-strong);
}
tbody tr{transition:background .13s ease}
tbody tr:hover{background:var(--hover)}
tbody tr:last-child td{border-bottom:0}
td.num,th.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
td strong{font-weight:620}
.pos{color:var(--pos)}.neg{color:var(--neg)}.muted{color:var(--fg-muted)}

/* --- controls ------------------------------------------------------------- */
form{margin:0}
label{display:block;font-weight:600;font-size:var(--step--1);margin:0 0 .35rem}
input[type=text],input[type=password],input[type=email],input:not([type]),select{
  font:inherit;width:100%;padding:.6rem .75rem;border:1px solid var(--line-strong);
  border-radius:var(--radius-sm);background:var(--bg);color:inherit;
  transition:border-color .16s ease,box-shadow .16s ease,background .16s ease;
}
input:hover,select:hover{border-color:color-mix(in oklch,var(--accent) 40%,var(--line-strong))}
input:focus,select:focus{outline:none;border-color:var(--accent);box-shadow:var(--ring);background:var(--panel)}
input::placeholder{color:var(--fg-faint)}
.field{margin-bottom:1rem}
/* A field whose input is focused gets a highlighted label — :has() replaces
   what used to need a JS focus handler. */
.field:has(input:focus) label{color:var(--accent)}

button,.btn{
  font:inherit;font-weight:590;font-size:var(--step--1);padding:.55rem 1.05rem;
  border-radius:var(--radius-sm);border:1px solid transparent;background:var(--accent);
  color:var(--accent-fg);cursor:pointer;text-decoration:none;display:inline-flex;
  align-items:center;gap:.4rem;white-space:nowrap;
  transition:transform .12s cubic-bezier(.2,.7,.3,1),filter .16s ease,background .16s ease,border-color .16s ease;
}
button:hover,.btn:hover{filter:brightness(1.07)}
button:active,.btn:active{transform:translateY(1px)}
button.secondary,.btn.secondary{background:var(--panel);color:var(--fg);border-color:var(--line-strong)}
button.secondary:hover,.btn.secondary:hover{background:var(--hover);border-color:var(--accent);filter:none}
button.danger{background:transparent;color:var(--neg);border-color:color-mix(in oklch,var(--neg) 45%,transparent)}
button.danger:hover{background:color-mix(in oklch,var(--neg) 10%,transparent);filter:none}
button:disabled{opacity:.5;cursor:not-allowed;transform:none;filter:none}
.row{display:flex;gap:.6rem;align-items:center;flex-wrap:wrap}

.pill{
  display:inline-flex;align-items:center;gap:.3rem;padding:.14rem .55rem;border-radius:999px;
  font-size:.72rem;font-weight:620;letter-spacing:.005em;
  border:1px solid var(--line-strong);color:var(--fg-muted);background:var(--bg-sunk);
}
.pill.ok{color:var(--pos);border-color:color-mix(in oklch,var(--pos) 35%,transparent);
  background:color-mix(in oklch,var(--pos) 10%,transparent)}
.pill.bad{color:var(--neg);border-color:color-mix(in oklch,var(--neg) 35%,transparent);
  background:color-mix(in oklch,var(--neg) 10%,transparent)}
.pill.warn{color:var(--warn);border-color:color-mix(in oklch,var(--warn) 35%,transparent);
  background:color-mix(in oklch,var(--warn) 12%,transparent)}

.notice{
  padding:.8rem 1rem;border-radius:var(--radius-sm);border:1px solid var(--line-strong);
  margin-bottom:1.1rem;font-size:var(--step--1);background:var(--panel);
  display:flex;gap:.6rem;align-items:flex-start;
}
/* Entry animation that also works on first paint, via @starting-style. */
@starting-style{.notice{opacity:0;transform:translateY(-4px)}}
.notice{transition:opacity .25s ease,transform .25s ease}
.notice.err{border-color:color-mix(in oklch,var(--neg) 45%,transparent);color:var(--neg);
  background:color-mix(in oklch,var(--neg) 7%,var(--panel))}
.notice.ok{border-color:color-mix(in oklch,var(--pos) 45%,transparent);color:var(--pos);
  background:color-mix(in oklch,var(--pos) 7%,var(--panel))}
.notice.warn{border-color:color-mix(in oklch,var(--warn) 45%,transparent);color:var(--warn);
  background:color-mix(in oklch,var(--warn) 8%,var(--panel))}

code,.mono{font-family:ui-monospace,SFMono-Regular,"SF Mono",Menlo,monospace;font-size:.86em}
.code-block{
  background:var(--bg-sunk);border:1px solid var(--line);border-radius:var(--radius-sm);
  padding:.7rem .85rem;word-break:break-all;user-select:all;
  font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:var(--step--1);
}

input.otp{
  font-family:ui-monospace,SFMono-Regular,Menlo,monospace;
  font-size:1.6rem;letter-spacing:.42em;text-align:center;padding:.7rem .5rem .7rem .92rem;
  font-variant-numeric:tabular-nums;
}
.login{max-width:23rem;margin:min(14vh,7rem) auto}
.login h1{text-align:center}
.login p.sub{text-align:center;margin-bottom:1.6rem}

/* --- small utilities, so no markup needs a style attribute. A strict CSP
   (style-src with a nonce and no 'unsafe-inline') blocks inline style
   attributes outright, which silently broke every one of them. --- */
.mb{margin-bottom:1.1rem}.mb-sm{margin-bottom:.75rem}
.mt{margin-top:1rem}.mt-sm{margin-top:.9rem}.mt-xs{margin-top:.6rem}
.tight{gap:.35rem}
.inline-form{display:inline-flex}
.w-sm{max-width:12rem}.w-md{max-width:14rem}.w-lg{max-width:18rem}
.sub-line{font-size:.78rem;color:var(--fg-muted);margin-top:.15rem}
.icon{flex:0 0 auto;margin-top:.1rem}
.cell-stack{display:flex;flex-direction:column;gap:.1rem}
.split{display:grid;grid-template-columns:repeat(auto-fit,minmax(17rem,1fr));gap:1.1rem;margin-bottom:1.1rem;align-items:start}
.split section{margin-bottom:0}
.kv td{padding:.42rem .6rem}
.kv td:first-child{color:var(--fg-muted)}
.empty{color:var(--fg-muted);font-size:var(--step--1);padding:.4rem 0}
ol.steps{margin:0 0 .6rem;padding-left:1.15rem;color:var(--fg-muted);font-size:var(--step--1)}
ol.steps li{margin-bottom:.25rem}
ol.steps strong{color:var(--fg)}

@media(max-width:640px){
  main{padding:1.3rem .9rem 3.5rem}
  section{padding:1.05rem 1rem;border-radius:10px}
  th,td{padding:.55rem .4rem}

  /* Two-row header: identity and sign-out on top, navigation scrolling
     horizontally beneath. Letting nav wrap around the brand produced three
     ragged lines on a phone. */
  .bar{display:grid;grid-template-columns:1fr auto;gap:.55rem .75rem;padding:.6rem .9rem}
  .brand{grid-column:1;grid-row:1}
  .bar > form{grid-column:2;grid-row:1;justify-self:end}
  nav{
    grid-column:1/-1;grid-row:2;flex-wrap:nowrap;overflow-x:auto;
    scrollbar-width:none;-ms-overflow-style:none;margin:0 -.9rem;padding:0 .9rem;
  }
  nav::-webkit-scrollbar{display:none}

  /* Two across rather than one: four stacked cards pushed everything else
     below the fold. */
  .kpis{grid-template-columns:1fr 1fr;gap:.6rem}
  .kpi{padding:.8rem .85rem}
  .kpi .value{font-size:1.15rem;letter-spacing:-.02em}
  .kpi .label{font-size:.64rem}

  .split{gap:.85rem}
  input.otp{font-size:1.4rem;letter-spacing:.3em}
}
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
        <a class="brand" href="/"><span class="dot"></span>tally</a>
        <nav>${raw(
          NAV.map(
            (n) =>
              `<a href="${n.href}"${n.href === current ? ' aria-current="page"' : ''}>${n.label}</a>`,
          ).join(''),
        )}</nav>
        <form method="post" action="/logout"><button class="secondary" type="submit">Sign out</button></form>
      </div></header>`
    : raw('');

  // Speculation Rules prerender a page on hover, so by the time the click
  // lands the document is already built. Combined with cross-document view
  // transitions this gives SPA-grade navigation with no client framework and
  // no JavaScript of our own. Same-origin only, and eagerness is "moderate" so
  // it costs nothing until there is real intent.
  const speculation = chrome
    ? `<script type="speculationrules" nonce="${nonce}">${JSON.stringify({
        prerender: [
          {
            // Explicit list rather than a wildcard: prerendering issues a real
            // GET with cookies, so it should only ever hit pages we know are
            // pure reads.
            urls: NAV.map((n) => n.href),
            eagerness: 'moderate',
          },
        ],
      })}</scr` + `ipt>`
    : '';

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<meta name="color-scheme" content="light dark">
<title>${title} · tally</title>
<style nonce="${nonce}">${CSS}</style>
${speculation}
</head><body>${nav.value}<main>${body.value}</main></body></html>`;
}

const NOTICE_ICON: Record<string, string> = {
  ok: 'M20 6 9 17l-5-5',
  err: 'M12 9v4m0 4h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z',
  warn: 'M12 9v4m0 4h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z',
};

export function notice(kind: 'ok' | 'err' | 'warn', message: string): SafeHtml {
  const icon = raw(
    `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"` +
      ` stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"` +
      ` class="icon"><path d="${NOTICE_ICON[kind]}"/></svg>`,
  );
  return html`<div class="notice ${kind}" role="status">${icon}<span>${message}</span></div>`;
}

export function csrfField(token: string): SafeHtml {
  return html`<input type="hidden" name="_csrf" value="${token}">`;
}
