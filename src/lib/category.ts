/**
 * Plaid files rent and every utility bill under one primary category,
 * RENT_AND_UTILITIES, which hides the one split a household most wants to see:
 * what the home costs versus what running it costs. Its detailed category says
 * which is which, so the primary is refined here, once, as rows are written.
 *
 * Only a row whose detailed category says so is split. Without one the
 * combined label stays: guessing "utilities" for an unlabelled row would be a
 * made-up answer presented as the bank's.
 */
export const RENT = 'RENT';
export const UTILITIES = 'UTILITIES';
const COMBINED = 'RENT_AND_UTILITIES';

export function refineCategory(category: string | null, detailed: string | null): string | null {
  if (category !== COMBINED || !detailed?.startsWith(`${COMBINED}_`)) return category;
  return detailed === `${COMBINED}_RENT` ? RENT : UTILITIES;
}
