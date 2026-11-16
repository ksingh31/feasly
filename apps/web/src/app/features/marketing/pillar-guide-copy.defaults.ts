import type { PillarGuideCopy } from '../../core/config/app-config';

/**
 * Compiled pillar guide copy defaults (#980), split out of DEFAULT_APP_CONFIG so
 * they ship in the lazy chunk that renders them instead of the initial
 * bundle (Lighthouse script budget). Same rules as app-config.defaults.ts:
 * every value mirrors `public/assets/config/app-config.json`, whose
 * overrides are merged over these defaults by mergeLazyCopy().
 * Allowlisted in tools/hardcode-allowlist.txt.
 */
export const DEFAULT_PILLAR_GUIDE_COPY: PillarGuideCopy = {
  eyebrow: 'Calgary build-cost guide',
  title: 'How much does it cost to build a house in Calgary?',
  lede: 'For a typical 2,400 sq ft new build, most Calgary projects budget roughly $1.2M–$2.1M all-in including land. The build itself usually lands between $195 and $541 per square foot depending on finish tier — and your lot’s assessed land value swings the total more than anything else.',
  tiersTitle: 'Cost per square foot by finish tier',
  tiersIntro:
    'Build cost before land, for a typical 2,400 sq ft home, from our current cost model. These are planning ranges to budget with — your builder’s quote is what counts.',
  tiers: [
    {
      name: 'Standard',
      range: '$195–$293 per sq ft',
      blurb: 'Practical, durable finishes — the sensible default for a family home.',
    },
    {
      name: 'Premium',
      range: '$262–$391 per sq ft',
      blurb: 'Upgraded selections throughout — nicer kitchens, baths, and detailing.',
    },
    {
      name: 'Luxury',
      range: '$360–$541 per sq ft',
      blurb: 'High-end specifications — custom millwork, stone, and top-tier mechanical.',
    },
  ],
  exampleTitle: 'What that looks like for a 2,400 sq ft home',
  exampleBody:
    'At 2,400 square feet — a common size for a Calgary infill — the build itself budgets roughly $468,000–$703,000 at Standard tier, $629,000–$938,000 at Premium, and $864,000–$1,298,000 at Luxury. Land sits on top: the City-assessed value varies a lot by neighbourhood — each community guide shows its own average.',
  includedTitle: 'What’s included in the estimate',
  includedBody:
    'Each build range adds up the line items below, straight from Feasly’s cost model.',
  excludedTitle: 'What’s not included',
  excludedBody:
    'The cost model doesn’t price these yet, so budget for them separately with your builder.',
  infillTitle: 'Infill vs greenfield: why the lot changes the math',
  infillBody:
    'On an infill lot — a teardown in an established neighbourhood — expect demolition costs and sometimes servicing upgrades, in exchange for a known neighbourhood and no new-suburb premiums. On a greenfield lot in a new community, the developer sets the land price and servicing is brand new. Either way, build cost per square foot follows the same tiers above; it is the land line that moves.',
  financingTitle: 'How people usually pay for a build',
  financingBody:
    'Most custom builds use a construction loan: the lender releases money in draws as work is completed, and you typically pay interest only until the home is done and the loan converts to a regular mortgage. Talk to a mortgage broker early — they will tell you what you qualify for before you fall in love with a floor plan. Feasly does not offer financing or recommend lenders.',
  faqTitle: 'Common questions',
  faqs: [
    {
      q: 'How much does it cost to build a house in Calgary?',
      a: 'For a typical 2,400 sq ft home, budget roughly $1.2M–$2.1M all-in including land. The build itself runs $195–$541 per square foot depending on finish tier, and land is the City-assessed value, which varies widely by community. Run a free estimate with your address for the range on your lot.',
    },
    {
      q: 'What drives the cost up or down the most?',
      a: 'Three things: your lot’s land value, the size of the home, and the finish tier. Land value swings the total more than anything else in Calgary — the same house can budget hundreds of thousands apart in different neighbourhoods.',
    },
    {
      q: 'Is land included in the estimate?',
      a: 'Yes — Feasly adds your lot’s City-assessed land value to the build cost, so the total is the full investment. Browse our community cost guides to see how land values differ across Calgary.',
    },
    {
      q: 'Are these numbers quotes?',
      a: 'No — they are planning ranges to budget with before you talk to builders. Your final cost depends on your builder, your finish choices, and market conditions at build time. Bring your Feasly range to builders and ask them to explain any big difference.',
    },
    {
      q: 'How long does it take to build a house in Calgary?',
      a: 'A custom infill home in Calgary typically takes 12–16 months from design through permits to completion. Your report shows the typical range for each phase, from design and permits to construction. Your builder, permits, and site conditions set the actual schedule. Buying a pre-sale or move-in-ready home follows a different timeline.',
    },
    {
      q: 'Which Calgary communities cost the least to build in?',
      a: 'Land value drives the all-in number, so communities with lower assessed land values budget lower overall. Our community cost guides show average assessed values and build ranges for Calgary neighbourhoods — start there to compare.',
    },
  ],
  mathNoteTitle: 'Real math, not guesses',
  mathNoteBody:
    'Every dollar figure on this page comes from the same fixed cost model behind our estimator: current construction cost data plus City of Calgary property records. Figures are planning ranges, not quotes. Your final cost depends on your builder, finishes, and market conditions.',
  ctaEstimate: 'Get my free estimate →',
  ctaCommunities: 'Browse community cost guides',
};
