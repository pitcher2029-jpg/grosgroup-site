<?php
// GROSGROUP — приём заявки с сайта на виртуальном хостинге (PHP 8.1+): проверка полей, антиспам,
// доставка (почта, Telegram) и резервная копия на диск. Перенос server/lead.mjs: те же поля, правила и ответы JSON.
// Настройки — PHP-файл вне корня сайта (образец: deploy/lead-config.example.php), путь — GG_LEAD_CONFIG
// или <каталог над корнем сайта>/grosgroup-lead/config.php.
declare(strict_types=1);

const GG_MAX_FILES = 5;
const GG_MAX_FILE = 10 * 1024 * 1024;
const GG_MAX_TOTAL = 15 * 1024 * 1024;   // вложения в base64 ≈ 20,5 МБ — письмо проходит в Gmail (25 МБ)
const GG_MAX_BODY = 16 * 1024 * 1024;    // файлы + поля и разметка multipart
const GG_MIN_FILL_MS = 3000;             // быстрее человек форму не заполнит
const GG_RATE_COUNT = 8;                 // запросов с одного IP за окно
const GG_RATE_WINDOW = 600;
const GG_CHANNEL_TIMEOUT = 30;           // каждый канал целиком, с файлами
const GG_TG_TIMEOUT = 10;                // Telegram без файлов: из России api.telegram.org бывает медленным
const GG_DAY_BYTES = 1024 * 1024 * 1024; // файлов в сутки на все заявки; сверх — заявка без вложений
const GG_NAME_BYTES = 150;               // имя файла в письме и журнале, байт UTF-8
const GG_RETENTION_DAYS = 395;           // резервная копия: 12 месяцев по политике + запас на уничтожение
const GG_EXT = ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'csv', 'txt', 'png', 'jpg', 'jpeg', 'dwg', 'zip'];

function gg_respond(int $status, array $body): never {
  http_response_code($status);
  header('Content-Type: application/json; charset=utf-8');
  header('Cache-Control: no-store');
  echo json_encode($body, JSON_UNESCAPED_UNICODE);
  exit;
}
function gg_fail(int $status, string $error, array $extra = []): never {
  gg_respond($status, ['ok' => false, 'error' => $error] + $extra);
}
function gg_log(string $msg): void { error_log('[lead] ' . $msg); }

// Строка из формы без управляющих символов; $line — однострочное поле: переводы строк и табуляция → пробел
function gg_str($v, int $max, bool $line = false): string {
  if (!is_string($v)) return '';
  $s = mb_scrub($v, 'UTF-8');
  $s = $line ? preg_replace('/[\x00-\x1f\x7f]+/', ' ', $s) : preg_replace('/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]+/', '', $s);
  return mb_substr(trim($s), 0, $max, 'UTF-8');
}
function gg_phone(string $v): string {
  $d = preg_replace('/\D/', '', $v);
  if (strlen($d) === 11 && $d[0] === '8') $d = '7' . substr($d, 1);
  if (strlen($d) !== 11 || $d[0] !== '7') return '';
  return sprintf('+7 (%s) %s-%s-%s', substr($d, 1, 3), substr($d, 4, 3), substr($d, 7, 2), substr($d, 9));
}
// Имя файла без путей и управляющих символов; длинное укорачивается до GG_NAME_BYTES байт с сохранением расширения
function gg_safe_name(string $name): string {
  $parts = preg_split('/[\\\\\/]/', mb_scrub($name, 'UTF-8'));
  $clean = trim(preg_replace('/[\x00-\x1f\x7f"<>|:*?]/', '_', end($parts)));
  if ($clean === '') $clean = 'file';
  if (strlen($clean) <= GG_NAME_BYTES) return $clean;
  $p = strrpos($clean, '.');
  $ext = $p !== false && $p > 0 && strlen($clean) - $p <= 11 ? substr($clean, $p) : '';
  return mb_strcut($clean, 0, GG_NAME_BYTES - strlen($ext), 'UTF-8') . $ext;
}
function gg_ext(string $name): string {
  $p = strrpos($name, '.');
  return $p === false ? '' : strtolower(substr($name, $p + 1));
}
function gg_ini_bytes(string $v): int {
  $n = (int) $v;
  return match (strtolower(substr(trim($v), -1))) { 'g' => $n << 30, 'm' => $n << 20, 'k' => $n << 10, default => $n };
}

