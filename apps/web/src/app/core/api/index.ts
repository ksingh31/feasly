/** @core/api barrel — the UI/backend seam. Components inject API_SERVICE only. */
export { API_SERVICE, provideApi } from './api.service';
export type { ApiService } from './api.service';
export { HttpApiService } from './http-api.service';
export { MockApiService } from './mock-api.service';
export { simulateLatency } from './latency';
