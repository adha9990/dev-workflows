import { Type, type Static } from '@sinclair/typebox';

// TypeBox schema 同時兼具 runtime 驗證(Fastify 會依此驗證)
// 與編譯期型別(透過 Static<>)。一份定義,兩種保證。
export const NoteSchema = Type.Object({
  id: Type.String(),
  title: Type.String(),
  body: Type.String(),
  createdAt: Type.String(),
  updatedAt: Type.String(),
});

export const CreateNoteSchema = Type.Object({
  title: Type.String({ minLength: 1 }),
  body: Type.Optional(Type.String()),
});

export const NoteListSchema = Type.Object({
  items: Type.Array(NoteSchema),
});

export type NoteDto = Static<typeof NoteSchema>;
export type CreateNoteDto = Static<typeof CreateNoteSchema>;
