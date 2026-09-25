import { Component, inject, OnInit } from '@angular/core';
import { SeoService } from '../../core/seo/seo.service';
import { SiteFooterComponent } from '../../shared/components/site-footer/site-footer.component';
import { SiteNavComponent } from '../../shared/components/site-nav/site-nav.component';

/**
 * Privacy Policy (FE1-001 minimal page — M1 plain-language version).
 * Copy status: draft-pending-lawyer — Karan: have this reviewed by counsel
 * before launch. The HRD-05 legal gate blocks production deploys until the
 * lawyer approves this copy and the marker is removed.
 * Legal prose lives here (not in config): it changes by legal review,
 * not by deploy tuning. Allowlisted from the no-hardcode tripwire.
 */
@Component({
  selector: 'app-privacy-page',
  standalone: true,
  imports: [SiteFooterComponent, SiteNavComponent],
  template: `
    <app-site-nav />
    <main class="legal" id="main-content" tabindex="-1">
      <h1>Privacy Policy</h1>
      <p class="updated">Last updated: September 2026</p>

      <h2>What we collect</h2>
      <p>
        To generate an estimate we use the Calgary address you enter and the project details you
        choose (square footage, finish tier, garage, basement). This information is processed to
        produce your estimate and is not tied to your identity unless you ask us to send your
        report.
      </p>
      <p>
        When you request your full report, we collect your email address and name so we can send
        it to you, and your phone number only if you ask for a callback. Anonymous usage analytics
        are collected only if you opt in.
      </p>

      <h2>How we use it</h2>
      <p>
        We use your information to generate estimates, deliver reports you request, and respond to
        callback requests. We do not sell your personal information, and we do not share it with
        third parties except the service providers needed to operate Feasly (hosting, email
        delivery), who are bound to protect it.
      </p>

      <h2>On your device</h2>
      <p>
        Your in-progress estimate is saved in your browser's local storage so a refresh doesn't
        lose it. Clearing your browser data removes it. Nothing sensitive is stored there before
        you share your email with us.
      </p>

      <h2>Your rights</h2>
      <p>
        You may ask us at any time what information we hold about you, ask us to correct it, or
        ask us to delete it. Contact us through the callback request on any report and we will
        respond.
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
