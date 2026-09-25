# 准备提交的文件清单（共 92 个）

> 生成方式：`git add -A --dry-run`（尊重 `.gitignore`，权威口径）。
> 原则：**只保留运行所需的代码、配置、schema 与网页文件**；运行输出、原始报告、教师工作表、日志、密钥一律排除。

## 配置与文档（5）

- `.dockerignore`
- `.gitignore`
- `Dockerfile`
- `README.md`
- `render.yaml`

## 设计文档（7）

- `design/L1-document-index.md`
- `design/L2-evidence-focus.md`
- `design/L3-mechanical-verification.md`
- `design/L4-rubric-assessment.md`
- `design/evaluation-plan-veras.md`
- `design/veras-admission-criteria-sourcing.md`
- `design/veras-r6-r1-case-postmortem.md`

## rubric / profile 定义（5）

- `design/canonical-rubric.cs3223-test.json`
- `design/canonical-rubric.example.json`
- `design/canonical-rubric.veras-pendulum.json`
- `design/rubric-assessment-profile.cs3223-test.json`
- `design/rubric-assessment-profile.veras-pendulum.json`

## schema（8）

- `design/canonical-rubric.schema.json`
- `design/document-index.schema.json`
- `design/evidence-candidates.schema.json`
- `design/retrieval-plan.schema.json`
- `design/rubric-assessment-profile.schema.json`
- `design/rubric-assessment.schema.json`
- `design/summary.schema.json`
- `design/verification-checks.schema.json`

## 示例与标注（8）

- `design/document-index.example.json`
- `design/document-index.example.txt`
- `design/evidence-candidates.example.json`
- `design/retrieval-plan.example.json`
- `design/rubric.cs3223-test.ann.json`
- `design/rubric.cs3223-test.txt`
- `design/rubric.example.txt`
- `design/verification-checks.example.json`

## 网页（6）

- `fixtures/realtime/app.js`
- `fixtures/realtime/index.html`
- `fixtures/web/cases/2019-calculus-RR03-0503.txt.html`
- `fixtures/web/cases/cs3223-writeup.pdf.html`
- `fixtures/web/index.html`
- `fixtures/web/manifest.json`

## 代码（53）

- `src/_apiprobe.mjs`
- `src/_auditsheet.mjs`
- `src/_e2e.mjs`
- `src/_evaldiag.mjs`
- `src/_evalsum.mjs`
- `src/_evalveras.mjs`
- `src/_freezecheck.mjs`
- `src/_l2run.mjs`
- `src/_l4run.mjs`
- `src/_llmrun.mjs`
- `src/_mkchecks.mjs`
- `src/_mkexample.mjs`
- `src/_mkfixtures.mjs`
- `src/_mkholdout.mjs`
- `src/_mkindex.mjs`
- `src/_mklist.mjs`
- `src/_mkplan.mjs`
- `src/_mkprofile.mjs`
- `src/_mkrubric.mjs`
- `src/_mksite.mjs`
- `src/_mkveras.mjs`
- `src/_newcheck.mjs`
- `src/_pdfprobe.mjs`
- `src/_realtest.mjs`
- `src/_repoaudit.mjs`
- `src/_rprofile.mjs`
- `src/_rprofile2.mjs`
- `src/_rsec.mjs`
- `src/_rtest.mjs`
- `src/_rtunnel.mjs`
- `src/_selftest.mjs`
- `src/_smoke.mjs`
- `src/_stats.mjs`
- `src/_summaryrun.mjs`
- `src/_teacheredit.mjs`
- `src/_teacherui.mjs`
- `src/_toolrun.mjs`
- `src/_tvrun.mjs`
- `src/l1.mjs`
- `src/l2.mjs`
- `src/l4.mjs`
- `src/llm.mjs`
- `src/page.mjs`
- `src/quote-binding.mjs`
- `src/server.mjs`
- `src/summary.mjs`
- `src/teacherui.app.js`
- `src/teacherui.export.js`
- `src/teacherview.mjs`
- `src/toolcalling.mjs`
- `src/validator.mjs`
- `src/veras-map.mjs`
- `src/verify-tools.mjs`

---

## 已排除（要点）

- **密钥**：`.env*`、`*.key`、`secrets.json`、`.npmrc`
- **运行输出**：`fixtures/out/`、`fixtures/**/out*/`、`*.out.txt`、`*.index.json`、`src/*.txt`、`src/*.pid`
- **原始报告与测试夹具**：`fixtures/report*.pdf|html|docx|txt`、`fixtures/real/*.pdf`
- **教师工作表**：`design/teacher-scores*.json`、`design/*-work.json`
- **用户数据**：`fixtures/uploads/`（上传原件与分析产物）
- **本地样本与数据集**：`fixtures/veras/`
- **日志与本地工具**：`*.log`、`*.err`、`tools/`（cloudflared 二进制 ~55MB）

## 两个说明

- `fixtures/web/cases/*.html` 由 `src/_mksite.mjs` 生成，但**保留入库** —— 否则演示站点没有页面内容，无法直接部署。
- `src/` 下另有若干开发期探针（如 `_apiprobe.mjs`、`_pdfprobe.mjs`），体积很小；如需更精简可再移除。
