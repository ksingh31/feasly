import { Routes } from '@angular/router';
import { ErrorPageComponent } from './features/error/error-page.component';
import { AnalyzingPageComponent } from './features/wizard/analyzing-page.component';
import { DetailsPageComponent } from './features/wizard/details-page.component';
import { GatePageComponent } from './features/wizard/gate-page.component';
import { LandingPageComponent } from './features/landing/landing-page.component';
import { NotFoundPageComponent } from './features/not-found/not-found-page.component';
import { PreviewPageComponent } from './features/wizard/preview-page.component';
import { PrivacyPageComponent } from './features/legal/privacy-page.component';
import { RenoScopePageComponent } from './features/wizard/reno-scope-page.component';
import { ReportPageComponent } from './features/report/report-page.component';
import { reportEstimateGuard } from './features/report/report-estimate.guard';
import { SampleReportPageComponent } from './features/sample-report';
import { FaqPageComponent, HowItWorksPageComponent } from './features/marketing';
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
  // Marketing pages (SEO-010): indexable — no `noindex` data, so the SEO
  // table + check-prerender-seo.mjs treat them as crawlable like privacy/terms.
  { path: 'how-it-works', component: HowItWorksPageComponent, canActivate: [robotsGuard] },
  { path: 'faq', component: FaqPageComponent, canActivate: [robotsGuard] },
  // Labelled sample report (seo/09): fictional data, watermarked, never
  // gated/emailed/persisted. noindex like the wizard routes — it's a trust
  // page for visitors, not a search landing page.
  {
    path: 'sample-report',
    component: SampleReportPageComponent,
    canActivate: [robotsGuard],
    data: { noindex: true },
  },
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
  // Branded error page (HRD-02): uncaught client failures land here via the
  // global error handler — never a blank screen. Static story-pinned copy
  // only, so no error text or PII can leak into the DOM. noindexed.
  {
    path: 'error',
    component: ErrorPageComponent,
    canActivate: [robotsGuard],
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
