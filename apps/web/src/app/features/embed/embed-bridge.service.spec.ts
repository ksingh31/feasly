import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { provideStore, Store } from '@ngxs/store';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EmbedPublicConfig } from '@feasly/contracts';
import { EmbedBridgeService } from './embed-bridge.service';
import { EmbedConfigLoaded } from './embed.actions';
import { EmbedState } from './embed.state';

/**
 * embed/08 — bridge service: debounced resize, exactly-once lead events,
 * origin-gated inbound, never broadcast '*'.
 */
describe('EmbedBridgeService', () => {
  let bridge: EmbedBridgeService;
  let store: Store;
  let postMessage: ReturnType<typeof vi.fn>;

  const fakeConfig = {
    business_name: 'Elite Craft Builders',
    display_name: 'Elite Craft',
    logo_url: '',
    accent_color: '#a8761a',
    allowed_origins: ['https://example-builder.com'],
    fallback_phone: '(403) 555-0100',
    fallback_email: 'hello@example-builder.com',
    plan: null,
  } as EmbedPublicConfig;

  /** Fake an embedded context: window.parent !== window. */
  function embedWindow(parentOrigin: string): void {
    const fakeParent = { postMessage } as unknown as Window;
    vi.stubGlobal('window', {
      ...window,
      parent: fakeParent,
      location: { origin: 'https://embed.feasly.test' },
    });
    Object.defineProperty(document, 'referrer', {
      value: parentOrigin,
      configurable: true,
    });
  }

  beforeEach(() => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [provideRouter([]), provideStore([EmbedState])],
    });
    store = TestBed.inject(Store);
    bridge = TestBed.inject(EmbedBridgeService);
    postMessage = vi.fn();
    vi.unstubAllGlobals();
  });

  it('posts feasly:ready to the allowlisted parent origin', () => {
    embedWindow('https://example-builder.com/page');
    store.dispatch(new EmbedConfigLoaded(fakeConfig));
    bridge.notifyReady();
    expect(postMessage).toHaveBeenCalledWith(
      { type: 'feasly:ready' },
      'https://example-builder.com',
    );
  });

  it('never posts to a non-allowlisted referrer origin', () => {
    embedWindow('https://evil.test/page');
    store.dispatch(new EmbedConfigLoaded(fakeConfig));
    bridge.notifyReady();
    bridge.requestResize(800);
    expect(postMessage).not.toHaveBeenCalled();
  });

  it('never broadcasts with targetOrigin "*"', () => {
    embedWindow('https://example-builder.com/page');
    store.dispatch(new EmbedConfigLoaded(fakeConfig));
    bridge.notifyReady();
    for (const call of postMessage.mock.calls) {
      expect(call[1]).not.toBe('*');
    }
  });

  it('posts lead-created exactly once per leadId', () => {
    embedWindow('https://example-builder.com/page');
    store.dispatch(new EmbedConfigLoaded(fakeConfig));
    bridge.notifyLeadCreated('lead-1', 'est-1', 82);
    bridge.notifyLeadCreated('lead-1', 'est-1', 82);
    bridge.notifyLeadCreated('lead-2', 'est-2', 70);
    const leadPosts = postMessage.mock.calls.filter(
      ([msg]) => (msg as { type: string }).type === 'feasly:lead-created',
    );
    expect(leadPosts).toHaveLength(2);
    expect(leadPosts[0][0]).toEqual({
      type: 'feasly:lead-created',
      estimateId: 'est-1',
      leadScore: 82,
    });
  });

  it('omits leadScore from the payload when the backend does not provide it', () => {
    embedWindow('https://example-builder.com/page');
    store.dispatch(new EmbedConfigLoaded(fakeConfig));
    bridge.notifyLeadCreated('lead-1', 'est-1');
    expect(postMessage).toHaveBeenCalledWith(
      { type: 'feasly:lead-created', estimateId: 'est-1' },
      'https://example-builder.com',
    );
    const payload = postMessage.mock.calls[0][0] as Record<string, unknown>;
    expect('leadScore' in payload).toBe(false);
  });

  it('lead-created payload carries zero PII (keys enumerated)', () => {
    embedWindow('https://example-builder.com/page');
    store.dispatch(new EmbedConfigLoaded(fakeConfig));
    bridge.notifyLeadCreated('lead-1', 'est-1', 82);
    const payload = postMessage.mock.calls[0][0] as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual(['estimateId', 'leadScore', 'type']);
  });

  it('accepts inbound messages only from allowlisted origins', () => {
    store.dispatch(new EmbedConfigLoaded(fakeConfig));
    expect(bridge.isAllowedInbound('https://example-builder.com')).toBe(true);
    expect(bridge.isAllowedInbound('https://evil.test')).toBe(false);
    expect(bridge.isAllowedInbound('')).toBe(false);
    expect(bridge.isAllowedInbound('*')).toBe(false);
  });

  it('debounces rapid resize requests into a single post', async () => {
    embedWindow('https://example-builder.com/page');
    store.dispatch(new EmbedConfigLoaded(fakeConfig));
    bridge.requestResize(800);
    bridge.requestResize(810);
    bridge.requestResize(820);
    // Debounce window has not elapsed: nothing posted yet.
    expect(postMessage).not.toHaveBeenCalled();
    await new Promise((r) => setTimeout(r, 250));
    const resizePosts = postMessage.mock.calls.filter(
      ([msg]) => (msg as { type: string }).type === 'feasly:resize',
    );
    expect(resizePosts).toHaveLength(1);
    expect(resizePosts[0][0]).toEqual({ type: 'feasly:resize', height: 820 });
  });
});
