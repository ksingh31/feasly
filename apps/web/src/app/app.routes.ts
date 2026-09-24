import { Routes } from '@angular/router';
import { DetailsPageComponent } from './features/wizard/details-page.component';
import { LandingPageComponent } from './features/landing/landing-page.component';
import { NotFoundPageComponent } from './features/not-found/not-found-page.component';
import { PrivacyPageComponent } from './features/legal/privacy-page.component';
import { RenoScopePageComponent } from './features/wizard/reno-scope-page.component';
import { ReportPageComponent } from './features/report/report-page.component';
import { reportEstimateGuard } from './features/report/report-estimate.guard';
import { ScopePageComponent } from './features/wizard/scope-page.component';
import { TermsPageComponent } from './features/legal/terms-page.component';
import { wizardPropertyGuard } from './features/wizard/wizard-property.guard';
import { robotsGuard } from './core/seo/robots.guard';

export const routes: Routes = [
  { path: '', component: LandingPageComponent, canActivate: [robotsGuard] },
  // Scope step (FE-2): deep links without a selected property bounce to the address step.
  {
    path: 'estimate/scope',
    component: ScopePageComponent,
    canActivate: [robotsGuard, wizardPropertyGuard],
    data: { noindex: true },
  },
  // Reno scope-inputs step (RENO-02 placeholder, RENO-03 builds the real
  // page): deep links without a selected property bounce to the address step.
  {
    path: 'estimate/reno-scope',
    component: RenoScopePageComponent,
    canActivate: [robotsGuard, wizardPropertyGuard],
    data: { noindex: true },
  },
  { path: 'privacy', component: PrivacyPageComponent, canActivate: [robotsGuard] },
  { path: 'terms', component: TermsPageComponent, canActivate: [robotsGuard] },
  {
    path: 'estimate/details',
    component: DetailsPageComponent,
    canActivate: [robotsGuard],
    data: { noindex: true },
  },
  // Report (M1): needs a completed estimate basis (property + sqft), else the address step.
  // Private estimate data: noindex like the other wizard routes.
  {
    path: 'estimate/report',
    component: ReportPageComponent,
    canActivate: [robotsGuard, reportEstimateGuard],
    data: { noindex: true },
  },
  // Branded 404 (SEO-01): unknown paths render the 404 page (noindexed via
  // setForRoute('404')); the CTA returns visitors home. SWA's
  // responseOverrides.404 rewrites platform-level 404s to /index.html so the
  // app — and this page — can render (see SEO.md for the status-code nuance).
  {
    path: '404',
    component: NotFoundPageComponent,
    canActivate: [robotsGuard],
    data: { noindex: true },
  },
  { path: '**', component: NotFoundPageComponent, canActivate: [robotsGuard], data: { noindex: true } },
];
