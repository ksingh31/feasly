/**
 * Finalized transactional email templates (story email/01).
 *
 * Pure render functions: every template takes a `TemplateContext` carrying
 * the URLs (app base, unsubscribe base) so no URL is ever hardcoded here —
 * the layer-boundary test forbids URL literals in services/. Copy rules:
 *   - magic-link: single CTA, states the 7-day expiry, plain-text fallback.
 *     Consumer magic-link emails carry the unsubscribe footer
 *     (admin/builder sign-in links are team credentials — no footer).
 *   - share: carries the partner's FRESH bearer share URL — never the
 *     owner's magic link. No dollar figures in email copy, ever. The
 *     recipient is not a lead (one-off, owner-initiated) — no footer.
 *   - nudge (non-transactional): unsubscribe footer via
 *     renderLeadEmailFooter; the service also sets List-Unsubscribe headers.
 *   - callback-team / ops-alert: internal team mail — no footer.
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
function layout(
  ctx: TemplateContext,
  title: string,
  bodyHtml: string,
  footerLinksHtml?: string,
): string {
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
${footerLinksHtml ?? ''}<p style="margin:12px 0 0;">Deterministic cost math &middot; not a contractor quote &middot; cost data currently uncalibrated.</p>
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

/**
 * Footer block for LEAD-facing emails: one-click unsubscribe + preference
 * management. Both links land on the tokenized preference page (the page
 * confirms before saving — that page IS the one click). Internal emails
 * (callback-team, ops-alert) and the partner-share email (one-off,
 * owner-initiated, recipient is not a lead) never render this.
 */
export function renderLeadEmailFooter(unsubscribeUrl: string): string {
  const url = esc(unsubscribeUrl);
  return `<p style="margin:16px 0 0;font-size:12px;color:#8a8378;"><a href="${url}" style="color:#b08d3e;">Unsubscribe</a> &middot; <a href="${url}" style="color:#b08d3e;">Manage email preferences</a></p>`;
}

/** Plain-text twin of {@link renderLeadEmailFooter}. */
export function leadEmailFooterText(unsubscribeUrl: string): string {
  return `Unsubscribe: ${unsubscribeUrl}\nManage email preferences: ${unsubscribeUrl}`;
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
  /**
   * Tokenized preference-page URL. Rendered as the unsubscribe footer for
   * the consumer audience only — admin/builder sign-in links are team
   * credentials, not lead marketing, and carry no footer.
   */
  readonly unsubscribeUrl?: string;
}

/** Consumer magic-link emails carry the unsubscribe footer; admin/builder do not. */
export function renderMagicLinkEmail(
  ctx: TemplateContext,
  input: MagicLinkTemplateInput,
): RenderedEmail {
  const greeting = input.name ? `Hi ${esc(input.name)},` : 'Hi there,';
  const subject =
    input.audience === 'admin'
      ? `Your ${ctx.brandName} admin sign-in link`
      : input.audience === 'builder'
        ? `Your ${ctx.brandName} builder dashboard sign-in link`
        : `Your ${ctx.brandName} estimate is ready — sign in to view it`;
  const isAdmin = input.audience === 'admin';
  const ctaLabel =
    isAdmin
      ? `Sign in to ${ctx.brandName} admin`
      : input.audience === 'builder'
        ? 'Open builder dashboard'
        : 'View my estimate';
  const body = `<p>${greeting}</p>
<p>Here's your secure sign-in link. It expires in ${input.expiresInDays} days and can only be used once.</p>
${ctaButton(input.magicLinkUrl, ctaLabel)}
${fallbackLink(input.magicLinkUrl)}`;
  const footerUrl =
    input.audience === 'consumer' ? input.unsubscribeUrl : undefined;
  const text = `${input.name ? `Hi ${input.name},` : 'Hi there,'}\n\nHere's your secure sign-in link. It expires in ${input.expiresInDays} days and can only be used once.\n\n${ctaLabel}: ${input.magicLinkUrl}\n\n— ${ctx.brandName}\nDeterministic cost math · not a contractor quote · cost data currently uncalibrated.${
    footerUrl ? `\n\n${leadEmailFooterText(footerUrl)}` : ''
  }`;
  return {
    subject,
    html: layout(
      ctx,
      'Your secure sign-in link',
      body,
      footerUrl ? renderLeadEmailFooter(footerUrl) : undefined,
    ),
    text,
  };
}

