import { Routes } from '@angular/router';
import { AnalyzingPageComponent } from './features/wizard/analyzing-page.component';
import { DetailsPageComponent } from './features/wizard/details-page.component';
import { GatePageComponent } from './features/wizard/gate-page.component';
import { LandingPageComponent } from './features/landing/landing-page.component';
import { PreviewPageComponent } from './features/wizard/preview-page.component';
import { PrivacyPageComponent } from './features/legal/privacy-page.component';
import { RenoScopePageComponent } from './features/wizard/reno-scope-page.component';
import { ReportPageComponent } from './features/report/report-page.component';
import { reportEstimateGuard } from './features/report/report-estimate.guard';
import { ScopePageComponent } from './features/wizard/scope-page.component';
import { TermsPageComponent } from './features/legal/terms-page.component';
import { wizardPropertyGuard } from './features/wizard/wizard-property.guard';
import { robotsGuard } from './core/seo/robots.guard';
import { wizardScopeGuard } from './features/wizard/wizard-scope.guard';

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
  // Lead gate (FE-004): the single gate — needs property + scope, else address step.
  // Private lead data: noindex like the other wizard routes.
  {
    path: 'estimate/gate',
    component: GatePageComponent,
    canActivate: [robotsGuard, wizardScopeGuard],
    data: { noindex: true },
  },
  // Analyzing (FE-004): runs the real estimate pipeline, then the report.
  {
    path: 'estimate/analyzing',
    component: AnalyzingPageComponent,
    canActivate: [robotsGuard, wizardScopeGuard],
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
  // Preview (S5): the single lead-gate point. Deep links without a selected
  // property bounce to the address step.
  {
    path: 'estimate/preview',
    component: PreviewPageComponent,
    canActivate: [robotsGuard, wizardPropertyGuard],
    data: { noindex: true },
  },
  // No dead ends: unknown paths return to the landing page.
  { path: '**', redirectTo: '' },
];
