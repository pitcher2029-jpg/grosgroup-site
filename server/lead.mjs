// Приём заявки с сайта: проверка полей, антиспам, доставка (почта, Telegram, вебхук CRM) и резервная копия на диск.
// Правила полей совпадают с проверками формы в assets/js/main.js.
import { appendFile, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { sendMail } from './smtp.mjs';

export const LIMITS = {
  maxFiles: 5,
  maxFileSize: 10 * 1024 * 1024,
  maxBody: 52 * 1024 * 1024,     // 5 файлов по 10 МБ + поля и разметка multipart
  minFillMs: 3000,               // быстрее человек форму не заполнит
  rateCount: 8,                  // запросов с одного IP за окно
  rateWindowMs: 10 * 60 * 1000,
  channelTimeoutMs: 20000,       // Telegram и вебхук
  smtpDeadlineMs: 45000,         // всё письмо целиком; nginx ждёт ответа 90 с
  retentionDays: 395,            // резервная копия: 12 месяцев по политике + запас на уничтожение
};
const EXT = new Set(['pdf', 'doc', 'docx', 'xls', 'xlsx', 'csv', 'txt', 'png', 'jpg', 'jpeg', 'dwg', 'zip']);

const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const normPhone = (v) => {
  let d = String(v).replace(/\D/g, '');
  if (d.length === 11 && d[0] === '8') d = '7' + d.slice(1);
  if (d.length !== 11 || d[0] !== '7') return '';
  return `+7 (${d.slice(1, 4)}) ${d.slice(4, 7)}-${d.slice(7, 9)}-${d.slice(9)}`;
};
// Имя файла без путей и управляющих символов; длинное имя укорачивается с сохранением расширения
export const safeName = (name) => {
  const clean = String(name).split(/[\\/]/).pop().replace(/[\x00-\x1f\x7f"<>|:*?]/g, '_').trim() || 'file';
  if (clean.length <= 120) return clean;
  const dot = clean.lastIndexOf('.');
  const ext = dot > 0 && clean.length - dot <= 10 ? clean.slice(dot) : '';
  return clean.slice(0, 120 - ext.length) + ext;
};

export function validate(fd) {
  const v = {
    name: str(fd.get('name'), 80),
    phone: normPhone(str(fd.get('phone'), 40)),
    email: str(fd.get('email'), 120),
    description: str(fd.get('description'), 3000),
  };
  const errors = {};
  if (!/\p{L}.*\p{L}/u.test(v.name)) errors.name = 'Укажите имя — хотя бы 2 буквы';
  if (!v.phone) errors.phone = 'Укажите телефон полностью: +7 и 10 цифр';
  if (v.email && !/^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]{2,}$/.test(v.email)) errors.email = 'Проверьте адрес почты';
  if (fd.get('consent') !== 'yes') errors.consent = 'Нужно согласие на обработку персональных данных';
  const files = fd.getAll('files').filter((f) => typeof f === 'object' && f && f.size > 0);
  if (files.length > LIMITS.maxFiles) errors.files = `Не больше ${LIMITS.maxFiles} файлов`;
  else {
    const bad = files.find((f) => f.size > LIMITS.maxFileSize || !EXT.has(safeName(f.name).split('.').pop().toLowerCase()));
    if (bad) errors.files = `Файл ${safeName(bad.name)}: до 10 МБ, форматы ${[...EXT].join(', ')}`;
  }
  return { v, files, errors };
}

export function leadText(lead) {
  return [
    lead.suspect ? `Внимание: ${lead.suspect} — проверьте, не бот ли это.\n` : '',
    'Новая заявка с сайта GROSGROUP',
    '',
    'Имя: ' + lead.name,
    'Телефон: ' + lead.phone,
    'Почта: ' + (lead.email || '—'),
    'Описание: ' + (lead.description || '—'),
    'Файлы: ' + (lead.files.length ? lead.files.map((f) => `${f.name} (${Math.max(1, Math.round(f.size / 1024))} КБ)`).join(', ') : 'нет'),
    '',
    'Согласие на обработку ПДн: да, ' + lead.consentAt,
    'Заявка № ' + lead.id,
  ].join('\n').replace(/^\n/, '');
}

// Каналы доставки включаются переменными окружения; см. server/README.md.
// files — [{ name, size, blob }]: содержимое файлов не копируется, каждый канал читает Blob сам.
function channels(env, fetchImpl) {
  const list = [];
  const timeout = () => AbortSignal.timeout(Number(env.CHANNEL_TIMEOUT_MS) || LIMITS.channelTimeoutMs);
  if (env.SMTP_HOST && env.MAIL_TO) {
    list.push(['почта', (lead, files) => sendMail({
      host: env.SMTP_HOST,
      port: Number(env.SMTP_PORT || 465),
      secure: env.SMTP_SECURE ? env.SMTP_SECURE === '1' : undefined,
      requireTLS: env.SMTP_REQUIRE_TLS !== '0',
      user: env.SMTP_USER,
      pass: env.SMTP_PASS,
      from: env.MAIL_FROM || env.SMTP_USER,
      to: env.MAIL_TO,
      replyTo: lead.email || undefined,
      subject: `${lead.suspect ? '[проверить] ' : ''}Заявка с сайта: ${lead.name}, ${lead.phone}`,
      text: leadText(lead),
      attachments: files.map((f) => ({ name: f.name, blob: f.blob })),
      deadlineMs: Number(env.SMTP_DEADLINE_MS) || LIMITS.smtpDeadlineMs,
    })]);
  }
  if (env.TG_BOT_TOKEN && env.TG_CHAT_ID) {
    const api = (env.TG_API_BASE || 'https://api.telegram.org') + '/bot' + env.TG_BOT_TOKEN;
    list.push(['telegram', async (lead, files) => {
      const r = await fetchImpl(api + '/sendMessage', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: env.TG_CHAT_ID, text: leadText(lead).slice(0, 4000) }),
        signal: timeout(),
      });
      if (!r.ok) throw new Error('Telegram sendMessage: HTTP ' + r.status);
      for (const f of files) {
        const fd = new FormData();
        fd.append('chat_id', env.TG_CHAT_ID);
        fd.append('document', f.blob, f.name);
        const rd = await fetchImpl(api + '/sendDocument', { method: 'POST', body: fd, signal: timeout() });
        if (!rd.ok) throw new Error('Telegram sendDocument: HTTP ' + rd.status);
      }
    }]);
  }
  if (env.WEBHOOK_URL) {
    list.push(['вебхук', async (lead) => {
      const r = await fetchImpl(env.WEBHOOK_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(env.WEBHOOK_TOKEN ? { authorization: 'Bearer ' + env.WEBHOOK_TOKEN } : {}) },
        body: JSON.stringify(lead),
        signal: timeout(),
      });
      if (!r.ok) throw new Error('Вебхук: HTTP ' + r.status);
    }]);
  }
  return list;
}

