import { Component, inject, input } from '@angular/core';
import type { PropertyRecord } from '@feasly/contracts';
import { ConfigService } from '../../../core/config';

/**
 * Property card (shared): community, lot size, zoning, assessed value,
 * year built, plus the data-freshness line. Used by the scope step now
 * and the address step (S1) later — built once, reused (DRY).
 *
 * Freshness line is mock-aware: sample values never masquerade as
 * City records while `api.useMockApi` is true.
 */
@Component({
  selector: 'app-property-card',
  standalone: true,
  templateUrl: './property-card.component.html',
  styleUrl: './property-card.component.scss',
})
export class PropertyCardComponent {
  private readonly config = inject(ConfigService);

  readonly property = input.required<PropertyRecord | null>();

  /** True while the mock property harness is active (never claim live data). */
  protected readonly isMockData = this.config.get('api').useMockApi;

  /** Mock-mode freshness copy (config-owned, no hardcode). */
  protected readonly freshnessMock = this.config.get('copy').propertyCard.freshnessMock;

  /** Integer CAD, no cents (contract guarantees an integer). */
  protected formatCad(value: number): string {
    return '$' + Math.round(value).toLocaleString('en-CA');
  }

  protected formatDate(iso: string): string {
    return new Date(iso).toLocaleDateString('en-CA', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  }
}
