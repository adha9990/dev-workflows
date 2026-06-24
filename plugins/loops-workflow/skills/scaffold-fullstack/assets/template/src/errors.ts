// 共用的錯誤型別。statusCode 會被 Fastify error handler 讀取,以將
// domain/service 的失敗對應到 HTTP 回應。
export class AppError extends Error {
  constructor(message: string, readonly statusCode: number = 500) {
    super(message);
    this.name = 'AppError';
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Not found') {
    super(message, 404);
    this.name = 'NotFoundError';
  }
}

export class ValidationError extends AppError {
  constructor(message = 'Invalid request') {
    super(message, 400);
    this.name = 'ValidationError';
  }
}
