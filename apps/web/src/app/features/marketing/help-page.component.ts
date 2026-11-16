import { Component, computed, inject, OnInit, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import type { HelpAnswerSource } from '../../core/config/app-config';
import { ConfigService } from '../../core/config';
import { SeoService } from '../../core/seo';
import { buildWebPageSchema } from '../../core/seo/jsonld-schemas';
import { SiteFooterComponent, SiteNavComponent } from '../../shared/components';
import { HELP_COPY, provideHelpCopy } from './help-copy';

/** One resolved help answer, ready to render. */
export interface HelpAnswer {
  readonly q: string;
  readonly a: string;
}

/** A topic with its resolved answers. */
export interface HelpTopic {
  readonly id: string;
  readonly title: string;
  readonly answers: readonly HelpAnswer[];
}

/**
 * Help + contact (#834) at `/help`.
 *
 * Answers are grouped by topic (estimates, zoning, assessed value, privacy,
 * builders) and reused verbatim from the config-owned FAQ lists: the topic
 * config names a source list and an exact question, and the answer text is
 * looked up here, so `/help` and the page that owns the answer can't drift.
 *
 * Search filters the rendered answers in the browser: no API call. Every
 * answer is in the prerendered HTML (empty query on the server), so crawlers
 * and no-JS readers see the full page.
 *
 * Contact: the callback pipeline is tied to a report (the report token is
 * the credential and the callback is filed against that lead), so the card
 * routes visitors to their report or to a new estimate. "Email us" waits
 * for a support address (#705).
 */
@Component({
  selector: 'app-help-page',
  standalone: true,
  imports: [SiteFooterComponent, SiteNavComponent, RouterLink],
  templateUrl: './help-page.component.html',
  styleUrls: ['./marketing.scss', './help-page.component.scss'],
  // Help copy is provided here (lazy chunk), not in the root config, to keep
  // it out of the initial bundle.
  providers: [provideHelpCopy()],
})
export class HelpPageComponent implements OnInit {
  private readonly seo = inject(SeoService);
  private readonly config = inject(ConfigService);

  private readonly allCopy = this.config.get('copy');
  /** Help copy (config-owned, lazy: see help-copy.ts). */
  readonly copy = inject(HELP_COPY);
  /** Public status page; the link is omitted while unconfigured (no dead links). */
  readonly statusPageUrl = this.config.get('site').statusPageUrl ?? '';

  /** Every topic with its answers resolved from the FAQ sources. */
  readonly topics: readonly HelpTopic[] = this.resolveTopics();

  /** Raw search text. */
  readonly query = signal('');

  /** Topics filtered by the query; topics with no matching answer drop out. */
  readonly visibleTopics = computed<readonly HelpTopic[]>(() => {
    const terms = this.query().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return this.topics;
    return this.topics
      .map((topic) => ({
        ...topic,
        answers: topic.answers.filter((answer) => {
          const haystack = `${topic.title} ${answer.q} ${answer.a}`.toLocaleLowerCase();
          return terms.every((term) => haystack.includes(term));
        }),
      }))
      .filter((topic) => topic.answers.length > 0);
  });

  /** Matching answer count across visible topics. */
  readonly matchCount = computed(() =>
    this.visibleTopics().reduce((total, topic) => total + topic.answers.length, 0),
  );

  /** Live-region text: empty while not searching. */
  readonly resultsText = computed(() => {
    if (!this.query().trim()) return '';
    const count = this.matchCount();
    if (count === 0) return this.copy.noResults;
    if (count === 1) return this.copy.resultsOne;
    return this.copy.resultsTemplate.replace('{count}', String(count));
  });

  ngOnInit(): void {
    this.seo.setForRoute('help');
    const pageUrl = `${this.seo.getSiteUrl()}/help/`;
    this.seo.setJsonLd(buildWebPageSchema(pageUrl, this.copy.title, this.allCopy.seo.help));
  }

  onSearch(event: Event): void {
    this.query.set((event.target as HTMLInputElement).value);
  }

  clearSearch(input: HTMLInputElement): void {
    input.value = '';
    this.query.set('');
    input.focus();
  }

  private resolveTopics(): HelpTopic[] {
    const sources: Record<HelpAnswerSource, readonly HelpAnswer[]> = {
      faq: this.allCopy.marketing.faq?.items ?? [],
      pillarGuide: this.allCopy.marketing.pillarGuide?.faqs ?? [],
      zoningGuide: this.allCopy.marketing.zoningGuide?.faqs ?? [],
      communities: this.allCopy.communities?.faqItems ?? [],
    };
    return this.copy.topics
      .map((topic) => ({
        id: topic.id,
        title: topic.title,
        answers: topic.answers
          .map((ref) => sources[ref.source]?.find((item) => item.q === ref.q))
          .filter((item): item is HelpAnswer => item !== undefined)
          .map((item) => ({ q: item.q, a: item.a })),
      }))
      // A served config that rewords every referenced question would leave
      // an empty <h2> section; drop topics with no resolved answers.
      .filter((topic) => topic.answers.length > 0);
  }
}
