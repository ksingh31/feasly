import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import { PageLayoutComponent, type PageLayoutPortal } from './page-layout.component';

@Component({
  standalone: true,
  imports: [PageLayoutComponent],
  template: `<ui-page-layout [portal]="portal()" [narrow]="narrow()"><p class="content">Body</p></ui-page-layout>`,
})
class HostComponent {
  portal = signal<PageLayoutPortal>('builder');
  narrow = signal(false);
}

function setup() {
  TestBed.configureTestingModule({ imports: [HostComponent] });
  const fixture = TestBed.createComponent(HostComponent);
  fixture.detectChanges();
  const host = (): HTMLElement => fixture.nativeElement.querySelector('ui-page-layout');
  return { fixture, host };
}

describe('PageLayoutComponent', () => {
  it('projects content inside the inner frame', () => {
    const { host } = setup();
    expect(host().querySelector('.ui-page-layout__inner .content')?.textContent).toBe('Body');
  });

  it('defaults to the builder width (no modifier classes)', () => {
    const { host } = setup();
    expect(host().classList).toContain('ui-page-layout');
    expect(host().classList).not.toContain('ui-page-layout--admin');
    expect(host().classList).not.toContain('ui-page-layout--narrow');
  });

  it('applies the admin and narrow variants', () => {
    const { fixture, host } = setup();
    fixture.componentInstance.portal.set('admin');
    fixture.componentInstance.narrow.set(true);
    fixture.detectChanges();
    expect(host().classList).toContain('ui-page-layout--admin');
    expect(host().classList).toContain('ui-page-layout--narrow');
  });

  it('accepts a bare `narrow` attribute', () => {
    @Component({
      standalone: true,
      imports: [PageLayoutComponent],
      template: `<ui-page-layout narrow>Form</ui-page-layout>`,
    })
    class BareHost {}
    TestBed.configureTestingModule({ imports: [BareHost] });
    const fixture = TestBed.createComponent(BareHost);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('ui-page-layout').classList).toContain(
      'ui-page-layout--narrow',
    );
  });

  it('renders no tinted wrapper element (only the transparent inner frame)', () => {
    const { host } = setup();
    expect(host().children).toHaveLength(1);
    expect(host().firstElementChild?.className).toBe('ui-page-layout__inner');
  });
});
