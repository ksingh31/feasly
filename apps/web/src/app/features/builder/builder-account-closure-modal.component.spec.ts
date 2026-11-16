/**
 * "Ask to close my account" dialog (#861): sends the closure request with
 * an optional note, closes with the outcome, shows the API message inline.
 */
import { DialogRef } from '@angular/cdk/dialog';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideStore } from '@ngxs/store';
import { of, throwError } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { BuilderAccountClosureModalComponent } from './builder-account-closure-modal.component';
import { BuilderSettingsState } from './builder-settings.state';
import { BuilderSettingsApiService } from './builder-settings-api.service';
import { BUILDER_COPY } from './builder-copy';
import { DEFAULT_BUILDER_COPY } from './builder-copy.defaults';
import { ConfigService } from '../../core/config/config.service';
import { DEFAULT_APP_CONFIG } from '../../core/config/app-config.defaults';

const COPY = DEFAULT_BUILDER_COPY.settings;
const RESPONSE = { requestId: 'r1', created: true, requestedAt: '2026-11-16T00:00:00Z' };

function setup(requestAccountClosure = vi.fn().mockReturnValue(of(RESPONSE))) {
  TestBed.resetTestingModule();
  const ref = { close: vi.fn() };
  TestBed.configureTestingModule({
    imports: [BuilderAccountClosureModalComponent],
    providers: [
      provideStore([BuilderSettingsState]),
      { provide: BuilderSettingsApiService, useValue: { requestAccountClosure } },
      { provide: BUILDER_COPY, useValue: DEFAULT_BUILDER_COPY },
      {
        provide: ConfigService,
        useValue: { get: (s: keyof typeof DEFAULT_APP_CONFIG) => DEFAULT_APP_CONFIG[s] },
      },
      { provide: DialogRef, useValue: ref },
    ],
  });
  const fixture: ComponentFixture<BuilderAccountClosureModalComponent> = TestBed.createComponent(
    BuilderAccountClosureModalComponent,
  );
  fixture.detectChanges();
  return { fixture, el: fixture.nativeElement as HTMLElement, ref, requestAccountClosure };
}

function setNote(el: HTMLElement, value: string): void {
  const area = el.querySelector('[data-testid="closure-note"]') as HTMLTextAreaElement;
  area.value = value;
  area.dispatchEvent(new Event('input'));
}

function submit(el: HTMLElement): void {
  (el.querySelector('form') as HTMLFormElement).dispatchEvent(new Event('submit'));
}

describe('BuilderAccountClosureModalComponent (#861)', () => {
  it('explains what happens and caps the note from config', () => {
    const { el } = setup();
    expect(el.textContent).toContain(COPY.closeModalIntro);
    const area = el.querySelector('[data-testid="closure-note"]') as HTMLTextAreaElement;
    expect(area.getAttribute('maxlength')).toBe(String(DEFAULT_APP_CONFIG.limits.builderAccountClosureNoteMaxLength));
  });

  it('sends without a note and closes with "created"', () => {
    const { el, ref, requestAccountClosure } = setup();
    submit(el);
    expect(requestAccountClosure).toHaveBeenCalledWith({});
    expect(ref.close).toHaveBeenCalledWith('created');
  });

  it('sends the trimmed note and closes with "duplicate" for a repeat', () => {
    const api = vi.fn().mockReturnValue(of({ ...RESPONSE, created: false }));
    const { el, ref } = setup(api);
    setNote(el, '  Retiring at year end  ');
    submit(el);
    expect(api).toHaveBeenCalledWith({ reason: 'Retiring at year end' });
    expect(ref.close).toHaveBeenCalledWith('duplicate');
  });

  it('keeps the dialog open with the API message on failure', () => {
    const api = vi.fn().mockReturnValue(throwError(() => ({ message: 'Only owners can do that.' })));
    const { el, fixture, ref } = setup(api);
    submit(el);
    fixture.detectChanges();
    expect(ref.close).not.toHaveBeenCalled();
    expect(el.querySelector('[data-testid="closure-error"]')?.textContent).toContain('Only owners can do that.');
  });
});