/** Файлы из $_FILES['files'] в виде [{ name, size, tmp, error }] без пустых полей выбора. */
function gg_uploads(): array {
  $f = $_FILES['files'] ?? null;
  if (!$f) return [];
  $list = [];
  foreach ((array) $f['name'] as $i => $name) {
    if (!is_string($name)) continue;   // files[a][b] — не поле формы сайта
    $err = (int) ((array) $f['error'])[$i];
    if ($err === UPLOAD_ERR_NO_FILE) continue;
    $size = (int) ((array) $f['size'])[$i];
    if ($err === UPLOAD_ERR_OK && $size === 0) continue;
    $list[] = ['name' => gg_safe_name((string) $name), 'size' => $size, 'tmp' => (string) ((array) $f['tmp_name'])[$i], 'error' => $err];
  }
  return $list;
}

function gg_validate(array $p, array $files): array {
  $v = [
    'name' => gg_str($p['name'] ?? null, 80, true),
    'phone' => gg_phone(gg_str($p['phone'] ?? null, 40, true)),
    'email' => gg_str($p['email'] ?? null, 120, true),
    'description' => gg_str($p['description'] ?? null, 3000),
  ];
  $e = [];
  if (!preg_match('/\p{L}.*\p{L}/u', $v['name'])) $e['name'] = 'Укажите имя — хотя бы 2 буквы';
  if ($v['phone'] === '') $e['phone'] = 'Укажите телефон полностью: +7 и 10 цифр';
  if ($v['email'] !== '' && !preg_match('/^[^\s@,;\x00-\x1f\x7f]+@[^\s@,;\x00-\x1f\x7f]+\.[^\s@,;\x00-\x1f\x7f]{2,}$/u', $v['email'])) $e['email'] = 'Проверьте адрес почты';
  if (($p['consent'] ?? null) !== 'yes') $e['consent'] = 'Нужно согласие на обработку персональных данных';
  if (count($files) > GG_MAX_FILES) $e['files'] = 'Не больше ' . GG_MAX_FILES . ' файлов';
  else {
    foreach ($files as $f) {
      $big = $f['error'] === UPLOAD_ERR_INI_SIZE || $f['error'] === UPLOAD_ERR_FORM_SIZE || $f['size'] > GG_MAX_FILE;
      if ($big || $f['error'] !== UPLOAD_ERR_OK || !in_array(gg_ext($f['name']), GG_EXT, true)) {
        $e['files'] = 'Файл ' . $f['name'] . ': до 10 МБ, форматы ' . implode(', ', GG_EXT);
        break;
      }
    }
    if (!isset($e['files']) && array_sum(array_column($files, 'size')) > GG_MAX_TOTAL) $e['files'] = 'Файлы вместе — не больше 15 МБ';
  }
  return [$v, $e];
}

function gg_lead_text(array $lead): string {
  $files = $lead['files'] ? implode(', ', array_map(fn($f) => $f['name'] . ' (' . max(1, (int) round($f['size'] / 1024)) . ' КБ)', $lead['files'])) : 'нет';
  if (!empty($lead['filesDropped'])) $files .= ' — не приложены: суточный предел файлов на сервере исчерпан, попросите клиента прислать их почтой';
  return ltrim(implode("\n", [
    !empty($lead['suspect']) ? "Внимание: {$lead['suspect']} — проверьте, не бот ли это.\n" : '',
    'Новая заявка с сайта GROSGROUP',
    '',
    'Имя: ' . $lead['name'],
    'Телефон: ' . $lead['phone'],
    'Почта: ' . ($lead['email'] ?: '—'),
    'Описание: ' . ($lead['description'] ?: '—'),
    'Файлы: ' . $files,
    '',
    'Согласие на обработку ПДн: да, ' . $lead['consentAt'],
    'Заявка № ' . $lead['id'],
  ]), "\n");
}
// Короткое уведомление без персональных данных: для Telegram, пока перевод ПДн за рубеж не оформлен.
// $where — где искать заявку: зависит от того, ушла ли почта
function gg_notice_text(array $lead, string $where): string {
  return (!empty($lead['suspect']) ? "[проверить] " : '') . 'Новая заявка с сайта GROSGROUP № ' . $lead['id']
    . "\nФайлов: " . count($lead['files']) . "\n" . $where;
}

