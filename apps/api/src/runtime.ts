import { MockAgentRuntime, RealOpenClawAgentRuntime, type AgentRuntime } from '@opentradie/agent';
import { createDatabase, databaseStatus, type Database } from '@opentradie/database';
import {
  FasterWhisperHttpAdapter,
  MockSpeechToText,
  WhisperCppServerAdapter,
  type SpeechToText,
} from '@opentradie/integrations/speech';
import {
  claimInstallation,
  createEmbeddingProvider,
  createFileStore,
  type RuntimeConfig,
} from '@opentradie/platform';

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

/** Synthetic demo transcript for SPEECH_PROVIDER=mock (development, tests and demos only). */
export const DEMO_VOICE_TRANSCRIPT =
  "Finished the job at Smith's house. One and a half hours labour, $185 mixer from Reece. Prepare the invoice and remind me to check the hot water cylinder next year.";

/** Speech-to-text adapter for voice notes; null when not configured. */
export function createSpeechToText(config: RuntimeConfig): SpeechToText | null {
  const speech = config.speech;
  switch (speech.provider) {
    case 'none':
      return null;
    case 'mock':
      return new MockSpeechToText({
        text: DEMO_VOICE_TRANSCRIPT,
        durationMs: 9_000,
        segments: [
          {
            startMs: 0,
            endMs: 2_000,
            text: "Finished the job at Smith's house.",
            confidence: 0.94,
          },
          { startMs: 2_000, endMs: 3_600, text: 'One and a half hours labour,', confidence: 0.9 },
          { startMs: 3_600, endMs: 5_200, text: '$185 mixer from Reece.', confidence: 0.48 },
          {
            startMs: 5_200,
            endMs: 9_000,
            text: 'Prepare the invoice and remind me to check the hot water cylinder next year.',
            confidence: 0.88,
          },
        ],
      });
    case 'whisper_cpp':
      return new WhisperCppServerAdapter({ baseUrl: speech.baseUrl, model: speech.model });
    case 'openai_compatible':
      return new FasterWhisperHttpAdapter({
        baseUrl: speech.baseUrl,
        model: speech.model,
        ...(speech.apiKey ? { apiKey: speech.apiKey } : {}),
      });
  }
}

export function createAdapters(config: RuntimeConfig) {
  return {
    fileStore: createFileStore(config.fileStore),
    embeddingProvider: createEmbeddingProvider(config.embedding),
    speech: createSpeechToText(config),
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
    if (status.status !== 'ok')
      throw new Error('Database unavailable or not migrated. Run pnpm db:migrate.');
    const required = status.pendingMigrations.filter(
      (name) => !name.includes('knowledge_embeddings'),
    );
    if (required.length)
      throw new Error(`Database migrations pending: ${required.join(', ')}. Run pnpm db:migrate.`);
    await claimInstallation(db, {
      installationId: config.installationId,
      profile: config.profile,
      gatewayUrl: config.agent.mode === 'openclaw' ? config.agent.url : null,
    });
    return db;
  } catch (error) {
    await db.close();
    throw error;
  }
}
