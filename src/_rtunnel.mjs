// _rtunnel.mjs —— 把实时分析站推到公网（cloudflared Quick Tunnel）
// ★ 用途：给评委一个**真实可上传**的公网链接（静态演示站之外的第二条路）。
// ★ 注意：Quick Tunnel 是**临时**公网入口 —— 本进程被回收后链接即失效；长期部署请用 README 的平台方案。
// ★ 密钥：只注入到子进程环境变量，不写入任何文件。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const PORT = Number(process.env.RT_PORT ?? 8096);
const CF = path.join(root, 'tools', 'cloudflared.exe');
if (!fs.existsSync(CF)) { console.error('缺少 tools/cloudflared.exe'); process.exit(1); }

const env = { ...process.env,
  LLM_BASE_URL: process.env.LLM_BASE_URL || 'https://api.deepseek.com/v1',
  LLM_API_KEY: process.env.LLM_API_KEY || process.env.DEEPSEEK_API_KEY,
  LLM_MODEL: process.env.LLM_MODEL || 'deepseek-flash',
  REALTIME_QUOTA: process.env.REALTIME_QUOTA || '6',
};
if (!env.LLM_API_KEY) { console.error('缺少 LLM_API_KEY / DEEPSEEK_API_KEY'); process.exit(1); }

// ① 服务端（detached：脚本退出后仍存活）
const srv = spawn(process.execPath, [path.join(here, 'server.mjs'), '--port', String(PORT)], {
  cwd: root, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
});
let slog = '';
srv.stdout.on('data', d => { slog += d; });
srv.stderr.on('data', d => { slog += d; });
srv.unref();

for (let i = 0; i < 40; i++) { try { const r = await fetch('http://localhost:' + PORT + '/api/cases'); if (r.ok) break; } catch {} await new Promise(s => setTimeout(s, 300)); }
console.log('① 本地服务端就绪：http://localhost:' + PORT);

// ② 隧道
const logPath = path.join(root, 'tools', 'tunnel.log');
const cf = spawn(CF, ['tunnel', '--url', 'http://localhost:' + PORT, '--no-autoupdate'], {
  cwd: root, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
});
const out = fs.createWriteStream(logPath, { flags: 'w' });
cf.stdout.pipe(out); cf.stderr.pipe(out);
cf.unref();

let url = null;
for (let i = 0; i < 60; i++) {
  await new Promise(s => setTimeout(s, 1000));
  const t = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '';
  const m = t.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
  if (m) { url = m[0]; break; }
}
if (!url) { console.log('✗ 未能取得隧道地址，cloudflared 日志尾部：'); console.log(fs.readFileSync(logPath, 'utf8').slice(-1200)); process.exit(1); }
console.log('② 公网入口：' + url);

// ③ 验证公网可达（首页 / 实时页 / 预置案例）
for (const u of ['/', '/realtime/', '/cases/cs3223-writeup.pdf.html']) {
  try {
    const r = await fetch(url + u);
    const t = await r.text();
    console.log('   ' + r.status + '  ' + (t.length / 1024).toFixed(0) + 'KB  ' + u);
  } catch (e) { console.log('   ERR ' + u + ' ' + String(e.message).slice(0, 60)); }
}
const q = await (await fetch(url + '/api/quota')).json().catch(() => null);
console.log('③ 配额：' + JSON.stringify(q));
console.log('\n★ 实时站（可上传全新 PDF）：' + url + '/realtime/');
console.log('★ 静态演示站（预置案例）：' + url + '/');
console.log('（Quick Tunnel 为临时入口，随本机进程结束失效；长期部署见 README §三）');
