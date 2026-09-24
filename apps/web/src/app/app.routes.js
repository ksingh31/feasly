import { DetailsPageComponent } from './features/wizard/details-page.component';
import { LandingPageComponent } from './features/landing/landing-page.component';
import { PrivacyPageComponent } from './features/legal/privacy-page.component';
import { ScopePageComponent } from './features/wizard/scope-page.component';
import { TermsPageComponent } from './features/legal/terms-page.component';
export const routes = [
    { path: '', component: LandingPageComponent },
    // Wizard shell scaffolding (FE1-001): full steps land in WEB-005/WEB-006.
    { path: 'estimate/scope', component: ScopePageComponent },
    { path: 'privacy', component: PrivacyPageComponent },
    { path: 'terms', component: TermsPageComponent },
    { path: 'estimate/details', component: DetailsPageComponent },
    // No dead ends: unknown paths return to the landing page.
    { path: '**', redirectTo: '' },
];
