/**
 * Builder Settings state (#871): profile load/save, embed load, and
 * origin-change requests. Failures land in state (inline errors), never
 * thrown; a duplicate open request is surfaced as such.
 */
import { TestBed } from '@angular/core/testing';
import { Store, provideStore } from '@ngxs/store';
import { of, throwError } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  BuilderEmbedResponse,
  BuilderNotificationPreferencesResponse,
  BuilderOriginRequest,
  BuilderProfileResponse,
} from '@feasly/contracts';
import {
  BuilderSettingsState,
  ClearBuilderSettingsErrors,
  LoadBuilderEmbed,
  LoadBuilderNotificationPreferences,
  LoadBuilderProfile,
  RequestBuilderOriginChange,
  SaveBuilderNotificationPreferences,
  SaveBuilderProfile,
} from './builder-settings.state';
import { BuilderSettingsApiService } from './builder-settings-api.service';

const PROFILE_RESPONSE: BuilderProfileResponse = {
  profile: {
    tenantKey: 'elite-craft',
    businessName: 'Elite Craft Builders Ltd.',
    displayName: 'Elite Craft',
    contactEmail: 'hello@elitecraft.example',
    contactPhone: null,
    logoUrl: null,
    accentColor: '#c8a24b',
    updatedAt: '2026-11-16T00:00:00Z',
  },
  canEdit: true,
  support: { channel: 'email', email: 'support@feasly.example', responseTime: 'within 1 business day' },
};

const OPEN_REQUEST: BuilderOriginRequest = {
  id: 'r1',
  status: 'open',
  add: ['https://staging.elitecraft.example'],
  remove: [],
  note: null,
  createdAt: '2026-11-15T00:00:00Z',
};

const EMBED_RESPONSE: BuilderEmbedResponse = {
  tenantKey: 'elite-craft',
  loaderUrl: 'https://feasly.example/embed/v1/loader.js',
  snippet: '<script src="https://feasly.example/embed/v1/loader.js" data-key="elite-craft"></script>',
  origins: [
    { origin: 'https://www.elitecraft.example', lastSeenAt: '2026-11-15T12:00:00Z', loadedRecently: true },
    { origin: 'https://old.elitecraft.example', lastSeenAt: '2026-09-01T12:00:00Z', loadedRecently: false },
    { origin: 'https://new.elitecraft.example', lastSeenAt: null, loadedRecently: false },
  ],
  liveWindowDays: 7,
  lastSeenAt: '2026-11-15T12:00:00Z',
  openRequests: [],
};

const NOTIFICATIONS: BuilderNotificationPreferencesResponse = {
  channel: 'email',
  preferences: { newLeadEmail: true, needsYouDigest: false, billingEmail: true },
  role: 'builder_admin',
  canDisableBillingEmail: true,
};

function setup(overrides: Partial<Record<keyof BuilderSettingsApiService, unknown>> = {}) {
  TestBed.resetTestingModule();
  const api = {
    getProfile: vi.fn().mockReturnValue(of(PROFILE_RESPONSE)),
    updateProfile: vi.fn().mockImplementation((body: object) =>
      of({ ...PROFILE_RESPONSE, profile: { ...PROFILE_RESPONSE.profile, ...body } }),
    ),
    getEmbed: vi.fn().mockReturnValue(of(EMBED_RESPONSE)),
    requestOriginChange: vi.fn().mockReturnValue(of({ request: OPEN_REQUEST, created: true })),
    getNotificationPreferences: vi.fn().mockReturnValue(of(NOTIFICATIONS)),
    updateNotificationPreferences: vi.fn().mockImplementation((body: object) =>
      of({ ...NOTIFICATIONS, preferences: { ...NOTIFICATIONS.preferences, ...body } }),
    ),
    ...overrides,
  };
  TestBed.configureTestingModule({
    providers: [
      provideStore([BuilderSettingsState]),
      { provide: BuilderSettingsApiService, useValue: api },
    ],
  });
  return { store: TestBed.inject(Store), api };
}

