# real-loops —— 四條真實 loop.md 的逐字快照

## 這是什麼

`.loops/` 是 gitignored、且**不存在於 linked worktree**，因此無法在測試裡直接讀。
本目錄是主 repo `.loops/` 底下**全部四條** loop.md 在某一時點的**逐字快照（byte-for-byte）**，
入版控後供 `scripts/test-loop-memory.mjs` 的 T0 characterization 當輸入。

| 檔名 | 來源 | bytes | sha256 |
|---|---|---|---|
| `170-policy-component-integration-registries.md` | `.loops/170-policy-component-integration-registries/loop.md` | 4140 | `f5df34a0b2c36f704f773fae9056101e297f40c3af1d237eb8bbd250bb30c595` |
| `171-restructure-skills-agents-references.md` | `.loops/171-restructure-skills-agents-references/loop.md` | 4283 | `7cdd173eb5f4159aa56bb6a5343993311d2884cedfbcbb5c6271396867cc4163` |
| `172-loop-memory-event-ledger.md` | `.loops/172-loop-memory-event-ledger/loop.md` | 7155 | `03ff1820f574dccdcec7204c7f77f8c4d855a3df35af76bb565beeae20324036` |
| `183-dual-harness-compat-layer.md` | `.loops/183-dual-harness-compat-layer/loop.md` | 11670 | `7579ce898b8d6071938032949b14b99ae8bc0696e748d6f94c013dd8089d2bf4` |

擷取時點：#172 T0（本 repo 當時 HEAD `bdb67db`）。

## 為什麼是逐字、且檔頭沒有任何說明

**這四個檔一個字都不能改**——連加一行「本檔為快照」的註解都不行。

repo 內已有前例：`fixtures/loop-243-*/observed-journal.md` 檔頭自陳「已重排格式、非逐字複製」，
於是拿它驗出來的東西**對現實不成立**（#172 plan 決策 5 據此把該素材整份刪除）。
characterization 測試鎖的是「真實輸入 → 現況輸出」，輸入一旦被整理過，鎖到的就是一個不存在的世界。

說明因此只寫在本 README，不寫進 fixture 本體。

## 為什麼是四條、不是三條

`172` 自己也在 `.loops/` 底下，且是四條裡**唯一**「未完工／無 session／無 worktree／無 outcome」
的進行中形態。只取 170／171／183 會正好漏掉這個唯一的進行中形狀。

## 重新擷取

四條 loop.md 仍在演進（`183` 會繼續 append）。要更新快照時，在**主 repo 根目錄**跑：

```powershell
# PowerShell（主 repo 根目錄）
$dst = "plugins\loops-workflow\scripts\fixtures\loop-memory\real-loops"
foreach ($s in @(
  "170-policy-component-integration-registries",
  "171-restructure-skills-agents-references",
  "172-loop-memory-event-ledger",
  "183-dual-harness-compat-layer"
)) { Copy-Item ".loops\$s\loop.md" "$dst\$s.md" -Force }
```

```bash
# bash 等價寫法
dst=plugins/loops-workflow/scripts/fixtures/loop-memory/real-loops
for s in 170-policy-component-integration-registries \
         171-restructure-skills-agents-references \
         172-loop-memory-event-ledger \
         183-dual-harness-compat-layer; do
  cp ".loops/$s/loop.md" "$dst/$s.md"
done
```

⚠ 重新擷取後，`test-loop-memory.mjs --filter T0` 的期望值**必然要一起更新**——這正是
characterization 的用途：期望值變動必須是**刻意的一次提交**，不是靜默漂移。

上表的 bytes／sha256 也要一起更新，而且**一律用算的、不要手打**：

```powershell
Get-ChildItem $dst -Filter *.md | Where-Object Name -ne 'README.md' |
  ForEach-Object { "| ``$($_.Name)`` | ... | $($_.Length) | ``$((Get-FileHash $_ -Algorithm SHA256).Hash.ToLower())`` |" }
```

`test-loop-memory.mjs` 的 `T0-README-SELFCHECK` 會**回頭檢查這張表**：逐列比對宣告的 bytes／sha256
與磁碟實況，並斷言 sha256 恰為 64 個十六進位字元。表格與現實一偏離就紅燈——不靠人眼比對 64 個字元。
（本表曾有一列被手打成 65 個字元，就是這條 case 的由來。）

## 已知現況缺陷（T0 刻意鎖住的）

T0 有數條 case 標題帶「**現況已知有缺陷**」。那些 case 鎖的不是「對的答案」，是**現在實際發生的錯**：

- `eval-trajectory.readObservedStages` 對四條抽出的是 `["e1","e2",…]`（事件 ID），不是階段名。
- `baseline-trace.parseSessionId` 對四條**全 `null`**（它要 `**session**：` 冒號形式，真檔是表格豎線）。
- `progress.extractProgress` 的 `round`／`findings` 對四條恆為 `0`／`''`（`回環 N 圈`／`findings X→Y`
  只寫在 `★[outcome]` 那行，而該行不符 `/^-\s*\[E\d+\]/`、根本不進 `journalEntries()`）。

修這些缺陷時，這幾條 case 會轉紅——那是**刻意更新期望值**的訊號，不是意外破壞。
