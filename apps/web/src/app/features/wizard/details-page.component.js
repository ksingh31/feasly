import { __decorate } from "tslib";
import { Component, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Store } from '@ngxs/store';
import { ConfigService } from '../../core/config/config.service';
import { SeoService } from '../../core/seo/seo.service';
import { WizardState } from '../wizard';
import { PropertyCardComponent, SiteFooterComponent, SiteNavComponent, WizardStepsComponent } from '../../shared/components';
/**
 * S3 details step (FE1-001 scaffolding — TODO WEB-006 builds the full step).
 * Shows the seeded input defaults read-only; the preview CTA stays disabled
 * with honest helper text until the analyzing/preview stories land.
 */
let DetailsPageComponent = class DetailsPageComponent {
    store = inject(Store);
    seo = inject(SeoService);
    config = inject(ConfigService);
    property = this.store.selectSignal(WizardState.property);
    /** Wizard scaffolding copy (config-owned). */
    copy = this.config.get('copy').wizard;
    inputs = this.store.selectSignal(WizardState.inputs);
    ngOnInit() {
        this.seo.setPage({
            title: this.config.get('copy').seo.detailsTitle,
            description: this.config.get('copy').seo.details,
            path: '/estimate/details',
        });
    }
};
DetailsPageComponent = __decorate([
    Component({
        selector: 'app-details-page',
        standalone: true,
        imports: [
            PropertyCardComponent,
            RouterLink,
            SiteFooterComponent,
            SiteNavComponent,
            WizardStepsComponent,
        ],
        templateUrl: './details-page.component.html',
        styleUrls: ['./wizard-shell.scss', './details-page.component.scss'],
    })
], DetailsPageComponent);
export { DetailsPageComponent };
