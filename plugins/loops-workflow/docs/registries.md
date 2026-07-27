<!-- loops-artifact: concept-doc@1 -->
# Registry 三件套：規則、元件、外部工具

`references/` 底下有三份機器可讀的登記表，各自回答一個問題：

| 檔案 | 回答的問題 |
| --- | --- |
| `policy-registry.json` | **這個 repo 有哪些規則？** 每條規則管什麼範圍、可不可以被覆寫、由誰核可、寫在哪份文件裡、由哪些測試守著。 |
| `component-registry.json` | **這個 repo 由哪些零件組成？** 每個零件的檔案在哪、誰依賴它、它被誰消費、動到它之後有哪些檢查非跑不可。 |
| `integration-registry.json` | **這個 repo 用到哪些外部工具能力？** 每種能力的偵測／健檢／安裝／回滾指令是什麼、支援到什麼程度、有沒有互斥的替代方案。 |

三份都由 `scripts/registry-compiler.mjs` 檢查，全綠才算自洽。

---

## 1. 三份表怎麼互相連

只有一條跨表連線，方向固定：

```
component.required_checks.integrations[] ──→ integration.id
```

也就是說：**元件宣告「動到我之後要跑的檢查」時，可以指名一種外部工具能力**。例如 `merge-guard` 這個元件的必跑檢查裡列了 `forge-cli`，意思是「改了合併守門邏輯，得確認遠端 forge 指令那條路還通」。compiler 會驗這些 id 真的存在於 integration registry（指到不存在的 id ⇒ 紅）。

`required_checks` 一共四個桶，前三個是 repo 內的檔案路徑，第四個是 integration id：

```json
"required_checks": {
  "hooks": ["plugins/loops-workflow/hooks/test-merge-guard.mjs"],
  "evals": [],
  "docs":  ["plugins/loops-workflow/docs/dual-harness.md"],
  "integrations": ["forge-cli"]
}
```

policy 與 component 之間沒有直接外鍵，兩者透過**檔案路徑**間接相關：policy 的 `projection`／`tests`／`docs` 填的是 repo 相對路徑，那些路徑同時會被某個 component 的 `paths` 涵蓋。

---

## 2. 各表的欄位在說什麼

### policy

| 欄位 | 意義 |
| --- | --- |
| `id` | 全表唯一的 kebab-case 識別碼。 |
| `title` | 一句話說明這條規則要求什麼。 |
| `scope.kind` | `path-based`（管特定檔案）或 `activity-based`（管特定行為，沒有自然的檔案面）。 |
| `scope.paths` / `scope.activities` / `scope.stages` | 依 `kind` 填對應維度；**跨 kind 的兩條規則一律不視為重疊**。 |
| `enforcement` | `forbid` / `require` / `warn` / `info`，由嚴到寬。 |
| `overridable`、`approval` | 可不可以破例、破例要誰點頭。 |
| `precedence` | 數字；兩條規則真的打架時用來排誰壓誰。 |
| `fail_closed_on_missing_state` | 判定所需狀態拿不到時，是擋下來還是放行。 |
| `requires` / `forbids` / `conflicts_with` | 規則的實質內容與已知的對立面。 |
| `projection` | 這條規則被寫進哪些人讀文件。 |
| `projection_marker` | 在那些文件裡用來定位這條規則的字串（未填則用 `id`）。 |
| `tests` | 守著這條規則的測試檔。 |
| `docs` | 延伸說明放在哪。 |

`scope.kind` 分兩種是刻意的：多數規則（例如「數字只報實測值」）沒有自然的檔案面，若逼它填 `**` 這種全域 glob，它會跟每一條規則假交集，衝突判定會退化成人人忽略的噪音。所以裸全域 glob 被明確擋掉。

### component

| 欄位 | 意義 |
| --- | --- |
| `id` | 全表唯一的 kebab-case 識別碼。 |
| `kind` | `hook` / `skill` / `agent` / `reference` / `script` / `doc` / `eval`。 |
| `paths` | 這個元件涵蓋的檔案或 glob。 |
| `stage_role` | 若屬於某個迴圈階段，填該階段角色；否則 `null`。 |
| `visibility` | `public`（外部可依賴）或 `internal`。 |
| `dependencies` / `consumers` | 上下游元件 id；兩邊必須互相對得上。 |
| `required_checks` | 動到這個元件之後非跑不可的檢查（見上一節）。 |

