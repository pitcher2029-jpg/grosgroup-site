#!/usr/bin/env node
// Переносит сайт на боевой адрес: canonical, og:url, og:image, sitemap, robots, <base> страницы 404, домен в deploy/.
// Запуск: node tools/set-domain.mjs https://grosgroup.ru [--dry-run] [--root каталог]
// Повторный запуск безопасен: текущий адрес берётся из canonical в index.html.
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const dry = args.includes('--dry-run');
const rootIdx = args.indexOf('--root');
const root = rootIdx >= 0 ? path.resolve(args[rootIdx + 1]) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--root');

const fail = (msg) => { console.error('Ошибка: ' + msg); process.exit(2); };
if (!target) fail('укажите адрес: node tools/set-domain.mjs https://grosgroup.ru [--dry-run]');
let url;
try { url = new URL(target); } catch { fail('не адрес: ' + target); }
if (url.protocol !== 'https:') fail('нужен https://');
if (url.search || url.hash) fail('адрес без ? и #');
const base = url.origin + url.pathname.replace(/\/?$/, '/');
const host = url.hostname;

const read = (f) => readFile(path.join(root, f), 'utf8');
const index = await read('index.html');
const m = /<link rel="canonical" href="([^"]+)">/.exec(index);
if (!m) fail('в index.html нет <link rel="canonical">');
const oldBase = m[1];
const oldPath = new URL(oldBase).pathname;
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// [файл, [регулярное выражение, замена]…]
const plan = [
  ...['index.html', 'privacy.html', 'consent.html', 'robots.txt', 'sitemap.xml'].map((f) => [f, [[new RegExp(escape(oldBase), 'g'), base]]]),
  ['404.html', [[new RegExp('<base href="' + escape(oldPath) + '">'), `<base href="${url.pathname.replace(/\/?$/, '/')}">`]]],
];
// Домен в конфигурациях сервера: текущий берётся из server_name в nginx.conf
if (existsSync(path.join(root, 'deploy/nginx.conf'))) {
  const nginx = await read('deploy/nginx.conf');
  const cur = /server_name\s+([^\s;]+)\s+www\./.exec(nginx);
  if (cur && cur[1] !== host) {
    const re = new RegExp('(?<![\\w-])' + escape(cur[1]) + '(?![\\w-])', 'g');
    plan.push(['deploy/nginx.conf', [[re, host]]], ['deploy/apache.htaccess', [[re, host]]]);
  }
}

let total = 0;
for (const [file, rules] of plan) {
  if (!existsSync(path.join(root, file))) { console.log(`  ${file}: нет файла, пропущен`); continue; }
  let text = await read(file);
  let n = 0;
  for (const [re, to] of rules) text = text.replace(re, (s) => { if (s !== to) n++; return to; });
  total += n;
  console.log(`  ${file}: замен ${n}`);
  if (n && !dry) await writeFile(path.join(root, file), text);
}
console.log(`${dry ? 'Проверка без записи' : 'Готово'}: ${oldBase} → ${base}, замен ${total}.`);
if (!dry && host !== 'pitcher2029-jpg.github.io') console.log('Дальше: node tools/prelaunch-check.mjs');
