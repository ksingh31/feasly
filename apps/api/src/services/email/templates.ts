/**
 * Finalized transactional email templates (story email/01).
 *
 * Pure render functions: every template takes a `TemplateContext` carrying
 * the URLs (app base, unsubscribe base) so no URL is ever hardcoded here —
 * the layer-boundary test forbids URL literals in services/. Copy rules:
 *   - magic-link: single CTA, states the 7-day expiry, plain-text fallback.
 *   - share: carries the partner's FRESH bearer share URL — never the
 *     owner's magic link. No dollar figures in email copy, ever.
 *   - nudge (non-transactional): one-click unsubscribe link in the body;
 *     the service also sets List-Unsubscribe headers.
 *   - every template: banned-phrase clean (see banned-patterns.txt) and a
 *     trust footer noting deterministic math + uncalibrated cost data.
 */

export interface TemplateContext {
  /** Where magic links / resume links point (config APP_BASE_URL). */
  readonly appBaseUrl: string;
  /**
   * One-click unsubscribe base (email/03, config UNSUBSCRIBE_URL_BASE).
   * The nudge template renders the full tokenized URL passed in
   * `NudgeTemplateInput.unsubscribeUrl` — the base is kept here for
   * templates that only need the prefix.
   */
  readonly unsubscribeBaseUrl: string;
  readonly brandName: string;
}

export interface RenderedEmail {
  readonly subject: string;
  readonly html: string;
  readonly text: string;
}

/** Minimal HTML escaping for interpolated user values. */
function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Shared table-based layout (email-client safe, inline CSS only).
 * Warm cream / charcoal / brass per the Feasly design tokens.
 */
