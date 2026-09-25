# AutoGrader · 教师协作式多模态评分

> 深大计软 & 腾讯云 粤港澳大湾区 AI Coding 创新大赛（2026）「Agent 应用」赛道参赛作品
> **在线体验（公网）**：https://0795576dbd8c403cb6668f07a7ecbf4e.app.workbuddy.host

**一句话**：AI 不做裁判，做**可核对的观察者** —— 它把"学生哪里写错了、依据是什么、在哪一页"摊开给教师，
教师确认/修改评价并给分，最后生成评语草稿。**主视图不显示 AI 档位或分数**，教师的第一印象建立在可核查的事实上。

---

## 一、线上 Demo 怎么用（静态演示站）

打开上面的链接，选一个案例 → 进入教师视图：

1. **看整篇优先观察**：每份最多 3 条，**过了门槛才上屏**（合格不足就不凑满，可能是 0 条）
2. **看「关键缺项／论述不足 · 待教师核对」**：附 rubric 要求 + 学生实际写的段落 + 跳页入口
3. **点「查看原文」**：跳到**原件对应页**并高亮引文；缩放由你掌控（默认适合阅读区宽度，**切换评价不会被重置**）
4. **按条目确认／修改评价、给分**：准确／部分准确／不准确 + 整数分（越界标红）
5. **生成评语草稿 / 导出教师工作表**：草稿只把标注"准确"的条目当作已确认内容；未全部给分时显示「总分未形成」

> ⚠️ **本站是预置案例演示**：页面里的评价、判断与验证结果**全部是离线预先生成**的产物，**不是实时分析**。
> 静态站无法调用模型服务（密钥只能放服务端）。真实"上传报告 + 跑模型分析"请用下面的服务端方式。

---

## 二、本地启动

### 2.1 静态站（零依赖，双击即可）

```bash
# 直接打开首页；也可以起一个静态服务器
python -m http.server 8000 --directory fixtures/web
# 然后访问 http://localhost:8000
```

---

## 二之二、实时分析站（评委可上传全新 PDF）

**入口**：服务端启动后访问 **`/realtime/`**（即 `http://localhost:8080/realtime/`）。

与静态站的区别：**这是实时分析** —— 评委上传一份全新报告，服务端**真实调用模型**跑完整评测链，
产物即时生成，再进入同一个教师视图。

流程（页面上按 ①→④ 走）：

1. **选择报告**：拖拽/点选 `.pdf` / `.txt`（≤ 10 MB；PDF 会做页面渲染，从而支持"查看原文"跳页）——或选预置案例
2. **选择 rubric**：CS3223（points 型 8 叶子）或 VerAs 单摆（levels + points 混合）
3. **开始分析**：显示**分步进度**（评测链 → 教师视图）、实时用时、服务端日志尾
   —— 任务在服务端**异步执行**（job 轮询），避免长请求被浏览器/代理掐断
4. **教师视图**：分析完成后内嵌显示（也可在新标签打开），随后即可确认/修改评价、给分、生成评语草稿、导出

**约束与安全**：

- **配额**：默认全局 6 次实时分析（环境变量 `REALTIME_QUOTA` 可调），防止密钥被刷；用尽返回 429 并提示
- **上传上限**：`REALTIME_MAX_UPLOAD_MB`（默认 10 MB）
- **密钥**：只在服务端 `process.env`，不写入文件、不返回前端、不出现在日志里
- **降级**：未配置模型环境变量时，`/api/analyze` 明确返回 503（而不是假装有结果）


### 2.2 服务端（支持上传 + 真实分析）

```bash
# 1) 配置环境变量（见 §四；密钥只从环境变量读取，不写入任何文件）
# 2) 启动
node src/server.mjs --port 8080 --web fixtures/web
# 3) 访问 http://localhost:8080
```

服务端提供：

