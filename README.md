# GROSGROUP — прототип лендинга

Статический прототип сайта GROSGROUP (поставки инструмента, расходников и оборудования для производств).
HTML/CSS/JS без сборки: откройте `index.html` или любой статический сервер.

## Структура
- `index.html` — разметка страницы
- `assets/css/style.css` — стили и токены дизайна (CSS custom properties)
- `assets/js/main.js` — меню, подсветка разделов, форма заявки
- `assets/img/` — изображения (WebP), `assets/fonts/` — шрифты (WOFF2)

## Прототип: что не подключено
- Отправка заявки имитируется. Адрес приёма — `CONFIG.endpoint` в `assets/js/main.js` (POST multipart/form-data).
- Ссылки с `data-todo` ждут адресов: сайт проекта вентиляции (`vent-url`), политика обработки ПДн (`privacy`).
- Раздел «Кейсы» — заглушка до получения материалов.

## Шрифты (по ТЗ)
- Логотип GROSGROUP в шапке — Arimo Bold (SIL OFL 1.1, `assets/fonts/arimo-latin-700-normal.woff2`).
- Весь остальной текст — Cy Grotesk Std Wide (Maksym Kobuzan, коммерческий, продаётся на MyFonts; для сайта нужна webfont-лицензия).
  Пока лицензии нет, работает замена Unbounded (SIL OFL 1.1); если Cy Grotesk Std Wide установлен на компьютере, браузер возьмёт его.
- Подключение купленного шрифта: положить файлы `cy-grotesk-std-wide-regular.woff2`, `-bold.woff2`, `-black.woff2`
  в `assets/fonts/` и раскомментировать блок `@font-face` в начале `assets/css/style.css`.

## Цвета (по ТЗ)
- Фон всех страниц — `#faf9f7`, плашки иконок и карточек — `#efeae8` (`--c-bg`, `--c-surface` в `style.css`).
