import { Component, inject, OnInit } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Store } from '@ngxs/store';
import { ConfigService } from '../../core/config/config.service';
import { SeoService } from '../../core/seo/seo.service';
import { GoToStep, WizardState } from '../wizard';
import { PropertyCardComponent, SiteFooterComponent, SiteNavComponent, WizardStepsComponent } from '../../shared/components';

/**
 * S3 details step.
 * Shows the seeded input defaults; the preview CTA routes to the S5
 * estimate preview step (the single lead-gate point).
 */
@Component({
  selector: 'app-details-page',
  standalone: true,
  imports: [
    PropertyCardComponent,
    RouterLink,
    SiteFooterComponent,
    SiteNavComponent,
    WizardStepsComponent,
  ],
  templateUrl: './details-page.component.html',
  styleUrls: ['./wizard-shell.scss', './details-page.component.scss'],
})
export class DetailsPageComponent implements OnInit {
  private readonly store = inject(Store);
  private readonly seo = inject(SeoService);
  private readonly config = inject(ConfigService);

  protected readonly property = this.store.selectSignal(WizardState.property);
  /** Wizard scaffolding copy (config-owned). */
  protected readonly copy = this.config.get('copy').wizard;
  protected readonly inputs = this.store.selectSignal(WizardState.inputs);

  /** Display name for the chosen garage (config-owned; falls back to the id). */
  protected garageName(): string {
    const garage = this.inputs().garage;
    return this.copy.scopeGarages.find((g) => g.id === garage)?.name ?? garage;
  }

  /** Display name for the chosen basement (config-owned; falls back to the id). */
  protected basementName(): string {
    const basement = this.inputs().basement;
    return this.copy.scopeBasements.find((b) => b.id === basement)?.name ?? basement;
  }

  ngOnInit(): void {
    this.seo.setForRoute('estimate/details');
  }

  goBack(): void {
    this.store.dispatch(new GoToStep(2));
    // The routerLink on the template anchor performs the navigation.
  }
}