| 路由 | 说明 |
|---|---|
| `GET /` | 演示站首页（预置案例） |
| `GET /cases/<name>.html` | 教师视图 |
| `GET /api/cases` | 列出预置案例与可用 rubric |
| `POST /api/analyze` | **上传报告 + 选 rubric → 跑完整评测链 → 返回教师视图**（需密钥） |
| `POST /api/export` | 保存教师工作表 JSON（导出后可直接接入评语生成） |

### 2.2.1 实时站的安全设计（已加固）

| 项 | 做法 |
|---|---|
| **上传件与产物** | **不做静态公开**（`/uploads/...` 一律 404）。只能经 `/api/artifact/<jobId>/<file>?token=<jobToken>` 取；token 在提交任务时**只返回给提交者**，别的浏览器拿不到 |
| **按任务隔离** | **每个任务一个独立目录** `fixtures/uploads/jobs/<jobId>/` —— 原件与全部中间产物都只落在本任务目录里，任务之间互不可见、同名文件不会互相覆盖 |
| **导出白名单** | 产物接口**只提供该任务生成的那个教师视图文件**；同一目录里的原件、中间产物、其它文件一律 404（白名单之外取不到） |
| **产物期限** | 任务 TTL 到期后，**连该任务目录一起清理** |
| **教师导出** | **浏览器本地下载**（前端拼 JSON 并下载）。服务端**不再有任何写 `design/` 的导出接口**，导出物不经过服务器 |
| **校验顺序** | 大小 → 配额 → 并发 → 模型配置，**全部通过之后才落盘、才启动任务**（被拒的请求不会留下文件） |
| **配额** | 写在**实例本地磁盘**（`fixtures/uploads/.quota.json`），按天重置。<br>★ **有效期如实标注为「当前实例运行期间有效」**：同一实例内重启会保留（实测），但平台**休眠/重建实例**后文件可能丢失、额度会被重置 —— **本项目不宣称跨休眠/跨实例持久**（要做到需外部存储，未接入）。 |
| **并发** | `REALTIME_CONCURRENCY`（默认 1）；超出返回 429 |
| **产物 TTL** | `REALTIME_JOB_TTL_MS`（默认 6 小时）；过期返回 410 |
| **密钥** | 只在服务端 `process.env`；`.dockerignore` 与 `.gitignore` 都已排除密钥、上传件、本地样本 |
| **超限请求** | 返回明确的 **413**（不会把连接直接掐断，客户端能读到原因） |

### 2.2.2 环境变量（新增项，完整清单见 §四）

| 变量 | 默认 | 说明 |
|---|---|---|
| `REALTIME_CONCURRENCY` | `1` | 同时运行的分析任务数上限 |
| `REALTIME_JOB_TTL_MS` | `21600000` | 产物可从接口取回的时长（6h） |
| `REALTIME_MAX_UPLOAD_MB` | `10` | 上传大小上限 |

### 2.2.3 部署到 Render（方案 B）

1. 把仓库推到 GitHub / Gitee
2. Render → **New → Web Service**（★ 不是 Static Site）→ 选仓库 → **Runtime: Docker**（会读根目录 `Dockerfile`）
3. 在 **Environment** 里填：`LLM_BASE_URL`、`LLM_API_KEY`、`LLM_MODEL`
   （可选：`REALTIME_QUOTA`、`REALTIME_CONCURRENCY`、`REALTIME_MAX_UPLOAD_MB`）★ 密钥只填在这里
4. Health Check Path 填 `/api/cases`
5. 部署完成后访问 `https://<你的服务名>.onrender.com/realtime/`

### 2.2.4 实测资源画像（判断托管规格够不够用）

在一台 18 核开发机上，跑「上传 → 全链分析 → 生成教师视图」的实测：

| 输入 | 单次全链耗时 | 进程内存峰值（node + 渲染浏览器） |
|---|---|---|
| **PDF**（含整页渲染，供"查看原文"跳页） | **346 秒** | **约 2.0 GB** |
| **纯文本 .txt**（跳过页面渲染） | 见下方补测 | 见下方补测 |

