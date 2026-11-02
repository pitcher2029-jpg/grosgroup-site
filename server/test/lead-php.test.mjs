// Тесты PHP-обработчика заявок api/lead.php (хостинг reg.ru) на встроенном сервере PHP.
// Нужен php в PATH (или PHP_BIN); без него тесты пропускаются. Без PHP на машине — tools/php-test.sh (Docker php:8.2-cli).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp, readFile, writeFile, mkdir, chmod, readdir, rm } from 'node:fs/promises';

const API = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../api');
const PHP = process.env.PHP_BIN || 'php';
const T0 = Date.parse('2026-11-03T10:00:00Z') / 1000;

let hasPhp = true;
try { execFileSync(PHP, ['-v'], { stdio: 'ignore' }); } catch { hasPhp = false; }
const opts = { skip: hasPhp ? false : 'нет PHP — запустите tools/php-test.sh', timeout: 60000 };

let tmp, port, php, cfgFile;
const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));

before(async () => {
  if (!hasPhp) return;
  tmp = await mkdtemp(path.join(os.tmpdir(), 'gg-php-'));
  cfgFile = path.join(tmp, 'config.php');
  // sendmail хостинга: письмо — в mail.eml, аргументы — в mail.args
  await writeFile(path.join(tmp, 'sendmail.sh'), `#!/bin/sh\necho "$@" > ${tmp}/mail.args\ncat > ${tmp}/mail.eml\n`);
  await chmod(path.join(tmp, 'sendmail.sh'), 0o755);
  await config({});
  const probe = net.createServer();
  port = await listen(probe);
  await new Promise((r) => probe.close(r));
  php = spawn(PHP, ['-d', `sendmail_path=${tmp}/sendmail.sh`, '-d', 'upload_max_filesize=10M', '-d', 'post_max_size=20M', '-d', 'max_file_uploads=10',
    '-d', 'log_errors=1', '-d', `error_log=${tmp}/php.log`, '-S', `127.0.0.1:${port}`, '-t', API],
    { stdio: 'ignore', env: { ...process.env, GG_LEAD_CONFIG: cfgFile } });
  for (let i = 0; i < 100; i++) {
    try { await fetch(`http://127.0.0.1:${port}/lead.php`); return; } catch { await new Promise((r) => setTimeout(r, 200)); }
  }
  throw new Error('PHP-сервер не поднялся');
});
after(async () => {
  if (php) php.kill();
  if (tmp) await rm(tmp, { recursive: true, force: true }).catch(() => {});
});

// Настройки обработчика: каждая проверка пишет свои; store — новый каталог, чтобы счётчик частоты не копился
let storeN = 0;
async function config(c) {
  const store = c.store === false ? '' : `${tmp}/store${++storeN}`;
  const php = (v) => (typeof v === 'object' && v ? `[${Object.entries(v).map(([k, x]) => `'${k}' => ${php(x)}`).join(', ')}]` : JSON.stringify(v));
  const body = { store_dir: store, now: c.now ?? T0, ...(c.mail ? { mail: c.mail } : {}), ...(c.telegram ? { telegram: c.telegram } : {}) };
  await writeFile(cfgFile, `<?php\nreturn ${php(body)};\n`);
  return store;
}
const MAIL = { transport: 'mail', to: 'test@example.com', from: 'noreply@grosgroup.ru' };

const form = (over = {}, files = []) => {
  const fd = new FormData();
  const base = { name: 'Иван Петров', phone: '8 961 125 55 50', email: 'ivan@example.ru', description: 'Свёрла 8 мм, 100 шт.', consent: 'yes', website: '', elapsed: '60000' };
  for (const [k, v] of Object.entries({ ...base, ...over })) if (v !== null) fd.append(k, v);
  for (const f of files) fd.append('files[]', new Blob([f.data]), f.name);
  return fd;
};
const post = async (fd, extra = {}) => {
  const r = await fetch(`http://127.0.0.1:${port}/lead.php`, { method: 'POST', body: fd, ...extra });
  return { status: r.status, body: await r.json() };
};
const mailText = async () => {
  const raw = await readFile(path.join(tmp, 'mail.eml'), 'utf8');
  const part = raw.split(/--gg-[0-9a-f]+/)[1];
  return { raw, text: Buffer.from(part.split('\r\n\r\n')[1].replace(/\s/g, ''), 'base64').toString('utf8') };
};
const decodeSubject = (raw) => raw.match(/^Subject: ((?:.*\r?\n[ \t].*)*.*)/m)[1]
  .split(/\s+/).map((w) => Buffer.from(w.replace(/^=\?UTF-8\?B\?|\?=$/g, ''), 'base64').toString('utf8')).join('');

test('PHP: GET — 405; без каналов — 500 not_configured', opts, async () => {
  assert.equal((await fetch(`http://127.0.0.1:${port}/lead.php`)).status, 405);
  await config({});
  assert.deepEqual(await post(form()), { status: 500, body: { ok: false, error: 'not_configured' } });
});

