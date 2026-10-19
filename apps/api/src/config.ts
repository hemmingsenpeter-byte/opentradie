import { z } from 'zod';

export interface ApiConfig {
  databaseUrl: string;
  sessionSecret: string;
  tenantId: string;
  appOrigin: string;
  deploymentProfile: 'local' | 'cloud' | 'hybrid';
  privacyMode: 'LOCAL_ONLY' | 'APPROVAL_REQUIRED' | 'APPROVED_CLOUD';
  agentMode: 'mock' | 'openclaw';
  modelLocation: 'local' | 'hosted';
  port: number;
  secureCookies: boolean;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const parsed = z.object({
    DATABASE_URL: z.string().url(),
    SESSION_SECRET: z.string().min(32),
    TENANT_ID: z.string().uuid(),
    APP_ORIGIN: z.string().url().default('http://localhost:5173'),
    DEPLOYMENT_PROFILE: z.enum(['local', 'cloud', 'hybrid']).default('local'),
    PRIVACY_MODE: z.enum(['LOCAL_ONLY', 'APPROVAL_REQUIRED', 'APPROVED_CLOUD']).default('LOCAL_ONLY'),
    AGENT_MODE: z.enum(['mock', 'openclaw']).default('mock'),
    MODEL_LOCATION: z.enum(['local', 'hosted']).default('local'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    SECURE_COOKIES: z.enum(['true', 'false']).default('false'),
  }).parse(env);
  const origin = new URL(parsed.APP_ORIGIN);
  if (origin.origin !== parsed.APP_ORIGIN) throw new Error('APP_ORIGIN must be an origin without a path or trailing slash.');
  if (parsed.DEPLOYMENT_PROFILE === 'cloud' && (origin.protocol !== 'https:' || parsed.SECURE_COOKIES !== 'true')) {
    throw new Error('Cloud profile requires HTTPS APP_ORIGIN and SECURE_COOKIES=true.');
  }
  return {
    databaseUrl: parsed.DATABASE_URL,
    sessionSecret: parsed.SESSION_SECRET,
    tenantId: parsed.TENANT_ID,
    appOrigin: parsed.APP_ORIGIN,
    deploymentProfile: parsed.DEPLOYMENT_PROFILE,
    privacyMode: parsed.PRIVACY_MODE,
    agentMode: parsed.AGENT_MODE,
    modelLocation: parsed.MODEL_LOCATION,
    port: parsed.PORT,
    secureCookies: parsed.SECURE_COOKIES === 'true',
  };
}
