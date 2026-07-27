<!-- loops-artifact: concept-doc@1 -->
# 目錄結構：agents／references 分類、skills 為何維持平鋪

`agents/` 與 `references/` 依角色分了子目錄；`skills/` 沒有——這份文件說清楚三件事：現在的樹長怎樣、
怎麼在裡面加一個新元件、怎麼在 skill / agent 裡引用一份規範。

---

## 1. 現在的樹長怎樣

### agents/ 分三類（依派工角色）

```
agents/
  build/    impl-author、test-author（紅綠分離的兩個作者角色）
  eval/     eval-judge（無 oracle 維度的 rubric judge）
  verify/
    core/         每次驗證都跑的核心軸（architecture／code-quality／security／tests…）
    conditional/  依改動性質才加派的軸（frontend-ui／accessibility／migration…）
    validation/   驗證結果的驗證（finding-validator／referee）
```

### references/ 分三層（personas／stages／shared，shared 再依用途分四個子類）

```
references/
  personas/   reviewer／validator 的人設模板（含 reviewer-shared.md 單一樣板源與 gen-reviewers.mjs 生成的 17 份）
  stages/     各階段專屬的產出格式（schema）——goal-restate-schema、design-plan-schema…
  shared/     跨階段共用規範，依用途再分：
    delivery/  對外溝通產出（PR body、commit、comment 版型…）
    docs/      文件相關（docs-policy、onboarding、ADR…）
    quality/   寫碼品質標準（clean-code、security-checklist、test-rubric…）
    runtime/   執行期機制（journaling、fleet、eval-harness…）
```

`references/` 根層另外三份是機器可讀登記表（`component-registry.json`／`policy-registry.json`／
`integration-registry.json`），不算「文件」，見 [registries.md](registries.md)。

### skills/ 維持平鋪，分類記在 registry——不是遺漏

`skills/<name>/` 一律平鋪、不巢狀分類。這是使用者拍板的決定：skill 是使用者與 `/loops-workflow:dispatch`
之間的介面單位，巢狀分類對「哪個 skill 對應哪個階段」這件事沒有幫助（階段順序本來就記在
`FLOW.md` 與 `component-registry.json`，不需要目錄結構重複表達一次）。想知道某個 skill 屬於哪個分類
（階段 / 側用 / 工具型），查 `component-registry.json` 裡該 skill 元件的 `kind` / `stage` 欄位，
不要用目錄路徑猜。

---

## 2. 怎麼加一個新元件

不管加的是 skill、agent 還是 reference，步驟都一樣三步：

1. **建檔**——放進對應分類的目錄（agent 依角色選 `build/eval/verify/<core|conditional|validation>`；
   reference 依性質選 `personas/stages/shared/<delivery|docs|quality|runtime>`；skill 直接放
   `skills/<name>/`）。
2. **登記 registry**——在 `plugins/loops-workflow/references/component-registry.json` 加一筆，填
   `id`／`paths`／`target_path`／依賴與被依賴關係。這是唯一的真相源：目錄結構本身不會自動讓工具
   認得新元件，沒登記的檔案在 resolver／compiler 眼裡不存在。
3. **跑檢查**——至少這幾道（見下方〈驗證〉章節的完整清單與指令）：
   - `registry-compiler.mjs`：新條目的欄位形狀、跨表連線（`required_checks.integrations`）合法。
   - `skill-lint.mjs`：description footprint、agent 重複、reference 斷鏈孤兒、寫死計數漂移。
   - `reference-graph.mjs --compare`：新增的引用字面在基準快照裡站得住腳（不是憑空多出的漂移）。
   - 若新增的是 reviewer/validator agent：跑 `gen-reviewers.mjs --check` 確認沒有手改漂移出
     `reviewer-shared.md` 這份單一樣板源。

## 3. 怎麼引用一份規範

**規則：用元件 id 問 resolver，不要自己拼相對路徑。** 目錄重整之後，散文裡寫的
`references/xxx.md` 只是給人看的「這份規範大概在哪」，不是可靠的路徑——唯一的真相源是
registry 裡的 `target_path`。

- **給人看的散文**（SKILL.md／agent prompt 裡引用某份規範時）：用元件 id 稱呼它（例如
  「見 `clean-code`」），不要寫死巢狀路徑——路徑之後還可能再搬，id 不會變。
