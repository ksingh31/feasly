import { Component, DestroyRef, inject, OnInit } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Router } from '@angular/router';
import { Store } from '@ngxs/store';
import { switchMap } from 'rxjs/operators';
import { SeoService } from '../../core/seo/seo.service';
import { ConfigService } from '../../core/config/config.service';
import { BuilderAuthApiService } from './builder-auth-api.service';
import { BuilderState } from './builder.state';
import {
  LoadBuilderMemberships,
  LoadBuilderSession,
  SetBuilderActiveOrg,
} from './builder.actions';
import type { BuilderOrgMembership } from './builder-auth.contracts';

/**
 * Builder org picker (auth/05, builder org accounts).
 *
 * Route: `/builder/org-picker` — shown right after Entra sign-in when the
 * user belongs to more than one builder organization (or none — the
 * empty state explains that no org was found). The user picks their
 * active org; the choice is POSTed to the backend
 * (`POST /api/v1/builder/auth/switch-org`) which stores it in the
 * session — the client never trusts an org id from request params.
 *
 * After the switch the session is re-probed (`LoadBuilderSession`) so
 * the shell picks up the active org, then the user lands on `/builder`.
 *
 * Guarded: unreachable without an authenticated builder session (the
 * builder guard redirects to login). A single-membership user never lands
 * here — the callback sets their org directly.
 *
 * noindex,nofollow via the robots guard; excluded from prerendering.
 */
@Component({
  selector: 'app-builder-org-picker',
  standalone: true,
  templateUrl: './builder-org-picker.component.html',
  styleUrls: ['./builder-login.component.scss', './builder-org-picker.component.scss'],
})
export class BuilderOrgPickerComponent implements OnInit {
  private readonly store = inject(Store);
  private readonly router = inject(Router);
  private readonly api = inject(BuilderAuthApiService);
  private readonly seo = inject(SeoService);
  private readonly destroyRef = inject(DestroyRef);

  /** Builder portal copy (config-owned). */
  protected readonly copy = inject(ConfigService).get('copy').builder;

  protected readonly memberships = this.store.selectSignal(BuilderState.memberships);
  protected readonly loading = this.store.selectSignal(BuilderState.membershipsLoading);
  protected readonly loadError = this.store.selectSignal(BuilderState.membershipsError);

  /** Org id currently being switched (disables its button). */
  protected switchingId: string | null = null;
  protected switchError = false;

  constructor() {
    this.seo.setPage({
      title: 'Choose your organization — Feasly',
      description: 'Choose which builder organization to work in.',
      path: '/builder/org-picker',
    });
  }

  ngOnInit(): void {
    this.store.dispatch(new LoadBuilderMemberships());
  }

  protected retry(): void {
    this.store.dispatch(new LoadBuilderMemberships());
  }

  protected roleLabel(membership: BuilderOrgMembership): string {
    return membership.role === 'builder_admin'
      ? this.copy.orgRoleAdmin
      : this.copy.orgRoleMember;
  }

  protected choose(membership: BuilderOrgMembership): void {
    if (this.switchingId) return;
    this.switchingId = membership.builderId;
    this.switchError = false;
    this.api
      .switchOrg({ builderId: membership.builderId })
      .pipe(
        switchMap(() => {
          this.store.dispatch(
            new SetBuilderActiveOrg(
              membership.builderId,
              membership.builderName,
              membership.role,
            ),
          );
          return this.store.dispatch(new LoadBuilderSession());
        }),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe({
        next: () => {
          void this.router.navigate(['/builder']);
        },
        error: () => {
          this.switchingId = null;
          this.switchError = true;
        },
      });
  }
}
