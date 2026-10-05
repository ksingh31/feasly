import { Component, inject, OnInit } from '@angular/core';
import { SeoService } from '../../core/seo/seo.service';
import { SiteFooterComponent } from '../../shared/components/site-footer/site-footer.component';
import { SiteNavComponent } from '../../shared/components/site-nav/site-nav.component';
import { LegalReviewBannerComponent } from '../../shared/components/legal-review-banner/legal-review-banner.component';

/**
 * Privacy Policy — full draft content (2026-10-05).
 * Copy status: draft-pending-lawyer — Karan: have this reviewed by counsel
 * before launch. The HRD-05 legal gate blocks production deploys until the
 * lawyer approves this copy and the marker is removed.
 * Legal prose lives here (not in config): it changes by legal review,
 * not by deploy tuning. Allowlisted from the no-hardcode tripwire.
 */
@Component({
  selector: 'app-privacy-page',
  standalone: true,
  imports: [SiteFooterComponent, SiteNavComponent, LegalReviewBannerComponent],
  template: `
    <app-site-nav />
    <main class="legal" id="main-content" tabindex="-1">
      <app-legal-review-banner />
      <h1>Privacy Policy</h1>
      <p class="updated">Last updated: October 2026</p>

      <h2>1. Who we are</h2>
      <p>
        Feasly ("we", "us") is a Calgary, Alberta–based service that helps homeowners estimate the
        cost of building a home. ____ is responsible for your personal information under Alberta's
        Personal Information Protection Act (PIPA).
      </p>
      <p>
        Contact our privacy officer at <strong>____</strong> or <strong>____</strong> with any
        question, access request, correction, or deletion request.
      </p>

      <h2>2. What we collect</h2>

      <h3>2.1 Information you give us</h3>
      <p>
        <strong>To browse and build an estimate (no account needed).</strong> You type a Calgary
        address and choose project details: house size, finish tier (standard / premium / luxury),
        garage, basement, and your building timeline. Before you share contact details, this stays
        anonymous — it is not tied to your identity.
      </p>
      <p><strong>To receive your full report (the lead gate).</strong> We ask for:</p>
      <ul>
        <li>Your <strong>name</strong> (required)</li>
        <li>
          Your <strong>email address</strong> (required) — this is how we send your report link and
          how you reopen your report later
        </li>
        <li>Your <strong>phone number</strong> (optional) — only used if you ask for a callback</li>
        <li><strong>When you're hoping to build</strong> (required; defaults to "exploring")</li>
      </ul>
      <p>
        To get your report you must check a box agreeing to these Terms and this Privacy Policy, and
        agreeing that <strong>Feasly and builders associated with us may contact you about your
        estimate</strong>. You can opt out of further contact at any time (see section 8).
      </p>
      <p>
        <strong>Callback requests.</strong> If you ask us to call you, we use the name, email, and
        phone number you provide to reach you.
      </p>
      <p>
        <strong>Sharing your report with a partner.</strong> If you ask us to email your report to
        someone (e.g. a spouse or partner), we use the email address you type for that one-time
        send. We never share your dollar figures in that email — only a private link.
      </p>
      <p>
        <strong>Builder and administrator accounts.</strong> Builders and staff sign in through
        Microsoft Entra External ID (email + password, managed by Microsoft — we never see or store
        your password). We store your name, work email, organization, and role so we can run your
        account.
      </p>
      <p>
        <strong>Invoice disputes and notes.</strong> If a builder disputes a commission invoice, we
        keep the written reason. If our staff resolve it, we keep the resolution note and the staff
        member's identity — visible to staff only.
      </p>

      <h3>2.2 Information collected automatically (only with your consent)</h3>
      <p>
        <strong>Usage analytics — opt-in only.</strong> If you click <strong>Accept</strong> on our
        consent banner, we record anonymous funnel events: which estimate step you viewed (scope,
        details, preview, gate, report), when, and nothing else. No name, no email, no address, no
        dollar figures, no cookies, no fingerprinting, no third-party trackers. If you decline — or
        never answer — <strong>nothing is recorded at all</strong>. The landing page itself is never
        tracked.
      </p>
      <p>
        <strong>On-device storage.</strong> Your in-progress estimate is saved in your browser's
        local storage so a refresh doesn't lose it. Clearing your browser data removes it. Your name
        and phone number are never stored in your browser; after the lead gate we keep only an
        anonymous lead reference and your email there.
      </p>
      <p>
        <strong>Cookies.</strong> The homeowner estimator uses no cookies. We set two strictly
        necessary session cookies, only for signed-in administrators and builders, each expiring
        after 7 days of inactivity. They contain only an opaque session reference — nothing
        readable.
      </p>

      <h3>2.3 Information from other sources</h3>
      <p>
        <strong>City of Calgary open data.</strong> When you type an address, your keystrokes go
        directly from your browser to the City of Calgary's public property assessment service to
        find matches. We receive only the property reference you select, plus its assessed land
        value, lot size, and zoning — used solely to build your estimate.
      </p>

      <h2>3. How we use your information</h2>
      <ul>
        <li>Generate your cost estimate and deliver your report</li>
        <li>Send your report link and let you reopen it later (magic link, valid 7 days)</li>
        <li>Respond to callback requests and questions</li>
        <li>
          Send one reminder email about your unopened report, roughly 24 hours later (every such
          email has an unsubscribe link)
        </li>
        <li>
          Share your details with builders associated with us so they can contact you about your
          estimate (only after the consent described in section 2.1)
        </li>
        <li>Operate builder billing: calculate and collect the commission builders owe us</li>
        <li>Improve Feasly using anonymous, aggregated analytics (only from visitors who opted in)</li>
        <li>Meet legal obligations and keep the service secure</li>
      </ul>
      <p>We <strong>do not sell</strong> your personal information. Ever.</p>

      <h2>4. Who we share it with</h2>
      <p>
        <strong>Builders associated with us.</strong> When you submit the lead gate, the builders
        matched to your project can see your name, email, phone number, property address, timeline,
        and lead score — only their own assigned leads, never anyone else's. This is what the
        consent checkbox authorizes.
      </p>
      <p>
        <strong>Service providers.</strong> We use trusted third-party providers to operate Feasly —
        for example, secure cloud hosting in Canada, email delivery, payment processing, and
        internal operations tools. They are bound by contract to protect your information and may
        only use it to provide their services to us. We do not sell your personal information. Ever.
      </p>
      <p>
        We also share information if required by law, or to protect Feasly's rights and safety.
      </p>

      <h2>5. Emails you may receive from us</h2>
      <ul>
        <li>
          <strong>Your report link</strong> — sent every time you submit the lead gate (this is how
          you reopen your report; it's not marketing)
        </li>
        <li>
          <strong>One reminder</strong> — roughly 24 hours later, only if you haven't opened your
          report (unsubscribe link included)
        </li>
        <li><strong>A partner share</strong> — only if you ask us to email your report to someone</li>
        <li>
          <strong>Builder/admin account emails</strong> — invitations and billing notices (for
          builder and staff accounts only)
        </li>
      </ul>
      <p>
        Every marketing-type email carries a one-click unsubscribe. Unsubscribing stops promotional
        contact; your report link and other transactional messages still work.
      </p>

      <h2>6. How long we keep it</h2>
      <ul>
        <li><strong>Report links (magic links):</strong> expire 7 days after issue</li>
        <li><strong>Sign-in sessions (builders/admins):</strong> expire after 7 days</li>
        <li>
          <strong>Estimates and leads:</strong> kept until you ask us to delete them — there is no
          automatic expiry on production records
        </li>
        <li><strong>Test and sandbox data:</strong> automatically purged after 30 days</li>
      </ul>

      <h2>7. Your rights</h2>
      <p>Under Alberta PIPA you may at any time:</p>
      <ul>
        <li>
          <strong>Ask what we hold about you</strong> — we can provide an export of your leads,
          estimates, report links, and consent history
        </li>
        <li><strong>Ask us to correct it</strong></li>
        <li>
          <strong>Ask us to delete it</strong> — we delete your lead records from our database and
          revoke your report links. Anonymized records that can no longer identify you (such as
          detached estimate statistics and aggregate analytics), audit logs we are legally required
          to keep, and copies already mirrored to our internal spreadsheet are handled separately —
          ask us and we will confirm what was removed
        </li>
      </ul>
      <p>
        To exercise any of these rights, contact <strong>____</strong>. We respond to every
        request.
      </p>

      <h2>8. Opting out of contact</h2>
      <ul>
        <li>
          <strong>Emails:</strong> click "unsubscribe" in any email, or contact us — we stop
          promptly
        </li>
        <li>
          <strong>Calls/messages from us and associated builders:</strong> reply to any message or
          contact <strong>____</strong> and we record a do-not-contact flag
        </li>
      </ul>
      <p>Opting out never affects report links you've already received.</p>

      <h2>9. Security</h2>
      <p>
        We protect your information with industry-standard measures: encrypted connections
        throughout, session tokens stored only as irreversible hashes (never the raw token),
        role-based access so staff and builders see only what they need, and card payments handled
        entirely by Stripe (card numbers never touch our servers). No system is perfectly secure,
        and we will notify you as required by law if a breach affects you.
      </p>

      <h2>10. Children</h2>
      <p>
        Feasly is intended for adults planning a home build. We do not knowingly collect information
        from children.
      </p>

      <h2>11. Changes to this policy</h2>
      <p>
        If we change this policy materially, we will post the new version here with a new "last
        updated" date and, where appropriate, notify you by email before the changes take effect.
      </p>

      <h2>12. Contact</h2>
      <p>
        Questions about privacy, or a request about your data: <strong>____</strong>,
        <strong>____</strong>.
      </p>
    </main>
    <app-site-footer />
  `,
  styleUrl: './legal.scss',
})
export class PrivacyPageComponent implements OnInit {
  private readonly seo = inject(SeoService);

  ngOnInit(): void {
    this.seo.setForRoute('privacy');
  }
}
