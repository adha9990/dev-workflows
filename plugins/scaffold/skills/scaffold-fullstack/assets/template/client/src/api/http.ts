// 輕薄的 fetch wrapper。client 永遠不匯入 server 程式碼 — 它只知道
// HTTP 契約。請求送往 /api/*(在 dev 環境 proxy 到 Fastify,在
// single-process 模式則為 same-origin)。
export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...init?.headers,
    },
  });
  if (!response.ok) {
    throw new Error(`Request failed: ${response.status} ${response.statusText}`);
  }
  return (await response.json()) as T;
}
