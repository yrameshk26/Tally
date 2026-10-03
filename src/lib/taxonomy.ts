/**
 * Grouped categories: a budgeting app's list (modelled on Fidelity's, which a
 * user sent over) rather than a bank's. "Family care › Childcare & daycare"
 * and "Bills & utilities › Phone, internet, cable & security" instead of
 * GENERAL_SERVICES_CHILDCARE and RENT_AND_UTILITIES_TELEPHONE.
 *
 * Every Plaid detailed category that means spending maps to one entry here.
 * Some entries have no Plaid source at all (Pets › Grooming, Home › Condo
 * fees): they exist to be chosen by hand, which is the point of a fixed list.
 *
 * What this never touches: income, transfers and loan or card payments keep
 * Plaid's own codes. Mapping a mortgage payment into "Home" would turn money
 * the app deliberately leaves out of spending into spending, and the three
 * category modes must agree on every total (CLAUDE.md rule 12).
 *
 * Codes follow the same PARENT_CHILD shape as Plaid's, so a filter on a parent
 * finds its children. No child may start with a longer parent's code
 * (HOME_IMPROVEMENT is Plaid's), or it would be filed under that one instead;
 * test/category.test.ts checks every entry.
 */
type Parent = {
  code: string;
  label: string;
  /** Plaid codes that mean "this area, nothing more specific". */
  from: string[];
  subs: Array<[code: string, label: string, from: string[]]>;
};

