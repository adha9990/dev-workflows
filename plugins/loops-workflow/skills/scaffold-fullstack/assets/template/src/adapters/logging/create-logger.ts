import { pino } from 'pino';
import type { Logger } from '../../ports/logger';

// Adapter:以 pino 為後端的 Logger。pino instance 在結構上滿足
// Logger port,因此 app 的其餘部分永遠不需匯入 pino。
export function createLogger(opts: { level?: string; pretty?: boolean } = {}): Logger {
  return pino({
    level: opts.level ?? 'info',
    transport: opts.pretty ? { target: 'pino-pretty' } : undefined,
  });
}