// ---------- Резервная копия, очистка, ограничение частоты ----------
function gg_locked(string $file, callable $fn) {
  $h = fopen($file, 'c');
  if (!$h) throw new RuntimeException('нет доступа к ' . basename($file));
  try { flock($h, LOCK_EX); return $fn(); } finally { flock($h, LOCK_UN); fclose($h); }
}
function gg_mkdir(string $dir): void {
  if (!is_dir($dir) && !mkdir($dir, 0700, true) && !is_dir($dir)) throw new RuntimeException('каталог не создан');
}
function gg_store(string $dir, array $lead, array $files): void {
  gg_mkdir($dir);
  if ($files) {
    $own = $dir . '/files/' . $lead['id'];
    gg_mkdir($own);
    // На диске — по номеру в заявке (1.pdf, 2.dwg): исходное имя бывает длиннее предела ФС; оно — в leads.jsonl
    foreach ($files as $i => $f) {
      $name = ($i + 1) . '.' . gg_ext($f['name']);
      if (!copy($f['tmp'], $own . '/' . $name)) throw new RuntimeException('файл не сохранён');
      chmod($own . '/' . $name, 0600);
    }
  }
  gg_locked($dir . '/.lock', function () use ($dir, $lead) {
    $line = json_encode($lead, JSON_UNESCAPED_UNICODE) . "\n";
    if (file_put_contents($dir . '/leads.jsonl', $line, FILE_APPEND) === false) throw new RuntimeException('leads.jsonl не записан');
    @chmod($dir . '/leads.jsonl', 0600);
  });
}
/** Удаляет заявки старше $days дней: каталоги files/<номер> и строки leads.jsonl (номер начинается с ГГГГММДД). */
function gg_purge(string $dir, int $days, int $now): int {
  $border = gmdate('Ymd', $now - $days * 86400);
  $old = fn($id) => is_string($id) && preg_match('/^\d{8}-/', $id) && substr($id, 0, 8) < $border;
  $removed = 0;
  foreach (glob($dir . '/files/*', GLOB_ONLYDIR) ?: [] as $d) {
    if (!$old(basename($d))) continue;
    foreach (scandir($d) ?: [] as $f) if (is_file($d . '/' . $f)) unlink($d . '/' . $f);
    @rmdir($d);
    $removed++;
  }
  $jsonl = $dir . '/leads.jsonl';
  if (!is_file($jsonl)) return $removed;
  return $removed + gg_locked($dir . '/.lock', function () use ($jsonl, $old) {
    $lines = array_values(array_filter(explode("\n", (string) file_get_contents($jsonl)), 'strlen'));
    $keep = array_values(array_filter($lines, function ($l) use ($old) { $j = json_decode($l, true); return !(is_array($j) && $old($j['id'] ?? null)); }));
    if (count($keep) === count($lines)) return 0;
    file_put_contents($jsonl . '.tmp', $keep ? implode("\n", $keep) . "\n" : '');
    chmod($jsonl . '.tmp', 0600);
    rename($jsonl . '.tmp', $jsonl);
    return count($lines) - count($keep);
  });
}
// Очистка — не чаще раза в сутки: метка с датой последнего прохода
function gg_purge_daily(string $dir, int $now): void {
  $mark = $dir . '/.purged';
  if (@file_get_contents($mark) === gmdate('Ymd', $now)) return;
  gg_purge($dir, GG_RETENTION_DAYS, $now);
  @file_put_contents($mark, gmdate('Ymd', $now));
}
function gg_rate_limited(string $dir, string $ip, int $now): bool {
  gg_mkdir($dir);
  $file = $dir . '/rate.json';
  return gg_locked($dir . '/.rate.lock', function () use ($file, $ip, $now) {
    $hits = json_decode((string) @file_get_contents($file), true) ?: [];
    foreach ($hits as $k => $list) {
      $hits[$k] = array_values(array_filter($list, fn($t) => $now - $t < GG_RATE_WINDOW));
      if (!$hits[$k]) unset($hits[$k]);
    }
    $key = hash('sha256', $ip);
    $hits[$key][] = $now;
    file_put_contents($file, json_encode($hits));
    return count($hits[$key]) > GG_RATE_COUNT;
  });
}
// Суточный предел объёма файлов на все заявки: бот с разных адресов не забьёт диск хостинга и ящик
function gg_quota_ok(string $dir, int $now, int $bytes, int $limit): bool {
  gg_mkdir($dir);
  return gg_locked($dir . '/.rate.lock', function () use ($dir, $now, $bytes, $limit) {
    $file = $dir . '/quota.json';
    $day = gmdate('Ymd', $now);
    $q = json_decode((string) @file_get_contents($file), true);
    $used = is_array($q) && ($q['day'] ?? '') === $day ? (int) ($q['bytes'] ?? 0) : 0;
    if ($used + $bytes > $limit) return false;
    file_put_contents($file, json_encode(['day' => $day, 'bytes' => $used + $bytes]));
    return true;
  });
}

