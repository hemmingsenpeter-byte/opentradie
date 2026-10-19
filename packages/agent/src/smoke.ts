import { randomUUID } from 'node:crypto';
import { RealOpenClawAgentRuntime } from './openclaw.js';

const url = process.env.OPENCLAW_GATEWAY_URL;
const token = process.env.OPENCLAW_GATEWAY_TOKEN;
const deviceStatePath = process.env.OPENCLAW_DEVICE_STATE_PATH;
if (!url || !token || !deviceStatePath) throw new Error('Configure OPENCLAW_GATEWAY_URL, OPENCLAW_GATEWAY_TOKEN and OPENCLAW_DEVICE_STATE_PATH for the real Gateway smoke.');
// Running this explicit command authorizes sending only these synthetic fixtures
// to the configured model. It never reads the business database.
const runtime = new RealOpenClawAgentRuntime({ url, token, deviceStatePath, ...(process.env.OPENCLAW_AGENT_ID ? { agentId: process.env.OPENCLAW_AGENT_ID } : {}) });
try {
  const health = await runtime.health();
  console.log(JSON.stringify({ check: 'real-gateway-health', ...health }));
  if (health.status !== 'ok') throw new Error(`Gateway smoke unavailable: ${health.detail ?? 'health check failed'}`);
  const proposal = await runtime.interpret({
    requestId: randomUUID(), prompt: 'Mrs Johnson needs two power points replaced. Prepare a proposal.',
    context: { customers: [{ id: 'synthetic-customer', name: 'Mrs Johnson' }], notes: ['SYNTHETIC FIXTURE. Confirm access before work.'], rates: [{ code: 'power_point', label: 'Replace one power point' }] },
  });
  if (proposal.rateCode !== 'power_point' || proposal.quantity !== 2 || !proposal.customerQuery.toLowerCase().includes('johnson')) throw new Error('Real model smoke returned an unexpected proposal.');
  console.log(JSON.stringify({ check: 'real-gateway-interpretation', passed: true, syntheticInput: true, gatewayVersion: health.version }));
} finally { await runtime.close(); }
