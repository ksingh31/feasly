import { Component, computed, inject, input } from '@angular/core';
import { Store } from '@ngxs/store';
import type { CommunityAmenityMetricDto } from '@feasly/contracts';
import { injectCommunityGuideCopy } from './community-guide-copy';
import { LoadCommunityLiving } from './community-guide.actions';
import { CommunityGuideState } from './community-guide.state';

/**
 * Community guide Living nearby tab (#781): the amenity metric grid
 * (nearest + counts within each radius) and public-tree cover, rendered
 * straight from `GET /communities/{slug}/living` via `CommunityGuideState`.
 * Distances are straight-line (the API says so; the note repeats it).
 */
@Component({
  selector: 'app-community-living-tab',
  standalone: true,
  templateUrl: './community-living-tab.component.html',
  styleUrl: './community-living-tab.component.scss',
})
export class CommunityLivingTabComponent {
  private readonly store = inject(Store);

  readonly displayName = input.required<string>();

  readonly copy = injectCommunityGuideCopy();
  readonly status = this.store.selectSignal(CommunityGuideState.livingStatus);
  readonly living = this.store.selectSignal(CommunityGuideState.living);

  readonly refreshed = computed(() => {
    const at = this.living()?.dataRefreshedAt;
    if (!at) return '';
    const date = new Date(at).toLocaleDateString('en-CA', {
      month: 'long',
      year: 'numeric',
      timeZone: 'UTC',
    });
    return this.copy.living.refreshedTemplate.replace('{date}', date);
  });

  load(): void {
    this.store.dispatch(new LoadCommunityLiving());
  }

  fill(template: string): string {
    return template.replace('{name}', this.displayName());
  }

  /** "240 m" under a kilometre, "1.4 km" above. */
  distance(metres: number): string {
    if (metres < this.copy.living.metresPerKm) return `${Math.round(metres)} m`;
    const km = metres / this.copy.living.metresPerKm;
    return `${Number.isInteger(km) ? km : km.toFixed(1)} km`;
  }

  nearest(metric: CommunityAmenityMetricDto): string {
    if (!metric.nearest) {
      return this.copy.living.noneWithin.replace('{radius}', this.distance(this.living()?.searchRadiusM ?? 0));
    }
    return this.copy.living.nearestTemplate
      .replace('{place}', metric.nearest.name)
      .replace('{distance}', this.distance(metric.nearest.distanceM));
  }

  countLine(count: number, radiusM: number): string {
    return this.copy.living.countWithin
      .replace('{count}', count.toLocaleString('en-CA'))
      .replace('{radius}', this.distance(radiusM));
  }

  treesPerHa(trees: number): string {
    return this.copy.living.treesPerHaTemplate.replace('{trees}', trees.toLocaleString('en-CA'));
  }
}
