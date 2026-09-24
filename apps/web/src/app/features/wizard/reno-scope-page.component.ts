import { Component, inject, OnInit } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Store } from '@ngxs/store';
import { SeoService } from '../../core/seo/seo.service';
import { ConfigService } from '../../core/config/config.service';
import { GoToStep, WizardState } from '../wizard';
import { SiteFooterComponent, SiteNavComponent, WizardStepsComponent } from '../../shared/components';

/**
 * Reno scope-inputs route placeholder (RENO-02).
 *
 * The project-type selector (scope step) routes Renovation here; RENO-03
 * replaces this placeholder with the real reno scope-inputs step (reno type,
 * affected area, finish tier, underpinning toggle). Until then this page is
 * an explicit in-wizard placeholder — never a dead end — with the selection
 * preserved in NGXS so "back" restores the scope step exactly.
 */
@Component({
  selector: 'app-reno-scope-page',
  standalone: true,
  imports: [RouterLink, SiteFooterComponent, SiteNavComponent, WizardStepsComponent],
  templateUrl: './reno-scope-page.component.html',
  styleUrls: ['./wizard-shell.scss', './reno-scope-page.component.scss'],
})
export class RenoScopePageComponent implements OnInit {
  private readonly store = inject(Store);
  private readonly seo = inject(SeoService);
  private readonly config = inject(ConfigService);

  /** Reno placeholder copy (config-owned). */
  protected readonly copy = this.config.get('copy').wizard;

  ngOnInit(): void {
    this.seo.setPage({
      title: this.config.get('copy').seo.renoScopeTitle,
      description: this.config.get('copy').seo.renoScope,
      path: '/estimate/reno-scope',
    });
  }

  goBack(): void {
    this.store.dispatch(new GoToStep(2));
    // The routerLink on the template anchor performs the navigation.
  }
}
