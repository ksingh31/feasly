/**
 * Address-query normalisation tests (#701) — table-driven.
 *
 * The City stores "[UNIT ]HOUSE STREET TYPE QUADRANT" ("1412 PROSPECT AV SW",
 * "101 1107 17 AV SW"); every reasonable spelling must land on that key.
 */
import { describe, expect, it } from 'vitest';
import { normalizeAddressQuery } from '../src/lib/address-query';

describe('normalizeAddressQuery', () => {
  describe('issue #701 table', () => {
    it.each([
      ['1412 Prospect Avenue SW', '1412 PROSPECT AV SW', 'address'],
      ['1412 Prospect Av Southwest', '1412 PROSPECT AV SW', 'address'],
      ['1412 Prospect Av S.W.', '1412 PROSPECT AV SW', 'address'],
      ['1412 Prospect Av South West', '1412 PROSPECT AV SW', 'address'],
      ['1412 Prospect Av S W', '1412 PROSPECT AV SW', 'address'],
      ['prospect av', 'PROSPECT AV', 'no_house_number'],
      ['#201 1234 17 Ave SW', '201 1234 17 AV SW', 'unit'],
      ['201-1234 17 Ave SW', '201 1234 17 AV SW', 'unit'],
      ['201 - 1234 17 Ave SW', '201 1234 17 AV SW', 'unit'],
      ['Unit 201 1234 17 Ave SW', '201 1234 17 AV SW', 'unit'],
      ['Suite #201, 1234 17 Ave SW', '201 1234 17 AV SW', 'unit'],
      ['Apt 3B 1234 17 Ave SW', '3B 1234 17 AV SW', 'unit'],
      ['1234 17 Ave SW #201', '201 1234 17 AV SW', 'unit'],
      ['1234 17 Ave SW, Unit 201', '201 1234 17 AV SW', 'unit'],
    ])('"%s" → "%s" (%s)', (input, search, kind) => {
      const parsed = normalizeAddressQuery(input);
      expect(parsed.search).toBe(search);
      expect(parsed.kind).toBe(kind);
    });

    it.each(['T2T 0X5', 't2t0x5', 'T2T 0X5, Calgary, AB'])(
      '"%s" is a postal code with no searchable key',
      (input) => {
        expect(normalizeAddressQuery(input)).toEqual({
          search: '',
          kind: 'postal_code',
          houseNumber: null,
          streetName: null,
          unit: null,
          postalFsa: 'T2T',
        });
      },
    );
  });

  describe('more normalisation', () => {
    it.each([
      ['1234 17th Ave SW', '1234 17 AV SW'],
      ['1234 1st St NW', '1234 1 ST NW'],
      ['1234 22nd St NW', '1234 22 ST NW'],
      ['1234 3rd Ave Northeast', '1234 3 AV NE'],
      ['  1412   prospect   avenue   sw  ', '1412 PROSPECT AV SW'],
      ['1412 Prospect Ave. S.W., Calgary, AB', '1412 PROSPECT AV SW'],
      ['1412 Prospect Ave SW, Calgary, Alberta', '1412 PROSPECT AV SW'],
      ['1412 Prospect Av SW, Calgary, AB T2T 0X5', '1412 PROSPECT AV SW'],
      ['2 66 Beny-Sur-Mer Road SW', '2 66 BENY-SUR-MER RD SW'],
      ['1412 Prospect Av NORTHWEST', '1412 PROSPECT AV NW'],
    ])('"%s" → "%s"', (input, search) => {
      expect(normalizeAddressQuery(input).search).toBe(search);
    });

    it('splits house number and street name of the building (unit excluded)', () => {
      expect(normalizeAddressQuery('#201 1234 17th Ave SW')).toMatchObject({
        unit: '201',
        houseNumber: '1234',
        streetName: '17',
      });
      expect(normalizeAddressQuery('1412 Prospect')).toMatchObject({
        houseNumber: '1412',
        streetName: 'PROSPECT',
      });
      expect(normalizeAddressQuery('1412 Prospect St SW')).toMatchObject({
        houseNumber: '1412',
        streetName: 'PROSPECT',
      });
    });

    it('has no street name for a bare house number', () => {
      expect(normalizeAddressQuery('1412')).toMatchObject({
        houseNumber: '1412',
        streetName: null,
        kind: 'address',
      });
    });

    it('drops LIKE wildcards and SoQL-hostile punctuation', () => {
      expect(normalizeAddressQuery('1412 Pro%spect_ Av; SW').search).toBe('1412 PRO SPECT AV SW');
    });
  });

  describe('regression — inputs that worked before #701 keep their key', () => {
    it.each([
      ['1600 90 Ave SW', '1600 90 AV SW'],
      ['2631 63 av sw, calgary, ab', '2631 63 AV SW'],
      ['2631 63 av sw calgary ab', '2631 63 AV SW'],
      ['2631 63 av sw, calgary', '2631 63 AV SW'],
      ['100 calgary trail nw', '100 CALGARY TR NW'],
      ['2631 63', '2631 63'],
      ['1412 PROSPECT AV SW', '1412 PROSPECT AV SW'],
      ['101 1107 17 AV SW', '101 1107 17 AV SW'],
      ['1600 90 Avenue', '1600 90 AV'],
      ['Calgary, AB', ''],
    ])('"%s" → "%s"', (input, search) => {
      expect(normalizeAddressQuery(input).search).toBe(search);
    });
  });
});