function layout(ctx: TemplateContext, title: string, bodyHtml: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background-color:#faf6ef;font-family:'Instrument Sans',-apple-system,'Segoe UI',Arial,sans-serif;color:#232323;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#faf6ef;padding:32px 16px;">
<tr><td align="center">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;background-color:#ffffff;border-radius:12px;overflow:hidden;">
<tr><td style="padding:28px 32px 8px;font-family:Syne,Arial,sans-serif;font-size:22px;font-weight:700;color:#232323;">${esc(ctx.brandName)}</td></tr>
<tr><td style="padding:8px 32px 24px;font-size:16px;line-height:1.6;color:#232323;">
<h1 style="font-size:20px;margin:0 0 12px;color:#232323;">${title}</h1>
${bodyHtml}
</td></tr>
<tr><td style="padding:0 32px 28px;font-size:12px;line-height:1.6;color:#8a8378;border-top:1px solid #eee6d6;">
<p style="margin:12px 0 0;">Deterministic cost math &middot; not a contractor quote &middot; cost data currently uncalibrated.</p>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

function ctaButton(url: string, label: string): string {
  return `<p style="margin:20px 0;"><a href="${esc(url)}" style="display:inline-block;background-color:#b08d3e;color:#ffffff;text-decoration:none;font-weight:600;font-size:16px;padding:14px 28px;border-radius:8px;">${esc(label)}</a></p>`;
}

function fallbackLink(url: string): string {
  return `<p style="font-size:13px;color:#8a8378;">Button not working? Paste this link into your browser:<br><a href="${esc(url)}" style="color:#b08d3e;word-break:break-all;">${esc(url)}</a></p>`;
}

export interface MagicLinkTemplateInput {
  readonly name?: string;
  readonly magicLinkUrl: string;
  /** Days until the link expires — rendered from config, never hardcoded. */
  readonly expiresInDays: number;
  readonly audience: 'consumer' | 'admin' | 'builder';
}

/** Single-CTA magic-link email. Transactional: no unsubscribe link. */
export function renderMagicLinkEmail(
  ctx: TemplateContext,
  input: MagicLinkTemplateInput,
): RenderedEmail {
  const greeting = input.name ? `Hi ${esc(input.name)},` : 'Hi there,';
  const subject =
    input.audience === 'admin'
      ? `Your ${ctx.brandName} admin sign-in link`
      : `Your ${ctx.brandName} estimate is ready — sign in to view it`;
  const isAdmin = input.audience === 'admin';
  const ctaLabel = isAdmin ? `Sign in to ${ctx.brandName} admin` : 'View my estimate';
      : input.audience === 'builder'
        ? `Your ${ctx.brandName} builder dashboard sign-in link`
        : `Your ${ctx.brandName} estimate is ready — sign in to view it`;
  const ctaLabel =
    input.audience === 'builder' ? 'Open builder dashboard' : 'View my estimate';
  const body = `<p>${greeting}</p>
<p>Here's your secure sign-in link. It expires in ${input.expiresInDays} days and can only be used once.</p>
${ctaButton(input.magicLinkUrl, ctaLabel)}
${fallbackLink(input.magicLinkUrl)}`;
  const text = `${input.name ? `Hi ${input.name},` : 'Hi there,'}\n\nHere's your secure sign-in link. It expires in ${input.expiresInDays} days and can only be used once.\n\n${ctaLabel}: ${input.magicLinkUrl}\n\n— ${ctx.brandName}\nDeterministic cost math · not a contractor quote · cost data currently uncalibrated.`;
  return { subject, html: layout(ctx, 'Your secure sign-in link', body), text };
}

export interface ShareTemplateInput {
  readonly ownerName?: string;
  readonly partnerName?: string;
  /** Fresh single-use bearer share URL — NEVER the owner's magic link. */
  readonly shareUrl: string;
  readonly note?: string;
  /** Days until the share link expires — rendered from config, never hardcoded. */
  readonly expiresInDays: number;
}

/**
 * Partner-share email. The shareUrl is a fresh bearer token minted for the
 * partner; forwarding the owner's magic link is forbidden by construction —
 * this renderer never receives it.
 */
export function renderShareEmail(
  ctx: TemplateContext,
  input: ShareTemplateInput,
): RenderedEmail {
  const greeting = input.partnerName ? `Hi ${esc(input.partnerName)},` : 'Hi there,';
  const fromLine = input.ownerName
    ? `<p>${esc(input.ownerName)} shared their ${esc(ctx.brandName)} build estimate with you.</p>`
    : `<p>Someone shared their ${esc(ctx.brandName)} build estimate with you.</p>`;
  const note = input.note ? `<p style="font-style:italic;">&ldquo;${esc(input.note)}&rdquo;</p>` : '';
  const subject = `${input.ownerName ? `${input.ownerName} shared` : 'A'} build estimate with you via ${ctx.brandName}`;
  const body = `<p>${greeting}</p>
${fromLine}
${note}
<p>You can view the full estimate — cost breakdown, what-if tiers, and next steps — with this private link. It expires in ${input.expiresInDays} days.</p>
${ctaButton(input.shareUrl, 'View the shared estimate')}
${fallbackLink(input.shareUrl)}
<p style="font-size:13px;color:#8a8378;">This link is personal to you. Please don't forward it — ask the sender for a fresh one if someone else needs access.</p>`;
  const text = `${input.partnerName ? `Hi ${input.partnerName},` : 'Hi there,'}\n\n${input.ownerName ? `${input.ownerName} shared` : 'Someone shared'} their ${ctx.brandName} build estimate with you.\n${input.note ? `\n"${input.note}"\n` : ''}\nView the shared estimate (private link, expires in ${input.expiresInDays} days): ${input.shareUrl}\n\nThis link is personal to you — please don't forward it.\n\n— ${ctx.brandName}\nDeterministic cost math · not a contractor quote · cost data currently uncalibrated.`;
  return { subject, html: layout(ctx, 'An estimate was shared with you', body), text };
}

export interface CallbackTeamTemplateInput {
  readonly leadName: string;
  readonly leadEmail: string;
  readonly leadPhone?: string;
  readonly timeline?: string;
  readonly estimateId: string;
  readonly requestedAt: Date;
}

/** Internal notification to the team inbox when a homeowner requests a callback. */
export function renderCallbackTeamEmail(
  ctx: TemplateContext,
  input: CallbackTeamTemplateInput,
): RenderedEmail {
  const subject = `Callback requested: ${input.leadName}`;
  const phoneRow = input.leadPhone
    ? `<tr><td style="padding:4px 8px 4px 0;color:#8a8378;">Phone</td><td style="padding:4px 0;">${esc(input.leadPhone)}</td></tr>`
    : '';
  const timelineRow = input.timeline
    ? `<tr><td style="padding:4px 8px 4px 0;color:#8a8378;">Timeline</td><td style="padding:4px 0;">${esc(input.timeline)}</td></tr>`
    : '';
  const body = `<p>A homeowner asked for a callback from their estimate report.</p>
<table role="presentation" cellpadding="0" cellspacing="0" style="font-size:15px;">
<tr><td style="padding:4px 8px 4px 0;color:#8a8378;">Name</td><td style="padding:4px 0;">${esc(input.leadName)}</td></tr>
<tr><td style="padding:4px 8px 4px 0;color:#8a8378;">Email</td><td style="padding:4px 0;">${esc(input.leadEmail)}</td></tr>
${phoneRow}
${timelineRow}
<tr><td style="padding:4px 8px 4px 0;color:#8a8378;">Estimate</td><td style="padding:4px 0;">${esc(input.estimateId)}</td></tr>
<tr><td style="padding:4px 8px 4px 0;color:#8a8378;">Requested</td><td style="padding:4px 0;">${esc(input.requestedAt.toISOString())}</td></tr>
</table>`;
  const text = `Callback requested\n\nName: ${input.leadName}\nEmail: ${input.leadEmail}\n${input.leadPhone ? `Phone: ${input.leadPhone}\n` : ''}${input.timeline ? `Timeline: ${input.timeline}\n` : ''}Estimate: ${input.estimateId}\nRequested: ${input.requestedAt.toISOString()}\n\n— ${ctx.brandName} (internal notification)`;
  return { subject, html: layout(ctx, 'Callback requested', body), text };
}

export interface NudgeTemplateInput {
  readonly name?: string;
  /** Resume/unlock URL for the homeowner's estimate. */
  readonly resumeUrl: string;
  /** One-click unsubscribe URL (token embedded). */
  readonly unsubscribeUrl: string;
}

/**
 * 24-hour unverified-lead nudge. NON-transactional: carries the one-click
 * unsubscribe link in the body (and the service sets List-Unsubscribe
 * headers). Only sent when the lead opted into marketing (CASL).
 */
export function renderNudgeEmail(
  ctx: TemplateContext,
  input: NudgeTemplateInput,
): RenderedEmail {
  const greeting = input.name ? `Hi ${esc(input.name)},` : 'Hi there,';
  const subject = `Your ${ctx.brandName} estimate is still waiting for you`;
  const body = `<p>${greeting}</p>
<p>You started a build estimate yesterday but haven't unlocked the full numbers yet. Your estimate is saved — pick up right where you left off.</p>
${ctaButton(input.resumeUrl, 'See my full estimate')}
${fallbackLink(input.resumeUrl)}
<p style="font-size:13px;color:#8a8378;">Changed your mind? <a href="${esc(input.unsubscribeUrl)}" style="color:#b08d3e;">Unsubscribe</a> from these reminders — no hard feelings.</p>`;
  const text = `${input.name ? `Hi ${input.name},` : 'Hi there,'}\n\nYou started a build estimate yesterday but haven't unlocked the full numbers yet. Your estimate is saved — pick up right where you left off:\n\n${input.resumeUrl}\n\nChanged your mind? Unsubscribe from these reminders: ${input.unsubscribeUrl}\n\n— ${ctx.brandName}\nDeterministic cost math · not a contractor quote · cost data currently uncalibrated.`;
  return { subject, html: layout(ctx, 'Your estimate is waiting', body), text };
}

export interface OpsAlertTemplateInput {
  readonly title: string;
  readonly summary: string;
  readonly detailsUrl?: string;
  readonly firedAt: Date;
}

/** Deduplicated ops alert (worker/webhook failures) to the ops inbox. */
export function renderOpsAlertEmail(
  ctx: TemplateContext,
  input: OpsAlertTemplateInput,
): RenderedEmail {
  const subject = `[${ctx.brandName} ops] ${input.title}`;
  const details = input.detailsUrl
    ? `<p><a href="${esc(input.detailsUrl)}" style="color:#b08d3e;">View details</a></p>`
    : '';
  const body = `<p>${esc(input.summary)}</p>
<p style="font-size:13px;color:#8a8378;">Fired at ${esc(input.firedAt.toISOString())}</p>
${details}`;
  const text = `[${ctx.brandName} ops] ${input.title}\n\n${input.summary}\n\nFired at ${input.firedAt.toISOString()}\n${input.detailsUrl ? `\nDetails: ${input.detailsUrl}\n` : ''}`;
  return { subject, html: layout(ctx, esc(input.title), body), text };
}
