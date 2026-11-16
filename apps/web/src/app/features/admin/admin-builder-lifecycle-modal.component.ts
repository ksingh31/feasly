import { DIALOG_DATA, DialogRef } from '@angular/cdk/dialog';
import { Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Store } from '@ngxs/store';
import type { Builder, BuilderLifecycleAction } from '@feasly/contracts';
import { UiButtonComponent, UiFieldShellComponent, UiModalComponent, UiToastService } from '@app/shared/ui';
import {
  ChangeBuilderStatus,
  DismissBuilderLifecycleFeedback,
  LoadOffboardingBlockers,
} from './admin-builders.actions';
import { AdminBuildersState } from './admin-builders.state';
import {
  LIFECYCLE_ACTION_VIEWS,
  LIFECYCLE_REASON_MAX,
  LIFECYCLE_REASON_MIN,
  lifecycleText,
} from './admin-builders-view';

/** Data handed to the lifecycle modal. */
export interface AdminBuilderLifecycleData {
  readonly builder: Builder;
  readonly action: BuilderLifecycleAction;
}

/**
 * Builder lifecycle confirm (#861, portal-ui-kit §3 ConfirmDialog shape):
 * Suspend · Reactivate · Start offboarding · Complete offboarding. Names
 * the builder, states the consequence, and requires a reason (3–1000
 * characters, as the API does) before the verb enables.
 *
 * Dispatches `ChangeBuilderStatus`; on success toasts and closes with
 * `true`. A failure stays inline — "Complete offboarding" refused for
 * blockers also refreshes the drawer's checklist.
 */
@Component({
  selector: 'app-admin-builder-lifecycle-modal',
  standalone: true,
  imports: [UiModalComponent, UiButtonComponent, UiFieldShellComponent],
  templateUrl: './admin-builder-lifecycle-modal.component.html',
  styleUrl: './admin-builder-lifecycle-modal.component.scss',
})
export class AdminBuilderLifecycleModalComponent {
  private readonly store = inject(Store);
  private readonly ref = inject<DialogRef<boolean>>(DialogRef);
  private readonly toasts = inject(UiToastService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly data = inject<AdminBuilderLifecycleData>(DIALOG_DATA);

  protected readonly view = LIFECYCLE_ACTION_VIEWS[this.data.action];
  protected readonly title = lifecycleText(this.view.title, this.data.builder.businessName);
  protected readonly body = lifecycleText(this.view.body, this.data.builder.businessName);
  protected readonly danger = this.view.tone === 'danger';
  protected readonly maxLength = LIFECYCLE_REASON_MAX;
  protected readonly reasonHint =
    `Required, ${LIFECYCLE_REASON_MIN}–${LIFECYCLE_REASON_MAX} characters. ` +
    'Saved on the builder so other admins can see why.';

  protected readonly reason = signal('');
  /** The admin tried to submit — show the reason error from now on. */
  private readonly attempted = signal(false);
  protected readonly submitting = signal(false);
  protected readonly error = signal<string | null>(null);

  private readonly reasonValid = computed(() => {
    const length = this.reason().trim().length;
    return length >= LIFECYCLE_REASON_MIN && length <= LIFECYCLE_REASON_MAX;
  });

  protected readonly reasonError = computed(() =>
    this.attempted() && !this.reasonValid()
      ? `Enter a reason of at least ${LIFECYCLE_REASON_MIN} characters.`
      : null,
  );

  protected onReason(event: Event): void {
    this.reason.set((event.target as HTMLTextAreaElement).value);
  }

  protected confirm(): void {
    this.attempted.set(true);
    if (!this.reasonValid() || this.submitting()) return;
    this.submitting.set(true);
    this.error.set(null);
    const id = this.data.builder.id;
    this.store
      .dispatch(new ChangeBuilderStatus(id, this.data.action, this.reason()))
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        complete: () => {
          this.submitting.set(false);
          const feedback = this.store.selectSnapshot(AdminBuildersState.lifecycleFeedback);
          this.store.dispatch(new DismissBuilderLifecycleFeedback());
          if (feedback?.ok) {
            this.toasts.show({ message: feedback.message });
            this.ref.close(true);
            return;
          }
          this.error.set(feedback?.message ?? 'Something went wrong. Please try again.');
          if (feedback && !feedback.ok && feedback.blocked) {
            this.store.dispatch(new LoadOffboardingBlockers(id));
          }
        },
      });
  }

  protected cancel(): void {
    this.ref.close(false);
  }
}
