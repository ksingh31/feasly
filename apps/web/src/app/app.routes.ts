import { Routes } from '@angular/router';
import { ComparePickerPageComponent } from './features/compare/compare-picker-page.component';
import { DevelopersPageComponent } from './features/developers';
import { EmbedShellComponent } from './features/embed';
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
import { AdminLoginComponent } from './features/admin/admin-login.component';
import { AdminVerifyComponent } from './features/admin/admin-verify.component';
import { AdminShellComponent } from './features/admin/admin-shell.component';
import { AdminLeadsComponent } from './features/admin/admin-leads.component';
import { adminGuard } from './features/admin/admin.guard';

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
  // Neighbourhood comparison picker (NBH-04): no wizard property needed —
  // it compares communities, not an address. Private funnel route: noindex.
  {
    path: 'estimate/compare',
    component: ComparePickerPageComponent,
    canActivate: [robotsGuard],
    data: { noindex: true },
  },
  { path: 'privacy', component: PrivacyPageComponent, canActivate: [robotsGuard] },
  { path: 'terms', component: TermsPageComponent, canActivate: [robotsGuard] },
  // Marketing pages (SEO-010): indexable — no `noindex` data, so the SEO
  // table + check-prerender-seo.mjs treat them as crawlable like privacy/terms.
  { path: 'how-it-works', component: HowItWorksPageComponent, canActivate: [robotsGuard] },
  { path: 'faq', component: FaqPageComponent, canActivate: [robotsGuard] },
  // API docs (api-mcp/03): indexable like the other marketing pages — no
  // `noindex` data, so the SEO table + check-prerender-seo.mjs treat it as
  // crawlable. Sitemap already reserves /developers (seo/02).
  { path: 'developers', component: DevelopersPageComponent, canActivate: [robotsGuard] },
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
  // White-label embed shell (EMB-01): client-rendered, noindex, excluded
  // from the prerender manifest. Key via ?key= (snippet) or :tenantKey.
  {
    path: 'embed',
    component: EmbedShellComponent,
    canActivate: [robotsGuard],
    data: { noindex: true },
  },
  {
    path: 'embed/:tenantKey',
    component: EmbedShellComponent,
    canActivate: [robotsGuard],
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
  // Admin (admin/01): magic-link session auth. All admin routes are
  // noindexed and excluded from prerendering (not in prerender-routes.txt).
  // No public-page links point here.
  {
    path: 'admin/login',
    component: AdminLoginComponent,
    canActivate: [robotsGuard],
    data: { noindex: true },
  },
  {
    path: 'admin/verify',
    component: AdminVerifyComponent,
    canActivate: [robotsGuard],
    data: { noindex: true },
  },
  {
    path: 'admin',
    component: AdminShellComponent,
    canActivate: [robotsGuard, adminGuard],
    data: { noindex: true },
    children: [
      { path: '', redirectTo: 'leads', pathMatch: 'full' },
      { path: 'leads', component: AdminLeadsComponent },
    ],
  },
];
