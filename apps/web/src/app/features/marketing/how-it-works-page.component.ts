import { Component, computed, inject, OnInit } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { Store } from '@ngxs/store';
import { ConfigService } from '../../core/config';
import { SeoService } from '../../core/seo';
import { LoadPartners, PartnersState } from '../../core/partners';
import { buildHowToSchema } from '../../core/seo/jsonld-schemas';
import { DataFreshnessService } from '../../core/data-freshness';
import type { FormulaGroupKey, HowWeEstimateBand } from '../../core/config/app-config';
import {
  BuildTimelineComponent,
  EstimateScopeComponent,
  SiteFooterComponent,
  SiteNavComponent,
} from '../../shared/components';
import { formatCount, formatWholeCad } from '../../shared/utils/money';
import { ChooseProjectType, type ProjectType } from '../wizard/wizard.actions';
import { injectHowItWorksCopy } from './how-it-works-copy';

/** One formula card: a term (hard / soft / contingency) and its line items. */
export interface FormulaCard {
  readonly key: FormulaGroupKey;
  readonly title: string;
  readonly body: string;
  readonly items: readonly { readonly key: string; readonly label: string; readonly note: string }[];
}

/** One worked-example table section (a formula term's rows + subtotal). */
export interface ExampleSection {
  readonly key: FormulaGroupKey;
  readonly rows: readonly { readonly key: string; readonly label: string; readonly range: string }[];
  readonly subtotalLabel: string;
  readonly subtotal: string;
}

/** One data-source card with its freshness stamp. */
export interface SourceCard {
  readonly key: string;
  readonly title: string;
  readonly body: string;
  readonly stamp: string;
  readonly url: string | null;
  readonly linkLabel: string;
}

/** Fills `{name}` tokens in a config template. Display only — no math. */
function fill(template: string, values: Record<string, string>): string {
  return Object.entries(values).reduce((out, [k, v]) => out.split(`{${k}}`).join(v), template);
}

/**
 * ISO date → "Aug 4, 2026". A date-only ISO string parses as UTC midnight,
 * and formatting in UTC keeps prerender and browser on the same day.
 */
