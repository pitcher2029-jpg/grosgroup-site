# Запуск сайта GROSGROUP

Порядок перевода прототипа в боевой сайт. Готовность проверяет `node tools/prelaunch-check.mjs`:
код 0 — блокеров нет; `--report` — только список.

## 1. Что нужно от заказчика

| Что | Куда |
|---|---|
| Домен (например `grosgroup.ru`) | `node tools/set-domain.mjs https://grosgroup.ru` |
| Реквизиты оператора ПДн: наименование, ИНН, ОГРН, юридический адрес | `[НАИМЕНОВАНИЕ]`, `[ИНН]`, `[ОГРН]`, `[ЮРИДИЧЕСКИЙ АДРЕС]` в `index.html`, `privacy.html`, `consent.html` |
| Хостинг и почтовый сервис (названия компаний) | `[ХОСТИНГ-ПРОВАЙДЕР]`, `[ПОЧТОВЫЙ СЕРВИС]` в `privacy.html`, п. 5.2 |
| Канал заявок: ящик-отправитель и пароль приложения, получатели; или CRM | `/etc/grosgroup-lead.env` на сервере (`deploy/grosgroup-lead.env.example`) |
| Номер счётчика Яндекс Метрики | `CONFIG.metrikaId` в `assets/js/main.js` |
| Код подтверждения Яндекс Вебмастера | `<meta name="yandex-verification" content="…">` в `<head>` `index.html` |
| Адрес сайта проекта вентиляции | ссылка `data-todo="vent-url"` в `index.html`: `href` = адрес, атрибут `data-todo` удалить |
| Кейсы: отрасль и город клиента, задача, решение, срок | список `.cases__list` в `index.html` — инструкция в комментарии раздела |
| Настоящие фотографии (по желанию) | `assets/img/`, те же имена или правка `src` |

Пароли и токены в репозиторий не попадают — только в файл окружения на сервере с правами 600.

## 2. Юридическое (152-ФЗ) — за заказчиком и юристом

1. Юрист проверяет `privacy.html` и `consent.html`; после проверки удалить плашки `<p class="doc__draft" data-draft>`
   и поставить дату редакции.
2. До начала сбора заявок — уведомление Роскомнадзора об обработке ПДн (ст. 22 152-ФЗ), форма на pd.rkn.gov.ru.
3. Данные граждан России хранятся на серверах в России (ч. 5 ст. 18): сервер обработчика и почта — у российских провайдеров.
4. **Telegram — трансграничная передача ПДн.** Включать `TG_BOT_TOKEN` только после отдельного уведомления
   Роскомнадзора о трансграничной передаче (ст. 12) и правки п. 5.3 политики. Без этого — почта и CRM.
5. Согласие — отдельный документ (`consent.html`) и отдельная галочка в форме; так и должно остаться.
6. Шрифт Cy Grotesk Std Wide — коммерческий: до покупки webfont-лицензии сайт работает на замене Unbounded (README.md).

## 3. Подготовка файлов

```sh
git switch launch
node tools/set-domain.mjs https://grosgroup.ru --dry-run   # что изменится
node tools/set-domain.mjs https://grosgroup.ru
git rm -r roy                                              # прототип для сравнения
# robots.txt: удалить строку «Disallow: /roy/»
# assets/js/main.js: CONFIG.endpoint = '/api/lead', CONFIG.metrikaId = '<номер>'
# заполнить скобки, убрать плашки черновика, вставить код Вебмастера и адрес проекта вентиляции
node tools/prelaunch-check.mjs                             # код 0 — можно выкладывать
node --test server/test/*.test.mjs tools/test/*.test.mjs
```

Если менялся встроенный скрипт в `<head>` `index.html`, проверка сообщит новый хэш — вписать его в CSP
`deploy/nginx.conf` и `deploy/apache.htaccess`.

## 4. Выкладка на VPS (nginx + Node.js 22)

Рекомендуемый вариант: сайт и обработчик заявок на одном сервере.

```sh
# сайт — только публичные файлы
rsync -a --delete index.html 404.html privacy.html consent.html robots.txt sitemap.xml assets /var/www/grosgroup/
# обработчик заявок
install -d /opt/grosgroup-lead && cp server/*.mjs /opt/grosgroup-lead/
install -m 600 deploy/grosgroup-lead.env.example /etc/grosgroup-lead.env   # заполнить
cp deploy/grosgroup-lead.service /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now grosgroup-lead
# сертификат — до включения конфига (nginx -t без файлов сертификата не пройдёт); хуки сохраняются для продления
certbot certonly --standalone --pre-hook "systemctl stop nginx" --post-hook "systemctl start nginx" -d grosgroup.ru -d www.grosgroup.ru
# nginx
cp deploy/nginx.conf /etc/nginx/sites-available/grosgroup && ln -s ../sites-available/grosgroup /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
```

Резервные копии заявок — `/var/lib/grosgroup-lead/leads.jsonl` и `files/`; журнал — `journalctl -u grosgroup-lead`.
Строка `DELIVERY_FAILED` в журнале — заявка не дошла ни по одному каналу и лежит только в резервной копии.
Резервная копия чистится сама: заявки старше 395 дней (12 месяцев по п. 4.3 политики + 30 дней) удаляются
при запуске службы и раз в сутки. Письма с заявками в ящике `MAIL_TO` и сообщения в CRM заказчик удаляет
по тому же сроку сам — сервер к ним доступа не имеет.

### Вариант: виртуальный хостинг

Статика — на хостинге с `deploy/apache.htaccess` (переименовать в `.htaccess`). Node.js там обычно нет,
поэтому обработчик — на отдельном VPS: `CONFIG.endpoint` — полный адрес обработчика, в его окружении
`ALLOW_ORIGIN=https://grosgroup.ru`, адрес обработчика — в `connect-src` CSP `.htaccess`.

## 5. После выкладки

1. Открыть сайт, отправить тестовую заявку с файлом — письмо пришло, в `leads.jsonl` есть строка.
2. Метрика: «Принять» в окне о cookie → визит виден в отчёте «В реальном времени». Цели типа «JavaScript-событие»
   с идентификаторами `lead` (заявка отправлена), `tel` (клик по телефону), `mail` (клик по почте).
3. Яндекс Вебмастер: подтвердить права, добавить `https://grosgroup.ru/sitemap.xml`.
4. Проверить заголовки: `curl -sI https://grosgroup.ru | grep -i -E 'content-security|strict-transport'`;
   консоль браузера без ошибок CSP.
5. Превью ссылки: отправить адрес в мессенджер — картинка `og.jpg` и заголовок на месте.
6. Настоящие iPhone (Safari) и Android (Chrome): меню, форма, выбор файлов, окно о cookie.
