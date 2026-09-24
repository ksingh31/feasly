import { __decorate } from "tslib";
import { Component, inject, input } from '@angular/core';
import { ConfigService } from '../../../core/config';
/**
 * Property card (shared): community, lot size, zoning, assessed value,
 * year built, plus the data-freshness line. Used by the scope step now
 * and the address step (S1) later — built once, reused (DRY).
 *
 * Freshness line is mock-aware: sample values never masquerade as
 * City records while `api.useMockApi` is true.
 */
let PropertyCardComponent = class PropertyCardComponent {
    config = inject(ConfigService);
    property = input.required();
    /** True while the mock property harness is active (never claim live data). */
    isMockData = this.config.get('api').useMockApi;
    /** Mock-mode freshness copy (config-owned, no hardcode). */
    freshnessMock = this.config.get('copy').propertyCard.freshnessMock;
    /** Integer CAD, no cents (contract guarantees an integer). */
    formatCad(value) {
        return '$' + Math.round(value).toLocaleString('en-CA');
    }
    formatDate(iso) {
        return new Date(iso).toLocaleDateString('en-CA', {
            year: 'numeric',
            month: 'short',
            day: 'numeric',
        });
    }
};
PropertyCardComponent = __decorate([
    Component({
        selector: 'app-property-card',
        standalone: true,
        templateUrl: './property-card.component.html',
        styleUrl: './property-card.component.scss',
    })
], PropertyCardComponent);
export { PropertyCardComponent };
