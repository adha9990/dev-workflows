import type { NoteRow } from './types';

// 筆記列表(純呈現,View 層)。只吃 props —— 不認得 model/api,資料由 viewmodel 經 route 餵入。
export function NoteList({ notes }: { notes: NoteRow[] }) {
  return (
    <ul className="flex flex-col gap-1">
      {notes.map((note) => (
        <li key={note.id} className="rounded border border-gray-200 p-2">
          {note.title}
        </li>
      ))}
    </ul>
  );
}
