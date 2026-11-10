<?php
// Настройки обработчика заявок api/lead.php. Положить ВНЕ корня сайта: <каталог над корнем сайта>/grosgroup-lead/config.php
// (на reg.ru корень сайта — www/grosgroup.ru, значит файл — www/grosgroup-lead/config.php), права 600.
// Пароли и токен в репозиторий не попадают: этот файл — образец, рабочий создаётся на хостинге.
return [
  // Резервная копия заявок и файлов (JSONL + files/<номер>); вне корня сайта, хранится 395 дней
  'store_dir' => __DIR__ . '/data',

  'mail' => [
    // 'mail' — sendmail хостинга (SPF домена разрешает сервер хостинга); 'smtp' — через ящик на домене
    'transport' => 'mail',
    'to' => 'buy@grosgroup.ru',                   // несколько адресов — через запятую
    'from' => 'noreply@grosgroup.ru',
    'from_name' => 'Сайт GROSGROUP',
    // для 'smtp':
    // 'host' => 'mail.hosting.reg.ru', 'port' => 465, 'secure' => true,
    // 'user' => 'buy@grosgroup.ru', 'pass' => '<пароль ящика>', 'from' => 'buy@grosgroup.ru',
  ],

  // Дубль заявки в Telegram. 'notice' — номер заявки без персональных данных;
  // 'full' — текст заявки и файлы (это трансграничная передача ПДн: нужны п. 5.3 политики и уведомление РКН)
  'telegram' => [
    'token' => '<токен бота от @BotFather>',
    'chat_id' => '<id чата>',
    'mode' => 'notice',
  ],
];
