// Тесты обработчика заявок: node --test server/test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { createLeadHandler, LIMITS, safeName, purgeStore } from '../lead.mjs';
import { createServer } from '../http.mjs';
import { encodeHeader } from '../smtp.mjs';

const T0 = Date.parse('2026-10-27T10:00:00Z');
const quiet = { error() {}, log() {} };
const form = (over = {}, files = []) => {
  const fd = new FormData();
  const base = { name: 'Иван Петров', phone: '+7 (961) 125-55-50', email: 'ivan@example.ru', description: 'Свёрла 8 мм, 100 шт.', consent: 'yes', website: '', elapsed: '60000' };
  for (const [k, v] of Object.entries({ ...base, ...over })) if (v !== null) fd.append(k, v);
  for (const f of files) fd.append('files', new Blob([f.data]), f.name);
  return fd;
};
const req = (fd) => new Request('http://local/api/lead', { method: 'POST', body: fd });
const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));

// Поддельный SMTP-сервер: записывает команды и текст письма
function fakeSmtp() {
  const got = { cmds: [], data: '' };
  const srv = net.createServer((s) => {
    let buf = '';
    let inData = false;
    s.write('220 fake ESMTP\r\n');
    s.on('data', (d) => {
      buf += d.toString('utf8');
      for (;;) {
        if (inData) {
          const end = buf.indexOf('\r\n.\r\n');
          if (end < 0) return;
          got.data = buf.slice(0, end);
          buf = buf.slice(end + 5);
          inData = false;
          s.write('250 queued\r\n');
          continue;
        }
        const i = buf.indexOf('\r\n');
        if (i < 0) return;
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        got.cmds.push(line);
        const c = line.split(' ')[0].toUpperCase();
        if (c === 'EHLO') s.write('250-fake\r\n250 AUTH PLAIN\r\n');
        else if (c === 'AUTH') s.write('235 ok\r\n');
        else if (c === 'MAIL' || c === 'RCPT') s.write('250 ok\r\n');
        else if (c === 'DATA') { s.write('354 go\r\n'); inData = true; }
        else if (c === 'QUIT') { s.write('221 bye\r\n'); s.end(); return; }
        else s.write('500 ?\r\n');
      }
    });
  });
  return { srv, got };
}

// Поддельный Telegram Bot API
function fakeTelegram(status = 200) {
  const calls = [];
  const srv = http.createServer((rq, rs) => {
    const chunks = [];
    rq.on('data', (c) => chunks.push(c));
    rq.on('end', () => {
      calls.push({ url: rq.url, body: Buffer.concat(chunks).toString('latin1') });
      rs.writeHead(status, { 'content-type': 'application/json' });
      rs.end('{"ok":true}');
    });
  });
  return { srv, calls };
}

test('без настроенных каналов — 500 not_configured', async () => {
  const h = createLeadHandler({}, { now: () => T0, log: quiet });
  const r = await h(req(form()), { ip: '1.1.1.1' });
  assert.equal(r.status, 500);
  assert.equal(r.body.error, 'not_configured');
});

test('проверка полей: имя, телефон, почта, согласие', async () => {
  const h = createLeadHandler({ WEBHOOK_URL: 'http://x' }, { now: () => T0, log: quiet, fetchImpl: async () => new Response('') });
  const r = await h(req(form({ name: 'И', phone: '+7 (961) 12', email: 'плохо', consent: null })), { ip: '1' });
  assert.equal(r.status, 400);
  assert.deepEqual(Object.keys(r.body.fields).sort(), ['consent', 'email', 'name', 'phone']);
  const ok8 = await h(req(form({ phone: '89611255550', email: '' })), { ip: '2' });
  assert.equal(ok8.status, 200, 'номер с 8 и пустая почта принимаются');
});

test('файлы: не больше 5, белый список расширений, до 10 МБ', async () => {
  const h = createLeadHandler({ WEBHOOK_URL: 'http://x' }, { now: () => T0, log: quiet, fetchImpl: async () => new Response('') });
  const six = Array.from({ length: 6 }, (_, i) => ({ name: `f${i}.pdf`, data: 'x' }));
  assert.equal((await h(req(form({}, six)), { ip: 'a' })).body.fields.files, 'Не больше 5 файлов');
  assert.match((await h(req(form({}, [{ name: 'virus.exe', data: 'x' }])), { ip: 'b' })).body.fields.files, /virus\.exe/);
  const big = { name: 'big.pdf', data: new Uint8Array(LIMITS.maxFileSize + 1) };
  assert.equal((await h(req(form({}, [big])), { ip: 'c' })).status, 400);
  assert.equal(safeName('../../etc/passwd'), 'passwd');
  assert.equal(safeName('C:\\docs\\смета "1".xlsx'), 'смета _1_.xlsx');
});

