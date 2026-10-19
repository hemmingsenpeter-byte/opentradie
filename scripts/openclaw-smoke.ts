import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OPENCLAW_VERSION, RealOpenClawAgentRuntime } from '@opentradie/agent';
import { loadDotEnv } from './lib/env.js';

/**
 * pnpm test:openclaw — opt-in smoke test against a REAL, separately installed OpenClaw Gateway.
 * Reads OPENCLAW_URL and OPENCLAW_TOKEN (as in .env.example); OPENCLAW_DEVICE_PATH or
 * OPENCLAW_DEVICE_STATE_JSON for the paired device identity. Sends only synthetic fixtures.
 * Skips with exit code 0 when not configured, unless OPENCLAW_SMOKE_REQUIRED=true.
 */
loadDotEnv();
const url = process.env.OPENCLAW_URL;
const token = process.env.OPENCLAW_TOKEN;
if (!url || !token) {
  const message =
    'OpenClaw smoke SKIPPED: OPENCLAW_URL and OPENCLAW_TOKEN are not set. This is not evidence of a working integration.';
  if (process.env.OPENCLAW_SMOKE_REQUIRED === 'true') {
    process.stderr.write(`${message}\n`);
    process.exit(1);
  }
  process.stdout.write(`${message}\n`);
  process.exit(0);
}

let deviceStatePath = process.env.OPENCLAW_DEVICE_PATH ?? '.data/openclaw-device.json';
if (process.env.OPENCLAW_DEVICE_STATE_JSON) {
  deviceStatePath = join(await mkdtemp(join(tmpdir(), 'opentradie-openclaw-')), 'device.json');
  await writeFile(deviceStatePath, process.env.OPENCLAW_DEVICE_STATE_JSON, { mode: 0o600 });
}
const runtime = new RealOpenClawAgentRuntime({
  url,
  token,
  deviceStatePath,
  ...(process.env.OPENCLAW_AGENT_ID ? { agentId: process.env.OPENCLAW_AGENT_ID } : {}),
  ...(process.env.OPENCLAW_MODEL_PROVIDER
    ? { modelProvider: process.env.OPENCLAW_MODEL_PROVIDER }
    : {}),
});
try {
  const health = await runtime.health();
  process.stdout.write(
    `${JSON.stringify({ check: 'openclaw-gateway-health', pinnedClient: OPENCLAW_VERSION, ...health })}\n`,
  );
  if (health.status !== 'ok')
    throw new Error(`Gateway unavailable: ${health.detail ?? 'health check failed'}`);
  const proposal = await runtime.interpret({
    requestId: randomUUID(),
    prompt:
      'SYNTHETIC SMOKE TEST: Mrs Johnson needs two power points replaced. Prepare a proposal.',
    context: {
      customers: [{ name: 'Margaret Johnson' }],
      rates: [
        { code: 'power_point_replace', label: 'Replace existing double power point', unit: 'each' },
      ],
    },
  });
  const line = proposal.lineItems.find((item) => item.rateCode === 'power_point_replace');
  if (!line || line.quantity !== 2 || !/johnson/i.test(proposal.customerQuery))
    throw new Error('Real model returned an unexpected (but schema-valid) proposal.');
  process.stdout.write(
    `${JSON.stringify({ check: 'openclaw-interpretation', passed: true, syntheticInput: true })}\n`,
  );
} catch (error) {
  process.stderr.write(
    `OpenClaw smoke FAILED: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
} finally {
  await runtime.close();
}
