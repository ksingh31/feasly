/**
 * Calgary zoning rules catalogue — rules in effect from 2026-08-04 (issue #687).
 *
 * On 2026-08-04 the City's repeal of citywide rezoning (Bylaw 21P2024) took
 * effect and parcels returned to their pre-2024 districts. Sections below
 * were read from Land Use Bylaw 1P2007 as consolidated before the
 * 2024-08-06 amendment (the text the repeal restored), published by the City
 * at the `sourceUrl` page.
 *
 * Owner decision (2026-11-15): every value carries its section; the catalogue
 * is shown as "typically allowed, confirm with the City" with a link to the
 * source; Karan or the pilot builder spot-checks once before launch; #757
 * keeps it current.
 *
 * `verified: true` = read from that section of the bylaw text above.
 * `verified: false` = draft (e.g. a reported amendment whose text we have
 * not checked) — the resolver drops it, so it is never shown.
 *
 * Data only: no logic, no dollar figures. Adding a city = a new file like
 * this one registered in `../catalogues.ts`, plus `ZONING_CITY` config.
 */
import type {
  BuildingForm,
  FormPermission,
  ZoningDistrictSource,
  ZoningFormSource,
  ZoningRuleSource,
  ZoningRulesVersion,
} from '@feasly/contracts';

function form(
  f: BuildingForm,
  permission: FormPermission,
  section: string,
  verified = true,
  note?: string,
): ZoningFormSource {
  return note === undefined
    ? { form: f, permission, section, verified }
    : { form: f, permission, section, verified, note };
}

function rule(
  value: number,
  section: string,
  verified = true,
  note?: string,
): ZoningRuleSource {
  return note === undefined ? { value, section, verified } : { value, section, verified, note };
}

const CONTEXTUAL_HEIGHT =
  'Greater of 8.6 m or the contextual height plus 1.5 m, up to 10.0 m.';
const PARKING_COVERAGE =
  'Reduced by 21 m² for each required parking stall not in a private garage.';

/** Districts outside what Feasly describes. Named so the live-code test passes. */
function notCovered(
  code: string,
  name: string,
  category: ZoningDistrictSource['category'],
): ZoningDistrictSource {
  return {
    code,
    name,
    category,
    coverage: 'not-covered',
    forms: [],
    rules: {},
  };
}

// ── Low density: contextual one dwelling family (Part 5, Divisions 2–4) ──

const RC1L_FORMS: readonly ZoningFormSource[] = [
  form('single-detached', 'permitted', 's. 367(b)'),
  form('secondary-suite', 'discretionary', 's. 368(e.1)'),
  form('backyard-suite', 'discretionary', 's. 368(a)'),
];
const RC1L_RULES = {
  maxHeightM: rule(10, 's. 381', true, CONTEXTUAL_HEIGHT),
  maxLotCoveragePct: rule(40, 's. 375', true, PARKING_COVERAGE),
};

const RC1_FORMS: readonly ZoningFormSource[] = [
  form('single-detached', 'permitted', 's. 385(1)(b)'),
  form('secondary-suite', 'discretionary', 's. 386(1)(h.1)'),
  form('backyard-suite', 'discretionary', 's. 386(1)(a.2)'),
];
const RC1_RULES = {
  maxHeightM: rule(10, 's. 399', true, CONTEXTUAL_HEIGHT),
  maxLotCoveragePct: rule(45, 's. 393', true, PARKING_COVERAGE),
};

// ── Low density: one dwelling family (Part 5, Divisions 6–7) ──

const R1_FORMS: readonly ZoningFormSource[] = [
  form('single-detached', 'permitted', 's. 445(f)'),
  form('secondary-suite', 'discretionary', 's. 446(h.1)'),
  form('backyard-suite', 'discretionary', 's. 446(a.2)'),
];
const R1_RULES = {
  maxHeightM: rule(
    12,
    's. 458',
    true,
    '11.0 m where the parcel is under 400 m² or narrower than 15 m.',
  ),
  maxLotCoveragePct: rule(45, 's. 453', true, PARKING_COVERAGE),
};

