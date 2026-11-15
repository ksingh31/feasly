import { Component, inject, input } from '@angular/core';
import type { PropertyRecord } from '@feasly/contracts';
import { ConfigService } from '../../../core/config';

/**
 * Property card (shared): community, lot size, zoning, assessed value,
 * year built, plus the data-freshness line. Used by the scope step now
 * and the address step (S1) later — built once, reused (DRY).
 *
 * Freshness line is mock-aware: sample values never masquerade as
 * City records while the mock property harness is active. Keyed off
 * `propertyData.source` (not `api.useMockApi`): the property backend is
 * an independent switch and can be live while estimate/lead flows mock.
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

  /**
   * Show the "includes the current house" note under the facts (#505).
   * Off for renovations: the house stays, so the teardown caveat is moot.
   */
  readonly showLandNote = input(true);

  /** True while the mock property harness serves the data (never claim live data). */
  protected readonly isMockData = this.config.get('propertyData').source === 'mock';

  /**
   * Honest label for the City-assessed figure: it covers the lot AND the
   * existing house (consumer review M2, #505). Same config copy as the
   * report's land card — one source, no duplicate strings.
   */
  protected readonly landLabel = this.config.get('copy').report.landLabel;
  protected readonly landHouseNote = this.config.get('copy').report.landHouseNote;

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
