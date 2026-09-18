/**
 * The tally mark: four strokes stepping upward, struck through.
 *
 * Kept as SVG rather than a raster so it is crisp at 16px and 512px alike, and
 * so it can take `currentColor` in the page and a media-query-aware fill in
 * the favicon. Geometry traced from the approved artwork on a 100-unit grid.
 */

const STROKE = 6.5;
const BOTTOM = 79;
/** x positions and top y of the four uprights — each one taller than the last. */
const UPRIGHTS: Array<[number, number]> = [
  [30, 42],
  [43, 35],
  [56, 28],
  [69, 21],
];
const SLASH: [number, number, number, number] = [22, 68, 78, 31];

function paths(): string {
  const bars = UPRIGHTS.map(([x, top]) => `M${x} ${top}V${BOTTOM}`).join('');
  const [x1, y1, x2, y2] = SLASH;
  return `<path d="${bars}M${x1} ${y1}L${x2} ${y2}" fill="none" stroke="currentColor" stroke-width="${STROKE}" stroke-linecap="round" stroke-linejoin="round"/>`;
}

/** Inline mark for the page chrome. Inherits the text colour. */
export function logoSvg(size = 22, className = ''): string {
  return (
    `<svg width="${size}" height="${size}" viewBox="0 0 100 100" aria-hidden="true"` +
    (className ? ` class="${className}"` : '') +
    `>${paths()}</svg>`
  );
}

/**
 * Standalone favicon. Colour follows the OS theme via an embedded stylesheet:
 * jade on light, mint on dark — the same two accent tokens the UI uses.
 */
export function faviconSvg(): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">` +
    `<style>path{color:oklch(52% .11 172)}@media(prefers-color-scheme:dark){path{color:oklch(76% .13 172)}}</style>` +
    paths() +
    `</svg>`
  );
}