// ── R-CG family (Part 5, Division 11) ──

const RCG_BASE_FORMS: readonly ZoningFormSource[] = [
  form('single-detached', 'discretionary', 's. 527(2)(r)'),
  form('semi-detached', 'permitted', 's. 526(1)(b)', true, 'Contextual semi-detached.'),
  form('duplex', 'discretionary', 's. 527(2)(h)'),
  form(
    'rowhouse',
    'permitted',
    's. 526(2)',
    true,
    'Discretionary where the rowhouse does not meet every district rule (s. 527(1)).',
  ),
  form('townhouse', 'discretionary', 's. 527(2)(s.1)'),
];
const RCG_RULES = {
  maxDensityUnitsPerHa: rule(75, 's. 529'),
  // City-reported post-repeal amendments (April 2026 Council decision):
  // height 11 m → 10 m and coverage 60% → 55%. Amended text not yet
  // checked, so these stay unverified and are never shown.
  maxHeightM: rule(10, 's. 541', false, 'Reported amendment 11.0 m → 10.0 m; text unchecked.'),
  maxLotCoveragePct: rule(
    55,
    's. 534',
    false,
    'Reported amendment 60% → 55%; text unchecked. Varies with density.',
  ),
};

// ── R-G family (Part 5, Division 12) ──

const RG_RULES = {
  maxHeightM: rule(12, 's. 547.13(1)'),
  maxLotCoveragePct: rule(
    60,
    's. 547.8(1)',
    true,
    'Higher on some laned parcels (s. 547.8(2)). ' + PARKING_COVERAGE,
  ),
};

// ── Multi-residential (Part 6) ──

function multiResidential(
  code: string,
  name: string,
  multiForm: ZoningFormSource,
  rules: ZoningDistrictSource['rules'] = {},
): ZoningDistrictSource {
  return {
    code,
    name,
    category: 'multi-residential',
    coverage: 'covered',
    forms: [multiForm],
    rules,
    note: 'Apartment-style and multi-unit buildings. Feasly does not estimate these.',
  };
}

const DENSITY_MODIFIER_NOTE =
  'A density modifier on the parcel (e.g. "d100") replaces this value.';

