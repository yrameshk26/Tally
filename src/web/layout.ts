/**
 * Page shell. Server-rendered, no build step, no framework, no webfonts — the
 * only third-party script anywhere is Plaid Link, and only on the page that
 * needs it. Everything inline is nonce-allowed so the CSP can stay strict.
 */
import { idleMs } from '../auth/session.ts';
import { esc, html, raw, type SafeHtml } from '../lib/html.ts';
import { logoSvg } from './logo.ts';

export type Nav = { href: string; label: string };

/** The uploaded logo if there is one, otherwise the built-in tally mark. */
export function brandMark(logoUrl: string | null, size: number): SafeHtml {
  return logoUrl
    ? html`<img class="mark mark-img" src="${logoUrl}" alt="" width="${String(size)}" height="${String(size)}">`
    : raw(logoSvg(size, 'mark'));
}

export const NAV: Nav[] = [
  { href: '/', label: 'Overview' },
  { href: '/transactions', label: 'Transactions' },
  { href: '/merchants', label: 'Merchants' },
  { href: '/report', label: 'Reports' },
  { href: '/chat', label: 'Assistant' },
  { href: '/connections', label: 'Connections' },
  { href: '/profiles', label: 'Profiles' },
  { href: '/settings', label: 'Settings' },
  { href: '/security', label: 'Security' },
];

/**
 * Open-source footer. Deliberately one quiet line: this is a page someone opens
 * to look at their own money, not a place to sell to them.
 */
const footer = (name: string): string =>
  '<footer class="site-footer">' +
  // A renamed install still says what it runs on, so the link to the project
  // survives the rename.
  (name === 'tally'
    ? '<span>tally — open source, MIT.</span> '
    : `<span>${esc(name)} runs on tally, open source, MIT.</span> `) +
  '<a href="https://github.com/yrameshk26/Tally" rel="noreferrer noopener" target="_blank">Star it on GitHub</a>' +
  ' · ' +
  '<a href="https://github.com/sponsors/yrameshk26" rel="noreferrer noopener" target="_blank">Sponsor</a>' +
  '</footer>';

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

  /* Categorical series slots, in fixed order — assigned by entity, never by
     rank, and never cycled past the last slot. Validated with the palette
     script against this surface in both modes: lightness band, chroma floor,
     CVD separation, normal-vision floor and contrast. Light s4/s5 sit under
     3:1, which is legal only with the relief every chart here ships: visible
     direct labels plus a table view. */
  --s1:#0f7f62; --s2:#eb6834; --s3:#2a78d6;
  --s4:#eda100; --s5:#e87ba4; --s6:#4a3aa7;

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
  /* Re-stepped for the dark surface, not dimmed: the light jade fails the dark
     lightness band outright. Same six hues, same order. */
  --s1:#25a37e; --s2:#d95926; --s3:#3987e5;
  --s4:#c98500; --s5:#d55181; --s6:#9085e9;
  --shadow:0 1px 2px oklch(0% 0 0/.35);
  --shadow-lift:0 2px 6px oklch(0% 0 0/.4), 0 16px 32px oklch(0% 0 0/.35);
}}

/* Paper is white whatever the screen is set to. Printing from a dark-mode
   browser otherwise produces light text on a page the printer leaves blank, or
   a PDF that is a black rectangle. The light values, restated. */
@media print{:root{
  color-scheme:light;
  --bg:#fff; --bg-sunk:#fff; --panel:#fff;
  --line:oklch(91.5% .006 var(--hue));
  --line-strong:oklch(85% .008 var(--hue));
  --fg:oklch(24% .018 var(--hue));
  --fg-muted:oklch(52% .016 var(--hue));
  --fg-faint:oklch(64% .012 var(--hue));
  --accent:oklch(52% .11 var(--accent-hue));
  --pos:oklch(52% .11 var(--accent-hue));
  --neg:oklch(54% .18 25);
  --warn:oklch(58% .13 75);
  --s1:#0f7f62; --s2:#eb6834; --s3:#2a78d6;
  --s4:#eda100; --s5:#e87ba4; --s6:#4a3aa7;
  --shadow:none; --shadow-lift:none;
}}
@page{margin:14mm}

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
  letter-spacing:-.022em;text-decoration:none;color:inherit;min-width:0;max-width:100%;
}
/* The name is a setting, up to 40 characters; past what the row can hold it
   ends in an ellipsis, and the full name is on hover and in the tab title. */
