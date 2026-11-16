import type { HelpCopy } from '../../core/config/app-config';

/**
 * Default `/help` page copy (#834). Lazy-loaded with the help page (provided
 * as HELP_COPY by the component) so the initial bundle doesn't carry it
 * (Lighthouse script-size budget). Deploy-time overrides live in
 * `/assets/config/app-config.json` under `copy.marketing.help` and are merged
 * over these defaults by provideHelpCopy().
 */
export const DEFAULT_HELP_COPY: HelpCopy = {
  eyebrow: 'Help',
  title: 'Help and contact',
  answer:
    'Feasly gives Calgary homeowners a planning range for building a new home: the City-assessed value of the lot plus a build-cost range from one fixed formula. Search the answers below by topic (estimates, zoning, assessed value, privacy, builders), or request a callback from your report to talk it through.',
  searchLabel: 'Search help answers',
  searchPlaceholder: 'Try “zoning” or “privacy”',
  resultsTemplate: '{count} answers match your search.',
  resultsOne: '1 answer matches your search.',
  noResults: 'No answers match your search. Try a shorter word, or request a callback below.',
  clearSearch: 'Clear search',
  topics: [
    {
      id: 'estimates',
      title: 'Estimates',
      answers: [
        { source: 'faq', q: 'How much does it cost to build a house in Calgary?' },
        { source: 'pillarGuide', q: 'What drives the cost up or down the most?' },
        { source: 'faq', q: 'What is the difference between Standard, Premium, and Luxury finishes?' },
        { source: 'faq', q: 'How accurate are the estimates?' },
        { source: 'faq', q: 'Can Feasly estimate my renovation?' },
        { source: 'faq', q: 'How long does it take to build a home in Calgary?' },
        { source: 'faq', q: 'Is Feasly free?' },
        { source: 'faq', q: 'Do you support addresses outside Calgary?' },
      ],
    },
    {
      id: 'zoning',
      title: 'Zoning',
      answers: [
        { source: 'zoningGuide', q: 'What does R-C1 mean?' },
        { source: 'zoningGuide', q: 'My lot is R-CG — can I still build a single-family home?' },
        { source: 'zoningGuide', q: 'What is Direct Control (DC) zoning?' },
        { source: 'zoningGuide', q: "How do I find my property's zoning?" },
        { source: 'zoningGuide', q: 'Can zoning change?' },
      ],
    },
    {
      id: 'assessed-value',
      title: 'Assessed value',
      answers: [
        { source: 'faq', q: 'What data do you use for my estimate?' },
        { source: 'pillarGuide', q: 'Is land included in the estimate?' },
        { source: 'communities', q: 'What is the difference between assessed value and sale price?' },
      ],
    },
    {
      id: 'privacy',
      title: 'Privacy',
      answers: [
        { source: 'faq', q: 'Who sees my information?' },
        { source: 'faq', q: 'How does the magic link work?' },
      ],
    },
    {
      id: 'builders',
      title: 'Builders',
      answers: [
        { source: 'faq', q: 'Is Feasly a home builder? Will you recommend one?' },
        { source: 'faq', q: 'How do builder introductions work?' },
      ],
    },
  ],
  linksTitle: 'More about how Feasly works',
  howWeEstimateLabel: 'How we estimate',
  faqLabel: 'Frequently asked questions',
  statusLabel: 'Service status',
  contactTitle: 'Contact us',
  contactIntro: 'Want to talk your estimate through with someone? Ask for a call at a time that suits you.',
  callbackTitle: 'Request a callback',
  callbackBody:
    'Callbacks are booked from your report, so whoever calls has your estimate in front of them. Open your report and use the callback form to pick a day and time window. No report yet? Get an estimate first; it takes about two minutes.',
  callbackFindReport: 'Find my report',
  callbackStartEstimate: 'Get an estimate',
};