`dependencies` 與 `consumers` 是同一條邊的兩個方向，compiler 強制雙向一致：A 宣告依賴 B，B 就必須把 A 列進 `consumers`。少一邊的話，波及面查詢會沿著缺的那個方向走不下去，答案默默變窄。

### integration

| 欄位 | 意義 |
| --- | --- |
| `id` | 全表唯一的 kebab-case 識別碼。 |
| `capability` | 這是**什麼能力**（不是「哪個牌子的工具」）。 |
| `support_status` | `supported` / `degraded` / `not_supported` / `not_measured`。 |
| `exclusive_group` | 同組的替代方案彼此互斥；不參與互斥填 `null`。 |
| `lifecycle` | `detect` / `install_latest` / `update_latest` / `health` / `uninstall` / `rollback` 六個階段，各填一條指令字串或 `null`。 |
| `triggers` / `outputs` | 什麼情況會用到它、它產出什麼。 |
| `docs` | 延伸說明放在哪。 |

`lifecycle` 只是**宣告**，compiler 只驗字串形狀、絕不執行其中任何一條指令。六個鍵必須齊全——沒有這個能力請顯式填 `null`，不要省略鍵，否則「還沒想過」跟「確定沒有」長得一模一樣。

---

## 3. 怎麼加一條規則

1. 確認這條規則在人讀文件裡**已經有正文**（通常是 `AGENTS.md` 的 Operating Rules）。registry 記的是既有規則的機器可讀投影，不是規則的發源地。
2. 在 `policy-registry.json` 的 `policies[]` 加一筆，`id` 用 kebab-case。
3. 決定 `scope.kind`：能指出具體檔案面就用 `path-based` 並填 `scope.paths`；否則用 `activity-based` 並填 `scope.activities`。**不要填 `**`**。
4. 填 `enforcement`。若填 `forbid`，`fail_closed_on_missing_state` 必須顯式為 `true`。
5. 若 `overridable` 為 `true`，`approval.required` 必須為 `true` 且 `approval.by` 非空。
6. `projection` 填規則正文所在的文件路徑，`projection_marker` 填那份文件裡逐字出現、且只屬於這條規則的字串。
7. `tests` 填真的會因為違反這條規則而變紅的測試檔——這欄不得為空。宣告了規則卻沒有任何測試承載，等於沒宣告。
8. 跑 `node plugins/loops-workflow/scripts/registry-compiler.mjs --root .`。

若新規則與既有規則在同一片 scope 上互相牴觸，compiler 會把它列進 `decisions[]` 並讓整體不綠（見第 5 節）。

## 怎麼加一個元件

1. 在 `component-registry.json` 的 `components[]` 加一筆，填 `id`、`kind`、`paths`、`visibility`。
2. 填 `dependencies`：這個元件 import／讀取／依賴哪些既有元件。
3. **回頭把自己加進每一個上游元件的 `consumers`**——這是最容易漏的一步，compiler 會擋。
4. 填 `required_checks`：改了這個元件之後，哪些測試、哪些 eval、哪些文件、哪種外部工具能力得跟著驗。四個桶全空的元件會讓波及面查詢對它回出空答案，等於白登記。
5. 跑 compiler。

## 怎麼加一個外部工具

1. 先問「這是**什麼能力**」而不是「這是哪個工具」。`id` 與 `capability` 都描述能力，例如「以指令列建立隔離工作區」。
2. 在 `integration-registry.json` 的 `integrations[]` 加一筆。
3. `lifecycle` 六個鍵一次填齊，沒有的填 `null`。
4. 若它跟既有某個能力是二選一的替代方案，兩者填同一個 `exclusive_group`；同組**至多一個** `support_status` 可以是 `supported`，其餘填 `not_measured` 或 `degraded`。
5. `capability`／`triggers`／`outputs` 這幾個自由文字欄不得寫死平台專屬工具名或廠商 model id——那會讓這份表綁死在單一平台上。
6. 若某個元件動到之後應該連帶驗這個能力，把它的 `id` 加進該元件的 `required_checks.integrations`。
7. 跑 compiler。

