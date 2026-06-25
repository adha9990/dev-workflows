import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type Note } from '@/model';

// 筆記頁的 viewmodel:持有列表(React Query)+ 新增表單的 title 狀態,
// 編排取列表 / 新增的非同步流程,對外回 { notes, status, actions };不碰任何 JSX。
//
// MVVM:viewmodel 層 —— 可 import model + lib,不可 import components/routes/JSX。

export function useNotes() {
  const queryClient = useQueryClient();
  // 表單狀態(呈現邏輯,不屬 model):新增筆記的標題輸入。
  const [title, setTitle] = useState('');

  const query = useQuery({ queryKey: ['notes'], queryFn: api.fetchNotes });
  const mutation = useMutation({
    mutationFn: api.createNote,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['notes'] }),
  });

  // 提交新增:空白標題不送;送出後清空輸入。View 只觸發,不知道流程細節。
  const submit = () => {
    const trimmed = title.trim();
    if (trimmed.length === 0) return;
    mutation.mutate({ title: trimmed, body: '' });
    setTitle('');
  };

  return {
    data: {
      notes: query.data ?? ([] as Note[]),
      title,
    },
    status: {
      loading: query.isLoading,
      error: query.isError,
      creating: mutation.isPending,
    },
    actions: {
      setTitle,
      submit,
      retry: () => void query.refetch(),
    },
  };
}
