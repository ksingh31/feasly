/**
 * Azure Functions v3 trigger adapter — POST /api/v1/stripe/webhooks.
 *
 * Stripe signature verification needs the EXACT bytes Stripe signed, so
 * this adapter passes the raw request body through untouched:
 * `stripe-webhooks/function.json` sets `dataType: 'binary'` on the
 * httpTrigger binding, which makes `req.body` a Buffer. Do NOT JSON-parse
 * here — the webhook service verifies the signature against these bytes.
 *
 * Runs through the webhook pipeline (correlation + tight 100/min-per-IP
 * rate limiter per the frozen registry + RFC 7807 errors). A 401 on bad
 * signature is deliberate: Stripe retries are keyed on non-2xx, and 401
 * tells us the secret or payload is wrong.
 *
 * Bundled by `npm run bundle:functions` into `stripe-webhooks/index.js`
 * (self-contained — the Function App has no node_modules).
 */
import { randomUUID } from 'node:crypto';
import {
  createComposition,
  middleware,
  type AppComposition,
} from '../index';
import type { FunctionContext, FunctionRequest } from './estimate';

const CORRELATION_RESPONSE_HEADER = 'x-correlation-id';

let cached: AppComposition | undefined;

function getApp(): AppComposition {
  if (!cached) cached = createComposition();
  return cached;
}

function clientIpFrom(req: FunctionRequest): string | undefined {
  const forwarded = req.headers?.['x-forwarded-for'];
  const first = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  const ip = first?.split(',')[0]?.trim();
  return ip ? ip : undefined;
}

function signatureFrom(req: FunctionRequest): string | undefined {
  const raw = req.headers?.['stripe-signature'];
  return Array.isArray(raw) ? raw[0] : raw;
}

export async function stripeWebhooksHandler(
  context: FunctionContext,
  req: FunctionRequest,
): Promise<void> {
  const app = getApp();
  const headers: Record<string, string | string[] | undefined> = {
    ...(req.headers ?? {}),
  };
  if (!headers[CORRELATION_RESPONSE_HEADER]) {
    headers[CORRELATION_RESPONSE_HEADER] = randomUUID();
  }
  const correlationId = middleware.ensureCorrelationId(headers);

  // The raw body is never logged — it carries the signed payload.
  const result = await app.webhookPipeline.run(
    { headers, clientIp: clientIpFrom(req) },
    () => app.stripeWebhooksRoute.handle(req.body, signatureFrom(req)),
  );

  if (middleware.isProblemDetails(result)) {
    context.res = {
      status: result.status,
      headers: {
        ...middleware.problemResponseHeaders(result),
        [CORRELATION_RESPONSE_HEADER]: result.correlationId,
      },
      body: result,
    };
    return;
  }
  context.res = {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      [CORRELATION_RESPONSE_HEADER]: correlationId,
    },
    body: result,
  };
}

// Azure Functions v3 programming model entry point (bundled as CJS).
module.exports = stripeWebhooksHandler;
