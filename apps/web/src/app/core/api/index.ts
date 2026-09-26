/** @core/api barrel — the UI/backend seam. Components inject API_SERVICE only. */
export { API_SERVICE, provideApi } from './api.service';
export type { ApiService } from './api.service';
export { HttpApiService } from './http-api.service';
export { MockApiService } from './mock-api.service';
export { toApiError } from './api-error';
export type { FunnelQuery, FunnelReport, FunnelStep, FunnelTenantFilter } from './funnel.types';
export { PROPERTY_DATA_SERVICE, providePropertyData } from './property-data.service';
export type { PropertyDataService } from './property-data.service';
export { CalgaryAssessmentService } from './calgary-assessment.service';
export { MockPropertyDataService } from './mock-property-data.service';
export { BackendPropertyDataService } from './backend-property-data.service';
export { simulateLatency } from './latency';
