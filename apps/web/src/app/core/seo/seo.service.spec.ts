import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { Meta, Title } from '@angular/platform-browser';
import { beforeEach, describe, expect, it } from 'vitest';
import { ConfigService } from '../config/config.service';
import { SeoService } from './seo.service';

/** FE1-001: per-page SEO tags are set idempotently. */
describe('SeoService', () => {
  let service: SeoService;
  let httpMock: HttpTestingController;

  beforeEach(async () => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    httpMock = TestBed.inject(HttpTestingController);
    const config = TestBed.inject(ConfigService);
    const pending = config.load();
    httpMock.expectOne('/assets/config/app-config.json').flush({ site: { url: 'https://feasly.com' } });
    await pending;
    service = TestBed.inject(SeoService);
  });

  it('sets title, description, OG tags, and canonical', () => {
    service.setPage({
      title: 'Feasly — Test page',
      description: 'A test page description.',
      path: '/test',
    });
    expect(TestBed.inject(Title).getTitle()).toBe('Feasly — Test page');
    expect(TestBed.inject(Meta).getTag('name="description"')?.content).toBe(
      'A test page description.',
    );
    expect(TestBed.inject(Meta).getTag('property="og:url"')?.content).toBe(
      'https://feasly.com/test',
    );
    const canonical = document.querySelector<HTMLLinkElement>('link[rel="canonical"]');
    expect(canonical?.href).toBe('https://feasly.com/test');
  });

  it('updates tags idempotently on repeat calls', () => {
    service.setPage({ title: 'One', description: 'First.', path: '/one' });
    service.setPage({ title: 'Two', description: 'Second.', path: '/two' });
    expect(TestBed.inject(Title).getTitle()).toBe('Two');
    expect(document.querySelectorAll('link[rel="canonical"]').length).toBe(1);
  });
});
