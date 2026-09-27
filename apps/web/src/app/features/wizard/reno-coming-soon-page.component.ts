import { Component, inject, OnInit } from '@angular/core';
import { Router } from '@angular/router';
import { Store } from '@ngxs/store';
import { ConfigService } from '../../core/config/config.service';
import { SeoService } from '../../core/seo/seo.service';
import { SiteFooterComponent, SiteNavComponent, WizardBackComponent } from '../../shared/components';
import { ChooseProjectType } from '../wizard';

/**
 * Renovation coming-soon page (Karan 2026-09-27).
 *
 * Renovation estimates are out of launch scope, so reno users land here
 * instead of the analyzing pipeline — a designed page, never a spinner and
 * never a generic error. No figures are invented: the page is honest that
 * renovation estimates aren't ready yet.
 *
 * CTAs: "Back to your project details" returns to the reno scope step;
 * "Start a new-build estimate" flips the wizard back to new-build and
 * continues the working flow.
 */
@Component({
  selector: 'app-reno-coming-soon-page',
  standalone: true,
  imports: [SiteFooterComponent, SiteNavComponent, WizardBackComponent],
  templateUrl: './reno-coming-soon-page.component.html',
  styleUrls: ['./wizard-shell.scss', './reno-coming-soon-page.component.scss'],
})
export class RenoComingSoonPageComponent implements OnInit {
  private readonly store = inject(Store);
  private readonly router = inject(Router);
  private readonly seo = inject(SeoService);
  private readonly config = inject(ConfigService);

  /** Coming-soon copy (config-owned). */
  protected readonly copy = this.config.get('copy').renoComingSoon;

  ngOnInit(): void {
    this.seo.setForRoute('estimate/reno-coming-soon');
  }

  /** One-click switch back to the working new-build flow. */
  startNewBuild(): void {
    this.store.dispatch(new ChooseProjectType('new-build'));
    void this.router.navigate(['/estimate/scope']);
  }
}
