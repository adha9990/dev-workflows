import type { FastifyError } from 'fastify';
import type { AppInstance } from './app-instance';

// 為整個 API 提供單一、一致的錯誤封套。
export function registerErrorHandler(app: AppInstance): void {
  app.setErrorHandler((error: FastifyError, request, reply) => {
    const status = error.statusCode ?? 500;
    if (status >= 500) {
      request.log.error(error);
    }
    reply.code(status).send({
      error: {
        message: error.message,
        code: status,
      },
    });
  });
}
