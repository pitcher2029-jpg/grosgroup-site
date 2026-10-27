// Минимальный SMTP-клиент без зависимостей: SSL (порт 465) или STARTTLS (587), AUTH PLAIN, письмо с вложениями.
import net from 'node:net';
import tls from 'node:tls';
import crypto from 'node:crypto';

// Заголовок в UTF-8 (RFC 2047): кусками не длиннее 45 байт, чтобы не резать многобайтные буквы
export const encodeHeader = (s) => {
  if (/^[\x20-\x7e]*$/.test(s)) return s;
  const words = [];
  let chunk = '';
  for (const ch of s) {
    if (Buffer.byteLength(chunk + ch) > 45) { words.push(chunk); chunk = ''; }
    chunk += ch;
  }
  if (chunk) words.push(chunk);
  return words.map((w) => '=?UTF-8?B?' + Buffer.from(w).toString('base64') + '?=').join('\r\n ');
};

const b64lines = (buf) => buf.toString('base64').replace(/.{1,76}/g, '$&\r\n');
const addr = (s) => { const m = /<([^>]+)>/.exec(s); return (m ? m[1] : s).trim(); };
// Имя файла в параметре (RFC 2231): UTF-8 в процентной записи
const fileParam = (name) => "UTF-8''" + encodeURIComponent(name).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());

// Письмо пишется в сокет по частям: вложения читаются из Blob кусками и сразу кодируются в base64,
// поэтому в памяти нет ни копии файлов, ни письма целиком
async function writeMessage(socket, { from, to, replyTo, subject, text, attachments = [], date = new Date() }) {
  // Ждём, пока сокет примет данные; обрыв соединения во время ожидания — ошибка, а не вечное ожидание
  const put = (s) => new Promise((resolve, reject) => {
    if (socket.destroyed) return reject(new Error('SMTP: соединение закрыто'));
    if (socket.write(s)) return resolve();
    const done = (err) => { socket.off('drain', onDrain); socket.off('close', onClose); err ? reject(err) : resolve(); };
    const onDrain = () => done();
    const onClose = () => done(new Error('SMTP: соединение закрыто'));
    socket.once('drain', onDrain);
    socket.once('close', onClose);
  });
  const boundary = 'gg-' + crypto.randomBytes(12).toString('hex');
  const domain = addr(from).split('@')[1] || 'localhost';
  const head = [
    'From: ' + from,
    'To: ' + to.join(', '),
    replyTo ? 'Reply-To: ' + replyTo : '',
    'Subject: ' + encodeHeader(subject),
    'Date: ' + date.toUTCString().replace('GMT', '+0000'),
    'Message-ID: <' + crypto.randomUUID() + '@' + domain + '>',
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="' + boundary + '"',
  ].filter(Boolean);
  // Точка в начале строки удваивается (в base64 и границах частей её не бывает)
  await put((head.join('\r\n') + '\r\n\r\n--' + boundary + '\r\n'
    + 'Content-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n'
    + b64lines(Buffer.from(text))).replace(/^\./gm, '..'));
  for (const a of attachments) {
    await put('--' + boundary + '\r\n'
      + 'Content-Type: application/octet-stream; name*=' + fileParam(a.name) + '\r\n'
      + 'Content-Transfer-Encoding: base64\r\n'
      + 'Content-Disposition: attachment; filename*=' + fileParam(a.name) + '\r\n\r\n');
    let rest = Buffer.alloc(0);
    for await (const chunk of a.blob.stream()) {
      const buf = rest.length ? Buffer.concat([rest, chunk]) : Buffer.from(chunk);
      const cut = buf.length - (buf.length % 57); // 57 байт = строка base64 из 76 знаков
      if (cut) await put(b64lines(buf.subarray(0, cut)));
      rest = buf.subarray(cut);
    }
    if (rest.length) await put(b64lines(rest));
  }
  await put('--' + boundary + '--\r\n');
}

// Чтение ответов сервера: многострочный ответ заканчивается строкой «код пробел текст»
class Conn {
  constructor(socket, timeoutMs) {
    this.timeoutMs = timeoutMs;
    this.ready = [];
    this.waiters = [];
    this.lines = [];
    this.buf = '';
    this.attach(socket);
  }

  attach(socket) {
    if (this.socket) this.socket.removeAllListeners('data');
    this.socket = socket;
    socket.on('data', (d) => this.onData(d));
    socket.on('error', (e) => this.fail(e));
    socket.on('close', () => this.fail(new Error('SMTP: соединение закрыто')));
  }

