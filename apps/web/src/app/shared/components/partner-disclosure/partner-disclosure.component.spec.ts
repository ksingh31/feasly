import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { describe, expect, it } from 'vitest';
import type { BuilderPartner } from '@feasly/contracts';
import { DEFAULT_APP_CONFIG } from '../../../core/config/app-config.defaults';
import { ConfigService } from '../../../core/config/config.service';
import { PartnerDisclosureComponent } from './partner-disclosure.component';

const copy = DEFAULT_APP_CONFIG.copy.partners;

/** #918: "Leads from Feasly's site go to our builder partner(s): <names linked>". */
describe('PartnerDisclosureComponent', () => {
  function render(partners: readonly BuilderPartner[]): HTMLElement {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [PartnerDisclosureComponent],
      providers: [
        provideRouter([]),
        { provide: ConfigService, useValue: { get: () => DEFAULT_APP_CONFIG.copy } },
      ],
    });
    const fixture = TestBed.createComponent(PartnerDisclosureComponent);
    fixture.componentRef.setInput('partners', partners);
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  }

  const elite: BuilderPartner = {
    id: 'p1',
    name: 'Elite Craft Builders',
    logoUrl: null,
    websiteUrl: 'https://elite.example/',
    description: null,
  };
  const north: BuilderPartner = { id: 'p2', name: 'North Homes', logoUrl: null, websiteUrl: null, description: null };

  it('names every partner, linking the ones with a website', () => {
    const el = render([elite, north]);
    const text = el.textContent?.replace(/\s+/g, ' ').trim();
    expect(text).toContain(`${copy.disclosureLead} Elite Craft Builders`);
    expect(text).toContain('Elite Craft Builders (opens in a new tab), North Homes');
    const links = el.querySelectorAll('a');
    expect(links).toHaveLength(1);
    expect(links[0].getAttribute('href')).toBe('https://elite.example/');
    expect(links[0].getAttribute('target')).toBe('_blank');
    expect(links[0].getAttribute('rel')).toContain('noopener');
    expect(el.querySelector('.partner-name')?.textContent).toBe('North Homes');
  });

  it('falls back to the How it works partners section while the list is unavailable', () => {
    const el = render([]);
    expect(el.textContent).toContain(copy.disclosureFallbackLead);
    const link = el.querySelector('a') as HTMLAnchorElement;
    expect(link.textContent).toBe(copy.howItWorksLinkLabel);
    expect(link.getAttribute('href')).toBe('/how-it-works#partners');
  });

  it('ships the disclosure wording from the issue', () => {
    expect(copy.disclosureLead).toBe('Leads from Feasly’s site go to our builder partner(s):');
  });
});
