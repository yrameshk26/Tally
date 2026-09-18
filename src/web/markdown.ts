/**
 * A small Markdown renderer for assistant replies.
 *
 * Why not a library: this page renders text produced by a third-party model,
 * from data supplied by institutions. Every general-purpose Markdown renderer
 * has an HTML passthrough mode, and the safe configuration is one flag away
 * from the unsafe one. Here the input is escaped *first* and tags are only ever
 * emitted by this file, so there is no passthrough to get wrong — raw HTML in a
 * reply renders as visible text, which is the correct outcome.
 *
 * It covers what a financial answer actually uses: headings, tables, lists,
 * emphasis, code, blockquotes, links and horizontal rules. Anything else is
 * left as text rather than silently swallowed.
 */
import { esc, raw, type SafeHtml } from '../lib/html.ts';

/** Links are the one place a URL from the model reaches an attribute. */
function safeHref(url: string): string | null {
  const trimmed = url.trim();
  // Anything but http(s) — javascript:, data:, vbscript: — is refused outright.
  if (!/^https?:\/\//i.test(trimmed)) return null;
  try {
    return new URL(trimmed).toString();
  } catch {
    return null;
  }
}

/** Emphasis and links, applied to an already-escaped run of non-code text. */
function emphasis(escaped: string): string {
  let out = escaped;
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, text: string, url: string) => {
    const href = safeHref(url.replace(/&amp;/g, '&'));
    return href ? `<a href="${esc(href)}" rel="noreferrer noopener" target="_blank">${text}</a>` : m;
  });
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>');
  out = out.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  return out;
}

/**
 * Inline spans. Code is split out by tokenising on backticks rather than by
 * substituting placeholders: a placeholder that happened to appear in the text
 * would be replaced on the way back out, and the text here is attacker-shaped.
 */
function inline(escaped: string): string {
  const parts = escaped.split('`');
  return parts
    .map((part, i) => (i % 2 === 1 ? `<code>${part}</code>` : emphasis(part)))
    .join('');
}

function tableRow(line: string): string[] {
  return line
    .replace(/^\s*\|/, '')
    .replace(/\|\s*$/, '')
    .split('|')
    .map((c) => c.trim());
}

const isDivider = (line: string): boolean =>
  /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(line) && line.includes('-');

export type FencedBlock = { lang: string; body: string };

/**
 * Render Markdown to HTML. `onFence` receives fenced blocks, so a caller can
 * turn e.g. a chart spec into a figure; returning null falls back to a code
 * block.
 */
export function renderMarkdown(
  source: string,
  onFence?: (block: FencedBlock) => SafeHtml | null,
): SafeHtml {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  const para: string[] = [];
  let i = 0;

  const flushParagraph = (): void => {
    if (para.length === 0) return;
    out.push(`<p>${inline(esc(para.join(' ')))}</p>`);
    para.length = 0;
  };

  while (i < lines.length) {
    const line = lines[i] ?? '';

    // Fenced code, and the extension point for charts.
    const fence = /^\s*```\s*([\w-]*)\s*$/.exec(line);
    if (fence) {
      flushParagraph();
      const lang = fence[1] ?? '';
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i] ?? '')) {
        body.push(lines[i] ?? '');
        i += 1;
      }
      i += 1; // closing fence
      const text = body.join('\n');
      const custom = onFence?.({ lang, body: text });
      out.push(custom ? custom.value : `<pre class="code-block"><code>${esc(text)}</code></pre>`);
      continue;
    }

    if (/^\s*(---|\*\*\*|___)\s*$/.test(line)) {
      flushParagraph();
      out.push('<hr>');
      i += 1;
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flushParagraph();
      // A reply sits inside the page, so h1 would compete with the page title;
      // every level is shifted down two.
      const level = Math.min(6, (heading[1] ?? '#').length + 2);
      out.push(`<h${String(level)}>${inline(esc(heading[2] ?? ''))}</h${String(level)}>`);
      i += 1;
      continue;
    }

    // Table: a header row followed by a divider.
    if (line.includes('|') && isDivider(lines[i + 1] ?? '')) {
      flushParagraph();
      const head = tableRow(line);
      // A column the model right-aligned is a number column; matching the rest
      // of the app's tables keeps figures on the tabular-numerals path.
      const aligns = tableRow(lines[i + 1] ?? '').map((c) =>
        c.endsWith(':') && !c.startsWith(':') ? ' class="num"' : '',
      );
      i += 2;
      const body: string[][] = [];
      while (i < lines.length && (lines[i] ?? '').includes('|')) {
        body.push(tableRow(lines[i] ?? ''));
        i += 1;
      }
      const th = head.map((c, n) => `<th${aligns[n] ?? ''}>${inline(esc(c))}</th>`).join('');
      const rows = body
        .map(
          (r) =>
            `<tr>${r.map((c, n) => `<td${aligns[n] ?? ''}>${inline(esc(c))}</td>`).join('')}</tr>`,
        )
        .join('');
      out.push(
        `<div class="table-wrap"><table><thead><tr>${th}</tr></thead><tbody>${rows}</tbody></table></div>`,
      );
      continue;
    }

    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (bullet || numbered) {
      flushParagraph();
      const ordered = numbered !== null;
      const items: string[] = [];
      while (i < lines.length) {
        const m = ordered
          ? /^\s*\d+[.)]\s+(.*)$/.exec(lines[i] ?? '')
          : /^\s*[-*+]\s+(.*)$/.exec(lines[i] ?? '');
        if (!m) break;
        items.push(`<li>${inline(esc(m[1] ?? ''))}</li>`);
        i += 1;
      }
      const tag = ordered ? 'ol' : 'ul';
      out.push(`<${tag}>${items.join('')}</${tag}>`);
      continue;
    }

    const quote = /^\s*>\s?(.*)$/.exec(line);
    if (quote) {
      flushParagraph();
      const items: string[] = [];
      while (i < lines.length) {
        const m = /^\s*>\s?(.*)$/.exec(lines[i] ?? '');
        if (!m) break;
        items.push(m[1] ?? '');
        i += 1;
      }
      out.push(`<blockquote>${inline(esc(items.join(' ')))}</blockquote>`);
      continue;
    }

    if (line.trim() === '') {
      flushParagraph();
      i += 1;
      continue;
    }

    para.push(line.trim());
    i += 1;
  }

  flushParagraph();
  return raw(out.join('\n'));
}
