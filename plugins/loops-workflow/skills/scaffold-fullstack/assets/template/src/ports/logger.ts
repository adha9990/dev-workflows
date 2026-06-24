// Port:一個 logging 接縫,內層可以依賴它而不需知道 pino 的存在。
export interface Logger {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
  debug(obj: unknown, msg?: string): void;
  child(bindings: Record<string, unknown>): Logger;
}
