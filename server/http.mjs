#!/usr/bin/env node
// HTTP-сервер приёма заявок. Запуск: node server/http.mjs (настройки — переменные окружения, см. server/README.md).
// За nginx: location /api/lead → proxy_pass http://127.0.0.1:8787 (deploy/nginx.conf).
import http from 'node:http';
import { Readable, Transform } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { createLeadHandler, LIMITS } from './lead.mjs';

export function createServer(env = process.env, opts = {}) {
  const handle = createLeadHandler(env, opts);
  const leadPath = env.LEAD_PATH || '/api/lead';
  const cors = env.ALLOW_ORIGIN ? { 'access-control-allow-origin': env.ALLOW_ORIGIN, vary: 'Origin' } : {};

  return http.createServer(async (req, res) => {
    const send = (status, body, extra = {}) => {
      if (res.headersSent) return;
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...cors, ...extra });
      res.end(body === null ? undefined : JSON.stringify(body));
    };
    const { pathname } = new URL(req.url, 'http://local');
    if (pathname !== leadPath) return send(404, { ok: false, error: 'not_found' });
    if (req.method === 'OPTIONS' && env.ALLOW_ORIGIN) {
      return send(204, null, { 'access-control-allow-methods': 'POST', 'access-control-allow-headers': 'content-type', 'access-control-max-age': '86400' });
    }
    if (req.method !== 'POST') return send(405, { ok: false, error: 'method' }, { allow: 'POST' });

    const tooLarge = () => { send(413, { ok: false, error: 'too_large' }, { connection: 'close' }); req.destroy(); };
    if (Number(req.headers['content-length'] || 0) > LIMITS.maxBody) return tooLarge();

    // Тело считается по ходу чтения: без content-length лимит всё равно соблюдается
    let seen = 0;
    const counter = new Transform({
      transform(chunk, _enc, cb) {
        seen += chunk.length;
        cb(seen > LIMITS.maxBody ? new Error('too_large') : null, chunk);
      },
    });
    req.pipe(counter);
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(', ') : v);
    const ip = env.TRUST_PROXY === '1'
      ? String(req.headers['x-real-ip'] || String(req.headers['x-forwarded-for'] || '').split(',')[0]).trim() || req.socket.remoteAddress
      : req.socket.remoteAddress;

    try {
      const request = new Request('http://local' + req.url, { method: 'POST', headers, body: Readable.toWeb(counter), duplex: 'half' });
      const r = await handle(request, { ip });
      if (seen > LIMITS.maxBody) return tooLarge();
      send(r.status, r.body);
    } catch (e) {
      if (seen > LIMITS.maxBody) return tooLarge();
      console.error('[lead] ошибка обработки:', e.message);
      send(500, { ok: false, error: 'server' });
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT || 8787);
  const host = process.env.HOST || '127.0.0.1';
  createServer().listen(port, host, () => console.log(`[lead] слушаю http://${host}:${port}${process.env.LEAD_PATH || '/api/lead'}`));
}
