// GROSGROUP — поведение прототипа: меню, активный пункт навигации, появление блоков, форма заявки.
(() => {
  'use strict';

  // Куда отправлять заявку. Пусто — прототип: отправка имитируется, данные никуда не уходят.
  const CONFIG = {
    endpoint: '',            // например '/api/lead' — POST multipart/form-data
    maxFiles: 5,
    maxFileSize: 10 * 1024 * 1024,
    metrikaId: '',           // номер счётчика Яндекс Метрики; пусто — счётчика и окна о cookie нет
  };

  const $ = (s, root = document) => root.querySelector(s);
  const $$ = (s, root = document) => [...root.querySelectorAll(s)];

  // ---------- Метрика: загружается только после согласия на cookie ----------
  const COOKIE_KEY = 'gg-cookie';
  const store = {
    get() { try { return localStorage.getItem(COOKIE_KEY); } catch (e) { return null; } },
    set(v) { try { localStorage.setItem(COOKIE_KEY, v); } catch (e) { /* приватный режим: спросим в следующий раз */ } },
  };
  let metrikaOn = false;
  const loadMetrika = () => {
    if (metrikaOn) return;
    metrikaOn = true;
    const id = Number(CONFIG.metrikaId);
    window.ym = window.ym || function () { (window.ym.a = window.ym.a || []).push(arguments); };
    window.ym.l = Date.now();
    const s = document.createElement('script');
    s.async = true;
    s.src = 'https://mc.yandex.ru/metrika/tag.js';
    document.head.append(s);
    window.ym(id, 'init', { clickmap: true, trackLinks: true, accurateTrackBounce: true, webvisor: false });
  };
  // Цели: lead — заявка отправлена, tel и mail — клик по телефону и почте
  const goal = (name) => { if (metrikaOn) window.ym(Number(CONFIG.metrikaId), 'reachGoal', name); };

  if (CONFIG.metrikaId) {
    const choice = store.get();
    if (choice === 'yes') loadMetrika();
    else if (choice !== 'no') {
      const bar = document.createElement('section');
      bar.className = 'cookie';
      bar.setAttribute('aria-label', 'Cookie');
      bar.innerHTML = '<p class="cookie__text">Для статистики посещений сайт использует cookie Яндекс Метрики. Подробнее — в&nbsp;<a href="privacy.html#cookies">политике</a>.</p>'
        + '<div class="cookie__btns"><button class="btn btn--light cookie__btn" type="button" data-cookie="yes">Принять</button>'
        + '<button class="cookie__no" type="button" data-cookie="no">Отклонить</button></div>';
      bar.addEventListener('click', (e) => {
        const b = e.target.closest('[data-cookie]');
        if (!b) return;
        store.set(b.dataset.cookie);
        if (b.dataset.cookie === 'yes') loadMetrika();
        bar.remove();
      });
      document.body.append(bar);
    }
    document.addEventListener('click', (e) => {
      const a = e.target.closest('a[href^="tel:"], a[href^="mailto:"]');
      if (a) goal(a.protocol === 'tel:' ? 'tel' : 'mail');
    });
  }

  // ---------- Шапка и меню ----------
  const header = $('.header');
  const nav = $('#nav');
  const burger = $('.burger');

  const onScroll = () => header.classList.toggle('is-scrolled', window.scrollY > 8);
  onScroll();
  window.addEventListener('scroll', onScroll, { passive: true });

  // Пока меню открыто: фон не прокручивается и недоступен с клавиатуры
  const outside = [$('main'), $('footer')];
  const isOpen = () => nav.classList.contains('is-open');
  const setMenu = (open) => {
    nav.classList.toggle('is-open', open);
    document.documentElement.classList.toggle('menu-open', open);
    outside.forEach((el) => { el.inert = open; });
    burger.setAttribute('aria-expanded', String(open));
    burger.setAttribute('aria-label', open ? 'Закрыть меню' : 'Открыть меню');
  };
  burger.addEventListener('click', () => setMenu(!isOpen()));
  document.addEventListener('click', (e) => { if (isOpen() && !e.target.closest('.header')) setMenu(false); });

  // После перехода по якорю фокус уходит в целевую секцию, а не теряется
  $$('a[href^="#"]').forEach((a) => a.addEventListener('click', () => {
    const href = a.getAttribute('href');
    const wasOpen = isOpen();
    if (wasOpen) setMenu(false);
    if (href.length < 2 || !(wasOpen || a.closest('.nav'))) return;
    const target = href === '#top' ? $('.hero') : $(href);
    if (!target) return;
    if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
    target.focus({ preventScroll: true });
  }));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isOpen()) { setMenu(false); burger.focus(); }
  });
  window.matchMedia('(min-width: 961px)').addEventListener('change', (e) => { if (e.matches) setMenu(false); });

  // Подсветка пункта меню текущей секции
  const links = $$('.nav__list a');
  const targets = new Map(); // секция → ссылка меню; «Главная» (#top) подсвечивается на hero
  links.forEach((a) => {
    const href = a.getAttribute('href');
    const el = href === '#top' ? $('.hero') : $(href);
    if (el) targets.set(el, a);
  });
  // Выгоды — продолжение «Услуг», отдельная секция только ради фона
  const perks = $('.perks');
  const supplyLink = links.find((a) => a.getAttribute('href') === '#supply');
  if (perks && supplyLink) targets.set(perks, supplyLink);
  if ('IntersectionObserver' in window) {
    const io = new IntersectionObserver((entries) => {
      entries.forEach((en) => {
        if (!en.isIntersecting) return;
        const current = targets.get(en.target);
        links.forEach((a) => (a === current ? a.setAttribute('aria-current', 'true') : a.removeAttribute('aria-current')));
      });
    }, { rootMargin: '-45% 0px -50% 0px' });
    targets.forEach((_, el) => io.observe(el));
  }

  // Ссылки, адреса которых ещё не дал заказчик
  $$('[data-todo]').forEach((a) => a.addEventListener('click', (e) => {
    if (a.getAttribute('href') === '#') e.preventDefault();
  }));

  $$('[data-year]').forEach((el) => { el.textContent = new Date().getFullYear(); });

  // ---------- Появление при загрузке и прокрутке ----------
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  // Заголовки с data-r="split" режутся на слова: каждое выезжает из-под маски с задержкой
  $$('[data-r="split"]').forEach((el) => {
    let n = 0;
    const walk = (node) => {
      [...node.childNodes].forEach((ch) => {
        if (ch.nodeType === 3) {
          // Слова, склеенные неразрывным пробелом (предлог + слово), идут одной неразрывной группой
          const frag = document.createDocumentFragment();
          const tokens = ch.textContent.split(/([ \u00a0\n\t]+)/);
          let group = null, len = 0;
          const close = () => { if (group) { if (len > 12) group.classList.add('g--long'); frag.append(group); } group = null; len = 0; };
          tokens.forEach((t, k) => {
            if (!t) return;
            if (/^[ \u00a0\n\t]+$/.test(t)) {
              if (/[ \n\t]/.test(t)) { close(); frag.append(' '); } else if (group) { group.append(' '); len += 1; }
              return;
            }
            if (!group) { group = document.createElement('span'); group.className = 'g'; }
            const w = document.createElement('span');
            w.className = 'w';
            const inner = document.createElement('span');
            inner.textContent = t;
            inner.style.setProperty('--w', n++);
            w.append(inner);
            group.append(w);
            len += t.length;
            const next = tokens[k + 1];
            if (next === undefined || /[ \n\t]/.test(next)) close();
          });
          close();
          ch.replaceWith(frag);
        } else if (ch.nodeType === 1 && ch.tagName !== 'BR') walk(ch);
      });
    };
    walk(el);
    el.dataset.words = n;
  });
  // Порядковый номер внутри группы задаёт задержку «лесенкой»
  $$('[data-stagger]').forEach((g) => $$('[data-r]', g).forEach((el, i) => el.style.setProperty('--i', i)));

  const show = (el) => {
    el.classList.add('in');
    if (el.dataset.r !== 'split') return;
    // Когда слова встали на место, маска больше не нужна: снимаем, чтобы не обрезать Ё и выносы букв
    const delay = parseFloat(getComputedStyle(el).getPropertyValue('--d')) || 0;
    setTimeout(() => el.classList.add('is-settled'), reduce ? 0 : delay + el.dataset.words * 55 + 950);
  };
  const hero = $('.hero');
  if (reduce || !('IntersectionObserver' in window)) {
    show(header);
    $$('[data-r]').forEach(show);
  } else {
    const rio = new IntersectionObserver((entries) => {
      entries.forEach((en) => {
        if (!en.isIntersecting) return;
        show(en.target);
        rio.unobserve(en.target);
      });
    }, { threshold: 0 });
    $$('[data-r]').forEach((el) => { if (!hero.contains(el)) rio.observe(el); });
    // Фокус с клавиатуры показывает свой блок сразу, даже если тот ещё не попал в окно
    document.addEventListener('focusin', (e) => {
      for (let el = e.target.closest('[data-r]'); el; el = el.parentElement && el.parentElement.closest('[data-r]')) {
        if (!el.classList.contains('in')) { show(el); rio.unobserve(el); }
      }
    });
    // Первый экран стартует после шрифтов, чтобы маска заголовка не прыгала; ждём не дольше 700 мс
    Promise.race([document.fonts ? document.fonts.ready : Promise.resolve(), new Promise((r) => setTimeout(r, 700))])
      .then(() => requestAnimationFrame(() => { show(header); $$('[data-r]', hero).forEach(show); }));
  }
  document.documentElement.classList.add('r-ok');

  // ---------- Форма ----------
  const form = $('#lead-form');
  if (!form) return;
  const f = {
    name: $('#f-name'), phone: $('#f-phone'), email: $('#f-email'), desc: $('#f-desc'), files: $('#f-files'), consent: $('#f-consent'),
  };
  // Сколько страница была открыта до отправки: заявку быстрее 3 с сервер пометит «проверить».
  // Считается по performance.now(), поэтому неверные часы компьютера не мешают
  const elapsed = $('#f-elapsed');
  const trap = $('#f-website');
  const fileList = $('#file-list');
  const errorBox = $('#form-error');
  const submitBtn = $('.pill--submit', form);
  const done = $('.form__done', form);
  let files = [];

  // Карточки категорий подставляют тему в описание закупки
  $$('.cat[data-topic]').forEach((card) => card.addEventListener('click', () => {
    const line = `Интересует: ${card.dataset.topic}. `;
    if (!f.desc.value.trim()) f.desc.value = line;
    else if (!f.desc.value.includes(line.trim())) f.desc.value = line + f.desc.value;
    setTimeout(() => f.name.focus({ preventScroll: true }), 600);
  }));

  // Маска телефона: +7 (XXX) XXX-XX-XX. Ведущая 8 или 7 — код страны, иначе +7 добавляется сам;
  // вставка ровно 10 цифр — номер без кода страны. Номер на «+» и не на +7 не маскируется — его отклонит проверка.
  const digits = (v) => v.replace(/\D/g, '');
  const isForeign = (v) => /^\s*\+\s*[0-689]/.test(v);
  const formatPhone = (raw, pasted10 = false) => {
    let d = digits(raw);
    if (!d) return raw.trim() === '+' ? '+' : '';
    if (pasted10 && d.length === 10) d = '7' + d;
    else if (d[0] === '8') d = '7' + d.slice(1);
    else if (d[0] !== '7') d = '7' + d;
    d = d.slice(0, 11);
    const p = [d.slice(1, 4), d.slice(4, 7), d.slice(7, 9), d.slice(9, 11)];
    let out = '+7';
    if (p[0]) out += ' (' + p[0];
    if (p[1]) out += ') ' + p[1]; // скобка закрывается вместе с первой цифрой номера — иначе Backspace её «возвращает»
    if (p[2]) out += '-' + p[2];
    if (p[3]) out += '-' + p[3];
    return out;
  };
  f.phone.addEventListener('input', (e) => {
    const el = f.phone;
    const raw = el.value;
    if (isForeign(raw)) { el.value = raw.replace(/[^\d+()\s-]/g, ''); return; }
    const caret = el.selectionStart ?? raw.length;
    let n = digits(raw.slice(0, caret)).length; // сколько цифр слева от курсора
    const d = digits(raw);
    const pasted10 = e.inputType === 'insertFromPaste' && d.length === 10;
    if (d && (pasted10 || (d[0] !== '7' && d[0] !== '8'))) n += 1; // спереди добавится 7
    const out = formatPhone(raw, pasted10);
    el.value = out;
    if (document.activeElement !== el) return;
    let pos = out.length;
    if (n > 0) {
      let seen = 0;
      for (let i = 0; i < out.length; i++) {
        if (/\d/.test(out[i]) && ++seen === n) { pos = i + 1; break; }
      }
    } else pos = Math.min(out.length, 2);
    el.setSelectionRange(pos, pos);
  });
  f.phone.addEventListener('blur', () => { if (f.phone.value === '+7' || f.phone.value === '+') f.phone.value = ''; });

  // Проверки
  const rules = {
    name: () => (/\p{L}.*\p{L}/u.test(f.name.value) ? '' : 'Укажите имя — хотя бы 2 буквы'),
    phone: () => {
      if (isForeign(f.phone.value)) return 'Принимаем российские номера: +7 и 10 цифр';
      return /^\+7 \(\d{3}\) \d{3}-\d{2}-\d{2}$/.test(f.phone.value) ? '' : 'Укажите телефон полностью: +7 и 10 цифр';
    },
    email: () => {
      const v = f.email.value.trim();
      return !v || /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v) ? '' : 'Проверьте адрес почты, например: name@company.ru';
    },
    desc: () => '',
    consent: () => (f.consent.checked ? '' : 'Нужно согласие на обработку персональных данных'),
  };
  const showError = (key, msg) => {
    const input = f[key];
    const field = input.closest('.field, .consent');
    field.classList.toggle('is-invalid', !!msg);
    input.setAttribute('aria-invalid', msg ? 'true' : 'false');
    $('#' + input.id + '-err').textContent = msg;
  };
  const validate = (key) => { const msg = rules[key](); showError(key, msg); return !msg; };
  Object.keys(rules).forEach((key) => {
    if (f[key].type !== 'checkbox') f[key].addEventListener('blur', () => { if (f[key].value) validate(key); });
    f[key].addEventListener('input', () => { if (f[key].closest('.field, .consent').classList.contains('is-invalid')) validate(key); });
  });

  // Файлы
  const fmtSize = (b) => (b < 1024 * 1024 ? Math.max(1, Math.round(b / 1024)) + ' КБ' : (b / 1024 / 1024).toFixed(1).replace('.', ',') + ' МБ');
  const renderFiles = (note = '') => {
    fileList.replaceChildren();
    if (!files.length) {
      const empty = document.createElement('span');
      empty.className = 'files__empty';
      empty.id = 'f-files-hint';
      empty.textContent = note || 'Список файлов · до 5 шт., до 10 МБ';
      fileList.append(empty);
      return;
    }
    files.forEach((file, i) => {
      const chip = document.createElement('span');
      chip.className = 'file-chip';
      const name = document.createElement('span');
      name.className = 'file-chip__name';
      name.textContent = file.name;
      name.title = file.name;
      const size = document.createElement('span');
      size.className = 'file-chip__size';
      size.textContent = fmtSize(file.size);
      const rm = document.createElement('button');
      rm.type = 'button';
      rm.className = 'file-chip__rm';
      rm.setAttribute('aria-label', 'Убрать файл ' + file.name);
      rm.innerHTML = '<svg aria-hidden="true"><use href="#i-x"/></svg>';
      rm.addEventListener('click', () => {
        files.splice(i, 1);
        renderFiles();
        const rest = fileList.querySelectorAll('.file-chip__rm');
        (rest[Math.min(i, rest.length - 1)] || f.files).focus();
      });
      chip.append(name, size, rm);
      fileList.append(chip);
    });
    if (note) {
      const n = document.createElement('span');
      n.className = 'files__empty';
      n.textContent = note;
      fileList.append(n);
    }
  };
  f.files.addEventListener('change', () => {
    const skipped = [];
    [...f.files.files].forEach((file) => {
      if (files.some((x) => x.name === file.name && x.size === file.size)) skipped.push(`${file.name} уже в списке`);
      else if (file.size > CONFIG.maxFileSize) skipped.push(`${file.name} больше 10 МБ`);
      else if (files.length >= CONFIG.maxFiles) skipped.push(`${file.name}: не больше ${CONFIG.maxFiles} файлов`);
      else files.push(file);
    });
    f.files.value = '';
    renderFiles(skipped.length ? 'Не добавлено: ' + skipped.join('; ') : '');
  });

  // Отправка
  const send = async (data) => {
    if (!CONFIG.endpoint) {
      await new Promise((r) => setTimeout(r, 900));
      return;
    }
    const res = await fetch(CONFIG.endpoint, { method: 'POST', body: data });
    if (!res.ok) {
      const err = new Error('HTTP ' + res.status);
      err.status = res.status;
      err.body = await res.json().catch(() => null);
      throw err;
    }
  };
  // Текст ошибки по ответу сервера (server/lead.mjs)
  const failText = (err) => {
    const fields = err.body && err.body.fields;
    if (err.status === 429) return 'Слишком много заявок подряд. Подождите 10 минут или позвоните: +7 (961) 125-55-50.';
    if (err.status === 413) return 'Файлы слишком большие: не больше 5 файлов по 10 МБ.';
    if (err.status === 400 && fields) return Object.values(fields).join('. ') + '.';
    return 'Не удалось отправить заявку. Проверьте связь и повторите или позвоните: +7 (961) 125-55-50.';
  };

  // Экран успеха перекрывает форму: поля под ним выключены из обхода с клавиатуры
  const under = [...form.children].filter((el) => el !== done);
  const setDone = (on) => {
    done.hidden = !on;
    under.forEach((el) => { el.inert = on; });
    if (on) $('.form__done-title', done).focus();
  };

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (submitBtn.getAttribute('aria-busy') === 'true') return;
    const bad = Object.keys(rules).filter((k) => !validate(k));
    if (bad.length) { f[bad[0]].focus(); return; }
    // Заполненная ловушка — бот: показываем успех, ничего не отправляя
    if (trap.value) { setDone(true); return; }

    elapsed.value = String(Math.round(performance.now()));
    const data = new FormData(form);
    data.delete('files');
    files.forEach((file) => data.append('files', file, file.name));

    submitBtn.setAttribute('aria-busy', 'true');
    submitBtn.disabled = true;
    errorBox.hidden = true;
    errorBox.textContent = '';
    try {
      await send(data);
      goal('lead');
      setDone(true);
    } catch (err) {
      errorBox.textContent = failText(err);
      errorBox.hidden = false;
    } finally {
      submitBtn.removeAttribute('aria-busy');
      submitBtn.disabled = false;
    }
  });

  $('[data-reset]', done).addEventListener('click', () => {
    form.reset();
    files = [];
    renderFiles();
    Object.keys(rules).forEach((k) => showError(k, ''));
    setDone(false);
    f.name.focus();
  });
})();
