import { isIP } from 'node:net';
import { z } from 'zod';
import { privacyModes } from '@opentradie/core';

const bool = z.enum(['true', 'false']).transform((value) => value === 'true');

/**
 * One configuration schema for every deployment profile. Profiles change adapters and
 * guard-rails, never business logic. Invalid combinations refuse to start.
 */
const envSchema = z.object({
  DEPLOYMENT_PROFILE: z.enum(['local', 'cloud', 'hybrid']).default('local'),
  INSTALLATION_ID: z.string().regex(/^[a-z0-9][a-z0-9-]{2,62}$/).optional(),
  AUTHORITATIVE_RUNTIME: bool.default(true),
  DATABASE_URL: z.string().url(),
  SESSION_SECRET: z.string().min(32),
  TENANT_ID: z.string().uuid(),
  APP_ORIGIN: z.string().url().default('http://localhost:5173'),
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  SECURE_COOKIES: bool.default(false),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'silent']).default('info'),
  PRIVACY_MODE: z.enum(privacyModes).default('LOCAL_ONLY'),
  AGENT_MODE: z.enum(['mock', 'openclaw']).default('mock'),
  OPENCLAW_URL: z.string().url().default('ws://127.0.0.1:18789'),
  OPENCLAW_TOKEN: z.string().default(''),
  OPENCLAW_DEVICE_PATH: z.string().default('.data/openclaw-device.json'),
  OPENCLAW_AGENT_ID: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/).default('opentradie'),
  OPENCLAW_MODEL_PROVIDER: z.string().regex(/^[a-z0-9_.:-]{1,64}$/).default('unconfigured'),
  OPENCLAW_INFERENCE_LOCATION: z.enum(['local', 'hosted']).default('hosted'),
  EMBEDDING_PROVIDER: z.enum(['none', 'ollama', 'openai_compatible']).default('none'),
  EMBEDDING_URL: z.string().url().optional(),
  EMBEDDING_MODEL: z.string().min(1).max(128).optional(),
  EMBEDDING_API_KEY: z.string().optional(),
  FILE_STORE: z.enum(['local', 's3']).default('local'),
  FILE_STORE_PATH: z.string().default('.data/files'),
  S3_BUCKET: z.string().optional(),
  S3_REGION: z.string().default('auto'),
  S3_ENDPOINT: z.string().url().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_FORCE_PATH_STYLE: bool.default(false),
  CREDENTIAL_ENCRYPTION_KEY: z.string().regex(/^[0-9a-fA-F]{64}$/).optional(),
  RELAY_SHARED_SECRET: z.string().min(32).optional(),
});

export type DeploymentProfile = 'local' | 'cloud' | 'hybrid';

export interface RuntimeConfig {
  profile: DeploymentProfile;
  installationId: string;
  authoritative: boolean;
  databaseUrl: string;
  sessionSecret: string;
  tenantId: string;
  appOrigin: string;
  host: string;
  port: number;
  secureCookies: boolean;
  logLevel: z.infer<typeof envSchema>['LOG_LEVEL'];
  privacyMode: z.infer<typeof envSchema>['PRIVACY_MODE'];
  agent:
    | { mode: 'mock' }
    | {
        mode: 'openclaw';
        url: string;
        token: string;
        deviceStatePath: string;
        agentId: string;
        modelProvider: string;
        inferenceLocation: 'local' | 'hosted';
      };
  embedding:
    | { provider: 'none' }
    | { provider: 'ollama' | 'openai_compatible'; url: string; model: string; apiKey?: string };
  fileStore:
    | { kind: 'local'; path: string }
    | { kind: 's3'; bucket: string; region: string; endpoint?: string; accessKeyId?: string; secretAccessKey?: string; forcePathStyle: boolean };
  credentialEncryptionKey?: string;
  relaySharedSecret?: string;
}

export class ConfigError extends Error {
  constructor(readonly issues: string[]) {
    super(`Invalid configuration: ${issues.join(' ')}`);
    this.name = 'ConfigError';
  }
}

/** Loopback, RFC 1918/4193 private ranges and mDNS names: hosts that live on the installation's own network. */
export function isPrivateHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) return true;
  const version = isIP(host);
  if (version === 4) {
    const [a, b] = host.split('.').map(Number) as [number, number];
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  if (version === 6) return host === '::1' || host.startsWith('fc') || host.startsWith('fd');
  return false;
}

