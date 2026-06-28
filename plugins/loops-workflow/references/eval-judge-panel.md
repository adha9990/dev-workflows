# eval-judge-panel — judge panel orchestration recipe

> 把 #32 eval-judge + #33 eval-poll 接成**可跑的 judge panel 活流程**。**派 N judge＝主迴圈/Workflow 的事（本 recipe）**；組合 N verdict→共識＝確定性膠水 `scripts/eval-panel.mjs`（不 spawn）。給「無 oracle 維度」（解釋/溝通品質）拿比單 judge 更穩、抗偏誤的品質訊號。

## 流程（主迴圈照做）
對一份要評的 artifact（PR body / explain 包 / commit 訊息…）：

1. **同回合派 N 個異質 judge**（建議 N=2–3、**不同模型家族**）：每個都派 `agents/eval-judge.md`，prompt 給 rubric 絕對路徑（`references/eval-judge-rubric.md`）+ artifact + 契約。**複用 verify 反偏誤**：
   - **不告知「作者已過 / 已驗證」**（防 sycophancy）；
   - 每個 judge **fresh context**（防 self-enhancement）；
   - **異質模型**（PoLL：異質小 judge 投票 > 單一大 judge、抗 position/verbosity/self-enhancement、便宜 ~7×）。
2. **捕每個 judge 的 verdict**，寫成 `verdicts.jsonl`，每行一個 judge：
   ```jsonc
   { "judgeId": "sonnet-1", "model": "claude-sonnet-4-6", "output": "<該 judge 的 raw verdict 文字>" }
   ```
3. **跑膠水算共識**（cwd＝repo 根，路徑與 `eval-harness.md` 一致）：
   ```bash
   node plugins/loops-workflow/scripts/eval-panel.mjs run \
     --rubric plugins/loops-workflow/references/eval-judge-rubric.md \
     --verdicts <verdicts.jsonl> --case-id <artifact-id> \
     [--gold plugins/loops-workflow/evals/gold/explanation-quality.json] [--judge-file .loops/.metrics/judge-results.jsonl]
   ```
   → 回 `{consensus（PoLL 投票：pass/passTie/score；**只計 valid verdict**）, validCount, panelSize, goldAgreement, records, rubricValid, skipped}`，並（有 `--judge-file`）把 N 筆 record append judge-results.jsonl（帶 caseId、judge-estimate 軌）。
   - **棄權語意**：解析失敗/越界的 verdict 計入 `panelSize`、仍落檔，但**不投票**（`validCount` 才是投票數）——一個 judge 吐壞 JSON ＝沒投票、非投反對。
   - **`--gold` 的 per-case agreement** 只在 `--case-id` 本身就是金標案例 id 時有值；對真實 artifact（caseId＝該 artifact id）通常 `goldAgreement:null`，**常態校準走下方累積 κ**。平手共識 → `agree:null`（不把擲銅板算成一致）。
   - exit code：產出 0（advisory 永不擋路，rubric 不合法只警示不擋）/ 缺旗標·未知命令 2 / rubric·verdicts·gold 讀檔失敗 3。

## 校準（跨 case κ，累積後做）
單次 panel 只給「這份 artifact 的共識」。**judge 與人工的 Cohen κ 校準是跨多 case 的**——累積夠多 case 的 judge-results.jsonl 後跑既有（cwd＝repo 根）：
```bash
node plugins/loops-workflow/scripts/eval-poll.mjs kappa \
  --records .loops/.metrics/judge-results.jsonl --gold plugins/loops-workflow/evals/gold/explanation-quality.json
```
（金標養到 50–100 筆 κ 才有統計意義，見 #50。）

## 不變量
- `eval-panel.mjs` **不 spawn judge**——派 N judge 是本 recipe 的步驟 1（主迴圈）。
- judge 分數是 **judge-estimate**（估算、非權威）；落獨立 judge-results.jsonl、**不污染 oracle 回歸曲線**（沿用 #32/#33 軌）。
- `pass` 由 rubric 門檻推導（覆蓋 judge 自報）；共識 `pass` 由 PoLL majority（平手→passTie，不亂猜）。
- **oracle-first, judge-last**：能用可執行 oracle 判的維度不走 panel。
