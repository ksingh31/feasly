import { DIALOG_DATA, DialogRef } from '@angular/cdk/dialog';
import { Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Store } from '@ngxs/store';
import { UiButtonComponent, UiFieldShellComponent, UiModalComponent } from '@app/shared/ui';
import { ConfigService } from '../../core/config/config.service';
import { BUILDER_COPY } from './builder-copy';
import {
  BuilderSettingsState,
  RequestBuilderOriginChange,
} from './builder-settings.state';

export interface BuilderOriginRequestModalData {
  /** Currently allowed origins (offered as "remove" choices). */
  readonly origins: readonly string[];
}

/** Closed with the outcome; undefined when cancelled. */
export type BuilderOriginRequestModalResult = 'created' | 'duplicate';

let modalCounter = 0;

/**
 * "Request a change" dialog (#871): builders can't edit allowed embed
 * origins (staff-controlled for the pilot, #724) — they file a request
 * that opens an admin task. Origins to add are typed one per line; current
 * origins can be ticked for removal; an optional note goes to staff.
 *
 * The API validates each origin (https, no path) and dedupes identical
 * open requests; its message is shown inline (role="alert").
 */
@Component({
  selector: 'app-builder-origin-request-modal',
  standalone: true,
  imports: [ReactiveFormsModule, UiButtonComponent, UiFieldShellComponent, UiModalComponent],
  templateUrl: './builder-origin-request-modal.component.html',
  styleUrl: './builder-origin-request-modal.component.scss',
})
export class BuilderOriginRequestModalComponent {
  protected readonly data = inject<BuilderOriginRequestModalData>(DIALOG_DATA);
  private readonly ref = inject<DialogRef<BuilderOriginRequestModalResult>>(DialogRef);
  private readonly store = inject(Store);
  private readonly fb = inject(FormBuilder);
  private readonly destroyRef = inject(DestroyRef);
  private readonly limits = inject(ConfigService).get('limits');

  protected readonly copy = inject(BUILDER_COPY).settings;
  protected readonly noteMax = this.limits.builderOriginRequestNoteMaxLength;

  private readonly id = ++modalCounter;
  protected readonly ids = {
    add: `origin-request-add-${this.id}`,
    note: `origin-request-note-${this.id}`,
  };

  protected readonly form = this.fb.nonNullable.group({
    add: [''],
    note: ['', [Validators.maxLength(this.noteMax)]],
  });

  protected readonly removing = signal<ReadonlySet<string>>(new Set());
  protected readonly requesting = this.store.selectSignal(BuilderSettingsState.requesting);
  private readonly requestError = this.store.selectSignal(BuilderSettingsState.requestError);
  /** Client-side "nothing to request" message. */
  private readonly emptyError = signal(false);

  protected readonly errorText = computed(() => {
    if (this.emptyError()) return this.copy.requestEmptyError;
    const err = this.requestError();
    if (err === null) return null;
    return err || this.copy.requestError;
  });

  protected toggleRemove(origin: string, checked: boolean): void {
    this.removing.update((current) => {
      const next = new Set(current);
      if (checked) next.add(origin);
      else next.delete(origin);
      return next;
    });
    this.emptyError.set(false);
  }

  protected cancel(): void {
    if (!this.requesting()) this.ref.close();
  }

  protected submit(): void {
    if (this.requesting()) return;
    const v = this.form.getRawValue();
    const add = v.add
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    const remove = [...this.removing()];
    if (add.length === 0 && remove.length === 0) {
      this.emptyError.set(true);
      return;
    }
    this.emptyError.set(false);
    const note = v.note.trim();
    this.store
      .dispatch(
        new RequestBuilderOriginChange({
          ...(add.length > 0 ? { add } : {}),
          ...(remove.length > 0 ? { remove } : {}),
          ...(note.length > 0 ? { note } : {}),
        }),
      )
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => {
        const outcome = this.store.selectSnapshot(BuilderSettingsState.requestOutcome);
        if (outcome) this.ref.close(outcome);
      });
  }
}