async function store(dir, lead, files) {
  const own = path.join(dir, 'files', lead.id);
  await mkdir(files.length ? own : dir, { recursive: true, mode: 0o700 });
  const used = new Set();
  for (const f of files) {
    let name = f.name;
    for (let k = 2; used.has(name); k++) name = k + '-' + f.name;
    used.add(name);
    await pipeline(Readable.fromWeb(f.blob.stream()), createWriteStream(path.join(own, name), { mode: 0o600 }));
  }
  await appendFile(path.join(dir, 'leads.jsonl'), JSON.stringify(lead) + '\n', { mode: 0o600 });
}

/**
 * Удаляет из резервной копии заявки старше days дней: каталоги files/<номер> и строки leads.jsonl.
 * Номер заявки начинается с даты ГГГГММДД — по ней и считается возраст.
 */
export async function purgeStore(dir, days = LIMITS.retentionDays, now = Date.now()) {
  const border = new Date(now - days * 864e5).toISOString().slice(0, 10).replace(/-/g, '');
  const old = (id) => /^\d{8}-/.test(id) && id.slice(0, 8) < border;
  let removed = 0;
  const filesDir = path.join(dir, 'files');
  for (const id of await readdir(filesDir).catch(() => [])) {
    if (old(id)) { await rm(path.join(filesDir, id), { recursive: true, force: true }); removed++; }
  }
  const jsonl = path.join(dir, 'leads.jsonl');
  const text = await readFile(jsonl, 'utf8').catch(() => null);
  if (text) {
    const lines = text.split('\n').filter(Boolean);
    const keep = lines.filter((l) => { try { return !old(JSON.parse(l).id); } catch { return true; } });
    if (keep.length !== lines.length) {
      await writeFile(jsonl + '.tmp', keep.map((l) => l + '\n').join(''), { mode: 0o600 });
      await rename(jsonl + '.tmp', jsonl);
      removed += lines.length - keep.length;
    }
  }
  return removed;
}

