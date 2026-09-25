import { Component, DestroyRef, computed, inject, output, signal } from '@angular/core';
import { FormControl, ReactiveFormsModule } from '@angular/forms';
import { catchError, debounceTime, distinctUntilChanged, filter, map, of, switchMap, tap } from 'rxjs';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import type { AutocompleteSuggestion, PropertyRecord } from '@feasly/contracts';
import { API_SERVICE } from '../../../core/api';
import { ConfigService } from '../../../core/config';

let nextInstanceId = 0;

type SearchStatus = 'idle' | 'searching' | 'error';

/**
 * Backend error codes the address step distinguishes (reno/05). Anything
 * else falls back to the generic search-error copy.
 */
const OUT_OF_COVERAGE = 'OUT_OF_COVERAGE';
const ADDRESS_NOT_FOUND = 'ADDRESS_NOT_FOUND';

/**
 * Address autocomplete (FE1-001): debounced City-backed suggestions shared by
 * the landing page (S0) and the wizard address step (S1).
 *
 * Emits the full `PropertyRecord` once a suggestion resolves — parents never
 * touch address keys. Keyboard: ArrowUp/Down to move, Enter to pick the
 * highlighted suggestion (or `submitted` when nothing is highlighted),
 * Escape to dismiss.
 */
@Component({
  selector: 'app-address-autocomplete',
  standalone: true,
  imports: [ReactiveFormsModule],
  templateUrl: './address-autocomplete.component.html',
  styleUrl: './address-autocomplete.component.scss',
})
export class AddressAutocompleteComponent {
  private readonly api = inject(API_SERVICE);
  private readonly config = inject(ConfigService);
  private readonly destroyRef = inject(DestroyRef);

  /** Fires with the resolved property when the user picks a suggestion. */
  readonly selected = output<PropertyRecord>();
  /** Fires on Enter with no highlighted suggestion (parent decides: pick-top or hint). */
  readonly submitted = output<void>();

  /** User-facing strings (config-owned so the no-hardcode tripwire stays green). */
  readonly copy = this.config.get('copy').search;

  readonly inputId = `ac-input-${nextInstanceId}`;
  readonly listboxId = `ac-listbox-${nextInstanceId++}`;

  readonly query = new FormControl('', { nonNullable: true });
  readonly suggestions = signal<AutocompleteSuggestion[]>([]);
  readonly open = signal(false);
  readonly activeIndex = signal(-1);
  readonly status = signal<SearchStatus>('idle');
  /**
   * Backend error code from the last failed lookup (reno/05). Set when a
   * request fails with a machine-readable code; drives the Calgary-only vs
   * generic error rendering. Cleared on every new search.
   */
  readonly errorCode = signal<string | null>(null);
  /** True when the last failure was OUT_OF_COVERAGE (reno/05). */
  readonly outOfCoverage = computed(() => this.errorCode() === OUT_OF_COVERAGE);
  /** True when the last failure was ADDRESS_NOT_FOUND (reno/05). */
  readonly addressNotFound = computed(() => this.errorCode() === ADDRESS_NOT_FOUND);
  /** A 3+ char search completed (controls the no-results message). */
  readonly searched = signal(false);
  /** Empty-submit hint, set by the parent via `nudgeIfEmpty()`. */
  readonly hint = signal<string | null>(null);

  /** Address key currently resolving to a full record (for retry). */
  private pendingKey: string | null = null;
  /** Max suggestions per response, from config. */
  private suggestionLimit: number;

