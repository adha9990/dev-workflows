import { useState } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createNote, fetchNotes } from '@/api/notes';

export const Route = createFileRoute('/')({
  component: HomePage,
});

function HomePage() {
  const queryClient = useQueryClient();
  const [title, setTitle] = useState('');

  const { data, isLoading } = useQuery({ queryKey: ['notes'], queryFn: fetchNotes });
  const mutation = useMutation({
    mutationFn: createNote,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['notes'] }),
  });

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-xl font-semibold">Notes</h1>

      <form
        className="flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (!title.trim()) return;
          mutation.mutate({ title, body: '' });
          setTitle('');
        }}
      >
        <input
          className="rounded border border-gray-300 px-2 py-1"
          value={title}
          placeholder="New note title"
          onChange={(event) => setTitle(event.target.value)}
        />
        <button className="rounded bg-blue-600 px-3 py-1 text-white" type="submit">
          Add
        </button>
      </form>

      {isLoading ? (
        <p>Loading…</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {data?.map((note) => (
            <li key={note.id} className="rounded border border-gray-200 p-2">
              {note.title}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
