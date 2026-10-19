import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
} from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { DeviceIdentity, GatewayClientHostDeps } from '@openclaw/gateway-client';

interface ClientDeviceState {
  identity: DeviceIdentity;
  tokens: Record<string, { token: string; scopes: string[] }>;
}

/** This is OPENTRADIE-owned client state; it never reads ~/.openclaw. */
export function fileDeviceAuth(path: string, gatewayOrigin: string): GatewayClientHostDeps {
  const file = resolve(path);
  let state: ClientDeviceState;
  try {
    state = JSON.parse(readFileSync(file, 'utf8')) as ClientDeviceState;
    if (!state.identity?.privateKeyPem || !state.identity.publicKeyPem || !state.tokens)
      throw new Error('Invalid client device state.');
    const derived = createPublicKey(createPrivateKey(state.identity.privateKeyPem)).export({
      format: 'der',
      type: 'spki',
    });
    if (
      createHash('sha256').update(derived.subarray(-32)).digest('hex') !== state.identity.deviceId
    )
      throw new Error('Invalid device key pair.');
    chmodSync(file, 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const keys = generateKeyPairSync('ed25519');
    const publicKeyPem = keys.publicKey.export({ format: 'pem', type: 'spki' }).toString();
    state = {
      identity: {
        deviceId: createHash('sha256')
          .update(keys.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32))
          .digest('hex'),
        publicKeyPem,
        privateKeyPem: keys.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
      },
      tokens: {},
    };
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    // Exclusive create prevents silently replacing a concurrently created key.
    writeFileSync(file, JSON.stringify(state), { mode: 0o600, flag: 'wx' });
  }
  function persist(): void {
    const temporary = `${file}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(state), { mode: 0o600 });
    renameSync(temporary, file);
  }
  const key = (role: string): string => `${gatewayOrigin}:${role}`;
  return {
    loadOrCreateDeviceIdentity: () => state.identity,
    signDevicePayload: (privateKeyPem, payload) =>
      sign(null, Buffer.from(payload), privateKeyPem).toString('base64url'),
    publicKeyRawBase64UrlFromPem: (pem) =>
      createPublicKey(pem)
        .export({ format: 'der', type: 'spki' })
        .subarray(-32)
        .toString('base64url'),
    loadDeviceAuthToken: ({ role }) => state.tokens[key(role)] ?? null,
    storeDeviceAuthToken: ({ role, token, scopes }) => {
      state.tokens[key(role)] = { token, scopes };
      persist();
    },
    clearDeviceAuthToken: ({ role }) => {
      delete state.tokens[key(role)];
      persist();
    },
    // The application never logs vendor errors or sensitive prompt payloads.
    logDebug: () => {},
    logError: () => {},
    redactForLog: () => '[gateway diagnostic omitted]',
  };
}
