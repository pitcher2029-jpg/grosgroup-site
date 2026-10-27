#!/usr/bin/env node
// Проверка готовности к запуску: что ещё не заполнено и что разойдётся на боевом сервере.
// Запуск: node tools/prelaunch-check.mjs [--report] [--root каталог]
// Код выхода 1 — есть блокеры; с --report всегда 0 (только список).
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const report = args.includes('--report');
const rootIdx = args.indexOf('--root');
const root = rootIdx >= 0 ? path.resolve(args[rootIdx + 1]) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const has = (f) => existsSync(path.join(root, f));
const read = async (f) => (has(f) ? readFile(path.join(root, f), 'utf8') : '');

const blockers = [];
const warnings = [];
const ok = [];
const block = (s) => blockers.push(s);
const warn = (s) => warnings.push(s);

// Комментарии HTML заменяются пробелами с сохранением переносов, чтобы номера строк остались верными
const stripComments = (html) => html.replace(/<!--[\s\S]*?-->/g, (c) => c.replace(/[^\n]/g, ' '));
const lineOf = (text, idx) => text.slice(0, idx).split('\n').length;
const findAll = (text, re) => [...text.matchAll(re)].map((m) => ({ s: m[0], line: lineOf(text, m.index) }));

const pages = ['index.html', 'privacy.html', 'consent.html', '404.html'];
const html = Object.fromEntries(await Promise.all(pages.map(async (f) => [f, await read(f)])));
const js = await read('assets/js/main.js');

// 1. Адрес сайта
const canonical = /<link rel="canonical" href="([^"]+)">/.exec(html['index.html'])?.[1] || '';
if (!canonical) block('index.html: нет <link rel="canonical">');
else if (canonical.includes('github.io')) block(`адрес сайта ещё ${canonical} — node tools/set-domain.mjs https://<домен>`);
else ok.push('адрес сайта: ' + canonical);
for (const f of ['robots.txt', 'sitemap.xml', 'privacy.html', 'consent.html']) {
  const text = await read(f);
  if (canonical && text && !text.includes(canonical)) warn(`${f}: не содержит ${canonical} — запустите tools/set-domain.mjs ещё раз`);
}

// 2. Заглушки в квадратных скобках, плашки черновика, ссылки без адреса
for (const f of pages) {
  const text = stripComments(html[f]);
  const holes = findAll(text, /\[[А-ЯЁ][А-ЯЁ -]+\]/g);
  if (holes.length) block(`${f}: не заполнено ${holes.length} — ${[...new Set(holes.map((h) => h.s))].join(', ')} (строки ${[...new Set(holes.map((h) => h.line))].join(', ')})`);
  for (const d of findAll(text, /data-draft/g)) block(`${f}:${d.line}: плашка «Черновик — требует проверки юристом»; убрать после проверки`);
  for (const t of findAll(text, /data-todo="([^"]+)"/g)) block(`${f}:${t.line}: ссылка без адреса ${t.s}`);
}

// 3. Настройки main.js
const cfg = (key) => new RegExp(key + ":\\s*'([^']*)'").exec(js)?.[1];
if (!cfg('endpoint')) block("assets/js/main.js: CONFIG.endpoint пуст — заявки не отправляются (нужно '/api/lead')");
else ok.push('приём заявок: ' + cfg('endpoint'));
if (!cfg('metrikaId')) warn('assets/js/main.js: CONFIG.metrikaId пуст — Метрики и окна о cookie не будет');
else ok.push('Метрика: ' + cfg('metrikaId'));
if (!/name="yandex-verification"/.test(html['index.html'])) warn('index.html: нет <meta name="yandex-verification"> для Яндекс Вебмастера');

// 4. Прототип ROY
if (has('roy')) block('каталог roy/ — прототип для сравнения; удалить перед запуском (git rm -r roy)');
if (/Disallow:\s*\/roy\//.test(await read('robots.txt'))) warn('robots.txt: строка Disallow: /roy/ больше не нужна после удаления roy/');

// 5. CSP: хэш встроенного скрипта index.html совпадает с конфигурациями сервера
const inline = [...html['index.html'].matchAll(/<script(?![^>]*\bsrc=)(?![^>]*ld\+json)[^>]*>([\s\S]*?)<\/script>/g)]
  .map((m) => "'sha256-" + crypto.createHash('sha256').update(m[1]).digest('base64') + "'");
for (const f of ['deploy/nginx.conf', 'deploy/apache.htaccess']) {
  const conf = await read(f);
  if (!conf) { warn(`${f}: нет файла`); continue; }
  const missing = inline.filter((h) => !conf.includes(h));
  if (missing.length) block(`${f}: в CSP нет хэша встроенного скрипта ${missing.join(' ')} — скрипт в <head> менялся`);
  else ok.push(`${f}: хэш CSP совпадает`);
}

// 6. Файлы, на которые ссылается разметка
if (!has('assets/img/og.jpg')) block('нет assets/img/og.jpg — превью для соцсетей');
for (const f of ['robots.txt', 'sitemap.xml', '404.html', 'privacy.html', 'consent.html']) if (!has(f)) block('нет ' + f);
const base404 = /<base href="([^"]+)">/.exec(html['404.html'])?.[1];
if (canonical && base404 && base404 !== new URL(canonical).pathname) block(`404.html: <base href="${base404}"> не совпадает с путём сайта ${new URL(canonical).pathname}`);

// Вывод
const out = [];
out.push(`Проверка готовности: ${root}`);
if (blockers.length) out.push('', `Блокеры (${blockers.length}):`, ...blockers.map((s) => '  ✗ ' + s));
if (warnings.length) out.push('', `Предупреждения (${warnings.length}):`, ...warnings.map((s) => '  ! ' + s));
if (ok.length) out.push('', 'В порядке:', ...ok.map((s) => '  ✓ ' + s));
out.push('', 'Не проверяется автоматически — см. LAUNCH.md:',
  '  · тексты политики и согласия проверены юристом',
  '  · уведомление Роскомнадзора об обработке ПДн подано',
  '  · лицензия шрифта Cy Grotesk на сайт',
  '  · факты на сайте подтверждены заказчиком; тестовая заявка дошла до получателя',
  '  · проверка на настоящих iPhone и Android');
console.log(out.join('\n'));
process.exit(blockers.length && !report ? 1 : 0);
