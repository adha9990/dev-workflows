import { CreateNoteSchema, NoteListSchema, NoteSchema, type CreateNoteDto } from '../schemas/note';
import type { AppInstance } from '../app-instance';
import type { NoteService } from '../../services/note/note-service';

// Route 模組:notes 的 HTTP adapter。它以 TypeBox schema 驗證,
// 委派給 service,並塑形回應。這裡沒有商業邏輯。
export async function registerNoteRoutes(
  app: AppInstance,
  deps: { noteService: NoteService },
): Promise<void> {
  app.get('/api/v1/notes', {
    schema: { response: { 200: NoteListSchema } },
  }, async () => {
    const items = await deps.noteService.list();
    return { items };
  });

  app.post('/api/v1/notes', {
    schema: { body: CreateNoteSchema, response: { 201: NoteSchema } },
  }, async (request, reply) => {
    const body = request.body as CreateNoteDto;
    const note = await deps.noteService.create({ title: body.title, body: body.body ?? '' });
    reply.code(201);
    return note;
  });
}
