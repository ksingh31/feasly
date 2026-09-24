import { Routes } from '@angular/router';
import { DetailsPageComponent } from './features/wizard/details-page.component';
import { LandingPageComponent } from './features/landing/landing-page.component';
import { PrivacyPageComponent } from './features/legal/privacy-page.component';
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
  { path: 'privacy', component: PrivacyPageComponent, canActivate: [robotsGuard] },
  { path: 'terms', component: TermsPageComponent, canActivate: [robotsGuard] },
  {
    path: 'estimate/details',
    component: DetailsPageComponent,
    canActivate: [robotsGuard],
    data: { noindex: true },
  },
  // No dead ends: unknown paths return to the landing page.
  { path: '**', redirectTo: '' },
];