**结论与建议**：

- 峰值内存主要来自 **PDF 页面渲染（chromium）**，而不是模型调用（模型调用是网络 IO，占用小）。
- 因此 **512 MB 量级的免费档很可能在 PDF 渲染阶段 OOM**。
- 两条可行路线（**由你决定，我不会自行升级实例**）：
  1. **先用 .txt 报告演示**（跳过渲染，占用显著降低）——功能完整，只是"查看原文"会退回文本定位；
  2. 若要稳定跑 PDF，目标规格按 **≥2 GB 内存** 准备（并给 CPU 留余量）。
- 若在部署平台上失败，把**平台日志里的具体错误**贴给我，我据此给出所需规格建议。

> 也支持仓库里的 `render.yaml` 走 Blueprint 一键创建（字段含义相同）。
> ★ 免费档资源较小，PDF 页面渲染（chromium）是最吃资源的一步：
> 若实时分析失败，请把 Render 日志里的**具体错误**发我；也可以先上传 **.txt** 报告（跳过渲染）验证链路。
> 需要提规格时我会给出建议，**不会自行升级实例**。

### 2.3 重新生成预置产物（离线批处理）

```bash
# 单份：一键跑 L1→L2→L3→L4→评语（fail-closed，端到端账目）
node src/_e2e.mjs --doc fixtures/real/cs3223-writeup.pdf \
  --rubric design/canonical-rubric.cs3223-test.json \
  --profile design/rubric-assessment-profile.cs3223-test.json

# 生成教师视图（自包含单文件 HTML）
node src/_teacherui.mjs --case cs3223-writeup.pdf --out fixtures/real/out

# 组装可部署的演示站点
node src/_mksite.mjs
```

---

## 三、部署说明

**当前线上版本**：静态演示站，部署于 WorkBuddy CloudStudio 沙箱静态托管
（`fixtures/web/` 整个目录即可作为站点根；`index.html` 为入口）。

**任何静态托管均可**（Vercel / Netlify / GitHub Pages / 对象存储 + CDN）：

```bash
# 站点内容 = fixtures/web/（index.html + cases/*.html + manifest.json）
# 直接把该目录作为站点根上传即可；案例页是自包含单文件（内联 PDF / 页图 / 数据），无外部依赖
```

> ★ 案例页体积较大（cs3223 约 2.1 MB）是因为把 **原 PDF 与整页渲染图内联**了 ——
> 这样既不受静态托管的路径限制，也能离线双击打开。若托管平台有单文件体积限制，可改走服务端托管。

### 3.2 实时分析站的部署（**需要能跑 Node 的托管**）

★ 静态托管放不了实时站：实时分析要在服务端跑 **PDF 解析 + 页面渲染 + 四层评测 + 模型调用**，静态托管无法执行任何服务端代码。

三条可行路径（配置已随仓库提供）：

| 路径 | 步骤 |
|---|---|
| **A. Docker（推荐）** | 仓库已含 `Dockerfile`：构建后 `docker run -p 8080:8080 -e LLM_BASE_URL=… -e LLM_API_KEY=… -e LLM_MODEL=… <镜像>`；镜像内已装 chromium 供 PDF 页面渲染 |
| **B. Render 一键** | 仓库已含 `render.yaml`：Render → New → Blueprint → 选仓库 → 在 Environment 填三个变量 |
| **C. 腾讯云轻量应用服务器 / CVM**（国内访问快，贴合赛事背景） | 装 Node 20 与 chromium；把仓库拷上去；`node src/server.mjs --port 8080`；用 systemd / pm2 常驻；安全组放行 8080 |

> 三条路都需要在**平台的环境变量**里配置模型密钥（不要写进仓库）。
> 实时分析单次耗时数分钟（PDF 解析 + 4 层评测 + 模型调用），注意平台的请求/任务超时设置。