---

## 4. 波及面查詢

問「我改了這些檔案，有什麼非跑不可」：

```bash
# 單一路徑，人讀輸出
node plugins/loops-workflow/scripts/registry-compiler.mjs \
  --affected plugins/loops-workflow/hooks/merge-guard.mjs

# 多條路徑（逗號分隔）＋ 機器可讀輸出
node plugins/loops-workflow/scripts/registry-compiler.mjs --json \
  --affected plugins/loops-workflow/hooks/merge-guard.mjs,AGENTS.md

# 接 git：把這次改動的檔案整批餵進去
node plugins/loops-workflow/scripts/registry-compiler.mjs \
  --affected "$(git diff --name-only origin/master... | paste -sd,)"
```

輸出長這樣：

```json
{
  "components": ["hook-wiring", "hooks-codex-generator", "merge-guard"],
  "hooks": ["plugins/loops-workflow/hooks/test-merge-guard.mjs", "..."],
  "evals": [],
  "docs": ["AGENTS.md", "..."],
  "integrations": ["forge-cli"],
  "unmatched": []
}
```

幾件要知道的事：

- `components` 是**傳遞閉包**，不只直接命中的元件：沿著 `consumers` 一路往下游收。改一個大家都依賴的葉節點，答案會很大——那正是它該有的樣子。
- `hooks`／`evals`／`docs`／`integrations` 是閉包內所有元件的 `required_checks` 聯集，也就是「這次該跑的清單」。
- `unmatched` 是**沒有對到任何元件的路徑**。它不是錯誤，是提醒：這些檔案還沒被登記，波及面答案對它們沒有意義。
- **查詢模式的 exit code 一律 0**，包含有 `unmatched` 的時候。這是查詢不是 lint，要能安全地接進別的指令。想讓「改到沒登記的路徑」擋 CI，得顯式加 `--strict`。
- registry 讀不到時會往 stderr 講一聲。少了這句，「registry 壞了」會長得跟「這些路徑沒登記」一模一樣。

---

## 5. compiler 的檢查在防什麼

執行 `node plugins/loops-workflow/scripts/registry-compiler.mjs --root .`（加 `--json` 給機器讀）。

結果有**兩條並行的紅線**：`findings`（違規）與 `decisions`（真衝突、要人裁決）。兩者任一非空就 exit 1。只看 `findings` 的話，真衝突會在「✓ 無 finding」底下消失。

### 三表共通

| 檢查 | 防什麼 |
| --- | --- |
| 信封形狀 | `schema_version` 缺失、清單欄位不是陣列。**空陣列一律紅**——逐筆檢查對空清單全部恆真，「一條都沒登記」會被印成「無 finding」。 |
| 解析失敗 | JSON 壞掉時指名檔案與行號，而不是丟一個沒有出處的例外。 |
| id 衛生 | 重複 id；以及「只差大小寫或前後空白」的近重複——逐字比對會讓 `Foo-Bar` 與 `foo-bar` 各自成立、繞過唯一性。 |
| dangling 路徑 | 路徑欄位指向不存在的檔案，或指向一個存在但不是檔案的目標（例如目錄）。 |

### policy

| 檢查 | 防什麼 |
| --- | --- |
| scope 一致性 | `kind` 與實填維度對不上；以及用裸全域 glob 當 scope（會讓衝突判定退化成噪音）。 |
| 覆寫核可 | 宣告可覆寫卻沒說要誰核可——那等於「誰都可以破例」。 |
| fail-closed 必填 | `forbid` 或需核可的規則沒有顯式宣告「狀態拿不到時怎麼辦」。沒有這條，該欄位就只是個沒人檢查的 schema 鍵。 |
| 投影標記漂移 | 只驗檔案存在不夠——**檔案還在、規則段落被人拿掉**才是真正的漂移。所以改成在目標文件裡逐字比對 `projection_marker`。 |
| 衝突三態 | 見下。 |

**衝突三態**：兩條 scope 有交集、要求又互斥的規則，compiler 分三種處理——

