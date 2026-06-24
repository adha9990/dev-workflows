// server package 的公開介面。在其他地方匯入 app(測試、
// Electron host、自訂進入點)都會經過這裡。
export { createServer } from './http/create-server';
export type { ServerDeps } from './http/server-deps';
export { createSqliteMetadataStore } from './adapters/db/sqlite-metadata-store';
export { migrateDatabase } from './adapters/db/migrator';
export { createLogger } from './adapters/logging/create-logger';
export { NoteRepo } from './repositories/note-repo';
export { NoteService } from './services/note/note-service';
export type { Note } from './domain/note/note';
export * from './errors';
