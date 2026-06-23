import type {
  FastifyBaseLogger,
  FastifyInstance,
  RawReplyDefaultExpression,
  RawRequestDefaultExpression,
  RawServerDefault,
} from 'fastify';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';

// `withTypeProvider()` 會改變 instance 的泛型參數,所以任何接收 app 的
// helper 都必須使用*相同*的具體型別 — 否則因為泛型不變性,Fastify 的
// route 方法會不相容。把它收斂成一個 alias,可讓 route 模組保持乾淨且
// 型別一致對齊。
export type AppInstance = FastifyInstance<
  RawServerDefault,
  RawRequestDefaultExpression,
  RawReplyDefaultExpression,
  FastifyBaseLogger,
  TypeBoxTypeProvider
>;
