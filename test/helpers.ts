/** Shared assertions for the rendered pages. */
/**
 * Inline handlers, ignoring anything inside a quoted attribute value — an
 * escaped merchant name like `&lt;img src=x onerror=...&gt;` is inert text in a
 * value attribute, and a regex that flags it is testing itself, not the page.
 */
export function inlineHandlers(htmlText: string): string[] {
  const withoutValues = htmlText.replace(/"[^"]*"|'[^']*'/g, '""');
  return withoutValues.match(/<[^>]+\son[a-z]+\s*=/gi) ?? [];
}
