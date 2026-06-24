import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { createServer } from '../http/create-server';
import { createLogger } from '../adapters/logging/create-logger';
import { createSqliteMetadataStore } from '../adapters/db/sqlite-metadata-store';
import { migrateDatabase } from '../adapters/db/migrator';
import { NoteRepo } from '../repositories/note-repo';
import { NoteService } from '../services/note/note-service';

// Composition root + CLI 進入點。這是唯一允許接觸所有東西的地方:
// 它讀取 config、把 adapter 接線到 service,並啟動 Fastify。
interface DevConfig {
  database?: string;
  host?: string;
  port?: number;
  log_level?: string;
  log_format?: 'pretty' | 'json';
  client_dir?: string;
}

function loadConfig(): DevConfig {
  const idx = process.argv.indexOf('--config');
  if (idx === -1) {
    return {};
  }
  const path = process.argv[idx + 1];
  return JSON.parse(readFileSync(path, 'utf8')) as DevConfig;
}

async function serve(): Promise<void> {
  const config = loadConfig();

  const logger = createLogger({
    level: config.log_level ?? 'info',
    pretty: (config.log_format ?? 'pretty') === 'pretty',
  });

  const dbPath = resolve(config.database ?? './data/app.db');
  migrateDatabase(dbPath);
  const store = createSqliteMetadataStore(dbPath);
  const noteService = new NoteService(new NoteRepo(store));

  const app = await createServer({
    logger,
    noteService,
    clientDir: config.client_dir ? resolve(config.client_dir) : undefined,
  });

  const host = config.host ?? '127.0.0.1';
  const port = config.port ?? 51599;
  await app.listen({ host, port });
}

const command = process.argv[2];

if (command === 'serve') {
  serve().catch((error) => {
    console.error(error);
    process.exit(1);
  });
} else {
  console.error(`Unknown command: ${command ?? '(none)'}. Usage: server.ts serve --config <path>`);
  process.exit(1);
}
