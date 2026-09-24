import { inject, InjectionToken } from '@angular/core';
import { ConfigService } from '../config/config.service';
import { HttpApiService } from './http-api.service';
import { MockApiService } from './mock-api.service';
/** DI token for the ApiService. Inject this, never a concrete class. */
export const API_SERVICE = new InjectionToken('feasly.api-service');
/**
 * Wires the ApiService implementation from config: `api.useMockApi` selects
 * the mock harness (FE0-003). Flipping that flag is the ONLY change needed to
 * point at the real backend later — the HttpApiService already speaks the
 * /api/v1 routes. Call once in app.config.ts.
 */
export function provideApi() {
    return {
        provide: API_SERVICE,
        useFactory: () => {
            const config = inject(ConfigService);
            return config.get('api').useMockApi ? inject(MockApiService) : inject(HttpApiService);
        },
    };
}
