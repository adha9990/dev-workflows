# 發 PR 規範

> iterate 完工收尾交 PR 時用。標題與 body 敘述繁中（identifier 英文）。

## 開法

- **開 Draft PR**（先草稿，確認再轉 Ready）。
- **標題**：`<type>: <繁中主旨> (#<issue>)`，例 `feat: 補上訂單關鍵字搜尋 (#122)`。

## body 第一樓 = 實作成果書

把這次的「完工定義 + 實作計畫 + 真實成果」整合成 PR body 第一樓：

- 做了什麼、為什麼這樣設計（從 `.loops/` 的 goal / plan / build 提煉）。
- 成果展示（實際跑出來的證據：測試輸出、畫面、driver 結果）。
- **不含** 內部設計更新流水帳 / commit 列表 / 後續迭代記錄 —— body 是「單一最新真相」。

## edit-first 紀律

- PR **還沒有其他 reviewer**（只有作者本人，含自己跑的自檢）→ 一律 **edit 第一樓**，不開新 comment。
- PR **出現其他 reviewer 的 comment 後** → 每輪修正發**新 comment** 回覆（第一樓仍同步成最新成果）。

## 收尾

- 與 master / 主幹 merge 同步、解衝突後再請求 review。
- 送出前對外內容（PR body / 回覆）先寫 tmp 草稿給使用者校稿（見 `references/comment-policy.md`），確認才 post。