test('антиспам: ловушка — 200 без доставки; быстрая отправка доставляется с пометкой', async () => {
  const hooks = [];
  const h = createLeadHandler({ WEBHOOK_URL: 'http://x' }, { now: () => T0, log: quiet, fetchImpl: async (u, init) => { hooks.push(JSON.parse(init.body)); return new Response(''); } });
  assert.equal((await h(req(form({ website: 'http://spam' })), { ip: '1' })).status, 200);
  assert.equal(hooks.length, 0, 'ловушка: ничего не доставлено');
  assert.equal((await h(req(form({ elapsed: '1500' })), { ip: '2' })).status, 200);
  assert.equal(hooks.length, 1, 'быстрая отправка не теряется');
  assert.match(hooks[0].suspect, /через 1\.5 с/);
  assert.equal((await h(req(form({ elapsed: null })), { ip: '3' })).status, 200);
  assert.equal(hooks[1].suspect, undefined, 'без поля elapsed пометки нет');
});

test('имя файла: длинное укорачивается с сохранением расширения и принимается', async () => {
  const long = 'Техническое задание '.repeat(6) + '.pdf';
  assert.ok(long.length > 120);
  assert.equal(safeName(long).length, 120);
  assert.ok(safeName(long).endsWith('.pdf'));
  const h = createLeadHandler({ WEBHOOK_URL: 'http://x' }, { now: () => T0, log: quiet, fetchImpl: async () => new Response('') });
  assert.equal((await h(req(form({}, [{ name: long, data: 'x' }])), { ip: '1' })).status, 200);
});

test('медленный канал не задерживает ответ дольше тайм-аута', async () => {
  const hang = http.createServer(() => {});
  const port = await listen(hang);
  const errors = [];
  const env = { WEBHOOK_URL: `http://127.0.0.1:${port}/hook`, CHANNEL_TIMEOUT_MS: '300' };
  const h = createLeadHandler(env, { now: () => T0, log: { error: (...a) => errors.push(a.join(' ')) } });
  const t = Date.now();
  const r = await h(req(form()), { ip: '1' });
  assert.equal(r.status, 502);
  assert.ok(Date.now() - t < 3000, 'ответ без ожидания зависшего вебхука');
  assert.ok(errors.some((e) => /вебхук/.test(e)));
  hang.closeAllConnections();
  hang.close();
});

test('очистка резервной копии: заявки старше срока удаляются, свежие остаются', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'gg-purge-'));
  let t = Date.parse('2025-01-10T10:00:00Z');
  const h = createLeadHandler({ LEAD_STORE_DIR: dir, WEBHOOK_URL: 'http://x' }, { now: () => t, log: quiet, fetchImpl: async () => new Response('') });
  await h(req(form({}, [{ name: 'old.pdf', data: 'A' }])), { ip: '1' });
  t = Date.parse('2026-02-20T10:00:00Z');
  await h(req(form({}, [{ name: 'new.pdf', data: 'B' }])), { ip: '1' });
  assert.equal((await readdir(path.join(dir, 'files'))).length, 2);
  const removed = await purgeStore(dir, 395, Date.parse('2026-02-21T00:00:00Z'));
  assert.equal(removed, 2, 'каталог и строка старой заявки');
  const left = await readdir(path.join(dir, 'files'));
  assert.deepEqual(left.map((x) => x.slice(0, 8)), ['20260220']);
  const lines = (await readFile(path.join(dir, 'leads.jsonl'), 'utf8')).trim().split('\n');
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]).id.slice(0, 8), '20260220');
  assert.equal(await purgeStore(dir, 395, Date.parse('2026-02-21T00:00:00Z')), 0, 'повторно удалять нечего');
});

test('ограничение частоты: девятый запрос с одного IP за 10 минут — 429', async () => {
  let t = T0;
  const h = createLeadHandler({ WEBHOOK_URL: 'http://x' }, { now: () => t, log: quiet, fetchImpl: async () => new Response('') });
  for (let i = 0; i < LIMITS.rateCount; i++) assert.equal((await h(req(form()), { ip: '9.9.9.9' })).status, 200);
  assert.equal((await h(req(form()), { ip: '9.9.9.9' })).status, 429);
  assert.equal((await h(req(form()), { ip: '8.8.8.8' })).status, 200, 'другой IP не затронут');
  t += LIMITS.rateWindowMs + 1;
  assert.equal((await h(req(form()), { ip: '9.9.9.9' })).status, 200, 'после окна снова можно');
});

