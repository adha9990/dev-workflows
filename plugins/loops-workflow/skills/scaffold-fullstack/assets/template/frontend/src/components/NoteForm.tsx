// 新增筆記表單(純呈現,View 層)。只吃 props、回呼事件 —— 不持有 server 狀態、
// 不認得 model/api(由 viewmodel 提供 value 與 actions)。
export function NoteForm({
  title,
  disabled,
  onTitleChange,
  onSubmit,
}: {
  title: string;
  /** 送出中時禁用,避免重複提交。 */
  disabled: boolean;
  onTitleChange: (value: string) => void;
  onSubmit: () => void;
}) {
  return (
    <form
      className="flex gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <input
        className="rounded border border-gray-300 px-2 py-1"
        value={title}
        placeholder="New note title"
        onChange={(event) => onTitleChange(event.target.value)}
      />
      <button
        className="rounded bg-blue-600 px-3 py-1 text-white disabled:opacity-50"
        type="submit"
        disabled={disabled}
      >
        Add
      </button>
    </form>
  );
}
