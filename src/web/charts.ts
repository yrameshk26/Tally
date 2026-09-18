/**
 * Server-rendered SVG charts. No chart library: every mark is a few path
 * commands, which keeps the CSP strict and the dependency count at zero.
 *
 * Conventions (from the data-viz method):
 *  - thin marks: bars <= 24px, 2px lines, >= 8px markers with a 2px surface ring
 *  - a 2px surface gap between touching fills, never a stroke around a mark
 *  - hairline solid gridlines, one step off the surface
 *  - text always wears text tokens, never the series colour
 *  - a legend for >= 2 series, none for one; labels selective, never on every point
 *  - every chart has a table twin, so no value is gated behind hover
 *
 * Series colours are `--s1..--s6`, defined in layout.ts and validated with the
 * palette script for both light and dark surfaces — in this fixed order.
 */
import { esc, html, join, money, raw, type SafeHtml } from '../lib/html.ts';

// --- helpers --------------------------------------------------------------

/** "Nice" tick steps so the axis reads 0 / 50k / 100k, not 0 / 46,231 / 92,462. */
export function niceTicks(max: number, count = 4): number[] {
  if (!(max > 0)) return [0];
  const rough = max / count;
  const pow = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s >= rough) ?? pow * 10;
  const ticks: number[] = [];
  for (let v = 0; v <= max + step * 0.999; v += step) ticks.push(Math.round(v * 100) / 100);
  return ticks;
}

/** $150k / $1.2M — for axis ticks and tile deltas, not for table cells. */
export function compact(n: number): string {
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(abs >= 10_000_000 ? 0 : 1)}M`;
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(abs >= 100_000 ? 0 : 1)}k`;
  return `${sign}$${abs.toFixed(0)}`;
}

/** Horizontal bar with a 4px rounded data-end and a square baseline edge. */
function hbarPath(x: number, y: number, w: number, h: number, r = 4): string {
  const rr = Math.min(r, w, h / 2);
  if (w <= 0) return '';
  return (
    `M${x} ${y}H${x + w - rr}` +
    `a${rr} ${rr} 0 0 1 ${rr} ${rr}V${y + h - rr}` +
    `a${rr} ${rr} 0 0 1 -${rr} ${rr}H${x}Z`
  );
}

/** Vertical column: rounded cap, square at the baseline. */
function vbarPath(x: number, y: number, w: number, h: number, r = 4): string {
  const rr = Math.min(r, h, w / 2);
  if (h <= 0) return '';
  return (
    `M${x} ${y + h}V${y + rr}` +
    `a${rr} ${rr} 0 0 1 ${rr} -${rr}H${x + w - rr}` +
    `a${rr} ${rr} 0 0 1 ${rr} ${rr}V${y + h}Z`
  );
}

function tableTwin(caption: string, head: string[], rows: string[][]): SafeHtml {
  return html`<details class="chart-table">
    <summary>Table view</summary>
    <div class="table-wrap"><table>
      <caption class="sr-only">${caption}</caption>
      <thead><tr>${raw(head.map((h, i) => `<th${i > 0 ? ' class="num"' : ''}>${esc(h)}</th>`).join(''))}</tr></thead>
      <tbody>${raw(
        rows
          .map((r) => `<tr>${r.map((c, i) => `<td${i > 0 ? ' class="num"' : ''}>${esc(c)}</td>`).join('')}</tr>`)
          .join(''),
      )}</tbody>
    </table></div>
  </details>`;
}

// --- 1. trend: single series over time --------------------------------------