describe('BuilderSettingsState (#871)', () => {
  let store: Store;
  let api: ReturnType<typeof setup>['api'];

  beforeEach(() => {
    ({ store, api } = setup());
  });

  it('loads the profile, canEdit and support contact', () => {
    store.dispatch(new LoadBuilderProfile());
    expect(store.selectSnapshot(BuilderSettingsState.profileStatus)).toBe('ready');
    expect(store.selectSnapshot(BuilderSettingsState.profile)?.displayName).toBe('Elite Craft');
    expect(store.selectSnapshot(BuilderSettingsState.canEdit)).toBe(true);
    expect(store.selectSnapshot(BuilderSettingsState.support)?.responseTime).toBe(
      'within 1 business day',
    );
  });

  it('marks a failed profile load as error', () => {
    ({ store } = setup({ getProfile: vi.fn().mockReturnValue(throwError(() => new Error('x'))) }));
    store.dispatch(new LoadBuilderProfile());
    expect(store.selectSnapshot(BuilderSettingsState.profileStatus)).toBe('error');
  });

  it('saves the profile and replaces it with the response', () => {
    store.dispatch(new LoadBuilderProfile());
    store.dispatch(new SaveBuilderProfile({ displayName: 'Elite' }));
    expect(api.updateProfile).toHaveBeenCalledWith({ displayName: 'Elite' });
    expect(store.selectSnapshot(BuilderSettingsState.profile)?.displayName).toBe('Elite');
    expect(store.selectSnapshot(BuilderSettingsState.saving)).toBe(false);
    expect(store.selectSnapshot(BuilderSettingsState.saveError)).toBeNull();
  });

  it('keeps the API message on a failed save', () => {
    ({ store } = setup({
      updateProfile: vi.fn().mockReturnValue(throwError(() => ({ message: 'Forbidden.' }))),
    }));
    store.dispatch(new SaveBuilderProfile({ displayName: 'Elite' }));
    expect(store.selectSnapshot(BuilderSettingsState.saveError)).toBe('Forbidden.');
    expect(store.selectSnapshot(BuilderSettingsState.saving)).toBe(false);
    store.dispatch(new ClearBuilderSettingsErrors());
    expect(store.selectSnapshot(BuilderSettingsState.saveError)).toBeNull();
  });

  it('loads the embed details', () => {
    store.dispatch(new LoadBuilderEmbed());
    expect(store.selectSnapshot(BuilderSettingsState.embedStatus)).toBe('ready');
    expect(store.selectSnapshot(BuilderSettingsState.embed)?.origins).toHaveLength(3);
  });

  it('adds a created origin request to the open list', () => {
    store.dispatch(new LoadBuilderEmbed());
    store.dispatch(new RequestBuilderOriginChange({ add: ['https://staging.elitecraft.example'] }));
    expect(store.selectSnapshot(BuilderSettingsState.requestOutcome)).toBe('created');
    expect(store.selectSnapshot(BuilderSettingsState.embed)?.openRequests).toEqual([OPEN_REQUEST]);
  });

  it('reports a duplicate request without listing it twice', () => {
    ({ store } = setup({
      requestOriginChange: vi.fn().mockReturnValue(of({ request: OPEN_REQUEST, created: false })),
      getEmbed: vi.fn().mockReturnValue(of({ ...EMBED_RESPONSE, openRequests: [OPEN_REQUEST] })),
    }));
    store.dispatch(new LoadBuilderEmbed());
    store.dispatch(new RequestBuilderOriginChange({ add: ['https://staging.elitecraft.example'] }));
    expect(store.selectSnapshot(BuilderSettingsState.requestOutcome)).toBe('duplicate');
    expect(store.selectSnapshot(BuilderSettingsState.embed)?.openRequests).toHaveLength(1);
  });

  it('keeps the API message on a failed request', () => {
    ({ store } = setup({
      requestOriginChange: vi
        .fn()
        .mockReturnValue(throwError(() => ({ message: 'Each add entry must be https.' }))),
    }));
    store.dispatch(new RequestBuilderOriginChange({ add: ['http://x'] }));
    expect(store.selectSnapshot(BuilderSettingsState.requestError)).toBe(
      'Each add entry must be https.',
    );
    expect(store.selectSnapshot(BuilderSettingsState.requestOutcome)).toBeNull();
  });
});

describe('BuilderSettingsState notifications (#864)', () => {
  it('loads the preferences', () => {
    const { store } = setup();
    store.dispatch(new LoadBuilderNotificationPreferences());
    expect(store.selectSnapshot(BuilderSettingsState.notifications)).toEqual(NOTIFICATIONS);
    expect(store.selectSnapshot(BuilderSettingsState.notificationsStatus)).toBe('ready');
  });

  it('marks a failed load as error', () => {
    const { store } = setup({
      getNotificationPreferences: vi.fn().mockReturnValue(throwError(() => ({ message: 'x' }))),
    });
    store.dispatch(new LoadBuilderNotificationPreferences());
    expect(store.selectSnapshot(BuilderSettingsState.notificationsStatus)).toBe('error');
  });

  it('saves a partial change and takes the server response', () => {
    const { store, api } = setup();
    store.dispatch(new LoadBuilderNotificationPreferences());
    store.dispatch(new SaveBuilderNotificationPreferences({ needsYouDigest: true }));
    expect(api.updateNotificationPreferences).toHaveBeenCalledWith({ needsYouDigest: true });
    expect(store.selectSnapshot(BuilderSettingsState.notifications)?.preferences.needsYouDigest).toBe(
      true,
    );
    expect(store.selectSnapshot(BuilderSettingsState.notificationsSaving)).toBe(false);
    expect(store.selectSnapshot(BuilderSettingsState.notificationsError)).toBeNull();
  });

  it('keeps the server state and the API message on a 409 LAST_ADMIN', () => {
    const message = 'Billing emails must reach at least one admin.';
    const { store } = setup({
      updateNotificationPreferences: vi
        .fn()
        .mockReturnValue(throwError(() => ({ code: 'LAST_ADMIN', message, retryable: false }))),
    });
    store.dispatch(new LoadBuilderNotificationPreferences());
    store.dispatch(new SaveBuilderNotificationPreferences({ billingEmail: false }));
    expect(store.selectSnapshot(BuilderSettingsState.notifications)?.preferences.billingEmail).toBe(
      true,
    );
    expect(store.selectSnapshot(BuilderSettingsState.notificationsError)).toBe(message);
    store.dispatch(new ClearBuilderSettingsErrors());
    expect(store.selectSnapshot(BuilderSettingsState.notificationsError)).toBeNull();
  });
});
