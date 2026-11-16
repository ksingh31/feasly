import { describe, expect, it, vi } from 'vitest';
import { version as packageVersion } from '../package.json';
import { loadConfig, parseNarrativeModels, SEED_ADMIN_EMAIL } from '../src/config';
import { API_LEAD_CONSENT_VERSION, WAITLIST_CONSENT_VERSION } from '../src/lib/legal-copy';

const VALID_ENV = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/feasly',
} as NodeJS.ProcessEnv;

describe('loadConfig', () => {
  it('parses a valid env into typed config with defaults applied', () => {
    const config = loadConfig(VALID_ENV);
    expect(config).toEqual({
      serviceName: 'feasly-api',
      version: packageVersion,
      env: 'test',
      databaseUrl: 'postgresql://user:pass@localhost:5432/feasly',
      db: { poolMaxSize: 5 },
      rateLimit: { windowMs: 60_000, maxRequests: 100, maxTrackedKeys: 10_000 },
      sharedRateLimit: { sweepIntervalMs: 300_000 },
      lead: {
        rateLimit: { windowMs: 60_000, maxRequests: 10 },
        dedupWindowDays: 90,
        needsYouStaleDays: 7,
        needsYouScanLimit: 500,
        minSubmitMs: 2_000,
      },
      botChallenge: {
        enabled: false,
        siteKey: '',
        secretKey: '',
        verifyUrl: 'https://challenges.cloudflare.com/turnstile/v0/siteverify',
        verifyTimeoutMs: 5_000,
        windowMs: 86_400_000,
        verifyRateLimit: { windowMs: 3_600_000, maxRequests: 10 },
      },
      estimate: {
        rateLimit: { windowMs: 3_600_000, maxRequests: 20 },
        tenantRateLimit: { windowMs: 3_600_000, maxRequests: 600 },
      },
      analytics: {
        rateLimit: { windowMs: 60_000, maxRequests: 300 },
        funnelSourceGroupLimit: 25,
      },
      webTelemetry: {
        rateLimit: { windowMs: 60_000, maxRequests: 10 },
        maxTracesPerMinute: 60,
      },
      adminSearch: {
        ipRateLimit: { windowMs: 60_000, maxRequests: 300 },
        rateLimit: { windowMs: 60_000, maxRequests: 60 },
        maxHitsPerKind: 5,
      },
      webhook: {
        rateLimit: { windowMs: 60_000, maxRequests: 100 },
      },
      auth: {
        jwtTtlSeconds: 3_600,
        magicLinkTtlSeconds: 604_800,
        // HRD-03: per-email magic-link resend cooldown (default 60s).
        magicLinkReissueCooldownMs: 60_000,
        // P1-6: max magic-link sends per email per hour (default 5).
        magicLinkMaxSendsPerHour: 5,
        // #806: erase-confirmation link lifetime (default 24 h).
        eraseConfirmLinkTtlSeconds: 86_400,
        adminApiKey: undefined,
        adminSessionTtlSeconds: 43_200,
        adminSessionIdleTimeoutSeconds: 3_600,
        builderSessionTtlSeconds: 604_800,
        builderSessionIdleTimeoutSeconds: 86_400,
        sessionActivityTouchIntervalSeconds: 60,
        sessionReauthWindowSeconds: 1_800,
        // AUTH-01: Entra invitations expire after 7 days.
        invitationTtlSeconds: 604_800,
      },
      // AUTH-01: Entra External ID (Microsoft Graph user provisioning).
      // All values empty in test env → configured: false.
      entra: {
        tenantId: '',
        graphClientId: '',
        graphClientSecret: '',
        issuerDomain: '',
        loginBaseUrl: 'https://login.microsoftonline.com',
        graphBaseUrl: 'https://graph.microsoft.com',
        configured: false,
      },
      // auth/02: Entra External ID sign-in wiring — fail-closed while
      // unprovisioned.
      entraSignIn: {
        tenantSubdomain: '',
        tenantId: '',
        clientId: '',
        clientSecret: '',
        userFlow: '',
        configured: false,
        tokenEndpoint: 'https://.ciamlogin.com//oauth2/v2.0/token',
        jwksUri: 'https://.ciamlogin.com//discovery/v2.0/keys',
        issuer: 'https://.ciamlogin.com//v2.0',
        logoutEndpoint: 'https://.ciamlogin.com//oauth2/v2.0/logout',
        jwksCacheTtlMs: 600_000,
        httpTimeoutMs: 15_000,
        callbackRateLimit: { windowMs: 900_000, maxRequests: 10 },
      },
      // auth/05: builder-portal Entra sign-in — unprovisioned by default,
      // fail-closed (placeholder until Karan provisions the builder app
      // registration in the portal).
      builderEntraSignIn: {
        tenantSubdomain: '',
        tenantId: '',
        clientId: '',
        clientSecret: '',
        userFlow: '',
        configured: false,
        tokenEndpoint: 'https://.ciamlogin.com//oauth2/v2.0/token',
        jwksUri: 'https://.ciamlogin.com//discovery/v2.0/keys',
        issuer: 'https://.ciamlogin.com//v2.0',
        logoutEndpoint: 'https://.ciamlogin.com//oauth2/v2.0/logout',
        jwksCacheTtlMs: 600_000,
        httpTimeoutMs: 15_000,
        callbackRateLimit: { windowMs: 900_000, maxRequests: 10 },
      },
      corsOrigins: [],
      siteUrl: 'https://feasly.dev',
      queues: { email: 'email-queue', pdf: 'pdf-queue', sheets: 'sheets-queue' },
      email: {
        provider: 'log',
        fromAddress: 'noreply@feasly.example',
        fromName: 'Feasly',
        postmarkServerToken: undefined,
        postmarkEndpoint: 'https://api.postmarkapp.com/email',
        acsConnectionString: undefined,
        acsSendTimeoutMs: 7_000,
        // Worst case with in-code retries: 7+1+7+1+7 = 23s, inside the
        // frontend gate-submit timeout (25s).
        sendMaxAttempts: 3,
        appBaseUrl: 'https://feasly.example',
        unsubscribeUrlBase: 'https://feasly.example/unsubscribe',
        unsubscribeTokenSecret: undefined,
        unsubscribeTokenTtlSeconds: 2_592_000,
        opsInbox: SEED_ADMIN_EMAIL,
        opsAlertEmail: SEED_ADMIN_EMAIL,
        opsAlertDedupeWindowMs: 86_400_000,
        logLinks: true,
      },
      health: { dbTimeoutMs: 2_000 },
      costEngine: { allowDraftCostData: false },
      propertyData: {
        socrataBaseUrl: 'https://data.calgary.ca',
        datasetId: '4bsw-nn7w',
        cacheTtlMs: 300_000,
        httpTimeoutMs: 15_000,
        searchRowLimit: 50,
        suggestionLimit: 8,
        redevelopmentMinAgeYears: 25,
        // #756: durable shared cache + HTTP cache lifetime.
        dbCacheTtlMs: 604_800_000,
        dbCacheTimeoutMs: 1_500,
        httpCacheMaxAgeSeconds: 3_600,
      },
      // #686: current land-use district from the City's Land Use Districts
      // dataset; falls back to the roll value on timeout/error/no hit.
      landUse: {
        provider: 'calgary-land-use-districts',
        socrataBaseUrl: 'https://data.calgary.ca',
        datasetId: 'qe6k-p9nh',
        cacheTtlMs: 86_400_000,
        dbCacheTtlMs: 604_800_000,
        httpTimeoutMs: 3_000,
      },
      // #687: zoning rules catalogue city + public cache lifetime.
      zoning: {
        city: 'calgary',
        cacheMaxAgeSeconds: 3_600,
        // #757: daily City-source watcher (no token = detect, file no issue).
        freshnessCacheTtlMs: 300_000,
        watch: {
          enabled: true,
          socrataBaseUrl: 'https://data.calgary.ca',
          landUseDatasetId: 'qe6k-p9nh',
          bylawPageUrl:
            'https://www.calgary.ca/pda/pd/calgary-land-use-bylaw-1p2007/calgary-land-use-bylaw-1p2007.html',
          httpTimeoutMs: 15_000,
          githubRepo: 'ksingh31/feasly',
          githubToken: '',
          githubApiUrl: 'https://api.github.com',
        },
      },
      // #888: builder partner list caches (in-memory TTL + HTTP max-age).
      partners: { cacheTtlMs: 300_000, cacheMaxAgeSeconds: 300 },
      // trust-strip/01: landing "Refreshed <Month Year>" from the Socrata
      // dataset metadata. Reuses the SOCRATA_* source; 24h cache TTL on
      // successful fetches only.
      cityDataFreshness: {
        socrataBaseUrl: 'https://data.calgary.ca',
        datasetId: '4bsw-nn7w',
        httpTimeoutMs: 15_000,
        cacheTtlMs: 86_400_000,
      },
      billing: {
        model: 'commission',
        commissionRate: 0.01,
        attributionWindowDays: 365,
        reportingSlaDays: 14,
        flatPlanName: 'Builder Standard',
        flatMonthlyCents: 30_000,
        flatCurrency: 'CAD',
        stripeSecretKey: undefined,
        stripeWebhookSecret: undefined,
        stripeFlatPriceId: undefined,
        isProduction: false,
        maxChargeRetries: 3,
        settlementThresholdHours: 24,
        cardExpiryWarningDays: 30,
        tax: {
          enabled: false,
          ratePercent: 5,
          label: 'GST',
          inclusive: false,
          supplierLegalName: 'PLACEHOLDER_SUPPLIER_LEGAL_NAME',
          supplierAddress: 'PLACEHOLDER_SUPPLIER_ADDRESS',
          registrationNumber: 'PLACEHOLDER_GST_NUMBER',
        },
      },
      // #753: payment provider — `stripe` unless PAYMENTS_PROVIDER=simulated.
      payments: {
        provider: 'stripe',
        simulatedWebhookSecret: undefined,
        simulatedWebhookDelayMs: 1_500,
      },
      sandboxPurge: {
        retentionDays: 30,
        dryRun: true,
      },
      apiKeyAuth: {
        authCacheTtlSeconds: 0,
        acceptedModes: 'all',
      },
      followUpEmail: {
        enabled: false,
        delayHours: 72,
      },
      builderNotifications: {
        enabled: true,
        maxAttempts: 5,
        retryWindowHours: 24,
        claimLeaseMinutes: 10,
        digestLocalHour: 7,
        digestTimeZone: 'America/Edmonton',
      },
      communityStatsRefresh: {
        minAssessmentCount: 10,
        alertAfterConsecutiveFailures: 2,
        pruneMinRows: 100,
      },
      neighbourhoodData: {
        providers: {
          schoolDirectory: 'calgary-open-data',
          schoolDesignation: 'none',
          schoolRatings: 'none',
          reviews: 'none',
          amenities: 'calgary-open-data',
          commute: 'straight-line',
        },
        socrataBaseUrl: 'https://data.calgary.ca',
        schoolsDatasetId: 'fd9t-tdn2',
        amenityCategories: [
          expect.objectContaining({ key: 'parks', datasetId: 'kami-qbfh' }),
          expect.objectContaining({ key: 'playgrounds', datasetId: 'bdu9-amk8' }),
          expect.objectContaining({ key: 'pathways', datasetId: 'qndb-27qm' }),
          expect.objectContaining({ key: 'rec-centres', datasetId: 'hxfu-6d96' }),
          expect.objectContaining({ key: 'pools', datasetId: 'hxfu-6d96' }),
          expect.objectContaining({ key: 'libraries', datasetId: 'x34e-bcjz', where: "type='Library'" }),
          expect.objectContaining({ key: 'off-leash', datasetId: 'enr4-crti' }),
        ],
        publicTreesDatasetId: 'tfs4-3wwa',
        communityBoundariesDatasetId: 'surr-xmvs',
        treeCoverThresholds: [11, 16],
        amenitySearchRadiusM: 3_000,
        amenityCountRadiiM: [500, 1_000],
        communityMetricsTtlMs: 86_400_000,
        communityPointsDatasetId: 'j9ps-fyst',
        communityClass: 'Residential',
        communityStructures: ['INNER CITY', '1950s', '1960s/1970s'],
        commuteDestination: { name: 'Downtown', lat: 51.0453, lng: -114.0581 },
        httpTimeoutMs: 15_000,
        maxRows: 50_000,
        refreshDayOfMonth: 1,
        alertAfterFailureDays: 3,
        lotRadiusM: 1_000,
        lotMetricsTtlMs: 2_592_000_000,
      },
      backupCheck: {
        enabled: false,
        subscriptionId: '',
        resourceGroup: 'rg-feasly-dev',
        serverName: 'feasly-dev-pg-4fhkep',
        minRetentionDays: 7,
        maxStaleHours: 48,
        imdsTokenUrl:
          'http://169.254.169.254/metadata/identity/oauth2/token?api-version=2018-02-01&resource=https%3A%2F%2Fmanagement.azure.com%2F',
        identityEndpoint: undefined,
        identityHeader: undefined,
        armBaseUrl: 'https://management.azure.com',
      },
      sheets: {
        sheetId: '',
        serviceAccountEmail: '',
        serviceAccountPrivateKey: '',
        maxLeadsPerRun: 500,
        apiScope: 'https://www.googleapis.com/auth/spreadsheets',
        enabled: false,
        lagAfterHours: 2,
        runStaleAfterMin: 30,
      },
      narrative: {
        provider: 'log',
        apiKey: '',
        models: ['gemini-3.8-flash'],
        timeoutMs: 20_000,
        endpoint: 'https://generativelanguage.googleapis.com/v1beta/openai/',
        fallback: {
          endpoint: 'https://api.groq.com/openai/v1',
          apiKey: '',
          models: ['openai/gpt-oss-120b'],
        },
      },
      communityNarratives: {
        enabled: true,
        schedule: '0 0 9 * * *',
        runDay: 'last',
        retryDays: 3,
        models: ['gemini-3.8-flash'],
        promptVersion: 'community-v1',
        maxPerRun: 400,
        adminBudgetMs: 60_000,
        tickBudgetMs: 1_200_000,
      },
      embed: {
        relayCodeTtlSeconds: 600,
        relayResendCooldownSeconds: 60,
        sessionTtlSeconds: 43_200,
      },
      waitlist: {
        consentVersion: WAITLIST_CONSENT_VERSION,
      },
      apiAccess: {
        dailyQuota: 100,
        monthlyQuota: 2_000,
        leadConsentVersion: API_LEAD_CONSENT_VERSION,
        quarantineLeads: true,
      },
    });
  });

  it('reads the agent API quotas, consent version and quarantine flag (#738)', () => {
    const config = loadConfig({
      ...VALID_ENV,
      API_KEY_DAILY_QUOTA: '5',
      API_KEY_MONTHLY_QUOTA: '50',
      API_LEAD_CONSENT_VERSION: ' api-lead-2027-01-01 ',
      API_KEY_LEADS_QUARANTINE: 'false',
    });
    expect(config.apiAccess).toEqual({
      dailyQuota: 5,
      monthlyQuota: 50,
      leadConsentVersion: 'api-lead-2027-01-01',
      quarantineLeads: false,
    });
  });

  it('reads the waitlist consent version from WAITLIST_CONSENT_VERSION (#740)', () => {
    const config = loadConfig({ ...VALID_ENV, WAITLIST_CONSENT_VERSION: ' waitlist-2027-01-01 ' });
    expect(config.waitlist.consentVersion).toBe('waitlist-2027-01-01');
  });

  it('reads LEAD_MIN_SUBMIT_MS (#788), allows 0 and rejects negatives', () => {
    expect(loadConfig({ ...VALID_ENV, LEAD_MIN_SUBMIT_MS: '4500' }).lead.minSubmitMs).toBe(4_500);
    expect(loadConfig({ ...VALID_ENV, LEAD_MIN_SUBMIT_MS: '0' }).lead.minSubmitMs).toBe(0);
    expect(() => loadConfig({ ...VALID_ENV, LEAD_MIN_SUBMIT_MS: '-1' })).toThrow(/LEAD_MIN_SUBMIT_MS/);
  });

  it('enables the bot challenge (#788) only when both the Turnstile site key and secret are set', () => {
    expect(loadConfig({ ...VALID_ENV, TURNSTILE_SITE_KEY: 'site' }).botChallenge.enabled).toBe(false);
    expect(loadConfig({ ...VALID_ENV, TURNSTILE_SECRET_KEY: 'secret' }).botChallenge.enabled).toBe(false);
    const config = loadConfig({
      ...VALID_ENV,
      TURNSTILE_SITE_KEY: 'site',
      TURNSTILE_SECRET_KEY: 'secret',
      BOT_CHALLENGE_WINDOW_MS: '3600000',
      BOT_CHALLENGE_VERIFY_MAX_ATTEMPTS: '5',
      BOT_CHALLENGE_VERIFY_WINDOW_MS: '600000',
    });
    expect(config.botChallenge).toMatchObject({
      enabled: true,
      siteKey: 'site',
      secretKey: 'secret',
      windowMs: 3_600_000,
      verifyRateLimit: { windowMs: 600_000, maxRequests: 5 },
    });
  });

  it('reads the reno draft-data flag from COST_ENGINE_ALLOW_DRAFT', () => {
    const config = loadConfig({ ...VALID_ENV, COST_ENGINE_ALLOW_DRAFT: 'true' });
    expect(config.costEngine.allowDraftCostData).toBe(true);
  });

  it('derives the Entra sign-in endpoints when the tenant is provisioned (auth/02)', () => {
    const config = loadConfig({
      ...VALID_ENV,
      ENTRA_TENANT_SUBDOMAIN: 'feaslyext',
      ENTRA_TENANT_ID: 'tenant-123',
      ENTRA_CLIENT_ID: 'client-abc',
      ENTRA_CLIENT_SECRET: 'secret-xyz',
      ENTRA_USER_FLOW: 'feasly-signup-signin',
    });
    expect(config.entraSignIn).toEqual({
      tenantSubdomain: 'feaslyext',
      tenantId: 'tenant-123',
      clientId: 'client-abc',
      clientSecret: 'secret-xyz',
      userFlow: 'feasly-signup-signin',
      configured: true,
      tokenEndpoint: 'https://feaslyext.ciamlogin.com/tenant-123/oauth2/v2.0/token',
      jwksUri: 'https://feaslyext.ciamlogin.com/tenant-123/discovery/v2.0/keys',
      // id_token iss uses the tenant id as host (tenant openid-configuration).
      issuer: 'https://tenant-123.ciamlogin.com/tenant-123/v2.0',
      logoutEndpoint: 'https://feaslyext.ciamlogin.com/tenant-123/oauth2/v2.0/logout',
      jwksCacheTtlMs: 600_000,
      httpTimeoutMs: 15_000,
      callbackRateLimit: { windowMs: 900_000, maxRequests: 10 },
    });
  });

  it('keeps Entra sign-in unconfigured when the client secret is missing (auth/02)', () => {
    // The redirect URI is on the "Web" platform: without the secret the
    // token endpoint rejects the exchange with 401 invalid_client, so the
    // callback must fail closed (503) until the secret is provisioned.
    const config = loadConfig({
      ...VALID_ENV,
      ENTRA_TENANT_SUBDOMAIN: 'feaslyext',
      ENTRA_TENANT_ID: 'tenant-123',
      ENTRA_CLIENT_ID: 'client-abc',
      ENTRA_USER_FLOW: 'feasly-signup-signin',
    });
    expect(config.entraSignIn.configured).toBe(false);
    expect(config.entraSignIn.clientSecret).toBe('');
  });

  it('reads the billing model, rate, window, and SLA from env', () => {
    const config = loadConfig({
      ...VALID_ENV,
      BILLING_MODEL: 'flat',
      BILLING_COMMISSION_RATE: '0.02',
      BILLING_ATTRIBUTION_WINDOW_DAYS: '180',
      BILLING_REPORTING_SLA_DAYS: '7',
      BILLING_FLAT_PLAN_NAME: 'Builder Pro',
      BILLING_FLAT_MONTHLY_CENTS: '45000',
      BILLING_FLAT_CURRENCY: 'usd',
    });
    expect(config.billing).toEqual({
      model: 'flat',
      commissionRate: 0.02,
      attributionWindowDays: 180,
      reportingSlaDays: 7,
      flatPlanName: 'Builder Pro',
      flatMonthlyCents: 45_000,
      flatCurrency: 'USD',
      stripeSecretKey: undefined,
      stripeWebhookSecret: undefined,
      stripeFlatPriceId: undefined,
      isProduction: false,
      maxChargeRetries: 3,
      settlementThresholdHours: 24,
      cardExpiryWarningDays: 30,
      tax: {
        enabled: false,
        ratePercent: 5,
        label: 'GST',
        inclusive: false,
        supplierLegalName: 'PLACEHOLDER_SUPPLIER_LEGAL_NAME',
        supplierAddress: 'PLACEHOLDER_SUPPLIER_ADDRESS',
        registrationNumber: 'PLACEHOLDER_GST_NUMBER',
      },
    });
  });

  it('reads the GST settings (#714) and defaults to tax OFF, 5%, commission plus GST', () => {
    const config = loadConfig({
      ...VALID_ENV,
      BILLING_TAX_ENABLED: 'true',
      BILLING_TAX_RATE: '0.13',
      BILLING_TAX_LABEL: 'HST',
      BILLING_TAX_INCLUSIVE: 'true',
      BILLING_SUPPLIER_LEGAL_NAME: 'Example Holdings Ltd.',
      BILLING_SUPPLIER_ADDRESS: '100 Example St SW, Calgary AB',
      BILLING_TAX_REGISTRATION_NUMBER: '123456789RT0001',
    });
    expect(config.billing.tax).toEqual({
      enabled: true,
      ratePercent: 13,
      label: 'HST',
      inclusive: true,
      supplierLegalName: 'Example Holdings Ltd.',
      supplierAddress: '100 Example St SW, Calgary AB',
      registrationNumber: '123456789RT0001',
    });
    expect(loadConfig(VALID_ENV).billing.tax?.enabled).toBe(false);
    expect(() => loadConfig({ ...VALID_ENV, BILLING_TAX_ENABLED: 'yes' })).toThrow(
      /BILLING_TAX_ENABLED/,
    );
  });

  it('allows placeholder supplier details with tax ON outside production (#714)', () => {
    expect(
      loadConfig({ ...VALID_ENV, BILLING_TAX_ENABLED: 'true' }).billing.tax?.enabled,
    ).toBe(true);
  });

  it('reads BILLING_SETTLEMENT_THRESHOLD_HOURS (#711) and rejects non-positive values', () => {
    expect(
      loadConfig({ ...VALID_ENV, BILLING_SETTLEMENT_THRESHOLD_HOURS: '48' }).billing
        .settlementThresholdHours,
    ).toBe(48);
    expect(() =>
      loadConfig({ ...VALID_ENV, BILLING_SETTLEMENT_THRESHOLD_HOURS: '0' }),
    ).toThrow(/BILLING_SETTLEMENT_THRESHOLD_HOURS/);
  });

  it('#725: BUILDER_DIGEST_TIMEZONE must be a real IANA zone', () => {
    expect(
      loadConfig({ ...VALID_ENV, BUILDER_DIGEST_TIMEZONE: 'America/Toronto' })
        .builderNotifications.digestTimeZone,
    ).toBe('America/Toronto');
    expect(() =>
      loadConfig({ ...VALID_ENV, BUILDER_DIGEST_TIMEZONE: 'America/Edmonon' }),
    ).toThrow(/BUILDER_DIGEST_TIMEZONE/);
  });

  it('reads BILLING_STATEMENT_DESCRIPTOR (#716) and enforces Stripe descriptor rules', () => {
    expect(loadConfig(VALID_ENV).billing.statementDescriptor).toBeUndefined();
    expect(
      loadConfig({ ...VALID_ENV, BILLING_STATEMENT_DESCRIPTOR: ' FEASLY COMMISSION ' })
        .billing.statementDescriptor,
    ).toBe('FEASLY COMMISSION');
    expect(() =>
      loadConfig({ ...VALID_ENV, BILLING_STATEMENT_DESCRIPTOR: 'X'.repeat(23) }),
    ).toThrow(/BILLING_STATEMENT_DESCRIPTOR/);
    expect(() =>
      loadConfig({ ...VALID_ENV, BILLING_STATEMENT_DESCRIPTOR: 'FEASLY*COMM' }),
    ).toThrow(/BILLING_STATEMENT_DESCRIPTOR/);
    expect(() =>
      loadConfig({ ...VALID_ENV, BILLING_STATEMENT_DESCRIPTOR: '12345' }),
    ).toThrow(/BILLING_STATEMENT_DESCRIPTOR/);
  });

  it('reads BILLING_CARD_EXPIRY_WARNING_DAYS (#716) and rejects 0', () => {
    expect(
      loadConfig({ ...VALID_ENV, BILLING_CARD_EXPIRY_WARNING_DAYS: '45' }).billing
        .cardExpiryWarningDays,
    ).toBe(45);
    expect(() =>
      loadConfig({ ...VALID_ENV, BILLING_CARD_EXPIRY_WARNING_DAYS: '0' }),
    ).toThrow(/BILLING_CARD_EXPIRY_WARNING_DAYS/);
  });

  it('rejects an unknown billing model naming the variable', () => {
    expect(() => loadConfig({ ...VALID_ENV, BILLING_MODEL: 'per-lead' })).toThrow(
      /BILLING_MODEL/,
    );
  });

  it('rejects a commission rate above 100% naming the variable', () => {
    expect(() => loadConfig({ ...VALID_ENV, BILLING_COMMISSION_RATE: '1.5' })).toThrow(
      /BILLING_COMMISSION_RATE/,
    );
  });

  it('rejects a zero attribution window naming the variable', () => {
    expect(() => loadConfig({ ...VALID_ENV, BILLING_ATTRIBUTION_WINDOW_DAYS: '0' })).toThrow(
      /BILLING_ATTRIBUTION_WINDOW_DAYS/,
    );
  });

  it('composes DATABASE_URL from POSTGRES_* pieces when it is absent', () => {
    const config = loadConfig({
      NODE_ENV: 'test',
      POSTGRES_HOST: 'feasly-dev-pg-abc.postgres.database.azure.com',
      POSTGRES_DB: 'feasly',
      POSTGRES_USER: 'feaslyadmin',
      POSTGRES_PASSWORD: 'p@ss:w/rd?',
    } as NodeJS.ProcessEnv);
    expect(config.databaseUrl).toBe(
      'postgresql://feaslyadmin:p%40ss%3Aw%2Frd%3F@feasly-dev-pg-abc.postgres.database.azure.com:5432/feasly?sslmode=require',
    );
  });

  it('prefers an explicit DATABASE_URL over POSTGRES_* pieces', () => {
    const config = loadConfig({
      ...VALID_ENV,
      POSTGRES_HOST: 'other.example.com',
      POSTGRES_DB: 'feasly',
      POSTGRES_USER: 'feaslyadmin',
      POSTGRES_PASSWORD: 'x',
    });
    expect(config.databaseUrl).toBe('postgresql://user:pass@localhost:5432/feasly');
  });

  it('fails fast naming DATABASE_URL when neither form is configured', () => {
    expect(() =>
      loadConfig({ NODE_ENV: 'test', POSTGRES_HOST: 'h' } as NodeJS.ProcessEnv),
    ).toThrow(/DATABASE_URL/);
  });

  it('fails fast naming DATABASE_URL when it is missing', () => {
    expect(() => loadConfig({ NODE_ENV: 'test' } as NodeJS.ProcessEnv)).toThrow(
      /DATABASE_URL/,
    );
  });

  it('rejects a non-Postgres DATABASE_URL naming the variable', () => {
    expect(() =>
      loadConfig({ ...VALID_ENV, DATABASE_URL: 'mysql://localhost/db' }),
    ).toThrow(/DATABASE_URL/);
  });

  it('rejects a negative TTL naming the variable', () => {
    expect(() => loadConfig({ ...VALID_ENV, JWT_TTL_SECONDS: '-5' })).toThrow(
      /JWT_TTL_SECONDS/,
    );
  });

  it('rejects a non-numeric rate limit naming the variable', () => {
    expect(() =>
      loadConfig({ ...VALID_ENV, RATE_LIMIT_MAX_REQUESTS: 'many' }),
    ).toThrow(/RATE_LIMIT_MAX_REQUESTS/);
  });

  it('rejects an invalid NODE_ENV naming the variable', () => {
    expect(() => loadConfig({ ...VALID_ENV, NODE_ENV: 'bogus' })).toThrow(
      /NODE_ENV/,
    );
  });

  it('treats empty-string values as unset so defaults apply', () => {
    const config = loadConfig({
      ...VALID_ENV,
      RATE_LIMIT_WINDOW_MS: '',
      CORS_ORIGINS: '',
    });
    expect(config.rateLimit.windowMs).toBe(60_000);
    expect(config.corsOrigins).toEqual([]);
  });

  it('parses CORS_ORIGINS into a trimmed list', () => {
    const config = loadConfig({
      ...VALID_ENV,
      CORS_ORIGINS: ' https://app.feasly.com,https://admin.feasly.com ,,',
    });
    expect(config.corsOrigins).toEqual([
      'https://app.feasly.com',
      'https://admin.feasly.com',
    ]);
  });

  it('coerces numeric strings to numbers', () => {
    const config = loadConfig({
      ...VALID_ENV,
      RATE_LIMIT_MAX_REQUESTS: '10',
      MAGIC_LINK_TTL_SECONDS: '600',
    });
    expect(config.rateLimit.maxRequests).toBe(10);
    expect(config.auth.magicLinkTtlSeconds).toBe(600);
  });

  it('estimates rate limits default to the registry values (TECH_PLAN.md §13.3: 20/hr/IP, 600/hr/tenant)', () => {
    const config = loadConfig(VALID_ENV);
    expect(config.estimate.rateLimit).toEqual({
      windowMs: 3_600_000,
      maxRequests: 20,
    });
    // #737: the per-tenant cap must cover the 10x launch target (500/hr).
    expect(config.estimate.tenantRateLimit).toEqual({
      windowMs: 3_600_000,
      maxRequests: 600,
    });
    expect(config.estimate.tenantRateLimit.maxRequests).toBeGreaterThanOrEqual(500);
  });

  it('estimates rate limits are env-overridable', () => {
    const config = loadConfig({
      ...VALID_ENV,
      ESTIMATE_RATE_LIMIT_MAX_REQUESTS: '5',
      ESTIMATE_TENANT_RATE_LIMIT_MAX_REQUESTS: '7',
    });
    expect(config.estimate.rateLimit.maxRequests).toBe(5);
    expect(config.estimate.tenantRateLimit.maxRequests).toBe(7);
  });

  it('unsubscribe token config: 30-day default TTL, secret optional (fail-closed at use)', () => {
    const defaults = loadConfig(VALID_ENV);
    expect(defaults.email.unsubscribeTokenTtlSeconds).toBe(2_592_000);
    expect(defaults.email.unsubscribeTokenSecret).toBeUndefined();

    const configured = loadConfig({
      ...VALID_ENV,
      UNSUBSCRIBE_TOKEN_SECRET: 'kv-ref',
      UNSUBSCRIBE_TOKEN_TTL_SECONDS: '86400',
    });
    expect(configured.email.unsubscribeTokenSecret).toBe('kv-ref');
    expect(configured.email.unsubscribeTokenTtlSeconds).toBe(86400);
  });

  it('version is the single source of truth: mirrors package.json', () => {
    expect(loadConfig(VALID_ENV).version).toBe(packageVersion);
  });

  it('requires sk_test_ Stripe keys outside production (no real charges in dev/staging)', () => {
    const config = loadConfig({
      ...VALID_ENV,
      STRIPE_SECRET_KEY: 'sk_test_123',
      STRIPE_WEBHOOK_SECRET: 'whsec_123',
    });
    expect(config.billing.stripeSecretKey).toBe('sk_test_123');

    // Invalid key in non-production: warn and treat as unconfigured
    // (don't crash the API — 2026-09-28 fix for dev outage).
    // Note: computed property avoids secrets-scanner FP on the fixture.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const stripeKeyName = 'STRIPE_SECRET_KEY';
    expect(
      loadConfig({ ...VALID_ENV, [stripeKeyName]: 'not-a-real-key' }).billing
        .stripeSecretKey,
    ).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('not an sk_test_ key'),
    );
    warnSpy.mockRestore();
  });

  it('PAYMENTS_PROVIDER (#753): fails closed to stripe unless simulated is set explicitly', () => {
    // Deployed Function Apps set no NODE_ENV, so "everything unset" must be stripe.
    const { NODE_ENV: _omit, ...noNodeEnv } = VALID_ENV as Record<string, string>;
    expect(loadConfig(noNodeEnv).payments).toEqual({
      provider: 'stripe',
      simulatedWebhookSecret: undefined,
      simulatedWebhookDelayMs: 1_500,
    });
    expect(loadConfig({ ...VALID_ENV, NODE_ENV: 'development' }).payments.provider).toBe('stripe');
    expect(loadConfig({ ...VALID_ENV, NODE_ENV: 'staging' }).payments.provider).toBe('stripe');
    expect(loadConfig({ ...VALID_ENV, NODE_ENV: 'production' }).payments.provider).toBe('stripe');
    const explicit = loadConfig({
      ...VALID_ENV,
      PAYMENTS_PROVIDER: 'simulated',
      PAYMENTS_SIMULATED_WEBHOOK_SECRET: 'sim-secret-0123456789',
      PAYMENTS_SIMULATED_WEBHOOK_DELAY_MS: '0',
    });
    expect(explicit.payments).toEqual({
      provider: 'simulated',
      simulatedWebhookSecret: 'sim-secret-0123456789',
      simulatedWebhookDelayMs: 0,
    });
    expect(() => loadConfig({ ...VALID_ENV, PAYMENTS_PROVIDER: 'paypal' })).toThrow(
      /PAYMENTS_PROVIDER/,
    );
  });

  it('production refuses to boot with the simulated payment provider (#753)', () => {
    expect(() =>
      loadConfig({ ...VALID_ENV, NODE_ENV: 'production', PAYMENTS_PROVIDER: 'simulated' }),
    ).toThrow(/PAYMENTS_PROVIDER: production cannot use the simulated payment provider/);
  });

  it('refuses the simulated provider alongside a live Stripe key, whatever NODE_ENV says (#753)', () => {
    const { NODE_ENV: _omit, ...noNodeEnv } = VALID_ENV as Record<string, string>;
    // Built from parts so the HRD-07 secrets scan doesn't read it as a live key.
    const fakeLiveKey = ['sk', 'live', 'placeholder'].join('_');
    expect(() =>
      loadConfig({
        ...noNodeEnv,
        PAYMENTS_PROVIDER: 'simulated',
        STRIPE_SECRET_KEY: fakeLiveKey,
      }),
    ).toThrow(/PAYMENTS_PROVIDER: the simulated payment provider cannot run with a live/);
  });

  it('requires sk_live_ Stripe keys in production', () => {
    const config = loadConfig({
      ...VALID_ENV,
      NODE_ENV: 'production',
      STRIPE_SECRET_KEY: 'sk_live_123',
      STRIPE_WEBHOOK_SECRET: 'whsec_123',
    });
    expect(config.billing.stripeSecretKey).toBe('sk_live_123');

    expect(() =>
      loadConfig({
        ...VALID_ENV,
        NODE_ENV: 'production',
        STRIPE_SECRET_KEY: 'sk_test_123',
      }),
    ).toThrow(/production requires an sk_live_ key/);
  });

  it('production refuses tax ON while supplier details are placeholders (#714)', () => {
    // Built at runtime so the secrets scanner (HRD-07) never sees a key-shaped literal.
    const fakeLiveKey = ['sk', 'live', '123'].join('_');
    const fakeWebhookSecret = ['whsec', '123'].join('_');
    const prod = {
      ...VALID_ENV,
      NODE_ENV: 'production',
      STRIPE_SECRET_KEY: fakeLiveKey,
      STRIPE_WEBHOOK_SECRET: fakeWebhookSecret,
    };
    expect(() => loadConfig({ ...prod, BILLING_TAX_ENABLED: 'true' })).toThrow(
      /BILLING_TAX_REGISTRATION_NUMBER: required when BILLING_TAX_ENABLED=true in production/,
    );
    // Tax OFF in production with placeholders is fine (pre-tax behaviour).
    expect(loadConfig(prod).billing.tax?.enabled).toBe(false);
    expect(
      loadConfig({
        ...prod,
        BILLING_TAX_ENABLED: 'true',
        BILLING_SUPPLIER_LEGAL_NAME: 'Example Holdings Ltd.',
        BILLING_SUPPLIER_ADDRESS: '100 Example St SW, Calgary AB',
        BILLING_TAX_REGISTRATION_NUMBER: '123456789RT0001',
      }).billing.tax?.enabled,
    ).toBe(true);
  });

  it('leaves billing dormant when no Stripe key is configured', () => {
    const config = loadConfig(VALID_ENV);
    expect(config.billing.stripeSecretKey).toBeUndefined();
  });
});

