// Domain 層:純邏輯、零 I/O。這是最內層 — 它不從
// ports/adapters/services/repositories/http 匯入任何東西。商業不變條件
// 存放於此,因此無論使用哪個 adapter 或傳輸方式都成立。

export interface Note {
  id: string;
  title: string;
  body: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * 建構一個有效的 Note,並強制套用不變條件。呼叫端提供 `id` 與
 * `now`,使 domain 保持零 I/O(這裡沒有時鐘,也沒有 uuid 產生)。
 */
export function createNote(input: {
  id: string;
  title: string;
  body: string;
  now: string;
}): Note {
  const title = input.title.trim();
  if (title.length === 0) {
    throw new Error('Note title must not be empty');
  }
  return {
    id: input.id,
    title,
    body: input.body,
    createdAt: input.now,
    updatedAt: input.now,
  };
}