const ok = { status: 200, body: { ok: true } };
const fail = (status, error, extra = {}) => ({ status, body: { ok: false, error, ...extra } });

/**
 * Возвращает обработчик (request: Request, { ip }) → { status, body }.
 * Заполненная ловушка — бот: ответ 200 { ok:true } без доставки, чтобы не подсказывать причину.
 * Слишком быстрая отправка заявку не отбрасывает: она доставляется с пометкой «проверить».
 */
export function createLeadHandler(env = process.env, { now = () => Date.now(), fetchImpl = fetch, log = console } = {}) {
  const hits = new Map();
  const limited = (ip) => {
    const t = now();
    if (hits.size > 5000) for (const [k, list] of hits) if (t - list.at(-1) > LIMITS.rateWindowMs) hits.delete(k);
    const list = (hits.get(ip) || []).filter((x) => t - x < LIMITS.rateWindowMs);
    list.push(t);
    hits.set(ip, list);
    return list.length > LIMITS.rateCount;
  };
  const deliver = channels(env, fetchImpl);

  return async function handleLead(request, { ip = '' } = {}) {
    if (limited(ip)) return fail(429, 'rate_limited');
    let fd;
    try { fd = await request.formData(); } catch { return fail(400, 'bad_form'); }

    if (str(fd.get('website'), 200)) return ok;
    // elapsed — сколько миллисекунд страница была открыта до отправки (считает браузер, часы сервера не нужны)
    // Пустое или отсутствующее поле (страница из старого кэша) пометки не даёт: Number('') === 0
    const rawElapsed = str(fd.get('elapsed'), 20);
    const elapsed = rawElapsed ? Number(rawElapsed) : NaN;
    const suspect = Number.isFinite(elapsed) && elapsed >= 0 && elapsed < LIMITS.minFillMs
      ? `форма отправлена через ${(elapsed / 1000).toFixed(1)} с после открытия страницы` : '';

    const { v, files, errors } = validate(fd);
    if (Object.keys(errors).length) return fail(400, 'invalid', { fields: errors });
    if (!deliver.length) {
      log.error('[lead] ни один канал доставки не настроен');
      return fail(500, 'not_configured');
    }

    const at = new Date(now());
    const data = files.map((f) => ({ name: safeName(f.name), size: f.size, blob: f }));
    const lead = {
      id: at.toISOString().slice(0, 10).replace(/-/g, '') + '-' + crypto.randomBytes(3).toString('hex'),
      receivedAt: at.toISOString(),
      ...v,
      consentAt: at.toISOString(),
      files: data.map(({ name, size }) => ({ name, size })),
      ip,
      ...(suspect ? { suspect } : {}),
    };

    let stored = false;
    if (env.LEAD_STORE_DIR) {
      try { await store(env.LEAD_STORE_DIR, lead, data); stored = true; } catch (e) { log.error('[lead] резервная копия не записана:', e.message); }
    }
    // Каналы работают параллельно, у каждого свой срок: медленная CRM не задерживает ответ дольше тайм-аута
    const results = await Promise.allSettled(deliver.map(([, send]) => send(lead, data)));
    results.forEach((r, i) => { if (r.status === 'rejected') log.error(`[lead] ${lead.id}: канал «${deliver[i][0]}» не доставил:`, r.reason?.message || r.reason); });
    if (results.some((r) => r.status === 'fulfilled')) return ok;
    // Каналы молчат, но заявка сохранена на диске — пользователю не нужно отправлять её повторно
    if (stored) { log.error(`[lead] ${lead.id}: DELIVERY_FAILED, заявка только в резервной копии`); return ok; }
    return fail(502, 'delivery_failed');
  };
}
