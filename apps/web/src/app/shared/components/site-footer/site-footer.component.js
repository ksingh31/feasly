import { __decorate } from "tslib";
import { Component, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { ConfigService } from '../../../core/config/config.service';
/**
 * Site footer (FE1-001): slim dark footer with Privacy/Terms links.
 * The routes exist (minimal honest pages) — no dead ends.
 */
let SiteFooterComponent = class SiteFooterComponent {
    siteName = inject(ConfigService).get('site').name;
    year = new Date().getFullYear();
};
SiteFooterComponent = __decorate([
    Component({
        selector: 'app-site-footer',
        standalone: true,
        imports: [RouterLink],
        templateUrl: './site-footer.component.html',
        styleUrl: './site-footer.component.scss',
    })
], SiteFooterComponent);
export { SiteFooterComponent };
