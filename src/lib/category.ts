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
import { GROUPED_PARENTS, groupedLabel } from './taxonomy.ts';

export const RENT = 'RENT';
export const UTILITIES = 'UTILITIES';
const COMBINED = 'RENT_AND_UTILITIES';

export function refineCategory(category: string | null, detailed: string | null): string | null {
  if (category !== COMBINED || !detailed?.startsWith(`${COMBINED}_`)) return category;
  return detailed === `${COMBINED}_RENT` ? RENT : UTILITIES;
}

/**
 * Plaid's personal finance category primaries. A detailed category is its
 * primary with more words on the end (FOOD_AND_DRINK_GROCERIES), so this list
 * is what turns one back into the other. The first sixteen are Plaid's
 * published taxonomy; the rest have been seen on live Items.
 */
export const PFC_PRIMARIES = [
  'INCOME',
  'TRANSFER_IN',
  'TRANSFER_OUT',
  'LOAN_PAYMENTS',
  'BANK_FEES',
  'ENTERTAINMENT',
  'FOOD_AND_DRINK',
  'GENERAL_MERCHANDISE',
  'HOME_IMPROVEMENT',
  'MEDICAL',
  'PERSONAL_CARE',
  'GENERAL_SERVICES',
  'GOVERNMENT_AND_NON_PROFIT',
  'TRANSPORTATION',
  'TRAVEL',
  'RENT_AND_UTILITIES',
  'OTHER',
  'LOAN_DISBURSEMENTS',
  'KIDS_ENTERTAINMENT',
] as const;

/**
 * How spending is categorised. Grouped is a budgeting app's list (Food ›
 * Groceries, Family care › Childcare & daycare; see lib/taxonomy.ts), built
 * from Plaid's detailed category. Detailed is Plaid's detailed category as it
 * comes (Groceries, Coffee, Gas); broad is Plaid's primary (Food and drink,
 * Transportation). It is chosen on read, so switching rewrites nothing.
 */
export type CategoryDetail = 'grouped' | 'detailed' | 'broad';
export const CATEGORY_DETAILS: readonly CategoryDetail[] = ['grouped', 'detailed', 'broad'];
export const DEFAULT_CATEGORY_DETAIL: CategoryDetail = 'grouped';

const UPPER_SNAKE = /^[A-Z0-9]+(?:_[A-Z0-9]+)*$/;

/** Is `category` the family itself, or one of its detailed members? */
export function inFamily(category: string | null | undefined, family: string): boolean {
  if (!category) return false;
  return category === family || category.startsWith(`${family}_`);
}

/** Plaid's primaries and the grouped parents: every code a category can belong to. */
const FAMILIES: readonly string[] = [...new Set([...PFC_PRIMARIES, ...GROUPED_PARENTS])];

/**
 * The Plaid primary or grouped parent a category belongs to, or null for one
 * that is neither (a hand-added category, RENT, UTILITIES). The longest match
 * wins, so HOME_IMPROVEMENT_HARDWARE is Plaid's HOME_IMPROVEMENT, not HOME.
 */
export function familyOf(category: string | null | undefined): string | null {
  if (!category) return null;
  let best: string | null = null;
  for (const p of FAMILIES) {
    if (inFamily(category, p) && (!best || p.length > best.length)) best = p;
  }
  return best;
}

/**
 * The category a row is read under. In detailed mode that is the detailed code
 * when Plaid sent one, and the stored category otherwise: an older Item's
 * legacy "Food and Drink > Restaurants" path is not a code and is left alone,
 * as is anything else that does not belong to a known primary or to the row's
 * own. Corrections are applied after this, so a hand choice still wins.
 */
export function effectiveCategory(
  category: string | null,
  detailed: string | null | undefined,
  mode: CategoryDetail,
): string | null {
  if (mode === 'broad' || !detailed || !UPPER_SNAKE.test(detailed)) return category;
  // Grouped starts from the detailed code too; lib/taxonomy.ts maps it after
  // corrections, so a hand choice made in Plaid's terms is mapped as well.
  const family = familyOf(detailed) ?? (category && detailed.startsWith(`${category}_`) ? category : null);
  return family && detailed !== family ? detailed : category;
}

/** Plaid's detailed code for a mortgage payment. */
export const MORTGAGE_PAYMENT = 'LOAN_PAYMENTS_MORTGAGE_PAYMENT';
/** What a mortgage payment is read as: Home › Mortgage, which is spending. */
export const MORTGAGE = 'HOME_MORTGAGE';

/**
 * Whether a row is a mortgage payment that counts as spending. Plaid files it
 * under loan payments, which are left out of spending because paying a card
 * would otherwise count on top of its purchases. A mortgage has no purchases
 * to count, so leaving it out understates what the household spends; the money
 * leaving a bank account for the lender is the expense.
 *
 * Only the outflow counts, and not on the mortgage account itself: when the
 * loan is linked too, its side of the same payment arrives as a credit, and
 * charges on it are not a second payment. Both stay excluded, so the payment is
 * counted once, from the account it left.
 */
export function countsAsMortgageSpend(
  detailed: string | null | undefined,
  outflow: boolean,
  accountCategory: string | null | undefined,
): boolean {
  return detailed === MORTGAGE_PAYMENT && outflow && (accountCategory ?? '').toUpperCase() !== 'LOAN';
}

/** The family a category is totalled under, for "how much on food". */
export function categoryGroup(category: string | null | undefined): string {
  return familyOf(category) ?? category ?? 'UNCATEGORIZED';
}

const ACRONYMS: Record<string, string> = { tv: 'TV', atm: 'ATM', diy: 'DIY' };

/** Where dropping the primary leaves a word that means something else. */
const LABELS: Record<string, string> = {
  // "Gas" beside "Gas and electricity" reads as the same bill.
  TRANSPORTATION_GAS: 'Fuel',
};

/** The heading a family's categories are listed under in a picker. */
export function familyLabel(family: string): string {
  return groupedLabel(family) ?? sentenceCase(family);
}

/** UPPER_SNAKE_CASE as a sentence: GENERAL_MERCHANDISE is "General merchandise". */
export function sentenceCase(code: string): string {
  const words = code
    .trim()
    .replace(/_+/g, ' ')
    .toLowerCase()
    .split(' ')
    .map((w) => ACRONYMS[w] ?? w)
    .join(' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * The label a person reads. A detailed category drops the primary it repeats
 * (FOOD_AND_DRINK_GROCERIES is "Groceries"), except for transfers, where the
 * direction is the whole point: "Transfer out: savings".
 */
export function categoryLabel(category: string): string {
  const own = LABELS[category] ?? groupedLabel(category);
  if (own) return own;
  const family = familyOf(category);
  if (!family || family === category) return sentenceCase(category);
  const rest = sentenceCase(category.slice(family.length + 1));
  if (family === 'TRANSFER_IN' || family === 'TRANSFER_OUT') {
    return `${sentenceCase(family)}: ${rest.charAt(0).toLowerCase()}${rest.slice(1)}`;
  }
  return rest;
}