export function formatIsoDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? ''
    : date.toLocaleDateString('en-CA', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

/**
 * How it works (SEO-010): prerendered marketing page.
 *
 * #827 rebuilt it as the transparency page: answer-first summary, the
 * formula (hard + soft + contingency = range) with every engine line item,
 * why a range, data sources with freshness stamps, includes/excludes,
 * typical timeline, an engine-priced worked example, how the data stays
 * current, what happens next, and related links. Every figure comes from
 * config, and config's figures are generated from the engine / zoning
 * catalogue — the page never computes one.
 *
 * The 4-step flow (address → scope → preview → unlock), the
 * deterministic-math note, and CTAs into the estimator. Both project-type
 * CTAs preselect the type in NGXS before entering the wizard at the address
 * step (`/`); the scope step reads the preselected type and shows it as
 * already chosen. Renovation estimates are out of launch scope, so a
 * preselected renovation flows through the scope step's Continue into the
 * reno scope-inputs step and ends at the designed "coming soon" page
 * (never a dead end, never a guard bounce).
 * All user-facing copy comes from ConfigService (no-hardcode tripwire).
 */
@Component({
  selector: 'app-how-it-works-page',
  standalone: true,
  imports: [BuildTimelineComponent, EstimateScopeComponent, RouterLink, SiteFooterComponent, SiteNavComponent],
  templateUrl: './how-it-works-page.component.html',
  styleUrl: './marketing.scss',
})
export class HowItWorksPageComponent implements OnInit {
  private readonly seo = inject(SeoService);
  private readonly config = inject(ConfigService);
  private readonly store = inject(Store);
  private readonly router = inject(Router);
  private readonly dataFreshness = inject(DataFreshnessService);

  /** How-it-works copy (config-owned). */
  readonly copy = injectHowItWorksCopy();

  /** #827: engine/catalogue-generated figures behind the page (config). */
  private readonly data = this.config.get('howWeEstimate');

  private range(band: HowWeEstimateBand): string {
    return fill(this.copy.exampleRangeTemplate, { low: formatWholeCad(band.low), high: formatWholeCad(band.high) });
  }

  /**
   * #827: the formula, one card per term, each listing the engine line
   * items in that term (from the generated worked example, so the list is
   * the engine's rows) with what each covers (config notes).
   */
  protected readonly formulaCards: readonly FormulaCard[] = this.data.workedExample.groups.map((g) => ({
    key: g.key,
    title: this.copy.formulaGroups[g.key].title,
    body: this.copy.formulaGroups[g.key].body,
    items: g.rows.map((r) => ({ key: r.key, label: r.label, note: this.copy.lineItemNotes[r.key] ?? '' })),
  }));

  /** #827: worked example, priced by the engine at generation time. */
  protected readonly exampleIntro = fill(this.copy.exampleIntro, {
    sqft: formatCount(this.data.workedExample.input.buildSqft),
    tier: this.copy.exampleTierNames[this.data.workedExample.input.tier] ?? this.data.workedExample.input.tier,
    lot: formatCount(this.data.workedExample.input.lotSizeSqft),
  });
  protected readonly exampleSections: readonly ExampleSection[] = this.data.workedExample.groups.map((g) => ({
    key: g.key,
    rows: g.rows.map((r) => ({ key: r.key, label: r.label, range: this.range(r.range) })),
    subtotalLabel: this.copy.exampleSubtotals[g.key],
    subtotal: this.range(g.subtotal),
  }));
  protected readonly exampleTotal = this.range(this.data.workedExample.build);
  protected readonly exampleVersion = fill(this.copy.exampleVersion, {
    version: this.data.workedExample.costDataVersion,
  });

  /**
   * #827: data sources with freshness stamps. The assessment roll date is
   * live (browser-only, so the prerendered page shows the honest undated
   * line until it resolves); land use and cost data come from generated
   * config.
   */
  protected readonly sources = computed<readonly SourceCard[]>(() => {
    const s = this.copy.sources;
    const { refreshedMonth } = this.dataFreshness.freshness();
    const landUseDate = formatIsoDate(this.data.landUseRulesAsOf);
    return [
      {
        key: 'assessment',
        title: s.assessment.title,
        body: s.assessment.body,
        stamp: refreshedMonth ? fill(s.assessment.stampTemplate, { date: refreshedMonth }) : s.assessment.stampUnknown,
        url: this.data.sourceUrls.assessment,
        linkLabel: s.assessment.linkLabel,
      },
      {
        key: 'land-use',
        title: s.landUse.title,
        body: s.landUse.body,
        stamp: landUseDate ? fill(s.landUse.stampTemplate, { date: landUseDate }) : s.landUse.stampUnknown,
        url: this.data.sourceUrls.landUse,
        linkLabel: s.landUse.linkLabel,
      },
      {
        key: 'cost-data',
        title: s.costData.title,
        body: s.costData.body,
        stamp: this.data.costDataVersion
          ? fill(s.costData.stampTemplate, { version: this.data.costDataVersion })
          : s.costData.stampUnknown,
        url: null,
        linkLabel: s.costData.linkLabel,
      },
    ];
  });

  /** #827: related pages; flagged links hide while their feature is off. */
  protected readonly links = this.copy.links.filter(
    (l) => l.flag === undefined || this.config.get('features')[l.flag],
  );

  /**
   * #918: builder partners section — the same `PartnersState` the lead
   * capture points read (one request per session; browser-only, so the
   * prerendered page carries the heading + intro and the list hydrates).
   */
  protected readonly partnersCopy = this.config.get('copy').partners;
  protected readonly partners = this.store.selectSignal(PartnersState.partners);
  protected readonly partnersStatus = this.store.selectSignal(PartnersState.status);

  ngOnInit(): void {
    this.seo.setForRoute('how-it-works');
    this.store.dispatch(new LoadPartners());
    // #827: live assessment-roll freshness (no-op on the mock data path).
    this.dataFreshness.load();
    // SEO: HowTo schema mirrors the rendered 4 steps (same config copy —
    // schema and visible copy can't drift).
    const siteUrl = this.seo.getSiteUrl();
    this.seo.setJsonLd(
      buildHowToSchema(
        `${siteUrl}/how-it-works/`,
        this.copy.title,
        this.copy.sub,
        this.copy.steps,
      ),
    );
  }

  /**
   * Project-type CTAs: preselect the type in NGXS, then enter the wizard at
   * the address step (`/`). The scope step reads the preselected type and
   * shows it as already chosen.
   *
   * Renovation: renovation estimates are out of launch scope, so a
   * preselected renovation routes through the scope step's Continue into
   * the reno scope-inputs step and lands on the designed "coming soon"
   * page — a designed page, never a spinner or a generic error. Routing
   * via `/` like the new-build CTA keeps `wizardPropertyGuard` from
   * bouncing fresh visitors: the old direct
   * `/estimate/reno-coming-soon` deep link bounced them to `/` and the
   * button appeared dead.
   */
  startEstimate(type: ProjectType): void {
    this.store.dispatch(new ChooseProjectType(type));
    void this.router.navigate(['/']);
  }
}
