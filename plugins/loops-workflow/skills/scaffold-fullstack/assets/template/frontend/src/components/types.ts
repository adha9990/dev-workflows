// View 層共用的「呈現用」型別。刻意與 model 結構解耦(View 不 import model):這些只描述
// 元件需要畫什麼,由 route 從 viewmodel 取資料後餵入。結構上與 model 對應型別相容。

// 筆記列表一列需要畫的資料(對應 model 的 Note,但 View 自有一份最小集合)。
export interface NoteRow {
  id: string;
  title: string;
}
