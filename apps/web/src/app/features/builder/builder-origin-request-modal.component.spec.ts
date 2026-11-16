/**
 * "Request a change" dialog (#871): files an origin-change request (admin
 * task); closes with the outcome; shows the API message inline.
 */
import { DIALOG_DATA, DialogRef } from '@angular/cdk/dialog';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideStore } from '@ngxs/store';
import { of, throwError } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { BuilderOriginRequestModalComponent } from './builder-origin-request-modal.component';
import { BuilderSettingsState } from './builder-settings.state';
import { BuilderSettingsApiService } from './builder-settings-api.service';
import { BUILDER_COPY } from './builder-copy';
import { DEFAULT_BUILDER_COPY } from './builder-copy.defaults';
import { ConfigService } from '../../core/config/config.service';
import { DEFAULT_APP_CONFIG } from '../../core/config/app-config.defaults';

const COPY = DEFAULT_BUILDER_COPY.settings;
const REQUEST = {
  id: 'r1',
  status: 'open' as const,
  add: ['https://staging.example.com'],
  remove: ['https://old.example.com'],
  note: 'New staging site',
  createdAt: '2026-11-16T00:00:00Z',
};

function setup(requestOriginChange = vi.fn().mockReturnValue(of({ request: REQUEST, created: true }))) {
  TestBed.resetTestingModule();
  const ref = { close: vi.fn() };
  TestBed.configureTestingModule({
    imports: [BuilderOriginRequestModalComponent],
    providers: [
      provideStore([BuilderSettingsState]),
      { provide: BuilderSettingsApiService, useValue: { requestOriginChange } },
      { provide: BUILDER_COPY, useValue: DEFAULT_BUILDER_COPY },
      {
        provide: ConfigService,
        useValue: { get: (s: keyof typeof DEFAULT_APP_CONFIG) => DEFAULT_APP_CONFIG[s] },
      },
      { provide: DialogRef, useValue: ref },
      {
        provide: DIALOG_DATA,
        useValue: { origins: ['https://www.example.com', 'https://old.example.com'] },
      },
    ],
  });
  const fixture: ComponentFixture<BuilderOriginRequestModalComponent> = TestBed.createComponent(
    BuilderOriginRequestModalComponent,
  );
  fixture.detectChanges();
  return { fixture, el: fixture.nativeElement as HTMLElement, ref, requestOriginChange };
}

function setText(el: HTMLElement, testId: string, value: string): void {
  const area = el.querySelector(`[data-testid="${testId}"]`) as HTMLTextAreaElement;
  area.value = value;
  area.dispatchEvent(new Event('input'));
}

function submit(el: HTMLElement): void {
  (el.querySelector('form') as HTMLFormElement).dispatchEvent(new Event('submit'));
}

describe('BuilderOriginRequestModalComponent (#871)', () => {
  it('lists the current origins as remove choices', () => {
    const { el } = setup();
    const boxes = Array.from(el.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'));
    expect(boxes.map((b) => b.dataset['origin'])).toEqual([
      'https://www.example.com',
      'https://old.example.com',
    ]);
  });

  it('asks for at least one change before sending', () => {
    const { el, fixture, requestOriginChange } = setup();
    submit(el);
    fixture.detectChanges();
    expect(requestOriginChange).not.toHaveBeenCalled();
    expect(el.querySelector('[data-testid="request-error"]')?.textContent).toContain(
      COPY.requestEmptyError,
    );
  });

  it('sends adds (one per line), removals and the note, then closes with the outcome', () => {
    const { el, fixture, ref, requestOriginChange } = setup();
    setText(el, 'request-add', 'https://staging.example.com\n\n');
    setText(el, 'request-note', '  New staging site ');
    const old = el.querySelector('input[data-origin="https://old.example.com"]') as HTMLInputElement;
    old.checked = true;
    old.dispatchEvent(new Event('change'));
    submit(el);
    fixture.detectChanges();
    expect(requestOriginChange).toHaveBeenCalledWith({
      add: ['https://staging.example.com'],
      remove: ['https://old.example.com'],
      note: 'New staging site',
    });
    expect(ref.close).toHaveBeenCalledWith('created');
  });

  it('keeps the dialog open with the API message on failure', () => {
    const { el, fixture, ref } = setup(
      vi.fn().mockReturnValue(throwError(() => ({ message: 'Each add entry must be https.' }))),
    );
    setText(el, 'request-add', 'http://insecure.example.com');
    submit(el);
    fixture.detectChanges();
    expect(ref.close).not.toHaveBeenCalled();
    expect(el.querySelector('[data-testid="request-error"]')?.textContent).toContain(
      'Each add entry must be https.',
    );
  });
});
