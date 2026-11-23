/**
 * Finalized transactional email templates (story email/01).
 *
 * Pure render functions: every template takes a `TemplateContext` carrying
 * the URLs (app base, unsubscribe base) so no URL is ever hardcoded here —
 * the layer-boundary test forbids URL literals in services/. Copy rules:
 *   - magic-link: single CTA, states the expiry, plain-text fallback.
 *     The consumer variant is the report email (#703): names the property,
 *     lists what the report holds, states the real (reusable-until-expiry)
 *     link rules. Consumer magic-link emails carry the unsubscribe footer
 *     (admin/builder sign-in links are team credentials — no footer).
 *   - share: carries the partner's FRESH bearer share URL — never the
 *     owner's magic link. No dollar figures in email copy, ever. The
 *     recipient is not a lead (one-off, owner-initiated) — no footer.
 *   - follow-up (#703, non-transactional): same footer + headers as nudge.
 *   - nudge (non-transactional): unsubscribe footer via
 *     renderLeadEmailFooter; the service also sets List-Unsubscribe headers.
 *   - callback-team / ops-alert: internal team mail — no footer.
 *   - every template: banned-phrase clean (see banned-patterns.txt) and a
 *     trust footer noting deterministic math + uncalibrated cost data.
 */

import {
  PRESALE_TIMELINE_NOTE,
  formatPhaseRange,
  formatTimelineTotal,
  type BuildTimeline,
} from '../../lib/build-timeline';

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
  /**
   * #823: typical build timeline for the served city. When present, the
   * consumer report email for a NEW-BUILD estimate carries a compact
   * timeline block (see `MagicLinkTemplateInput.projectType`).
   */
  readonly buildTimeline?: BuildTimeline;
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
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light only"><meta name="supported-color-schemes" content="light only"></head>
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
  /**
   * #703 (consumer only): display address of the property the report is
   * for, e.g. "1412 Prospect Av SW". Named in the subject and body.
   */
  readonly address?: string;
  /**
   * #703 (consumer only): when the link stops working — the stored
   * `expires_at` of the issued token. Rendered as a date
   * (America/Edmonton); falls back to `expiresInDays` when absent.
   */
  readonly expiresOn?: Date;
  /**
   * #823 (consumer only): the estimate's project type. The typical
   * new-build timeline renders only for `'new_build'` — renovation reports
   * hide the timeline section on the web, so their email must too. Absent
   * (unknown) → no timeline block.
   */
  readonly projectType?: string;
  /**
   * #785 (consumer only): "Schools for this address" + "Living near this
   * lot", from the same stored data the web report reads. Absent → both
   * sections are left out; an empty list hides its own section.
   */
  readonly neighbourhood?: ReportNeighbourhoodSummary;
}

/** #785: the report email's neighbourhood sections (no dollar figures). */
export interface ReportNeighbourhoodSummary {
  /** The address's community as the City names it; null when unknown. */
  readonly communityName: string | null;
  /** Typically designated schools, board then grade-band order. */
  readonly schools: readonly {
    readonly boardName: string;
    readonly gradeBand: string;
    readonly schoolName: string;
  }[];
  /** Each board's address lookup page — confirm the exact address there. */
  readonly boardLookups: readonly { readonly name: string; readonly lookupUrl: string }[];
  /** Nearest amenity per category (only categories with one on file). */
  readonly amenities: readonly {
    readonly label: string;
    readonly nearestName: string;
    readonly distanceM: number;
  }[];
  readonly treeCover: { readonly level: 'low' | 'moderate' | 'high'; readonly treesPerHa: number } | null;
}

const SCHOOLS_TITLE = 'Schools for this address';
const SCHOOLS_NOTE =
  'These schools are typically designated for this community. Designations can vary by address and change from year to year, so confirm with the board before you decide.';
const LIVING_TITLE = 'Living near this lot';
const LIVING_NOTE =
  'Straight-line distances from the community centre, not travel times. From City of Calgary open data, refreshed monthly.';
const FIND_COMMUNITY_LABEL = 'Find a community';
const FIND_COMMUNITY_LEAD = 'Weighing other areas? Compare established communities side by side.';
/** Web route of the find-a-community page (joined to the app base URL). */
const FIND_COMMUNITY_PATH = '/find-a-community';
const TREE_LEVEL_LABEL: Record<'low' | 'moderate' | 'high', string> = {
  low: 'Low',
  moderate: 'Moderate',
  high: 'High',
};

/** "350 m" under a kilometre, "1.2 km" above. */
function formatDistance(m: number): string {
  return m < 1_000 ? `${Math.round(m)} m` : `${(m / 1_000).toFixed(1)} km`;
}

/**
 * #785: "Schools for this address" + "Living near this lot" + the "Find a
 * community" link. Each section hides when its data is missing (no empty
 * boxes); with neither on file the whole block (link included) is empty.
 */
