# quality-gate 結構化輸出契約

`scripts/loops-quality-gate.mjs` 跑 test/lint/type 三道 gate，把各自的機器 reporter 解析成**結構化 failures**，預設只印精簡摘要、`--json` 印完整結構。下游（#3 build 整合、verify reviewer）依本契約讀取，**不再把原始測試輸出整包灌進 agent context**。

> 務實邊界：Claude Code 的 `Workflow` 沙箱不能 spawn 測試 → 本腳本由 orchestrator/agent 的 Bash 跑；目標是把輸出**從 ~100k 壓到 ~2k**，而非「完全消除 agent 看輸出」。

## GateResult（`--json` 輸出）

```jsonc
{
  "ok": true,                       // 無 error 級 failure 且無 gate 為 failed/errored
  "status": "passed",               // "passed" | "failed" | "partial"(部分 gate not-run 但其餘 ok)
  "counts": { "test": 0, "lint": 0, "type": 0, "total": 0 }, // 含 warning
  "gates":  { "test": "passed", "lint": "passed", "type": "passed" }, // "passed" | "failed" | "not-run" | "errored"
  "failures": [ /* Failure[]，見下 */ ],
  "truncated": false,               // failures 是否因 cap 被截
  "passedTests": []                 // 通過 test assertion 的 titlePath 清單（與 failure 同 titlePath 組法）
}
```

> **`passedTests`**：只有 test gate 跑時才填（無 test gate / not-run → `[]`），元素為通過 assertion 的 titlePath（`ancestorTitles > … > title`，以 ` > ` 連接，與 failure titlePath 同組法但不接細節）。提供「真的觀察到通過」的**正向證據**，下游 oracle 用它避免「不在 failures 即當通過」的假綠（required test 缺席/打錯名 → 既不在 `failures` 也不在 `passedTests` → 判 unverified，而非誤報綠）。加性欄位，不影響既有 `ok`/`status`/`failures` 語意。

> **判「是否通過」一律用 `ok`，勿用 `failures.length` / `counts.total`**：warning（severity=1）也會計入 `failures`/`counts`，但不影響 `ok`/`status`（只看 error 級）。
> **但 `ok=true` 不代表「該跑的 gate 都跑了」**：某 gate 被 graceful skip（`gates.*="not-run"`、`status="partial"`）時 `ok` 仍可為 `true`。#3 整合應額外確認**預期跑的 gate 真的是 `passed`**（而非被漏偵測成 `not-run`）—— 別只看 `ok`/exit code。
> **`errored`**：gate 工具實際跑了、但**非 0 退出卻解不出任何 failure**（如 tsc 設定錯、測試框架收集期崩潰）→ 標 `errored` 且 `ok=false`，**不會誤報綠**。

## Failure

```jsonc
{
  "kind": "test",                  // "test" | "lint" | "type"
  "severity": "error",             // "error" | "warning"
  "file": "src/foo.ts",
  "line": 12,                       // 可選
  "column": 5,                      // 可選
  "code": "TS2345",                // type 用；可選
  "ruleId": "no-unused-vars",      // lint 用；可選
  "message": "..."
}
```

約束：`failures` dedup（同 `file`+`line`+`code|ruleId`+`kind` 視為同一筆）；總量 cap（預設 160，可 `--max-failures` 調），超出 → 截斷且 `truncated=true`；各 gate 原始輸出 tail 截到上限（預設 80000 字，可 `--tail` 調）。**已知限制（#97）**：`counts` 尚無 `skipped` 欄——被 `.skip`/`.todo` 的測試不進摘要、綠燈仍 `✓`；「skipped 必列」紀律（`context-diet.md` §A）目前僅覆蓋 quality-gate 以外的原始輸出路徑，本 schema 的補欄留待後續票。

## CLI

```
node scripts/loops-quality-gate.mjs [--cwd <dir>] [--gates test,lint,type] [--json]
                                     [--continue-on-failure] [--max-failures <n>] [--tail <n>]
```

- 預設輸出純文字精簡：全綠一行（含 `✓`）；紅燈 counts + 至多上限筆 `file:line [code|ruleId] message`。
- `--json` → 印上面 GateResult。
- exit code：`ok ? 0 : 1`。

## 設定與版控（per-repo 覆寫）

各 repo 可在 `<repo>/.loops/gate.config.json` 覆寫實際指令；缺檔或缺鍵則自動偵測（`package.json` 的 `scripts.test`/`scripts.lint`、`tsconfig.json`）：

```json
{ "test": "vitest run", "lint": "eslint . -f json", "type": "tsc --noEmit" }
```

> ⚠ **覆寫指令須輸出對應 parser 期望的格式**，否則該 gate 會解不出 failures → 靜默假綠：
> - `test`：**目前僅支援 vitest**（會被自動附加 `--reporter=json --outputFile=<暫存>`，這是 vitest 專屬 invocation）。輸出格式雖承襲 jest，但 jest 的 invocation 不同 → 用 jest 需自行讓 config 指令把 vitest 相容的 JSON 寫到該 `--outputFile`，否則該 gate 會 `errored`（不會假綠，但跑不通）。
> - `lint`：須輸出 **ESLint JSON**（指令要含 `-f json`，例 `eslint . -f json`）。
> - `type`：`tsc --noEmit`（文字診斷，regex 解析）。

⚠ `.loops/` 通常被 `.gitignore` 忽略 → 若要讓這份覆寫**版控共享**，在該 repo 的 `.gitignore` 加例外。**注意必須排除「目錄內容」`.loops/*` 而非目錄 `.loops/`** —— git 無法 re-include 被排除目錄底下的檔：

```gitignore
.loops/*
!.loops/gate.config.json
```

## reporter 解析

- **test**：`vitest --reporter=json`（JSON 結構承襲 jest，但 invocation 為 vitest 專屬）→ 走訪 `testResults[].assertionResults[]`，`status==="failed"` 進 `failures`、`status==="passed"` 的 titlePath 進 `passedTests`。
- **lint**：`eslint -f json` → 每個 `messages[]` 一筆，`severity` 2→error / 1→warning。
- **type**：`tsc --noEmit` → regex 解析 `file(line,col): error TSxxxx: message`，過濾 preamble / 摘要行。
