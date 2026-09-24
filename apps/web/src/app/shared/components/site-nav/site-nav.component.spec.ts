import { provideHttpClient } from '@angular/common/http';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { describe, expect, it } from 'vitest';
import { SiteNavComponent } from './site-nav.component';

/** QA audit: skip link first, and a >=44px brand tap target. */
describe('SiteNavComponent', () => {
  let fixture: ComponentFixture<SiteNavComponent>;

  function setup(): void {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [SiteNavComponent],
      providers: [provideHttpClient(), provideRouter([])],
    });
    fixture = TestBed.createComponent(SiteNavComponent);
    fixture.detectChanges();
  }

  it('renders the skip-to-content link as the first tab stop', () => {
    setup();
    const firstLink = fixture.nativeElement.querySelector('nav a');
    expect(firstLink?.classList.contains('skip-link')).toBe(true);
    expect(firstLink?.getAttribute('href')).toBe('#main-content');
    expect(firstLink?.textContent?.trim()).toBe('Skip to content');
  });

  it('gives the brand link a >=44px tap target', () => {
    setup();
    const brand = fixture.nativeElement.querySelector('.nav-brand') as HTMLElement;
    expect(parseFloat(getComputedStyle(brand).minHeight)).toBeGreaterThanOrEqual(44);
  });
});
