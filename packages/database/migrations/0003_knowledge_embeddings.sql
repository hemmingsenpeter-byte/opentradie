-- requires-extension: vector
-- Optional semantic search store. Applied only where pgvector is installed (the CI service
-- container and Docker deployments). Text search never depends on it. When pgvector is absent
-- the migration stays pending and is applied automatically once the extension is available.
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE knowledge_embeddings (
  tenant_id uuid NOT NULL,
  knowledge_item_id uuid NOT NULL,
  provider text NOT NULL,
  dimensions integer NOT NULL CHECK (dimensions = 768),
  embedding vector(768) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, knowledge_item_id),
  FOREIGN KEY (tenant_id, knowledge_item_id) REFERENCES knowledge_items(tenant_id, id)
);
CREATE INDEX knowledge_embeddings_hnsw ON knowledge_embeddings USING hnsw (embedding vector_cosine_ops);