test('PHP: проверка полей — имя, телефон, почта, согласие', opts, async () => {
  await config({ mail: MAIL });
  const r = await post(form({ name: 'И', phone: '123', email: 'a@b', consent: null }));
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'invalid');
  assert.deepEqual(Object.keys(r.body.fields).sort(), ['consent', 'email', 'name', 'phone']);
});

test('PHP: файлы — не больше 5, белый список, до 10 МБ, вместе до 15 МБ; тело больше 16 МБ — 413', opts, async () => {
  await config({ mail: MAIL });
  const six = Array.from({ length: 6 }, (_, i) => ({ name: `f${i}.pdf`, data: 'x' }));
  assert.match((await post(form({}, six))).body.fields.files, /Не больше 5/);
  assert.match((await post(form({}, [{ name: 'run.exe', data: 'x' }]))).body.fields.files, /run\.exe/);
  const mb = (n) => new Uint8Array(n * 1024 * 1024);
  assert.match((await post(form({}, [{ name: 'a.pdf', data: mb(8) }, { name: 'b.pdf', data: mb(7.5) }]))).body.fields.files, /15 МБ/);
  assert.equal((await post(form({}, [{ name: 'a.pdf', data: mb(9) }, { name: 'b.pdf', data: mb(9) }]))).status, 413);
});

test('PHP: почта через mail() — тема, Reply-To, адрес возврата, текст и вложение', opts, async () => {
  await config({ mail: MAIL });
  const bin = Buffer.from([0, 1, 2, 255, 46, 13, 10, 46]);
  const r = await post(form({}, [{ name: 'Спецификация.pdf', data: bin }]));
  assert.deepEqual(r, { status: 200, body: { ok: true } });
  const { raw, text } = await mailText();
  assert.match(await readFile(path.join(tmp, 'mail.args'), 'utf8'), /-fnoreply@grosgroup\.ru/);
  assert.match(raw, /^Reply-To: ivan@example\.ru/m);
  assert.equal(decodeSubject(raw), 'Заявка с сайта: Иван Петров, +7 (961) 125-55-50');
  assert.match(text, /^Новая заявка с сайта GROSGROUP/);
  assert.match(text, /Телефон: \+7 \(961\) 125-55-50/);
  assert.match(text, /Файлы: Спецификация\.pdf \(1 КБ\)/);
  assert.match(text, /Заявка № 20261103-[0-9a-f]{6}/);
  assert.match(raw, /filename\*=UTF-8''%D0%A1/);
  const att = raw.split(/--gg-[0-9a-f]+/)[2].split('\r\n\r\n')[1];
  assert.deepEqual(Buffer.from(att.replace(/\s/g, ''), 'base64'), bin);
});

test('PHP: антиспам — ловушка 200 без доставки; быстрая отправка с пометкой «проверить»', opts, async () => {
  await config({ mail: MAIL });
  await writeFile(path.join(tmp, 'mail.eml'), '');
  assert.deepEqual(await post(form({ website: 'http://spam' })), { status: 200, body: { ok: true } });
  assert.equal(await readFile(path.join(tmp, 'mail.eml'), 'utf8'), '');
  await post(form({ elapsed: '1200' }));
  const { raw, text } = await mailText();
  assert.match(decodeSubject(raw), /^\[проверить\] /);
  assert.match(text, /через 1\.2 с после открытия/);
});

test('PHP: ограничение частоты — девятый запрос с одного IP — 429', opts, async () => {
  await config({ mail: MAIL });
  const codes = [];
  for (let i = 0; i < 9; i++) codes.push((await post(form({ name: '' }))).status);
  assert.deepEqual(codes, [400, 400, 400, 400, 400, 400, 400, 400, 429]);
});

// Поддельный Telegram API: записывает метод и тело запроса
async function fakeTg(status = 200) {
  const got = [];
  const srv = http.createServer((q, s) => {
    const chunks = [];
    q.on('data', (c) => chunks.push(c));
    q.on('end', () => { got.push({ url: q.url, body: Buffer.concat(chunks).toString('utf8') }); s.writeHead(status, { 'content-type': 'application/json' }); s.end('{"ok":true}'); });
  });
  return { got, srv, port: await listen(srv) };
}

test('PHP: Telegram full — сообщение и файл; notice — без ПДн и файлов', opts, async () => {
  const tg = await fakeTg();
  try {
    const telegram = { token: '123:SECRET', chat_id: '-100', api_base: `http://127.0.0.1:${tg.port}`, mode: 'full' };
    await config({ telegram });
    assert.equal((await post(form({}, [{ name: 'чертёж.dwg', data: 'x' }]))).status, 200);
    assert.deepEqual(tg.got.map((g) => g.url), ['/bot123:SECRET/sendMessage', '/bot123:SECRET/sendDocument']);
    assert.match(tg.got[0].body, /%D0%98%D0%B2%D0%B0%D0%BD|Иван/);
    assert.match(tg.got[1].body, /filename="чертёж\.dwg"/);
    tg.got.length = 0;
    await config({ telegram: { ...telegram, mode: 'notice' } });
    assert.equal((await post(form({}, [{ name: 'чертёж.dwg', data: 'x' }]))).status, 200);
    assert.deepEqual(tg.got.map((g) => g.url), ['/bot123:SECRET/sendMessage']);
    const text = decodeURIComponent(tg.got[0].body.replace(/\+/g, ' '));
    assert.match(text, /Новая заявка с сайта GROSGROUP № 20261103-/);
    assert.doesNotMatch(text, /Иван|961|example/);
  } finally { tg.srv.close(); }
});