.brand-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.brand .mark{color:var(--accent);flex:0 0 auto}
.login .mark{color:var(--accent);display:block;margin:0 auto .6rem}
.mark-img{object-fit:contain;border-radius:22%}
.logo-row{display:flex;gap:1.1rem;align-items:flex-start}
.logo-preview{flex:none;padding:.6rem;border:1px solid var(--line);border-radius:var(--radius);background:var(--bg-sunk)}
.logo-preview .mark{color:var(--accent);display:block}
nav{display:flex;gap:.15rem;flex:1;flex-wrap:wrap}
nav a{
  padding:.38rem .72rem;border-radius:var(--radius-sm);text-decoration:none;
  color:var(--fg-muted);font-weight:520;font-size:var(--step--1);
  transition:background .16s ease,color .16s ease;
}
nav a:hover{background:var(--hover);color:var(--fg)}
nav a[aria-current=page]{background:color-mix(in oklch,var(--accent) 12%,transparent);color:var(--accent);font-weight:600}
main{max-width:68rem;margin:0 auto;padding:1.9rem 1.25rem 2.5rem}

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

/* --- charts ------------------------------------------------------------- */
.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;
  clip:rect(0 0 0 0);white-space:nowrap;border:0}
.chart{margin:0}
.chart-svg{width:100%;height:auto;display:block;overflow:visible}
.stack-svg{height:28px}
.chart .grid{stroke:var(--line);stroke-width:1;shape-rendering:crispEdges}
.chart .tick{fill:var(--fg-faint);font-size:10.5px;font-variant-numeric:tabular-nums}
.chart .label{fill:var(--fg-muted);font-size:11px}
.chart .value{fill:var(--fg);font-size:11px;font-weight:600;font-variant-numeric:tabular-nums}
.chart .line{fill:none;stroke-width:2;stroke-linejoin:round;stroke-linecap:round}
.chart .area{fill-opacity:.1;stroke:none}
/* The 2px ring is surface-coloured so a marker stays legible over the line. */
.chart .marker,.chart .cursor{stroke:var(--panel);stroke-width:2}
.chart .crosshair{stroke:var(--line-strong);stroke-width:1;pointer-events:none}
.chart .hit{fill:transparent;cursor:crosshair;outline:none}
.chart .hit:focus-visible{fill:color-mix(in oklch,var(--accent) 8%,transparent)}
.chart .bar,.chart .seg{transition:filter .12s ease}
.chart .bar.is-hover,.chart .seg.is-hover{filter:brightness(1.12)}
.chart .seg{outline:none}
.chart .seg-label{fill:#fff;font-size:11px;font-weight:650;pointer-events:none}
.chart .s1{color:var(--s1)}.chart .s2{color:var(--s2)}.chart .s3{color:var(--s3)}
.chart .s4{color:var(--s4)}.chart .s5{color:var(--s5)}.chart .s6{color:var(--s6)}
.chart path.s1,.chart rect.s1,.chart circle.s1{fill:var(--s1)}
.chart path.s2,.chart rect.s2,.chart circle.s2{fill:var(--s2)}
.chart path.s3,.chart rect.s3,.chart circle.s3{fill:var(--s3)}
.chart path.s4,.chart rect.s4,.chart circle.s4{fill:var(--s4)}
.chart path.s5,.chart rect.s5,.chart circle.s5{fill:var(--s5)}
.chart path.s6,.chart rect.s6,.chart circle.s6{fill:var(--s6)}
.chart path.line.s1{fill:none;stroke:var(--s1)}
.chart path.area.s1{fill:var(--s1)}
.chart-caption{display:flex;justify-content:space-between;gap:1rem;margin-top:.5rem;
  font-size:var(--step--1);font-variant-numeric:tabular-nums}
.legend{display:flex;flex-wrap:wrap;gap:.35rem .9rem;list-style:none;margin:.75rem 0 0;padding:0;
  font-size:var(--step--1);color:var(--fg-muted)}
.legend li{display:flex;align-items:center;gap:.35rem}
.legend .swatch{width:10px;height:10px;border-radius:3px;flex:0 0 auto}
.legend .swatch.s1{background:var(--s1)}.legend .swatch.s2{background:var(--s2)}
.legend .swatch.s3{background:var(--s3)}.legend .swatch.s4{background:var(--s4)}
.legend .swatch.s5{background:var(--s5)}.legend .swatch.s6{background:var(--s6)}
/* Filter bar: one row above the results, wrapping on narrow screens rather
   than scrolling, because a hidden filter is a filter nobody applies. */
.filters{display:flex;flex-wrap:wrap;gap:.6rem .75rem;align-items:flex-end;
  padding:.85rem 1rem;margin:0 0 1.25rem;border:1px solid var(--line);
  border-radius:var(--radius);background:var(--panel)}
.filters label{display:flex;flex-direction:column;gap:.25rem;
  font-size:var(--step--1);color:var(--fg-muted)}
.filters input,.filters select{min-width:8.5rem}
.filters input[type=search]{min-width:13rem}
.filters button{align-self:flex-end}
.btn-link{align-self:flex-end;padding:.5rem .35rem;font-size:var(--step--1);color:var(--fg-muted)}
.btn-link:hover{color:var(--fg)}
/* Editing inside a table row.
   The controls stack rather than sitting in a row: three of them side by side
   in a cell that is already competing with four other columns crushed the
   category select to two visible characters. */
.cell-edit{display:flex;flex-direction:column;gap:.35rem;min-width:13rem}
.cell-edit input[type=text]{width:100%}
.cell-edit-row{display:flex;gap:.35rem}
.cell-edit-row select{flex:1;min-width:0}
.cell-edit-row button{flex:0 0 auto}
/* Column widths, so the edit controls get real room and the long free-text
   columns give it up. Without this the browser sizes to content and the
   description wins. */
.cell-merchant{max-width:20rem}
.cell-account{max-width:11rem}
.cell-edit-col{width:16rem}
/* A bank description can be 80 characters of routing detail. Clip it and keep
   the whole string in a title, rather than letting one row set the table's
   width or wrap to four lines. */
.clip{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
/* A date that wraps onto two lines makes every row taller than it needs to be. */
td .nowrap,td.nowrap{white-space:nowrap}
.row.tight{gap:.35rem;flex-wrap:nowrap;align-items:center}
.row.tight select{max-width:12rem}
@media(max-width:640px){
  .filters label{flex:1 1 9rem}
  .row.tight{flex-wrap:wrap}
  /* Narrow screens scroll the table horizontally, so fixed caps would only
     make every column smaller than it needs to be. */
  .cell-merchant,.cell-account{max-width:14rem}
  .cell-edit-col{width:14rem}
}
/* Width and gutter match the main element above, so the rule lines up with it. */
.site-footer{max-width:68rem;margin:0 auto 2.5rem;padding:1.25rem 1.25rem 0;
  border-top:1px solid var(--line);font-size:var(--step--1);color:var(--fg-faint)}
.site-footer a{color:var(--fg-muted)}
.site-footer a:hover{color:var(--accent)}
/* --- assistant ----------------------------------------------------------- */
.chat-layout{display:grid;grid-template-columns:15rem 1fr;gap:1.5rem;align-items:start}
.chat-threads{position:sticky;top:1rem}
.btn-new-chat{margin-bottom:1rem}
.thread-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:.15rem}
.thread-list li{padding:.45rem .6rem;border-radius:var(--radius-sm);font-size:var(--step--1)}
.thread-list li:hover{background:var(--hover)}
.thread-list li.current{background:color-mix(in oklch,var(--accent) 12%,transparent)}
.thread-list a{display:block;color:var(--fg);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.chat-main{min-width:0}
.chat-head{align-items:baseline;gap:.75rem;flex-wrap:wrap}
.chat-head h1{margin:0}
.chat-empty{padding:1.5rem;border:1px dashed var(--line);border-radius:var(--radius);margin-bottom:1.25rem}
.suggestions{margin:.75rem 0 0;padding-left:1.1rem;color:var(--fg-muted);font-size:var(--step--1)}
.msg{margin:0 0 1.25rem;padding:1rem 1.1rem;border-radius:var(--radius);border:1px solid var(--line)}
/* The user's own words sit tinted and narrower; the answer gets full width. */
/* Shrink to the message: a one-line question in a full-width bubble reads as
   an empty box with text in the corner. */
.msg.user{background:color-mix(in oklch,var(--accent) 7%,transparent);border-color:transparent;
  margin-left:auto;width:fit-content;max-width:44rem;white-space:pre-wrap}
.msg.assistant{background:var(--panel)}
.msg-body>*:first-child{margin-top:0}
.msg-body>*:last-child{margin-bottom:0}
.msg-body table{margin:.5rem 0}
/* Links inside a reply are the only place the page has no styled anchor, so
   without this they fall back to the UA blue — unreadable on the dark surface. */
.msg-body a,.hint a{color:var(--accent);text-decoration:underline;text-underline-offset:2px}
.msg-body a:hover{filter:brightness(1.15)}
.msg-body h3,.msg-body h4,.msg-body h5{margin:1.1rem 0 .4rem}
.msg-body blockquote{margin:.6rem 0;padding-left:.9rem;border-left:2px solid var(--line);
  color:var(--fg-muted)}
.msg-tools,.msg-source{margin-top:.75rem;font-size:var(--step--1)}
.msg-tools summary,.msg-source summary{cursor:pointer;color:var(--fg-muted)}
.msg-actions{display:flex;gap:1rem;align-items:baseline;justify-content:space-between;
  margin-top:.5rem;flex-wrap:wrap}
.chart-card{margin:1rem 0;padding:.9rem 1rem;border:1px solid var(--line);border-radius:var(--radius)}
.chart-card figcaption{font-weight:600;margin-bottom:.5rem}
.chat-input{display:flex;gap:.6rem;align-items:flex-end;margin-top:1.5rem}
.chat-input textarea{flex:1;font:inherit;padding:.7rem .85rem;border:1px solid var(--line);
  border-radius:var(--radius);background:var(--bg-sunk);color:var(--fg);resize:vertical}
.chat-input textarea:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
@media(max-width:860px){
  .chat-layout{grid-template-columns:1fr}
  .chat-threads{position:static}
  .thread-list{flex-direction:row;overflow-x:auto;gap:.4rem}
  .thread-list li{flex:0 0 auto;max-width:12rem}
  .msg.user{max-width:100%}
}
/* Print is the PDF path: no chrome, no controls, just the conversation. */
@media print{
  header,nav,.site-footer,.chat-threads,.chat-input,.msg-actions,.msg-tools,form{display:none!important}
  body{background:#fff}
  main{max-width:none;padding:0}
  /* A chart's table twin is collapsed on screen; the report prints its own
     tables, and a closed <details> would print as a stray summary line. */
  .chart-table,.tip{display:none!important}
  section,.kpi{break-inside:avoid}
  .report h2{break-after:avoid}
  /* Four figures across a Letter page: a seven-digit net worth at the screen
     size runs out of its card. */
  .kpi .value{font-size:var(--step-1)}
  .chat-layout{grid-template-columns:1fr}
  .msg{border:none;padding:0;background:none;break-inside:avoid}
  .msg.user{max-width:100%;font-weight:600}
  a[target=_blank]::after{content:" (" attr(href) ")";font-size:.85em;color:#555}
}
/* A sync in flight: the banner, and every widget under it dimmed beneath a
   shimmer until the page reloads with fresh figures. Keyed off the banner being
   visible, so the click can show it before the server has answered. */
.sync-banner{display:flex;align-items:center;gap:.9rem;padding:.8rem 1rem;margin-bottom:1.1rem;
  background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);box-shadow:var(--shadow)}
.sync-banner[hidden]{display:none}
.sync-text{display:flex;flex-direction:column;gap:.1rem;flex:1;min-width:0}
.sync-text .muted{font-size:var(--step--1)}
.sync-banner progress{width:min(14rem,35%);accent-color:var(--accent)}
.spinner{flex:none;width:1.1rem;height:1.1rem;border-radius:50%;
  border:2px solid color-mix(in oklch,var(--accent) 25%,transparent);border-top-color:var(--accent);
  animation:spin .8s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
main:has(.sync-banner:not([hidden])) :is(section,.kpi){position:relative;overflow:hidden}
main:has(.sync-banner:not([hidden])) :is(section,.kpi)>*{opacity:.4;transition:opacity .25s}
main:has(.sync-banner:not([hidden])) :is(section,.kpi)::after{content:"";position:absolute;inset:0;
  pointer-events:none;background:linear-gradient(100deg,transparent 30%,
  color-mix(in oklch,var(--fg) 9%,transparent) 50%,transparent 70%);
  background-size:250% 100%;animation:shimmer 1.3s ease-in-out infinite}
@keyframes shimmer{from{background-position:120% 0}to{background-position:-20% 0}}
button[aria-disabled=true]{opacity:.65;cursor:progress}
/* The global rule shortens animations to nothing, which on an infinite shimmer
   reads as flicker. Stop these outright; the dimming alone says "loading". */
@media (prefers-reduced-motion:reduce){.spinner,main :is(section,.kpi)::after{animation:none}}
/* Two-row header: the name and Sign out on top, the whole nav on one line
   beneath, scrolling sideways if it must. Used whenever the single row cannot
   hold all three: below 1060px, where nine links alone fill it, and at any width
   for a name longer than "tally"-sized, which the server knows and marks with
   .two-row. The single row used to wrap link by link, leaving a couple of
   stragglers, or Sign out, stranded on a ragged line of their own. */
.bar.two-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:.4rem .75rem}
.bar.two-row .brand{grid-column:1;grid-row:1}
.bar.two-row > form{grid-column:2;grid-row:1;justify-self:end}
.bar.two-row nav{grid-column:1/-1;grid-row:2;flex-wrap:nowrap;overflow-x:auto;
  scrollbar-width:none;margin-inline:-.72rem;padding-inline:.72rem}
.bar.two-row nav::-webkit-scrollbar{display:none}
@media (max-width:1059px){
  .bar{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:.4rem .75rem}
  .brand{grid-column:1;grid-row:1}
  .bar > form{grid-column:2;grid-row:1;justify-self:end}
  nav{grid-column:1/-1;grid-row:2;flex-wrap:nowrap;overflow-x:auto;
    scrollbar-width:none;margin-inline:-.72rem;padding-inline:.72rem}
  nav::-webkit-scrollbar{display:none}
}
.chart-table{margin-top:.75rem}
/* The report prints its tables in full, so a collapsed twin would repeat them. */
.report .chart-table{display:none}
.chart-table summary{cursor:pointer;font-size:var(--step--1);color:var(--fg-muted);
  padding:.25rem 0;list-style-position:inside}
.chart-table summary:hover{color:var(--fg)}
.chart-table[open] summary{margin-bottom:.35rem}
.chart-empty{padding:.4rem 0}
.tip{position:absolute;z-index:60;pointer-events:none;background:var(--panel);
  border:1px solid var(--line-strong);border-radius:var(--radius-sm);padding:.45rem .6rem;
  box-shadow:var(--shadow-lift);display:flex;flex-direction:column;gap:.1rem;max-width:16rem}
.tip strong{font-size:var(--step-0);font-variant-numeric:tabular-nums}
.tip span{font-size:var(--step--1);color:var(--fg-muted)}
.charts-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(20rem,1fr));
  gap:1.1rem;margin-bottom:1.1rem;align-items:start}
.charts-grid section{margin-bottom:0}

@media(max-width:640px){
  main{padding:1.3rem .9rem 2rem}
  .site-footer{padding-inline:.9rem}
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
  /** What the UI calls itself (Settings → Appearance). Defaults to "tally". */
  appName?: string;
  /** An uploaded logo (src/brand.ts), or null for the built-in mark. */
  logoUrl?: string | null;
}): string {
  const { title, nonce, current, chrome = true, body } = opts;
  const name = opts.appName || 'tally';
  const idle = idleMs();
  const nav = chrome
    ? html`<header><div class="bar${
        // About six characters is all the single row has room for beside nine
        // links and Sign out (measured: ~120px at the widest). Past that the
        // header takes two rows at every width, rather than wrapping raggedly.
        [...name].length > 6 ? ' two-row' : ''
      }">
        <a class="brand" href="/" title="${name}">${brandMark(opts.logoUrl ?? null, 22)}<span class="brand-name">${name}</span></a>
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

  // Destructive forms confirm first. One handler in the shell rather than one
  // per page, and nonced — a nonce CSP blocks inline on*= handlers outright.
  const confirmScript = chrome
    ? `<script nonce="${nonce}">for(const f of document.querySelectorAll('form[data-confirm]'))` +
      `f.addEventListener('submit',e=>{if(!window.confirm(f.dataset.confirm))e.preventDefault()});` +
      `</scr` + `ipt>`
    : '';

  // Idle sign-out. The server decides — getSession refuses a session that has
  // been idle too long — but the server only sees requests, so a tab someone
  // is reading looks identical to one they walked away from. This reports
  // activity back, and signs out on screen when there has been none, so the
  // page does not sit there showing balances to whoever passes the desk.
  const idleScript =
    chrome && idle > 0
      ? `<script nonce="${nonce}">(()=>{const idle=${String(idle)},` +
        `every=Math.max(6e4,Math.round(idle/6));let seen=Date.now(),sent=seen;` +
        `const bump=()=>{seen=Date.now();if(seen-sent<every)return;sent=seen;` +
        `fetch('/session/ping',{method:'POST'}).catch(()=>{})};` +
        `for(const e of ['pointerdown','keydown','scroll','wheel'])` +
        `addEventListener(e,bump,{passive:true});` +
        `setInterval(()=>{if(Date.now()-seen<idle)return;` +
        `const f=document.createElement('form');f.method='post';f.action='/logout';` +
        `const i=document.createElement('input');i.type='hidden';i.name='idle';i.value='1';` +
        `f.append(i);document.body.append(f);f.submit();},1e4)})();` +
        `</scr` + `ipt>`
      : '';

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<meta name="color-scheme" content="light dark">
${opts.logoUrl ? `<link rel="icon" href="${esc(opts.logoUrl)}">` : '<link rel="icon" type="image/svg+xml" href="/favicon.svg">'}
<title>${title} · ${esc(name)}</title>
<style nonce="${nonce}">${CSS}</style>
${speculation}
</head><body>${nav.value}<main>${body.value}</main>${footer(name)}${confirmScript}${idleScript}</body></html>`;
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
