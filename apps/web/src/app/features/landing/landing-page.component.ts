import { Component, inject, OnInit, ViewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { Store } from '@ngxs/store';
import type { PropertyRecord } from '@feasly/contracts';
import { ConfigService } from '../../core/config';
import { SeoService } from '../../core/seo';
import { GoToStep, SelectProperty } from '../wizard';
import { AddressAutocompleteComponent, SiteFooterComponent, SiteNavComponent } from '../../shared/components';

/**
 * S0 landing (FE1-001): one job — get the address.
 *
 * Visual language locked to the prototype (cream/charcoal/brass, Syne +
 * Instrument Sans); hero content follows the story: the address question,
 * autocomplete (3+ chars, config debounce, max 6 suggestions), and selection
 * routes to `/estimate/scope` with wizard state populated at step 2.
 * All user-facing copy comes from ConfigService (no-hardcode tripwire).
 */
@Component({
  selector: 'app-landing-page',
  standalone: true,
  imports: [
    AddressAutocompleteComponent,
    FormsModule,
    SiteFooterComponent,
    SiteNavComponent,
  ],
  templateUrl: './landing-page.component.html',
  styleUrl: './landing-page.component.scss',
})
export class LandingPageComponent implements OnInit {
  private readonly store = inject(Store);
  private readonly router = inject(Router);
  private readonly seo = inject(SeoService);
  private readonly config = inject(ConfigService);

  /** Landing + search copy (config-owned). */
  readonly copy = this.config.get('copy').landing;
  readonly searchCopy = this.config.get('copy').search;

  /**
   * Trust items with mock-aware substitution: while the mock harness is
   * active the property-data item must not claim live City data.
   */
  readonly trustItems = this.config.get('api').useMockApi
    ? this.copy.trustItemsMock
    : this.copy.trustItems;

  @ViewChild(AddressAutocompleteComponent)
  private readonly autocomplete?: AddressAutocompleteComponent;

  ngOnInit(): void {
    const siteName = this.config.get('site').name;
    this.seo.setPage({
      title: `${siteName} — ${this.copy.heroTitle}`,
      description: this.copy.heroSub,
      path: '/',
    });
  }

  /** A suggestion resolved: populate wizard state at step 2 and go to scope. */
  onSelected(property: PropertyRecord): void {
    this.store.dispatch([new SelectProperty(property), new GoToStep(2)]);
    void this.router.navigate(['/estimate/scope']);
  }

  /**
   * Submit button / Enter with no highlighted suggestion: take the top
   * suggestion if there is one, otherwise nudge for a longer query.
   * Never a dead end — something always happens.
   */
  onSubmit(): void {
    const ac = this.autocomplete;
    if (!ac) return;
    if (ac.pickTop()) return;
    ac.nudgeIfEmpty();
  }
}
