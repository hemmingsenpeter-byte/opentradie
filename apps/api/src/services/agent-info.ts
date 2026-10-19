import type { AgentHealth } from '@opentradie/agent';

export function agentInfo(health: AgentHealth) {
  return {
    runtime: health.runtime,
    synthetic: health.synthetic,
    provider: health.provider,
    label: health.synthetic ? (health.detail ?? 'Mock agent runtime') : null,
  };
}

/** Health probes must never hang a request. */
export async function agentHealthWithTimeout(
  runtime: { health(): Promise<AgentHealth> },
  timeoutMs = 3_000,
): Promise<AgentHealth | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      runtime.health(),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs);
      }),
    ]);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