function renderNeighbourhoodBlock(
  ctx: TemplateContext,
  n: ReportNeighbourhoodSummary | undefined,
): { html: string; text: string } {
  if (!n) return { html: '', text: '' };
  const htmlParts: string[] = [];
  const textParts: string[] = [];
  if (n.schools.length > 0) {
    const rows = n.schools
      .map(
        (s) =>
          `<tr><td style="padding:4px 12px 4px 0;color:#5c574f;white-space:nowrap;">${esc(s.gradeBand)}</td><td style="padding:4px 12px 4px 0;">${esc(s.schoolName)}</td><td style="padding:4px 0;color:#5c574f;">${esc(s.boardName)}</td></tr>`,
      )
      .join('\n');
    const lookups = n.boardLookups
      .map((b) => `<a href="${esc(b.lookupUrl)}" style="color:#b08d3e;">${esc(b.name)}</a>`)
      .join(' &middot; ');
    htmlParts.push(`<h2 style="font-size:16px;margin:20px 0 4px;color:#232323;">${esc(SCHOOLS_TITLE)}</h2>
<p style="font-size:14px;color:#5c574f;margin:0 0 8px;">${esc(SCHOOLS_NOTE)}</p>
<table role="presentation" cellpadding="0" cellspacing="0" style="font-size:14px;margin:0 0 8px;">
${rows}
</table>${lookups ? `\n<p style="font-size:14px;margin:0 0 12px;">Confirm your address: ${lookups}</p>` : ''}`);
    textParts.push(
      `${SCHOOLS_TITLE}\n${SCHOOLS_NOTE}\n` +
        n.schools.map((s) => `- ${s.gradeBand}: ${s.schoolName} (${s.boardName})`).join('\n') +
        (n.boardLookups.length > 0
          ? '\nConfirm your address:\n' + n.boardLookups.map((b) => `- ${b.name}: ${b.lookupUrl}`).join('\n')
          : ''),
    );
  }
  if (n.amenities.length > 0 || n.treeCover) {
    const lines = n.amenities.map((a) => ({
      label: a.label,
      value: `${a.nearestName}, about ${formatDistance(a.distanceM)}`,
    }));
    if (n.treeCover) {
      lines.push({
        label: 'Public tree cover',
        value: `${TREE_LEVEL_LABEL[n.treeCover.level]} (${Math.round(n.treeCover.treesPerHa)} City trees per hectare)`,
      });
    }
    const rows = lines
      .map(
        (l) =>
          `<tr><td style="padding:4px 12px 4px 0;color:#5c574f;">${esc(l.label)}</td><td style="padding:4px 0;">${esc(l.value)}</td></tr>`,
      )
      .join('\n');
    const where = n.communityName ? ` (${n.communityName})` : '';
    htmlParts.push(`<h2 style="font-size:16px;margin:20px 0 4px;color:#232323;">${esc(LIVING_TITLE + where)}</h2>
<table role="presentation" cellpadding="0" cellspacing="0" style="font-size:14px;margin:0 0 8px;">
${rows}
</table>
<p style="font-size:14px;color:#5c574f;margin:0 0 12px;">${esc(LIVING_NOTE)}</p>`);
    textParts.push(
      `${LIVING_TITLE}${where}\n` + lines.map((l) => `- ${l.label}: ${l.value}`).join('\n') + `\n${LIVING_NOTE}`,
    );
  }
  if (htmlParts.length === 0) return { html: '', text: '' };
  const findUrl = `${ctx.appBaseUrl}${FIND_COMMUNITY_PATH}`;
  htmlParts.push(
    `<p style="font-size:14px;margin:0 0 12px;">${esc(FIND_COMMUNITY_LEAD)} <a href="${esc(findUrl)}" style="color:#b08d3e;font-weight:600;">${esc(FIND_COMMUNITY_LABEL)}</a></p>`,
  );
  textParts.push(`${FIND_COMMUNITY_LEAD}\n${FIND_COMMUNITY_LABEL}: ${findUrl}`);
  return { html: htmlParts.join('\n') + '\n', text: textParts.join('\n\n') };
}

const TRUST_LINE_TEXT =
  'Deterministic cost math · not a contractor quote · cost data currently uncalibrated.';

const TIMELINE_TITLE = 'Typical new-build timeline';

/**
 * #823: compact "typical" timeline block for the consumer report email —
 * total, phases, the pre-sale note. Typical ranges, never a promise; no
 * dollar figures. Empty strings when no timeline is configured.
 */
function renderTimelineBlock(timeline: BuildTimeline | undefined): {
  html: string;
  text: string;
} {
  if (!timeline || timeline.phases.length === 0) {
    return { html: '', text: '' };
  }
  const total = formatTimelineTotal(timeline);
  const rows = timeline.phases
    .map(
      (p) =>
        `<tr><td style="padding:4px 12px 4px 0;">${esc(p.label)}</td><td style="padding:4px 0;color:#5c574f;white-space:nowrap;">${esc(formatPhaseRange(p))}</td></tr>`,
    )
    .join('\n');
  const html = `<h2 style="font-size:16px;margin:20px 0 4px;color:#232323;">${esc(TIMELINE_TITLE)}</h2>
<p style="margin:0 0 8px;font-weight:600;">${esc(total)}</p>
<table role="presentation" cellpadding="0" cellspacing="0" style="font-size:14px;margin:0 0 8px;">
${rows}
</table>
<p style="font-size:14px;color:#5c574f;margin:0 0 12px;">${esc(PRESALE_TIMELINE_NOTE)}</p>`;
  const text =
    `${TIMELINE_TITLE}\n${total}\n` +
    timeline.phases.map((p) => `- ${p.label}: ${formatPhaseRange(p)}`).join('\n') +
    `\n${PRESALE_TIMELINE_NOTE}`;
  return { html, text };
}

/**
 * Consumer report email (#703). Names the property, lists what the report
 * holds, and states the REAL link rules: the owner link is a reusable
 * bearer handle until it expires (`isMagicLinkLive` ignores `used_at`), so
 * the copy says "open it as often as you like" — never "only once". No
 * dollar figures (banned-patterns.txt).
 */
