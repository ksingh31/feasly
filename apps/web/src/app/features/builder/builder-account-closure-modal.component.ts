import { DialogRef } from '@angular/cdk/dialog';
import { Component, DestroyRef, computed, inject } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Store } from '@ngxs/store';
import { UiButtonComponent, UiFieldShellComponent, UiModalComponent } from '@app/shared/ui';
import { ConfigService } from '../../core/config/config.service';
import { BUILDER_COPY } from './builder-copy';
import { BuilderSettingsState, RequestBuilderAccountClosure } from './builder-settings.state';

/** Closed with the outcome; undefined when cancelled. */
export type BuilderAccountClosureModalResult = 'created' | 'duplicate';

/**
 * "Ask to close my account" (#861): org owners send a closure request
 * with an optional note. The API opens one admin task per builder (a
 * repeat comes back as a duplicate) and emails the team — there is no
 * self-serve deletion. Errors show inline (role="alert").
 */
@Component({
  selector: 'app-builder-account-closure-modal',
  standalone: true,
  imports: [ReactiveFormsModule, UiButtonComponent, UiFieldShellComponent, UiModalComponent],
  templateUrl: './builder-account-closure-modal.component.html',
  styleUrl: './builder-origin-request-modal.component.scss',
})
export class BuilderAccountClosureModalComponent {
  private readonly ref = inject<DialogRef<BuilderAccountClosureModalResult>>(DialogRef);
  private readonly store = inject(Store);
  private readonly fb = inject(FormBuilder);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly copy = inject(BUILDER_COPY).settings;
  protected readonly noteMax = inject(ConfigService).get('limits').builderAccountClosureNoteMaxLength;
  protected readonly noteHint = this.copy.closeNoteHint.replace('{max}', String(this.noteMax));

  protected readonly form = this.fb.nonNullable.group({
    note: ['', [Validators.maxLength(this.noteMax)]],
  });

  protected readonly closing = this.store.selectSignal(BuilderSettingsState.closing);
  private readonly closeError = this.store.selectSignal(BuilderSettingsState.closeError);

  protected readonly errorText = computed(() => {
    const err = this.closeError();
    if (err === null) return null;
    return err || this.copy.closeError;
  });

  protected cancel(): void {
    if (!this.closing()) this.ref.close();
  }

  protected submit(): void {
    if (this.closing() || this.form.invalid) return;
    const note = this.form.getRawValue().note.trim();
    this.store
      .dispatch(new RequestBuilderAccountClosure(note.length > 0 ? { reason: note } : {}))
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => {
        const outcome = this.store.selectSnapshot(BuilderSettingsState.closeOutcome);
        if (outcome) this.ref.close(outcome);
      });
  }
}
