/*!
 * Feasly embed loader.
 *
 * One script tag on any builder page injects the sandboxed Feasly estimator:
 *
 *   <script src="https://app.feasly.com/embed/v1/loader.js"
 *           data-builder="YOUR_TENANT_KEY"></script>
 *
 * Zero dependencies. Install docs: docs/embed-install.md
 *
 * postMessage model (see docs/embed-install.md "Message protocol"):
 * - Outbound (loader -> iframe) posts to the *specific* iframe window with
 *   targetOrigin '*'. This is deliberate, not sloppy: the sandbox attribute
 *   intentionally omits allow-same-origin (TECH_PLAN 4.1), so the iframe runs
 *   at an opaque origin and a pinned targetOrigin can never match -- browsers
 *   throw or silently drop such messages. The post is still point-to-point
 *   (iframe.contentWindow, never a broadcast) and is only ever sent after the
 *   iframe proved its identity via feasly:ready.
 * - Inbound (iframe -> loader) messages carry event.origin "null" for the same
 *   opaque-origin reason, so sender identity is validated with
 *   event.source === iframe.contentWindow -- strictly stronger than an origin
 *   string, since only our iframe holds that window reference. Spoofed
 *   messages from any other window are ignored.
 */
(function () {
  'use strict';

  /** Single source of truth for the version; snippet/build.mjs stamps it. */
  var FEASLY_LOADER_VERSION = '1.0.0';

  var RELAY_PARAM = 'feasly_rt';
  var RELAY_STORAGE_KEY = 'feasly_relay_code';
  var FALLBACK_COPY =
    'This estimator is temporarily unavailable \u2014 please contact the builder directly.';
  /** Exact sandbox flags per TECH_PLAN 4.1: no allow-same-origin, no allow-top-navigation. */
  var SANDBOX_FLAGS = 'allow-scripts allow-forms allow-popups';
  var DEFAULT_READY_TIMEOUT_MS = 15000;
  var DEFAULT_IFRAME_HEIGHT_PX = 640;
  var MIN_IFRAME_HEIGHT_PX = 120;
  var MAX_IFRAME_HEIGHT_PX = 4000;

  function logError(message) {
    if (typeof console !== 'undefined' && console.error) {
      console.error('[feasly] ' + message);
    }
  }

  /**
   * Finds our own <script> tag: document.currentScript when it carries the
   * data-builder marker, otherwise the last script tag with data-builder
   * (covers async/defer and programmatic injection edge cases).
   */
  function findSnippetScript() {
    if (
      document.currentScript &&
      document.currentScript.hasAttribute &&
      document.currentScript.hasAttribute('data-builder')
    ) {
      return document.currentScript;
    }
    var scripts = document.querySelectorAll('script[data-builder]');
    return scripts.length > 0 ? scripts[scripts.length - 1] : null;
  }

  /** Embed origin defaults to the origin serving this loader file (same-origin hosting). */
  function defaultOriginFromSrc(scriptEl) {
    var src = scriptEl.getAttribute('src') || '';
    try {
      var url = new URL(src, document.baseURI);
      if (url.protocol === 'http:' || url.protocol === 'https:') {
        return url.origin;
      }
    } catch (e) {
      /* unparseable src -- caller falls back to the explicit attribute */
    }
    return '';
  }

  function parseConfig(scriptEl) {
    var attr = function (name) {
      var v = scriptEl.getAttribute('data-' + name);
      return v === null ? '' : v.trim();
    };
    var timeout = parseInt(attr('timeout'), 10);
    return {
      tenantKey: attr('builder'),
      embedOrigin: attr('embed-origin') || defaultOriginFromSrc(scriptEl),
      targetSelector: attr('target'),
      primaryColor: attr('primary-color'),
      readyTimeoutMs: isNaN(timeout) || timeout < 0 ? DEFAULT_READY_TIMEOUT_MS : timeout,
    };
  }

  /**
   * Token-relay intake (embed/06): a ?feasly_rt= code in the page URL is
   * stashed in builder-origin sessionStorage and stripped from the visible URL
   * via history.replaceState. On reload-before-exchange the stashed code is
   * re-posted; it is cleared once the iframe confirms FEASLY_AUTH_OK.
   */
  function readRelayCode() {
    try {
      var params = new URLSearchParams(window.location.search);
      var fromUrl = params.get(RELAY_PARAM);
      if (fromUrl) {
        window.sessionStorage.setItem(RELAY_STORAGE_KEY, fromUrl);
        params.delete(RELAY_PARAM);
        var rest = params.toString();
        var cleanUrl =
          window.location.pathname + (rest ? '?' + rest : '') + window.location.hash;
        window.history.replaceState(null, '', cleanUrl);
        return fromUrl;
      }
      return window.sessionStorage.getItem(RELAY_STORAGE_KEY);
    } catch (e) {
      return null;
    }
  }

  function clearRelayCode() {
    try {
      window.sessionStorage.removeItem(RELAY_STORAGE_KEY);
    } catch (e) {
      /* ignore */
    }
  }

  /** The builder page element the iframe (or its fallback card) renders into. */
  function resolveContainer(scriptEl) {
    if (scriptEl) {
      var selector = (scriptEl.getAttribute('data-target') || '').trim();
      if (selector) {
        try {
          var targeted = document.querySelector(selector);
          if (targeted) return targeted;
        } catch (e) {
          /* invalid selector -- fall through */
        }
      }
      var parent = scriptEl.parentNode;
      if (parent && parent.nodeType === 1 && parent !== document.documentElement) {
        return parent;
      }
    }
    var div = document.createElement('div');
    div.id = 'feasly-embed';
    document.body.appendChild(div);
    return div;
  }

  function buildIframe(cfg) {
    var iframe = document.createElement('iframe');
    iframe.src = cfg.embedOrigin + '/embed/' + encodeURIComponent(cfg.tenantKey);
    iframe.setAttribute('sandbox', SANDBOX_FLAGS);
    iframe.setAttribute('title', 'Feasly home building cost estimator');
    iframe.setAttribute('data-feasly-loader', FEASLY_LOADER_VERSION);
    iframe.style.width = '100%';
    iframe.style.height = DEFAULT_IFRAME_HEIGHT_PX + 'px';
    iframe.style.border = '0';
    iframe.style.display = 'block';
    return iframe;
  }

  /** Exact story-pinned copy; never a blank area, never a stack trace. */
  function showFallback(container, ctx) {
    if (ctx) ctx.dead = true;
    while (container.firstChild) container.removeChild(container.firstChild);
    var card = document.createElement('div');
    card.setAttribute('data-feasly-fallback', 'true');
    card.setAttribute('role', 'alert');
    card.style.cssText =
      'font-family:system-ui,-apple-system,"Segoe UI",sans-serif;' +
      'max-width:560px;margin:24px auto;padding:32px 24px;text-align:center;' +
      'border:1px solid #e5e0d5;border-radius:12px;background:#faf8f3;color:#2b2620;';
    var p = document.createElement('p');
    p.style.cssText = 'margin:0;font-size:16px;line-height:1.5;';
    p.textContent = FALLBACK_COPY;
    card.appendChild(p);
    container.appendChild(card);
  }

  /**
   * Point-to-point post into the iframe. See the file header for why '*'
   * is the only deliverable targetOrigin for an opaque-origin sandbox.
   */
  function postToIframe(iframe, message) {
    iframe.contentWindow.postMessage(message, '*');
  }

  function onReady(ctx) {
    if (ctx.ready || ctx.dead) return;
    ctx.ready = true;
    if (ctx.fallbackTimer) {
      clearTimeout(ctx.fallbackTimer);
      ctx.fallbackTimer = 0;
    }
    // Theme handshake (embed/08): the shell validates the hex format.
    if (ctx.cfg.primaryColor) {
      postToIframe(ctx.iframe, { type: 'feasly:theme', primaryColor: ctx.cfg.primaryColor });
    }
    // Relay handoff (embed/06): the iframe exchanges the code server-side.
    if (ctx.relayCode) {
      postToIframe(ctx.iframe, { type: 'feasly:relay', code: ctx.relayCode });
    }
  }

  function onResize(ctx, data) {
    if (ctx.dead) return;
    var h = Math.round(Number(data.height));
    if (isNaN(h)) return;
    h = Math.max(MIN_IFRAME_HEIGHT_PX, Math.min(MAX_IFRAME_HEIGHT_PX, h));
    ctx.iframe.style.height = h + 'px';
  }

  function onEstimateStart(ctx, data) {
    if (ctx.dead) return;
    var detail = {};
    if (typeof data.addressKey === 'string') detail.addressKey = data.addressKey;
    if (typeof data.address === 'string') detail.address = data.address;
    var event;
    try {
      event = new CustomEvent('feasly:estimate-start', { detail: detail, bubbles: true });
    } catch (e) {
      event = document.createEvent('CustomEvent');
      event.initCustomEvent('feasly:estimate-start', true, false, detail);
    }
    ctx.container.dispatchEvent(event);
  }

  function onMessage(ev, ctx) {
    // Identity gate: opaque-origin sandbox => event.origin is "null" for every
    // legitimate iframe message. The window reference is the real credential.
    if (ctx.dead || ev.source !== ctx.iframe.contentWindow) return;
    var data = ev.data;
    if (!data || typeof data.type !== 'string') return;
    switch (data.type) {
      case 'feasly:ready':
        onReady(ctx);
        break;
      case 'feasly:resize':
        onResize(ctx, data);
        break;
      case 'feasly:estimate-start':
        onEstimateStart(ctx, data);
        break;
      case 'FEASLY_AUTH_OK':
        clearRelayCode();
        break;
      default:
        break;
    }
  }

  function init() {
    var scriptEl = findSnippetScript();
    var container = resolveContainer(scriptEl);
    if (!scriptEl) {
      logError('embed loader: no <script data-builder="..."> tag found.');
      showFallback(container, null);
      return;
    }
    var cfg = parseConfig(scriptEl);
    if (!cfg.tenantKey) {
      logError('embed loader: data-builder (tenant key) is required.');
      showFallback(container, null);
      return;
    }
    if (!cfg.embedOrigin) {
      logError('embed loader: cannot determine the embed origin; set data-embed-origin.');
      showFallback(container, null);
      return;
    }

    var relayCode = readRelayCode();
    var iframe = buildIframe(cfg);
    container.appendChild(iframe);

    var ctx = {
      iframe: iframe,
      container: container,
      cfg: cfg,
      relayCode: relayCode,
      ready: false,
      dead: false,
      fallbackTimer: 0,
    };

    window.addEventListener('message', function (ev) {
      onMessage(ev, ctx);
    });

    // No feasly:ready within the timeout => the iframe failed to load.
    ctx.fallbackTimer = setTimeout(function () {
      if (!ctx.ready && !ctx.dead) {
        logError('embed loader: iframe did not signal ready in time; showing fallback.');
        showFallback(container, ctx);
      }
    }, cfg.readyTimeoutMs);

    iframe.addEventListener('error', function () {
      if (!ctx.dead) showFallback(container, ctx);
    });

    if (typeof console !== 'undefined' && console.info) {
      console.info('[feasly] embed loader v' + FEASLY_LOADER_VERSION + ' initialized.');
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