const TAXONOMY: Parent[] = [
  {
    code: 'AUTO_AND_TRANSPORT',
    label: 'Auto & transport',
    from: ['TRANSPORTATION', 'TRANSPORTATION_OTHER_TRANSPORTATION'],
    subs: [
      ['AUTO_AND_TRANSPORT_FUEL', 'Gas, fuel & charging', ['TRANSPORTATION_GAS']],
      ['AUTO_AND_TRANSPORT_PARKING', 'Parking, garages & tolls', ['TRANSPORTATION_PARKING', 'TRANSPORTATION_TOLLS']],
      ['AUTO_AND_TRANSPORT_SERVICE', 'Parts & auto services', ['GENERAL_SERVICES_AUTOMOTIVE']],
      ['AUTO_AND_TRANSPORT_PUBLIC_TRANSIT', 'Public transit', ['TRANSPORTATION_PUBLIC_TRANSIT']],
      ['AUTO_AND_TRANSPORT_REGISTRATION', 'Registration, fees & taxes', []],
      ['AUTO_AND_TRANSPORT_RENTALS', 'Rentals', ['TRAVEL_RENTAL_CARS', 'TRANSPORTATION_BIKES_AND_SCOOTERS']],
      ['AUTO_AND_TRANSPORT_TAXI', 'Taxi & rideshare', ['TRANSPORTATION_TAXIS_AND_RIDE_SHARES']],
    ],
  },
  {
    code: 'BILLS_AND_UTILITIES',
    label: 'Bills & utilities',
    // UTILITIES is the stored half of Plaid's combined category once rent is
    // split out (lib/category.ts), so it can only be a bill.
    from: ['UTILITIES', 'RENT_AND_UTILITIES_OTHER_UTILITIES'],
    subs: [
      ['BILLS_AND_UTILITIES_ENERGY', 'Heating, electric & gas', ['RENT_AND_UTILITIES_GAS_AND_ELECTRICITY']],
      [
        'BILLS_AND_UTILITIES_PHONE_INTERNET',
        'Phone, internet, cable & security',
        ['RENT_AND_UTILITIES_TELEPHONE', 'RENT_AND_UTILITIES_INTERNET_AND_CABLE', 'HOME_IMPROVEMENT_SECURITY'],
      ],
      [
        'BILLS_AND_UTILITIES_WATER',
        'Water, sewer & sanitation',
        ['RENT_AND_UTILITIES_WATER', 'RENT_AND_UTILITIES_SEWAGE_AND_WASTE_MANAGEMENT'],
      ],
    ],
  },
  {
    code: 'BUSINESS_AND_SERVICES',
    label: 'Business & services',
    from: ['GENERAL_SERVICES', 'GENERAL_SERVICES_OTHER_GENERAL_SERVICES'],
    subs: [
      [
        'BUSINESS_AND_SERVICES_PROFESSIONAL',
        'Professional (legal, accounting & services)',
        ['GENERAL_SERVICES_ACCOUNTING_AND_FINANCIAL_PLANNING', 'GENERAL_SERVICES_CONSULTING_AND_LEGAL'],
      ],
      ['BUSINESS_AND_SERVICES_SHIPPING', 'Shipping & handling', ['GENERAL_SERVICES_POSTAGE_AND_SHIPPING']],
    ],
  },
  {
    // Cash withdrawals and app transfers stay transfers, so nothing maps here
    // on its own; these are for filing a known cash spend by hand.
    code: 'CASH_AND_ATM',
    label: 'Cash & ATM',
    from: [],
    subs: [
      ['CASH_AND_ATM_CASH', 'Cash & cheques', []],
      ['CASH_AND_ATM_PAYMENT_APPS', 'Online payment services', []],
    ],
  },
  {
    code: 'CHARITY_AND_GIFTS',
    label: 'Charity & gifts',
    from: [],
    subs: [
      ['CHARITY_AND_GIFTS_CHARITY', 'Charity', ['GOVERNMENT_AND_NON_PROFIT_DONATIONS']],
      ['CHARITY_AND_GIFTS_GIFTS', 'Gifts', ['GENERAL_MERCHANDISE_GIFTS_AND_NOVELTIES']],
    ],
  },
  {
    code: 'EDUCATION',
    label: 'Education',
    from: [],
    subs: [['EDUCATION_TUITION', 'Tuition & learning', ['GENERAL_SERVICES_EDUCATION']]],
  },
  {
    code: 'ENTERTAINMENT',
    label: 'Entertainment',
    from: ['ENTERTAINMENT', 'ENTERTAINMENT_OTHER_ENTERTAINMENT', 'ENTERTAINMENT_CASINOS_AND_GAMBLING'],
    subs: [
      [
        'ENTERTAINMENT_EVENTS',
        'Concerts, sports, events & attractions',
        ['ENTERTAINMENT_SPORTING_EVENTS_AMUSEMENT_PARKS_AND_MUSEUMS'],
      ],
      ['ENTERTAINMENT_FUN_MONEY', 'Fun money', []],
      [
        'ENTERTAINMENT_MEDIA',
        'Movies, music, books & games',
        [
          'ENTERTAINMENT_TV_AND_MOVIES',
          'ENTERTAINMENT_MUSIC_AND_AUDIO',
          'ENTERTAINMENT_VIDEO_GAMES',
          'GENERAL_MERCHANDISE_BOOKSTORES_AND_NEWSSTANDS',
        ],
      ],
      ['ENTERTAINMENT_STREAMING', 'Streaming & subscriptions', []],
    ],
  },
  {
    code: 'FAMILY_CARE',
    label: 'Family care',
    from: [],
    subs: [
      ['FAMILY_CARE_ACTIVITIES', 'Activities & lessons', ['KIDS_ENTERTAINMENT']],
      ['FAMILY_CARE_SUPPORT', 'Alimony & child support', []],
      ['FAMILY_CARE_ALLOWANCE', 'Allowance & pocket money', []],
      ['FAMILY_CARE_CHILDCARE', 'Childcare & daycare', ['GENERAL_SERVICES_CHILDCARE']],
      ['FAMILY_CARE_KIDS', 'Children’s clothing, supplies & toys', []],
    ],
  },
  {
    code: 'FEES_AND_CHARGES',
    label: 'Fees & charges',
    from: [],
    subs: [
      [
        'FEES_AND_CHARGES_BANK',
        'Bank & service fees',
        [
          'BANK_FEES',
          'BANK_FEES_ATM_FEES',
          'BANK_FEES_FOREIGN_TRANSACTION_FEES',
          'BANK_FEES_INSUFFICIENT_FUNDS',
          'BANK_FEES_OVERDRAFT_FEES',
          'BANK_FEES_OTHER_BANK_FEES',
        ],
      ],
      ['FEES_AND_CHARGES_FINANCE', 'Finance charges', ['BANK_FEES_INTEREST_CHARGE', 'BANK_FEES_CASH_ADVANCE']],
    ],
  },
  {
    code: 'FOOD',
    label: 'Food',
    from: ['FOOD_AND_DRINK', 'FOOD_AND_DRINK_OTHER_FOOD_AND_DRINK'],
    subs: [
      ['FOOD_ALCOHOL', 'Alcoholic beverages', ['FOOD_AND_DRINK_BEER_WINE_AND_LIQUOR']],
      ['FOOD_GROCERIES', 'Groceries', ['FOOD_AND_DRINK_GROCERIES']],
      [
        'FOOD_DINING',
        'Restaurants, convenience & coffee',
        [
          'FOOD_AND_DRINK_RESTAURANT',
          'FOOD_AND_DRINK_FAST_FOOD',
          'FOOD_AND_DRINK_COFFEE',
          'FOOD_AND_DRINK_VENDING_MACHINES',
          'GENERAL_MERCHANDISE_CONVENIENCE_STORES',
        ],
      ],
    ],
  },
  {
    code: 'HOME',
    label: 'Home',
    from: [],
    subs: [
      ['HOME_APPLIANCES', 'Appliances', []],
      ['HOME_CONDO_FEES', 'Condo fees', []],
      ['HOME_FURNISHINGS', 'Furniture, decor & supplies', ['HOME_IMPROVEMENT_FURNITURE']],
      // Produced by the corrector from Plaid's mortgage payment (lib/category.ts),
      // not mapped from a code here: see countsAsMortgageSpend.
      ['HOME_MORTGAGE', 'Mortgage', []],
      [
        'HOME_MAINTENANCE',
        'Home improvement & maintenance',
        [
          'HOME_IMPROVEMENT',
          'HOME_IMPROVEMENT_HARDWARE',
          'HOME_IMPROVEMENT_REPAIR_AND_MAINTENANCE',
          'HOME_IMPROVEMENT_OTHER_HOME_IMPROVEMENT',
        ],
      ],
      ['HOME_SERVICES', 'Household services (cleaning & lawn care)', []],
      ['HOME_RENT', 'Rent', ['RENT', 'RENT_AND_UTILITIES_RENT']],
      ['HOME_STORAGE', 'Storage unit', ['GENERAL_SERVICES_STORAGE']],
    ],
  },
  {
    // Plaid says "insurance" and never which kind, so a bank row lands on the
    // parent and the kinds are there to be chosen per merchant.
    code: 'INSURANCE',
    label: 'Insurance premiums',
    from: ['GENERAL_SERVICES_INSURANCE'],
    subs: [
      ['INSURANCE_HEALTH', 'Health, dental & vision insurance', []],
      ['INSURANCE_HOME', 'Home insurance', []],
      ['INSURANCE_LIFE', 'Life insurance', []],
      ['INSURANCE_LONG_TERM_CARE', 'Long-term care insurance', []],
      ['INSURANCE_VEHICLE', 'Vehicle insurance', []],
    ],
  },
  {
    code: 'MEDICAL',
    label: 'Medical',
    from: ['MEDICAL', 'MEDICAL_OTHER_MEDICAL'],
    subs: [
      ['MEDICAL_DENTAL', 'Dental', ['MEDICAL_DENTAL_CARE']],
      ['MEDICAL_DEVICES', 'Devices & equipment', []],
      ['MEDICAL_DOCTORS', 'Doctors & hospitals', ['MEDICAL_PRIMARY_CARE', 'MEDICAL_NURSING_CARE']],
      ['MEDICAL_PHARMACY', 'Pharmacy', ['MEDICAL_PHARMACIES_AND_SUPPLEMENTS']],
      ['MEDICAL_VISION', 'Vision', ['MEDICAL_EYE_CARE']],
      ['MEDICAL_WELLNESS', 'Wellness & therapy', []],
    ],
  },
  {
    code: 'PERSONAL_CARE',
    label: 'Personal care',
    from: ['PERSONAL_CARE', 'PERSONAL_CARE_OTHER_PERSONAL_CARE'],
    subs: [
      ['PERSONAL_CARE_LAUNDRY', 'Dry cleaning & laundry', ['PERSONAL_CARE_LAUNDRY_AND_DRY_CLEANING']],
      [
        'PERSONAL_CARE_FITNESS',
        'Gym & sports equipment',
        ['PERSONAL_CARE_GYMS_AND_FITNESS_CENTERS', 'GENERAL_MERCHANDISE_SPORTING_GOODS'],
      ],
      ['PERSONAL_CARE_PRODUCTS', 'Products & supplements', []],
      ['PERSONAL_CARE_SERVICES', 'Services (hair, nails, beauty)', ['PERSONAL_CARE_HAIR_AND_BEAUTY']],
      ['PERSONAL_CARE_SPA', 'Spa & massage', []],
    ],
  },
  {
    code: 'PETS',
    label: 'Pets',
    from: [],
    subs: [
      ['PETS_SUPPLIES', 'Food & supplies', ['GENERAL_MERCHANDISE_PET_SUPPLIES']],
      ['PETS_GROOMING', 'Grooming', []],
      ['PETS_VETERINARY', 'Veterinary', ['MEDICAL_VETERINARY_SERVICES']],
    ],
  },
  {
    code: 'SHOPPING',
    label: 'Shopping',
    from: [],
    subs: [
      ['SHOPPING_CLOTHING', 'Clothing & accessories', ['GENERAL_MERCHANDISE_CLOTHING_AND_ACCESSORIES']],
      ['SHOPPING_ELECTRONICS', 'Electronics & software', ['GENERAL_MERCHANDISE_ELECTRONICS']],
      [
        'SHOPPING_GENERAL',
        'General merchandise',
        [
          'GENERAL_MERCHANDISE',
          'GENERAL_MERCHANDISE_DEPARTMENT_STORES',
          'GENERAL_MERCHANDISE_DISCOUNT_STORES',
          'GENERAL_MERCHANDISE_ONLINE_MARKETPLACES',
          'GENERAL_MERCHANDISE_SUPERSTORES',
          'GENERAL_MERCHANDISE_OFFICE_SUPPLIES',
          'GENERAL_MERCHANDISE_TOBACCO_AND_VAPE',
          'GENERAL_MERCHANDISE_OTHER_GENERAL_MERCHANDISE',
        ],
      ],
    ],
  },
  {
    code: 'TAXES',
    label: 'Taxes',
    from: ['GOVERNMENT_AND_NON_PROFIT_TAX_PAYMENT'],
    subs: [
      [
        'TAXES_GOVERNMENT_FEES',
        'Government fees & licences',
        [
          'GOVERNMENT_AND_NON_PROFIT',
          'GOVERNMENT_AND_NON_PROFIT_GOVERNMENT_DEPARTMENTS_AND_AGENCIES',
          'GOVERNMENT_AND_NON_PROFIT_OTHER_GOVERNMENT_AND_NON_PROFIT',
        ],
      ],
      ['TAXES_INCOME', 'Income tax', []],
      ['TAXES_PREPARATION', 'Tax preparation', []],
      ['TAXES_PROPERTY', 'Property tax', []],
    ],
  },
  {
    code: 'TRAVEL_AND_VACATION',
    label: 'Travel & vacation',
    from: ['TRAVEL', 'TRAVEL_OTHER_TRAVEL'],
    subs: [
      ['TRAVEL_AND_VACATION_CRUISES', 'Cruises', []],
      ['TRAVEL_AND_VACATION_TRANSPORT', 'Flights, trains & buses', ['TRAVEL_FLIGHTS']],
      ['TRAVEL_AND_VACATION_LODGING', 'Lodging', ['TRAVEL_LODGING']],
      ['TRAVEL_AND_VACATION_AGENCIES', 'Travel agencies', []],
    ],
  },
];

