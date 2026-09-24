import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ApplicationInitStatus, inject, provideAppInitializer, } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import { ConfigService } from './config.service';
/**
 * Proves the wiring the app itself uses: APP_INITIALIZER calls
 * ConfigService.load(), and bootstrap waits for it before first render.
 */
describe('config APP_INITIALIZER wiring', () => {
    it('blocks init until the config JSON is loaded and merged', async () => {
        TestBed.configureTestingModule({
            providers: [
                provideHttpClient(),
                provideHttpClientTesting(),
                provideAppInitializer(() => inject(ConfigService).load()),
            ],
        });
        const initStatus = TestBed.inject(ApplicationInitStatus);
        const httpMock = TestBed.inject(HttpTestingController);
        const service = TestBed.inject(ConfigService);
        const done = initStatus.donePromise;
        // The initializer must have fired the request before init completes.
        httpMock.expectOne('/assets/config/app-config.json').flush({
            timings: { resendCooldownSec: 45 },
        });
        await done;
        expect(service.get('timings').resendCooldownSec).toBe(45);
        httpMock.verify();
    });
});
