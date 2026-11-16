import { Component, computed, inject, input, OnInit } from '@angular/core';
import type { PropertyRecord } from '@feasly/contracts';
import { ConfigService } from '../../../core/config';
import { DataFreshnessService, formatFreshnessLine } from '../../../core/data-freshness';
import { singleDetachedNeedsApproval } from '../../../core/utils/coverage';

/**
 * Property card (shared): community, lot size, zoning, assessed value,
 * year built, plus the data-freshness line. Used by the scope step now
 * and the address step (S1) later — built once, reused (DRY).
 *
 * Freshness line (#513) is the shared one-story line — "2026 assessment
 * roll (City of Calgary) · checked Nov 2026" — the same string as the
 * landing trust strip: the property's own roll year plus the dataset check
 * month from the shared DataFreshnessService. It is mock-aware: sample values never masquerade as
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
export class PropertyCardComponent implements OnInit {
  private readonly config = inject(ConfigService);
  private readonly dataFreshness = inject(DataFreshnessService);

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

  /** "Needs City approval" note copy (#911). */
  protected readonly discretionaryZoningNote = this.config.get('copy').propertyCard.discretionaryZoningNote;

  /**
   * True when single-detached is only a discretionary use for this parcel's
   * zoning (#911): quoted, but never presented as a sure thing.
   */
  protected readonly needsApproval = computed((): boolean => {
    const p = this.property();
    if (!p) return false;
    const coverage = this.config.get('coverage');
    return singleDetachedNeedsApproval(
      p.zoning,
      coverage.singleFamilyDistricts.calgary,
      coverage.discretionarySingleFamilyDistricts.calgary,
    );
  });

  /** Shared freshness line: property roll year + dataset check month (#513). */
  protected readonly freshnessLine = computed((): string => {
    const p = this.property();
    if (!p) return '';
    return formatFreshnessLine(
      this.config.get('copy').dataFreshness,
      // Never claim a roll year we didn't read (#622): inferred → generic copy.
      p.assessmentYearInferred ? null : p.assessmentYear,
      this.dataFreshness.freshness().refreshedMonth,
    ).line;
  });

  ngOnInit(): void {
    // One request per session, shared with the landing strip (no-op on mock).
    this.dataFreshness.load();
  }

  /** Integer CAD, no cents (contract guarantees an integer). */
  protected formatCad(value: number): string {
    return '$' + Math.round(value).toLocaleString('en-CA');
  }
}