### 3.3 为什么没有用"本机隧道"直接开公网（实测记录）

尝试过 `cloudflared` quick tunnel（在本机开隧道即可获得公网入口），**在当前网络环境下不可用** ——
cloudflared 自带的连通性预检输出：

```
DNS Resolution    PASS
UDP Connectivity  FAIL   QUIC connection failed            （边缘端口 7844/UDP 被阻断）
TCP Connectivity  FAIL   HTTP/2 ... blocked or unreachable  （7844/TCP 同样被阻断）
Cloudflare API    PASS   （仅 443 通）
SUMMARY: Environment has critical failures
```

即：隧道依赖的**边缘端口被网络策略拦掉**，换 `--protocol http2` 也绕不过。
完整日志留档：`tools/tunnel.log`。→ 所以实时站的公网入口要走 §3.2 的平台方案。

### 3.2 实时分析站的部署（**需要能跑 Node 的托管**）

★ 静态托管放不了实时站：实时分析要在服务端跑 **PDF 解析 + 页面渲染 + 四层评测 + 模型调用**，静态托管无法执行任何服务端代码。

三条可行路径（配置已随仓库提供）：

| 路径 | 步骤 |
|---|---|
| **A. Docker（推荐）** | 仓库已含 `Dockerfile`：构建后 `docker run -p 8080:8080 -e LLM_BASE_URL=… -e LLM_API_KEY=… -e LLM_MODEL=… <镜像>`；镜像内已装 chromium 供 PDF 页面渲染 |
| **B. Render 一键** | 仓库已含 `render.yaml`：Render → New → Blueprint → 选仓库 → 在 Environment 填三个变量 |
| **C. 腾讯云轻量应用服务器 / CVM**（国内访问快，贴合赛事背景） | 装 Node 20 与 chromium；把仓库拷上去；`node src/server.mjs --port 8080`；用 systemd / pm2 常驻；安全组放行 8080 |

> 三条路都需要在**平台的环境变量**里配置模型密钥（不要写进仓库）。
> 实时分析单次耗时数分钟（PDF 解析 + 4 层评测 + 模型调用），注意平台的请求/任务超时设置。

### 3.3 为什么没有用"本机隧道"直接开公网（实测记录）

尝试过 `cloudflared` quick tunnel（在本机开隧道即可获得公网入口），**在当前网络环境下不可用** ——
cloudflared 自带的连通性预检输出：

```
DNS Resolution    PASS
UDP Connectivity  FAIL   QUIC connection failed            （边缘端口 7844/UDP 被阻断）
TCP Connectivity  FAIL   HTTP/2 ... blocked or unreachable  （7844/TCP 同样被阻断）
Cloudflare API    PASS   （仅 443 通）
SUMMARY: Environment has critical failures
```

即：隧道依赖的**边缘端口被网络策略拦掉**，换 `--protocol http2` 也绕不过。
完整日志留档：`tools/tunnel.log`。→ 所以实时站的公网入口要走 §3.2 的平台方案。

**服务端部署**：任意支持 Node 18+ 的平台（容器 / 云主机 / Serverless）。
需要 §四 的环境变量；**不要把密钥写进前端页面或仓库**。

---

## 四、环境变量清单（**不含密钥值**）

模型调用只发生在服务端；变量缺失时，静态站与教师视图仍可正常使用（走预置产物）。

| 变量 | 是否必需 | 说明 |
|---|---|---|
| `LLM_BASE_URL` | 服务端分析必需 | 模型服务基址（OpenAI 兼容 `/chat/completions`），例如 `https://api.deepseek.com/v1` |
| `LLM_API_KEY` | 服务端分析必需 | 模型服务密钥。**只从环境变量读取，绝不写入网页代码或仓库** |
| `LLM_MODEL` | 服务端分析必需 | 模型名，例如 `deepseek-flash` |
| `VERAS_MIN_TEXT_CHARS` | 可选 | 正文过短的样本判为"不可评"的阈值（默认 200） |
| `VERAS_STAGE_TIMEOUT_MS` | 可选 | 单层子进程硬超时（默认 900000，看门狗防挂起） |