test('почта: AUTH, получатели, тема и вложение в письме', async () => {
  const { srv, got } = fakeSmtp();
  const port = await listen(srv);
  const env = { SMTP_HOST: '127.0.0.1', SMTP_PORT: String(port), SMTP_SECURE: '0', SMTP_REQUIRE_TLS: '0', SMTP_USER: 'u@grosgroup.ru', SMTP_PASS: 'p', MAIL_FROM: 'GROSGROUP <u@grosgroup.ru>', MAIL_TO: 'a@grosgroup.ru, b@grosgroup.ru' };
  const h = createLeadHandler(env, { now: () => T0, log: quiet });
  const r = await h(req(form({}, [{ name: 'Смета.xlsx', data: 'XLSX-DATA' }])), { ip: '1' });
  srv.close();
  assert.equal(r.status, 200);
  assert.ok(got.cmds.includes('AUTH PLAIN ' + Buffer.from('\0u@grosgroup.ru\0p').toString('base64')));
  assert.deepEqual(got.cmds.filter((c) => c.startsWith('RCPT')), ['RCPT TO:<a@grosgroup.ru>', 'RCPT TO:<b@grosgroup.ru>']);
  assert.ok(got.data.includes('Subject: ' + encodeHeader('Заявка с сайта: Иван Петров, +7 (961) 125-55-50')));
  assert.ok(got.data.includes('Reply-To: ivan@example.ru'));
  assert.ok(got.data.includes("filename*=UTF-8''" + encodeURIComponent('Смета.xlsx')));
  assert.ok(got.data.includes(Buffer.from('XLSX-DATA').toString('base64')));
  const textPart = got.data.split('Content-Transfer-Encoding: base64\r\n\r\n')[1].split('\r\n--')[0];
  assert.match(Buffer.from(textPart, 'base64').toString('utf8'), /Описание: Свёрла 8 мм/);
});

test('почта: без шифрования пароль не отправляется', async () => {
  const { srv, got } = fakeSmtp();
  const port = await listen(srv);
  const env = { SMTP_HOST: '127.0.0.1', SMTP_PORT: String(port), SMTP_SECURE: '0', SMTP_USER: 'u', SMTP_PASS: 'p', MAIL_FROM: 'u@x.ru', MAIL_TO: 'a@x.ru' };
  const errors = [];
  const h = createLeadHandler(env, { now: () => T0, log: { error: (...a) => errors.push(a.join(' ')) } });
  const r = await h(req(form()), { ip: '1' });
  srv.close();
  assert.equal(r.status, 502);
  assert.ok(!got.cmds.some((c) => c.startsWith('AUTH')));
  assert.match(errors.join('\n'), /пароль не отправлен/);
});

test('Telegram: сообщение и файл; токен не попадает в журнал', async () => {
  const { srv, calls } = fakeTelegram();
  const port = await listen(srv);
  const env = { TG_BOT_TOKEN: 'SECRET123', TG_CHAT_ID: '-100', TG_API_BASE: `http://127.0.0.1:${port}` };
  const h = createLeadHandler(env, { now: () => T0, log: quiet });
  const r = await h(req(form({}, [{ name: 'spec.pdf', data: 'PDF' }])), { ip: '1' });
  assert.equal(r.status, 200);
  assert.deepEqual(calls.map((c) => c.url), ['/botSECRET123/sendMessage', '/botSECRET123/sendDocument']);
  assert.match(Buffer.from(calls[0].body, 'latin1').toString('utf8'), /Иван Петров/);
  srv.close();

  const bad = fakeTelegram(500);
  const port2 = await listen(bad.srv);
  const errors = [];
  const h2 = createLeadHandler({ ...env, TG_API_BASE: `http://127.0.0.1:${port2}` }, { now: () => T0, log: { error: (...a) => errors.push(a.join(' ')) } });
  assert.equal((await h2(req(form()), { ip: '1' })).status, 502);
  bad.srv.close();
  assert.ok(errors.length && !errors.join(' ').includes('SECRET123'));
});

test('резервная копия: строка JSONL и файл; при отказе каналов заявка не теряется', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'gg-lead-'));
  const h = createLeadHandler({ LEAD_STORE_DIR: dir, WEBHOOK_URL: 'http://x' }, { now: () => T0, log: quiet, fetchImpl: async () => new Response('', { status: 500 }) });
  const r = await h(req(form({}, [{ name: 'a.pdf', data: 'A' }, { name: 'a.pdf', data: 'B' }])), { ip: '1' });
  assert.equal(r.status, 200);
  const line = JSON.parse((await readFile(path.join(dir, 'leads.jsonl'), 'utf8')).trim());
  assert.equal(line.phone, '+7 (961) 125-55-50');
  assert.equal(line.consentAt, new Date(T0).toISOString());
  const files = await readdir(path.join(dir, 'files', line.id));
  assert.deepEqual(files.sort(), ['2-a.pdf', 'a.pdf']);
});

