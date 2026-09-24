import { Component, input } from '@angular/core';
import type { PropertyRecord } from '@feasly/contracts';

/**
 * Property card (shared): community, lot size, zoning, assessed value,
 * year built, plus the data-freshness line. Used by the scope step now
 * and the address step (S1) later — built once, reused (DRY).
 */
@Component({
  selector: 'app-property-card',
  standalone: true,
  templateUrl: './property-card.component.html',
  styleUrl: './property-card.component.scss',
})
export class PropertyCardComponent {
  readonly property = input.required<PropertyRecord | null>();

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