> 仓库中的 `.gitignore` 已排除 `.env*`、`*.key`、`secrets.json`。
> 请在部署平台的"环境变量/密钥管理"里配置，不要提交到代码库。

---

## 五、线上走查结果（2026-09-25）

| 检查项 | 结果 |
|---|---|
| 首页可打开 | ✅ HTTP 200（4 KB） |
| 两个案例页可打开 | ✅ HTTP 200（cs3223 2144 KB / VerAs 纯文本 63 KB） |
| **线上内容与本地一致性** | ✅ **逐字节相同**（sha256 前缀：index `a9a917771d2012c0`、cs3223 `3339fbe8e285da8c`、VerAs `7545a8f047d7a655`） |
| 首页渲染 | ✅ 案例卡片、预置声明、使用说明、页脚均正常（截图 `fixtures/web/_online_home.png`） |
| 教师视图：整篇观察 / 页码 chip | ✅ 每条观察带「第 N 页」，可点跳页 |
| 教师视图：PDF 跳页与放大 | ✅ 查看器渲染原件整页（已验第 4 页含 Figure 4 表格）；默认"适合阅读区宽度"，缩放不因切换评价重置（截图 `...teacher-ui.viewer.png`） |
| 教师视图：折叠区展开 | ✅ 展开显示真实折叠观察（不再只显示文件名） |
| 教师视图：给分与草稿 | ✅ 整数校验、越界标红；未全部给分显示「总分未形成」 |
| **导出接校验链** | ✅ 用 `verifySummaryInputs` 实测：**教师给分层 0 错误**（导出物含 `doc`/`rubric`/`assessment_ref`/每条 `max`/整数 `score`） |
| 密钥暴露 | ✅ 静态站 0 处密钥字样；代码中无硬编码密钥（已审计） |

**关于模型服务的走查边界**：静态站**不调用模型**，所以"模型服务可用性"只能通过服务端方式验证。
本轮服务端链路（`_e2e.mjs`）在**本地**已用真实模型跑通（24 份 VerAs 报告 + CS3223 报告）；线上静态站展示的是这些跑好的结果。

---

## 六、仍未实现的功能边界（如实说明）

1. **线上上传 + 实时分析未开放在静态站** —— 需要服务端与密钥；服务端代码已提供（`src/server.mjs`），本地可跑。
2. **分数指标类评测结论较弱** —— 95.7% 的样本算不出总分（保守映射下 R5/R6 弃权），逐维 ρ 只在部分维度有意义。
3. **送审率偏高**（84% 条目级）—— "省时间"这一卖点**没有计时实验支持，不能宣称**。
4. **0 分覆盖 40%** —— gold 判 0 的维度里约六成未被识别为"未涉及"。
5. **「关键缺项」通道每份最多 1 条** —— 折叠区里仍有同类（刻意的保守上限，待放宽）。
6. **缺项/论述不足尚无结构化契约** —— 当前是展示层复用现有观察，不是模型显式产出的结构化致缺项。
7. **severity / kind 仍是模型自报** —— 已降级为辅助信号（不再单独决定上屏），但没有可机械核实的替代量。
8. **单教师视角** —— 多人协作、评分者间对比、班级批量流程未实现。
9. **仅支持 PDF / 纯文本** —— 其他格式（docx、图片手写稿）未接入。

---

## 六之二、服务端走查（本地实测，2026-09-25）

启动 `node src/server.mjs --port 8099` 后逐端点实测：

