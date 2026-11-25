import type {
  CommunityLivingResponse,
  CommunitySchoolDesignationsResponse,
  School,
  SchoolsListResponse,
} from '@feasly/contracts';
import { TYPICALLY_DESIGNATED } from '@feasly/contracts';

/**
 * Contract-shaped community-guide fixtures for the mock API (#781). Sample
 * names only — never presented as real schools or places. Covers every
 * school type the Schools tab filters on, a school with and one without a
 * Fraser score, and a school with no published figures at all.
 */
const REFRESHED_AT = '2026-11-01T00:00:00.000Z';
const BOARDS = [
  { board: 'cbe', name: 'Calgary Board of Education', lookupUrl: 'https://cbe.ab.ca/schools/find-a-school' },
  { board: 'ccsd', name: 'Calgary Catholic School District', lookupUrl: 'https://www.cssd.ab.ca/schools' },
] as const;

function mockSchool(partial: Partial<School> & Pick<School, 'id' | 'name' | 'type'>): School {
  return {
    board: null,
    authority: null,
    grades: null,
    programs: [],
    address: null,
    postalCode: null,
    lat: null,
    lng: null,
    website: null,
    tuition: false,
    communityCode: 'MOK',
    communityName: 'MOCK',
    sources: {},
    ratings: { fraser: null, provincialResults: null, enrolment: null },
    reviews: null,
    refreshedAt: REFRESHED_AT,
    ...partial,
  };
}

const REVIEWS = (name: string) => ({
  kind: 'link' as const,
  provider: 'google-maps',
  label: 'Google reviews',
  url: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(name)}`,
});

export function mockCommunitySchoolDesignations(slug: string): CommunitySchoolDesignationsResponse {
  return {
    communityCode: 'MOK',
    communityName: 'MOCK',
    slug,
    label: TYPICALLY_DESIGNATED,
    designations: [
      {
        board: 'cbe',
        boardName: BOARDS[0].name,
        gradeBand: 'K-6',
        schoolName: 'Sample Elementary School',
        label: TYPICALLY_DESIGNATED,
        lookupUrl: BOARDS[0].lookupUrl,
        refreshedAt: REFRESHED_AT,
      },
      {
        board: 'ccsd',
        boardName: BOARDS[1].name,
        gradeBand: 'K-9',
        schoolName: 'Sample Catholic School',
        label: TYPICALLY_DESIGNATED,
        lookupUrl: BOARDS[1].lookupUrl,
        refreshedAt: REFRESHED_AT,
      },
    ],
    boards: BOARDS.map((b) => ({ ...b })),
    disclaimer: 'Designations can vary by address and change year to year — confirm with the board.',
  };
}

export function mockCommunitySchools(communityCode: string): SchoolsListResponse {
  const schools: School[] = [
    mockSchool({
      id: 'mock-cbe-1',
      name: 'Sample Elementary School',
      type: 'public_cbe',
      board: 'Calgary Board of Education',
      grades: 'Elementary',
      programs: ['french-immersion'],
      communityCode,
      ratings: {
        fraser: { score: 7.1, year: '2025', attribution: 'Fraser Institute — School Report Cards', sourceUrl: 'https://www.compareschoolrankings.org' },
        provincialResults: {
          schoolYear: '2024-25',
          tests: [{ test: 'pat6', acceptableStandardPct: 78, excellenceStandardPct: 21 }],
          attribution: 'Alberta Education — Provincial Achievement Tests',
          sourceUrl: 'https://www.alberta.ca/provincial-achievement-tests',
        },
        enrolment: {
          schoolYear: '2025-26',
          enrolment: 412,
          capacity: 500,
          utilizationPct: 82,
          attribution: 'Calgary Board of Education — enrolment report',
          sourceUrl: 'https://cbe.ab.ca',
        },
      },
      reviews: REVIEWS('Sample Elementary School'),
    }),
    mockSchool({
      id: 'mock-ccsd-1',
      name: 'Sample Catholic School',
      type: 'catholic_ccsd',
      board: 'Calgary Catholic School District',
      grades: 'Elementary/Junior High',
      communityCode,
      reviews: REVIEWS('Sample Catholic School'),
    }),
    mockSchool({
      id: 'mock-charter-1',
      name: 'Sample Charter Academy',
      type: 'charter',
      board: 'Sample Charter Society',
      grades: 'Junior High',
      programs: ['stem'],
      communityCode,
    }),
    mockSchool({
      id: 'mock-private-1',
      name: 'Sample Private High School',
      type: 'private',
      board: 'Sample Independent School Society',
      grades: 'High School',
      tuition: true,
      communityCode,
    }),
  ];
  return {
    schools,
    attributions: [
      {
        id: 'calgary-open-data',
        label: 'City of Calgary Open Data',
        licence: 'Open Government Licence – City of Calgary',
        url: 'https://data.calgary.ca',
      },
    ],
    disclaimer: 'School details change — confirm with the school or board.',
  };
}

export function mockCommunityLiving(slug: string): CommunityLivingResponse {
  return {
    communityCode: 'MOK',
    name: 'MOCK',
    slug,
    distanceBasis: 'straight-line',
    searchRadiusM: 3000,
    amenities: [
      {
        category: 'parks',
        label: 'Parks',
        nearest: { name: 'Sample Park', distanceM: 240 },
        counts: [
          { radiusM: 500, count: 3 },
          { radiusM: 1000, count: 9 },
        ],
      },
      {
        category: 'groceries',
        label: 'Groceries',
        nearest: { name: 'Sample Market', distanceM: 1350 },
        counts: [
          { radiusM: 500, count: 0 },
          { radiusM: 1000, count: 0 },
        ],
      },
      { category: 'golf', label: 'Golf', nearest: null, counts: [
        { radiusM: 500, count: 0 },
        { radiusM: 1000, count: 0 },
      ] },
    ],
    treeCover: { publicTrees: 2100, areaHa: 120, treesPerHa: 17.5, level: 'moderate' },
    dataRefreshedAt: REFRESHED_AT,
  };
}
