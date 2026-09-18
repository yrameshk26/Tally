/**
 * Minimal HTML templating with escaping on by default.
 *
 * This matters more here than in most apps: merchant names, transaction
 * descriptions and security names come from institutions and ultimately from
 * whoever typed the memo field on a transfer. They are safe as MCP text; in a
 * rendered page they are a stored-XSS vector. So interpolation escapes unless
 * the value is explicitly marked safe.
 */
const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function esc(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value).replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c);
}

/** Wrapper marking a string as already-safe HTML, so `html` will not escape it. */
export class SafeHtml {
  // Declared explicitly rather than as a parameter property: `erasableSyntaxOnly`
  // is on so the source stays runnable by Node's type stripping.
  readonly value: string;
  constructor(value: string) {
    this.value = value;
  }
  toString(): string {
    return this.value;
  }
}

export function raw(value: string): SafeHtml {
  return new SafeHtml(value);
}

/** Join pre-escaped fragments (e.g. rows built in a loop). */
export function join(parts: Array<SafeHtml | string>, sep = ''): SafeHtml {
  return raw(parts.map((p) => (p instanceof SafeHtml ? p.value : esc(p))).join(sep));
}

export function html(strings: TemplateStringsArray, ...values: unknown[]): SafeHtml {
  let out = strings[0] ?? '';
  for (let i = 0; i < values.length; i += 1) {
    const v = values[i];
    if (v instanceof SafeHtml) out += v.value;
    else if (Array.isArray(v)) out += join(v as Array<SafeHtml | string>).value;
    else out += esc(v);
    out += strings[i + 1] ?? '';
  }
  return raw(out);
}

/** Money for display. Negative renders with a minus sign, never parentheses. */
export function money(n: number, currency = 'CAD'): string {
  return new Intl.NumberFormat('en-CA', {
    style: 'currency',
    currency,
    maximumFractionDigits: 2,
  }).format(n);
}
