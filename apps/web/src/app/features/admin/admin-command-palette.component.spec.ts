/**
 * ⌘K command palette (#538): debounced search through AdminSearchState,
 * hits grouped by kind with human labels (never raw ids), ↑/↓ + Enter
 * keyboard path, mouse pick, empty / no-results / error states, and each
 * kind navigating to its record.
 */
import { DialogRef } from '@angular/cdk/dialog';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { provideStore } from '@ngxs/store';
import { of, throwError } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdminSearchHit } from '@feasly/contracts';
import { AdminCommandPaletteComponent } from './admin-command-palette.component';
import { AdminSearchApiService } from './admin-search-api.service';
import { AdminSearchState } from './admin-search.state';

const HITS: AdminSearchHit[] = [
  { kind: 'lead', id: '11111111-1111-4111-8111-111111111111', label: 'Jordan Lee', sublabel: 'jordan@example.com' },
  { kind: 'lead', id: '22222222-2222-4222-8222-222222222222', label: 'Jordan Park', sublabel: null },
  { kind: 'invoice', id: '33333333-3333-4333-8333-333333333333', label: 'INV-2026-0042', sublabel: 'Elite Craft' },
  { kind: 'builder', id: '44444444-4444-4444-8444-444444444444', label: 'Elite Craft', sublabel: 'elite-craft' },
  { kind: 'user', id: '55555555-5555-4555-8555-555555555555', label: 'Jordan Ops', sublabel: 'ops@example.com' },
];

describe('AdminCommandPaletteComponent (#538)', () => {
  let fixture: ComponentFixture<AdminCommandPaletteComponent>;
  let api: { search: ReturnType<typeof vi.fn> };
  let dialogRef: { close: ReturnType<typeof vi.fn> };
  let navigate: ReturnType<typeof vi.spyOn>;

  afterEach(() => vi.useRealTimers());

  beforeEach(() => {
    vi.useFakeTimers();
    TestBed.resetTestingModule();
    api = { search: vi.fn((q: string) => of({ query: q, hits: HITS })) };
    dialogRef = { close: vi.fn() };
    TestBed.configureTestingModule({
      imports: [AdminCommandPaletteComponent],
      providers: [
        provideRouter([]),
        provideStore([AdminSearchState]),
        { provide: AdminSearchApiService, useValue: api },
        { provide: DialogRef, useValue: dialogRef },
      ],
    });
    navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    fixture = TestBed.createComponent(AdminCommandPaletteComponent);
    fixture.detectChanges();
  });

  const el = (): HTMLElement => fixture.nativeElement as HTMLElement;
  const input = (): HTMLInputElement => el().querySelector('.admin-palette__input') as HTMLInputElement;
  const status = (): string => (el().querySelector('#admin-palette-status')?.textContent ?? '').trim();
  const options = (): HTMLElement[] => Array.from(el().querySelectorAll<HTMLElement>('[role="option"]'));
  const type = (text: string): void => {
    input().value = text;
    input().dispatchEvent(new Event('input'));
    fixture.detectChanges();
  };
  const key = (k: string): KeyboardEvent => {
    const event = new KeyboardEvent('keydown', { key: k, cancelable: true });
    input().dispatchEvent(event);
    fixture.detectChanges();
    return event;
  };

  it('starts with a hint and an ARIA combobox wired to the listbox', () => {
    expect(status()).toContain('Type a name, email, address, invoice number or builder slug.');
    expect(input().getAttribute('role')).toBe('combobox');
    expect(input().getAttribute('aria-controls')).toBe('admin-palette-list');
    expect(input().getAttribute('aria-expanded')).toBe('false');
    expect(el().querySelector('#admin-palette-list')?.getAttribute('role')).toBe('listbox');
  });

  it('debounces the search and renders hits grouped by kind with human labels only', () => {
    type('jor');
    expect(status()).toBe('Searching…');
    vi.advanceTimersByTime(100);
    expect(api.search).not.toHaveBeenCalled();
    vi.advanceTimersByTime(200);
    fixture.detectChanges();
    expect(api.search).toHaveBeenCalledTimes(1);
    expect(api.search).toHaveBeenCalledWith('jor');

    const groups = Array.from(el().querySelectorAll('.admin-palette__group-label')).map((g) =>
      g.textContent?.trim(),
    );
    expect(groups).toEqual(['Leads', 'Invoices', 'Builders', 'Users']);
    expect(options().map((o) => o.querySelector('.admin-palette__label')?.textContent?.trim())).toEqual([
      'Jordan Lee',
      'Jordan Park',
      'INV-2026-0042',
      'Elite Craft',
      'Jordan Ops',
    ]);
    // No raw UUIDs reach the palette text.
    expect(el().textContent).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/i);
    expect(input().getAttribute('aria-expanded')).toBe('true');
    expect(options()[0].getAttribute('aria-selected')).toBe('true');
  });

  it('↑/↓ move the active hit (wrapping) and Enter opens it', () => {
    type('jor');
    vi.advanceTimersByTime(300);
    fixture.detectChanges();
    key('ArrowDown');
    key('ArrowDown');
    expect(input().getAttribute('aria-activedescendant')).toBe(options()[2].id);
    key('ArrowUp');
    key('ArrowUp');
    key('ArrowUp');
    expect(input().getAttribute('aria-activedescendant')).toBe(options()[4].id);
    const enter = key('Enter');
    expect(enter.defaultPrevented).toBe(true);
    expect(dialogRef.close).toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith(['/admin/users'], {
      queryParams: { open: HITS[4].id },
    });
  });

  it('each kind navigates to its record', () => {
    type('jor');
    vi.advanceTimersByTime(300);
    fixture.detectChanges();
    const pick = (index: number): void => {
      options()[index].dispatchEvent(new MouseEvent('mousedown', { cancelable: true }));
    };
    pick(0);
    expect(navigate).toHaveBeenLastCalledWith(['/admin/leads'], { queryParams: { open: HITS[0].id } });
    pick(2);
    expect(navigate).toHaveBeenLastCalledWith(['/admin/billing/invoices'], { queryParams: { open: HITS[2].id } });
    pick(3);
    expect(navigate).toHaveBeenLastCalledWith(['/admin/builders'], { queryParams: { open: HITS[3].id } });
  });

  it('says so when nothing matches', () => {
    api.search.mockReturnValue(of({ query: 'zzz', hits: [] }));
    type('zzz');
    vi.advanceTimersByTime(300);
    fixture.detectChanges();
    expect(status()).toBe('No matches.');
    expect(options()).toEqual([]);
    expect(key('Enter').defaultPrevented).toBe(false);
  });

  it('shows an error with a retry', () => {
    api.search.mockReturnValue(throwError(() => ({ status: 500, message: 'boom' })));
    type('jor');
    vi.advanceTimersByTime(300);
    fixture.detectChanges();
    expect(status()).toContain('Search failed.');
    api.search.mockReturnValue(of({ query: 'jor', hits: HITS }));
    (el().querySelector('.admin-palette__retry') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(options()).toHaveLength(5);
  });

  it('the Esc button closes the dialog', () => {
    (el().querySelector('.admin-palette__close') as HTMLButtonElement).click();
    expect(dialogRef.close).toHaveBeenCalled();
  });
});