// ---------- Почта ----------
function gg_mime_header(string $s): string {
  if (!preg_match('/[^\x20-\x7e]/', $s)) return $s;
  // Куски до 45 байт UTF-8 без разрыва символа: base64 ≤ 60 знаков + обёртка 12 = слово ≤ 72 знаков (RFC 2047 — 75)
  $words = [];
  for ($i = 0, $n = strlen($s); $i < $n; $i += strlen($c)) {
    $c = mb_strcut($s, $i, 45, 'UTF-8');
    $words[] = '=?UTF-8?B?' . base64_encode($c) . '?=';
  }
  return implode("\r\n ", $words);
}
function gg_build_mail(array $cfg, array $lead, array $files): array {
  $from = $cfg['from'];
  $b = 'gg-' . bin2hex(random_bytes(12));
  $subject = (!empty($lead['suspect']) ? '[проверить] ' : '') . 'Заявка с сайта: ' . $lead['name'] . ', ' . $lead['phone'];
  $headers = [
    'From: ' . gg_mime_header($cfg['from_name'] ?? 'Сайт GROSGROUP') . ' <' . $from . '>',
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="' . $b . '"',
  ];
  if ($lead['email'] !== '') $headers[] = 'Reply-To: ' . $lead['email'];
  $body = "--$b\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n"
    . chunk_split(base64_encode(str_replace("\n", "\r\n", gg_lead_text($lead))));
  foreach ($files as $f) {
    $enc = gg_mime_header($f['name']);
    // Параметры — на отдельных строках: filename* от 150 байт имени ≤ 450 знаков, строка письма ≤ 998 (RFC 5322)
    $body .= "--$b\r\nContent-Type: application/octet-stream;\r\n name=\"$enc\"\r\nContent-Transfer-Encoding: base64\r\n"
      . "Content-Disposition: attachment;\r\n filename=\"$enc\";\r\n filename*=UTF-8''" . rawurlencode($f['name']) . "\r\n\r\n"
      . chunk_split(base64_encode((string) file_get_contents($f['tmp'])));
  }
  $body .= "--$b--\r\n";
  return ['subject' => gg_mime_header($subject), 'headers' => $headers, 'body' => $body];
}
function gg_send_mail(array $cfg, array $lead, array $files): void {
  $m = gg_build_mail($cfg, $lead, $files);
  $to = array_values(array_filter(array_map('trim', explode(',', $cfg['to']))));
  if (($cfg['transport'] ?? 'mail') === 'smtp') { gg_smtp($cfg, $to, $m); return; }
  // mail(): письмо уходит через sendmail хостинга; -f — адрес возврата на домене сайта (SPF домена разрешает сервер хостинга)
  if (!mail(implode(', ', $to), $m['subject'], $m['body'], implode("\r\n", $m['headers']), '-f' . $cfg['from'])) throw new RuntimeException('mail() вернул false');
}
function gg_smtp(array $cfg, array $to, array $m): void {
  $port = (int) ($cfg['port'] ?? 465);
  $secure = $cfg['secure'] ?? ($port === 465);
  $deadline = microtime(true) + GG_CHANNEL_TIMEOUT;
  $verify = (bool) ($cfg['verify'] ?? true);
  $ctx = stream_context_create(['ssl' => ['verify_peer' => $verify, 'verify_peer_name' => $verify]]);
  $s = @stream_socket_client(($secure ? 'ssl://' : 'tcp://') . $cfg['host'] . ':' . $port, $errno, $errstr, 15, STREAM_CLIENT_CONNECT, $ctx);
  if (!$s) throw new RuntimeException("SMTP: нет соединения ($errno)");
  $read = function () use ($s, $deadline) {
    $out = '';
    while (true) {
      stream_set_timeout($s, max(1, (int) ceil($deadline - microtime(true))));
      $line = fgets($s, 2048);
      if ($line === false || microtime(true) > $deadline) throw new RuntimeException('SMTP: нет ответа');
      $out .= $line;
      if (strlen($line) < 4 || $line[3] !== '-') return [(int) substr($line, 0, 3), $out];
    }
  };
  $cmd = function (string $c, array $okCodes) use ($s, $read) {
    fwrite($s, $c . "\r\n");
    [$code] = $read();
    if (!in_array($code, $okCodes, true)) throw new RuntimeException('SMTP: ' . strtok($c, ' ') . " — ответ $code");
  };
  try {
    [$code] = $read();
    if ($code !== 220) throw new RuntimeException("SMTP: приветствие $code");
    $host = preg_replace('/^.*@/', '', $cfg['from']);
    fwrite($s, "EHLO $host\r\n");
    [, $ehlo] = $read();
    if (!$secure) {
      if (stripos($ehlo, 'STARTTLS') === false) throw new RuntimeException('SMTP: сервер не предлагает STARTTLS — пароль открытым текстом не отправляется');
      $cmd('STARTTLS', [220]);
      if (!stream_socket_enable_crypto($s, true, STREAM_CRYPTO_METHOD_TLSv1_2_CLIENT | STREAM_CRYPTO_METHOD_TLSv1_3_CLIENT)) throw new RuntimeException('SMTP: TLS не установлен');
      $cmd("EHLO $host", [250]);
    }
    if (!empty($cfg['user'])) $cmd('AUTH PLAIN ' . base64_encode("\0" . $cfg['user'] . "\0" . $cfg['pass']), [235]);
    $cmd('MAIL FROM:<' . $cfg['from'] . '>', [250]);
    foreach ($to as $r) $cmd('RCPT TO:<' . $r . '>', [250, 251]);
    $cmd('DATA', [354]);
    $msg = 'To: ' . implode(', ', $to) . "\r\nSubject: " . $m['subject'] . "\r\nDate: " . date('r') . "\r\n"
      . 'Message-ID: <' . bin2hex(random_bytes(8)) . '@' . $host . ">\r\n" . implode("\r\n", $m['headers']) . "\r\n\r\n" . $m['body'];
    $msg = preg_replace('/^\./m', '..', $msg);
    foreach (str_split($msg, 65536) as $chunk) {
      if (microtime(true) > $deadline) throw new RuntimeException('SMTP: срок письма истёк');
      fwrite($s, $chunk);
    }
    $cmd("\r\n.", [250]);
    @fwrite($s, "QUIT\r\n");
  } finally { fclose($s); }
}