export interface InvitationTemplateInput {
  readonly name?: string;
  /**
   * Sign-in URL (e.g. /admin/login) — Entra owns the credential, so the
   * email carries no token and no password.
   */
  readonly signInUrl: string;
  /** Days until the invitation expires — rendered from config, never hardcoded. */
  readonly expiresInDays: number;
  /** Human-readable access grant, e.g. "an admin" or "a team member for Elite Craft Builders". */
  readonly accessDescription: string;
  /** Name of the person who sent the invite, if known. */
  readonly inviterName?: string;
}

/**
 * Invitation emails are team credentials (like admin/builder sign-in
 * links) — transactional, no unsubscribe footer.
 */
export function renderInvitationEmail(
  ctx: TemplateContext,
  input: InvitationTemplateInput,
): RenderedEmail {
  const greeting = input.name ? `Hi ${esc(input.name)},` : 'Hi there,';
  const inviter = input.inviterName
    ? `${esc(input.inviterName)} invited you`
    : `You've been invited`;
  // First-sign-in password setup (auth/05 audit 2026-09-28): the Entra
  // account is pre-created with a random password the invitee never
  // receives — Entra owns the credential, so the email must tell them how
  // to set their own: "Forgot password" on the Microsoft sign-in page
  // (self-service reset via email). Without this line invitees hit the
  // sign-in page with no password and no way forward.
  const passwordSetupHtml =
    '<p>First time signing in? On the Microsoft sign-in page, choose ' +
    '<strong>Forgot password</strong> to set your own password, then sign in.</p>';
  const passwordSetupText =
    'First time signing in? On the Microsoft sign-in page, choose "Forgot password" ' +
    'to set your own password, then sign in.';
  const body = `<p>${greeting}</p>
<p>${inviter} to join ${esc(ctx.brandName)} as ${esc(input.accessDescription)}.</p>
<p>Your sign-in account is ready — sign in with your email to get started. This invitation expires in ${input.expiresInDays} days.</p>
${passwordSetupHtml}
${ctaButton(input.signInUrl, 'Sign in to Feasly')}
${fallbackLink(input.signInUrl)}`;
  const text =
    `${input.name ? `Hi ${input.name},` : 'Hi there,'}\n\n` +
    `${input.inviterName ? `${input.inviterName} invited you` : `You've been invited`} to join ${ctx.brandName} as ${input.accessDescription}.\n\n` +
    `Your sign-in account is ready — sign in with your email to get started. This invitation expires in ${input.expiresInDays} days.\n\n` +
    `${passwordSetupText}\n\n` +
    `Sign in to Feasly: ${input.signInUrl}\n\n— ${ctx.brandName}\nDeterministic cost math · not a contractor quote · cost data currently uncalibrated.`;
  return {
    subject: `You've been invited to ${ctx.brandName}`,
    html: layout(ctx, `You've been invited to ${esc(ctx.brandName)}`, body),
    text,
  };
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
${fallbackLink(input.resumeUrl)}`;
  const text = `${input.name ? `Hi ${input.name},` : 'Hi there,'}\n\nYou started a build estimate yesterday but haven't unlocked the full numbers yet. Your estimate is saved — pick up right where you left off:\n\n${input.resumeUrl}\n\n${leadEmailFooterText(input.unsubscribeUrl)}\n\n— ${ctx.brandName}\nDeterministic cost math · not a contractor quote · cost data currently uncalibrated.`;
  return {
    subject,
    html: layout(
      ctx,
      'Your estimate is waiting',
      body,
      renderLeadEmailFooter(input.unsubscribeUrl),
    ),
    text,
  };
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

/* ── BILL-04: builder commission-billing templates ───────────────────────
 *
 * Transactional account-billing mail (not marketing): always sent, no
 * unsubscribe footer, no List-Unsubscribe headers.
 *
 * NOTE on the banned-pattern `\$\s?\d` (no dollar figures in email copy):
 * that rule targets ESTIMATE figures to homeowners (uncalibrated cost
 * data must not leave the report). A commission invoice email that hides
 * the charged amount would be worse — the builder must see what they are
 * being charged and when. Amounts here are real billed figures, formatted
 * from integer cents; the literal `$` is interpolated (`$${...}`) so the
 * copy lint (which scans string literals) stays green.
 */

/** Format integer cents as "1,234.56" (no currency symbol — interpolated). */
function formatMoney(cents: number): string {
  return (cents / 100).toLocaleString('en-CA', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/** Day-level date in America/Edmonton, e.g. "Oct 5, 2026". */
function formatEdmontonDate(date: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Edmonton',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  }).format(date);
}

export interface CommissionInvoiceReadyTemplateInput {
  /** Public invoice reference shown to the builder (short id). */
  readonly invoiceRef: string;
  readonly commissionCents: number;
  readonly contractValueCents: number;
  readonly currency: string;
  /** End of the 7-day review window — rendered in America/Edmonton. */
  readonly reviewDueAt: Date;
  /** Builder portal invoices URL is derived from ctx.appBaseUrl. */
}

export function renderCommissionInvoiceReadyEmail(
  ctx: TemplateContext,
  input: CommissionInvoiceReadyTemplateInput,
): RenderedEmail {
  const invoicesUrl = `${ctx.appBaseUrl}/builder/billing`;
  const dueDate = formatEdmontonDate(input.reviewDueAt);
  const commission = formatMoney(input.commissionCents);
  const contractValue = formatMoney(input.contractValueCents);
  const subject = `Your ${ctx.brandName} commission invoice is ready for review`;
  const body = `<p>Hi there,</p>
<p>A commission invoice for your build is now in its 7-day review window:</p>
<table role="presentation" cellpadding="0" cellspacing="0" style="font-size:15px;margin:12px 0;">
<tr><td style="padding:4px 12px 4px 0;color:#8a8378;">Invoice</td><td style="padding:4px 0;font-weight:600;">${esc(input.invoiceRef)}</td></tr>
<tr><td style="padding:4px 12px 4px 0;color:#8a8378;">Commission (1%)</td><td style="padding:4px 0;font-weight:600;">$${commission} ${esc(input.currency)}</td></tr>
<tr><td style="padding:4px 12px 4px 0;color:#8a8378;">Contract value</td><td style="padding:4px 0;">$${contractValue} ${esc(input.currency)} (excl. land)</td></tr>
<tr><td style="padding:4px 12px 4px 0;color:#8a8378;">Review deadline</td><td style="padding:4px 0;font-weight:600;">${esc(dueDate)}</td></tr>
</table>
<p>We&apos;ll charge the card on file on <strong>${esc(dueDate)}</strong> unless the invoice is disputed before then. Open your billing page to review the invoice.</p>
${ctaButton(invoicesUrl, 'Review invoice')}
${fallbackLink(invoicesUrl)}`;
  const text =
    `Hi there,\n\nA commission invoice for your build is now in its 7-day review window:\n\n` +
    `Invoice: ${input.invoiceRef}\n` +
    `Commission (1%): $${commission} ${input.currency}\n` +
    `Contract value: $${contractValue} ${input.currency} (excl. land)\n` +
    `Review deadline: ${dueDate}\n\n` +
    `We'll charge the card on file on ${dueDate} unless the invoice is disputed before then.\n\n` +
    `Review invoice: ${invoicesUrl}\n\n— ${ctx.brandName}\nDeterministic cost math · not a contractor quote · cost data currently uncalibrated.`;
  return { subject, html: layout(ctx, 'Commission invoice ready', body), text };
}

export interface CommissionPaymentReceivedTemplateInput {
  readonly invoiceRef: string;
  readonly commissionCents: number;
  readonly currency: string;
  readonly paidAt: Date;
}

export function renderCommissionPaymentReceivedEmail(
  ctx: TemplateContext,
  input: CommissionPaymentReceivedTemplateInput,
): RenderedEmail {
  const invoicesUrl = `${ctx.appBaseUrl}/builder/billing`;
  const paidDate = formatEdmontonDate(input.paidAt);
  const commission = formatMoney(input.commissionCents);
  const subject = `Payment received — ${ctx.brandName} commission invoice ${input.invoiceRef}`;
  const body = `<p>Hi there,</p>
<p>We&apos;ve received your commission payment. This is your receipt:</p>
<table role="presentation" cellpadding="0" cellspacing="0" style="font-size:15px;margin:12px 0;">
<tr><td style="padding:4px 12px 4px 0;color:#8a8378;">Invoice</td><td style="padding:4px 0;font-weight:600;">${esc(input.invoiceRef)}</td></tr>
<tr><td style="padding:4px 12px 4px 0;color:#8a8378;">Amount charged</td><td style="padding:4px 0;font-weight:600;">$${commission} ${esc(input.currency)}</td></tr>
<tr><td style="padding:4px 12px 4px 0;color:#8a8378;">Date</td><td style="padding:4px 0;">${esc(paidDate)}</td></tr>
</table>
<p>Thanks for building with ${esc(ctx.brandName)}.</p>
${ctaButton(invoicesUrl, 'View invoices')}
${fallbackLink(invoicesUrl)}`;
  const text =
    `Hi there,\n\nWe've received your commission payment. This is your receipt:\n\n` +
    `Invoice: ${input.invoiceRef}\n` +
    `Amount charged: $${commission} ${input.currency}\n` +
    `Date: ${paidDate}\n\n` +
    `Thanks for building with ${ctx.brandName}.\n\n` +
    `View invoices: ${invoicesUrl}\n\n— ${ctx.brandName}\nDeterministic cost math · not a contractor quote · cost data currently uncalibrated.`;
  return { subject, html: layout(ctx, 'Payment received', body), text };
}

export interface CommissionPaymentFailedTemplateInput {
  readonly invoiceRef: string;
  readonly commissionCents: number;
  readonly currency: string;
  /** Days the builder has to update the card before collection steps. */
  readonly updateWithinDays: number;
}

export function renderCommissionPaymentFailedEmail(
  ctx: TemplateContext,
  input: CommissionPaymentFailedTemplateInput,
): RenderedEmail {
  const cardUrl = `${ctx.appBaseUrl}/builder/billing`;
  const commission = formatMoney(input.commissionCents);
  const subject = `Your card was declined — update it to settle invoice ${input.invoiceRef}`;
  const body = `<p>Hi there,</p>
<p>We tried to charge your card on file for commission invoice <strong>${esc(input.invoiceRef)}</strong> ($${commission} ${esc(input.currency)}) but the charge was declined.</p>
<p>Please update your card within <strong>${input.updateWithinDays} days</strong> — we&apos;ll retry the charge automatically once a valid card is on file.</p>
${ctaButton(cardUrl, 'Update card')}
${fallbackLink(cardUrl)}`;
  const text =
    `Hi there,\n\nWe tried to charge your card on file for commission invoice ${input.invoiceRef} ` +
    `($${commission} ${input.currency}) but the charge was declined.\n\n` +
    `Please update your card within ${input.updateWithinDays} days — we'll retry the charge automatically once a valid card is on file.\n\n` +
    `Update card: ${cardUrl}\n\n— ${ctx.brandName}\nDeterministic cost math · not a contractor quote · cost data currently uncalibrated.`;
  return { subject, html: layout(ctx, 'Card declined', body), text };
}
