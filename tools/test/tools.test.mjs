// Тесты утилит запуска на временной копии сайта: node --test tools/test/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cp, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const tool = (name) => path.join(repo, 'tools', name);
const copy = async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'gg-site-'));
  await cp(repo, dir, { recursive: true, filter: (src) => !/[\\/](\.git|node_modules)$/.test(src) });
  return dir;
};
const run = (name, ...args) => spawnSync(process.execPath, [tool(name), ...args], { encoding: 'utf8' });

test('set-domain: адреса, <base> страницы 404, домен в deploy; повторный запуск ничего не меняет', async () => {
  const dir = await copy();
  const before = await readFile(path.join(dir, 'index.html'), 'utf8');
  const dry = run('set-domain.mjs', 'https://example.ru', '--dry-run', '--root', dir);
  assert.equal(dry.status, 0, dry.stderr);
  assert.equal(await readFile(path.join(dir, 'index.html'), 'utf8'), before, '--dry-run не пишет');

  const r = run('set-domain.mjs', 'https://example.ru', '--root', dir);
  assert.equal(r.status, 0, r.stderr);
  const index = await readFile(path.join(dir, 'index.html'), 'utf8');
  assert.ok(index.includes('<link rel="canonical" href="https://example.ru/">'));
  assert.ok(index.includes('content="https://example.ru/assets/img/og.jpg"'));
  assert.ok(!index.includes('github.io'));
  assert.ok((await readFile(path.join(dir, '404.html'), 'utf8')).includes('<base href="/">'));
  assert.ok((await readFile(path.join(dir, 'robots.txt'), 'utf8')).includes('Sitemap: https://example.ru/sitemap.xml'));
  assert.ok((await readFile(path.join(dir, 'privacy.html'), 'utf8')).includes('href="https://example.ru/privacy.html"'));
  const nginx = await readFile(path.join(dir, 'deploy/nginx.conf'), 'utf8');
  assert.ok(nginx.includes('server_name example.ru www.example.ru;'));
  assert.ok(nginx.includes('/etc/letsencrypt/live/example.ru/fullchain.pem'));
  assert.ok(nginx.includes('zone=grosgroup_lead') && nginx.includes('root /var/www/grosgroup;'), 'имена зоны и каталога не тронуты');
  assert.ok((await readFile(path.join(dir, 'deploy/apache.htaccess'), 'utf8')).includes('RewriteRule ^ https://example.ru%{REQUEST_URI}'));

  const again = run('set-domain.mjs', 'https://example.ru/', '--root', dir);
  assert.match(again.stdout, /замен 0\./);
  assert.equal(run('set-domain.mjs', 'http://example.ru', '--root', dir).status, 2, 'только https');
  await rm(dir, { recursive: true });
});

test('prelaunch-check: блокеры в прототипе; после заполнения — код 0', async () => {
  const dir = await copy();
  const r = run('prelaunch-check.mjs', '--root', dir);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /\[ИНН\]/);
  assert.match(r.stdout, /CONFIG\.endpoint пуст/);
  assert.equal(run('prelaunch-check.mjs', '--report', '--root', dir).status, 0);

  execFileSync(process.execPath, [tool('set-domain.mjs'), 'https://grosgroup.ru', '--root', dir]);
  const fill = { '[НАИМЕНОВАНИЕ]': 'ООО «Тест»', '[ИНН]': '4000000000', '[ОГРН]': '1234000000000', '[ЮРИДИЧЕСКИЙ АДРЕС]': 'Калуга', '[ХОСТИНГ-ПРОВАЙДЕР]': 'Хостинг', '[ПОЧТОВЫЙ СЕРВИС]': 'Почта' };
  for (const f of ['index.html', 'privacy.html', 'consent.html']) {
    let t = await readFile(path.join(dir, f), 'utf8');
    for (const [k, v] of Object.entries(fill)) t = t.split(k).join(v);
    t = t.replace(/<p class="doc__draft" data-draft>.*?<\/p>/, '').replace(/href="#" data-todo="vent-url"/, 'href="https://vent.example.ru"');
    await writeFile(path.join(dir, f), t);
  }
  const jsFile = path.join(dir, 'assets/js/main.js');
  await writeFile(jsFile, (await readFile(jsFile, 'utf8')).replace("endpoint: '',", "endpoint: '/api/lead',"));
  await rm(path.join(dir, 'roy'), { recursive: true });
  const done = run('prelaunch-check.mjs', '--root', dir);
  assert.equal(done.status, 0, done.stdout);

  // Правка встроенного скрипта без обновления CSP — блокер
  const idx = path.join(dir, 'index.html');
  await writeFile(idx, (await readFile(idx, 'utf8')).replace("classList.add('js');", "classList.add('js'); "));
  const csp = run('prelaunch-check.mjs', '--root', dir);
  assert.equal(csp.status, 1);
  assert.match(csp.stdout, /deploy\/nginx\.conf: в CSP нет хэша/);
  await rm(dir, { recursive: true });
});
