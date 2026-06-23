import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { createServer } from '../src/http/create-server';
import { createLogger } from '../src/adapters/logging/create-logger';
import { createSqliteMetadataStore } from '../src/adapters/db/sqlite-metadata-store';
import { migrateDatabase } from '../src/adapters/db/migrator';
import { NoteRepo } from '../src/repositories/note-repo';
import { NoteService } from '../src/services/note/note-service';
import type { MetadataStore } from '../src/ports/metadata-store';

// 貫穿整個垂直切片的 e2e:HTTP → service → repository →
// SQLite。使用一個用完即丟的磁碟資料庫與 app.inject()(沒有真正的 socket)。
let app: FastifyInstance;
let store: MetadataStore;
let dir: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'layered-fullstack-e2e-'));
  const dbPath = join(dir, 'test.db');
  migrateDatabase(dbPath);
  store = createSqliteMetadataStore(dbPath);
  const noteService = new NoteService(new NoteRepo(store));
  app = await createServer({ logger: createLogger({ level: 'silent' }), noteService });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  // 在刪除檔案前先釋放 SQLite 連線 — 在 Windows 上,未關閉的
  // handle 會讓 rmSync 以 EPERM 失敗。
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('notes API', () => {
  it('reports healthy', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });

  it('creates a note and lists it back', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/notes',
      payload: { title: 'Hello', body: 'world' },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ title: 'Hello', body: 'world' });

    const list = await app.inject({ method: 'GET', url: '/api/v1/notes' });
    expect(list.statusCode).toBe(200);
    expect(list.json().items).toHaveLength(1);
  });

  it('rejects an empty title (schema validation)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/notes',
      payload: { title: '' },
    });
    expect(res.statusCode).toBe(400);
  });
});