test('PHP: резервная копия — заявка сохраняется, при отказе каналов ответ 200; без копии — 502; токен не в журнале', opts, async () => {
  const tg = await fakeTg(500);
  try {
    const telegram = { token: '123:SECRET', chat_id: '-100', api_base: `http://127.0.0.1:${tg.port}`, mode: 'full' };
    const store = await config({ telegram });
    assert.deepEqual(await post(form({}, [{ name: 'a.txt', data: 'abc' }])), { status: 200, body: { ok: true } });
    const lead = JSON.parse((await readFile(path.join(store, 'leads.jsonl'), 'utf8')).trim());
    assert.equal(lead.name, 'Иван Петров');
    assert.equal(lead.consentAt, '2026-11-03T10:00:00.000Z');
    assert.equal(await readFile(path.join(store, 'files', lead.id, 'a.txt'), 'utf8'), 'abc');
    await config({ telegram, store: false });
    assert.deepEqual(await post(form()), { status: 502, body: { ok: false, error: 'delivery_failed' } });
    const log = await readFile(path.join(tmp, 'php.log'), 'utf8');
    assert.match(log, /канал «telegram» не доставил: Telegram sendMessage: HTTP 500/);
    assert.doesNotMatch(log, /SECRET/);
  } finally { tg.srv.close(); }
});

test('PHP: очистка — заявки старше 395 дней удаляются раз в сутки, свежие остаются', opts, async () => {
  const store = await config({ mail: MAIL });
  await mkdir(path.join(store, 'files', '20250101-aaaaaa'), { recursive: true });
  await writeFile(path.join(store, 'files', '20250101-aaaaaa', 'old.pdf'), 'x');
  await writeFile(path.join(store, 'leads.jsonl'), '{"id":"20250101-aaaaaa"}\n{"id":"20251201-bbbbbb"}\n');
  assert.equal((await post(form())).status, 200);
  assert.deepEqual(await readdir(path.join(store, 'files')), []);
  const ids = (await readFile(path.join(store, 'leads.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l).id);
  assert.equal(ids.length, 2);
  assert.equal(ids[0], '20251201-bbbbbb');
  assert.match(ids[1], /^20261103-/);
});

// Поддельный SMTP-сервер с TLS (порт 465): записывает команды и письмо
async function fakeSmtps() {
  const key = path.join(tmp, 'k.pem');
  const crt = path.join(tmp, 'c.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', crt, '-days', '1', '-subj', '/CN=localhost'], { stdio: 'ignore' });
  const got = { cmds: [], data: '' };
  const srv = tls.createServer({ key: await readFile(key), cert: await readFile(crt) }, (s) => {
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
  return { got, srv, port: await listen(srv) };
}

test('PHP: почта через SMTP (SSL) — AUTH, получатели, точка в начале строки экранируется', opts, async () => {
  const smtp = await fakeSmtps();
  try {
    await config({ mail: { transport: 'smtp', host: '127.0.0.1', port: smtp.port, secure: true, verify: false, user: 'by@grosgroup.ru', pass: 'pw', from: 'by@grosgroup.ru', to: 'a@example.com, b@example.com' } });
    assert.equal((await post(form({ description: 'строка\n.точка' }))).status, 200);
    assert.ok(smtp.got.cmds.includes('AUTH PLAIN ' + Buffer.from('\0by@grosgroup.ru\0pw').toString('base64')));
    assert.ok(smtp.got.cmds.includes('MAIL FROM:<by@grosgroup.ru>'));
    assert.deepEqual(smtp.got.cmds.filter((c) => c.startsWith('RCPT')), ['RCPT TO:<a@example.com>', 'RCPT TO:<b@example.com>']);
    assert.match(smtp.got.data, /^To: a@example\.com, b@example\.com\r\nSubject: =\?UTF-8\?B\?/);
  } finally { smtp.srv.close(); }
});

test('PHP: SMTP без шифрования и без STARTTLS — пароль не отправляется', opts, async () => {
  const got = [];
  const srv = net.createServer((s) => {
    s.write('220 plain\r\n');
    s.on('data', (d) => { got.push(d.toString()); s.write('250 fake\r\n'); });
  });
  const p = await listen(srv);
  try {
    await config({ mail: { transport: 'smtp', host: '127.0.0.1', port: p, secure: false, user: 'u', pass: 'pw', from: 'by@grosgroup.ru', to: 'a@example.com' }, store: false });
    assert.equal((await post(form())).status, 502);
    assert.doesNotMatch(got.join(''), /AUTH/);
  } finally { srv.close(); }
});