// ---------- Telegram ----------
function gg_tg_call(string $api, string $method, array $fields, float $deadline): void {
  $left = (int) ceil($deadline - microtime(true));
  if ($left <= 0) throw new RuntimeException("Telegram $method: срок канала истёк");
  $ch = curl_init($api . '/' . $method);
  curl_setopt_array($ch, [CURLOPT_POST => true, CURLOPT_POSTFIELDS => $fields, CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => $left, CURLOPT_CONNECTTIMEOUT => min(5, $left)]);
  $res = curl_exec($ch);
  $code = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
  curl_close($ch);
  // В журнал — только метод и код: адрес содержит токен бота
  if ($res === false || $code !== 200) throw new RuntimeException("Telegram $method: HTTP $code");
}
// Telegram считает длину сообщения в единицах UTF-16 (предел 4096); суррогатная пара не разрывается
function gg_tg_cut(string $s, int $max): string {
  $u = mb_convert_encoding($s, 'UTF-16LE', 'UTF-8');
  if (strlen($u) <= 2 * $max) return $s;
  $u = substr($u, 0, 2 * $max);
  $hi = ord($u[2 * $max - 1]);
  if ($hi >= 0xD8 && $hi <= 0xDB) $u = substr($u, 0, -2);
  return mb_convert_encoding($u, 'UTF-8', 'UTF-16LE');
}
function gg_send_tg(array $cfg, array $lead, array $files, string $where): void {
  $api = rtrim($cfg['api_base'] ?? 'https://api.telegram.org', '/') . '/bot' . $cfg['token'];
  $full = ($cfg['mode'] ?? 'notice') === 'full';
  $deadline = microtime(true) + ($full ? GG_CHANNEL_TIMEOUT : GG_TG_TIMEOUT);
  gg_tg_call($api, 'sendMessage', ['chat_id' => (string) $cfg['chat_id'], 'text' => gg_tg_cut($full ? gg_lead_text($lead) : gg_notice_text($lead, $where), 4000)], $deadline);
  if (!$full) return;
  foreach ($files as $f) {
    gg_tg_call($api, 'sendDocument', ['chat_id' => (string) $cfg['chat_id'], 'document' => new CURLFile($f['tmp'], 'application/octet-stream', $f['name'])], $deadline);
  }
}

