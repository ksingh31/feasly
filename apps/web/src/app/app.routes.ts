import { Routes } from '@angular/router';
import { lazyProvider } from '@ngxs/store';
import { leadGateGuard } from './features/compare';
import { CommunitiesIndexPageComponent } from './features/communities/communities-index-page.component';
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
import { FaqPageComponent, HowItWorksPageComponent } from './features/marketing';
import { ScopePageComponent } from './features/wizard/scope-page.component';
import { CommunityPageComponent } from './features/communities/community-page.component';
import { TermsPageComponent } from './features/legal/terms-page.component';
import { wizardPropertyGuard } from './features/wizard/wizard-property.guard';
import { robotsGuard } from './core/seo/robots.guard';
import { wizardScopeGuard } from './features/wizard/wizard-scope.guard';
import { adminGuard } from './features/admin/admin.guard';
import { builderGuard } from './features/builder/builder.guard';

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
  // Lead gate (FE-004 / NBH-03): the single gate — the wizard flow needs
  // property + scope, the comparison flow needs an active comparison result.
  // Private lead data: noindex like the other wizard routes.
  {
    path: 'estimate/gate',
    component: GatePageComponent,
    canActivate: [robotsGuard, leadGateGuard],
    data: { noindex: true },
  },
  // Analyzing (FE-004): runs the real estimate pipeline, then the report.
  // Renovation never reaches it — reno users get the coming-soon page
  // (Karan 2026-09-27: reno out of launch scope).
  {
    path: 'estimate/analyzing',
    component: AnalyzingPageComponent,
    canActivate: [robotsGuard, wizardScopeGuard],
    data: { noindex: true },
  },
  // Reno coming-soon (Karan 2026-09-27): a designed holding page instead of
  // the analyzing pipeline. Private funnel route: noindex. Lazy-loaded so
  // it stays out of the initial bundle (budget).
  {
    path: 'estimate/reno-coming-soon',
    loadComponent: () =>
      import('./features/wizard/reno-coming-soon-page.component').then(
        (m) => m.RenoComingSoonPageComponent,
      ),
    canActivate: [robotsGuard, wizardPropertyGuard],
    data: { noindex: true },
  },
  // Neighbourhood comparison picker (NBH-04): no wizard property needed —
  // it compares communities, not an address. Private funnel route: noindex.
  {
    path: 'estimate/compare',
    loadComponent: () =>
      import('./features/compare/compare-picker-page.component').then(
        (m) => m.ComparePickerPageComponent,
      ),
    canActivate: [robotsGuard],
    data: { noindex: true },
  },
  { path: 'privacy', component: PrivacyPageComponent, canActivate: [robotsGuard] },
  { path: 'terms', component: TermsPageComponent, canActivate: [robotsGuard] },
  // Unsubscribe center (email/03): token-authenticated, no login — the token
  // IS the credential. noindex like the other private token routes; never
  // prerendered (the token is only known at click time). Lazy-loaded so the
  // token page stays out of the initial bundle (budget).
  {
    path: 'unsubscribe/:token',
    loadComponent: () =>
      import('./features/unsubscribe/unsubscribe-page.component').then(
        (m) => m.UnsubscribePageComponent,
      ),
    canActivate: [robotsGuard],
    data: { noindex: true },
  },
  // Marketing pages (SEO-010): indexable — no `noindex` data, so the SEO
  // table + check-prerender-seo.mjs treat them as crawlable like privacy/terms.
  { path: 'how-it-works', component: HowItWorksPageComponent, canActivate: [robotsGuard] },
  { path: 'faq', component: FaqPageComponent, canActivate: [robotsGuard] },
  // API docs (api-mcp/03): indexable like the other marketing pages — no
  // `noindex` data, so the SEO table + check-prerender-seo.mjs treat it as
  // crawlable. Sitemap already reserves /developers (seo/02). Lazy-loaded:
  // prerendering follows loadComponent routes, so SEO is unaffected.
  {
    path: 'developers',
    loadComponent: () =>
      import('./features/developers/developers-page.component').then(
        (m) => m.DevelopersPageComponent,
      ),
    canActivate: [robotsGuard],
  },
  // Community index (SEO-05): prerendered hub listing all 40 community
  // cost guides. Indexable — no `noindex` data. The `communities/:slug`
  // pages (SEO-04) link back here; this page links out to each of them.
  {
    path: 'communities',
    component: CommunitiesIndexPageComponent,
    canActivate: [robotsGuard],
  },
  // Labelled sample report (seo/09): fictional data, watermarked, never
  // gated/emailed/persisted. noindex like the wizard routes — it's a trust
  // page for visitors, not a search landing page.
  {
    path: 'sample-report',
    loadComponent: () =>
      import('./features/sample-report/sample-report-page.component').then(
        (m) => m.SampleReportPageComponent,
      ),
    canActivate: [robotsGuard],
    data: { noindex: true },
  },
  {
    path: 'estimate/details',
    component: DetailsPageComponent,
    // Deep links without a selected property bounce to the address step —
    // same as scope/preview (FE-2). The empty-state template stays as a
    // belt-and-suspenders fallback.
    canActivate: [robotsGuard, wizardPropertyGuard],
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
  // Lazy-loaded so the embed shell stays out of the initial bundle
  // (790kB production budget). EmbedState stays in the root store.
  {
    path: 'embed',
    loadComponent: () =>
      import('./features/embed/embed-shell.component').then((m) => m.EmbedShellComponent),
    canActivate: [robotsGuard],
    data: { noindex: true },
  },
  {
    path: 'embed/:tenantKey',
    loadComponent: () =>
      import('./features/embed/embed-shell.component').then((m) => m.EmbedShellComponent),
    canActivate: [robotsGuard],
    data: { noindex: true },
  },
  // Admin funnel dashboard (admin/07): Karan's conversion visibility —
  // per-step counts + conversion %, date-range + tenant filters. Session-auth
  // adminGuard (admin/01). noindex — private. Lazy-loaded: this is an
  // admin-only page, so it stays out of the public initial bundle (budget).
  {
    path: 'admin/funnels',
    loadComponent: () =>
      import('./features/admin/funnels-page.component').then(
        (m) => m.FunnelsPageComponent,
      ),
    canActivate: [robotsGuard, adminGuard],
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
  // Community pages (SEO-04): prerendered per-community cost guides.
  // Indexable — no `noindex` data, so crawlers rank them.
  {
    path: 'communities/:slug',
    component: CommunityPageComponent,
    canActivate: [robotsGuard],
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
  // Admin (auth/02): Microsoft Entra External ID sign-in is the only admin
  // sign-in. The legacy magic-link flow was retired 2026-09-28 (Karan):
  // `/admin/verify` no longer exists, so dead magic-link URLs fall through
  // to the branded 404 page. All admin routes are noindexed and excluded
  // from prerendering (not in prerender-routes.txt). No public-page links
  // point here. All admin views are lazy-loaded so they stay out of the
  // initial bundle (bundle-budget regression, PR #159).
  {
    path: 'admin/login',
    loadComponent: () =>
      import('./features/admin/admin-login.component').then((m) => m.AdminLoginComponent),
    canActivate: [robotsGuard],
    data: { noindex: true },
  },
  {
    path: 'admin/auth/callback',
    loadComponent: () =>
      import('./features/admin/admin-entra-callback.component').then(
        (m) => m.AdminEntraCallbackComponent,
      ),
    canActivate: [robotsGuard],
    data: { noindex: true },
  },
  {
    path: 'admin',
    loadComponent: () =>
      import('./features/admin/admin-shell.component').then((m) => m.AdminShellComponent),
    canActivate: [
      robotsGuard,
      adminGuard,
      // Admin data states are lazy-loaded at this route via lazyProvider
      // (dynamic import): the states + their actions stay in the admin lazy
      // chunk, out of the initial bundle (740kB lighthouse budget).
      lazyProvider(
        async () =>
          (await import('./features/admin/admin-leads.state')).adminLeadsStateProvider,
      ),
      lazyProvider(
        async () =>
          (await import('./features/admin/admin-disputes.state')).adminDisputesStateProvider,
      ),
      lazyProvider(
        async () =>
          (await import('./features/admin/admin-calibration.state')).calibrationStateProvider,
      ),
      lazyProvider(
        async () =>
          (await import('./features/admin/sheets-sync.state')).sheetsSyncStateProvider,
      ),
      // Builders management (embed/02 admin-UI migration): registered on
      // the /admin PARENT route because the lead-detail modal (rendered
      // under /admin/leads) needs the builders list for its
      // assign-to-builder dropdown.
      lazyProvider(
        async () =>
          (await import('./features/admin/admin-builders.state')).adminBuildersStateProvider,
      ),
      // Admin user management (auth/03): the team-user table.
      lazyProvider(
        async () =>
          (await import('./features/admin/admin-users.state')).adminUsersStateProvider,
      ),
    ],
    data: { noindex: true },
    children: [
      { path: '', redirectTo: 'leads', pathMatch: 'full' },
      {
        path: 'leads',
        loadComponent: () =>
          import('./features/admin/admin-leads.component').then((m) => m.AdminLeadsComponent),
      },
      // Builders management (embed/02 admin-UI migration): the builders
      // table — branding, sign-in keys, allowed embed origins, plans.
      {
        path: 'builders',
        loadComponent: () =>
          import('./features/admin/admin-builders.component').then((m) => m.AdminBuildersComponent),
      },
      // Admin user management (auth/03): invite/edit/deactivate/delete users.
      {
        path: 'users',
        loadComponent: () =>
          import('./features/admin/admin-users.component').then((m) => m.AdminUsersComponent),
      },
      // Dispute console (billing/01 follow-on, was OPS-009): open disputes
      // oldest-first with reason, immutable evidence snapshot, 5-business-day
      // SLA countdown, and accept/reject resolution.
      {
        path: 'disputes',
        loadComponent: () =>
          import('./features/admin/admin-disputes.component').then(
            (m) => m.AdminDisputesComponent,
          ),
      },
      {
        path: 'calibration',
        loadComponent: () =>
          import('./features/admin/admin-calibration.component').then((m) => m.AdminCalibrationComponent),
      },
      // billing/03 follow-on: read-only billing-health dashboard (was
      // OPS-007). MRR, review aging, dunning, webhook health.
      // BillingHealthState is lazy-loaded at this route via lazyProvider
      // (dynamic import): the state + its actions stay in the billing lazy
      // chunk, out of the initial bundle (790kB production budget). This is
      // the 2026-09-27 fix — the state was never registered anywhere, so the
      // tab crashed at init.
      {
        path: 'billing',
        loadComponent: () =>
          import('./features/admin/admin-billing.component').then(
            (m) => m.AdminBillingComponent,
          ),
        canActivate: [
          lazyProvider(
            async () =>
              (await import('./features/admin/billing-health.state'))
                .billingHealthStateProvider,
          ),
        ],
      },
      // admin/05: Sheets sync ops panel.
      {
        path: 'ops/sheets',
        loadComponent: () =>
          import('./features/admin/admin-sheets-status.component').then((m) => m.AdminSheetsStatusComponent),
      },
      // Admin estimate lookup (admin/03): search entry + read-only detail.
      {
        path: 'estimates',
        loadComponent: () =>
          import('./features/admin/admin-estimate-lookup.component').then((m) => m.AdminEstimateLookupComponent),
      },
      {
        path: 'estimates/:id',
        loadComponent: () =>
          import('./features/admin/admin-estimate-lookup.component').then((m) => m.AdminEstimateLookupComponent),
      },
    ],
  },
  // Builder portal (embed/09): magic-link session auth, tenant-scoped lead
  // pipeline. All builder routes are noindexed and excluded from
  // prerendering (not in prerender-routes.txt). No public-page links point
  // here. Lazy-loaded so the builder portal stays out of the initial bundle
  // (790kB production budget). BuilderState stays in the root store — the
  // global credentials interceptor selects its sessionToken.
  {
    path: 'builder/login',
    loadComponent: () =>
      import('./features/builder/builder-login.component').then((m) => m.BuilderLoginComponent),
    canActivate: [robotsGuard],
    data: { noindex: true },
  },
  {
    path: 'builder/verify',
    loadComponent: () =>
      import('./features/builder/builder-verify.component').then((m) => m.BuilderVerifyComponent),
    canActivate: [robotsGuard],
    data: { noindex: true },
  },
  {
    path: 'builder',
    loadComponent: () =>
      import('./features/builder/builder-shell.component').then((m) => m.BuilderShellComponent),
    canActivate: [robotsGuard, builderGuard],
    data: { noindex: true },
    children: [
      {
        path: '',
        loadComponent: () =>
          import('./features/builder/builder-dashboard.component').then(
            (m) => m.BuilderDashboardComponent,
          ),
        pathMatch: 'full',
      },
      {
        // Builder billing (billing/02, BILL-02): card-on-file section.
        // Lazy-loaded like the dashboard so the builder portal stays out
        // of the initial bundle.
        path: 'billing',
        loadComponent: () =>
          import('./features/builder/builder-billing.component').then(
            (m) => m.BuilderBillingComponent,
          ),
      },
    ],
  },
  // API key management (api-mcp/02). Admin-only (adminGuard); noindexed —
  // never in sitemap or prerender. ApiKeysState is lazy-loaded at this route
  // via lazyProvider (dynamic import): the state + its actions stay in the
  // api-keys chunk, out of the initial bundle (790kB production budget).
  {
    path: 'admin/api-keys',
    loadComponent: () =>
      import('./features/admin/api-keys-page.component').then(
        (m) => m.ApiKeysPageComponent,
      ),
    canActivate: [
      robotsGuard,
      adminGuard,
      lazyProvider(
        async () =>
          (await import('./features/admin/api-keys.state')).apiKeysStateProvider,
      ),
    ],
    data: { noindex: true },
  },
  // Magic-link redemption (consumer/02): /r/:token from the estimate email.
  // Verifies the token, sets the report token, and lands on the unlocked
  // report. noindex like the other private token routes; never prerendered
  // (the token is only known at click time). Lazy-loaded so the page stays
  // out of the initial bundle (budget).
  {
    path: 'r/:token',
    loadComponent: () =>
      import('./features/magic-link/magic-link-page.component').then(
        (m) => m.MagicLinkPageComponent,
      ),
    canActivate: [robotsGuard],
    data: { noindex: true },
  },
  // Wildcard 404 MUST be last — Angular matches routes in order. Placing it
  // before the admin routes above would swallow /admin/login etc. (P0 fix).
  { path: '**', component: NotFoundPageComponent, canActivate: [robotsGuard], data: { noindex: true } },
];
