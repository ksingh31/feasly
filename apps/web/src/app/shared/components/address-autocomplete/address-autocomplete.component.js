import { __decorate } from "tslib";
import { Component, DestroyRef, inject, output, signal } from '@angular/core';
import { FormControl, ReactiveFormsModule } from '@angular/forms';
import { catchError, debounceTime, distinctUntilChanged, filter, map, of, switchMap, tap } from 'rxjs';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { API_SERVICE } from '../../../core/api';
import { ConfigService } from '../../../core/config';
let nextInstanceId = 0;
/**
 * Address autocomplete (FE1-001): debounced City-backed suggestions shared by
 * the landing page (S0) and the wizard address step (S1).
 *
 * Emits the full `PropertyRecord` once a suggestion resolves — parents never
 * touch address keys. Keyboard: ArrowUp/Down to move, Enter to pick the
 * highlighted suggestion (or `submitted` when nothing is highlighted),
 * Escape to dismiss.
 */
let AddressAutocompleteComponent = class AddressAutocompleteComponent {
    api = inject(API_SERVICE);
    config = inject(ConfigService);
    destroyRef = inject(DestroyRef);
    /** Fires with the resolved property when the user picks a suggestion. */
    selected = output();
    /** Fires on Enter with no highlighted suggestion (parent decides: pick-top or hint). */
    submitted = output();
    /** User-facing strings (config-owned so the no-hardcode tripwire stays green). */
    copy = this.config.get('copy').search;
    inputId = `ac-input-${nextInstanceId}`;
    listboxId = `ac-listbox-${nextInstanceId++}`;
    query = new FormControl('', { nonNullable: true });
    suggestions = signal([]);
    open = signal(false);
    activeIndex = signal(-1);
    status = signal('idle');
    /** A 3+ char search completed (controls the no-results message). */
    searched = signal(false);
    /** Empty-submit hint, set by the parent via `nudgeIfEmpty()`. */
    hint = signal(null);
    /** Address key currently resolving to a full record (for retry). */
    pendingKey = null;
    /** Max suggestions per response, from config. */
    suggestionLimit;
    constructor() {
        const debounceMs = this.config.get('timings').debounceMs;
        this.suggestionLimit = this.config.get('limits').autocompleteSuggestionLimit;
        this.query.valueChanges
            .pipe(debounceTime(debounceMs), map((q) => q.trim()), distinctUntilChanged(), tap((q) => {
            this.hint.set(null);
            if (q.length < 3) {
                this.suggestions.set([]);
                this.searched.set(false);
                this.open.set(false);
                this.activeIndex.set(-1);
                // A new query abandons any in-flight pick; its late
                // response must not emit (see resolve()).
                this.pendingKey = null;
            }
        }), filter((q) => q.length >= 3), tap(() => {
            this.status.set('searching');
            this.pendingKey = null;
        }), switchMap((q) => this.api.autocomplete(q).pipe(map((res) => res.suggestions.slice(0, this.suggestionLimit)), catchError(() => {
            this.status.set('error');
            return of([]);
        }))), takeUntilDestroyed(this.destroyRef))
            .subscribe((suggestions) => {
            if (this.status() !== 'error') {
                this.applyResults(suggestions);
            }
        });
    }
    /** Applies fresh suggestions (shared by the debounced pipeline and retry). */
    applyResults(suggestions) {
        this.suggestions.set(suggestions);
        this.searched.set(true);
        this.open.set(true);
        this.activeIndex.set(-1);
        this.status.set('idle');
    }
    /** Fires one autocomplete request immediately, skipping the debounce. */
    searchNow(query) {
        this.status.set('searching');
        this.pendingKey = null;
        this.api
            .autocomplete(query)
            .pipe(map((res) => res.suggestions.slice(0, this.suggestionLimit)), takeUntilDestroyed(this.destroyRef))
            .subscribe({
            next: (suggestions) => this.applyResults(suggestions),
            error: () => this.status.set('error'),
        });
    }
    /** Current raw query (for parent submit handling). */
    queryText() {
        return this.query.value;
    }
    /** Picks the top suggestion if one exists. Returns whether it did. */
    pickTop() {
        const top = this.suggestions()[0];
        if (!top || this.status() === 'searching')
            return false;
        this.choose(0);
        return true;
    }
    /** Shows the empty-submit hint when the query is too short to search. */
    nudgeIfEmpty() {
        if (this.query.value.trim().length < 3) {
            this.hint.set(this.config.get('copy').search.emptyHint);
        }
    }
    retry() {
        const key = this.pendingKey;
        const q = this.query.value.trim();
        this.status.set('idle');
        if (key) {
            this.resolve(key);
        }
        else if (q.length >= 3) {
            this.searchNow(q);
        }
    }
    onKeydown(event) {
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
                }
                else {
                    this.submitted.emit();
                }
                break;
            case 'Escape':
                this.open.set(false);
                this.activeIndex.set(-1);
                break;
        }
    }
    onFocus() {
        if (this.suggestions().length > 0)
            this.open.set(true);
    }
    onBlur() {
        // Option mousedown is preventDefaulted (input keeps focus), so a blur
        // here always means genuine focus loss — safe to close immediately.
        this.open.set(false);
        this.activeIndex.set(-1);
    }
    choose(index) {
        const suggestion = this.suggestions()[index];
        if (!suggestion)
            return;
        this.open.set(false);
        this.activeIndex.set(-1);
        // Show the picked address while the record resolves.
        this.query.setValue(suggestion.address, { emitEvent: false });
        this.resolve(suggestion.addressKey);
    }
    resolve(addressKey) {
        this.pendingKey = addressKey;
        this.status.set('searching');
        this.api
            .getProperty(addressKey)
            .pipe(takeUntilDestroyed(this.destroyRef))
            .subscribe({
            next: (property) => {
                // Drop late responses superseded by a newer pick or query.
                if (this.pendingKey !== addressKey)
                    return;
                this.pendingKey = null;
                this.status.set('idle');
                this.selected.emit(property);
            },
            error: () => {
                this.status.set('error');
            },
        });
    }
};
AddressAutocompleteComponent = __decorate([
    Component({
        selector: 'app-address-autocomplete',
        standalone: true,
        imports: [ReactiveFormsModule],
        templateUrl: './address-autocomplete.component.html',
        styleUrl: './address-autocomplete.component.scss',
    })
], AddressAutocompleteComponent);
export { AddressAutocompleteComponent };