  onData(d) {
    this.buf += d.toString('utf8');
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).replace(/\r$/, '');
      this.buf = this.buf.slice(i + 1);
      this.lines.push(line);
      if (/^\d{3}(?: |$)/.test(line)) {
        const resp = { code: Number(line.slice(0, 3)), lines: this.lines };
        this.lines = [];
        const w = this.waiters.shift();
        if (w) w.resolve(resp); else this.ready.push(resp);
      }
    }
  }

  fail(err) {
    this.closed = err;
    this.waiters.splice(0).forEach((w) => w.reject(err));
  }

  read() {
    if (this.ready.length) return Promise.resolve(this.ready.shift());
    if (this.closed) return Promise.reject(this.closed);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('SMTP: нет ответа сервера')), this.timeoutMs);
      this.waiters.push({ resolve: (v) => { clearTimeout(t); resolve(v); }, reject: (e) => { clearTimeout(t); reject(e); } });
    });
  }

  // label — что писать в ошибке вместо команды (пароль в журнал не попадает)
  async cmd(line, expect, label = line.split(' ')[0]) {
    if (line !== null) this.socket.write(line + '\r\n');
    const r = await this.read();
    if (!expect.includes(r.code)) throw new Error(`SMTP ${label}: ${r.code} ${r.lines.at(-1).slice(4)}`);
    return r;
  }
}

const connect = (fn, timeoutMs) => new Promise((resolve, reject) => {
  const s = fn();
  const t = setTimeout(() => { s.destroy(); reject(new Error('SMTP: не удалось подключиться')); }, timeoutMs);
  s.once(s instanceof tls.TLSSocket ? 'secureConnect' : 'connect', () => { clearTimeout(t); resolve(s); });
  s.once('error', (e) => { clearTimeout(t); reject(e); });
});

/**
 * Отправка письма. secure — SSL с первого байта (по умолчанию для порта 465);
 * иначе соединение поднимается до TLS командой STARTTLS. requireTLS=false разрешает
 * авторизацию без шифрования — только для тестов на локальном поддельном сервере.
 */
export async function sendMail({
  host, port = 465, secure = Number(port) === 465, requireTLS = true, user, pass,
  from, to, replyTo, subject, text, attachments = [], timeoutMs = 20000, deadlineMs = 60000, tlsOptions = {}, ehloName = 'grosgroup-lead',
}) {
  const recipients = (Array.isArray(to) ? to : String(to).split(',')).map((x) => x.trim()).filter(Boolean);
  if (!host || !from || !recipients.length) throw new Error('SMTP: не заданы сервер, отправитель или получатели');
  const raw = await connect(() => (secure
    ? tls.connect({ host, port: Number(port), servername: host, ...tlsOptions })
    : net.connect({ host, port: Number(port) })), timeoutMs);
  const c = new Conn(raw, timeoutMs);
  // Общий срок на всё письмо: медленный сервер не держит заявку дольше deadlineMs
  const deadline = setTimeout(() => c.socket.destroy(new Error('SMTP: превышен общий срок отправки')), deadlineMs);
  try {
    await c.cmd(null, [220], 'приветствие');
    let ehlo = await c.cmd('EHLO ' + ehloName, [250]);
    let encrypted = secure;
    if (!secure && ehlo.lines.some((l) => /^250[- ]STARTTLS/i.test(l))) {
      await c.cmd('STARTTLS', [220]);
      const up = await connect(() => tls.connect({ socket: raw, servername: host, ...tlsOptions }), timeoutMs);
      c.attach(up);
      encrypted = true;
      ehlo = await c.cmd('EHLO ' + ehloName, [250]);
    }
    if (user) {
      if (!encrypted && requireTLS) throw new Error('SMTP: сервер не поддерживает шифрование, пароль не отправлен');
      await c.cmd('AUTH PLAIN ' + Buffer.from('\0' + user + '\0' + pass).toString('base64'), [235], 'AUTH');
    }
    await c.cmd(`MAIL FROM:<${addr(from)}>`, [250]);
    for (const r of recipients) await c.cmd(`RCPT TO:<${addr(r)}>`, [250, 251]);
    await c.cmd('DATA', [354]);
    await writeMessage(c.socket, { from, to: recipients, replyTo, subject, text, attachments });
    if (c.closed) throw c.closed;
    // Письмо заканчивается строкой из одной точки
    await c.cmd('.', [250], 'DATA');
    await c.cmd('QUIT', [221]).catch(() => {});
  } finally {
    clearTimeout(deadline);
    c.socket.end();
  }
}
