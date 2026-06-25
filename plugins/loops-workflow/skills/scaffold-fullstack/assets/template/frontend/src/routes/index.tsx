import { createFileRoute } from '@tanstack/react-router';
import { useNotes } from '@/viewmodels/useNotes';
import { NoteForm, NoteList } from '@/components';

export const Route = createFileRoute('/')({
  component: HomePage,
});

// View(薄):吃 useNotes viewmodel 渲染,把事件接回 actions。不直接碰 model/api
//(由 ESLint zone 強制)—— 資料與行為一律經 viewmodel。
function HomePage() {
  const { data, status, actions } = useNotes();

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-xl font-semibold">Notes</h1>

      <NoteForm
        title={data.title}
        disabled={status.creating}
        onTitleChange={actions.setTitle}
        onSubmit={actions.submit}
      />

      {status.loading ? (
        <p>Loading…</p>
      ) : status.error ? (
        <div className="flex items-center gap-2">
          <p className="text-red-600">Failed to load notes.</p>
          <button
            className="rounded border border-gray-300 px-2 py-1"
            type="button"
            onClick={actions.retry}
          >
            Retry
          </button>
        </div>
      ) : (
        <NoteList notes={data.notes} />
      )}
    </div>
  );
}