export function loadRuntimeConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    throw new ConfigError(result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}.`));
  }
  const e = result.data;
  const issues: string[] = [];
  const origin = new URL(e.APP_ORIGIN);
  if (origin.origin !== e.APP_ORIGIN) issues.push('APP_ORIGIN must be an origin without a path or trailing slash.');
  if (!e.AUTHORITATIVE_RUNTIME) {
    issues.push('AUTHORITATIVE_RUNTIME=false: the API and worker only run on the authoritative runtime. Run the relay elsewhere instead.');
  }
  if (e.AGENT_MODE === 'openclaw' && !e.OPENCLAW_TOKEN) issues.push('AGENT_MODE=openclaw requires OPENCLAW_TOKEN.');
  if (e.EMBEDDING_PROVIDER !== 'none' && (!e.EMBEDDING_URL || !e.EMBEDDING_MODEL)) {
    issues.push('EMBEDDING_PROVIDER requires EMBEDDING_URL and EMBEDDING_MODEL.');
  }
  if (e.FILE_STORE === 's3' && !e.S3_BUCKET) issues.push('FILE_STORE=s3 requires S3_BUCKET.');

  if (e.DEPLOYMENT_PROFILE === 'cloud') {
    if (origin.protocol !== 'https:' || !e.SECURE_COOKIES) issues.push('Cloud profile requires an HTTPS APP_ORIGIN and SECURE_COOKIES=true.');
    if (e.FILE_STORE !== 's3') issues.push('Cloud profile requires FILE_STORE=s3; container disks are not durable.');
    if (!e.CREDENTIAL_ENCRYPTION_KEY) issues.push('Cloud profile requires CREDENTIAL_ENCRYPTION_KEY.');
  }
  if (e.DEPLOYMENT_PROFILE === 'hybrid') {
    // The Mac mini is the single authoritative writer. Pointing it at a cloud database or a
    // cloud gateway would create a second authority, so both must be on the installation network.
    if (!isPrivateHost(new URL(e.DATABASE_URL).hostname)) {
      issues.push('Hybrid profile: DATABASE_URL must be the local authoritative database (loopback or private network), not a cloud database.');
    }
    if (e.AGENT_MODE === 'openclaw' && !isPrivateHost(new URL(e.OPENCLAW_URL).hostname)) {
      issues.push('Hybrid profile: OPENCLAW_URL must be the single local gateway, not a second cloud gateway.');
    }
  }
  if (issues.length) throw new ConfigError(issues);

  return {
    profile: e.DEPLOYMENT_PROFILE,
    installationId: e.INSTALLATION_ID ?? `install-${e.TENANT_ID.slice(0, 8)}`,
    authoritative: e.AUTHORITATIVE_RUNTIME,
    databaseUrl: e.DATABASE_URL,
    sessionSecret: e.SESSION_SECRET,
    tenantId: e.TENANT_ID.toLowerCase(),
    appOrigin: e.APP_ORIGIN,
    host: e.HOST,
    port: e.PORT,
    secureCookies: e.SECURE_COOKIES,
    logLevel: e.LOG_LEVEL,
    privacyMode: e.PRIVACY_MODE,
    agent:
      e.AGENT_MODE === 'mock'
        ? { mode: 'mock' }
        : {
            mode: 'openclaw',
            url: e.OPENCLAW_URL,
            token: e.OPENCLAW_TOKEN,
            deviceStatePath: e.OPENCLAW_DEVICE_PATH,
            agentId: e.OPENCLAW_AGENT_ID,
            modelProvider: e.OPENCLAW_MODEL_PROVIDER,
            inferenceLocation: e.OPENCLAW_INFERENCE_LOCATION,
          },
    embedding:
      e.EMBEDDING_PROVIDER === 'none'
        ? { provider: 'none' }
        : { provider: e.EMBEDDING_PROVIDER, url: e.EMBEDDING_URL!, model: e.EMBEDDING_MODEL!, ...(e.EMBEDDING_API_KEY ? { apiKey: e.EMBEDDING_API_KEY } : {}) },
    fileStore:
      e.FILE_STORE === 'local'
        ? { kind: 'local', path: e.FILE_STORE_PATH }
        : {
            kind: 's3',
            bucket: e.S3_BUCKET!,
            region: e.S3_REGION,
            forcePathStyle: e.S3_FORCE_PATH_STYLE,
            ...(e.S3_ENDPOINT ? { endpoint: e.S3_ENDPOINT } : {}),
            ...(e.S3_ACCESS_KEY_ID ? { accessKeyId: e.S3_ACCESS_KEY_ID } : {}),
            ...(e.S3_SECRET_ACCESS_KEY ? { secretAccessKey: e.S3_SECRET_ACCESS_KEY } : {}),
          },
    ...(e.CREDENTIAL_ENCRYPTION_KEY ? { credentialEncryptionKey: e.CREDENTIAL_ENCRYPTION_KEY.toLowerCase() } : {}),
    ...(e.RELAY_SHARED_SECRET ? { relaySharedSecret: e.RELAY_SHARED_SECRET } : {}),
  };
}

/** Safe subset for health and settings screens. Never includes secrets or URLs with credentials. */
export function describeConfig(config: RuntimeConfig) {
  return {
    profile: config.profile,
    installationId: config.installationId,
    authoritative: config.authoritative,
    privacyMode: config.privacyMode,
    agentMode: config.agent.mode,
    fileStore: config.fileStore.kind,
    embeddingProvider: config.embedding.provider,
  };
}