const DISTRICTS: readonly ZoningDistrictSource[] = [
  // Contextual one dwelling
  {
    code: 'R-C1L',
    name: 'Residential – Contextual Large Parcel One Dwelling',
    category: 'low-density',
    coverage: 'covered',
    forms: RC1L_FORMS,
    rules: RC1L_RULES,
  },
  {
    code: 'R-C1Ls',
    name: 'Residential – Contextual Large Parcel One Dwelling (secondary suite)',
    category: 'low-density',
    coverage: 'covered',
    forms: [
      form('single-detached', 'permitted', 's. 367(b)'),
      form('secondary-suite', 'permitted', 's. 369(1)(a)'),
      form('backyard-suite', 'discretionary', 's. 368(a)'),
    ],
    rules: RC1L_RULES,
  },
  {
    code: 'R-C1',
    name: 'Residential – Contextual One Dwelling',
    category: 'low-density',
    coverage: 'covered',
    aliases: ['RC-1', 'RC1'],
    forms: RC1_FORMS,
    rules: RC1_RULES,
  },
  {
    code: 'R-C1s',
    name: 'Residential – Contextual One Dwelling (secondary suite)',
    category: 'low-density',
    coverage: 'covered',
    aliases: ['RC-1s', 'RC1s'],
    forms: [
      form('single-detached', 'permitted', 's. 385(1)(b)'),
      form('secondary-suite', 'permitted', 's. 387(1)(a)'),
      form('backyard-suite', 'discretionary', 's. 386(1)(a.2)'),
    ],
    rules: RC1_RULES,
  },
  {
    code: 'R-C1N',
    name: 'Residential – Contextual Narrow Parcel One Dwelling',
    category: 'low-density',
    coverage: 'covered',
    forms: [
      form('single-detached', 'permitted', 's. 405(b)'),
      form('secondary-suite', 'discretionary', 's. 406(h.1)'),
      form('backyard-suite', 'discretionary', 's. 406(a.2)'),
    ],
    rules: {
      maxHeightM: rule(10, 's. 418', true, CONTEXTUAL_HEIGHT),
      maxLotCoveragePct: rule(
        45,
        's. 412',
        true,
        'Up to 50% on some narrow parcels (s. 412(2)). ' + PARKING_COVERAGE,
      ),
    },
  },
  {
    code: 'R-C2',
    name: 'Residential – Contextual One / Two Dwelling',
    category: 'low-density',
    coverage: 'covered',
    aliases: ['RC-2', 'RC2'],
    forms: [
      form('single-detached', 'permitted', 's. 425(1)(b)'),
      form('semi-detached', 'permitted', 's. 425(1)(a.1)', true, 'Contextual semi-detached.'),
      form('duplex', 'discretionary', 's. 426(1)(e)'),
      form('secondary-suite', 'permitted', 's. 425(1)(f.1)'),
      form('backyard-suite', 'discretionary', 's. 426(1)(a.2)'),
    ],
    rules: {
      maxHeightM: rule(10, 's. 438', true, CONTEXTUAL_HEIGHT),
      maxLotCoveragePct: rule(45, 's. 432', true, PARKING_COVERAGE),
    },
  },
  // One dwelling (developing areas)
  {
    code: 'R-1',
    name: 'Residential – One Dwelling',
    category: 'low-density',
    coverage: 'covered',
    forms: R1_FORMS,
    rules: R1_RULES,
  },
  {
    code: 'R-1s',
    name: 'Residential – One Dwelling (secondary suite)',
    category: 'low-density',
    coverage: 'covered',
    forms: [
      form('single-detached', 'permitted', 's. 445(f)'),
      form('secondary-suite', 'permitted', 's. 447(1)(a)'),
      form('backyard-suite', 'discretionary', 's. 446(a.2)'),
    ],
    rules: R1_RULES,
  },
  {
    code: 'R-1N',
    name: 'Residential – Narrow Parcel One Dwelling',
    category: 'low-density',
    coverage: 'covered',
    forms: [
      form('single-detached', 'permitted', 's. 460(f)'),
      form('secondary-suite', 'discretionary', 's. 461(h.1)'),
      form('backyard-suite', 'discretionary', 's. 461(a.2)'),
    ],
    rules: {
      maxHeightM: rule(
        10,
        's. 472',
        true,
        '11.0 m on larger parcels at least 10 m wide (s. 472(2)).',
      ),
      maxLotCoveragePct: rule(
        50,
        's. 467',
        true,
        '60% on small narrow parcels; 45% on parcels wider than 11 m. ' + PARKING_COVERAGE,
      ),
    },
  },
  {
    code: 'R-2',
    name: 'Residential – One / Two Dwelling',
    category: 'low-density',
    coverage: 'covered',
    forms: [
      form('single-detached', 'permitted', 's. 475(h)'),
      form('semi-detached', 'permitted', 's. 475(f)'),
      form('duplex', 'permitted', 's. 475(b)'),
      form('secondary-suite', 'permitted', 's. 475(e.1)'),
      form('backyard-suite', 'discretionary', 's. 476(a.2)'),
    ],
    rules: {
      maxHeightM: rule(
        10,
        's. 487',
        true,
        '11.0 m for semi-detached and duplex homes, and some single-detached homes.',
      ),
      maxLotCoveragePct: rule(
        45,
        's. 482',
        true,
        '50% for semi-detached and duplex homes. ' + PARKING_COVERAGE,
      ),
    },
  },
  {
    code: 'R-2M',
    name: 'Residential – Low Density Multiple Dwelling',
    category: 'low-density',
    coverage: 'covered',
    forms: [
      form('single-detached', 'discretionary', 's. 491(2)(m)'),
      form('semi-detached', 'permitted', 's. 490.1(c)', true, 'Where it is the only main building.'),
      form('duplex', 'permitted', 's. 490.1(a)', true, 'Where it is the only main building.'),
      form('rowhouse', 'permitted', 's. 490(f)'),
      form('townhouse', 'discretionary', 's. 491(2)(o)'),
      form('secondary-suite', 'permitted', 's. 490.1(b)', true, 'Where there is one main building.'),
      form('backyard-suite', 'discretionary', 's. 491(2)(a.2)'),
    ],
    rules: {
      maxHeightM: rule(11, 's. 502'),
      maxLotCoveragePct: rule(
        60,
        's. 497',
        true,
        'For rowhouses and townhouses; 45% single-detached, 50% semi-detached or duplex.',
      ),
      maxDensityUnitsPerHa: rule(
        50,
        's. 493',
        true,
        'Rowhouses; townhouses not all facing a street are capped at 38 units/ha.',
      ),
    },
  },
  {
    code: 'R-MH',
    name: 'Residential – Manufactured Home',
    category: 'low-density',
    coverage: 'not-covered',
    forms: [],
    rules: {},
    note: 'Manufactured homes and parks. Feasly does not estimate these.',
  },
  // Grade-oriented
  {
    code: 'R-CG',
    name: 'Residential – Grade-Oriented Infill',
    category: 'grade-oriented',
    coverage: 'covered',
    aliases: ['RC-G'],
    forms: [
      ...RCG_BASE_FORMS,
      form('secondary-suite', 'permitted', 's. 526(1)(g)'),
      form('backyard-suite', 'discretionary', 's. 527(2)(c)'),
    ],
    rules: RCG_RULES,
  },
  {
    code: 'R-CGex',
    name: 'Residential – Grade-Oriented Infill (excluding suites)',
    category: 'grade-oriented',
    coverage: 'covered',
    // #911 (owner decision 2026-11-15): the single-detached entry here is
    // borrowed from R-CG (s. 527(2)(r)), not cited from R-CGex's own text, so
    // it stays a draft: hidden from the panel and not quotable until a cited
    // R-CGex section is added (tracked on the #757 stale-catalogue review).
    forms: RCG_BASE_FORMS.map((f) =>
      f.form === 'single-detached'
        ? { ...f, verified: false, note: 'Needs a cited R-CGex section (#911, #757).' }
        : f,
    ),
    rules: RCG_RULES,
    note: 'Secondary and backyard suites are excluded (s. 527.1).',
  },
  {
    code: 'R-G',
    name: 'Residential – Low Density Mixed Housing',
    category: 'low-density',
    coverage: 'covered',
    forms: [
      form('single-detached', 'permitted', 's. 547.1(l)'),
      form('semi-detached', 'permitted', 's. 547.1(j)'),
      form('duplex', 'permitted', 's. 547.1(c)'),
      form('rowhouse', 'permitted', 's. 547.1(h)'),
      form('secondary-suite', 'permitted', 's. 547.1(i)'),
      form('backyard-suite', 'permitted', 's. 547.1(b)'),
    ],
    rules: RG_RULES,
  },
  {
    code: 'R-Gm',
    name: 'Residential – Low Density Mixed Housing (attached housing)',
    category: 'low-density',
    coverage: 'covered',
    forms: [
      form('single-detached', 'discretionary', 's. 547.3(2)(a)'),
      form('semi-detached', 'permitted', 's. 547.1(j)'),
      form('duplex', 'permitted', 's. 547.1(c)'),
      form('rowhouse', 'permitted', 's. 547.1(h)'),
      form('secondary-suite', 'permitted', 's. 547.1(i)'),
      form('backyard-suite', 'permitted', 's. 547.1(b)'),
    ],
    rules: RG_RULES,
  },
  {
    code: 'H-GO',
    name: 'Housing – Grade Oriented',
    category: 'grade-oriented',
    coverage: 'covered',
    forms: [
      // Owner decision (#898, 2026-11-15): s. 1387 lists the generic use
      // "Dwelling Unit", which covers a single dwelling; keeps the catalogue
      // in step with the estimator's eligibility list (Karan, 2026-10-02).
      form(
        'single-detached',
        'permitted',
        's. 1387(b)',
        true,
        'Listed as the generic use "Dwelling Unit" rather than by name; typically allowed, confirm with the City.',
      ),
      form(
        'rowhouse',
        'permitted',
        's. 1387(b)',
        true,
        'The district permits dwelling units with direct access to grade (s. 1391).',
      ),
      form(
        'townhouse',
        'permitted',
        's. 1387(b)',
        true,
        'The district permits dwelling units with direct access to grade (s. 1391).',
      ),
      form('secondary-suite', 'permitted', 's. 1387(g)'),
    ],
    rules: {
      maxHeightM: rule(12, 's. 1399(1)', true, 'Lower next to low-density parcels (s. 1399(2)).'),
      maxLotCoveragePct: rule(
        60,
        's. 1392(1)',
        true,
        '45% to 60% depending on density. ' + PARKING_COVERAGE,
      ),
    },
  },
  // Multi-residential (not priced by Feasly)
  multiResidential(
    'M-CG',
    'Multi-Residential – Contextual Grade-Oriented',
    form('multi-residential', 'discretionary', 's. 578(1)(i)'),
    { maxDensityUnitsPerHa: rule(111, 's. 580(1)', true, DENSITY_MODIFIER_NOTE) },
  ),
  multiResidential(
    'M-C1',
    'Multi-Residential – Contextual Low Profile',
    form('multi-residential', 'discretionary', 's. 588(1)(j)'),
    { maxDensityUnitsPerHa: rule(148, 's. 590(1)', true, DENSITY_MODIFIER_NOTE) },
  ),
  multiResidential(
    'M-C2',
    'Multi-Residential – Contextual Medium Profile',
    form('multi-residential', 'discretionary', 's. 597(1)(j)'),
  ),
  multiResidential(
    'M-G',
    'Multi-Residential – At Grade Housing',
    form('multi-residential', 'permitted', 's. 606(c)', true, 'Minor developments; larger ones are discretionary (s. 607(g)).'),
  ),
  multiResidential(
    'M-1',
    'Multi-Residential – Low Profile',
    form('multi-residential', 'permitted', 's. 617(c)', true, 'Minor developments; larger ones are discretionary (s. 618(h)).'),
  ),
  multiResidential(
    'M-2',
    'Multi-Residential – Medium Profile',
    form('multi-residential', 'permitted', 's. 626(c)', true, 'Minor developments; larger ones are discretionary (s. 627(h)).'),
  ),
  multiResidential(
    'M-H1',
    'Multi-Residential – High Density Low Rise',
    form('multi-residential', 'discretionary', 's. 637(1)(k)'),
  ),
  multiResidential(
    'M-H2',
    'Multi-Residential – High Density Medium Rise',
    form('multi-residential', 'discretionary', 's. 648(l)'),
  ),
  multiResidential(
    'M-H3',
    'Multi-Residential – High Density High Rise',
    form('multi-residential', 'discretionary', 's. 659(l)'),
  ),
  multiResidential(
    'M-X1',
    'Multi-Residential – Low Profile Support Commercial',
    form('multi-residential', 'discretionary', 's. 670(1)(k)'),
  ),
  multiResidential(
    'M-X2',
    'Multi-Residential – Medium Profile Support Commercial',
    form('multi-residential', 'discretionary', 's. 680(1)(k)'),
  ),
  // Direct Control
  {
    code: 'DC',
    name: 'Direct Control',
    category: 'direct-control',
    coverage: 'site-specific',
    forms: [],
    rules: {},
    note: 'Site-specific rules. See the Direct Control bylaw for this parcel.',
  },
  // Mixed use and centre city (residential possible, not described here)
  notCovered('MU-1', 'Mixed Use – General', 'mixed-use'),
  notCovered('MU-2', 'Mixed Use – Active Frontage', 'mixed-use'),
  notCovered('CC-MH', 'Centre City Multi-Residential High Rise', 'mixed-use'),
  notCovered('CC-MHX', 'Centre City Multi-Residential High Rise Support Commercial', 'mixed-use'),
  notCovered('CC-X', 'Centre City Mixed Use', 'mixed-use'),
  notCovered('CC-COR', 'Centre City Commercial Corridor', 'mixed-use'),
  notCovered('CC-ET', 'Centre City East Village Transition', 'mixed-use'),
  notCovered('CC-EIR', 'Centre City East Village Integrated Residential', 'mixed-use'),
  notCovered('CC-EMU', 'Centre City East Village Mixed Use', 'mixed-use'),
  notCovered('CC-EPR', 'Centre City East Village Primarily Residential', 'mixed-use'),
  notCovered('CC-ERR', 'Centre City East Village River Residential', 'mixed-use'),
  notCovered('CC-ER', 'Centre City East Village Recreational', 'non-residential'),
  notCovered('CR20-C20/R20', 'Commercial Residential', 'mixed-use'),
  // Commercial
  notCovered('C-N1', 'Commercial – Neighbourhood 1', 'non-residential'),
  notCovered('C-N2', 'Commercial – Neighbourhood 2', 'non-residential'),
  notCovered('C-C1', 'Commercial – Community 1', 'non-residential'),
  notCovered('C-C2', 'Commercial – Community 2', 'non-residential'),
  notCovered('C-COR1', 'Commercial – Corridor 1', 'non-residential'),
  notCovered('C-COR2', 'Commercial – Corridor 2', 'non-residential'),
  notCovered('C-COR3', 'Commercial – Corridor 3', 'non-residential'),
  notCovered('C-O', 'Commercial – Office', 'non-residential'),
  notCovered('C-R1', 'Commercial – Regional 1', 'non-residential'),
  notCovered('C-R2', 'Commercial – Regional 2', 'non-residential'),
  notCovered('C-R3', 'Commercial – Regional 3', 'non-residential'),
  // Industrial
  notCovered('I-G', 'Industrial – General', 'non-residential'),
  notCovered('I-B', 'Industrial – Business', 'non-residential'),
  notCovered('I-E', 'Industrial – Edge', 'non-residential'),
  notCovered('I-C', 'Industrial – Commercial', 'non-residential'),
  notCovered('I-R', 'Industrial – Redevelopment', 'non-residential'),
  notCovered('I-O', 'Industrial – Outdoor', 'non-residential'),
  notCovered('I-H', 'Industrial – Heavy', 'non-residential'),
  // Special purpose
  notCovered('S-UN', 'Special Purpose – Urban Nature', 'non-residential'),
  notCovered('S-SPR', 'Special Purpose – School, Park and Community Reserve', 'non-residential'),
  notCovered('S-CS', 'Special Purpose – Community Service', 'non-residential'),
  notCovered('S-R', 'Special Purpose – Recreation', 'non-residential'),
  notCovered('S-CI', 'Special Purpose – Community Institution', 'non-residential'),
  notCovered('S-CRI', 'Special Purpose – City and Regional Infrastructure', 'non-residential'),
  notCovered('S-URP', 'Special Purpose – University Research Park', 'non-residential'),
  notCovered('S-FUD', 'Special Purpose – Future Urban Development', 'non-residential'),
  notCovered('S-TUC', 'Special Purpose – Transportation and Utility Corridor', 'non-residential'),
  // Other
  notCovered('RF', 'Ranch and Farm', 'non-residential'),
  notCovered('ANRI', 'Agricultural and Natural Resource Industry (M.D. of Rocky View)', 'non-residential'),
];

export const CALGARY_2026_08_04: ZoningRulesVersion = {
  city: 'calgary',
  effectiveDate: '2026-08-04',
  bylaw: 'Land Use Bylaw 1P2007',
  bylawVersion:
    'Text as restored by the repeal of citywide rezoning (in effect 2026-08-04); ' +
    'sections read from the City consolidation before the 2024-08-06 amendment.',
  sourceUrl:
    'https://www.calgary.ca/pda/pd/calgary-land-use-bylaw-1p2007/calgary-land-use-bylaw-1p2007.html',
  districts: DISTRICTS,
};
