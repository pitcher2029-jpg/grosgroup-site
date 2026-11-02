#!/bin/sh
# Тесты PHP-обработчика заявок (api/lead.php) в Docker: PHP 8.2 из образа php:8.2-cli, Node — с этой машины.
# Запуск из корня репозитория: sh tools/php-test.sh
set -e
NODE_BIN=$(readlink -f "$(command -v node)")
exec docker run --rm --network none -v "$(pwd):/w:ro" -v "$NODE_BIN:/usr/local/bin/node:ro" -w /w php:8.2-cli \
  node --test --test-timeout=60000 server/test/lead-php.test.mjs