1. **相容**：scope 沒交集，或有交集但要求不互斥（可直接疊加）⇒ 不報。若「凡同 scope 就報」，第三態很快就會被人學會忽略。
2. **自動取嚴**：一邊的 `enforcement` 比另一邊嚴，或作者已用 `precedence` 排好順序 ⇒ 機器自己決定，不打擾人。
3. **要人裁決**：雙方一樣嚴、`precedence` 也無從排序 ⇒ 進 `decisions[]` 擋線。機器不得替人選一邊。

另外，所有非互斥的 scope 重疊關係會列進 `notes`（不是 finding）——重疊本身不違規，但「哪些規則在同一片 scope 上」是人審需要看見的。

### component

| 檢查 | 防什麼 |
| --- | --- |
| 跨欄 dangling | `dependencies`／`consumers` 指向不存在的元件 id。 |
| 雙向一致 | 只宣告了單向的依賴邊——缺的那一半會讓波及面查詢默默走不通。 |
| 必跑檢查路徑存在 | `required_checks` 裡列了已經被刪掉或改名的測試檔。 |
| 依賴環 | 元件圖出現環（含自我引用）；訊息會印出環上的節點。 |

### integration

| 檢查 | 防什麼 |
| --- | --- |
| 互斥組 | 同一個 `exclusive_group` 內有兩個以上 `supported`——那代表「二選一」的宣告其實沒選。 |
| lifecycle 形狀 | 六個階段鍵不齊、值不是指令字串或 `null`、出現未定義階段。只驗形狀，不執行。 |
| 跨表引用 | 元件的 `required_checks.integrations` 指向不存在的 integration id。這條**無條件跑**：integration 表整份缺席時以空表代入，引用不存在的 id 仍然紅。 |
| 平台中立 | 自由文字欄寫死了平台專屬工具名或廠商 model id。 |

### 覆蓋率地板

compiler 只保證 registry **自洽**——而 registry 填得越空越容易自洽。`scripts/test-registry-coverage.mjs` 補的是另一面：

- 每一支非測試 hook 都必須被某個元件的 `paths` 或 `required_checks.hooks` 涵蓋（**不留豁免名單**：葉節點正是大家的共同依賴，漏登記它們，波及面查詢會對最該擴散的改動回出最窄的答案）。
- `AGENTS.md` 的每一條 Operating Rule 都對得到唯一一筆 policy，且該筆的 `projection` 與 `tests` 皆非空。
- repo 內測試檔被 registry 反查得到的比例不得低於地板。
- 每個元件被動到時都真的有事要做（擋「對上元件卻回空清單」）。
- 變異斷言：把某條 `consumers` 邊拿掉，波及面答案必須變小。沒變小就代表那條邊根本沒被閉包用到。
- 端到端煙霧：真的把 CLI 跑起來，驗已登記路徑查得到下游必跑測試、未登記路徑落進 `unmatched`、查詢模式 exit code 為 0。

---

## 6. 限制

- **compiler 不執行任何 `lifecycle` 指令**，所以 `support_status` 是人寫的宣告，不是實測結果。標成 `supported` 而實際壞掉的工具，這裡看不出來。
- **policy 的 `enforcement` 沒有執行語意**。registry 記錄「這條規則有多嚴」，但真正擋下違規的是各自的 hook 與測試；改了 `enforcement` 不會改變任何守門行為。
- **policy 與 component 之間沒有外鍵**，只靠檔案路徑間接相關。改一條規則不會在波及面查詢裡直接帶出「守著它的測試」，除非那些測試同時被某個元件的 `required_checks` 列到。
- **波及面查詢的邊來自人工宣告，不是靜態分析**。沒人填的依賴邊就不存在；閉包只忠實反映 registry 寫了什麼，不反映程式碼真正 import 了什麼。
- **`unmatched` 只擋「路徑沒對上元件」**，擋不住「對上了元件、但那個元件沒宣告任何必跑檢查」。後者由覆蓋率地板的元件檢查負責。
- **投影標記比對是字串包含**，不是語意比對。規則被改寫成同義但不同字面的句子時，標記會失配（紅得過頭）；標記字串太短太泛時，則可能在不相干的段落裡命中（漏報）。
- **測試檔覆蓋率是比例地板不是全覆蓋**，留了一格緩衝給「新測試檔已進 repo、registry 還沒補上」的短暫落差。
- **多平台差異不在這三份表裡**，那是能力清單（見 `dual-harness.md`）的職責範圍。
