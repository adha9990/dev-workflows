# Promptfoo 轉接文件（薄轉接，不安裝）

> D5（#169 plan）：本文件只給「C1 fixture → Promptfoo test case」的映射說明＋範例，**不安裝 Promptfoo、不改 C1 schema**。安裝與納管留給後續票（見計畫 §7「不在本次範圍」）。目的只有一個：證明本票的 fixture／trajectory 格式對 Promptfoo **可消費／可轉換**（R5），不是被鎖死在自家 runner 裡。

## 為什麼可以薄轉接

C1 fixture 本來就把「怎麼判過不過」（`oracle`）跟「用什麼輸入重播」（`replay_cmd`）都寫在同一筆 JSON 裡，跟 Promptfoo 的 test case 概念（`vars` + `assert`）一一對應：

| C1 fixture 欄位 | Promptfoo test case 對應 |
|---|---|
| `id` | test case 的 `description` 或 `vars.id` |
| `replay_cmd` | Promptfoo 沒有直接等價欄；放進 `assert[].value` 呼叫的 shell-out / javascript 裡執行 |
| `oracle.type` + `oracle.config` | `assert: [{ type: 'javascript', value: <呼叫既有 oracle 的函式> }]` |
| `expected_outcome`（省略＝`pass`） | 反轉到 assert 的期望值：`expected-fail` 的 fixture 期望 assert 回 `false`（誠實記現況紅，不是「跳過」） |

**assert type 一律用 `javascript`**——Promptfoo 的 javascript assert 收一個回傳 `{pass, score, reason}`（或純 boolean）的函式，剛好可以直接呼叫本票既有的 `evaluateFixture` / `scoreOracle`，不用重寫一份判定邏輯。

## 完整映射範例（route-decision 型）

C1 fixture（`evals/baseline/corpus/*.json` 其一）：

```json
{
  "id": "route-ok-sample",
  "category": "resume",
  "harness": ["claude-code"],
  "provenance": { "source_type": "live-capture", "ref": "...", "captured_at": "2026-07-25", "method": "..." },
  "oracle": { "type": "route-decision", "config": { "expected_route": "resume", "recorded_actual": "resume" } },
  "nondeterminism": "none — deterministic string compare",
  "replay_cmd": "node plugins/loops-workflow/scripts/baseline-corpus.mjs --dir plugins/loops-workflow/evals/baseline/corpus --fixture route-ok-sample --json"
}
```

轉成 Promptfoo `promptfooconfig.yaml` 的一筆 test case（示意，本 repo 不安裝、不執行）：

```yaml
tests:
  - description: 'route-ok-sample（#169 baseline corpus，route-decision 型）'
    vars:
      fixtureId: route-ok-sample
      fixtureDir: plugins/loops-workflow/evals/baseline/corpus
    assert:
      - type: javascript
        value: |
          const path = require('path');
          const { loadCorpusFixtures, evaluateFixture } = require(
            path.resolve('plugins/loops-workflow/scripts/baseline-corpus.mjs')
          );
          const entries = loadCorpusFixtures(vars.fixtureDir);
          const entry = entries.find((e) => e.fixture.id === vars.fixtureId);
          if (!entry) return { pass: false, reason: `fixture ${vars.fixtureId} not found` };
          const result = evaluateFixture(entry.fixture, vars.fixtureDir);
          // expected_outcome 省略 → 缺省 'pass'：assert 期望 result.pass === true。
          const expectPass = (entry.fixture.expected_outcome ?? 'pass') !== 'expected-fail';
          return { pass: result.pass === expectPass, reason: result.reason };
```

`expected-fail` 型 fixture（例如某條 route 現況真的不符）只差一行：`expectPass` 算出 `false`，assert 期望的是「oracle 判定確實是紅」——這正是 M4「預期紅」的語意，Promptfoo 這邊不用另開分支。

> 注意：`require()` 一支 `.mjs` ESM 檔在 CommonJS 環境不會直接動——上例是**示意映射**，真要接時（#176/#177 納管階段）該用 `import()` 動態載入或把 assert 腳本本身寫成 `.mjs`。本文件只證明「形狀可轉換」，不是可直接貼上執行的成品。

## quality-gate 型與 trajectory-rules 型

同一套模式：`assert` 裡一樣呼叫 `evaluateFixture(fixture, fixtureDir)`，差別只在 fixture 的 `oracle.type`／`oracle.config` 本身（quality-gate 需要 `workspace` 底下的實體樹已存在；trajectory-rules 需要 `observed_journal` 或 `observed_journal_file` 可解析）——轉接層完全不用知道底層是哪一種判定，這也是三軌分派收斂在同一個 `evaluateFixture` 入口的好處。

## 邊界

- 本文件不安裝 Promptfoo、不驗證上例在真 Promptfoo CLI 下可跑（那是 #176/#177 的納管範圍）。
- `oracle.config` 的 shape 是本票 C1 鎖定的契約；Promptfoo 端只是消費者，不得反向要求改 C1。
- quality-gate 型的 assert 會真的 spawn 子行程跑測試（`spawnGate`）——若真要在 Promptfoo CLI 裡跑，沿用 `eval-harness.md`「⚠️ 信任邊界」同一條：只在信任來源的 corpus 上跑。
