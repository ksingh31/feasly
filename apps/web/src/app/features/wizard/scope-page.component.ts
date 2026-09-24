import { Component, inject, OnInit } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { Store } from '@ngxs/store';
import { SeoService } from '../../core/seo/seo.service';
import { ConfigService } from '../../core/config/config.service';
import { ChooseProjectType, GoToStep, WizardState } from '../wizard';
import { PropertyCardComponent, SiteFooterComponent, SiteNavComponent, WizardStepsComponent } from '../../shared/components';

/**
 * S2 scope step (FE1-001 scaffolding — TODO WEB-005 builds the full step).
 * Proves the FE1-001 wiring: landing selection populates wizard state and the
 * step indicator shows 2 of 3. Direct visits with no property get a way back,
 * never a dead end.
 */
@Component({
  selector: 'app-scope-page',
  standalone: true,
  imports: [
    PropertyCardComponent,
    RouterLink,
    SiteFooterComponent,
    SiteNavComponent,
    WizardStepsComponent,
  ],
  templateUrl: './scope-page.component.html',
  styleUrls: ['./wizard-shell.scss', './scope-page.component.scss'],
})
export class ScopePageComponent implements OnInit {
  private readonly store = inject(Store);
  private readonly router = inject(Router);
  private readonly seo = inject(SeoService);
  private readonly config = inject(ConfigService);

  protected readonly property = this.store.selectSignal(WizardState.property);
  /** Wizard scaffolding copy (config-owned). */
  protected readonly copy = this.config.get('copy').wizard;

  ngOnInit(): void {
    this.seo.setPage({
      title: this.config.get('copy').seo.scopeTitle,
      description: this.config.get('copy').seo.scope,
      path: '/estimate/scope',
    });
  }

  chooseNewBuild(): void {
    this.store.dispatch([new ChooseProjectType('new-build'), new GoToStep(3)]);
    void this.router.navigate(['/estimate/details']);
  }
}
