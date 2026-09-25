import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectivityService } from '../../core/errors/connectivity.service';
import { OfflinePageComponent } from './offline-page.component';

/**
 * HRD-02: the offline page renders the story's exact copy and its retry
 * button re-probes the API (the shell restores the app when it answers).
 */
describe('OfflinePageComponent', () => {
  let fixture: ComponentFixture<OfflinePageComponent>;
  let checkHealth: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    checkHealth = vi.fn();
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [OfflinePageComponent],
      providers: [
        provideRouter([]),
        { provide: ConnectivityService, useValue: { checkHealth, offline: () => true } },
      ],
    });
    fixture = TestBed.createComponent(OfflinePageComponent);
    fixture.detectChanges();
    await fixture.whenStable();
  });

  it('renders the offline copy verbatim', () => {
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain("You're offline.");
    expect(text).toContain('Feasly needs an internet connection to look up City data.');
    expect(text).toContain('Try again');
  });

  it('the retry button re-probes the API', () => {
    (fixture.nativeElement as HTMLElement).querySelector('button.cta')?.dispatchEvent(new Event('click'));
    expect(checkHealth).toHaveBeenCalledTimes(1);
  });
});