| 端点 | 结果 |
|---|---|
| `GET /api/cases` | ✅ 200，返回 2 个预置案例 + 2 个 rubric |
| `GET /` | ✅ 200（演示站首页） |
| `GET /cases/cs3223-writeup.pdf.html` | ✅ 200，2144 KB，**含内联 PDF** |
| `GET /cases/2019-calculus-RR03-0503.txt.html` | ✅ 200，63 KB |
| `GET /api/job/<不存在>` | ✅ 404 |
| `POST /api/analyze`（未配置密钥） | ✅ **503** + 明确提示（引导走预置案例）—— 降级行为正确 |
| 路径穿越 `GET /cases/../../design/...` | ✅ 404 |
| `POST /api/export` | ✅ 200；**`_teacheredit --check` 校验 ALL PASS**（含"teacher_confirmed 时必须全部填完"） |

> ★ 实时分析（`/api/analyze`）需要模型环境变量；未配置时**明确返回 503**，不静默失败。

## 六之三、仓库与提交

- **源码仓库**：推送到 GitHub / Gitee（`.gitignore` 已排除密钥与运行产物）。推送需在本地执行（需要你的账号凭据）：

```bash
cd autograder
git init
git add -A
git commit -m "AutoGrader: 教师协作式多模态评分（赛事提交版）"
git remote add origin <你的仓库地址>
git push -u origin main
# ★ 推送前自查：git ls-files | grep -iE '\.env|secret|\.key' 应为空
```

- **LearnBuddy 历史对话记录**：本次开发会话即在 LearnBuddy 内，可在平台侧导出/引用
- **提交入口**：LearnBuddy【赛事】专区，截止 **9 月 26 日 23:59**（截止前可更新，评委看最后一次提交）



---

## 七、目录结构（核心）

```
autograder/
├─ src/
│  ├─ l1/l2/l3/l4 相关：_realtest / _mkindex / _mkplan / _llmrun / l4.mjs …
│  ├─ teacherview.mjs      教师视图（三条通道：优先观察 / 关键缺项 / 可能缺少）+ 门槛与排序
│  ├─ teacherui.app.js     教师界面前端逻辑（独立文件，生成时内联）
│  ├─ teacherui.export.js  教师工作表导出（纯函数，浏览器与 node 共用）
│  ├─ summary.mjs          评语层 + 输入闸（verifySummaryInputs）
│  ├─ _e2e.mjs             一键端到端 + 账目核对
│  ├─ _teacherui.mjs       生成教师界面（自包含 HTML）
│  ├─ _mksite.mjs          组装可部署演示站点
│  └─ server.mjs           服务端（静态 + 上传分析 + 导出）
├─ design/                 契约与 schema（rubric / profile / 各层 schema）
├─ fixtures/
│  ├─ real/                CS3223 真实 PDF 样本与产物
│  ├─ veras/               VerAs 数据集样本与评测产物、核查报告
│  └─ web/                 ★ 可部署的演示站点（index.html + cases/）
└─ .gitignore              （含密钥与大产物的排除规则）
```

---

## 八、设计原则（供评委参考）

- **AI 不评分**：全链 `layer_produces_score: false`；分数权归教师
- **可核对优先**：每条观察都要能回原文（有定位或机械验证挂钩），否则明确标"请勿当作确定结论"
- **不预设结论**："可能缺少的关键内容"只表示"在**已解析的文本**里没找到"，**不等于原文中没有**；
  关键词搜索排除不了换一种说法，提取不完整时只报「无法确认」
- **隐藏 AI 评级**：主视图不显示 AI 档位/判断/分数（机械自证），教师自行给分
- **失败即停、账目对平**：端到端核对样本集合与可评分叶子，缺/多都进 diffs

## 九、许可与数据来源

- 代码：参赛作品，供本次赛事评审使用
- 样本：CS3223 课程公开实验报告（GitHub 公开仓库）、VerAs 自动化评分研究公开数据集
- 本仓库**不包含任何模型服务密钥**
