import http from 'node:http';
import https from 'node:https';
import { spawn } from 'node:child_process';

const PORT = process.env.PORT || 8080;

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ status: 'ok', bot: 'running' }));
});

const PING_INTERVAL_MS = 14 * 60 * 1000;
const pingInterval = setInterval(() => {
  const url = process.env.RENDER_EXTERNAL_URL;
  if (!url) return;
  try {
    const client = url.startsWith('https:') ? https : http;
    client.get(url, (res) => {
      res.resume();
    }).on('error', (err) => {
      console.warn(`[bot-host] Ping error: ${err.message}`);
    });
  } catch (err) {
    console.warn(`[bot-host] Ping error: ${err.message}`);
  }
}, PING_INTERVAL_MS);

server.listen(PORT, () => {
  console.log(`[bot-host] Server listening on port ${PORT}`);

  const bot = spawn('node', ['scripts/discord-bot.mjs'], {
    stdio: 'inherit',
    env: process.env,
  });

  bot.on('exit', (code) => {
    console.log(`[bot-host] Bot process exited with code ${code}`);
    clearInterval(pingInterval);
    server.close(() => {
      process.exit(code ?? 0);
    });
  });

  bot.on('error', (err) => {
    console.error('[bot-host] Bot process error:', err);
    clearInterval(pingInterval);
    server.close(() => {
      process.exit(1);
    });
  });
});
