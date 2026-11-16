import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { ConfigService } from '../../../core/config/config.service';
import { PrivacyDataLinkComponent } from './privacy-data-link.component';

describe('PrivacyDataLinkComponent (#706)', () => {
  it('links to the privacy self-service page with the config-owned label', () => {
    TestBed.configureTestingModule({
      imports: [PrivacyDataLinkComponent],
      providers: [provideRouter([])],
    });
    const fixture = TestBed.createComponent(PrivacyDataLinkComponent);
    fixture.detectChanges();
    const a = (fixture.nativeElement as HTMLElement).querySelector('a');
    const label = TestBed.inject(ConfigService).get('copy').privacyData.entryLinkLabel;
    expect(a?.getAttribute('href')).toBe('/privacy/my-data');
    expect(a?.textContent?.trim()).toBe(label);
  });
});
