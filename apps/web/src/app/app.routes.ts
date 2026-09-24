import { Routes } from '@angular/router';
import { DetailsPageComponent } from './features/wizard/details-page.component';
import { LandingPageComponent } from './features/landing/landing-page.component';
import { PrivacyPageComponent } from './features/legal/privacy-page.component';
import { ScopePageComponent } from './features/wizard/scope-page.component';
import { TermsPageComponent } from './features/legal/terms-page.component';
import { wizardPropertyGuard } from './features/wizard/wizard-property.guard';

export const routes: Routes = [
  { path: '', component: LandingPageComponent },
  // Scope step (FE-2): deep links without a selected property bounce to the address step.
  { path: 'estimate/scope', component: ScopePageComponent, canActivate: [wizardPropertyGuard] },
  { path: 'privacy', component: PrivacyPageComponent },
  { path: 'terms', component: TermsPageComponent },
  { path: 'estimate/details', component: DetailsPageComponent },
  // No dead ends: unknown paths return to the landing page.
  { path: '**', redirectTo: '' },
];
