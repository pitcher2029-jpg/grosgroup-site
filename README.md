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

## Шрифты
Unbounded и Onest — SIL Open Font License 1.1.