- **要塞進 subagent prompt 的絕對路徑**：orchestrator skill 執行期跑
  ```
  node <plugin-root>/scripts/component-resolver.mjs <component-id>
  ```
  拿到的絕對路徑寫進該 subagent 的 prompt。subagent 的 CWD 是使用者 repo、相對路徑解不到，
  **不得自己拼**（見 `AGENTS.md`〈參考檔路徑解析〉）。
- **skill 自己讀自己的 reference**：skill 內的裸引用（`references/<file>.md`）有兩種合法解法——
  skill 自己的 `references/` 子目錄裡有這份檔就近取用，沒有才落到 plugin 層的巢狀路徑；
  `skill-lint.mjs` 與 `reference-graph.mjs` 都認這條判準（`skill-local` 分類）。

## 4. 有哪些檢查在守這件事

| 檢查 | 防什麼 |
| --- | --- |
| `registry-compiler.mjs` | 三份 registry 的欄位形狀、跨表連線合法、`--affected` 波及面查詢正確。 |
| `skill-lint.mjs` | description footprint、agent 重複與 base⇄deep 同步、references 斷鏈孤兒、寫死計數漂移、死指令引用。 |
| `reference-graph.mjs --compare` | 逐條引用（五類：real／fixture／placeholder／glob／skill-local）比對搬遷前後的邏輯鍵與內容雜湊，防止搬檔漏改或內容漂移躲過 stale-ref。 |
| `check-legacy-paths.mjs` | 專防「還留著扁平舊路徑」的殘留字面（`references/<檔名>.md` 或 `agents/<檔名>.md` 直接落在根層，不在分類子目錄下）——五類分類接不到的角落（歷史文件、凍結語料）走明確 allowlist，其餘一律判紅。 |
| `check-baseline-whitelist.mjs` | 基線測試檔清單與現況存在性對帳，防止測試檔被靜默刪除而 glob 迴圈渾然不覺。 |
| `gen-reviewers.mjs --check` | 21 份 reviewer/validator agent 檔與 `reviewer-shared.md` 單一樣板源之間有沒有手改漂移。 |
| `compat-lint.mjs` | 雙 harness 相容層的表面禁令與投影漂移（見 [dual-harness.md](dual-harness.md)）。 |
| `codex-plugin-lint.mjs` | Codex 側 plugin 樹的結構合法性。 |

## 參考｜限制

- `check-legacy-paths.mjs` 的 allowlist 是明確列名（逐檔附理由），刻意保留舊扁平字面的檔案分三類：
  - **歷史設計文件**——`docs/specs/2026-07-02-pr-watch-design.md`：描述尚未落地功能的舊 spec，字面
    是撰寫當下（搬遷前）的用詞，凍結為歷史紀錄、不隨後續搬遷同步改寫。
  - **凍結評測語料**——`evals/baseline/corpus/*.json`、`evals/gold/artifacts/*.json`：評測輸入輸出
    的凍結快照，改字面等於竄改語料本身。
  - **負向 fixture**——`scripts/fixtures/**/*.json`：非 `test-*.mjs` 命名、放在 `fixtures/` 目錄下
    的合成測資，字面是測試斷言用的假值。
  （`test-*.mjs` 本身與 `skill-lint.mjs` 的合成字面走既有的 `isExcludedFromLintScan` 結構性排除，
  不重複列進 allowlist——單一定義，見 `check-legacy-paths.mjs` 檔頭。）
- skills 目前沒有機械檢查驗證「目錄平鋪」本身這條約定——它是使用者拍板的設計決定，不是可以被違反
  再靠工具抓回來的規則；真正被機械檢查守著的是 registry 裡的分類欄位是否與實際用途一致。
- `component-resolver.mjs` 解不到的 component id 會非零退出並指名該 id，但它不會告訴你「這個 id
  應該存在但你打錯字」與「這個元件真的還沒登記」的差別——兩種情況現階段都是同一種紅燈。

## 怎麼自己驗證

改動 agents／references／skills 任何一份檔案後，依序跑：

```
node plugins/loops-workflow/scripts/skill-lint.mjs
node plugins/loops-workflow/scripts/registry-compiler.mjs --root .
node plugins/loops-workflow/scripts/reference-graph.mjs --compare
node plugins/loops-workflow/scripts/check-legacy-paths.mjs
node plugins/loops-workflow/scripts/check-baseline-whitelist.mjs
node plugins/loops-workflow/scripts/gen-reviewers.mjs --check
```

新增 / 刪除任一支 `test-*.mjs` 測試檔時，另外同步 `check-baseline-whitelist.mjs` 的
`BASELINE_TEST_FILES` 清單（新增就加、刪除就拿掉並在 PR 說明理由）。
