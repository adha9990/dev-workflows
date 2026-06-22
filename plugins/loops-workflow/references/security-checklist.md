<!-- adapted from addyosmani/agent-skills (MIT) -->

# 安全檢查表（security-checklist）

> security-reviewer 的延伸 checklist。改寫自 `addyosmani/agent-skills` 的 `security-checklist.md` 與 `security-and-hardening` skill（MIT）。先做威脅建模，再逐項對照。

## 一、Threat Model First（從這裡開始）

伸手抓控制項之前，先花五分鐘像攻擊者一樣想：

- [ ] **信任邊界畫出來**：request / 上傳 / webhook / 第三方 API / LLM 輸出 —— 哪些資料來自不可信來源。
- [ ] **資產點名**：憑證 / PII / 付款資料 / 管理動作 / 金流 —— 最該保護的是什麼。
- [ ] **每個邊界跑一遍 STRIDE**（見下）。
- [ ] **濫用案例**：每寫一個 use case，就在旁邊寫一個「我會怎麼濫用它」。

## 二、STRIDE 六類

| 類別 | 問什麼 |
|------|------|
| **S**poofing（偽冒） | 身份能被冒充嗎？authn 夠嗎？ |
| **T**ampering（竄改） | 資料 / 參數能被中途改嗎？完整性怎麼保證？ |
| **R**epudiation（否認） | 關鍵動作有沒有可稽核的紀錄？ |
| **I**nfo disclosure（洩漏） | 敏感資料會不會外洩 / 進 log / 進回應？ |
| **D**oS（阻斷） | 有沒有無上限的消耗（迴圈 / query / 上傳）？ |
| **E**levation（提權） | 能不能越權拿到更高權限 / 別人的資源（IDOR）？ |

## 三、Pre-Commit secret 掃描

- [ ] code 裡沒有密鑰：`git diff --cached | grep -i "password\|secret\|api_key\|token"`
- [ ] `.gitignore` 蓋掉 `.env` / `.env.local` / `*.pem` / `*.key`
- [ ] `.env.example` 用 placeholder，不是真值

## 四、Auth / Authz 重點

**Authentication**
- [ ] 密碼用 bcrypt（≥12 rounds）/ scrypt / argon2 雜湊。
- [ ] session cookie：`httpOnly` / `secure` / `sameSite: 'lax'`、有過期。
- [ ] 登入端點有 rate limit（≤10 次 / 15 分）。
- [ ] 重設密碼 token：時限（≤1 小時）、單次使用。

**Authorization**
- [ ] 每個受保護端點都檢查身份。
- [ ] 每次存取資源都檢查 ownership / role（防 IDOR）。
- [ ] admin 端點驗 admin role；API key 最小權限。
- [ ] JWT 驗簽章 / 過期 / issuer。

## 五、Input Validation

- [ ] 所有使用者輸入在邊界（API route / form handler）驗證，用 **allowlist** 不是 denylist。
- [ ] 長度 / 數值範圍 / email / URL / 日期格式都驗。
- [ ] 上傳：限類型、限大小、驗內容。
- [ ] SQL 一律參數化（不字串拼接）；HTML 輸出靠框架自動 escape。
- [ ] redirect 前驗 URL（防 open redirect）；server 端對外抓取 allowlist + 擋私有 IP（防 SSRF）。

## 六、Data Protection

- [ ] 敏感欄位（`passwordHash` / `resetToken`…）排除在 API 回應外。
- [ ] 敏感資料不進 log（密碼 / token / 完整卡號）。
- [ ] 對外通訊一律 HTTPS；備份加密。

## 七、Dependency / 供應鏈

- [ ] `npm audit`（含 `--audit-level=critical`）。
- [ ] lockfile 進版控；CI 用 `npm ci` 不是 `npm install`。
- [ ] 新依賴審維護狀況 / 下載量 / `postinstall` script；防 typosquat（`cross-env` vs `crossenv`）。

## 八、AI / LLM 安全（凡呼叫 LLM 的功能）

- [ ] 模型輸出視為**不可信**：絕不直接進 `eval` / SQL / shell / `innerHTML` / 檔案路徑。
- [ ] 假設會有 prompt injection：權限在 **code 裡**強制，不是寫在 system prompt。
- [ ] 密鑰 / 跨租戶資料 / 完整 system prompt 不進 context window。
- [ ] tool / agent 權限最小化；破壞性 / 不可逆動作要確認。
- [ ] 設 token / rate / 遞迴深度上限（界定消耗）。

## 九、OWASP Top 10 速查

| # | 弱點 | 防法 |
|---|------|------|
| 1 | Broken Access Control | 每端點驗身份 + ownership |
| 2 | Cryptographic Failures | HTTPS / 強雜湊 / 不藏密鑰於 code |
| 3 | Injection | 參數化查詢 + 輸入驗證 |
| 4 | Insecure Design | 威脅建模 / spec-driven |
| 5 | Security Misconfiguration | 安全 header / 最小權限 / audit deps |
| 6 | Vulnerable Components | `npm audit` / 更新 / 最小依賴 |
| 7 | Auth Failures | 強密碼 / rate limit / session 管理 |
| 8 | Data Integrity Failures | 驗更新 / 簽章 artifact |
| 9 | Logging Failures | log 安全事件、別 log 密鑰 |
| 10 | SSRF | 驗 / allowlist URL、限制對外請求 |

## 十、OWASP LLM Top 10 速查（有 LLM 功能才看）

| ID | 風險 | 防法 |
|---|------|------|
| LLM01 | Prompt Injection | 別把 system prompt 當邊界；權限在 code 強制 |
| LLM02 | Sensitive Info Disclosure | 密鑰 / PII 不進 prompt；過濾輸出 |
| LLM03 | Supply Chain | 模型 / 資料集 / plugin 比照依賴審核 |
| LLM04 | Data & Model Poisoning | 用可信來源、驗完整性；審 fine-tuning / RAG 資料 |
| LLM05 | Improper Output Handling | 輸出當不可信：驗證 / 參數化 / 編碼 |
| LLM06 | Excessive Agency | tool 權限最小化；破壞性動作要確認 |
| LLM07 | System Prompt Leakage | 假設會洩漏，裡面別放密鑰 |
| LLM08 | Vector & Embedding | RAG embedding 按租戶分區；索引前驗文件 |
| LLM09 | Misinformation | 答案附引用、關鍵主張驗證、保留 human in the loop |
| LLM10 | Unbounded Consumption | 限 token / 請求率 / 遞迴深度 |

> 完整版見 [OWASP GenAI Security Project](https://genai.owasp.org/llm-top-10/)。