// ---------- Обработчик ----------
function gg_config(): array {
  $path = getenv('GG_LEAD_CONFIG') ?: dirname(__DIR__, 2) . '/grosgroup-lead/config.php';
  $cfg = is_file($path) ? require $path : [];
  return is_array($cfg) ? $cfg : [];
}

function gg_handle(): never {
  @set_time_limit(2 * GG_CHANNEL_TIMEOUT + 20);
  if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') { header('Allow: POST'); gg_fail(405, 'method_not_allowed'); }
  $cfg = gg_config();
  $now = (int) ($cfg['now'] ?? time());
  $dir = (string) ($cfg['store_dir'] ?? '');
  $ip = (string) ($_SERVER['REMOTE_ADDR'] ?? '');
  $work = $dir !== '' ? $dir : sys_get_temp_dir() . '/gg-lead';   // счётчики частоты и объёма
  try {
    if (gg_rate_limited($work, $ip, $now)) gg_fail(429, 'rate_limited');
  } catch (Throwable $e) { gg_log('ограничение частоты: ' . $e->getMessage()); }

  $len = (int) ($_SERVER['CONTENT_LENGTH'] ?? 0);
  if ($len > GG_MAX_BODY) gg_fail(413, 'too_large');
  // Тело больше post_max_size хостинга PHP отбрасывает целиком — без этой проверки ответ был бы bad_form
  $postMax = gg_ini_bytes((string) ini_get('post_max_size'));
  if ($postMax > 0 && $len > $postMax) { gg_log("тело $len байт больше post_max_size=" . ini_get('post_max_size')); gg_fail(413, 'too_large'); }
  if (!$_POST) gg_fail(400, 'bad_form');
  if (gg_str($_POST['website'] ?? null, 200, true) !== '') gg_respond(200, ['ok' => true]);
  // elapsed — сколько миллисекунд страница была открыта до отправки; пустое поле пометки не даёт
  $raw = gg_str($_POST['elapsed'] ?? null, 20, true);
  $suspect = '';
  if ($raw !== '' && is_numeric($raw) && (float) $raw >= 0 && (float) $raw < GG_MIN_FILL_MS) {
    $suspect = 'форма отправлена через ' . number_format((float) $raw / 1000, 1, '.', '') . ' с после открытия страницы';
  }

  $files = gg_uploads();
  foreach ($files as $f) {
    if ($f['error'] === UPLOAD_ERR_INI_SIZE) gg_log('файл больше upload_max_filesize=' . ini_get('upload_max_filesize') . ' — проверьте php.ini хостинга');
  }
  [$v, $errors] = gg_validate($_POST, $files);
  if ($errors) gg_fail(400, 'invalid', ['fields' => $errors]);

  $mail = $cfg['mail'] ?? null;
  $tg = $cfg['telegram'] ?? null;
  $hasMail = !empty($mail['to']) && preg_match('/^[^\s@<>]+@[^\s@<>]+$/', (string) ($mail['from'] ?? ''));
  $hasTg = !empty($tg['token']) && !empty($tg['chat_id']);
  if (!$hasMail && !$hasTg) { gg_log('ни один канал доставки не настроен'); gg_fail(500, 'not_configured'); }

  $at = gmdate('Y-m-d\TH:i:s.000\Z', $now);
  $lead = [
    'id' => gmdate('Ymd', $now) . '-' . bin2hex(random_bytes(3)),
    'receivedAt' => $at,
    ...$v,
    'consentAt' => $at,
    'files' => array_map(fn($f) => ['name' => $f['name'], 'size' => $f['size']], $files),
    'ip' => $ip,
  ];
  if ($suspect !== '') $lead['suspect'] = $suspect;
  if ($files) {
    $ok = true;
    try { $ok = gg_quota_ok($work, $now, array_sum(array_column($files, 'size')), (int) ($cfg['day_bytes'] ?? GG_DAY_BYTES)); }
    catch (Throwable $e) { gg_log('суточный предел: ' . $e->getMessage()); }
    if (!$ok) {
      gg_log("{$lead['id']}: суточный предел файлов исчерпан, вложения отброшены");
      $lead['filesDropped'] = true;
      $files = [];
    }
  }

  $stored = false;
  if ($dir !== '') {
    try { gg_store($dir, $lead, $files); $stored = true; } catch (Throwable $e) { gg_log('резервная копия не записана: ' . $e->getMessage()); }
    try { gg_purge_daily($dir, $now); } catch (Throwable $e) { gg_log('очистка: ' . $e->getMessage()); }
  }
  // Доставка — канал, который несёт заявку целиком: почта или Telegram full. Уведомление notice без ПДн
  // доставкой не считается: оно лишь сообщает номер и где искать заявку. Telegram — последним: он медленнее
  $delivered = $mailed = false;
  if ($hasMail) {
    try { gg_send_mail($mail, $lead, $files); $delivered = $mailed = true; } catch (Throwable $e) { gg_log("{$lead['id']}: канал «почта» не доставил: " . $e->getMessage()); }
  }
  if ($hasTg) {
    $where = $mailed ? 'Подробности — в почте.' : ($stored ? 'Почта не отправлена — заявка в резервной копии на сервере.' : 'Почта не отправлена, резервная копия не записана — клиенту показана ошибка.');
    try { gg_send_tg($tg, $lead, $files, $where); if (($tg['mode'] ?? 'notice') === 'full') $delivered = true; }
    catch (Throwable $e) { gg_log("{$lead['id']}: канал «telegram» не доставил: " . $e->getMessage()); }
  }
  if ($delivered) gg_respond(200, ['ok' => true]);
  // Каналы молчат, но заявка сохранена на диске — пользователю не нужно отправлять её повторно
  if ($stored) { gg_log("{$lead['id']}: DELIVERY_FAILED, заявка только в резервной копии"); gg_respond(200, ['ok' => true]); }
  gg_fail(502, 'delivery_failed');
}

if (PHP_SAPI !== 'cli') gg_handle();
