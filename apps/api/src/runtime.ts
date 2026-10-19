import { MockAgentRuntime, RealOpenClawAgentRuntime, type AgentRuntime } from '@opentradie/agent';
import { createDatabase, databaseStatus, type Database } from '@opentradie/database';
import { claimInstallation, createEmbeddingProvider, createFileStore, type RuntimeConfig } from '@opentradie/platform';

/** Builds the profile-specific adapters. Business logic never branches on the profile. */
export function createAgentRuntime(config: RuntimeConfig): AgentRuntime {
  if (config.agent.mode === 'mock') return new MockAgentRuntime();
  return new RealOpenClawAgentRuntime({
    url: config.agent.url,
    token: config.agent.token,
    deviceStatePath: config.agent.deviceStatePath,
    agentId: config.agent.agentId,
    modelProvider: config.agent.modelProvider,
    inferenceLocation: config.agent.inferenceLocation,
  });
}

export function createAdapters(config: RuntimeConfig) {
  return {
    fileStore: createFileStore(config.fileStore),
    embeddingProvider: createEmbeddingProvider(config.embedding),
  };
}

/**
 * Start-up guard for every authoritative process: required migrations applied and the database
 * claimed by this installation (and gateway). A second authority refuses to start.
 */
export async function prepareAuthoritativeDatabase(config: RuntimeConfig): Promise<Database> {
  const db = createDatabase(config.databaseUrl);
  try {
    const status = await databaseStatus(db);
    if (status.status !== 'ok') throw new Error('Database unavailable or not migrated. Run pnpm db:migrate.');
    const required = status.pendingMigrations.filter((name) => !name.includes('knowledge_embeddings'));
    if (required.length) throw new Error(`Database migrations pending: ${required.join(', ')}. Run pnpm db:migrate.`);
    await claimInstallation(db, { installationId: config.installationId, profile: config.profile, gatewayUrl: config.agent.mode === 'openclaw' ? config.agent.url : null });
    return db;
  } catch (error) {
    await db.close();
    throw error;
  }
}
