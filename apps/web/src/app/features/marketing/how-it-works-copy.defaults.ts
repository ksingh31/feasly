import type { HowItWorksCopy } from '../../core/config/app-config';

/**
 * Compiled how-it-works page copy defaults (#980), split out of DEFAULT_APP_CONFIG so
 * they ship in the lazy chunk that renders them instead of the initial
 * bundle (Lighthouse script budget). Same rules as app-config.defaults.ts:
 * every value mirrors `public/assets/config/app-config.json`, whose
 * overrides are merged over these defaults by mergeLazyCopy().
 * Allowlisted in tools/hardcode-allowlist.txt.
 */
export const DEFAULT_HOW_IT_WORKS_COPY: HowItWorksCopy = {
  eyebrow: 'How it works',
  title: 'From address to estimate in about 2 minutes',
  sub: 'Just your address and a few project details. We may reach out about your estimate — opt out anytime.',
  steps: [
    {
      n: '01',
      title: 'Enter your Calgary address',
      body: 'We pull your City of Calgary property record — lot size, zoning, and assessed land value. Only Calgary addresses are supported right now.',
    },
    {
      n: '02',
      title: 'Configure your scope',
      body: 'Tell us about the project: living area, finish tier, garage, and basement. Rough figures are fine — you can adjust them later. Renovation estimates are coming soon.',
    },
    {
      n: '03',
      title: 'Preview your estimate',
      body: 'See a blurred preview of your build-cost range before you share anything. No email required to look.',
    },
    {
      n: '04',
      title: 'Get your full report',
      body: 'Enter your email and your full report opens immediately: total investment, cost breakdown, and next steps. We also email you a link to reopen it anytime — valid for 7 days.',
    },
  ],
  mathNoteTitle: 'Real math, not guesses',
  mathNoteBody:
    'Every dollar figure in your estimate is produced by a fixed formula from current cost data and your City property record. Our AI writes the narrative summary only — it never invents prices. Figures are planning ranges, not quotes or appraisals: your final cost depends on your builder, finishes, and market conditions.',
  ctaNewBuild: 'Start a new-build estimate →',
  ctaReno: 'Renovation estimates — coming soon',
  zoningCardTitle: 'Why we ask about your address',
  zoningCardBody:
    'Your address tells us your lot\u2019s City land use designation \u2014 the zoning code that decides what can be built there. We quote single-family homes in every residential zone where a single-detached house is allowed (our zoning guide lists them), so if your lot is zoned for apartments, shops, or industry, we\u2019ll say so plainly instead of inventing a number.',
  zoningCardCta: 'Learn about Calgary zoning →',
  answer:
    'Feasly prices your build with one fixed formula: hard costs + soft costs + contingency = your build range. The inputs are your City of Calgary property record and versioned cost data. The same inputs always give the same range, and our AI never sets a price. Your total investment is that build range plus the City-assessed value of your lot.',
  formulaTitle: 'The formula behind every estimate',
  formulaIntro:
    'Each estimate adds up three parts. Every line item below is one row in your cost breakdown, listed straight from the cost model.',
  formulaGroups: {
    hard: {
      title: 'Hard costs',
      body: 'The physical build: materials and labour, priced from your home\u2019s size, your lot, and the finish level you pick.',
    },
    soft: {
      title: 'Soft costs',
      body: 'The paperwork and professionals that come before and around the build, priced as a share of the hard costs.',
    },
    contingency: {
      title: 'Contingency',
      body: 'A buffer for the surprises every custom build runs into, priced as a share of hard and soft costs together.',
    },
  },
  formulaPlus: '+',
  formulaEquals: '=',
  formulaSentence: 'Hard costs plus soft costs plus contingency equals your build range.',
  formulaResultTitle: 'Your build range',
  formulaResultBody:
    'A low and a high figure, not a single number. Add your lot\u2019s City-assessed value and you get your total investment.',
  lineItemNotes: {
    'hard.envelope': 'Roof, exterior walls, siding, windows and exterior doors that keep the weather out.',
    'hard.finishes': 'Flooring, cabinets, counters, trim, paint, fixtures and the other things you see and touch inside.',
    'hard.foundation': 'Footings, foundation walls and the basement slab.',
    'hard.framing': 'The structural frame: walls, floors, roof framing and sheathing.',
    'hard.mep': 'Heating and ventilation, electrical, plumbing and the fixtures they connect to.',
    'hard.sitePrep': 'Clearing and excavating the lot and getting it ready for the foundation. Scales with lot size.',
    'soft.design': 'Architectural drawings, structural engineering and the other design work a permit needs.',
    'soft.permits': 'City development and building permits and their fees.',
    contingency: 'Money set aside for the unexpected, such as soil conditions or a price change mid-build.',
  },
  whyRangeTitle: 'Why you get a range, not a single number',
  whyRangeIntro:
    'Two homes of the same size can cost very different amounts. A range shows where your project is likely to land before the decisions that move it are made.',
  whyRangeItems: [
    {
      title: 'Finish level',
      body: 'The materials and details you choose, from practical Standard to high-end Luxury, are the biggest swing in what you pay.',
    },
    {
      title: 'Lot conditions',
      body: 'Soil, slope, access, trees and existing services can make site work and foundations simpler or harder than usual.',
    },
    {
      title: 'Market movement',
      body: 'Material and labour prices change over the months between your estimate and your build.',
    },
  ],
  sourcesTitle: 'Where the data comes from',
  sourcesIntro: 'Each estimate draws on these sources. The date on each one shows when it was last updated.',
  sources: {
    assessment: {
      title: 'City of Calgary property assessment roll',
      body: 'Your lot size and the City-assessed value of your lot come from the City\u2019s open property assessment data.',
      linkLabel: 'City of Calgary property assessment data',
      stampTemplate: 'Updated {date}',
      stampUnknown: 'Read live from the City\u2019s open data',
    },
    landUse: {
      title: 'Calgary land use districts',
      body: 'Your lot\u2019s zoning decides whether we can estimate a single-family home there. Our district rules are read from the City\u2019s Land Use Bylaw.',
      linkLabel: 'City of Calgary Land Use Bylaw',
      stampTemplate: 'Rules as of {date}',
      stampUnknown: 'Rules from the current Land Use Bylaw',
    },
    costData: {
      title: 'Feasly cost data',
      body: 'The rates behind every line item live in one versioned cost-data table. Each estimate records the version it used, so it can be reproduced later.',
      linkLabel: '',
      stampTemplate: 'Version {version}',
      stampUnknown: 'Current version',
    },
  },
  exampleTitle: 'A worked example',
  exampleIntro: 'A sample {sqft} sq ft home, {tier} finish, on a {lot} sq ft lot. These figures come from the same cost model as your estimate.',
  exampleTierNames: { standard: 'Standard', premium: 'Premium', luxury: 'Luxury' },
  exampleCaption: 'Build cost for the sample home, by line item',
  exampleColItem: 'Line item',
  exampleColRange: 'Range',
  exampleSubtotals: {
    hard: 'Hard costs',
    soft: 'Soft costs',
    contingency: 'Contingency',
  },
  exampleTotal: 'Build range',
  exampleRangeTemplate: '{low} – {high}',
  exampleNote:
    'This sample home is fictional and has no lot value. Your estimate adds your lot\u2019s City-assessed value to the build range to give your total investment.',
  exampleVersion: 'Priced with cost data {version}.',
  currentTitle: 'How we keep it current',
  currentItems: [
    'Your property record is read from the City\u2019s open data when you search, and our community figures are refreshed from City data every month.',
    'We watch the City\u2019s land use rules and update our district list when they change.',
    'We review our cost data against real quotes from Calgary builders and publish each change as a new version.',
  ],
  nextTitle: 'What happens after your estimate',
  nextSteps: [
    {
      title: 'Your estimate',
      body: 'Your report opens right away and a link to it lands in your inbox.',
    },
    {
      title: 'A builder gets in touch',
      body: 'A builder partner may call or email you within 3\u20135 business days to talk through your project. You can opt out anytime.',
    },
    {
      title: 'Site visit',
      body: 'The builder walks your lot to see the conditions a desktop estimate can\u2019t.',
    },
    {
      title: 'Your quote',
      body: 'The builder prices your actual plans and selections in a written quote.',
    },
  ],
  linksTitle: 'Keep reading',
  links: [
    { label: 'Frequently asked questions', route: '/faq' },
    { label: 'See a sample report', route: '/sample-report', flag: 'sampleReport' },
    { label: 'How much does it cost to build a house in Calgary?', route: '/guides/cost-to-build-a-house-calgary' },
    { label: 'Find my report', route: '/my-report' },
  ],
};
