/**
 * A second, fictional city (issue #687 AC6): adding a city is a data file +
 * config, with no resolver change. Also exercises `maxUnitsOnLot`, an
 * unverified density, two versions, and an alias.
 */
import type { ZoningRulesVersion } from '@feasly/contracts';

export const TESTVILLE_2025_01_01: ZoningRulesVersion = {
  city: 'testville',
  effectiveDate: '2025-01-01',
  bylaw: 'Testville Zoning Bylaw 1-2025',
  bylawVersion: 'Original text',
  sourceUrl: 'https://testville.example/zoning',
  districts: [
    {
      code: 'TV-R1',
      name: 'Testville Residential 1',
      category: 'low-density',
      coverage: 'covered',
      forms: [{ form: 'single-detached', permission: 'permitted', section: '§ 1', verified: true }],
      rules: { maxDensityUnitsPerHa: { value: 20, section: '§ 2', verified: true } },
    },
  ],
};

export const TESTVILLE_2026_06_01: ZoningRulesVersion = {
  city: 'testville',
  effectiveDate: '2026-06-01',
  bylaw: 'Testville Zoning Bylaw 1-2025',
  bylawVersion: 'As amended by 7-2026',
  sourceUrl: 'https://testville.example/zoning',
  districts: [
    {
      code: 'TV-R1',
      name: 'Testville Residential 1',
      category: 'low-density',
      coverage: 'covered',
      aliases: ['R1'],
      forms: [
        { form: 'single-detached', permission: 'permitted', section: '§ 1', verified: true },
        { form: 'backyard-suite', permission: 'discretionary', section: '§ 1(b)', verified: true },
      ],
      rules: {
        maxDensityUnitsPerHa: { value: 60, section: '§ 2', verified: true },
        maxUnitsOnLot: { value: 4, section: '§ 3', verified: true },
      },
    },
    {
      code: 'TV-R2',
      name: 'Testville Residential 2',
      category: 'grade-oriented',
      coverage: 'covered',
      forms: [{ form: 'rowhouse', permission: 'permitted', section: '§ 4', verified: true }],
      rules: { maxDensityUnitsPerHa: { value: 90, section: '§ 5', verified: false } },
    },
  ],
};
