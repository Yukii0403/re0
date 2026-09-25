# AutoGrader 服务端（含实时分析站）
#
# ★ 为什么需要 Chromium：上传 PDF 时要渲染整页图片，教师视图才能"跳页看原件"。
#   （若宿主无法装 Chromium，功能仍可用，只是教师视图退回"抽取文本"定位 —— 见 README §六 边界说明。）
#
# 构建：docker build -t autograder .
# 运行：docker run -p 8080:8080 \
#         -e LLM_BASE_URL=https://api.deepseek.com/v1 \
#         -e LLM_API_KEY=<你的密钥> \
#         -e LLM_MODEL=deepseek-flash \
#         autograder
#      → 打开 http://localhost:8080/（预置案例）与 http://localhost:8080/realtime/（实时分析）

FROM node:20-bookworm-slim

# Chromium 用于 PDF→页面图渲染；字体保证中文/数学符号正常
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      chromium fonts-noto-cjk fonts-dejavu-core ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# 让子进程能按名字找到浏览器（部分实现读 CHROME_PATH / 也会走 PATH）
ENV CHROME_PATH=/usr/bin/chromium \
    CHROMIUM_PATH=/usr/bin/chromium \
    NODE_ENV=production

WORKDIR /app

# ★ 本项目**零第三方 npm 依赖** —— 直接拷源码即可，无需 npm install
COPY . .

# 运行期会写入的目录（上传件与产物）
RUN mkdir -p fixtures/uploads/out tools

EXPOSE 8080

# 只暴露服务端；密钥全部由运行时环境变量注入，绝不写入镜像
CMD ["node", "src/server.mjs", "--port", "8080", "--web", "fixtures/web"]
