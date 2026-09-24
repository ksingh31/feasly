import { mergeApplicationConfig } from '@angular/core';
import { provideServerRendering } from '@angular/ssr';
import { appConfig } from './app.config';
/**
 * Server config exists only so the builder can prerender routes at build time
 * (FE-6). There is no Node server at runtime — hosting is static (SWA).
 */
const serverConfig = {
    providers: [provideServerRendering()],
};
export const config = mergeApplicationConfig(appConfig, serverConfig);
