import { Injectable, inject } from '@angular/core';
import { type Observable, ReplaySubject, map } from 'rxjs';
import { UiConfirmDialogComponent, type UiConfirmOptions } from './confirm-dialog.component';
import { UiModalService } from './modal.service';

/**
 * ConfirmDialog — portal-ui-kit §3. Required for every destructive or money
 * action (deactivate, delete, revoke, rotate, retry charge, mark paid, …).
 *
 *   this.confirms
 *     .confirm({ title: 'Deactivate Marco Silva?', body: '…', verb: 'Deactivate', tone: 'danger' })
 *     .pipe(filter(Boolean), takeUntilDestroyed(this.destroyRef))
 *     .subscribe(() => this.store.dispatch(new DeactivateMember(id)));
 *
 * Opens immediately; emits once (`true` only when the verb was pressed,
 * `false` for Cancel / × / Esc / scrim) and completes.
 */
@Injectable({ providedIn: 'root' })
export class UiConfirmService {
  private readonly modals = inject(UiModalService);

  confirm(options: UiConfirmOptions): Observable<boolean> {
    const ref = this.modals.open<UiConfirmDialogComponent, boolean, UiConfirmOptions>(UiConfirmDialogComponent, {
      data: options,
      size: 'sm',
      role: 'alertdialog',
    });
    // Replayed, so a late subscriber still gets the answer. `closed` emits
    // once and completes when the dialog closes, which ends this subscription.
    const answer = new ReplaySubject<boolean>(1);
    ref.closed.pipe(map((result) => result === true)).subscribe(answer);
    return answer.asObservable();
  }
}