/** The grouped parents, for familyOf. */
export const GROUPED_PARENTS: readonly string[] = TAXONOMY.map((p) => p.code);

/** Every grouped category, parents first, for a picker in grouped mode. */
export const GROUPED_CATEGORIES: readonly string[] = TAXONOMY.flatMap((p) => [p.code, ...p.subs.map(([c]) => c)]);

/** Each grouped category's parent, for the consistency test. */
export const GROUPED_PARENT_OF: ReadonlyMap<string, string> = new Map(
  TAXONOMY.flatMap((p) => [[p.code, p.code] as const, ...p.subs.map(([c]) => [c, p.code] as const)]),
);

const LABELS = new Map<string, string>(
  TAXONOMY.flatMap((p) => [[p.code, p.label] as const, ...p.subs.map(([c, l]) => [c, l] as const)]),
);

/**
 * Plaid code → grouped code. A Plaid code listed twice would quietly go to
 * whichever entry came last, so that is refused when the module loads.
 */
export const FROM_PLAID: ReadonlyMap<string, string> = (() => {
  const map = new Map<string, string>();
  const add = (src: string, code: string): void => {
    if (map.has(src)) throw new Error(`taxonomy: ${src} is mapped twice`);
    map.set(src, code);
  };
  for (const p of TAXONOMY) {
    for (const src of p.from) add(src, p.code);
    for (const [code, , from] of p.subs) for (const src of from) add(src, code);
  }
  return map;
})();

export function groupedLabel(code: string): string | undefined {
  return LABELS.get(code);
}

/**
 * The grouped category for a category read from the bank or set by hand.
 * Only codes this table knows are moved: a hand-made category, an income or
 * transfer code, or a Plaid code published after this list was written stays
 * as it is, rather than being guessed into a group.
 */
export function toGrouped(category: string | null): string | null {
  if (!category) return category;
  return FROM_PLAID.get(category) ?? category;
}
