import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ErrorRecoveryService } from '../../core/errors/error-recovery.service';
import { AdminErrorComponent } from './admin-error.component';

/**
 * #472: the in-shell admin error state — static copy, a retry that re-fires
 * the captured action, and a way back to the admin home (never the public
 * homepage).
 */
describe('AdminErrorComponent', () => {
  beforeEach(async () => {
    TestBed.resetTestingModule();
    await TestBed.configureTestingModule({
      imports: [AdminErrorComponent],
      providers: [provideRouter([])],
    }).compileComponents();
  });

  function render(): HTMLElement {
    const fixture = TestBed.createComponent(AdminErrorComponent);
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  }

  it('renders static copy as an alert, without a page-level main landmark', () => {
    const el = render();
    expect(el.querySelector('[role="alert"] h1')?.textContent).toContain(
      'Something went wrong on our end.',
    );
    // The admin shell owns <main>; the error state must not nest another.
    expect(el.querySelector('main')).toBeNull();
  });

  it('links back to the admin home', () => {
    const link = render().querySelector('a');
    expect(link?.getAttribute('href')).toBe('/admin');
  });

  it('"Try again" re-fires the captured failed action', () => {
    const recovery = TestBed.inject(ErrorRecoveryService);
    const retry = vi.fn();
    recovery.capture({ description: 'Reload the current page', retry });
    const button = render().querySelector('button') as HTMLButtonElement;
    button.click();
    expect(retry).toHaveBeenCalledTimes(1);
  });
});
