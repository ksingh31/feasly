/**
 * Admin shell component tests.
 *
 * Verifies: the header carries the brand logo, the mobile menu toggle
 * opens/closes the nav (with aria-expanded), and the menu closes when a
 * nav link is clicked or navigation completes.
 */
import { Component, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { Store } from '@ngxs/store';
import { of } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminShellComponent } from './admin-shell.component';
import { SeoService } from '../../core/seo/seo.service';

/** Blank route target. */
@Component({ standalone: true, template: '' })
class BlankComponent {}

async function setup() {
  TestBed.resetTestingModule();
  const seo = { setPage: vi.fn() };

  // auth/04: the view-as banner reads via store.selectSignal — the mock
  // returns a null banner (banner hidden).
  const store = {
    dispatch: vi.fn().mockReturnValue(of({})),
    selectSignal: vi.fn().mockReturnValue(signal(null)),
  };

  TestBed.configureTestingModule({
    imports: [AdminShellComponent, BlankComponent],
    providers: [
      provideRouter([{ path: '**', component: BlankComponent }]),
      { provide: SeoService, useValue: seo },
      { provide: Store, useValue: store },
    ],
  });
  const fixture: ComponentFixture<AdminShellComponent> =
    TestBed.createComponent(AdminShellComponent);
  fixture.detectChanges();
  await fixture.whenStable();
  return { fixture };
}

function toggleButton(fixture: ComponentFixture<AdminShellComponent>): HTMLButtonElement {
  const el = fixture.nativeElement.querySelector('.admin-shell__menu-toggle');
  if (!el) throw new Error('menu toggle button not found');
  return el as HTMLButtonElement;
}

function nav(fixture: ComponentFixture<AdminShellComponent>): HTMLElement {
  const el = fixture.nativeElement.querySelector('.admin-shell__nav');
  if (!el) throw new Error('admin nav not found');
  return el as HTMLElement;
}

describe('AdminShellComponent', () => {
  beforeEach(setup);

  it('shows the brand mark in the header', async () => {
    const { fixture } = await setup();
    const mark = fixture.nativeElement.querySelector('.admin-shell__brand app-brand-mark');
    expect(mark).not.toBeNull();
    expect(
      fixture.nativeElement.querySelector('.admin-shell__wordmark')?.textContent,
    ).toContain('Feasly');
  });

  it('toggles the mobile nav open and closed', async () => {
    const { fixture } = await setup();
    const button = toggleButton(fixture);
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(nav(fixture).classList.contains('admin-shell__nav--open')).toBe(false);

    button.click();
    fixture.detectChanges();
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(nav(fixture).classList.contains('admin-shell__nav--open')).toBe(true);

    button.click();
    fixture.detectChanges();
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(nav(fixture).classList.contains('admin-shell__nav--open')).toBe(false);
  });

  it('closes the menu when a nav link is clicked', async () => {
    const { fixture } = await setup();
    toggleButton(fixture).click();
    fixture.detectChanges();
    expect(nav(fixture).classList.contains('admin-shell__nav--open')).toBe(true);

    const link = fixture.nativeElement.querySelector(
      '.admin-shell__nav a',
    ) as HTMLAnchorElement;
    link.click();
    fixture.detectChanges();
    await fixture.whenStable();
    expect(nav(fixture).classList.contains('admin-shell__nav--open')).toBe(false);
  });
});