  constructor() {
    const debounceMs = this.config.get('timings').debounceMs;
    this.suggestionLimit = this.config.get('limits').autocompleteSuggestionLimit;
    this.query.valueChanges
      .pipe(
        debounceTime(debounceMs),
        map((q) => q.trim()),
        distinctUntilChanged(),
        tap((q) => {
          this.hint.set(null);
          this.errorCode.set(null);
          if (q.length < 3) {
            this.suggestions.set([]);
            this.searched.set(false);
            this.open.set(false);
            this.activeIndex.set(-1);
            // A new query abandons any in-flight pick; its late
            // response must not emit (see resolve()).
            this.pendingKey = null;
          }
        }),
        filter((q) => q.length >= 3),
        tap(() => {
          this.status.set('searching');
          this.pendingKey = null;
        }),
        switchMap((q) =>
          this.api.autocomplete(q).pipe(
            map((res) => res.suggestions.slice(0, this.suggestionLimit)),
            catchError((error: unknown) => {
              this.status.set('error');
              this.errorCode.set(apiErrorCode(error));
              return of([]);
            }),
          ),
        ),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((suggestions) => {
        if (this.status() !== 'error') {
          this.applyResults(suggestions);
        }
      });
  }

  /** Applies fresh suggestions (shared by the debounced pipeline and retry). */
  private applyResults(suggestions: AutocompleteSuggestion[]): void {
    this.suggestions.set(suggestions);
    this.searched.set(true);
    this.open.set(true);
    this.activeIndex.set(-1);
    this.status.set('idle');
  }

  /** Fires one autocomplete request immediately, skipping the debounce. */
  private searchNow(query: string): void {
    this.status.set('searching');
    this.errorCode.set(null);
    this.pendingKey = null;
    this.api
      .autocomplete(query)
      .pipe(
        map((res) => res.suggestions.slice(0, this.suggestionLimit)),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe({
        next: (suggestions) => this.applyResults(suggestions),
        error: (error: unknown) => {
          this.status.set('error');
          this.errorCode.set(apiErrorCode(error));
        },
      });
  }

  /** Current raw query (for parent submit handling). */
  queryText(): string {
    return this.query.value;
  }

  /** Picks the top suggestion if one exists. Returns whether it did. */
  pickTop(): boolean {
    const top = this.suggestions()[0];
    if (!top || this.status() === 'searching') return false;
    this.choose(0);
    return true;
  }

  /** Shows the empty-submit hint when the query is too short to search. */
  nudgeIfEmpty(): void {
    if (this.query.value.trim().length < 3) {
      this.hint.set(this.config.get('copy').search.emptyHint);
    }
  }


  retry(): void {
    const key = this.pendingKey;
    const q = this.query.value.trim();
    this.status.set('idle');
    this.errorCode.set(null);
    if (key) {
      this.resolve(key);
    } else if (q.length >= 3) {
      this.searchNow(q);
    }
  }

  onKeydown(event: KeyboardEvent): void {
    const count = this.suggestions().length;
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        if (count > 0) {
          this.open.set(true);
          this.activeIndex.set(Math.min(this.activeIndex() + 1, count - 1));
        }
        break;
      case 'ArrowUp':
        event.preventDefault();
        if (count > 0) {
          this.activeIndex.set(Math.max(this.activeIndex() - 1, 0));
        }
        break;
      case 'Enter':
        if (this.open() && this.activeIndex() >= 0) {
          event.preventDefault();
          this.choose(this.activeIndex());
        } else {
          this.submitted.emit();
        }
        break;
      case 'Escape':
        this.open.set(false);
        this.activeIndex.set(-1);
        break;
    }
  }

  onFocus(): void {
    if (this.suggestions().length > 0) this.open.set(true);
  }

  onBlur(): void {
    // Option mousedown is preventDefaulted (input keeps focus), so a blur
    // here always means genuine focus loss — safe to close immediately.
    this.open.set(false);
    this.activeIndex.set(-1);
  }

  choose(index: number): void {
    const suggestion = this.suggestions()[index];
    if (!suggestion) return;
    this.open.set(false);
    this.activeIndex.set(-1);
    // Show the picked address while the record resolves.
    this.query.setValue(suggestion.address, { emitEvent: false });
    this.resolve(suggestion.addressKey);
  }

  private resolve(addressKey: string): void {
    this.pendingKey = addressKey;
    this.status.set('searching');
    this.errorCode.set(null);
    this.api
      .getProperty(addressKey)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (property) => {
          // Drop late responses superseded by a newer pick or query.
          if (this.pendingKey !== addressKey) return;
          this.pendingKey = null;
          this.status.set('idle');
          this.selected.emit(property);
        },
        error: (error: unknown) => {
          this.status.set('error');
          this.errorCode.set(apiErrorCode(error));
        },
      });
  }
}

/**
 * Extracts the machine-readable error code from a failed API call.
 * The API service rejects with the `ApiError` contract shape (`code` /
 * `message` / `retryable`); anything else maps to null (generic error).
 */
function apiErrorCode(error: unknown): string | null {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code: unknown }).code;
    return typeof code === 'string' && code.length > 0 ? code : null;
  }
  return null;
}
