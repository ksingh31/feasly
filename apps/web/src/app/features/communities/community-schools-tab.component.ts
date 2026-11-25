import { Component, computed, inject, input } from '@angular/core';
import { Store } from '@ngxs/store';
import type {
  ProvincialTestResult,
  School,
  SchoolBoardLookup,
  SchoolDesignation,
} from '@feasly/contracts';
import { ConfigService } from '../../core/config/config.service';
import { SchoolComparisonState, ToggleSchoolComparison } from '../../core/schools';
import { injectCommunityGuideCopy } from './community-guide-copy';
import { LoadCommunitySchools, SetSchoolTypeFilter } from './community-guide.actions';
import { CommunityGuideState, type SchoolTypeFilter } from './community-guide.state';

/** One level group of school cards. */
export interface SchoolLevelGroup {
  readonly key: string;
  readonly label: string;
  readonly schools: readonly School[];
}

/** Designations for one board, in the API's grade-band order. */
export interface BoardDesignations {
  readonly board: SchoolBoardLookup;
  readonly designations: readonly SchoolDesignation[];
}

const OTHER_LEVEL_KEY = 'other';

/**
 * Community guide Schools tab (#781). Renders data from
 * `CommunityGuideState` (our API — the monthly-refreshed schools directory
 * and board designations); never computes a figure. The prerendered page
 * carries the heading, intro and "typically designated" notice; the
 * schools load after hydration.
 *
 * - Type filter: All / Public (CBE) / Catholic (CCSD) / Charter / Private —
 *   each shows only that type (AC1).
 * - Every card shows its type badge, so private and charter schools are
 *   always labelled (AC2).
 * - Fraser score: hidden when `features.schoolFraserScore` is off; "n/a"
 *   when on and the school has none (AC3).
 */
@Component({
  selector: 'app-community-schools-tab',
  standalone: true,
  templateUrl: './community-schools-tab.component.html',
  styleUrl: './community-schools-tab.component.scss',
})
export class CommunitySchoolsTabComponent {
  private readonly store = inject(Store);
  private readonly config = inject(ConfigService);

  /** Community display name for the copy templates. */
  readonly displayName = input.required<string>();

  readonly copy = injectCommunityGuideCopy();
  readonly showFraser = this.config.get('features').schoolFraserScore;
  private readonly comparisonMax = this.config.get('limits').schoolComparisonMax;

  readonly status = this.store.selectSignal(CommunityGuideState.schoolsStatus);
  readonly filter = this.store.selectSignal(CommunityGuideState.schoolTypeFilter);
  private readonly designationsRes = this.store.selectSignal(CommunityGuideState.designations);
  private readonly schoolsRes = this.store.selectSignal(CommunityGuideState.schools);
  private readonly comparisonIds = this.store.selectSignal(SchoolComparisonState.schoolIds);

  readonly designationNotice = computed(() => this.fill(this.copy.schools.designatedNotice));

  /** Designations grouped by board (every board appears, for its lookup link). */
  readonly boardDesignations = computed<readonly BoardDesignations[]>(() => {
    const res = this.designationsRes();
    if (!res) return [];
    return res.boards.map((board) => ({
      board,
      designations: res.designations.filter((d) => d.board === board.board),
    }));
  });

  readonly hasDesignations = computed(
    () => (this.designationsRes()?.designations.length ?? 0) > 0,
  );

  readonly disclaimer = computed(() => this.schoolsRes()?.disclaimer ?? '');
  readonly attributions = computed(() => this.schoolsRes()?.attributions ?? []);

  private readonly allSchools = computed(() => this.schoolsRes()?.schools ?? []);

  /** Schools of the selected type only (AC1), grouped by level in config order. */
  readonly groups = computed<readonly SchoolLevelGroup[]>(() => {
    const filter = this.filter();
    const schools = this.allSchools().filter((s) => filter === 'all' || s.type === filter);
    const levels = this.copy.schools.levels;
    const buckets = new Map<string, School[]>();
    for (const school of schools) {
      const key = this.levelKey(school.grades);
      buckets.set(key, [...(buckets.get(key) ?? []), school]);
    }
    const ordered = [
      ...levels.map((l) => ({ key: l.key, label: l.label })),
      { key: OTHER_LEVEL_KEY, label: this.copy.schools.otherLevelLabel },
    ];
    return ordered
      .map((l) => ({ ...l, schools: buckets.get(l.key) ?? [] }))
      .filter((g) => g.schools.length > 0);
  });

  readonly emptyMessage = computed(() =>
    this.fill(this.allSchools().length === 0 ? this.copy.schools.emptyAll : this.copy.schools.emptyFiltered),
  );

  readonly comparisonFull = computed(() => this.comparisonIds().length >= this.comparisonMax);

  load(): void {
    this.store.dispatch(new LoadCommunitySchools());
  }

  setFilter(filter: SchoolTypeFilter): void {
    this.store.dispatch(new SetSchoolTypeFilter(filter));
  }

  toggleComparison(school: School): void {
    this.store.dispatch(new ToggleSchoolComparison(school.id, this.comparisonMax));
  }

  inComparison(school: School): boolean {
    return this.comparisonIds().includes(school.id);
  }

  fill(template: string): string {
    return template.replace('{name}', this.displayName());
  }

  typeLabel(school: School): string {
    return this.copy.schools.typeLabels[school.type] ?? school.type;
  }

  /** "Board · Grades" line (either part may be missing). */
  metaLine(school: School): string {
    return [school.board, school.grades].filter(Boolean).join(' · ');
  }

  programLabel(program: string): string {
    return this.copy.schools.programLabels[program] ?? program;
  }

  lookupLabel(board: SchoolBoardLookup): string {
    return this.copy.schools.lookupLinkTemplate.replace('{board}', board.name);
  }

  gradeBandLabel(designation: SchoolDesignation): string {
    return this.copy.schools.gradeBandLabels[designation.gradeBand] ?? designation.gradeBand;
  }

  testLabel(result: ProvincialTestResult): string {
    return this.copy.schools.testLabels[result.test] ?? result.test;
  }

  testResult(result: ProvincialTestResult): string {
    return this.copy.schools.testResultTemplate
      .replace('{acceptable}', this.pct(result.acceptableStandardPct))
      .replace('{excellence}', this.pct(result.excellenceStandardPct));
  }

  enrolment(school: School): string {
    const e = school.ratings.enrolment;
    if (!e) return this.copy.schools.notAvailable;
    return this.copy.schools.enrolmentTemplate
      .replace('{enrolment}', e.enrolment.toLocaleString('en-CA'))
      .replace('{capacity}', e.capacity.toLocaleString('en-CA'))
      .replace('{pct}', String(e.utilizationPct))
      .replace('{year}', e.schoolYear);
  }

  fraser(school: School): string {
    const f = school.ratings.fraser;
    if (!f) return this.copy.schools.notAvailable;
    return this.copy.schools.fraserTemplate
      .replace('{score}', String(f.score))
      .replace('{year}', f.year);
  }

  private pct(value: number | null): string {
    return value === null ? this.copy.schools.notAvailable : `${value}%`;
  }

  /** First configured level whose fragment appears in the grades text. */
  private levelKey(grades: string | null): string {
    const text = (grades ?? '').toLowerCase();
    if (!text) return OTHER_LEVEL_KEY;
    const level = this.copy.schools.levels.find((l) => l.match.some((m) => text.includes(m)));
    return level?.key ?? OTHER_LEVEL_KEY;
  }
}