describe('parseNarrativeModels (BE-9)', () => {
  it('parses a comma-separated list in order', () => {
    expect(parseNarrativeModels('gemini-3.8-flash')).toEqual([
      'gemini-3.8-flash',
    ]);
  });

  it('trims whitespace and drops empty entries', () => {
    expect(parseNarrativeModels('  a ,, b ,')).toEqual(['a', 'b']);
  });

  it('throws on an empty list so a misconfigured deployment fails fast', () => {
    expect(() => parseNarrativeModels('')).toThrow(/NARRATIVE_MODELS/);
    expect(() => parseNarrativeModels(' , ')).toThrow(/NARRATIVE_MODELS/);
  });

  it('reads the community-narrative overrides (#759)', () => {
    const config = loadConfig({
      ...VALID_ENV,
      NARRATIVE_MODELS: 'm1',
      COMMUNITY_NARRATIVE_MODELS: 'c1, c2',
      COMMUNITY_NARRATIVE_RUN_DAY: '25',
      COMMUNITY_NARRATIVE_PROMPT_VERSION: 'community-v2',
      COMMUNITY_NARRATIVE_ENABLED: 'false',
    });
    expect(config.communityNarratives).toMatchObject({
      enabled: false,
      runDay: 25,
      models: ['c1', 'c2'],
      promptVersion: 'community-v2',
    });
    // Empty override falls back to NARRATIVE_MODELS.
    expect(loadConfig({ ...VALID_ENV, NARRATIVE_MODELS: 'm1' }).communityNarratives.models).toEqual(['m1']);
    expect(() => loadConfig({ ...VALID_ENV, COMMUNITY_NARRATIVE_RUN_DAY: '31' })).toThrow();
  });

  it('reads a custom NARRATIVE_MODELS and NARRATIVE_TIMEOUT_MS from env', () => {
    const config = loadConfig({
      ...VALID_ENV,
      NARRATIVE_MODELS: 'm1, m2',
      NARRATIVE_TIMEOUT_MS: '5000',
    });
    expect(config.narrative.models).toEqual(['m1', 'm2']);
    expect(config.narrative.timeoutMs).toBe(5000);
  });
});