function renderConsumerReportEmail(
  ctx: TemplateContext,
  input: MagicLinkTemplateInput,
): RenderedEmail {
  const address = input.address?.trim() ? input.address.trim() : undefined;
  const subject = address
    ? `Your estimate for ${address}`
    : `Your ${ctx.brandName} estimate is ready`;
  const until = input.expiresOn
    ? `until ${formatEdmontonDate(input.expiresOn)}`
    : `for ${input.expiresInDays} days`;
  const ctaLabel = 'View my estimate';
  const greetingText = input.name ? `Hi ${input.name},` : 'Hi there,';
  const greetingHtml = input.name ? `Hi ${esc(input.name)},` : 'Hi there,';
  const introText = address
    ? `Your build-cost estimate for ${address} is ready.`
    : 'Your build-cost estimate is ready.';
  const introHtml = address
    ? `Your build-cost estimate for <strong>${esc(address)}</strong> is ready.`
    : 'Your build-cost estimate is ready.';
  const contents = [
    'The estimated cost range for your build',
    'A line-by-line cost breakdown',
    'Next steps, including how to talk to a builder',
  ];
  const linkRules = `This link works ${until}. You can open it as often as you like, on any device.`;
  const freshLink =
    'After that, open the same link and enter your email address — we will send you a fresh one.';
  const timeline = renderTimelineBlock(
    input.projectType === 'new_build' ? ctx.buildTimeline : undefined,
  );
  const neighbourhood = renderNeighbourhoodBlock(ctx, input.neighbourhood);
  const body = `<p>${greetingHtml}</p>
<p>${introHtml}</p>
<p style="margin:0 0 4px;">Your report includes:</p>
<ul style="margin:0 0 12px;padding-left:20px;">
${contents.map((c) => `<li>${esc(c)}</li>`).join('\n')}
</ul>
${ctaButton(input.magicLinkUrl, ctaLabel)}
<p>${esc(linkRules)}</p>
<p style="font-size:14px;color:#5c574f;">${esc(freshLink)}</p>
${timeline.html}${neighbourhood.html}${fallbackLink(input.magicLinkUrl)}`;
  const footerUrl = input.unsubscribeUrl;
  const text =
    `${greetingText}\n\n${introText}\n\nYour report includes:\n` +
    contents.map((c) => `- ${c}`).join('\n') +
    `\n\n${ctaLabel}: ${input.magicLinkUrl}\n\n${linkRules}\n${freshLink}` +
    (timeline.text ? `\n\n${timeline.text}` : '') +
    (neighbourhood.text ? `\n\n${neighbourhood.text}` : '') +
    `\n\n— ${ctx.brandName}\n${TRUST_LINE_TEXT}` +
    (footerUrl ? `\n\n${leadEmailFooterText(footerUrl)}` : '');
  return {
    subject,
    html: layout(
      ctx,
      address ? `Your estimate for ${esc(address)}` : 'Your estimate is ready',
      body,
      footerUrl ? renderLeadEmailFooter(footerUrl) : undefined,
    ),
    text,
  };
}

/**
 * Consumer magic-link emails are the report email (#703) and carry the
 * unsubscribe footer; admin/builder sign-in links do not. Builder links
 * ARE single-use (`markUsed` on verify), so their copy keeps that line.
 */
