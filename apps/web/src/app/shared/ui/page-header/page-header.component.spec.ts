import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { describe, expect, it } from 'vitest';
import { PageHeaderComponent, type Breadcrumb } from './page-header.component';

@Component({
  standalone: true,
  imports: [PageHeaderComponent],
  template: `
    <ui-page-header
      [heading]="heading()"
      [description]="description()"
      [breadcrumbs]="crumbs()"
      headingId="page-title"
    >
      @if (withActions()) {
        <div uiPageHeaderActions><button type="button">New lead</button></div>
      }
    </ui-page-header>
  `,
})
class HostComponent {
  heading = signal('Leads');
  description = signal<string | null>('Everyone who asked for a quote.');
  crumbs = signal<Breadcrumb[]>([]);
  withActions = signal(true);
}

function setup() {
  TestBed.configureTestingModule({ imports: [HostComponent], providers: [provideRouter([])] });
  const fixture = TestBed.createComponent(HostComponent);
  fixture.detectChanges();
  const el = (): HTMLElement => fixture.nativeElement;
  return { fixture, el };
}

describe('PageHeaderComponent', () => {
  it('renders exactly one H1 with the heading and id', () => {
    const { el } = setup();
    const h1s = el().querySelectorAll('h1');
    expect(h1s).toHaveLength(1);
    expect(h1s[0].textContent?.trim()).toBe('Leads');
    expect(h1s[0].id).toBe('page-title');
  });

  it('renders the description only when given', () => {
    const { fixture, el } = setup();
    expect(el().querySelector('.ui-page-header__description')?.textContent).toContain(
      'Everyone who asked',
    );
    fixture.componentInstance.description.set(null);
    fixture.detectChanges();
    expect(el().querySelector('.ui-page-header__description')).toBeNull();
  });

  it('omits the breadcrumb nav when there are no crumbs', () => {
    const { el } = setup();
    expect(el().querySelector('nav')).toBeNull();
  });

  it('links ancestor crumbs and marks the last one as the current page', () => {
    const { fixture, el } = setup();
    fixture.componentInstance.crumbs.set([
      { label: 'Leads', link: '/builder/leads' },
      { label: 'Marco Silva', link: '/ignored' },
    ]);
    fixture.detectChanges();
    const nav = el().querySelector('nav')!;
    expect(nav.getAttribute('aria-label')).toBe('Breadcrumb');
    const links = nav.querySelectorAll('a');
    expect(links).toHaveLength(1);
    expect(links[0].getAttribute('href')).toBe('/builder/leads');
    const current = nav.querySelector('[aria-current="page"]');
    expect(current?.textContent).toBe('Marco Silva');
    expect(current?.tagName).toBe('SPAN');
  });

  it('projects actions into the actions slot', () => {
    const { el } = setup();
    expect(el().querySelector('.ui-page-header__actions button')?.textContent).toBe('New lead');
  });

  it('leaves the actions slot empty (hidden by :empty) without actions', () => {
    const { fixture, el } = setup();
    fixture.componentInstance.withActions.set(false);
    fixture.detectChanges();
    expect(el().querySelector('.ui-page-header__actions')?.children).toHaveLength(0);
  });
});
