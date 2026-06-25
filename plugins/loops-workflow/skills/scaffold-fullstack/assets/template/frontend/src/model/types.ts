// HTTP 契約的 client 鏡像 DTO 型別(對應後端的 schema)。前端只認契約,不 import
// 後端程式碼。集中放這支,讓 api/ 端點與 viewmodels 共用同一份型別。
//
// MVVM:純型別(無 I/O、無 React),屬 model 層。

// 一筆筆記(對應後端 GET/POST /api/v1/notes 的回傳)。
export interface Note {
  id: string;
  title: string;
  body: string;
  createdAt: string;
  updatedAt: string;
}

// 新增筆記的輸入(對應 POST /api/v1/notes 的 body)。
export interface CreateNoteInput {
  title: string;
  body: string;
}