export function renderMagicLinkEmail(
  ctx: TemplateContext,
  input: MagicLinkTemplateInput,
): RenderedEmail {
  if (input.audience === 'consumer') {
    return renderConsumerReportEmail(ctx, input);
  }
  const greeting = input.name ? `Hi ${esc(input.name)},` : 'Hi there,';
  const isAdmin = input.audience === 'admin';
  const subject = isAdmin
    ? `Your ${ctx.brandName} admin sign-in link`
    : `Your ${ctx.brandName} builder dashboard sign-in link`;
  const ctaLabel = isAdmin
    ? `Sign in to ${ctx.brandName} admin`
    : 'Open builder dashboard';
  const body = `<p>${greeting}</p>
<p>Here's your secure sign-in link. It expires in ${input.expiresInDays} days and can only be used once.</p>
${ctaButton(input.magicLinkUrl, ctaLabel)}
${fallbackLink(input.magicLinkUrl)}`;
  const text = `${input.name ? `Hi ${input.name},` : 'Hi there,'}\n\nHere's your secure sign-in link. It expires in ${input.expiresInDays} days and can only be used once.\n\n${ctaLabel}: ${input.magicLinkUrl}\n\n— ${ctx.brandName}\n${TRUST_LINE_TEXT}`;
  return {
    subject,
    html: layout(ctx, 'Your secure sign-in link', body),
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

export interface ErasureConfirmationTemplateInput {
  readonly name?: string;
  /**
   * `${appBaseUrl}/privacy/confirm/${requestId}#token=${token}` — minted by
   * the privacy service. The token rides in the fragment so it never
   * reaches a server log.
   */
  readonly confirmUrl: string;
  /** Hours until the confirm link expires — from config, never hardcoded. */
  readonly expiresInHours: number;
}

/**
 * #806: step 2 of self-service erasure (owner decision on #706: deletion
 * with email confirmation). Transactional — the person asked for it — so
 * no unsubscribe footer. Nothing is deleted until the link is clicked and
 * the landing page's button is pressed.
 */
export function renderErasureConfirmationEmail(
  ctx: TemplateContext,
  input: ErasureConfirmationTemplateInput,
): RenderedEmail {
  const greeting = input.name ? `Hi ${esc(input.name)},` : 'Hi there,';
  const hours = `${input.expiresInHours} hour${input.expiresInHours === 1 ? '' : 's'}`;
  const subject = `Confirm you want to delete your ${ctx.brandName} data`;
  const body = `<p>${greeting}</p>
<p>We got a request to delete the data ${esc(ctx.brandName)} holds about you. Nothing has been deleted yet.</p>
<p>To go ahead, open this link and confirm. The link expires in ${hours}.</p>
${ctaButton(input.confirmUrl, 'Review and confirm deletion')}
${fallbackLink(input.confirmUrl)}
<p style="font-size:13px;color:#8a8378;">Didn't ask for this? Ignore this email and your data stays as it is.</p>`;
  const text = `${input.name ? `Hi ${input.name},` : 'Hi there,'}\n\nWe got a request to delete the data ${ctx.brandName} holds about you. Nothing has been deleted yet.\n\nTo go ahead, open this link and confirm (the link expires in ${hours}):\n${input.confirmUrl}\n\nDidn't ask for this? Ignore this email and your data stays as it is.\n\n— ${ctx.brandName}`;
  return { subject, html: layout(ctx, 'Confirm your data deletion', body), text };
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
<p>You started a build estimate yesterday but haven't opened your full report yet. Your estimate is saved — pick up right where you left off.</p>
${ctaButton(input.resumeUrl, 'See my full estimate')}
${fallbackLink(input.resumeUrl)}`;
  const text = `${input.name ? `Hi ${input.name},` : 'Hi there,'}\n\nYou started a build estimate yesterday but haven't opened your full report yet. Your estimate is saved — pick up right where you left off:\n\n${input.resumeUrl}\n\n${leadEmailFooterText(input.unsubscribeUrl)}\n\n— ${ctx.brandName}\nDeterministic cost math · not a contractor quote · cost data currently uncalibrated.`;
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

export interface FollowUpTemplateInput {
  readonly name?: string;
  /** Display address of the property, e.g. "1412 Prospect Av SW". */
  readonly address?: string;
  /** Owner report URL (fresh owner link). */
  readonly reportUrl: string;
  /** One-click unsubscribe URL (token embedded). */
  readonly unsubscribeUrl: string;
}

/**
 * #703 post-report follow-up. NON-transactional: sent once, a few days
 * after the homeowner first opened their report, only with marketing
 * consent; carries the one-click unsubscribe footer (and the service sets
 * List-Unsubscribe headers). No dollar figures.
 */
export function renderFollowUpEmail(
  ctx: TemplateContext,
  input: FollowUpTemplateInput,
): RenderedEmail {
  const address = input.address?.trim() ? input.address.trim() : undefined;
  const subject = address
    ? `Questions about your estimate for ${address}?`
    : 'Questions about your estimate?';
  const greetingText = input.name ? `Hi ${input.name},` : 'Hi there,';
  const greetingHtml = input.name ? `Hi ${esc(input.name)},` : 'Hi there,';
  const introText = address
    ? `A few days ago you opened your build-cost estimate for ${address}. If anything in it raised questions, there are two easy next steps from your report:`
    : 'A few days ago you opened your build-cost estimate. If anything in it raised questions, there are two easy next steps from your report:';
  const introHtml = address
    ? `A few days ago you opened your build-cost estimate for <strong>${esc(address)}</strong>. If anything in it raised questions, there are two easy next steps from your report:`
    : esc(introText);
  const steps = [
    'Request a callback — a builder can walk you through the numbers.',
    'Adjust your inputs — try a different size or finish level and see how the estimate changes.',
  ];
  const ctaLabel = 'Open my report';
  const body = `<p>${greetingHtml}</p>
<p>${introHtml}</p>
<ul style="margin:0 0 12px;padding-left:20px;">
${steps.map((s) => `<li>${esc(s)}</li>`).join('\n')}
</ul>
${ctaButton(input.reportUrl, ctaLabel)}
${fallbackLink(input.reportUrl)}
<p style="font-size:14px;color:#5c574f;">This is the only follow-up we will send about this estimate.</p>`;
  const text =
    `${greetingText}\n\n${introText}\n\n` +
    steps.map((s) => `- ${s}`).join('\n') +
    `\n\n${ctaLabel}: ${input.reportUrl}\n\nThis is the only follow-up we will send about this estimate.\n\n${leadEmailFooterText(input.unsubscribeUrl)}\n\n— ${ctx.brandName}\n${TRUST_LINE_TEXT}`;
  return {
    subject,
    html: layout(
      ctx,
      'Questions about your estimate?',
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

/** Rate percent label, e.g. 1 → "1%", 1.5 → "1.5%" (no float dust). */
function formatPercent(ratePercent: number): string {
  const rounded = Math.round(ratePercent * 10_000) / 10_000;
  return `${Number(rounded.toFixed(4))}%`;
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

/**
 * #714: sales tax on a commission invoice, for builder emails. When absent
 * the email renders exactly as it did before tax existed.
 */
export interface CommissionEmailTax {
  /** e.g. "GST". */
  readonly label: string;
  /** Snapshotted rate in PERCENT (5 = 5%). */
  readonly ratePercent: number;
  readonly taxCents: number;
  /** Subtotal + tax: the amount charged. */
  readonly totalCents: number;
  /** Supplier GST/HST registration number. */
  readonly registrationNumber: string;
}

const LABEL_TD = 'padding:4px 12px 4px 0;color:#8a8378;';

/** Extra HTML rows + text lines for the tax breakdown (#714). */
function taxRows(
  tax: CommissionEmailTax,
  currency: string,
): { html: string; text: string } {
  const label = `${tax.label} (${formatPercent(tax.ratePercent)})`;
  const amount = `$${formatMoney(tax.taxCents)} ${currency}`;
  const total = `$${formatMoney(tax.totalCents)} ${currency}`;
  return {
    html:
      `<tr><td style="${LABEL_TD}">${esc(label)}</td><td style="padding:4px 0;">${esc(amount)}</td></tr>\n` +
      `<tr><td style="${LABEL_TD}">Total</td><td style="padding:4px 0;font-weight:600;">${esc(total)}</td></tr>\n` +
      `<tr><td style="${LABEL_TD}">${esc(tax.label)} registration</td><td style="padding:4px 0;">${esc(tax.registrationNumber)}</td></tr>\n`,
    text:
      `${label}: ${amount}\n` +
      `Total: ${total}\n` +
      `${tax.label} registration: ${tax.registrationNumber}\n`,
  };
}

export interface CommissionInvoiceReadyTemplateInput {
  /** Public invoice reference shown to the builder (short id). */
  readonly invoiceRef: string;
  readonly commissionCents: number;
  readonly contractValueCents: number;
  readonly currency: string;
  /** Effective commission rate applied to the invoice, in PERCENT. */
  readonly commissionRatePercent: number;
  /** End of the 7-day review window — rendered in America/Edmonton. */
  readonly reviewDueAt: Date;
  readonly tax?: CommissionEmailTax;
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
  const rateLabel = formatPercent(input.commissionRatePercent);
  const tax = input.tax ? taxRows(input.tax, input.currency) : undefined;
  const subject = `Your ${ctx.brandName} commission invoice is ready for review`;
  const body = `<p>Hi there,</p>
<p>A commission invoice for your build is now in its 7-day review window:</p>
<table role="presentation" cellpadding="0" cellspacing="0" style="font-size:15px;margin:12px 0;">
<tr><td style="padding:4px 12px 4px 0;color:#8a8378;">Invoice</td><td style="padding:4px 0;font-weight:600;">${esc(input.invoiceRef)}</td></tr>
<tr><td style="padding:4px 12px 4px 0;color:#8a8378;">Commission (${rateLabel})</td><td style="padding:4px 0;font-weight:600;">$${commission} ${esc(input.currency)}</td></tr>
${tax?.html ?? ''}<tr><td style="padding:4px 12px 4px 0;color:#8a8378;">Contract value</td><td style="padding:4px 0;">$${contractValue} ${esc(input.currency)} (excl. land)</td></tr>
<tr><td style="padding:4px 12px 4px 0;color:#8a8378;">Review deadline</td><td style="padding:4px 0;font-weight:600;">${esc(dueDate)}</td></tr>
</table>
<p>We&apos;ll charge the card on file on <strong>${esc(dueDate)}</strong> unless the invoice is disputed before then. Open your billing page to review the invoice.</p>
${ctaButton(invoicesUrl, 'Review invoice')}
${fallbackLink(invoicesUrl)}`;
  const text =
    `Hi there,\n\nA commission invoice for your build is now in its 7-day review window:\n\n` +
    `Invoice: ${input.invoiceRef}\n` +
    `Commission (${rateLabel}): $${commission} ${input.currency}\n` +
    (tax?.text ?? '') +
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
  readonly tax?: CommissionEmailTax;
}

export function renderCommissionPaymentReceivedEmail(
  ctx: TemplateContext,
  input: CommissionPaymentReceivedTemplateInput,
): RenderedEmail {
  const invoicesUrl = `${ctx.appBaseUrl}/builder/billing`;
  const paidDate = formatEdmontonDate(input.paidAt);
  // #714: the receipt shows the amount actually charged (subtotal + tax)
  // with the breakdown; untaxed receipts are unchanged.
  const commission = formatMoney(input.tax?.totalCents ?? input.commissionCents);
  const subtotal = `$${formatMoney(input.commissionCents)} ${input.currency}`;
  const tax = input.tax ? taxRows(input.tax, input.currency) : undefined;
  const subject = `Payment received — ${ctx.brandName} commission invoice ${input.invoiceRef}`;
  const body = `<p>Hi there,</p>
<p>We&apos;ve received your commission payment. This is your receipt:</p>
<table role="presentation" cellpadding="0" cellspacing="0" style="font-size:15px;margin:12px 0;">
<tr><td style="padding:4px 12px 4px 0;color:#8a8378;">Invoice</td><td style="padding:4px 0;font-weight:600;">${esc(input.invoiceRef)}</td></tr>
<tr><td style="padding:4px 12px 4px 0;color:#8a8378;">Amount charged</td><td style="padding:4px 0;font-weight:600;">$${commission} ${esc(input.currency)}</td></tr>
${tax ? `<tr><td style="${LABEL_TD}">Commission</td><td style="padding:4px 0;">${esc(subtotal)}</td></tr>\n${tax.html}` : ''}<tr><td style="padding:4px 12px 4px 0;color:#8a8378;">Date</td><td style="padding:4px 0;">${esc(paidDate)}</td></tr>
</table>
<p>Thanks for building with ${esc(ctx.brandName)}.</p>
${ctaButton(invoicesUrl, 'View invoices')}
${fallbackLink(invoicesUrl)}`;
  const text =
    `Hi there,\n\nWe've received your commission payment. This is your receipt:\n\n` +
    `Invoice: ${input.invoiceRef}\n` +
    `Amount charged: $${commission} ${input.currency}\n` +
    (tax ? `Commission: ${subtotal}\n${tax.text}` : '') +
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
  /**
   * #718: when the next automatic retry runs (rendered in
   * America/Edmonton). Omitted/null = no retry scheduled.
   */
  readonly nextRetryAt?: Date | null;
  /**
   * #718: the retry budget (BILLING_MAX_CHARGE_RETRIES) is used up — the
   * final notice. Builder Pay now attempts count toward that budget, so
   * the copy never claims the failed attempt itself was automatic.
   */
  readonly finalNotice?: boolean;
  /** 'chargeback_lost' renders the #873 "payment reversed" variant. */
  readonly reason?: 'declined' | 'chargeback_lost';
  readonly tax?: CommissionEmailTax;
}

/**
 * #718 dunning copy: what happens next after a declined charge. Plain
 * facts only — the date of the next automatic attempt, or that there is
 * none — and the builder's one action (update the card, Pay now).
 */
function paymentFailedNextStep(
  input: CommissionPaymentFailedTemplateInput,
): { html: string; text: string } {
  if (input.finalNotice === true) {
    const line =
      "We won't try this charge again automatically. Please update your card and choose Pay now on your billing page to settle the invoice.";
    return { html: `<p>${esc(line)}</p>`, text: line };
  }
  if (input.nextRetryAt) {
    const date = formatEdmontonDate(input.nextRetryAt);
    return {
      html: `<p>We&apos;ll try the charge again on <strong>${esc(date)}</strong>. To settle it sooner, update your card and choose Pay now on your billing page.</p>`,
      text: `We'll try the charge again on ${date}. To settle it sooner, update your card and choose Pay now on your billing page.`,
    };
  }
  if (input.nextRetryAt === null) {
    const line =
      'Please update your card and choose Pay now on your billing page to settle the invoice.';
    return { html: `<p>${esc(line)}</p>`, text: line };
  }
  return {
    html: `<p>Please update your card within <strong>${input.updateWithinDays} days</strong> — we&apos;ll retry the charge automatically once a valid card is on file.</p>`,
    text: `Please update your card within ${input.updateWithinDays} days — we'll retry the charge automatically once a valid card is on file.`,
  };
}

export function renderCommissionPaymentFailedEmail(
  ctx: TemplateContext,
  input: CommissionPaymentFailedTemplateInput,
): RenderedEmail {
  const cardUrl = `${ctx.appBaseUrl}/builder/billing`;
  // #714: the declined amount is what we tried to charge (incl. tax).
  const commission = formatMoney(input.tax?.totalCents ?? input.commissionCents);
  if (input.reason === 'chargeback_lost') {
    return renderChargebackLostEmail(
      ctx,
      input.invoiceRef,
      commission,
      input.currency,
      cardUrl,
      input.nextRetryAt,
    );
  }
  const subject =
    input.finalNotice === true
      ? `Final notice: invoice ${input.invoiceRef} is unpaid`
      : `Your card was declined — update it to settle invoice ${input.invoiceRef}`;
  const next = paymentFailedNextStep(input);
  const body = `<p>Hi there,</p>
<p>We tried to charge your card on file for commission invoice <strong>${esc(input.invoiceRef)}</strong> ($${commission} ${esc(input.currency)}) but the charge was declined.</p>
${next.html}
${ctaButton(cardUrl, input.finalNotice === true ? 'Pay now' : 'Update card')}
${fallbackLink(cardUrl)}`;
  const text =
    `Hi there,\n\nWe tried to charge your card on file for commission invoice ${input.invoiceRef} ` +
    `($${commission} ${input.currency}) but the charge was declined.\n\n` +
    `${next.text}\n\n` +
    `Update card: ${cardUrl}\n\n— ${ctx.brandName}\nDeterministic cost math · not a contractor quote · cost data currently uncalibrated.`;
  return {
    subject,
    html: layout(ctx, input.finalNotice === true ? 'Final notice' : 'Card declined', body),
    text,
  };
}

/* ── #718: a manual-method invoice (cheque, e-transfer, bank draft) is past
 * its due date (review window end + the invoice's grace period). Sent once.
 */

export interface CommissionInvoiceOverdueTemplateInput {
  readonly invoiceRef: string;
  readonly commissionCents: number;
  readonly currency: string;
  /** Due date — rendered in America/Edmonton. */
  readonly dueAt: Date;
  readonly tax?: CommissionEmailTax;
}

export function renderCommissionInvoiceOverdueEmail(
  ctx: TemplateContext,
  input: CommissionInvoiceOverdueTemplateInput,
): RenderedEmail {
  const invoicesUrl = `${ctx.appBaseUrl}/builder/billing`;
  const dueDate = formatEdmontonDate(input.dueAt);
  const amount = formatMoney(input.tax?.totalCents ?? input.commissionCents);
  const subject = `Invoice ${input.invoiceRef} is past due`;
  const body = `<p>Hi there,</p>
<p>Commission invoice <strong>${esc(input.invoiceRef)}</strong> ($${amount} ${esc(input.currency)}) was due on <strong>${esc(dueDate)}</strong> and we haven&apos;t recorded your payment yet.</p>
<p>If you&apos;ve already sent it, thank you — you can ignore this email. Otherwise, please send your payment, or open your billing page to switch this invoice to your card on file.</p>
${ctaButton(invoicesUrl, 'View invoice')}
${fallbackLink(invoicesUrl)}`;
  const text =
    `Hi there,\n\nCommission invoice ${input.invoiceRef} ($${amount} ${input.currency}) was due on ${dueDate} ` +
    `and we haven't recorded your payment yet.\n\n` +
    `If you've already sent it, thank you — you can ignore this email. Otherwise, please send your payment, ` +
    `or open your billing page to switch this invoice to your card on file.\n\n` +
    `View invoice: ${invoicesUrl}\n\n— ${ctx.brandName}\nDeterministic cost math · not a contractor quote · cost data currently uncalibrated.`;
  return { subject, html: layout(ctx, 'Payment past due', body), text };
}

/**
 * #873: Stripe closed a bank chargeback as lost — the builder's bank took
 * the commission payment back, but the commission is still owed (owner
 * decision 2026-11-15), so the invoice is unpaid again and goes through
 * normal collection. `nextRetryAt === null` = no automatic retry is
 * scheduled (e.g. every allowed retry is used up, #977), so the copy asks
 * the builder to choose Pay now instead of promising another attempt.
 */
function renderChargebackLostEmail(
  ctx: TemplateContext,
  invoiceRef: string,
  commission: string,
  currency: string,
  billingUrl: string,
  nextRetryAt: Date | null | undefined,
): RenderedEmail {
  const subject = `Your bank reversed a payment — invoice ${invoiceRef} is unpaid again`;
  const payNow = nextRetryAt === null;
  const nextStep = payNow
    ? 'Please check that your card on file is up to date, then choose Pay now on your billing page to settle the invoice.'
    : "Please check that your card on file is up to date. We'll collect the payment again from it.";
  const cta = payNow ? 'Pay now' : 'Review invoice';
  const body = `<p>Hi there,</p>
<p>Your bank reversed your card payment for commission invoice <strong>${esc(invoiceRef)}</strong> ($${commission} ${esc(currency)}) after a chargeback. The commission is still owed, so the invoice is now unpaid.</p>
<p>${esc(nextStep)}</p>
${ctaButton(billingUrl, cta)}
${fallbackLink(billingUrl)}`;
  const text =
    `Hi there,\n\nYour bank reversed your card payment for commission invoice ${invoiceRef} ` +
    `($${commission} ${currency}) after a chargeback. The commission is still owed, so the invoice is now unpaid.\n\n` +
    `${nextStep}\n\n` +
    `${cta}: ${billingUrl}\n\n— ${ctx.brandName}\nDeterministic cost math · not a contractor quote · cost data currently uncalibrated.`;
  return { subject, html: layout(ctx, 'Payment reversed', body), text };
}

/* ── #712: the bank wants the builder to confirm the charge (3DS / SCA) ──
 *
 * Sent once when an off-session charge comes back `requires_action`. Not a
 * decline: the card is fine, the bank just needs the cardholder to approve
 * the payment. The CTA opens the invoice in the builder portal, where the
 * "Confirm payment with your bank" step runs.
 */

export interface CommissionPaymentActionRequiredTemplateInput {
  /** Invoice id — deep-links the invoice drawer. */
  readonly invoiceId: string;
  readonly invoiceRef: string;
  readonly commissionCents: number;
  readonly currency: string;
  readonly tax?: CommissionEmailTax;
}

export function renderCommissionPaymentActionRequiredEmail(
  ctx: TemplateContext,
  input: CommissionPaymentActionRequiredTemplateInput,
): RenderedEmail {
  const invoiceUrl = `${ctx.appBaseUrl}/builder/invoices?open=${encodeURIComponent(input.invoiceId)}`;
  // #714: the amount awaiting confirmation is what we are charging (incl. tax).
  const commission = formatMoney(input.tax?.totalCents ?? input.commissionCents);
  const subject = `Your bank needs you to confirm this payment — invoice ${input.invoiceRef}`;
  const body = `<p>Hi there,</p>
<p>We tried to charge your card on file for commission invoice <strong>${esc(input.invoiceRef)}</strong> ($${commission} ${esc(input.currency)}). Your bank needs you to confirm this payment before it goes through.</p>
<p>Your card was not declined. Open the invoice and choose <strong>Confirm payment with your bank</strong> to finish.</p>
${ctaButton(invoiceUrl, 'Confirm payment')}
${fallbackLink(invoiceUrl)}`;
  const text =
    `Hi there,\n\nWe tried to charge your card on file for commission invoice ${input.invoiceRef} ` +
    `($${commission} ${input.currency}). Your bank needs you to confirm this payment before it goes through.\n\n` +
    `Your card was not declined. Open the invoice and choose "Confirm payment with your bank" to finish.\n\n` +
    `Confirm payment: ${invoiceUrl}\n\n— ${ctx.brandName}\nDeterministic cost math · not a contractor quote · cost data currently uncalibrated.`;
  return { subject, html: layout(ctx, 'Confirm your payment', body), text };
}

/* ── #880: one-time "your card expires soon" reminder ───────────────────
 *
 * Sent once per saved card (dedupe by payment method id) to the builder
 * org's admins when the card first enters the expiry warning window. The
 * CTA opens portal Billing, where "Replace card" saves a new card. Account
 * notice — no unsubscribe footer, no figures.
 */

export interface CardExpiryReminderTemplateInput {
  readonly businessName: string;
  /** Card brand as the provider reports it (`visa`, `mastercard`, …). */
  readonly brand: string;
  readonly last4: string;
  /** 1-12. */
  readonly expMonth: number;
  readonly expYear: number;
}

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

function cardBrandLabel(brand: string): string {
  const known: Record<string, string> = {
    visa: 'Visa',
    mastercard: 'Mastercard',
    amex: 'American Express',
    discover: 'Discover',
    jcb: 'JCB',
    diners: 'Diners Club',
    unionpay: 'UnionPay',
  };
  const key = brand.trim().toLowerCase();
  return known[key] ?? (key ? key.charAt(0).toUpperCase() + key.slice(1) : 'card');
}

export function renderCardExpiryReminderEmail(
  ctx: TemplateContext,
  input: CardExpiryReminderTemplateInput,
): RenderedEmail {
  const billingUrl = `${ctx.appBaseUrl}/builder/billing`;
  const brand = cardBrandLabel(input.brand);
  const month = MONTH_NAMES[input.expMonth - 1] ?? `month ${input.expMonth}`;
  const expiry = `${month} ${input.expYear}`;
  const subject = `Your ${brand} ending in ${input.last4} expires soon — replace your card`;
  const body = `<p>Hi there,</p>
<p>The ${esc(brand)} ending in <strong>${esc(input.last4)}</strong> that ${esc(input.businessName)} keeps on file with ${esc(ctx.brandName)} expires at the end of <strong>${esc(expiry)}</strong>.</p>
<p>Commission invoices are charged to this card. To keep payments going through, sign in to your builder portal, open <strong>Billing</strong> and choose <strong>Replace card</strong>.</p>
<p>This is a one-time reminder for this card.</p>
${ctaButton(billingUrl, 'Replace card')}
${fallbackLink(billingUrl)}`;
  const text =
    `Hi there,\n\nThe ${brand} ending in ${input.last4} that ${input.businessName} keeps on file with ${ctx.brandName} ` +
    `expires at the end of ${expiry}.\n\n` +
    `Commission invoices are charged to this card. To keep payments going through, sign in to your builder portal, ` +
    `open Billing and choose "Replace card".\n\nThis is a one-time reminder for this card.\n\n` +
    `Replace card: ${billingUrl}\n\n— ${ctx.brandName}`;
  return { subject, html: layout(ctx, 'Your card expires soon', body), text };
}

/* ── Issue #530: "Mark won" → admin asked to record the contract ─────────
 *
 * Transactional org notice to a builder admin: a teammate marked a lead
 * won, and only admins can record the signed contract. No figures, no
 * unsubscribe footer (account notice, not marketing).
 */

export interface ContractNeedsRecordingTemplateInput {
  /** Display name (or email) of the teammate who marked the lead won. */
  readonly markedBy: string;
  /** The homeowner lead's name, as shown in the builder portal. */
  readonly leadName: string;
  /** The lead's property address key, as shown in the builder portal. */
  readonly address: string;
  /** Builder org display name. */
  readonly builderName: string;
  /** Lead id — deep-links the record-contract form to this lead. */
  readonly leadId: string;
}

export function renderContractNeedsRecordingEmail(
  ctx: TemplateContext,
  input: ContractNeedsRecordingTemplateInput,
): RenderedEmail {
  const recordUrl = `${ctx.appBaseUrl}/builder/record-contract?lead=${encodeURIComponent(input.leadId)}`;
  const subject = `Needs recording: ${input.leadName} was marked won`;
  const body = `<p>Hi there,</p>
<p><strong>${esc(input.markedBy)}</strong> marked <strong>${esc(input.leadName)}</strong> (${esc(input.address)}) as won for ${esc(input.builderName)}.</p>
<p>Only an admin can record the signed contract. Open the lead to record it and close out the deal.</p>
${ctaButton(recordUrl, 'Record contract')}
${fallbackLink(recordUrl)}`;
  const text =
    `Hi there,\n\n${input.markedBy} marked ${input.leadName} (${input.address}) as won for ${input.builderName}.\n\n` +
    `Only an admin can record the signed contract. Open the lead to record it and close out the deal.\n\n` +
    `Record contract: ${recordUrl}\n\n— ${ctx.brandName}`;
  return { subject, html: layout(ctx, 'Needs recording', body), text };
}

/* ── Issue #725: builder new-lead email + daily "Needs you" digest ───────
 *
 * Transactional org notices to builder team members. Privacy (owner
 * decision 2026-11-15): the lead's FIRST name, community and project type
 * plus a deep link to the lead in the portal — never the homeowner's email,
 * phone or full name, and nothing identifying in the subject line. No
 * figures. No unsubscribe footer (account notice); the member turns these
 * off in their notification preferences, which the footer line says.
 */

const BUILDER_PREFS_NOTE =
  'You get this email because it is turned on in your notification preferences in the builder portal. You can turn it off there.';

export interface BuilderNewLeadTemplateInput {
  /** Homeowner first name only. */
  readonly firstName: string;
  /** Calgary community name (City-assessed), or "Calgary" when unknown. */
  readonly community: string;
  /** Display project type, e.g. "New build" or "Renovation". */
  readonly projectType: string;
  /** Builder org display name. */
  readonly builderName: string;
  /** Lead id — deep-links the portal's lead drawer. */
  readonly leadId: string;
}

/** Portal deep link that opens the lead drawer on this lead. */
export function builderLeadUrl(ctx: TemplateContext, leadId: string): string {
  return `${ctx.appBaseUrl}/builder?open=${encodeURIComponent(leadId)}`;
}

export function renderBuilderNewLeadEmail(
  ctx: TemplateContext,
  input: BuilderNewLeadTemplateInput,
): RenderedEmail {
  const leadUrl = builderLeadUrl(ctx, input.leadId);
  // Subject: community only — no name or contact details (privacy).
  const subject = `New lead in ${input.community}`;
  const body = `<p>Hi there,</p>
<p>${esc(input.builderName)} has a new lead: <strong>${esc(input.firstName)}</strong>, ${esc(input.projectType.toLowerCase())} in <strong>${esc(input.community)}</strong>.</p>
<p>Open the lead in the portal to see their details and get in touch.</p>
${ctaButton(leadUrl, 'Open lead')}
${fallbackLink(leadUrl)}
<p style="font-size:13px;color:#8a8378;">${esc(BUILDER_PREFS_NOTE)}</p>`;
  const text =
    `Hi there,\n\n${input.builderName} has a new lead: ${input.firstName}, ` +
    `${input.projectType.toLowerCase()} in ${input.community}.\n\n` +
    `Open the lead in the portal to see their details and get in touch.\n\n` +
    `Open lead: ${leadUrl}\n\n${BUILDER_PREFS_NOTE}\n\n— ${ctx.brandName}`;
  return { subject, html: layout(ctx, 'New lead', body), text };
}

export interface BuilderDigestLeadLine {
  /** Homeowner first name only. */
  readonly firstName: string;
  /** Whole days the lead has been waiting in this group. */
  readonly waitingDays: number;
  readonly leadId: string;
}

export interface BuilderNeedsYouDigestTemplateInput {
  readonly builderName: string;
  readonly uncontacted: readonly BuilderDigestLeadLine[];
  readonly stale: readonly BuilderDigestLeadLine[];
  readonly wonWithoutContract: readonly BuilderDigestLeadLine[];
  /** The staleness threshold the feed used (server config). */
  readonly staleAfterDays: number;
  /** Max lines listed per group; the rest are summarized as "and N more". */
  readonly maxPerGroup: number;
}

function waitingLabel(days: number): string {
  if (days <= 0) return 'today';
  return days === 1 ? '1 day' : `${days} days`;
}

export function renderBuilderNeedsYouDigestEmail(
  ctx: TemplateContext,
  input: BuilderNeedsYouDigestTemplateInput,
): RenderedEmail {
  const portalUrl = `${ctx.appBaseUrl}/builder`;
  const groups = [
    { title: 'Not contacted yet', lines: input.uncontacted },
    {
      title: `No update in ${input.staleAfterDays}+ days`,
      lines: input.stale,
    },
    { title: 'Won, contract not recorded', lines: input.wonWithoutContract },
  ].filter((group) => group.lines.length > 0);
  const total =
    input.uncontacted.length + input.stale.length + input.wonWithoutContract.length;
  const subject =
    total === 1 ? '1 lead needs you today' : `${total} leads need you today`;

  const htmlGroups = groups
    .map((group) => {
      const shown = group.lines.slice(0, input.maxPerGroup);
      const more = group.lines.length - shown.length;
      const items = shown
        .map(
          (line) =>
            `<li><a href="${esc(builderLeadUrl(ctx, line.leadId))}" style="color:#b08d3e;">${esc(line.firstName)}</a> &middot; waiting ${esc(waitingLabel(line.waitingDays))}</li>`,
        )
        .join('');
      const moreLine = more > 0 ? `<li>and ${more} more</li>` : '';
      return `<p style="margin:16px 0 4px;"><strong>${esc(group.title)} (${group.lines.length})</strong></p><ul style="margin:0;padding-left:20px;">${items}${moreLine}</ul>`;
    })
    .join('\n');
  const textGroups = groups
    .map((group) => {
      const shown = group.lines.slice(0, input.maxPerGroup);
      const more = group.lines.length - shown.length;
      const lines = shown.map(
        (line) => `- ${line.firstName} (waiting ${waitingLabel(line.waitingDays)}): ${builderLeadUrl(ctx, line.leadId)}`,
      );
      if (more > 0) lines.push(`- and ${more} more`);
      return `${group.title} (${group.lines.length})\n${lines.join('\n')}`;
    })
    .join('\n\n');

  const body = `<p>Hi there,</p>
<p>Here are the ${esc(input.builderName)} leads that need you today.</p>
${htmlGroups}
${ctaButton(portalUrl, 'Open your leads')}
${fallbackLink(portalUrl)}
<p style="font-size:13px;color:#8a8378;">${esc(BUILDER_PREFS_NOTE)}</p>`;
  const text =
    `Hi there,\n\nHere are the ${input.builderName} leads that need you today.\n\n` +
    `${textGroups}\n\nOpen your leads: ${portalUrl}\n\n${BUILDER_PREFS_NOTE}\n\n— ${ctx.brandName}`;
  return { subject, html: layout(ctx, 'Leads that need you', body), text };
}
