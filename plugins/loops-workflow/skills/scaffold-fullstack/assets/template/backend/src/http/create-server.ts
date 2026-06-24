import Fastify, { type FastifyBaseLogger } from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { registerErrorHandler } from './error-handler';
import { registerHealthRoutes } from './routes/health';
import { registerNoteRoutes } from './routes/notes';
import type { AppInstance } from './app-instance';
import type { ServerDeps } from './server-deps';

// HTTP adapter 工廠。它僅從注入的依賴組裝 Fastify,
// 別無其他 — 沒有資料庫、沒有檔案系統。它所需的一切都透過
// ServerDeps 傳入,這正是讓 server 可以用 app.inject() 輕鬆測試的原因。
export async function createServer(deps: ServerDeps): Promise<AppInstance> {
  // pino instance 在結構上滿足 FastifyBaseLogger;我們的 Logger port 是
  // 它的較窄視圖,因此這個 cast 在 runtime 是健全的。
  const app = Fastify({
    loggerInstance: deps.logger as unknown as FastifyBaseLogger,
  }).withTypeProvider<TypeBoxTypeProvider>();

  await app.register(cors, { origin: true });

  registerErrorHandler(app);
  await registerHealthRoutes(app);
  await registerNoteRoutes(app, { noteService: deps.noteService });

  // 選用的 single-process 模式:提供建置好的 SPA,並為 client 端 route
  //(任何非 /api 路徑)退回到 index.html。
  if (deps.clientDir) {
    await app.register(fastifyStatic, { root: deps.clientDir });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api')) {
        reply.code(404).send({ error: { message: 'Not found', code: 404 } });
        return;
      }
      reply.sendFile('index.html');
    });
  }

  return app;
}