test('HTTP: заявка проходит, чужой путь — 404, GET — 405, CORS, тело больше лимита — 413', async () => {
  const hooks = [];
  const fetchImpl = async (url, init) => { hooks.push(JSON.parse(init.body)); return new Response(''); };
  const srv = createServer({ WEBHOOK_URL: 'http://crm', ALLOW_ORIGIN: 'https://grosgroup.ru', TRUST_PROXY: '1' }, { now: () => T0, fetchImpl, log: quiet });
  const port = await listen(srv);
  const base = `http://127.0.0.1:${port}`;
  const r = await fetch(base + '/api/lead', { method: 'POST', body: form({}, [{ name: 'x.txt', data: 'hi' }]), headers: { 'x-real-ip': '5.6.7.8' } });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true });
  assert.equal(r.headers.get('access-control-allow-origin'), 'https://grosgroup.ru');
  assert.equal(hooks[0].ip, '5.6.7.8');
  assert.deepEqual(hooks[0].files, [{ name: 'x.txt', size: 2 }]);
  assert.equal((await fetch(base + '/other', { method: 'POST' })).status, 404);
  assert.equal((await fetch(base + '/api/lead')).status, 405);
  assert.equal((await fetch(base + '/api/lead', { method: 'OPTIONS' })).status, 204);
  const big = await fetch(base + '/api/lead', { method: 'POST', body: new Uint8Array(LIMITS.maxBody + 10), headers: { 'content-type': 'multipart/form-data; boundary=x' } }).catch((e) => e);
  assert.ok(big instanceof Error || big.status === 413, 'большое тело отклонено');
  srv.close();
});

test('HTTP: кривой адрес — 400, очередь переполнена — 503 busy', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const fetchImpl = async () => { await gate; return new Response(''); };
  const srv = createServer({ WEBHOOK_URL: 'http://crm', MAX_CONCURRENT: '1', MAX_QUEUE: '0' }, { now: () => T0, fetchImpl, log: quiet });
  const port = await listen(srv);
  const base = `http://127.0.0.1:${port}`;
  const raw = await new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1', () => s.write('POST //[ HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n'));
    let out = '';
    s.on('data', (d) => { out += d; });
    s.on('close', () => resolve(out));
  });
  assert.match(raw, /^HTTP\/1\.1 400/);
  const first = fetch(base + '/api/lead', { method: 'POST', body: form() });
  await new Promise((r) => setTimeout(r, 100));
  const second = await fetch(base + '/api/lead', { method: 'POST', body: form() });
  assert.equal(second.status, 503);
  assert.equal(second.headers.get('retry-after'), '30');
  release();
  assert.equal((await first).status, 200);
  assert.equal((await fetch(base + '/api/lead', { method: 'POST', body: form() })).status, 200, 'место освободилось');
  srv.close();
});

test('почта: двоичное вложение передаётся по частям без искажений; пометка «проверить»', async () => {
  const { srv, got } = fakeSmtp();
  const port = await listen(srv);
  const env = { SMTP_HOST: '127.0.0.1', SMTP_PORT: String(port), SMTP_SECURE: '0', MAIL_FROM: 'u@x.ru', MAIL_TO: 'a@x.ru' };
  const bin = new Uint8Array(300001).map((_, i) => (i * 7919 + (i >> 8)) & 255);
  const fd = form({ elapsed: '800' });
  fd.append('files', new Blob([bin]), 'draw.dwg');
  const h = createLeadHandler(env, { now: () => T0, log: quiet });
  assert.equal((await h(req(fd), { ip: '1' })).status, 200);
  srv.close();
  assert.ok(got.data.includes('Subject: ' + encodeHeader('[проверить] Заявка с сайта: Иван Петров, +7 (961) 125-55-50')));
  const part = got.data.split("filename*=UTF-8''draw.dwg\r\n\r\n")[1].split('\r\n--')[0];
  assert.ok(part.split('\r\n').every((l) => l.length <= 76), 'строки base64 не длиннее 76');
  assert.ok(Buffer.from(part.replace(/\r\n/g, ''), 'base64').equals(Buffer.from(bin)));
});

test('заголовок письма: длинная кириллица режется на слова не длиннее 75 символов', () => {
  const h = encodeHeader('Заявка с сайта: Константин Константинопольский, +7 (961) 125-55-50');
  for (const w of h.split('\r\n ')) assert.ok(w.length <= 75, w);
  const back = h.split('\r\n ').map((w) => Buffer.from(w.slice(10, -2), 'base64').toString('utf8')).join('');
  assert.equal(back, 'Заявка с сайта: Константин Константинопольский, +7 (961) 125-55-50');
});