export function areaChart(opts: {
  title: string;
  points: Array<{ label: string; value: number }>;
  width?: number;
  height?: number;
}): SafeHtml {
  const W = opts.width ?? 640;
  const H = opts.height ?? 200;
  const pad = { l: 56, r: 24, t: 16, b: 28 };
  const pts = opts.points;

  if (pts.length < 2) {
    return html`<div class="chart-empty">
      <p class="empty">Net worth is recorded once a day. The trend appears after a second sync —
        there ${pts.length === 1 ? 'is one point' : 'are no points'} so far.</p>
      ${pts.length ? tableTwin(opts.title, ['Date', 'Net worth'], pts.map((p) => [p.label, money(p.value)])) : raw('')}
    </div>`;
  }

  const values = pts.map((p) => p.value);
  const lo = Math.min(0, ...values);
  const hi = Math.max(...values);
  const ticks = niceTicks(hi);
  const top = ticks[ticks.length - 1] ?? hi;
  const iw = W - pad.l - pad.r;
  const ih = H - pad.t - pad.b;
  const x = (i: number): number => pad.l + (i / (pts.length - 1)) * iw;
  const y = (v: number): number => pad.t + ih - ((v - lo) / (top - lo || 1)) * ih;

  const line = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)} ${y(p.value).toFixed(1)}`).join('');
  const area = `${line}L${x(pts.length - 1).toFixed(1)} ${y(lo).toFixed(1)}L${x(0).toFixed(1)} ${y(lo).toFixed(1)}Z`;
  const last = pts[pts.length - 1]!;
  const first = pts[0]!;
  const delta = last.value - first.value;

  // Sparse x labels: first, last, and a few in between.
  const every = Math.max(1, Math.ceil(pts.length / 5));
  const xLabels = pts
    .map((p, i) => (i % every === 0 || i === pts.length - 1 ? { i, label: p.label.slice(5) } : null))
    .filter((v): v is { i: number; label: string } => v !== null);

  // Hit columns: one per point, wider than the mark, driving the crosshair.
  const colW = iw / (pts.length - 1);
  const hits = pts
    .map(
      (p, i) =>
        `<rect class="hit" x="${(x(i) - colW / 2).toFixed(1)}" y="${pad.t}" width="${colW.toFixed(1)}" height="${ih}" ` +
        `data-x="${x(i).toFixed(1)}" data-y="${y(p.value).toFixed(1)}" data-tip="${esc(p.label)}|${esc(money(p.value))}" tabindex="0"/>`,
    )
    .join('');

  return html`<figure class="chart" data-chart="area">
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${opts.title}" preserveAspectRatio="none" class="chart-svg">
      ${raw(
        ticks
          .map(
            (t) =>
              `<line class="grid" x1="${pad.l}" x2="${W - pad.r}" y1="${y(t).toFixed(1)}" y2="${y(t).toFixed(1)}"/>` +
              `<text class="tick" x="${pad.l - 8}" y="${(y(t) + 4).toFixed(1)}" text-anchor="end">${esc(compact(t))}</text>`,
          )
          .join(''),
      )}
      ${raw(
        xLabels
          .map((l) => `<text class="tick" x="${x(l.i).toFixed(1)}" y="${H - 8}" text-anchor="middle">${esc(l.label)}</text>`)
          .join(''),
      )}
      <path class="area s1" d="${area}"/>
      <path class="line s1" d="${line}"/>
      <line class="crosshair" x1="0" x2="0" y1="${pad.t}" y2="${pad.t + ih}" hidden/>
      <circle class="marker s1" cx="${x(pts.length - 1).toFixed(1)}" cy="${y(last.value).toFixed(1)}" r="4"/>
      <circle class="cursor s1" cx="0" cy="0" r="4" hidden/>
      ${raw(hits)}
    </svg>
    <figcaption class="chart-caption">
      <span class="muted">${first.label} → ${last.label}</span>
      <span class="${delta >= 0 ? 'pos' : 'neg'}">${delta >= 0 ? '+' : ''}${money(delta)}</span>
    </figcaption>
    ${tableTwin(opts.title, ['Date', 'Net worth'], pts.map((p) => [p.label, money(p.value)]))}
  </figure>`;
}

// --- 2. part-to-whole: one horizontal stacked bar ------------------------------

export function stackedBar(opts: {
  title: string;
  segments: Array<{ label: string; value: number }>;
  maxSegments?: number;
}): SafeHtml {
  const cap = opts.maxSegments ?? 6;
  const positive = opts.segments.filter((s) => s.value > 0).sort((a, b) => b.value - a.value);
  const total = positive.reduce((a, s) => a + s.value, 0);
  if (total <= 0) return html`<p class="empty">Nothing to allocate yet.</p>`;

  // Fold the tail into "Other" rather than inventing a 7th colour.
  const shown = positive.length > cap ? positive.slice(0, cap - 1) : positive;
  const tail = positive.slice(shown.length);
  const segs = tail.length
    ? [...shown, { label: 'Other', value: tail.reduce((a, s) => a + s.value, 0) }]
    : shown;

  const W = 640;
  const H = 28;
  const GAP = 2;
  let cursor = 0;
  const rects = segs
    .map((s, i) => {
      const w = (s.value / total) * W;
      const xx = cursor;
      cursor += w;
      const inner = Math.max(0, w - (i < segs.length - 1 ? GAP : 0));
      const pct = (s.value / total) * 100;
      // Label inside only when it comfortably fits (~7px per char + padding).
      const label = `${pct.toFixed(0)}%`;
      const fits = inner >= label.length * 7 + 16;
      return (
        `<rect class="seg s${i + 1}" x="${xx.toFixed(1)}" y="0" width="${inner.toFixed(1)}" height="${H}" ` +
        `data-tip="${esc(s.label)}|${esc(money(s.value))} · ${pct.toFixed(1)}%" tabindex="0"/>` +
        (fits
          ? `<text class="seg-label" x="${(xx + inner / 2).toFixed(1)}" y="${H / 2 + 4}" text-anchor="middle">${esc(label)}</text>`
          : '')
      );
    })
    .join('');

  return html`<figure class="chart" data-chart="stack">
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${opts.title}" preserveAspectRatio="none" class="chart-svg stack-svg">
      ${raw(rects)}
    </svg>
    <ul class="legend">${join(
      segs.map(
        (s, i) => html`<li><span class="swatch s${i + 1}"></span>${s.label}
          <span class="muted">${((s.value / total) * 100).toFixed(1)}%</span></li>`,
      ),
    )}</ul>
    ${tableTwin(opts.title, ['Type', 'Value', 'Share'], segs.map((s) => [s.label, money(s.value), `${((s.value / total) * 100).toFixed(1)}%`]))}
  </figure>`;
}

// --- 3. magnitude: horizontal bars, one hue -----------------------------------

export function hBars(opts: {
  title: string;
  rows: Array<{ label: string; value: number; note?: string }>;
  max?: number;
  format?: (v: number) => string;
}): SafeHtml {
  const rows = opts.rows.filter((r) => r.value > 0);
  if (rows.length === 0) return html`<p class="empty">No holdings yet.</p>`;
  const fmt = opts.format ?? money;
  const max = opts.max ?? Math.max(...rows.map((r) => r.value));
  const W = 640;
  const labelW = 88;
  const valueW = 96;
  const barMax = W - labelW - valueW;
  const rowH = 30;
  const barH = 18;
  const H = rows.length * rowH;

  const marks = rows
    .map((r, i) => {
      const w = (r.value / max) * barMax;
      const yy = i * rowH + (rowH - barH) / 2;
      return (
        `<text class="label" x="${labelW - 10}" y="${yy + barH / 2 + 4}" text-anchor="end">${esc(r.label)}</text>` +
        `<path class="bar s1" d="${hbarPath(labelW, yy, w, barH)}" data-tip="${esc(r.label)}|${esc(fmt(r.value))}${r.note ? ` · ${esc(r.note)}` : ''}" tabindex="0"/>` +
        `<text class="value" x="${(labelW + w + 8).toFixed(1)}" y="${yy + barH / 2 + 4}">${esc(fmt(r.value))}</text>`
      );
    })
    .join('');

  return html`<figure class="chart" data-chart="hbars">
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${opts.title}" class="chart-svg">
      ${raw(marks)}
    </svg>
    ${tableTwin(opts.title, ['', 'Value'], rows.map((r) => [r.label, fmt(r.value)]))}
  </figure>`;
}

// --- 4. two series over time: grouped columns ----------------------------------

export function groupedColumns(opts: {
  title: string;
  groups: Array<{ label: string; a: number; b: number }>;
  seriesA: string;
  seriesB: string;
}): SafeHtml {
  const groups = opts.groups;
  if (groups.length === 0 || groups.every((g) => g.a === 0 && g.b === 0)) {
    return html`<p class="empty">No transactions in this period yet. Cashflow appears once a
      bank has synced a month of activity.</p>`;
  }
  const W = 640;
  const H = 200;
  const pad = { l: 56, r: 16, t: 16, b: 28 };
  const iw = W - pad.l - pad.r;
  const ih = H - pad.t - pad.b;
  const max = Math.max(...groups.flatMap((g) => [g.a, g.b]));
  const ticks = niceTicks(max);
  const top = ticks[ticks.length - 1] ?? max;
  const y = (v: number): number => pad.t + ih - (v / (top || 1)) * ih;
  const slot = iw / groups.length;
  const barW = Math.min(24, (slot - 12) / 2 - 1);
  const GAP = 2;

  const marks = groups
    .map((g, i) => {
      const cx = pad.l + slot * i + slot / 2;
      const ax = cx - barW - GAP / 2;
      const bx = cx + GAP / 2;
      return (
        `<path class="bar s1" d="${vbarPath(ax, y(g.a), barW, ih + pad.t - y(g.a))}" data-tip="${esc(g.label)} · ${esc(opts.seriesA)}|${esc(money(g.a))}" tabindex="0"/>` +
        `<path class="bar s2" d="${vbarPath(bx, y(g.b), barW, ih + pad.t - y(g.b))}" data-tip="${esc(g.label)} · ${esc(opts.seriesB)}|${esc(money(g.b))}" tabindex="0"/>` +
        `<text class="tick" x="${cx.toFixed(1)}" y="${H - 8}" text-anchor="middle">${esc(g.label)}</text>`
      );
    })
    .join('');

  return html`<figure class="chart" data-chart="columns">
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${opts.title}" preserveAspectRatio="none" class="chart-svg">
      ${raw(
        ticks
          .map(
            (t) =>
              `<line class="grid" x1="${pad.l}" x2="${W - pad.r}" y1="${y(t).toFixed(1)}" y2="${y(t).toFixed(1)}"/>` +
              `<text class="tick" x="${pad.l - 8}" y="${(y(t) + 4).toFixed(1)}" text-anchor="end">${esc(compact(t))}</text>`,
          )
          .join(''),
      )}
      ${raw(marks)}
    </svg>
    <ul class="legend">
      <li><span class="swatch s1"></span>${opts.seriesA}</li>
      <li><span class="swatch s2"></span>${opts.seriesB}</li>
    </ul>
    ${tableTwin(opts.title, ['Month', opts.seriesA, opts.seriesB, 'Net'], groups.map((g) => [g.label, money(g.a), money(g.b), money(g.a - g.b)]))}
  </figure>`;
}

/**
 * The single hover layer for every chart on a page: one tooltip element, one
 * listener, keyed off `data-tip="label|value"` on any mark. Nonced, so the CSP
 * stays at default-src 'none'. Focus shows the same as hover.
 */
export function chartRuntime(nonce: string): string {
  return (
    `<script nonce="${nonce}">(()=>{` +
    `const tip=document.createElement('div');tip.className='tip';tip.hidden=true;document.body.appendChild(tip);` +
    `const show=(el,ev)=>{const [l,v]=(el.dataset.tip||'').split('|');` +
    `tip.replaceChildren();const b=document.createElement('strong');b.textContent=v||'';const s=document.createElement('span');s.textContent=l||'';tip.append(b,s);` +
    `tip.hidden=false;const r=el.getBoundingClientRect();const px=ev&&ev.clientX!=null?ev.clientX:r.left+r.width/2;const py=ev&&ev.clientY!=null?ev.clientY:r.top;` +
    `tip.style.left=Math.min(px+12,innerWidth-tip.offsetWidth-8)+'px';tip.style.top=(py-tip.offsetHeight-10+scrollY)+'px';` +
    `const svg=el.closest('svg');if(svg&&el.classList.contains('hit')){const ch=svg.querySelector('.crosshair'),cu=svg.querySelector('.cursor');` +
    `if(ch){ch.setAttribute('x1',el.dataset.x);ch.setAttribute('x2',el.dataset.x);ch.hidden=false}if(cu){cu.setAttribute('cx',el.dataset.x);cu.setAttribute('cy',el.dataset.y);cu.hidden=false}}` +
    `el.classList.add('is-hover')};` +
    `const hide=(el)=>{tip.hidden=true;el.classList.remove('is-hover');const svg=el.closest('svg');if(svg){for(const n of svg.querySelectorAll('.crosshair,.cursor'))n.hidden=true}};` +
    `for(const el of document.querySelectorAll('[data-tip]')){` +
    `el.addEventListener('pointermove',e=>show(el,e));el.addEventListener('pointerleave',()=>hide(el));` +
    `el.addEventListener('focus',()=>show(el));el.addEventListener('blur',()=>hide(el))}` +
    `})();</scr` + `ipt>`
  );
}
