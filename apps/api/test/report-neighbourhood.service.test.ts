/**
 * #785: report email neighbourhood summary — built from the stored school
 * designations (#775) and community living metrics (#777), best-effort,
 * and threaded into the consumer report email.
 */
import { describe, expect, it, vi } from 'vitest';
import type { AddressSchoolDesignationsResponse } from '@feasly/contracts';
import { createReportNeighbourhoodService } from '../src/services/report-neighbourhood.service';
import type { CommunityLivingMetrics } from '../src/services/neighbourhood-data/neighbourhood-read.service';
import { sendOwnerMagicLinkEmail } from '../src/services/magic-link.service';
import type { EmailService, MagicLinkEmailInput } from '../src/services/email';
import type { UnsubscribeService } from '../src/services/unsubscribe.service';

const DESIGNATIONS: AddressSchoolDesignationsResponse = {
  addressKey: '1 TEST ST SW',
  communityCode: 'ALT',
  communityName: 'Altadore',
  slug: 'altadore',
  label: 'typically designated',
  designations: [
    {
      board: 'cbe',
      boardName: 'Calgary Board of Education',
      gradeBand: 'K-6',
      schoolName: 'Altadore School',
      label: 'typically designated',
      lookupUrl: 'https://cbe.example/lookup',
      refreshedAt: '2026-11-01T00:00:00.000Z',
    },
  ],
  boards: [
    { board: 'cbe', name: 'Calgary Board of Education', lookupUrl: 'https://cbe.example/lookup' },
    { board: 'ccsd', name: 'Calgary Catholic School District', lookupUrl: 'https://ccsd.example/lookup' },
  ],
  disclaimer: 'Confirm with the board.',
};

const LIVING: CommunityLivingMetrics = {
  communityCode: 'ALT',
  name: 'Altadore',
  slug: 'altadore',
  searchRadiusM: 2_000,
  amenities: [
    { category: 'parks', label: 'Parks', nearest: { name: 'River Park', distanceM: 340 }, counts: [] },
    { category: 'pools', label: 'Pools', nearest: null, counts: [] },
  ],
  treeCover: { publicTrees: 4_000, areaHa: 220, treesPerHa: 18.2, level: 'high' },
  dataRefreshedAt: '2026-11-01T00:00:00.000Z',
  metrics: {},
};

function service(over: {
  designations?: Partial<AddressSchoolDesignationsResponse>;
  living?: Partial<CommunityLivingMetrics>;
  failDesignations?: boolean;
} = {}) {
  const forAddress = vi.fn(async () => {
    if (over.failDesignations) throw new Error('boom');
    return { ...DESIGNATIONS, ...over.designations };
  });
  const getCommunityLivingMetrics = vi.fn(async () => ({ ...LIVING, ...over.living }));
  const warn = vi.fn();
  return {
    svc: createReportNeighbourhoodService({
      designations: { forAddress },
      neighbourhood: { getCommunityLivingMetrics },
      logWarning: warn,
    }),
    forAddress,
    getCommunityLivingMetrics,
    warn,
  };
}

describe('report neighbourhood summary (#785)', () => {
  it('maps designations, lookups, amenities with a nearest one, and tree cover', async () => {
    const { svc, getCommunityLivingMetrics } = service();
    const summary = await svc.forAddress('1 TEST ST SW');
    expect(getCommunityLivingMetrics).toHaveBeenCalledWith('altadore');
    expect(summary).toEqual({
      communityName: 'Altadore',
      schools: [{ boardName: 'Calgary Board of Education', gradeBand: 'K-6', schoolName: 'Altadore School' }],
      boardLookups: [
        { name: 'Calgary Board of Education', lookupUrl: 'https://cbe.example/lookup' },
        { name: 'Calgary Catholic School District', lookupUrl: 'https://ccsd.example/lookup' },
      ],
      amenities: [{ label: 'Parks', nearestName: 'River Park', distanceM: 340 }],
      treeCover: { level: 'high', treesPerHa: 18.2 },
    });
  });

  it('skips the living read when the address has no covered community', async () => {
    const { svc, getCommunityLivingMetrics } = service({
      designations: { designations: [], slug: null, communityCode: null, communityName: null },
    });
    expect(await svc.forAddress('1 TEST ST SW')).toBeUndefined();
    expect(getCommunityLivingMetrics).not.toHaveBeenCalled();
  });

  it('is undefined when nothing is on file (no empty sections)', async () => {
    const { svc } = service({
      designations: { designations: [] },
      living: { amenities: [], treeCover: null },
    });
    expect(await svc.forAddress('1 TEST ST SW')).toBeUndefined();
  });

  it('never throws: a failed read yields undefined and a sanitized warning', async () => {
    const { svc, warn } = service({ failDesignations: true });
    expect(await svc.forAddress('1 TEST ST SW')).toBeUndefined();
    expect(warn).toHaveBeenCalledWith('report-neighbourhood: summary unavailable (Error)');
  });
});

describe('report email send threads the summary (#785)', () => {
  function sendArgs(neighbourhood?: { forAddress: (k: string) => Promise<unknown> }) {
    const sent: MagicLinkEmailInput[] = [];
    const email = {
      sendMagicLink: async (input: MagicLinkEmailInput) => {
        sent.push(input);
        return { sent: true };
      },
    } as unknown as EmailService;
    const unsubscribe = {
      buildUnsubscribeUrl: () => 'https://app.example/unsubscribe?t=x',
    } as unknown as UnsubscribeService;
    return {
      sent,
      args: {
        email,
        unsubscribe,
        leadId: 'lead-1',
        to: 'a@b.example',
        appBaseUrl: 'https://app.example',
        magicLinkTtlSeconds: 86_400,
        token: 'tok',
        addressKey: '1 TEST ST SW',
        ...(neighbourhood ? { neighbourhood: neighbourhood as never } : {}),
      },
    };
  }

  it('passes the loaded summary to the email', async () => {
    const { svc } = service();
    const { sent, args } = sendArgs(svc);
    await sendOwnerMagicLinkEmail(args);
    expect(sent[0]?.neighbourhood?.schools[0]?.schoolName).toBe('Altadore School');
  });

  it('still sends (without the sections) when the loader rejects', async () => {
    const { sent, args } = sendArgs({ forAddress: () => Promise.reject(new Error('x')) });
    await sendOwnerMagicLinkEmail(args);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.neighbourhood).toBeUndefined();
  });
});
