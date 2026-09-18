/**
 * Map a brokerage account's raw name / type strings onto a Canadian
 * registered-account bucket. SnapTrade reports these inconsistently between
 * brokerages (Wealthsimple puts it in the account name, Questrade in the
 * meta), so we look at every string we were given and take the first hit.
 *
 * Order matters: "group RRSP" must not match TFSA, and "spousal RRSP" is still
 * an RRSP. RRIF/LIF are checked before RRSP/LIRA because they are the
 * decumulation versions and would otherwise be swallowed by the substring.
 */
export type RegisteredType =
  | 'RRSP'
  | 'TFSA'
  | 'LIRA'
  | 'DPSP'
  | 'RESP'
  | 'FHSA'
  | 'RRIF'
  | 'LIF'
  | 'NON_REG'
  | 'NA';

const RULES: Array<[RegisteredType, RegExp]> = [
  ['FHSA', /\bfhsa\b|first[-\s]?home\s+savings/i],
  ['RESP', /\bresp\b|education\s+savings/i],
  ['DPSP', /\bdpsp\b|deferred\s+profit/i],
  ['RRIF', /\brrif\b|registered\s+retirement\s+income/i],
  ['LIF', /\blif\b|life\s+income\s+fund/i],
  ['LIRA', /\blira\b|\blrsp\b|locked[-\s]?in/i],
  ['TFSA', /\btfsa\b|tax[-\s]?free\s+savings/i],
  ['RRSP', /\brrsp\b|\bsrrsp\b|\bgrsp\b|retirement\s+savings/i],
];

const NON_REG =
  /\bnon[-\s]?registered\b|\bcash\b|\bmargin\b|\bpersonal\b|\bindividual\b|\bcrypto\b|\bchequing\b|\bchecking\b|\bsavings\b/i;

export function guessRegistered(...parts: Array<string | null | undefined>): RegisteredType {
  // SnapTrade reports raw types like `CA_TFSA` and Plaid subtypes like
  // `retirement-rrsp`, where `_` and `-` are word characters and would defeat
  // the \b anchors below. Flatten every separator to a space first.
  const hay = parts.filter(Boolean).join(' ').replace(/[_\-/.,]+/g, ' ');
  if (!hay.trim()) return 'NA';
  for (const [type, re] of RULES) {
    if (re.test(hay)) return type;
  }
  if (NON_REG.test(hay)) return 'NON_REG';
  return 'NA';
}

/** True for buckets that carry contribution room we track. */
export function hasContributionRoom(t: RegisteredType): boolean {
  return t === 'RRSP' || t === 'TFSA' || t === 'FHSA';
}
