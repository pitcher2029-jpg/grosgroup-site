# GROSGROUP — прототип лендинга

Статический прототип сайта GROSGROUP (поставки инструмента, расходников и оборудования для производств).
HTML/CSS/JS без сборки: откройте `index.html` или любой статический сервер.

## Варианты для сравнения
- Текущая редакция: https://pitcher2029-jpg.github.io/grosgroup-site/
- Прототип от ROY (редизайн, один самодостаточный файл): https://pitcher2029-jpg.github.io/grosgroup-site/roy/ — `roy/index.html`

## Структура
- `index.html` — разметка страницы
- `assets/css/style.css` — стили и токены дизайна (CSS custom properties)
- `assets/js/main.js` — меню, подсветка разделов, появление блоков при прокрутке (`data-r`, `data-stagger`), форма заявки
- `assets/img/` — изображения (WebP), `assets/fonts/` — шрифты (WOFF2)

## Прототип: что не подключено
- Отправка заявки имитируется. Адрес приёма — `CONFIG.endpoint` в `assets/js/main.js` (POST multipart/form-data);
  обработчик — `server/` (см. `server/README.md`).
- Ссылка `data-todo="vent-url"` ждёт адреса сайта проекта вентиляции.
- Раздел «Кейсы» скрыт (`hidden`, пункта меню нет); как включить и шаблон списка — в комментарии раздела.
- Реквизиты оператора ПДн — в квадратных скобках; политика и согласие — черновики для юриста.

Порядок запуска, что нужно от заказчика и проверка готовности — `LAUNCH.md`, `node tools/prelaunch-check.mjs`.

## Проверки
- `node --test server/test/*.test.mjs tools/test/*.test.mjs`

## Шрифты (по ТЗ)
- Логотип GROSGROUP в шапке — Arimo Bold (SIL OFL 1.1, `assets/fonts/arimo-latin-700-normal.woff2`).
- Весь остальной текст — Cy Grotesk Std Wide (Maksym Kobuzan, коммерческий, продаётся на MyFonts; для сайта нужна webfont-лицензия).
  Пока лицензии нет, работает замена Unbounded (SIL OFL 1.1); если Cy Grotesk Std Wide установлен на компьютере, браузер возьмёт его.
- Подключение купленного шрифта: положить файлы `cy-grotesk-std-wide-regular.woff2`, `-bold.woff2`, `-black.woff2`
  в `assets/fonts/` и раскомментировать блок `@font-face` в начале `assets/css/style.css`.

## Цвета (по ТЗ)
- Фон всех страниц — `#faf9f7`, плашки иконок и карточек — `#efeae8` (`--c-bg`, `--c-surface` в `style.css`).
- Секции чередуются: светлые на `#faf9f7` и затенённые `#efeae8` (класс `sec--shade`); в затенённых карточки и фото лежат на светлых плашках.
