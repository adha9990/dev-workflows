# quality-gate 結構化輸出契約

`scripts/loops-quality-gate.mjs` 跑 test/lint/type 三道 gate，把各自的機器 reporter 解析成**結構化 failures**，預設只印精簡摘要、`--json` 印完整結構。下游（#3 build 整合、verify reviewer）依本契約讀取，**不再把原始測試輸出整包灌進 agent context**。

> 務實邊界：Claude Code 的 `Workflow` 沙箱不能 spawn 測試 → 本腳本由 orchestrator/agent 的 Bash 跑；目標是把輸出**從 ~100k 壓到 ~2k**，而非「完全消除 agent 看輸出」。

## GateResult（`--json` 輸出）

```jsonc
{
  "ok": true,                       // 無 error 級 failure
  "status": "passed",               // "passed" | "failed" | "partial"(部分 gate not-run 但其餘 ok)
  "counts": { "test": 0, "lint": 0, "type": 0, "total": 0 },
  "gates":  { "test": "ok", "lint": "ok", "type": "ok" }, // "ok" | "failed" | "not-run"
  "failures": [ /* Failure[]，見下 */ ],
  "truncated": false                // failures 是否因 cap 被截
}
```

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

約束：`failures` dedup（同 `file`+`line`+`code|ruleId`+`kind` 視為同一筆）；總量 cap（預設 160，可 `--max-failures` 調），超出 → 截斷且 `truncated=true`；各 gate 原始輸出 tail 截到上限（預設 80000 字，可 `--tail` 調）。

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
{ "test": "npm test", "lint": "eslint .", "type": "tsc --noEmit" }
```

⚠ `.loops/` 通常被 `.gitignore` 忽略 → 若要讓這份覆寫**版控共享**，在該 repo 的 `.gitignore` 加例外：

```gitignore
.loops/
!.loops/gate.config.json
```

## reporter 解析

- **test**：`vitest --reporter=json`（jest 相容）→ 走訪 `testResults[].assertionResults[]` 取 `status==="failed"`。
- **lint**：`eslint -f json` → 每個 `messages[]` 一筆，`severity` 2→error / 1→warning。
- **type**：`tsc --noEmit` → regex 解析 `file(line,col): error TSxxxx: message`，過濾 preamble / 摘要行。
