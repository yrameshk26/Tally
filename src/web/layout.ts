/**
 * Page shell. Server-rendered, no build step, no framework, no webfonts — the
 * only third-party script anywhere is Plaid Link, and only on the page that
 * needs it. Everything inline is nonce-allowed so the CSP can stay strict.
 */
import { idleMs } from '../auth/session.ts';
import { esc, html, raw, type SafeHtml } from '../lib/html.ts';
import { logoSvg } from './logo.ts';
import { icon, type IconName } from './icons.ts';

export type Nav = { href: string; label: string; icon: IconName; group: string };

/** The uploaded logo if there is one, otherwise the built-in tally mark. */
export function brandMark(logoUrl: string | null, size: number): SafeHtml {
  return logoUrl
    ? html`<img class="mark mark-img" src="${logoUrl}" alt="" width="${String(size)}" height="${String(size)}">`
    : raw(logoSvg(size, 'mark'));
}

export const NAV: Nav[] = [
  { href: '/', label: 'Overview', icon: 'overview', group: 'Money' },
  { href: '/transactions', label: 'Transactions', icon: 'transactions', group: 'Money' },
  { href: '/merchants', label: 'Merchants', icon: 'merchants', group: 'Money' },
  { href: '/report', label: 'Reports', icon: 'reports', group: 'Money' },
  { href: '/chat', label: 'Assistant', icon: 'assistant', group: 'Ask' },
  { href: '/connections', label: 'Connections', icon: 'connections', group: 'Manage' },
  { href: '/profiles', label: 'Profiles', icon: 'profiles', group: 'Manage' },
  { href: '/settings', label: 'Settings', icon: 'settings', group: 'Manage' },
  { href: '/security', label: 'Security', icon: 'security', group: 'Manage' },
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
  `<a href="https://github.com/yrameshk26/Tally" rel="noreferrer noopener" target="_blank">${icon('star', 14)}Star it on GitHub</a>` +
  ' · ' +
  `<a href="https://github.com/sponsors/yrameshk26" rel="noreferrer noopener" target="_blank">${icon('heart', 14)}Sponsor</a>` +
  '</footer>';

const CSS = `
/* ---------------------------------------------------------------------------
   Colour is defined in OKLCH: perceptually uniform, so a lightness step looks
   like the same step on every hue, and the dark theme is a genuine re-mix
   rather than the light theme with the brightness turned down. Hover, tint and
   glow states derive from the tokens with color-mix(), so the palette stays a
   handful of sources of truth.
--------------------------------------------------------------------------- */
:root{
  color-scheme:light dark;
  --hue:258;            /* cool slate */
  --accent-hue:170;     /* jade: money, without the traffic-light green */

  --bg:oklch(98.2% .005 var(--hue));
  --bg-sunk:oklch(96.2% .007 var(--hue));
  --panel:oklch(100% 0 0);
  --panel-2:oklch(98.8% .004 var(--hue));
  --line:oklch(92.4% .007 var(--hue));
  --line-strong:oklch(86.5% .01 var(--hue));
  --fg:oklch(22% .02 var(--hue));
  --fg-muted:oklch(50% .018 var(--hue));
  --fg-faint:oklch(62% .014 var(--hue));

  --accent:oklch(54% .12 var(--accent-hue));
  --accent-strong:oklch(47% .115 var(--accent-hue));
  --accent-fg:oklch(99% .01 var(--accent-hue));
  --accent-soft:color-mix(in oklch,var(--accent) 11%,transparent);
  --pos:oklch(52% .12 var(--accent-hue));
  --neg:oklch(55% .19 25);
  --warn:oklch(58% .13 70);

  /* The hero card: jade into deep teal-blue. White text holds 4.5:1 or better
     across the whole gradient. */
  --hero-a:oklch(50% .12 168);
  --hero-b:oklch(42% .1 222);

  --radius:16px;
  --radius-md:12px;
  --radius-sm:10px;
  --shadow:0 1px 2px oklch(22% .03 var(--hue)/.04),0 1px 3px oklch(22% .03 var(--hue)/.04);
  --shadow-lift:0 4px 10px -2px oklch(22% .03 var(--hue)/.07),0 18px 36px -12px oklch(22% .03 var(--hue)/.14);
  --ring:0 0 0 4px color-mix(in oklch,var(--accent) 22%,transparent);
  /* Derived from the foreground, so it darkens a light surface and lightens a
     dark one. Reusing --bg-sunk here punched a black hole through dark rows. */
  --hover:color-mix(in oklch,var(--fg) 4.5%,transparent);
  --glow:color-mix(in oklch,var(--accent) 12%,transparent);
  --sidebar:oklch(99.2% .003 var(--hue));

  /* Categorical series slots, in fixed order: assigned by entity, never by
     rank, and never cycled past the last slot. Validated with the palette
     script against these surfaces in both modes: lightness band, chroma floor,
     CVD separation, normal-vision floor and contrast. Light s4/s5 sit under
     3:1, which is legal only with the relief every chart here ships: visible
     direct labels plus a table view. */
  --s1:#0f7f62; --s2:#eb6834; --s3:#2a78d6;
  --s4:#eda100; --s5:#e87ba4; --s6:#4a3aa7;

  --font:"Inter var","Inter","SF Pro Text",ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
  --font-display:"Inter var","Inter","SF Pro Display",ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
  --mono:ui-monospace,"SF Mono",SFMono-Regular,Menlo,Consolas,monospace;
  --step--2:.72rem;
  --step--1:clamp(.8rem,.78rem + .08vw,.84rem);
  --step-0:clamp(.9rem,.88rem + .1vw,.95rem);
  --step-1:clamp(1.02rem,.98rem + .2vw,1.12rem);
  --step-2:clamp(1.45rem,1.3rem + .6vw,1.8rem);
  --step-3:clamp(1.65rem,1.45rem + .8vw,2.1rem);
  --sidebar-w:15.5rem;
}
/* Dark, by device setting or by choice. The theme switch in the sidebar sets
   data-theme on <html>: "light" opts out of a dark device, "dark" opts in
   on a light one, and no attribute follows the system. Same tokens either way. */
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){
  --bg:oklch(15.5% .012 var(--hue));
  --bg-sunk:oklch(13.2% .012 var(--hue));
  --panel:oklch(19.5% .014 var(--hue));
  --panel-2:oklch(21.5% .015 var(--hue));
  --line:oklch(27.5% .016 var(--hue));
  --line-strong:oklch(34% .02 var(--hue));
  --fg:oklch(95% .006 var(--hue));
  --fg-muted:oklch(72% .016 var(--hue));
  --fg-faint:oklch(58% .014 var(--hue));
  --accent:oklch(78% .135 var(--accent-hue));
  --accent-strong:oklch(84% .12 var(--accent-hue));
  --accent-fg:oklch(18% .04 var(--accent-hue));
  --accent-soft:color-mix(in oklch,var(--accent) 14%,transparent);
  --pos:oklch(79% .14 var(--accent-hue));
  --neg:oklch(73% .16 25);
  --warn:oklch(81% .13 78);
  --hero-a:oklch(44% .1 168);
  --hero-b:oklch(34% .08 225);
  /* Re-stepped for the dark surface, not dimmed: the light jade fails the dark
     lightness band outright. Same six hues, same order. */
  --s1:#25a37e; --s2:#d95926; --s3:#3987e5;
  --s4:#c98500; --s5:#d55181; --s6:#9085e9;
  --shadow:0 1px 2px oklch(0% 0 0/.3),inset 0 1px 0 oklch(100% 0 0/.03);
  --shadow-lift:0 6px 16px -4px oklch(0% 0 0/.45),0 22px 44px -16px oklch(0% 0 0/.5),inset 0 1px 0 oklch(100% 0 0/.04);
  --glow:color-mix(in oklch,var(--accent) 9%,transparent);
  --sidebar:oklch(17% .013 var(--hue));
}}
:root[data-theme=dark]{color-scheme:dark;
  --bg:oklch(15.5% .012 var(--hue));
  --bg-sunk:oklch(13.2% .012 var(--hue));
  --panel:oklch(19.5% .014 var(--hue));
  --panel-2:oklch(21.5% .015 var(--hue));
  --line:oklch(27.5% .016 var(--hue));
  --line-strong:oklch(34% .02 var(--hue));
  --fg:oklch(95% .006 var(--hue));
  --fg-muted:oklch(72% .016 var(--hue));
  --fg-faint:oklch(58% .014 var(--hue));
  --accent:oklch(78% .135 var(--accent-hue));
  --accent-strong:oklch(84% .12 var(--accent-hue));
  --accent-fg:oklch(18% .04 var(--accent-hue));
  --accent-soft:color-mix(in oklch,var(--accent) 14%,transparent);
  --pos:oklch(79% .14 var(--accent-hue));
  --neg:oklch(73% .16 25);
  --warn:oklch(81% .13 78);
  --hero-a:oklch(44% .1 168);
  --hero-b:oklch(34% .08 225);
  /* Re-stepped for the dark surface, not dimmed: the light jade fails the dark
     lightness band outright. Same six hues, same order. */
  --s1:#25a37e; --s2:#d95926; --s3:#3987e5;
  --s4:#c98500; --s5:#d55181; --s6:#9085e9;
  --shadow:0 1px 2px oklch(0% 0 0/.3),inset 0 1px 0 oklch(100% 0 0/.03);
  --shadow-lift:0 6px 16px -4px oklch(0% 0 0/.45),0 22px 44px -16px oklch(0% 0 0/.5),inset 0 1px 0 oklch(100% 0 0/.04);
  --glow:color-mix(in oklch,var(--accent) 9%,transparent);
  --sidebar:oklch(17% .013 var(--hue));
}
:root[data-theme=light]{color-scheme:light}

/* Paper is white whatever the screen is set to. Printing from a dark-mode
   browser otherwise produces light text on a page the printer leaves blank, or
   a PDF that is a black rectangle. The light values, restated. */
/* :not(#print) matches the root and nothing else, and its id-level
   specificity outranks every theme rule above, dark by device included. */
@media print{:root:not(#print){
  color-scheme:light;
  --bg:#fff; --bg-sunk:#fff; --panel:#fff; --panel-2:#fff;
  --line:oklch(91.5% .006 var(--hue));
  --line-strong:oklch(85% .008 var(--hue));
  --fg:oklch(22% .02 var(--hue));
  --fg-muted:oklch(50% .018 var(--hue));
  --fg-faint:oklch(62% .014 var(--hue));
  --accent:oklch(54% .12 var(--accent-hue));
  --pos:oklch(52% .12 var(--accent-hue));
  --neg:oklch(55% .19 25);
  --warn:oklch(58% .13 70);
  --s1:#0f7f62; --s2:#eb6834; --s3:#2a78d6;
  --s4:#eda100; --s5:#e87ba4; --s6:#4a3aa7;
  --shadow:none; --shadow-lift:none;
}}
@page{margin:14mm}

/* Cross-document view transitions: page changes crossfade instead of
   flashing white, which is what makes a multi-page app feel like an SPA
   without shipping one. The sidebar is named, so it holds still. */
@view-transition{navigation:auto}
::view-transition-old(root),::view-transition-new(root){animation-duration:.18s}
@media (prefers-reduced-motion:reduce){
  @view-transition{navigation:none}
  *,*::before,*::after{animation-duration:.01ms !important;transition-duration:.01ms !important}
}

*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{
  margin:0;color:var(--fg);
  /* A soft glow of the accent behind the top of the content: depth without
     an image. */
  background:
    radial-gradient(60rem 26rem at 78% -8rem,var(--glow),transparent 70%),
    radial-gradient(40rem 20rem at 20% -10rem,color-mix(in oklch,var(--s3) 6%,transparent),transparent 70%),
    var(--bg);
  background-attachment:fixed;
  font:var(--step-0)/1.55 var(--font);
  font-feature-settings:"cv11","ss01","ss03";
  -webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale;text-rendering:optimizeLegibility;
  font-variant-numeric:tabular-nums;
}
::selection{background:color-mix(in oklch,var(--accent) 28%,transparent)}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:6px}
a{color:inherit}
.i{flex:none;display:block}

/* --- app shell ------------------------------------------------------------ */
/* Desktop: a fixed sidebar and a scrolling content column. Below 1060px the
   same markup becomes a top bar with the nav as one scrolling row of pills, so
   there is one set of links and no hamburger to hide them behind. */
.app{display:grid;grid-template-columns:var(--sidebar-w) minmax(0,1fr);min-height:100vh}
.sidebar{
  /* The column carries the surface, so it runs the full height of a long
     page; the inner block is what stays on screen while the page scrolls. */
  z-index:20;
  background:color-mix(in oklch,var(--sidebar) 86%,transparent);
  backdrop-filter:saturate(170%) blur(14px);-webkit-backdrop-filter:saturate(170%) blur(14px);
  border-right:1px solid var(--line);
  view-transition-name:sidebar;
}
.side-inner{
  position:sticky;top:0;height:100vh;
  display:grid;grid-template-rows:auto 1fr auto;grid-template-areas:"brand" "nav" "foot";
  gap:1.2rem;padding:1.15rem .85rem 1rem;
}
.brand{
  grid-area:brand;display:flex;align-items:center;gap:.6rem;padding:.35rem .5rem;
  font:680 var(--step-1)/1.2 var(--font-display);letter-spacing:-.025em;
  text-decoration:none;color:inherit;min-width:0;border-radius:var(--radius-sm);
}
.brand:hover{background:var(--hover)}
/* The name is a setting, up to 40 characters; past what the row can hold it
   ends in an ellipsis, and the full name is on hover and in the tab title. */
.brand-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.brand .mark{color:var(--accent);flex:0 0 auto}
.mark-img{object-fit:contain;border-radius:24%}
.sidebar nav{grid-area:nav;display:flex;flex-direction:column;gap:.1rem;overflow-y:auto;
  scrollbar-width:thin;min-height:0}
.nav-group{margin:.9rem .65rem .3rem;font-size:var(--step--2);font-weight:650;letter-spacing:.08em;
  text-transform:uppercase;color:var(--fg-faint)}
.nav-group:first-child{margin-top:.1rem}
.sidebar nav a{
  display:flex;align-items:center;gap:.7rem;padding:.5rem .65rem;border-radius:var(--radius-sm);
  text-decoration:none;color:var(--fg-muted);font-weight:540;font-size:var(--step--1);
  transition:background .15s ease,color .15s ease;position:relative;
}
.sidebar nav a .i{opacity:.85}
.sidebar nav a:hover{background:var(--hover);color:var(--fg)}
.sidebar nav a[aria-current=page]{background:var(--accent-soft);color:var(--accent-strong);font-weight:640}
.sidebar nav a[aria-current=page] .i{opacity:1}
.sidebar nav a[aria-current=page]::before{content:"";position:absolute;left:-.85rem;top:22%;bottom:22%;
  width:3px;border-radius:0 3px 3px 0;background:var(--accent)}
.side-foot{grid-area:foot;display:flex;flex-direction:column;gap:.5rem}
.theme-switch{display:flex;gap:.15rem;padding:.2rem;border-radius:11px;background:var(--bg-sunk);
  border:1px solid var(--line);width:fit-content}
.side-foot .theme-switch button{width:auto;min-height:0;padding:.35rem .5rem;border-radius:8px;background:transparent;
  color:var(--fg-faint);border:0;box-shadow:none}
.side-foot .theme-switch button:hover{color:var(--fg);background:transparent;filter:none;box-shadow:none}
.side-foot .theme-switch button[aria-pressed=true]{background:var(--panel);color:var(--accent-strong);box-shadow:var(--shadow)}
.side-foot button{width:100%;justify-content:flex-start;gap:.7rem;background:transparent;
  color:var(--fg-muted);border-color:transparent;box-shadow:none;padding:.5rem .65rem;font-weight:540}
.side-foot button:hover{background:var(--hover);color:var(--fg);filter:none}
.content{min-width:0;display:flex;flex-direction:column}
main{width:100%;max-width:74rem;margin:0 auto;padding:2.1rem 2.4rem 2.5rem;flex:1}

@media (max-width:1059px){
  .app{display:block}
  .sidebar{position:sticky;top:0;border-right:0;border-bottom:1px solid var(--line)}
  .side-inner{
    position:static;height:auto;
    grid-template-columns:minmax(0,1fr) auto;grid-template-rows:auto auto;
    grid-template-areas:"brand foot" "nav nav";gap:.45rem .75rem;padding:.6rem 1rem .55rem;
  }
  .brand{padding:.25rem .35rem}
  .sidebar nav{flex-direction:row;overflow-x:auto;overflow-y:visible;gap:.3rem;
    scrollbar-width:none;margin:0 -1rem;padding:.1rem 1rem .2rem}
  .sidebar nav::-webkit-scrollbar{display:none}
  .nav-group{display:none}
  .sidebar nav a{flex:none;padding:.4rem .75rem;border-radius:999px;border:1px solid var(--line);
    background:var(--panel)}
  .sidebar nav a .i{display:none}
  .sidebar nav a[aria-current=page]{border-color:color-mix(in oklch,var(--accent) 40%,transparent)}
  .sidebar nav a[aria-current=page]::before{display:none}
  .side-foot{flex-direction:row;align-items:center}
  .side-foot button{width:auto;border:1px solid var(--line-strong);background:var(--panel);
    color:var(--fg);padding:.42rem .8rem}
  main{padding:1.6rem 1.25rem 2.25rem}
}

/* --- type --------------------------------------------------------------- */
h1{font:700 var(--step-3)/1.15 var(--font-display);letter-spacing:-.035em;margin:0 0 .4rem;text-wrap:balance}
h2{font:640 var(--step-1)/1.3 var(--font-display);margin:0 0 1rem;letter-spacing:-.02em}
h3{font:640 var(--step-0)/1.3 var(--font-display);margin:1.4rem 0 .7rem;letter-spacing:-.01em}
p.sub{color:var(--fg-muted);margin:0 0 1.9rem;max-width:64ch;text-wrap:pretty}
.hint{color:var(--fg-muted);font-size:var(--step--1);margin-top:.35rem;text-wrap:pretty}
/* A page with no subtitle: keep the first block off the title. */
h1+.notice,h1+section,h1+.kpis{margin-top:1.3rem}

/* A page title with its actions beside it rather than under it. */
.page-head{display:flex;align-items:flex-end;justify-content:space-between;gap:1rem 1.5rem;
  flex-wrap:wrap;margin-bottom:1.6rem}
.page-head p.sub{margin-bottom:0}
.page-actions{display:flex;align-items:center;gap:.6rem;flex-wrap:wrap}

/* A few views of the same page: one control, the current one raised. */
.segmented{display:inline-flex;gap:.2rem;padding:.25rem;border-radius:12px;
  background:var(--bg-sunk);border:1px solid var(--line);flex-wrap:wrap}
.segmented a{padding:.4rem .95rem;border-radius:9px;text-decoration:none;font-size:var(--step--1);
  font-weight:560;color:var(--fg-muted);transition:background .15s ease,color .15s ease}
.segmented a:hover{color:var(--fg)}
.segmented a[aria-current=page]{background:var(--panel);color:var(--fg);font-weight:640;box-shadow:var(--shadow)}

/* --- surfaces ------------------------------------------------------------- */
section{
  background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);
  padding:1.35rem 1.5rem;margin-bottom:1.15rem;box-shadow:var(--shadow);
}
section>h2:first-child{display:flex;align-items:center;gap:.5rem}

/* --- KPIs ----------------------------------------------------------------- */
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(12rem,1fr));gap:.9rem;margin-bottom:1.15rem}
/* With a hero, it takes the room it needs and the rest share what is left. */
.kpis:has(.hero){grid-template-columns:minmax(0,1.7fr) repeat(3,minmax(0,1fr))}
@media (max-width:1240px){.kpis:has(.hero){grid-template-columns:repeat(3,minmax(0,1fr))}.kpis .kpi.hero{grid-column:1/-1}}
.kpi{
  position:relative;background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);
  padding:1.1rem 1.25rem 1.15rem;box-shadow:var(--shadow);overflow:hidden;
  /* The figure is sized to its card, not the window: a seven-digit balance
     has to fit however many cards share the row. */
  container-type:inline-size;
  transition:transform .2s cubic-bezier(.2,.7,.3,1),box-shadow .2s ease,border-color .2s ease;
}
.kpi:hover{transform:translateY(-2px);box-shadow:var(--shadow-lift);border-color:var(--line-strong)}
.kpi .label{font-size:var(--step--2);text-transform:uppercase;letter-spacing:.08em;color:var(--fg-faint);font-weight:650;
  display:flex;align-items:center;gap:.45rem}
.kpi .label::before{content:"";width:.45rem;height:.45rem;border-radius:50%;background:var(--line-strong)}
.kpi .value{font:700 var(--step-2)/1.1 var(--font-display);letter-spacing:-.035em;margin-top:.5rem;
  font-size:clamp(1.05rem,11.5cqi,1.8rem);white-space:nowrap}
.kpi .value.pos{color:var(--pos)}.kpi .value.neg{color:var(--neg)}
.kpi:has(.value.pos) .label::before{background:var(--pos)}
.kpi:has(.value.neg) .label::before{background:var(--neg)}
.kpi .sub-line{margin-top:.4rem}
/* The one number that matters most gets the one gradient on the page. */
.kpi.hero{
  color:#fff;border-color:transparent;
  background:
    radial-gradient(22rem 12rem at 100% 0%,oklch(100% 0 0/.16),transparent 60%),
    linear-gradient(135deg,var(--hero-a),var(--hero-b));
  box-shadow:0 10px 30px -12px color-mix(in oklch,var(--hero-a) 70%,transparent);
}
.kpi.hero .label{color:oklch(100% 0 0/.78)}
.kpi.hero .label::before{background:oklch(100% 0 0/.85)}
.kpi.hero .value{color:#fff;font-size:clamp(1.6rem,10cqi,2.7rem)}
.delta{display:inline-flex;align-items:center;gap:.25rem;margin-top:.7rem;padding:.2rem .55rem .2rem .35rem;
  border-radius:999px;font-size:var(--step--1);font-weight:600;background:oklch(100% 0 0/.16);color:#fff}
.delta .muted-on-hero{color:oklch(100% 0 0/.72);font-weight:500;margin-left:.2rem}
@media (max-width:640px){
  .kpis .kpi.hero{grid-column:1/-1}.kpis:has(.hero){grid-template-columns:1fr 1fr}
  /* Hero on its own row leaves three cards for two columns: the odd one out
     takes the row rather than sitting alone beside a gap. */
  .kpis:has(.hero) .kpi:nth-child(4):last-child{grid-column:1/-1}
}

/* --- tables --------------------------------------------------------------- */
.table-wrap{overflow-x:auto;margin:0 -.4rem;padding:0 .4rem}
table{width:100%;border-collapse:separate;border-spacing:0;font-size:var(--step--1)}
th,td{text-align:left;padding:.7rem .7rem;border-bottom:1px solid var(--line);vertical-align:middle}
/* Deliberately NOT sticky. A sticky thead inside the horizontal scroll
   container overlapped and hid the first row of every table: the largest
   holding and the biggest account were both invisible. These tables are short;
   stickiness bought nothing and cost data. */
thead th{
  background:var(--panel-2);font-size:var(--step--2);text-transform:uppercase;letter-spacing:.075em;
  color:var(--fg-faint);font-weight:650;border-bottom-color:var(--line);padding-block:.6rem;
}
thead th:first-child{border-top-left-radius:var(--radius-sm)}
thead th:last-child{border-top-right-radius:var(--radius-sm)}
tbody tr{transition:background .13s ease}
tbody tr:hover{background:var(--hover)}
tbody tr:last-child td{border-bottom:0}
td.num,th.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
/* The Reports controls: a month only means something when the period is one. */
.filters:has(select[name=period] option[value=year]:checked) .month-field{display:none}
/* Bulk selection: a bar of actions above the table, checkboxes in the first column. */
.bulk-bar{display:flex;align-items:center;gap:.6rem;flex-wrap:wrap;margin:0 0 .9rem;padding:.6rem .75rem;
  border:1px solid var(--line);border-radius:var(--radius-md);background:var(--panel-2)}
.bulk-bar select{width:auto;min-width:12rem}
.bulk-bar #bulk-count{flex:1;min-width:10rem;font-size:var(--step--1)}
th.check,td.check{width:2.2rem;padding-right:0}
input[type=checkbox]{width:1.05rem;height:1.05rem;accent-color:var(--accent);cursor:pointer;margin:0;vertical-align:middle}
/* A select in a table cell keeps enough width to read its value; the table
   scrolls sideways before a profile name is crushed to its first letter. */
td select{min-width:7.5rem}
td strong{font-weight:640}
.pos{color:var(--pos)}.neg{color:var(--neg)}.muted{color:var(--fg-muted)}

/* --- controls ------------------------------------------------------------- */
form{margin:0}
label{display:block;font-weight:600;font-size:var(--step--1);margin:0 0 .4rem}
input[type=text],input[type=password],input[type=email],input[type=search],input[type=number],
input[type=date],input[type=month],input:not([type]),select,textarea{
  font:inherit;font-size:var(--step--1);width:100%;min-height:2.5rem;padding:.55rem .8rem;
  border:1px solid var(--line);border-radius:var(--radius-sm);
  background:var(--bg-sunk);color:inherit;
  transition:border-color .15s ease,box-shadow .15s ease,background .15s ease;
}
select{
  appearance:none;-webkit-appearance:none;padding-right:2.2rem;cursor:pointer;
  background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='%238a93a6' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m7 10 5 5 5-5'/%3E%3C/svg%3E");
  background-repeat:no-repeat;background-position:right .7rem center;
}
input:hover,select:hover,textarea:hover{border-color:var(--line-strong)}
input:focus,select:focus,textarea:focus{outline:none;border-color:var(--accent);box-shadow:var(--ring);background:var(--panel)}
input::placeholder,textarea::placeholder{color:var(--fg-faint)}
input[type=file]{font:inherit;font-size:var(--step--1);color:var(--fg-muted);max-width:100%}
input[type=file]::file-selector-button{
  font:inherit;font-weight:600;margin-right:.75rem;padding:.5rem .95rem;cursor:pointer;
  border:1px solid var(--line-strong);border-radius:var(--radius-sm);background:var(--panel);color:var(--fg);
  transition:background .15s ease,border-color .15s ease;
}
input[type=file]::file-selector-button:hover{background:var(--hover);border-color:var(--accent)}
.field{margin-bottom:1.05rem}
/* A field whose input is focused gets a highlighted label: :has() replaces
   what used to need a JS focus handler. */
.field:has(input:focus) label{color:var(--accent)}

button,.btn{
  font:inherit;font-weight:600;font-size:var(--step--1);min-height:2.45rem;padding:.55rem 1.1rem;
  border-radius:var(--radius-sm);border:1px solid transparent;cursor:pointer;text-decoration:none;
  display:inline-flex;align-items:center;justify-content:center;gap:.45rem;white-space:nowrap;
  color:var(--accent-fg);
  background:linear-gradient(180deg,color-mix(in oklch,var(--accent) 88%,white),var(--accent));
  box-shadow:0 1px 2px oklch(22% .03 var(--hue)/.12),inset 0 1px 0 oklch(100% 0 0/.18);
  transition:transform .12s cubic-bezier(.2,.7,.3,1),filter .15s ease,background .15s ease,
    border-color .15s ease,box-shadow .15s ease;
}
button:hover,.btn:hover{filter:brightness(1.06);box-shadow:0 4px 12px -4px color-mix(in oklch,var(--accent) 60%,transparent),inset 0 1px 0 oklch(100% 0 0/.18)}
button:active,.btn:active{transform:translateY(1px)}
button.secondary,.btn.secondary{background:var(--panel);color:var(--fg);border-color:var(--line-strong);
  box-shadow:0 1px 2px oklch(22% .03 var(--hue)/.05)}
button.secondary:hover,.btn.secondary:hover{background:var(--panel-2);border-color:color-mix(in oklch,var(--accent) 55%,var(--line-strong));filter:none}
button.danger{background:transparent;color:var(--neg);border-color:color-mix(in oklch,var(--neg) 40%,transparent);box-shadow:none}
button.danger:hover{background:color-mix(in oklch,var(--neg) 9%,transparent);filter:none;box-shadow:none}
button:disabled{opacity:.5;cursor:not-allowed;transform:none;filter:none}
button[aria-disabled=true]{opacity:.65;cursor:progress}
.row{display:flex;gap:.6rem;align-items:center;flex-wrap:wrap}

.pill{
  display:inline-flex;align-items:center;gap:.35rem;padding:.16rem .6rem;border-radius:999px;
  font-size:.72rem;font-weight:620;letter-spacing:.005em;line-height:1.5;
  border:1px solid var(--line);color:var(--fg-muted);background:var(--bg-sunk);
}
.pill.ok,.pill.bad,.pill.warn{border-color:transparent}
.pill.ok::before,.pill.bad::before,.pill.warn::before{content:"";width:.4rem;height:.4rem;border-radius:50%;background:currentColor}
.pill.ok{color:var(--pos);background:color-mix(in oklch,var(--pos) 12%,transparent)}
.pill.bad{color:var(--neg);background:color-mix(in oklch,var(--neg) 11%,transparent)}
.pill.warn{color:var(--warn);background:color-mix(in oklch,var(--warn) 14%,transparent)}

.notice{
  position:relative;padding:.85rem 1rem .85rem 1.15rem;border-radius:var(--radius-md);
  border:1px solid var(--line);margin-bottom:1.15rem;font-size:var(--step--1);background:var(--panel);
  display:flex;gap:.65rem;align-items:flex-start;box-shadow:var(--shadow);overflow:hidden;
}
.notice::before{content:"";position:absolute;left:0;top:0;bottom:0;width:3px;background:currentColor}
/* Entry animation that also works on first paint, via @starting-style. */
@starting-style{.notice{opacity:0;transform:translateY(-4px)}}
.notice{transition:opacity .25s ease,transform .25s ease}
.notice.err{color:var(--neg);background:color-mix(in oklch,var(--neg) 6%,var(--panel));border-color:color-mix(in oklch,var(--neg) 22%,transparent)}
.notice.ok{color:var(--pos);background:color-mix(in oklch,var(--pos) 6%,var(--panel));border-color:color-mix(in oklch,var(--pos) 22%,transparent)}
.notice.warn{color:var(--warn);background:color-mix(in oklch,var(--warn) 7%,var(--panel));border-color:color-mix(in oklch,var(--warn) 24%,transparent)}
.notice span{color:var(--fg)}

code,.mono{font-family:var(--mono);font-size:.86em}
.code-block{
  background:var(--bg-sunk);border:1px solid var(--line);border-radius:var(--radius-sm);
  padding:.7rem .9rem;word-break:break-all;user-select:all;
  font-family:var(--mono);font-size:var(--step--1);
}

input.otp{
  font-family:var(--mono);font-size:1.6rem;letter-spacing:.42em;text-align:center;
  padding:.7rem .5rem .7rem .92rem;font-variant-numeric:tabular-nums;min-height:3.4rem;
}

/* --- sign-in and other pages without the sidebar ------------------------- */
.bare{min-height:100vh;display:flex;flex-direction:column;
  background:
    radial-gradient(40rem 30rem at 15% 10%,color-mix(in oklch,var(--accent) 16%,transparent),transparent 65%),
    radial-gradient(36rem 28rem at 90% 90%,color-mix(in oklch,var(--s3) 12%,transparent),transparent 65%),
    var(--bg)}
.bare main{display:flex;align-items:center;justify-content:center;max-width:none;padding:2rem 1.25rem}
.login{width:100%;max-width:25rem;margin:0 auto;padding:2.2rem 2rem 1.8rem;
  background:color-mix(in oklch,var(--panel) 88%,transparent);
  backdrop-filter:blur(18px) saturate(160%);-webkit-backdrop-filter:blur(18px) saturate(160%);
  border:1px solid var(--line);border-radius:22px;box-shadow:var(--shadow-lift)}
.login .mark{color:var(--accent);display:block;margin:0 auto .9rem}
.login h1{text-align:center;font-size:var(--step-2)}
.login p.sub{text-align:center;margin-bottom:1.6rem}
.login section{background:transparent;border:0;box-shadow:none;padding:0;margin:0}
.login button[type=submit]{width:100%;min-height:2.7rem;margin-top:.25rem}

/* --- small utilities, so no markup needs a style attribute. A strict CSP
   (style-src with a nonce and no 'unsafe-inline') blocks inline style
   attributes outright, which silently broke every one of them. --- */
.mb{margin-bottom:1.15rem}.mb-sm{margin-bottom:.75rem}
.mt{margin-top:1rem}.mt-sm{margin-top:.9rem}.mt-xs{margin-top:.6rem}
.tight{gap:.35rem}
.inline-form{display:inline-flex}
.w-sm{max-width:12rem}.w-md{max-width:14rem}.w-lg{max-width:18rem}
.sub-line{font-size:.78rem;color:var(--fg-muted);margin-top:.15rem}
.icon{flex:0 0 auto;margin-top:.12rem}
.cell-stack{display:flex;flex-direction:column;gap:.1rem}
.split{display:grid;grid-template-columns:repeat(auto-fit,minmax(18rem,1fr));gap:1.15rem;margin-bottom:1.15rem;align-items:start}
.split section{margin-bottom:0}
.kv td{padding:.5rem .7rem}
.kv td:first-child{color:var(--fg-muted)}
.empty{color:var(--fg-muted);font-size:var(--step--1);padding:.4rem 0}
ol.steps{margin:0 0 .6rem;padding-left:1.15rem;color:var(--fg-muted);font-size:var(--step--1)}
ol.steps li{margin-bottom:.3rem}
ol.steps strong{color:var(--fg)}
.logo-row{display:flex;gap:1.2rem;align-items:flex-start}
.logo-preview{flex:none;padding:.7rem;border:1px solid var(--line);border-radius:var(--radius-md);background:var(--bg-sunk)}
.logo-preview .mark{color:var(--accent);display:block}

/* --- charts ------------------------------------------------------------- */
.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;
  clip:rect(0 0 0 0);white-space:nowrap;border:0}
.chart{margin:0}
.chart-svg{width:100%;height:auto;display:block;overflow:visible}
.stack-svg{height:28px}
.chart .grid{stroke:var(--line);stroke-width:1;shape-rendering:crispEdges;stroke-dasharray:2 4}
.chart .tick{fill:var(--fg-faint);font-size:10.5px;font-variant-numeric:tabular-nums}
.chart .label{fill:var(--fg-muted);font-size:11px}
.chart .value{fill:var(--fg);font-size:11px;font-weight:620;font-variant-numeric:tabular-nums}
.chart .line{fill:none;stroke-width:2.25;stroke-linejoin:round;stroke-linecap:round}
.chart .area{fill-opacity:.12;stroke:none}
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
.chart-caption{display:flex;justify-content:space-between;gap:1rem;margin-top:.6rem;
  font-size:var(--step--1);font-variant-numeric:tabular-nums;color:var(--fg-muted)}
.legend{display:flex;flex-wrap:wrap;gap:.35rem .95rem;list-style:none;margin:.8rem 0 0;padding:0;
  font-size:var(--step--1);color:var(--fg-muted)}
.legend li{display:flex;align-items:center;gap:.4rem}
.legend .swatch{width:10px;height:10px;border-radius:3px;flex:0 0 auto}
.legend .swatch.s1{background:var(--s1)}.legend .swatch.s2{background:var(--s2)}
.legend .swatch.s3{background:var(--s3)}.legend .swatch.s4{background:var(--s4)}
.legend .swatch.s5{background:var(--s5)}.legend .swatch.s6{background:var(--s6)}
.chart-table{margin-top:.8rem}
/* The report prints its tables in full, so a collapsed twin would repeat them. */
.report .chart-table{display:none}
.chart-table summary{cursor:pointer;font-size:var(--step--1);color:var(--fg-muted);
  padding:.25rem 0;list-style-position:inside;width:fit-content}
.chart-table summary:hover{color:var(--accent)}
.chart-table[open] summary{margin-bottom:.4rem}
.chart-empty{padding:.4rem 0}
.tip{position:absolute;z-index:60;pointer-events:none;
  background:color-mix(in oklch,var(--panel) 92%,transparent);backdrop-filter:blur(10px);
  border:1px solid var(--line-strong);border-radius:var(--radius-sm);padding:.5rem .7rem;
  box-shadow:var(--shadow-lift);display:flex;flex-direction:column;gap:.1rem;max-width:16rem}
/* An author display value beats the hidden attribute, so the empty tooltip
   sat in the page corner as a small ring until something was hovered. */
.tip[hidden]{display:none}
.tip strong{font-size:var(--step-0);font-variant-numeric:tabular-nums}
.tip span{font-size:var(--step--1);color:var(--fg-muted)}
.charts-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(21rem,1fr));
  gap:1.15rem;margin-bottom:1.15rem;align-items:start}
.charts-grid section{margin-bottom:0}

/* Filter bar: one card of controls above the results, wrapping on narrow
   screens rather than scrolling, because a hidden filter is a filter nobody
   applies. */
.filters{display:flex;flex-wrap:wrap;gap:.75rem .85rem;align-items:flex-end;
  padding:1rem 1.15rem;margin:0 0 1.3rem;border:1px solid var(--line);
  border-radius:var(--radius);background:var(--panel);box-shadow:var(--shadow)}
.filters label{display:flex;flex-direction:column;gap:.3rem;margin:0;
  font-size:var(--step--2);color:var(--fg-faint);text-transform:uppercase;letter-spacing:.07em;font-weight:650}
.filters input,.filters select{min-width:8.5rem;text-transform:none;letter-spacing:normal;font-weight:500;color:var(--fg)}
.filters input[type=search]{min-width:13rem}
.filters button{align-self:flex-end}
.btn-link{align-self:flex-end;padding:.55rem .4rem;font-size:var(--step--1);color:var(--fg-muted);text-decoration:none}
.btn-link:hover{color:var(--accent)}
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
.site-footer{width:100%;max-width:74rem;margin:0 auto;padding:1.1rem 2.4rem 2rem;
  font-size:var(--step--1);color:var(--fg-faint);display:flex;flex-wrap:wrap;gap:.35rem .6rem;align-items:center}
.site-footer a{color:var(--fg-muted);text-decoration:none;display:inline-flex;align-items:center;gap:.3rem}
.site-footer a:hover{color:var(--accent)}
.bare .site-footer{justify-content:center}
.bare .content{flex:1;display:flex;flex-direction:column}

/* --- a sync in flight --------------------------------------------------- */
/* The banner, and every widget under it dimmed beneath a shimmer until the
   page reloads with fresh figures. Keyed off the banner being visible, so the
   click can show it before the server has answered. */
.sync-banner{display:flex;align-items:center;gap:.95rem;padding:.85rem 1.1rem;margin-bottom:1.15rem;
  background:var(--panel);border:1px solid color-mix(in oklch,var(--accent) 30%,var(--line));
  border-radius:var(--radius);box-shadow:var(--shadow-lift)}
.sync-banner[hidden]{display:none}
.sync-text{display:flex;flex-direction:column;gap:.1rem;flex:1;min-width:0}
.sync-text .muted{font-size:var(--step--1)}
.sync-banner progress{width:min(14rem,35%);height:.5rem;accent-color:var(--accent);border-radius:999px}
.spinner{flex:none;width:1.15rem;height:1.15rem;border-radius:50%;
  border:2px solid color-mix(in oklch,var(--accent) 22%,transparent);border-top-color:var(--accent);
  animation:spin .8s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
main:has(.sync-banner:not([hidden])) :is(section,.kpi){position:relative;overflow:hidden}
main:has(.sync-banner:not([hidden])) :is(section,.kpi)>*{opacity:.4;transition:opacity .25s}
main:has(.sync-banner:not([hidden])) :is(section,.kpi)::after{content:"";position:absolute;inset:0;
  pointer-events:none;background:linear-gradient(100deg,transparent 30%,
  color-mix(in oklch,var(--fg) 9%,transparent) 50%,transparent 70%);
  background-size:250% 100%;animation:shimmer 1.3s ease-in-out infinite}
@keyframes shimmer{from{background-position:120% 0}to{background-position:-20% 0}}
/* The global rule shortens animations to nothing, which on an infinite shimmer
   reads as flicker. Stop these outright; the dimming alone says "loading". */
@media (prefers-reduced-motion:reduce){.spinner,main :is(section,.kpi)::after{animation:none}}

/* --- assistant ----------------------------------------------------------- */
.chat-layout{display:grid;grid-template-columns:15rem 1fr;gap:1.5rem;align-items:start}
.chat-threads{position:sticky;top:1.5rem}
.btn-new-chat{margin-bottom:1rem;width:100%}
.thread-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:.15rem}
.thread-list li{padding:.5rem .65rem;border-radius:var(--radius-sm);font-size:var(--step--1)}
.thread-list li:hover{background:var(--hover)}
.thread-list li.current{background:var(--accent-soft)}
.thread-list a{display:block;color:var(--fg);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-decoration:none}
.chat-main{min-width:0}
.chat-head{align-items:baseline;gap:.75rem;flex-wrap:wrap}
.chat-head h1{margin:0}
.chat-empty{padding:1.6rem;border:1px dashed var(--line-strong);border-radius:var(--radius);margin-bottom:1.25rem;background:var(--panel)}
.suggestions{margin:.75rem 0 0;padding-left:1.1rem;color:var(--fg-muted);font-size:var(--step--1)}
.msg{margin:0 0 1.25rem;padding:1.05rem 1.2rem;border-radius:var(--radius);border:1px solid var(--line)}
/* The user's own words sit tinted and narrower; the answer gets full width.
   Shrink to the message: a one-line question in a full-width bubble reads as
   an empty box with text in the corner. */
.msg.user{background:var(--accent-soft);border-color:transparent;border-bottom-right-radius:6px;
  margin-left:auto;width:fit-content;max-width:44rem;white-space:pre-wrap}
.msg.assistant{background:var(--panel);box-shadow:var(--shadow);border-bottom-left-radius:6px}
.msg-body>*:first-child{margin-top:0}
.msg-body>*:last-child{margin-bottom:0}
.msg-body table{margin:.5rem 0}
/* Links inside a reply are the only place the page has no styled anchor, so
   without this they fall back to the UA blue, unreadable on the dark surface. */
.msg-body a,.hint a{color:var(--accent);text-decoration:underline;text-underline-offset:2px}
.msg-body a:hover{filter:brightness(1.15)}
.msg-body h3,.msg-body h4,.msg-body h5{margin:1.1rem 0 .4rem}
.msg-body blockquote{margin:.6rem 0;padding-left:.9rem;border-left:2px solid var(--line);color:var(--fg-muted)}
.msg-tools,.msg-source{margin-top:.75rem;font-size:var(--step--1)}
.msg-tools summary,.msg-source summary{cursor:pointer;color:var(--fg-muted)}
.msg-actions{display:flex;gap:1rem;align-items:baseline;justify-content:space-between;margin-top:.5rem;flex-wrap:wrap}
.chart-card{margin:1rem 0;padding:.95rem 1.05rem;border:1px solid var(--line);border-radius:var(--radius-md)}
.chart-card figcaption{font-weight:600;margin-bottom:.5rem}
.chat-input{display:flex;gap:.6rem;align-items:flex-end;margin-top:1.5rem;padding:.6rem;
  background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);box-shadow:var(--shadow-lift)}
.chat-input textarea{flex:1;font:inherit;padding:.6rem .7rem;border:0;background:transparent;
  color:var(--fg);resize:vertical;min-height:2.6rem;box-shadow:none}
.chat-input textarea:focus{box-shadow:none;background:transparent}
.chat-input:focus-within{border-color:var(--accent);box-shadow:var(--ring),var(--shadow-lift)}
@media(max-width:860px){
  .chat-layout{grid-template-columns:1fr}
  .chat-threads{position:static}
  .thread-list{flex-direction:row;overflow-x:auto;gap:.4rem}
  .thread-list li{flex:0 0 auto;max-width:12rem}
  .msg.user{max-width:100%}
}

@media(max-width:640px){
  main{padding:1.3rem .95rem 2rem}
  .site-footer{padding-inline:.95rem}
  section{padding:1.1rem 1.05rem;border-radius:14px}
  th,td{padding:.6rem .45rem}
  /* Two across rather than one: four stacked cards pushed everything else
     below the fold. */
  .kpis{grid-template-columns:1fr 1fr;gap:.6rem}
  .kpi{padding:.85rem .9rem}
  .kpi .value{letter-spacing:-.025em}
  .kpi .label{font-size:.64rem}
  .split{gap:.85rem}
  input.otp{font-size:1.4rem;letter-spacing:.3em}
  .login{padding:1.8rem 1.35rem 1.5rem}
}

/* Print is the PDF path: no chrome, no controls, just the content. */
@media print{
  .sidebar,nav,.site-footer,.chat-threads,.chat-input,.msg-actions,.msg-tools,form{display:none!important}
  .app{display:block}
  body{background:#fff}
  main{max-width:none;padding:0}
  /* A chart's table twin is collapsed on screen; the report prints its own
     tables, and a closed <details> would print as a stray summary line. */
  .chart-table,.tip{display:none!important}
  section,.kpi{break-inside:avoid;box-shadow:none}
  .report h2{break-after:avoid}
  /* Four figures across a Letter page: a seven-digit net worth at the screen
     size runs out of its card. */
  .kpi .value{font-size:var(--step-1)}
  .kpi.hero{background:none;color:inherit;border-color:var(--line)}
  .kpi.hero .value{color:inherit}
  .chat-layout{grid-template-columns:1fr}
  .msg{border:none;padding:0;background:none;break-inside:avoid;box-shadow:none}
  .msg.user{max-width:100%;font-weight:600}
  a[target=_blank]::after{content:" (" attr(href) ")";font-size:.85em;color:#555}
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
  // One set of links, grouped. On a wide screen they are a sidebar; below
  // 1060px the same markup becomes a top bar with the links as one row of
  // pills, so nothing hides behind a menu button. A sidebar also has room for
  // any app name, which a single top row did not.
  let lastGroup = '';
  const links = NAV.map((n) => {
    const heading = n.group !== lastGroup ? `<span class="nav-group">${n.group}</span>` : '';
    lastGroup = n.group;
    return (
      heading +
      `<a href="${n.href}"${n.href === current ? ' aria-current="page"' : ''}>${icon(n.icon)}<span>${n.label}</span></a>`
    );
  }).join('');
  const nav = chrome
    ? html`<aside class="sidebar"><div class="side-inner">
        <a class="brand" href="/" title="${name}">${brandMark(opts.logoUrl ?? null, 24)}<span class="brand-name">${name}</span></a>
        <nav aria-label="Main">${raw(links)}</nav>
        <div class="side-foot">
          <div class="theme-switch" role="group" aria-label="Theme">
            <button type="button" data-theme-choice="system" aria-pressed="true" title="Match the device">${raw(icon('system', 16))}<span class="sr-only">System</span></button>
            <button type="button" data-theme-choice="light" aria-pressed="false" title="Light">${raw(icon('sun', 16))}<span class="sr-only">Light</span></button>
            <button type="button" data-theme-choice="dark" aria-pressed="false" title="Dark">${raw(icon('moon', 16))}<span class="sr-only">Dark</span></button>
          </div>
          <form method="post" action="/logout"><button class="secondary" type="submit">${raw(icon('logout'))}<span>Sign out</span></button></form>
        </div>
      </div></aside>`
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

  // The theme choice is a per-browser convenience, so it lives in this
  // browser's storage, not on the server. Applied from <head>, before the body
  // paints, so a dark choice never flashes light first. Storage can be
  // unavailable (private windows, blocked site data); the page then simply
  // follows the system.
  const themeHead =
    `<script nonce="${nonce}">try{const t=localStorage.getItem('tally-theme');` +
    `if(t==='light'||t==='dark')document.documentElement.dataset.theme=t}catch(_){}</scr` + `ipt>`;
  const themeSwitch = chrome
    ? `<script nonce="${nonce}">(()=>{const root=document.documentElement;` +
      `const btns=[...document.querySelectorAll('[data-theme-choice]')];` +
      `const show=()=>{const cur=root.dataset.theme||'system';` +
      `for(const b of btns)b.setAttribute('aria-pressed',String(b.dataset.themeChoice===cur))};` +
      `for(const b of btns)b.addEventListener('click',()=>{const v=b.dataset.themeChoice;` +
      `if(v==='system')delete root.dataset.theme;else root.dataset.theme=v;` +
      `try{if(v==='system')localStorage.removeItem('tally-theme');else localStorage.setItem('tally-theme',v)}catch(_){}` +
      `show()});show()})();</scr` + `ipt>`
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
${themeHead}
<style nonce="${nonce}">${CSS}</style>
${speculation}
</head><body class="${chrome ? 'app' : 'bare'}">${nav.value}<div class="content"><main>${body.value}</main>${footer(name)}</div>${confirmScript}${idleScript}${themeSwitch}</body></html>`;
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
