# loop：171-restructure-skills-agents-references

> refactor(plugin)：重整 skills/agents/references 分類＋resolver/lint/loader

| 欄位 | 值 |
|---|---|
| **類型** | issue ｜ **operation** `refactor`（既有行為不得變） |
| **issue** | [#171](https://github.com/adha9990/dev-workflows/issues/171)（parent #168；depends on #170 ✅、#183 ✅） |
| **當前階段** | 完工 |
| **推進模式** | auto（跳過 verify，使用者指示） |
| **base** | master @ 5816655 |
| **worktree** | `.claude/worktrees/171-restructure-skills-agents-references` |

## Journal

- [E1] dispatch → goal：現況實測 305 處硬編引用／71 檔；skills 11／agents 25／references 74；component-registry 現有覆蓋僅 reference 7／skill 3／agent 2，遠未全覆蓋。
- [E2] plan：§0–§9 ＋ 12 任務。
- [E3] 設計審查（opus fresh reviewer，含**真實搬檔模擬**）判「要修」，8 條必修。最重要 M2：純搬檔後 deep-sync（P1 檢查）與 orphan-ref **靜默變 no-op**（對照組抓到、搬後 0），另一支 lint 掃描面 83→31 檔**仍回報全綠**——「既有測試不由綠轉紅」對此完全無感。
- [E4] M8（平台 loader 是否支援巢狀 skill）零證據 → 查官方文件：巢狀支援，但需 manifest 陣列顯式宣告、呼叫名維持兩段式；另一平台能否認陣列無證據。實測本機 14 plugin／73 skill 全平鋪、零前例。
- [E5] **使用者拍板：skills 維持平鋪、分類進 registry；agents 與 references 照 issue 搬。** 兩平台 manifest 完全不動 ⇒ loader 風險歸零。issue 目標結構的 skills 三層明列為偏離、寫進 PR body。
- [E6] 折回完成：決策 2（邏輯鍵＋正規化雜湊）、決策 3（**變異驗證成為零回歸主要守門**）、決策 4（引用分五類）、決策 5（基準快照帶 provenance、防自比）、決策 6（另立 user_invocable 不覆用 visibility）。任務 12→13。
- [E7] T1/T1b/T5 完成：registry 63→166 元件（逐檔拆分＋owner_class/target_path/user_invocable），覆蓋率地板改逐檔枚舉（1048 斷言，否證實跑：拿掉一個登記→紅指名；退回 glob 分組→76 條紅）。變異驗證工具 13 個注入點全抓、6 條掃描面下限，自我否證固化成常駐測試。
- [E8] T6 完成：兩支 lint 由平鋪限定改支援巢狀。**反事實驗證**——用修前舊 lint 跑模擬搬檔樹：注入 13 只抓到 6、逃逸 7 個（deep-sync／orphan-ref／duplicate／footprint／platform-tool-name／C4／C5），掃描面 82→26、agent 與 deep 配對面歸零，而測試全綠。這證實了搬檔前必須先修 lint。
- [E9] T2/T3/T4 完成：resolver（找不到丟例外不回 null）、引用 372 處分五類（real 229 唯一進比對）、基準快照三道防自比閘。
- [E10] **使用者指示（build 期）**：①本機測試掃描暫停，留到所有 issue 完成後統一跑；②**移除 CI**（`.github/workflows` 已刪，commit 680293c）。已告知代價：CI 是唯一抓到 #183 那個 Windows-only 競態的機制，移除後跨平台差異無自動驗證。計畫的 T12 已同步移除 CI 接線。
- [E11] T7/T8 搬檔 99 檔（git mv）＋14 類路徑常數同步。lint-mutation 仍 13/13、掃描面只增不減。agent 正確回 BLOCKED（T8/T9 在「綠」的層次不可分割，是我的任務切分問題），裁決併入同輪。
- [E12] T9/T10 引用改寫 229 處。agent 指出我一個字面上不可能的要求（快照無法記載自己所在 commit 的 sha，雜湊自指），改為讀版控 HEAD 版本比對——嚴格加強非放寬，並實測就地重產會被擋。
- [E13] T11/T12：殘留檢查**當場抓到 3 處真殘留**（前輪漏改），已修。allowlist 實測只需 7 檔（非我沿用的 27），口徑差異如實記錄未硬湊。
- [E14] real-run 閘擋 gh pr ready → 依規放非空 no-ui.md（說明為何無畫面、改用變異驗證／引用圖比對／殘留檢查三種真實執行證據，含反事實對照），非繞過。
- [E15] PR #192 squash merged，issue #171 CLOSED。
- ★[outcome] 完工 ｜ token≈?(高)est ｜ sub-agent 7 ｜ 回環 0 圈（verify 依指示跳過）｜ findings 8→0（設計審查）｜ 交付：PR #192 merged
