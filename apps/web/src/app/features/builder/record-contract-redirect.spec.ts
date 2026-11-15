/**
 * #529 AC3: the retired record-contract page redirects to the Leads home,
 * opening the lead drawer when a lead is named.
 */
import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { describe, expect, it } from 'vitest';
import { recordContractRedirect } from './record-contract-redirect';

@Component({ standalone: true, template: '' })
class BlankComponent {}

async function navigate(url: string): Promise<string> {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      provideRouter([
        {
          path: 'builder',
          children: [
            { path: '', component: BlankComponent },
            { path: 'record-contract', redirectTo: recordContractRedirect },
            { path: 'report-contract', redirectTo: recordContractRedirect },
          ],
        },
      ]),
    ],
  });
  const router = TestBed.inject(Router);
  await router.navigateByUrl(url);
  return router.url;
}

describe('recordContractRedirect (#529)', () => {
  it('sends /builder/record-contract?lead=<id> to the lead drawer', async () => {
    expect(await navigate('/builder/record-contract?lead=lead-c')).toBe('/builder?open=lead-c');
  });

  it('sends a bare /builder/record-contract to the Leads home', async () => {
    expect(await navigate('/builder/record-contract')).toBe('/builder');
  });

  it('covers the older /builder/report-contract path too', async () => {
    expect(await navigate('/builder/report-contract?lead=lead-a')).toBe('/builder?open=lead-a');
  });
});
