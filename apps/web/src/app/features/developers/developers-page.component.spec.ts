import { ComponentFixture, TestBed } from '@angular/core/testing';
import { RouterTestingModule } from '@angular/router/testing';
import { DevelopersPageComponent } from './developers-page.component';
import { ConfigService } from '../../core/config';
import { SeoService } from '../../core/seo';

describe('DevelopersPageComponent', () => {
  let fixture: ComponentFixture<DevelopersPageComponent>;

  beforeEach(async () => {
    const configStub = { get: () => ({ copy: { seo: {} } }) };
    const seoStub = { setForRoute: () => undefined, setJsonLd: () => undefined };
    await TestBed.configureTestingModule({
      imports: [DevelopersPageComponent, RouterTestingModule],
      providers: [
        { provide: ConfigService, useValue: configStub },
        { provide: SeoService, useValue: seoStub },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(DevelopersPageComponent);
    fixture.detectChanges();
  });

  it('renders the page heading', () => {
    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelector('h1')?.textContent).toContain('Build on the Feasly API');
  });

  it('covers every required docs section', () => {
    const el: HTMLElement = fixture.nativeElement;
    const required = [
      'quickstart',
      'auth',
      'scopes',
      'rate-limits',
      'errors',
      'idempotency',
      'sandbox',
      'reference',
      'changelog',
    ];
    for (const id of required) {
      expect(el.querySelector(`#${id}`), `section #${id}`).toBeTruthy();
    }
  });

  it('links to the live OpenAPI spec', () => {
    const el: HTMLElement = fixture.nativeElement;
    const links = [...el.querySelectorAll('a[href*="openapi.json"]')];
    expect(links.length).toBeGreaterThan(0);
  });

  it('documents the API key scopes', () => {
    const text: string = fixture.nativeElement.textContent ?? '';
    for (const scope of ['property:read', 'estimate', 'estimate:read', 'lead', 'lead:read']) {
      expect(text, `scope ${scope}`).toContain(scope);
    }
  });
});
