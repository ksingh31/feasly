import { DialogRef } from '@angular/cdk/dialog';
import {
  ChangeDetectionStrategy,
  Component,
  ViewEncapsulation,
  DestroyRef,
  computed,
  inject,
  linkedSignal,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Router } from '@angular/router';
import { Store } from '@ngxs/store';
import { Subject, debounceTime, distinctUntilChanged } from 'rxjs';
import type { AdminSearchHit, AdminSearchHitKind } from '@feasly/contracts';
import { ConfigService } from '../../core/config/config.service';
import { ClearAdminSearch, SearchAdmin } from './admin-search.actions';
import { AdminSearchState } from './admin-search.state';
import { openAdminEntity } from './admin-entity-routes';

/** One rendered group of hits (kind order is the server's). */
interface PaletteGroup {
  readonly kind: AdminSearchHitKind;
  readonly label: string;
  readonly hits: readonly { readonly hit: AdminSearchHit; readonly index: number }[];
}

/**
 * Admin ⌘K command palette (#538, portal-ui-kit §5, admin review "Global
 * Command / search"). Type a lead name, email, address, invoice number or
 * builder slug and jump straight to the record — this replaces pasting
 * UUIDs.
 *
 * Opened by the admin shell (⌘K / Ctrl+K / `/`) in a CDK dialog, which owns
 * the focus trap, Esc-to-close and focus return. WAI-ARIA combobox +
 * listbox: ↑/↓ move the active hit, Enter opens it, Esc closes.
 */
@Component({
  selector: 'app-admin-command-palette',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './admin-command-palette.component.html',
  styleUrls: ['./admin-command-palette.component.scss'],
  encapsulation: ViewEncapsulation.None,
})
export class AdminCommandPaletteComponent {
  private readonly store = inject(Store);
  private readonly router = inject(Router);
  private readonly config = inject(ConfigService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly dialogRef = inject<DialogRef<void>>(DialogRef, { optional: true });

  protected readonly copy = this.config.get('copy').admin.shell.palette;
  /** Server-side query cap (GET /api/v1/admin/search rejects longer). */
  protected readonly maxQuery = this.config.get('admin').searchMaxQueryLength;

  protected readonly query = signal('');
  private readonly result = this.store.selectSignal(AdminSearchState.palette);

  /** Hits for the current text only — never a previous query's leftovers. */
  private readonly hits = computed<readonly AdminSearchHit[]>(() => {
    const result = this.result();
    return result.status === 'ready' && result.query === this.query().trim() ? result.hits : [];
  });

  protected readonly status = computed<'empty' | 'loading' | 'error' | 'none' | 'hits'>(() => {
    const text = this.query().trim();
    if (!text) return 'empty';
    const result = this.result();
    if (result.status === 'error' && result.query === text) return 'error';
    if (result.status === 'ready' && result.query === text) {
      return result.hits.length > 0 ? 'hits' : 'none';
    }
    return 'loading';
  });

  protected readonly groups = computed<readonly PaletteGroup[]>(() => {
    const groups: PaletteGroup[] = [];
    this.hits().forEach((hit, index) => {
      let group = groups.find((g) => g.kind === hit.kind);
      if (!group) {
        group = { kind: hit.kind, label: this.copy.kinds[hit.kind], hits: [] };
        groups.push(group);
      }
      (group.hits as { hit: AdminSearchHit; index: number }[]).push({ hit, index });
    });
    return groups;
  });

  /** Active hit: resets to the first hit whenever the hit list changes. */
  protected readonly activeIndex = linkedSignal<readonly AdminSearchHit[], number>({
    source: this.hits,
    computation: (hits) => (hits.length > 0 ? 0 : -1),
  });

  protected readonly activeId = computed(() =>
    this.activeIndex() >= 0 ? this.optionId(this.activeIndex()) : null,
  );

  private readonly typed = new Subject<string>();

  constructor() {
    this.typed
      .pipe(
        debounceTime(this.config.get('timings').debounceMs),
        distinctUntilChanged(),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((text) => this.store.dispatch(new SearchAdmin('palette', text)));
    this.destroyRef.onDestroy(() => this.store.dispatch(new ClearAdminSearch('palette')));
  }

  protected optionId(index: number): string {
    return `admin-palette-option-${index}`;
  }

  protected onInput(event: Event): void {
    const text = (event.target as HTMLInputElement).value;
    this.query.set(text);
    this.typed.next(text.trim());
  }

  protected retry(): void {
    this.store.dispatch(new SearchAdmin('palette', this.query()));
  }

  protected onKeydown(event: KeyboardEvent): void {
    const count = this.hits().length;
    switch (event.key) {
      case 'ArrowDown':
      case 'ArrowUp': {
        event.preventDefault();
        if (count === 0) return;
        const step = event.key === 'ArrowDown' ? 1 : -1;
        const current = this.activeIndex();
        const start = current < 0 ? (step === 1 ? -1 : 0) : current;
        this.activeIndex.set((start + step + count) % count);
        document.getElementById(this.optionId(this.activeIndex()))?.scrollIntoView?.({
          block: 'nearest',
        });
        break;
      }
      case 'Enter': {
        const hit = this.hits()[this.activeIndex()];
        if (hit) {
          event.preventDefault();
          this.open(hit);
        }
        break;
      }
      default:
        break;
    }
  }

  /** mousedown so the input keeps focus (no blur flash) before navigating. */
  protected onOptionPointerDown(event: Event, hit: AdminSearchHit): void {
    event.preventDefault();
    this.open(hit);
  }

  protected open(hit: AdminSearchHit): void {
    this.close();
    openAdminEntity(this.router, hit.kind, hit.id);
  }

  protected close(): void {
    this.dialogRef?.close();
  }
}
