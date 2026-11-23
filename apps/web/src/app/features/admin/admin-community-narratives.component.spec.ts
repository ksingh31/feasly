/**
 * Admin Community narratives panel (#915): status chips per row, KPI
 * counts, per-row and run-for-all "Regenerate now", returned counts, and
 * the deferred explanation for a run-for-all.
 */
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { provideStore } from '@ngxs/store';
import { NEVER, of } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  AdminCommunityNarrativeEntry,
  AdminCommunityNarrativeRegenerateResponse,
} from '@feasly/contracts';
import { AdminCommunityNarrativesComponent } from './admin-community-narratives.component';
import { AdminOpsApiService } from './admin-ops-api.service';
import { CommunityNarrativesState } from './community-narratives.state';

const ROWS: AdminCommunityNarrativeEntry[] = [
  {
    community_slug: 'altadore',
    community_name: 'Altadore',
    period: '2026-11',
    status: 'succeeded',
    generated_at: '2026-11-02T09:00:00.000Z',
    attempts: 1,
    last_error: null,
  },
  {
    community_slug: 'killarney',
    community_name: 'Killarney',
    period: '2026-11',
    status: 'failed',
    generated_at: '2026-10-02T09:00:00.000Z',
    attempts: 3,
    last_error: 'Provider timed out.',
  },
  {
    community_slug: 'bridgeland',
    community_name: 'Bridgeland',
    period: null,
    status: 'missing',
    generated_at: null,
    attempts: 0,
    last_error: null,
  },
];

async function setup(regenerate: unknown = NEVER, rows: AdminCommunityNarrativeEntry[] | null = ROWS) {
  TestBed.resetTestingModule();
  const api = {
    getCommunityNarratives: vi.fn().mockReturnValue(rows ? of({ communities: rows }) : NEVER),
    regenerateCommunityNarratives: vi.fn().mockReturnValue(regenerate),
  };
  TestBed.configureTestingModule({
    imports: [AdminCommunityNarrativesComponent],
    providers: [
      provideRouter([]),
      provideStore([CommunityNarrativesState]),
      { provide: AdminOpsApiService, useValue: api },
    ],
  });
  const fixture: ComponentFixture<AdminCommunityNarrativesComponent> =
    TestBed.createComponent(AdminCommunityNarrativesComponent);
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
  return { fixture, api, el: fixture.nativeElement as HTMLElement };
}

async function click(fixture: ComponentFixture<unknown>, selector: string) {
  const el = fixture.nativeElement as HTMLElement;
  const button = el.querySelector<HTMLButtonElement>(selector);
  expect(button, selector).not.toBeNull();
  button!.click();
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
}

function result(overrides: Partial<AdminCommunityNarrativeRegenerateResponse>) {
  return {
    scope: 'one',
    period: '2026-11',
    attempted: 1,
    succeeded: 1,
    failed: 0,
    deferred: 0,
    ...overrides,
  } as AdminCommunityNarrativeRegenerateResponse;
}

describe('AdminCommunityNarrativesComponent (#915)', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('lists every community with a status label, last error and KPI counts', async () => {
    const { el } = await setup();
    expect(el.querySelector('h1')?.textContent?.trim()).toBe('Community narratives');
    const text = el.textContent ?? '';
    for (const name of ['Altadore', 'Killarney', 'Bridgeland']) expect(text).toContain(name);
    expect(text).toContain('Up to date');
    expect(text).toContain('Failed');
    expect(text).toContain('Never generated');
    expect(text).toContain('Provider timed out.');
    // Raw enum values never reach the UI.
    expect(text).not.toContain('succeeded');
    expect(text).not.toContain('missing');
  });

  it('shows a skeleton while the first load is in flight', async () => {
    const { el } = await setup(NEVER, null);
    expect(el.querySelector('ui-skeleton')).not.toBeNull();
    expect(el.querySelector('[data-testid="regenerate-all"]')).toBeNull();
  });

  it('regenerates one community and shows the returned counts', async () => {
    const { fixture, api, el } = await setup(of(result({})));
    await click(fixture, '[data-testid="regenerate-killarney"]');
    expect(api.regenerateCommunityNarratives).toHaveBeenCalledWith({ community_slug: 'killarney' });
    const notice = el.querySelector('[data-testid="regenerate-result"]')?.textContent ?? '';
    expect(notice).toContain('for Killarney');
    expect(notice).toContain('1 attempted');
    expect(notice).toContain('1 succeeded');
    expect(notice).toContain('0 failed');
    expect(el.querySelector('[data-testid="regenerate-deferred"]')).toBeNull();
  });

  it('regenerates all and explains that deferred communities finish on the next daily run', async () => {
    const { fixture, api, el } = await setup(
      of(result({ scope: 'all', attempted: 40, succeeded: 39, failed: 1, deferred: 12 })),
    );
    await click(fixture, '[data-testid="regenerate-all"]');
    expect(api.regenerateCommunityNarratives).toHaveBeenCalledWith({});
    const notice = el.querySelector('[data-testid="regenerate-result"]')?.textContent ?? '';
    expect(notice).toContain('for all communities');
    expect(notice).toContain('40 attempted');
    const deferred = el.querySelector('[data-testid="regenerate-deferred"]')?.textContent ?? '';
    expect(deferred).toContain('12');
    expect(deferred).toContain('next daily run');
  });

  it('disables every regenerate button while one is running', async () => {
    const { fixture, el } = await setup(NEVER);
    await click(fixture, '[data-testid="regenerate-altadore"]');
    const buttons = Array.from(
      el.querySelectorAll<HTMLButtonElement>('[data-testid^="regenerate-"]'),
    );
    expect(buttons.length).toBeGreaterThan(1);
    for (const b of buttons) expect(b.disabled).toBe(true);
  });
});
