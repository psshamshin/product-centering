/*
 * Центровка фото товара — ядро без DOM.
 * Вход: JSON экспорта проекта DOOH (project + scenes[].layouts[].elements[]).
 * Выход: тот же JSON, где у элемента `product-image` пересчитаны x, y, w, h.
 * Работает в браузере (window.ProductCentering) и в Node (module.exports).
 */
(function (root) {
  'use strict';

  var DEFAULT_OPTIONS = {
    margin: 16,                  // поле товара от краёв холста, px
    padding: 8,                  // отступ от элементов: рамка без PNG и тонкие части товара, px
    clearance: 40,               // с PNG: воздух между массой товара и элементами, px
    fill: 0.9,                   // с PNG: доля от максимально возможного размера массы
    thinCrop: true,              // с PNG: тонкие части можно обрезать краем кадра, если масса станет крупнее в 1,5+ раза
    thinRatio: 0.22,             // с PNG: часть тоньше этой доли от самой толстой — «тонкая» (ручка, шнур)
    alphaThreshold: 26,          // пиксель PNG видим, если альфа ≥ 10%
    anchor: 'auto',              // обрезанный край фото: 'auto' — по PNG, 'none' — не учитывать, 'bottom' | 'top' | 'left' | 'right' — задать
    minSide: 80,                 // свободные области уже этого не рассматриваем
    productAspect: 1,            // пропорции товара (ширина / высота), когда PNG нет
    disclaimerIsObstacle: false, // по умолчанию товар может уходить под дисклеймер
    splitHeadlineIsSoft: false,  // заголовок с splitByProductImage: товар может заходить под него
    useSafeZones: true,          // прибавлять settings.safeZones сцены к полям
    widthFactors: {              // ширина = коэффициент × высота (калибровка по рендеру)
      'wb-logo': 1.7,
      'discount': 2.5,
      'cta': 2.07,
      'age-disclaimer': 1.5,
      'ali-price': 2.0,
      'ali-discount': 2.0,
      'aliexpress-logo': 3.5
    },
    // Роли по типу элемента (перекрывают встроенные ROLES): 'obstacle' | 'thin' | 'soft' | 'ignore' | 'auto'
    //   obstacle — товар обходит целиком; thin — масса обходит, тонкие части (ручка, шнур) могут заходить под элемент;
    //   soft — товар может заходить под элемент; ignore — не учитывается
    roles: {},
    // Роли отдельных слоёв — самый сильный уровень. Ключ: id элемента, 'layoutId/индекс' или 'layoutId/тип'.
    // Значение: 'obstacle' | 'thin' | 'soft' | 'ignore' | 'auto', либо true (учитывать) / false (не учитывать).
    layers: {},
    // Метрики текста по типу (перекрывают TEXT_METRICS): { charW, lineH, pad, placeholder }
    textMetrics: {},
    // Внутренние константы алгоритма посадки по массе
    tuning: {
      hitTolerance: 0.004,     // доля тонких частей, которой простительно задеть элемент
      cropNone: 0.02,          // допустимая обрезка тонких частей в режиме «целиком»
      cropMax: 0.9,            // максимум обрезки тонких частей краем кадра
      cropGain: 1.5,           // обрезать, только если масса крупнее во столько раз
      centerKeep: 0.8,         // по центру, если товар не мельче этой доли от максимума
      axisTolerance: 0.04,     // «у оси холста» — в долях ширины (не меньше 24 px)
      balanceWeight: 0.15,     // вес баланса зазоров сверху/снизу
      opticalBottom: 1.1,      // снизу зазор больше верхнего во столько раз
      airDelta: 0.15,          // допуск по воздуху, доля clearance (не меньше 4 px)
      airCap: 1,               // «комфортный» воздух сверх нормы, доля clearance
      airOk: 0.5,              // «достаточный» воздух для выбора центра, доля clearance
      smallPartRatio: 0.08,    // куски массы мельче этой доли от крупнейшего — тонкие части
      thinOnlyRatio: 0.15,     // если масса меньше этой доли силуэта — массой считается весь силуэт
      thinLength: 0.06,
      fringe: 0.8,             // тонкое ближе fringe × порога к массе — бахрома/кромка, считается массой
      thinUnderMax: 0,         // запасной режим: доля тонких частей, которая может уйти под ЛЮБЫЕ элементы (0 — выкл; обычно это решают роли 'thin')
      thinUnderKeep: 0.6,      // …и это делается, если масса по центру не мельче этой доли от максимума где угодно        // часть уже этой доли от длины силуэта — тонкая (ручка), независимо от толщины остального
      analysisSize: 256,       // размер копии PNG для анализа, px по длинной стороне
      cutEdgeMin: 0.02,        // край PNG считается обрезанным, если видимые пиксели занимают ≥ этой доли края
      cutDominance: 5,         // если задеты противоположные края — обрезан тот, что задет во столько раз сильнее; иначе это плотная обрезка PNG
      anchorProtect: 0.45,     // при привязке к краю: доля силуэта со стороны, противоположной обрезке (лицо, корпус), которая не заходит под элементы
      anchorCrop: 0.2,         // при привязке: насколько ещё можно срезать фото краем кадра, доля видимой высоты
      anchorCenterKeep: 0.6,   // при привязке: по центру, если фото не мельче этой доли от максимума (сбоку оно упирается в текст)
      anchorKeep: 0.7          // прижать к краю, если так товар не мельче этой доли от варианта, где обрезанный край спрятан под элемент
    }
  };
  var ROLE_VALUES = { obstacle: 1, thin: 1, soft: 1, ignore: 1, auto: 1 };

  // Роль элемента по отношению к фото товара; всё, чего нет в списке, — препятствие
  var ROLES = {
    'product-image': 'target',
    'background': 'ignore',
    'fade': 'ignore',
    'slideshow': 'ignore',
    'multi-layout-settings': 'ignore',
    'image-gallery': 'ignore',
    'disclaimer': 'soft',          // товар может уходить под него
    'headline': 'thin',            // масса обходит, тонкие части (ручка) могут проходить под текстом
    'strikethrough-price': 'thin',
    'product-description': 'thin',
    'extra-disclaimer': 'soft',
    'media': 'content'             // препятствие, только если в нём есть контент
  };

  // Текстовые элементы: размер оценивается по тексту, когда в JSON нет w или h.
  // charW — средняя ширина знака в долях кегля, lineH — высота строки по умолчанию,
  // pad — внутренний отступ плашки в долях кегля, placeholder — что редактор показывает при пустом тексте.
  var TEXT_METRICS = {
    'headline':            { placeholder: 'Заголовок', charW: 0.62, lineH: 0.81, pad: 0 },
    'strikethrough-price': { placeholder: '10 314 ₽', charW: 0.55, lineH: 1.0, pad: 0 },
    'price-badge':         { placeholder: '6 490 ₽', charW: 0.55, lineH: 1.0, pad: 0.25 },
    'product-description': { placeholder: 'Название и описание товара', charW: 0.5, lineH: 1.0, pad: 0 },
    'brand-badge':         { placeholder: 'БРЕНД', charW: 0.62, lineH: 1.0, pad: 0.35 },
    'bank-badge':          { placeholder: 'выгоднее\nс WB Банком', charW: 0.55, lineH: 1.1, pad: 0.3 },
    'age-disclaimer':      { placeholder: '18+', charW: 0.62, lineH: 1.0, pad: 0 },
    'ali-text':            { placeholder: 'Текст', charW: 0.55, lineH: 0.8, pad: 0 }
  };

  var NAMES = {
    'wb-logo': 'Лого WB', 'discount': 'Скидка', 'cta': 'Цена и кнопка', 'disclaimer': 'Дисклеймер',
    'extra-disclaimer': 'Доп. дисклеймер', 'fade': 'Градиент', 'background': 'Фон', 'product-image': 'Фото товара',
    'headline': 'Заголовок', 'age-disclaimer': 'Возрастная маркировка', 'bank-badge': 'Плашка WB Банка',
    'brand-badge': 'Бейдж бренда', 'price-badge': 'Цена', 'strikethrough-price': 'Старая цена',
    'product-description': 'Описание товара', 'slideshow': 'Слайдшоу', 'media': 'Медиа',
    'multi-layout-settings': 'Второй лейаут', 'image-gallery': 'Галерея'
  };

  function propsOf(el) {
    var m = {};
    (el.properties || []).forEach(function (p) { m[p.key] = p.value; });
    return m;
  }
  function num(v) {
    if (typeof v === 'number' && isFinite(v)) return v;
    if (typeof v === 'string' && v.trim() !== '' && isFinite(+v)) return +v;
    return null;
  }
  function round2(v) { return Math.round(v * 100) / 100; }
  function nameOf(el) { return NAMES[el.type] || el.title || el.type; }
  function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
  // Глубокое слияние настроек. Пришедшее значение берётся, только если оно того же типа, что и значение
  // по умолчанию (число — конечное); иначе остаётся значение по умолчанию. Словари (roles, layers,
  // widthFactors, textMetrics) дополняются новыми ключами.
  function mergeInto(out, extra, base, path, warn) {
    Object.keys(extra).forEach(function (k) {
      var v = extra[k], d = base ? base[k] : undefined, key = path ? path + '.' + k : k;
      if (v === undefined || v === null || (!path && k === 'warnings')) return;
      if (isObj(d)) {
        if (!isObj(v)) { warn.push(key + ': ожидался объект — оставлено по умолчанию'); return; }
        out[k] = out[k] || {};
        if (Object.keys(d).length) mergeInto(out[k], v, d, key, warn);
        else Object.keys(v).forEach(function (kk) { if (v[kk] !== undefined && v[kk] !== null) out[k][kk] = v[kk]; });
        return;
      }
      if (d === undefined) {                       // ключ словаря (тип элемента, слой)
        if (base && !path) { warn.push(key + ': неизвестный параметр — пропущен'); return; }
        out[k] = isObj(v) ? JSON.parse(JSON.stringify(v)) : v; return;
      }
      if (typeof d === 'number') {
        var n = num(v);
        if (n === null) { warn.push(key + ': не число — оставлено ' + d); return; }
        out[k] = n; return;
      }
      if (typeof d === 'boolean') {
        if (typeof v !== 'boolean') { warn.push(key + ': ожидалось true/false — оставлено ' + d); return; }
        out[k] = v; return;
      }
      out[k] = v;
    });
  }
  function resolveOptions(extra) {
    var out = JSON.parse(JSON.stringify(DEFAULT_OPTIONS)), warn = [];
    if (isObj(extra)) mergeInto(out, extra, DEFAULT_OPTIONS, '', warn);
    out.warnings = warn;
    return out;
  }
  function merge(base, extra) {
    if (extra && extra.__resolved) return extra;
    var r = resolveOptions(extra);
    Object.defineProperty(r, '__resolved', { value: true, enumerable: false });
    return r;
  }

  // Значения по умолчанию из палитры проекта (project.layoutElements) по типу элемента
  function paletteOf(project) {
    var map = {};
    var list = project && project.project && project.project.layoutElements;
    (list || []).forEach(function (el) { if (el && el.type && !map[el.type]) map[el.type] = propsOf(el); });
    return map;
  }

  // Рамка повёрнутого прямоугольника (поворот вокруг центра)
  function rotatedBounds(b, deg) {
    if (!deg) return b;
    var a = deg * Math.PI / 180, c = Math.abs(Math.cos(a)), s = Math.abs(Math.sin(a));
    var w = b.w * c + b.h * s, h = b.w * s + b.h * c;
    var cx = b.x + b.w / 2, cy = b.y + b.h / 2;
    return { x: cx - w / 2, y: cy - h / 2, w: w, h: h };
  }

  // Оценка размеров текстового элемента по кеглю, строкам и длине текста
  function textSize(type, p, w, h, opts) {
    var m = Object.assign({}, TEXT_METRICS[type] || {}, (opts && opts.textMetrics && opts.textMetrics[type]) || {});
    if (!m.charW) m = Object.assign({ placeholder: 'Текст', charW: 0.55, lineH: 1.0, pad: 0 }, m);
    var lineH = num(p.lineHeight) || m.lineH;
    var raw = (typeof p.text === 'number') ? String(p.text) : (p.text || '');
    var text = String(raw).trim() ? String(raw) : m.placeholder;
    var lines = text.split('\n');
    var maxChars = lines.reduce(function (a, l) { return Math.max(a, l.length); }, 1);
    var fs = num(p.fontSize) || num(p.titleFontSize) || (h !== null ? h / (lineH * lines.length + 2 * m.pad) : null) || 60;
    var pad = fs * m.pad;
    return {
      w: w !== null ? w : maxChars * fs * m.charW + 2 * pad,
      h: h !== null ? h : fs * lineH * lines.length + 2 * pad,
      text: text
    };
  }

  /*
   * Классифицирует элемент и строит его рамку на холсте.
   * Возвращает { type, name, role, box|null, source, notes[] }.
   *   role:   target | obstacle | soft | ignore
   *   source: json | factor | text — откуда взят размер
   */
  // Роль слоя, заданная снаружи: options.layers по id, 'layoutId/индекс' или 'layoutId/тип'
  function layerOverride(el, opts, ctx) {
    var L = opts.layers || {}, keys = [];
    if (el.id) keys.push(String(el.id));
    if (ctx) { keys.push(ctx.layoutId + '/' + ctx.index); keys.push(ctx.layoutId + '/' + el.type); }
    for (var i = 0; i < keys.length; i++) {
      var v = L[keys[i]];
      if (v === true) return { role: 'include', key: keys[i] };
      if (v === false) return { role: 'ignore', key: keys[i] };
      if (typeof v === 'string' && ROLE_VALUES[v]) return { role: v, key: keys[i] };
    }
    return null;
  }
  function defaultRole(type, opts) {
    var r = opts.roles && opts.roles[type];
    if (typeof r === 'string' && ROLE_VALUES[r] && r !== 'auto') return r;
    return ROLES[type] || 'obstacle';
  }

  /*
   * ctx (необязательно): { layoutId, index } — для настроек отдельных слоёв (options.layers).
   * res.override — роль задана снаружи; res.defaultRole — роль без настроек слоя.
   */
  function classify(el, opts, palette, ctx) {
    opts = merge(DEFAULT_OPTIONS, opts);
    var p = Object.assign({}, (palette && palette[el.type]) || {}, propsOf(el));
    var type = el.type, notes = [];
    var role = defaultRole(type, opts);
    var res = { type: type, name: nameOf(el), role: role, box: null, source: null, notes: notes, override: null, defaultRole: role };

    if (role === 'target') return res;
    var ov = layerOverride(el, opts, ctx);
    if (p.enabled === false && !(ov && ov.role !== 'ignore' && ov.role !== 'auto')) { res.role = 'ignore'; res.defaultRole = 'ignore'; notes.push('выключен'); return res; }
    if (role === 'content') {
      role = p.contentUrl ? 'obstacle' : 'ignore';
      if (role === 'ignore') notes.push('без контента');
    }
    if (type === 'disclaimer' && opts.disclaimerIsObstacle) role = 'obstacle';
    if (type === 'headline' && p.splitByProductImage === true && opts.splitHeadlineIsSoft) {
      role = 'soft'; notes.push('заголовок с разбиением по товару');
    }
    if (role === 'ignore' && !notes.length) notes.push('фон или служебный элемент');
    res.defaultRole = role;
    if (ov && ov.role !== 'auto') {
      role = ov.role === 'include' ? (role === 'ignore' ? 'obstacle' : role) : ov.role;
      res.override = ov.role;
      notes.push('роль задана в настройках слоя (' + ov.key + ')');
    }
    res.role = role;
    if (role === 'ignore') return res;

    var x = num(p.x), y = num(p.y), w = num(p.w), h = num(p.h);

    if (type === 'extra-disclaimer') {
      var id = p.extraDisclaimerId;
      if (!id || id === 'none' || !el.variants || !el.variants[id]) { res.role = 'ignore'; notes.push('не включён'); return res; }
      var v = {};
      el.variants[id].forEach(function (q) { v[q.key] = q.value; });
      x = num(v.x); y = num(v.y); w = num(v.w); h = num(v.h);
    }

    if (x === null || y === null) { res.role = 'ignore'; notes.push('нет координат'); return res; }

    res.source = 'json';
    if (w === null && h !== null && opts.widthFactors[type]) {
      w = h * opts.widthFactors[type];
      res.source = 'factor';
      notes.push('ширина оценена: ' + opts.widthFactors[type] + ' × h = ' + Math.round(w) + ' px');
    }
    if ((w === null || h === null) && (TEXT_METRICS[type] || (opts.textMetrics && opts.textMetrics[type]))) {
      var t = textSize(type, p, w, h, opts);
      notes.push('размер оценён по тексту «' + t.text.replace(/\n/g, ' ') + '»: ' + Math.round(t.w) + '×' + Math.round(t.h) + ' px');
      w = t.w; h = t.h; res.source = 'text';
    }
    if (w === null || h === null) { res.role = 'ignore'; res.source = null; notes.push('нет размеров — не учитывается'); return res; }

    var box = { x: x, y: y, w: w, h: h };
    if (type === 'disclaimer') box.y = y - h;            // y — нижняя граница текста, блок растёт вверх
    box = rotatedBounds(box, num(p.rotation) || 0);
    res.box = box;
    return res;
  }

  // --- Свободные прямоугольники (разрезание MaxRects) ---
  function inflate(r, p) { return { x: r.x - p, y: r.y - p, w: r.w + 2 * p, h: r.h + 2 * p }; }
  function intersects(a, b) {
    return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  }
  function contains(a, b) {
    return a.x <= b.x + 1e-6 && a.y <= b.y + 1e-6 &&
      a.x + a.w >= b.x + b.w - 1e-6 && a.y + a.h >= b.y + b.h - 1e-6;
  }
  function dropContained(list) {
    return list.filter(function (r, i) {
      return !list.some(function (s, j) {
        if (i === j || !contains(s, r)) return false;
        return !contains(r, s) || j < i;   // одинаковые оставляем один раз
      });
    });
  }
  function freeRects(area, obstacles, pad, minSide) {
    var free = [area];
    obstacles.forEach(function (ob) {
      var o = inflate(ob, pad), next = [];
      free.forEach(function (r) {
        if (!intersects(r, o)) { next.push(r); return; }
        if (o.x > r.x) next.push({ x: r.x, y: r.y, w: o.x - r.x, h: r.h });
        if (o.x + o.w < r.x + r.w) next.push({ x: o.x + o.w, y: r.y, w: r.x + r.w - (o.x + o.w), h: r.h });
        if (o.y > r.y) next.push({ x: r.x, y: r.y, w: r.w, h: o.y - r.y });
        if (o.y + o.h < r.y + r.h) next.push({ x: r.x, y: o.y + o.h, w: r.w, h: r.y + r.h - (o.y + o.h) });
      });
      free = dropContained(next);
    });
    return free.filter(function (r) { return r.w >= minSide && r.h >= minSide; });
  }

  // --- Силуэт товара: «масса» и тонкие части ---
  // Квадраты евклидовых расстояний до ближайшей клетки-источника (Felzenszwalb, Huttenlocher)
  function edt1d(f, n, d, v, z) {
    var k = 0, q, s;
    v[0] = 0; z[0] = -Infinity; z[1] = Infinity;
    for (q = 1; q < n; q++) {
      s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      while (s <= z[k]) { k--; s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]); }
      k++; v[k] = q; z[k] = s; z[k + 1] = Infinity;
    }
    k = 0;
    for (q = 0; q < n; q++) {
      while (z[k + 1] < q) k++;
      d[q] = (q - v[k]) * (q - v[k]) + f[v[k]];
    }
  }
  function sqEDT(src, w, h) {
    var INF = 1e20, n = Math.max(w, h), i, x, y;
    var g = new Float64Array(w * h);
    for (i = 0; i < w * h; i++) g[i] = src[i] ? 0 : INF;
    var f = new Float64Array(n), d = new Float64Array(n), v = new Int32Array(n), z = new Float64Array(n + 1);
    for (x = 0; x < w; x++) {
      for (y = 0; y < h; y++) f[y] = g[y * w + x];
      edt1d(f, h, d, v, z);
      for (y = 0; y < h; y++) g[y * w + x] = d[y];
    }
    for (y = 0; y < h; y++) {
      for (x = 0; x < w; x++) f[x] = g[y * w + x];
      edt1d(f, w, d, v, z);
      for (x = 0; x < w; x++) g[y * w + x] = d[x];
    }
    return g;
  }
  // Убирает куски маски меньше frac от самого крупного; возвращает число оставшихся пикселей
  function dropSmallParts(m, w, h, frac) {
    var lab = new Int32Array(w * h), sizes = [0], stack = [], cur = 0, i;
    for (i = 0; i < w * h; i++) {
      if (!m[i] || lab[i]) continue;
      cur++; var size = 0; stack.push(i); lab[i] = cur;
      while (stack.length) {
        var p = stack.pop(), px = p % w, py = (p - px) / w; size++;
        if (px > 0 && m[p - 1] && !lab[p - 1]) { lab[p - 1] = cur; stack.push(p - 1); }
        if (px < w - 1 && m[p + 1] && !lab[p + 1]) { lab[p + 1] = cur; stack.push(p + 1); }
        if (py > 0 && m[p - w] && !lab[p - w]) { lab[p - w] = cur; stack.push(p - w); }
        if (py < h - 1 && m[p + w] && !lab[p + w]) { lab[p + w] = cur; stack.push(p + w); }
      }
      sizes.push(size);
    }
    var big = 0, left = 0;
    for (i = 1; i < sizes.length; i++) big = Math.max(big, sizes[i]);
    for (i = 0; i < w * h; i++) if (m[i]) { if (sizes[lab[i]] < frac * big) m[i] = 0; else left++; }
    return left;
  }
  function samplePts(list, max) {
    var n = list.length / 2;
    if (n <= max) return new Float32Array(list);
    var st = n / max, out = new Float32Array(max * 2);
    for (var i = 0; i < max; i++) { var k = Math.floor(i * st); out[2 * i] = list[2 * k]; out[2 * i + 1] = list[2 * k + 1]; }
    return out;
  }

  /*
   * Анализ PNG товара. alpha — альфа-канал уменьшенной копии PNG (mw×mh, значения 0..255).
   * «Масса» — плотная часть силуэта (щётка, корпус): морфологическое открытие маски кругом радиуса
   * thinRatio × (толщина самой толстой части). Остальное — тонкие части (ручка, шнур, ножки).
   */
  function analyzeProduct(alpha, mw, mh, pngW, pngH, options) {
    var o = merge(DEFAULT_OPTIONS, options);
    var n = mw * mh, mask = new Uint8Array(n), count = 0, i, x, y, k;
    for (i = 0; i < n; i++) if (alpha[i] >= o.alphaThreshold) { mask[i] = 1; count++; }
    if (!count) return null;
    var pw = mw + 2, ph = mh + 2, src = new Uint8Array(pw * ph);
    src.fill(1);
    for (y = 0; y < mh; y++) for (x = 0; x < mw; x++) if (mask[y * mw + x]) src[(y + 1) * pw + x + 1] = 0;
    var din = sqEDT(src, pw, ph), dmax2 = 0;
    for (i = 0; i < din.length; i++) if (din[i] > dmax2) dmax2 = din[i];
    // Порог «тонкого»: доля от толщины самой толстой части ИЛИ доля от длины всего силуэта —
    // так длинная ручка тонкая, даже если остальной товар тоже плоский (швабра с плоской насадкой)
    var vb = (function () { var x0 = mw, y0 = mh, x1 = -1, y1 = -1, xx, yy; for (yy = 0; yy < mh; yy++) for (xx = 0; xx < mw; xx++) if (mask[yy * mw + xx]) { if (xx < x0) x0 = xx; if (xx > x1) x1 = xx; if (yy < y0) y0 = yy; if (yy > y1) y1 = yy; } return Math.max(x1 - x0 + 1, y1 - y0 + 1); })();
    var dmax = Math.sqrt(dmax2), r = Math.max(1.5, o.thinRatio * dmax, o.tuning.thinLength * vb / 2), r2 = r * r;
    var er = new Uint8Array(pw * ph), erN = 0;
    for (i = 0; i < din.length; i++) if (din[i] >= r2) { er[i] = 1; erN++; }
    var core = new Uint8Array(n), coreN = 0;
    if (erN) {
      var dd = sqEDT(er, pw, ph);
      for (y = 0; y < mh; y++) for (x = 0; x < mw; x++) {
        k = y * mw + x;
        if (mask[k] && dd[(y + 1) * pw + x + 1] <= r2 + 1e-9) { core[k] = 1; coreN++; }
      }
    }
    // Обрезанные края: доля видимых пикселей на крайних двух строках/столбцах PNG
    var edgeCut = { bottom: 0, top: 0, left: 0, right: 0 }, cutSide = null, cutBest = 0;
    (function () {
      var c = { bottom: 0, top: 0, left: 0, right: 0 }, xx, yy;
      for (xx = 0; xx < mw; xx++) {
        if (mask[(mh - 1) * mw + xx] || (mh > 1 && mask[(mh - 2) * mw + xx])) c.bottom++;
        if (mask[xx] || (mh > 1 && mask[mw + xx])) c.top++;
      }
      for (yy = 0; yy < mh; yy++) {
        if (mask[yy * mw] || (mw > 1 && mask[yy * mw + 1])) c.left++;
        if (mask[yy * mw + mw - 1] || (mw > 1 && mask[yy * mw + mw - 2])) c.right++;
      }
      edgeCut = { bottom: c.bottom / mw, top: c.top / mw, left: c.left / mh, right: c.right / mh };
      var opp = { bottom: 'top', top: 'bottom', left: 'right', right: 'left' }, tu0 = o.tuning;
      Object.keys(edgeCut).forEach(function (k) {
        var v = edgeCut[k], w = edgeCut[opp[k]];
        if (v < tu0.cutEdgeMin) return;
        if (w >= tu0.cutEdgeMin && v < tu0.cutDominance * w) return;   // задеты оба противоположных края — PNG просто обрезан впритык
        if (v > cutBest) { cutBest = v; cutSide = k; }
      });
    })();
    if (coreN) coreN = dropSmallParts(core, mw, mh, o.tuning.smallPartRatio);
    // Бахрома и короткие выступы у самой массы (ворс насадки, кромка) — тоже масса: тонкое в пределах
    // fringe × r от массы не считается отдельной тонкой частью (её нельзя срезать краем кадра)
    if (coreN && o.tuning.fringe > 0) {
      var csrc = new Uint8Array(pw * ph);
      for (y = 0; y < mh; y++) for (x = 0; x < mw; x++) if (core[y * mw + x]) csrc[(y + 1) * pw + x + 1] = 1;
      var dc = sqEDT(csrc, pw, ph), fr2 = Math.pow(o.tuning.fringe * r, 2);
      for (y = 0; y < mh; y++) for (x = 0; x < mw; x++) {
        k = y * mw + x;
        if (mask[k] && !core[k] && dc[(y + 1) * pw + x + 1] <= fr2) { core[k] = 1; coreN++; }
      }
    }
    var fallback = coreN < o.tuning.thinOnlyRatio * count;            // товар «весь тонкий» (кабель, цепочка) — масса = весь силуэт
    if (fallback) { core = mask.slice(); coreN = count; }

    var bbox = function (m) {
      var x0 = mw, y0 = mh, x1 = -1, y1 = -1;
      for (var yy = 0; yy < mh; yy++) for (var xx = 0; xx < mw; xx++) if (m[yy * mw + xx]) {
        if (xx < x0) x0 = xx; if (xx > x1) x1 = xx; if (yy < y0) y0 = yy; if (yy > y1) y1 = yy;
      }
      return { x0: x0, y0: y0, x1: x1 + 1, y1: y1 + 1 };
    };
    var coreRows = new Array(mh), bnd = [], smp = [], thin = [];
    for (y = 0; y < mh; y++) {
      var spans = [], run = -1;
      for (x = 0; x <= mw; x++) {
        var on = x < mw && core[y * mw + x] === 1;
        if (on && run < 0) run = x;
        else if (!on && run >= 0) { spans.push(run, x); run = -1; }
      }
      coreRows[y] = spans;
      for (x = 0; x < mw; x++) {
        k = y * mw + x;
        if (core[k]) {
          if (x === 0 || y === 0 || x === mw - 1 || y === mh - 1 || !core[k - 1] || !core[k + 1] || !core[k - mw] || !core[k + mw]) bnd.push(x + 0.5, y + 0.5);
          smp.push(x + 0.5, y + 0.5);
        } else if (mask[k]) thin.push(x + 0.5, y + 0.5);
      }
    }
    // Полосы силуэта для зазоров по сторонам: строки → крайние левый/правый пиксели, столбцы → верхний/нижний
    var bandsOf = function (m, box, byRows) {
      var out = [], n0 = byRows ? box.y0 : box.x0, n1 = byRows ? box.y1 : box.x1;
      var step = Math.max(1, Math.ceil((n1 - n0) / 24));
      for (var a0 = n0; a0 < n1; a0 += step) {
        var a1 = Math.min(n1, a0 + step), lo = Infinity, hi = -Infinity, a, t;
        for (a = a0; a < a1; a++) {
          if (byRows) {
            for (t = 0; t < mw; t++) if (m[a * mw + t]) { if (t < lo) lo = t; break; }
            for (t = mw - 1; t >= 0; t--) if (m[a * mw + t]) { if (t + 1 > hi) hi = t + 1; break; }
          } else {
            for (t = 0; t < mh; t++) if (m[t * mw + a]) { if (t < lo) lo = t; break; }
            for (t = mh - 1; t >= 0; t--) if (m[t * mw + a]) { if (t + 1 > hi) hi = t + 1; break; }
          }
        }
        if (hi > lo) out.push([a0, a1, lo, hi]);
      }
      return out;
    };
    var maskBox = bbox(mask), coreBox = bbox(core), thinPtsS;
    // Край перерезан тонкой частью (ручка ушла за край) или массой (человек по пояс)?
    var cutThin = false;
    if (cutSide) {
      var onEdge = 0, coreOnEdge = 0, e, ix;
      for (e = 0; e < (cutSide === 'top' || cutSide === 'bottom' ? mw : mh); e++) {
        for (var dd2 = 0; dd2 < 2; dd2++) {
          if (cutSide === 'bottom') ix = (mh - 1 - dd2) * mw + e; else if (cutSide === 'top') ix = dd2 * mw + e;
          else if (cutSide === 'left') ix = e * mw + dd2; else ix = e * mw + (mw - 1 - dd2);
          if (mask[ix]) { onEdge++; if (core[ix]) coreOnEdge++; }
        }
      }
      cutThin = onEdge > 0 && coreOnEdge < 0.5 * onEdge;
    }
    // Точки обрезанного края и тонкие точки между краем и массой (их можно прятать под элементы)
    var cutPts = [], thinNear = null;
    if (cutSide) {
      var L2 = (cutSide === 'top' || cutSide === 'bottom') ? mw : mh;
      for (var e2 = 0; e2 < L2; e2++) {
        var cx2, cy2;
        if (cutSide === 'bottom') { cx2 = e2; cy2 = mh - 1; } else if (cutSide === 'top') { cx2 = e2; cy2 = 0; }
        else if (cutSide === 'left') { cx2 = 0; cy2 = e2; } else { cx2 = mw - 1; cy2 = e2; }
        if (mask[cy2 * mw + cx2]) cutPts.push(cx2 + 0.5, cy2 + 0.5);
      }
      cutPts = samplePts(cutPts, 200);
      var gap = cutSide === 'bottom' ? mh - coreBox.y1 : cutSide === 'top' ? coreBox.y0 : cutSide === 'left' ? coreBox.x0 : mw - coreBox.x1;
      thinNear = function (px, py) {
        var d = cutSide === 'bottom' ? mh - py : cutSide === 'top' ? py : cutSide === 'left' ? px : mw - px;
        return d <= gap;
      };
    }
    return {
      rowBands: bandsOf(mask, maskBox, true), colBands: bandsOf(mask, maskBox, false),
      coreRowBands: bandsOf(core, coreBox, true), coreColBands: bandsOf(core, coreBox, false),
      mw: mw, mh: mh, pngW: pngW, pngH: pngH, qx: pngW / mw, qy: pngH / mh,
      count: count, coreCount: coreN, thinCount: count - coreN,
      coreShare: coreN / count, thinShare: (count - coreN) / count, fallback: fallback,
      dmax: dmax, radius: r, maskBox: maskBox, coreBox: coreBox, coreRows: coreRows,
      coreBoundary: samplePts(bnd, 520), coreSample: samplePts(smp, 400), thinPts: (thinPtsS = samplePts(thin, 900)),
      thinExempt: thinNear ? (function () { var f = new Uint8Array(thinPtsS.length / 2); for (var q = 0; q < f.length; q++) f[q] = thinNear(thinPtsS[2 * q], thinPtsS[2 * q + 1]) ? 1 : 0; return f; })() : null,
      mask: mask, core: core, edgeCut: edgeCut, cutSide: cutSide, cutThroughThin: cutThin,
      cutPts: cutPts, thinNearCut: thinNear
    };
  }

  // --- Посадка по массе ---
  // Поле расстояний до препятствий на сетке с шагом cell, px
  function obstacleField(W, H, boxes, cell) {
    var gw = Math.max(1, Math.ceil(W / cell)), gh = Math.max(1, Math.ceil(H / cell));
    var src = new Uint8Array(gw * gh), any = false;
    boxes.forEach(function (b) {
      var i0 = Math.max(0, Math.floor(b.x / cell)), i1 = Math.min(gw - 1, Math.floor((b.x + b.w - 1e-6) / cell));
      var j0 = Math.max(0, Math.floor(b.y / cell)), j1 = Math.min(gh - 1, Math.floor((b.y + b.h - 1e-6) / cell));
      for (var j = j0; j <= j1; j++) for (var i = i0; i <= i1; i++) { src[j * gw + i] = 1; any = true; }
    });
    var d = null;
    if (any) {
      var g2 = sqEDT(src, gw, gh);
      d = new Float32Array(gw * gh);
      for (var q = 0; q < d.length; q++) d[q] = Math.sqrt(g2[q]) * cell;
    }
    return { gw: gw, gh: gh, cell: cell, d: d };
  }
  function fieldAt(F, x, y) {
    if (!F.d) return 1e9;
    var i = Math.floor(x / F.cell), j = Math.floor(y / F.cell);
    if (i < 0) i = 0; else if (i >= F.gw) i = F.gw - 1;
    if (j < 0) j = 0; else if (j >= F.gh) j = F.gh - 1;
    return F.d[j * F.gw + i];
  }
  // Масса, нарезанная на полосы высотой ≈ g px (объединение отрезков строк — с запасом)
  function coreBands(an, kx, ky, g) {
    var hb = Math.max(1, Math.floor(g / ky)), gap = Math.max(0, Math.floor(g / kx)), out = [];
    for (var v0 = an.coreBox.y0; v0 < an.coreBox.y1; v0 += hb) {
      var v1 = Math.min(an.coreBox.y1, v0 + hb), spans = [], vmin = -1, vmax = -1;
      for (var v = v0; v < v1; v++) {
        var row = an.coreRows[v];
        if (!row.length) continue;
        if (vmin < 0) vmin = v;
        vmax = v + 1;
        for (var s = 0; s < row.length; s += 2) spans.push([row[s], row[s + 1]]);
      }
      if (!spans.length) continue;
      spans.sort(function (a, b) { return a[0] - b[0]; });
      var cur = spans[0].slice();
      for (var q = 1; q < spans.length; q++) {
        if (spans[q][0] <= cur[1] + gap) cur[1] = Math.max(cur[1], spans[q][1]);
        else { out.push({ u0: cur[0], u1: cur[1], v0: vmin, v1: vmax }); cur = spans[q].slice(); }
      }
      out.push({ u0: cur[0], u1: cur[1], v0: vmin, v1: vmax });
    }
    return out;
  }
  /*
   * Допустимые положения массы при масштабе S (px холста на px PNG): масса внутри поля A
   * и не ближе clearance к препятствиям. Сетка сдвигов (X, Y) левого верхнего угла PNG;
   * запретные сдвиги для пары «препятствие × полоса массы» — прямоугольник (разность Минковского),
   * они накладываются через 2D-разностный массив.
   */
  function feasibleGrid(an, S, A, obstaclesC) {
    var kx = an.qx * S, ky = an.qy * S, cb = an.coreBox;
    var Xlo = A.x - cb.x0 * kx, Xhi = A.x + A.w - cb.x1 * kx;
    var Ylo = A.y - cb.y0 * ky, Yhi = A.y + A.h - cb.y1 * ky;
    if (Xhi < Xlo - 1e-6 || Yhi < Ylo - 1e-6) return null;
    Xhi = Math.max(Xhi, Xlo); Yhi = Math.max(Yhi, Ylo);
    var g = Math.max(1, Math.max(Xhi - Xlo, Yhi - Ylo) / 160);
    var nx = Math.floor((Xhi - Xlo) / g + 1e-9) + 1, ny = Math.floor((Yhi - Ylo) / g + 1e-9) + 1;
    var W1 = nx + 1, cov = new Int32Array(W1 * (ny + 1)), i, j;
    var bands = coreBands(an, kx, ky, g);
    for (var oi = 0; oi < obstaclesC.length; oi++) {
      var o = obstaclesC[oi];
      for (var bi = 0; bi < bands.length; bi++) {
        var r = bands[bi];
        var i0 = Math.floor((o.x - r.u1 * kx - Xlo) / g) + 1, i1 = Math.ceil((o.x + o.w - r.u0 * kx - Xlo) / g) - 1;
        var j0 = Math.floor((o.y - r.v1 * ky - Ylo) / g) + 1, j1 = Math.ceil((o.y + o.h - r.v0 * ky - Ylo) / g) - 1;
        if (i0 < 0) i0 = 0;
        if (j0 < 0) j0 = 0;
        if (i1 > nx - 1) i1 = nx - 1;
        if (j1 > ny - 1) j1 = ny - 1;
        if (i0 > i1 || j0 > j1) continue;
        cov[j0 * W1 + i0]++; cov[j0 * W1 + i1 + 1]--; cov[(j1 + 1) * W1 + i0]--; cov[(j1 + 1) * W1 + i1 + 1]++;
      }
    }
    for (j = 0; j <= ny; j++) for (i = 1; i <= nx; i++) cov[j * W1 + i] += cov[j * W1 + i - 1];
    for (j = 1; j <= ny; j++) for (i = 0; i <= nx; i++) cov[j * W1 + i] += cov[(j - 1) * W1 + i];
    return { Xlo: Xlo, Ylo: Ylo, g: g, nx: nx, ny: ny, W1: W1, cov: cov, kx: kx, ky: ky };
  }
  // Свободные клетки сетки; если их много — прореживание решёткой с шагом step
  function freeCells(grid, limit, keepI) {
    var all = [], i, j;
    for (j = 0; j < grid.ny; j++) for (i = 0; i < grid.nx; i++) if (grid.cov[j * grid.W1 + i] === 0 && (!keepI || keepI(i, j))) all.push(i, j);
    var n = all.length / 2;
    if (n <= limit) return { list: all, step: 1 };
    var st = Math.ceil(Math.sqrt(n / limit)), out = [];
    for (var q = 0; q < all.length; q += 2) if (all[q] % st === 0 && all[q + 1] % st === 0) out.push(all[q], all[q + 1]);
    if (out.length < 8) { out = []; var m = n / limit; for (q = 0; q < limit; q++) { var k = Math.floor(q * m); out.push(all[2 * k], all[2 * k + 1]); } }
    return { list: out, step: st };
  }


  /*
   * Зазоры силуэта до ближайших препятствий/краёв холста слева, справа, сверху, снизу.
   * Считаются по полосам: для каждой полосы строк — от крайнего левого/правого пикселя до препятствия
   * на той же высоте; для полос столбцов — сверху/снизу. Так хвост под скидкой не «прячет» скидку от расчёта.
   */
  function sideGaps(rows, cols, X, Y, kx, ky, boxes, W, H) {
    var L = Infinity, R = Infinity, T = Infinity, B = Infinity, i, j, b, g1, g2;
    for (i = 0; i < rows.length; i++) {
      var y0 = Y + rows[i][0] * ky, y1 = Y + rows[i][1] * ky, xl = X + rows[i][2] * kx, xr = X + rows[i][3] * kx;
      g1 = xl; g2 = W - xr;
      for (j = 0; j < boxes.length; j++) {
        b = boxes[j];
        if (b.y >= y1 || b.y + b.h <= y0) continue;
        if (b.x + b.w <= xl + 0.5) g1 = Math.min(g1, xl - (b.x + b.w));
        else if (b.x >= xr - 0.5) g2 = Math.min(g2, b.x - xr);
      }
      if (g1 < L) L = g1;
      if (g2 < R) R = g2;
    }
    for (i = 0; i < cols.length; i++) {
      var x0 = X + cols[i][0] * kx, x1 = X + cols[i][1] * kx, yt = Y + cols[i][2] * ky, yb = Y + cols[i][3] * ky;
      g1 = yt; g2 = H - yb;
      for (j = 0; j < boxes.length; j++) {
        b = boxes[j];
        if (b.x >= x1 || b.x + b.w <= x0) continue;
        if (b.y + b.h <= yt + 0.5) g1 = Math.min(g1, yt - (b.y + b.h));
        else if (b.y >= yb - 0.5) g2 = Math.min(g2, b.y - yb);
      }
      if (g1 < T) T = g1;
      if (g2 < B) B = g2;
    }
    return { L: L, R: R, T: T, B: B };
  }

  /*
   * Посадка товара по массе.
   * 1) Размер: самый крупный масштаб, при котором масса помещается в поле с воздухом clearance до элементов,
   *    а тонкие части не задевают элементы (отступ padding). Если разрешено и это даёт массу крупнее в 1,5+ раза —
   *    тонкие части могут уйти за край кадра (до 90% их площади). Затем масштаб × fill — запас воздуха.
   * 2) Место: наибольший запас воздуха по всем точкам силуэта (масса — от clearance, тонкие части — от padding)
   *    с ровными зазорами сверху/снизу (снизу чуть больше — оптический центр). Среди положений, где воздуха
   *    достаточно (≈ половина clearance сверх нормы), — самое близкое к вертикальной оси холста: «по центру, если влезает».
   */
  function placeByMass(an, env) {
    var o = env.opts, W = env.W, H = env.H, A = env.A, tu = o.tuning;
    var HIT_TOL = tu.hitTolerance, HIT_BASE = tu.hitTolerance, CROP_NONE = tu.cropNone, CROP_MAX = tu.cropMax, CROP_GAIN = tu.cropGain, CENTER_KEEP = tu.centerKeep;
    var C = Math.max(0, o.clearance), P = Math.max(0, o.padding);
    var cellF = Math.max(2, Math.ceil(Math.max(W, H) / 400));
    var field = obstacleField(W, H, env.hard, cellF);
    var fieldThin = env.hardThin ? obstacleField(W, H, env.hardThin, cellF) : field;   // для тонких частей
    var hardC = env.hard.map(function (b) { return inflate(b, C); });
    var cb = an.coreBox;
    var sTop = Math.min(A.w / ((cb.x1 - cb.x0) * an.qx), A.h / ((cb.y1 - cb.y0) * an.qy));
    if (!(sTop > 0) || !isFinite(sTop)) return null;
    var TP = an.thinPts, BP = an.coreBoundary, SP = an.coreSample;
    var nT = TP.length / 2, nB = BP.length / 2, nS = SP.length / 2;
    var mb = an.maskBox, BAL_W = tu.balanceWeight, DELTA = Math.max(4, tu.airDelta * C), AIR_CAP = Math.max(8, tu.airCap * C), AIR_OK = tu.airOk * C;

    // hideCut: обрезанный край должен быть за холстом или под элементом; тонкие части у края могут
    // заходить под элементы и за край без штрафа
    var hideCut = !!env.hideCut, EX = hideCut ? an.thinExempt : null, CP = an.cutPts || [], nC = CP.length / 2;
    var coverBoxes = env.hard.concat(env.soft || []);
    function covered(X, Y, kx, ky) {
      if (!hideCut) return true;
      for (var i = 0; i < nC; i++) {
        var x = X + CP[2 * i] * kx, y = Y + CP[2 * i + 1] * ky, inside = false;
        if (x < 0 || y < 0 || x >= W || y >= H) continue;
        for (var j = 0; j < coverBoxes.length; j++) { var b = coverBoxes[j]; if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) { inside = true; break; } }
        if (!inside) return false;
      }
      return true;
    }
    function thinCheck(X, Y, kx, ky) {
      var hit = 0, crop = 0;
      for (var i = 0; i < nT; i++) {
        if (EX && EX[i]) continue;
        var x = X + TP[2 * i] * kx, y = Y + TP[2 * i + 1] * ky;
        if (x < 0 || y < 0 || x >= W || y >= H) crop++;
        else if (fieldAt(fieldThin, x, y) < P) hit++;
      }
      return { hit: nT ? hit / nT : 0, crop: nT ? crop / nT : 0, cov: covered(X, Y, kx, ky) };
    }
    function score(X, Y, kx, ky, cropMode) {
      var n = 0, mn = Infinity, hit = 0, crop = 0, i, x, y, a;
      for (i = 0; i < nB; i++) {
        x = X + BP[2 * i] * kx; y = Y + BP[2 * i + 1] * ky;
        a = Math.min(fieldAt(field, x, y) - C, x - A.x, A.x + A.w - x, y - A.y, A.y + A.h - y);
        n++; if (a < mn) mn = a;
      }
      for (i = 0; i < nT; i++) {
        if (EX && EX[i]) continue;
        x = X + TP[2 * i] * kx; y = Y + TP[2 * i + 1] * ky;
        var out = x < 0 || y < 0 || x >= W || y >= H;
        if (out) { crop++; if (cropMode) continue; }
        var dObs = fieldAt(fieldThin, x, y) - P;
        if (!out && dObs < 0) hit++;
        a = cropMode ? dObs : Math.min(dObs, x, W - x, y, H - y);
        n++; if (a < mn) mn = a;
      }
      // Воздух сверх «комфортного» (ещё clearance сверх обязательного) уже не важен — дальше решают центр и баланс
      var J = n ? Math.min(mn, AIR_CAP) : 0, soft = 0;
      // По вертикали — ровные зазоры сверху/снизу (снизу чуть больше — оптический центр).
      // В обычном режиме — по всему силуэту, при обрезке — по массе.
      var gp = cropMode ? sideGaps(an.coreRowBands, an.coreColBands, X, Y, kx, ky, env.hard, W, H)
                        : sideGaps(an.rowBands, an.colBands, X, Y, kx, ky, env.hard, W, H);
      J -= BAL_W * Math.abs(tu.opticalBottom * gp.T - gp.B) / 2;
      // По горизонтали ориентир — ось холста: центр видимой части (при обрезке — массы)
      var ref = cropMode ? cb : mb;
      var cx = X + (ref.x0 + ref.x1) / 2 * kx;
      if (env.soft.length) {
        for (i = 0; i < nS; i++) {
          x = X + SP[2 * i] * kx; y = Y + SP[2 * i + 1] * ky;
          for (var s = 0; s < env.soft.length; s++) {
            var b = env.soft[s];
            if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) { soft++; break; }
          }
        }
      }
      var softF = nS ? soft / nS : 0, cropF = nT ? crop / nT : 0;
      J -= softF * 2 * C;
      if (cropMode) J -= cropF * C;
      if (HIT_TOL > HIT_BASE) J -= (nT ? hit / nT : 0) * 2 * C;     // тонкие части под элементами — как можно меньше
      return { J: J, air: mn, hit: nT ? hit / nT : 0, crop: cropF, soft: softF, dc: Math.abs(cx - W / 2), gaps: gp, cov: covered(X, Y, kx, ky) };
    }
    // Главная свободная зона — самый большой по площади свободный прямоугольник (с воздухом clearance)
    var zone = (function () {
      var rs = freeRects(A, env.hard, C, Math.max(20, o.minSide));
      rs.sort(function (a, b) { return b.w * b.h - a.w * a.h; });
      return rs[0] || null;
    })();
    // centered: только положения, где центр товара у вертикальной оси холста (± axisTol),
    // а центр массы — в главной свободной зоне (а не в полоске под кнопкой или в углу)
    var axisTol = Math.max(24, tu.axisTolerance * W);
    function feasibleAt(S, kappa, centered) {
      var grid = feasibleGrid(an, S, A, hardC);
      if (!grid) return false;
      var keepI = null;
      if (centered) {
        var ref = kappa > CROP_NONE ? cb : mb, rc = (ref.x0 + ref.x1) / 2 * grid.kx;
        var mc = (cb.y0 + cb.y1) / 2 * grid.ky;
        keepI = function (i, j) {
          if (Math.abs(grid.Xlo + i * grid.g + rc - W / 2) > axisTol) return false;
          if (!zone) return true;
          var y = grid.Ylo + j * grid.g + mc;                       // центр массы — в главной свободной зоне
          return y >= zone.y && y <= zone.y + zone.h;
        };
      }
      var cs = freeCells(grid, 260, keepI);
      if (!cs.list.length) return false;
      if (!nT && !hideCut) return true;
      for (var q = 0; q < cs.list.length; q += 2) {
        var t = thinCheck(grid.Xlo + cs.list[q] * grid.g, grid.Ylo + cs.list[q + 1] * grid.g, grid.kx, grid.ky);
        if (t.hit <= HIT_TOL && t.crop <= kappa && t.cov) return true;
      }
      return false;
    }
    function maxScale(kappa, centered, from) {
      var top = from || sTop, S = top, bad = null, ok = null;
      for (var it = 0; it < 60 && S > top * 0.03; it++) {
        if (feasibleAt(S, kappa, centered)) { ok = S; break; }
        bad = S; S *= 0.93;
      }
      if (ok === null) return null;
      if (bad !== null) {
        var lo = ok, hi = bad;
        for (var b = 0; b < 7; b++) { var mid = Math.sqrt(lo * hi); if (feasibleAt(mid, kappa, centered)) lo = mid; else hi = mid; }
        ok = lo;
      }
      return ok;
    }
    // Масштаб режима: по центру холста, если так товар не мельче 80% от максимума; иначе — максимум где угодно
    function modeScale(kappa) {
      var any = maxScale(kappa, false);
      if (!any) return null;
      var cen = maxScale(kappa, true, any);
      return (cen && cen >= CENTER_KEEP * any) ? { s: cen, any: any, centered: true } : { s: any, any: any, centered: false };
    }

    var m0 = modeScale(CROP_NONE);
    var mUnder = null;
    var m1 = (o.thinCrop && nT) ? modeScale(CROP_MAX) : null;
    // Обрезка: сравниваются итоговые размеры режимов, вариант не по центру считается «мельче» в centerKeep раз
    var eff = function (m) { return m ? m.s * (m.centered ? 1 : CENTER_KEEP) : 0; };
    var s0 = eff(m0), s1 = eff(m1);
    var cropMode = false, chosenMode = m0;
    if (s1 && (!s0 || s1 >= CROP_GAIN * s0)) { cropMode = true; chosenMode = m1; }
    // Ни один вариант не встал по центру главной зоны (длинная ручка упирается в заголовок) —
    // пробуем пустить тонкие части под элементы и за край кадра: масса — по центру, ручка — за текстом
    var thinUnder = false;
    // (или так товар крупнее в cropGain раз, чем выбранный вариант)
    if (o.thinCrop && nT && tu.thinUnderMax > HIT_BASE) {
      HIT_TOL = tu.thinUnderMax;
      var top0 = Math.max(m0 ? m0.any : 0, m1 ? m1.any : 0);
      var cen2 = maxScale(CROP_MAX, true);
      var better = cen2 && ((!(chosenMode && chosenMode.centered) && cen2 >= tu.thinUnderKeep * top0) || cen2 >= CROP_GAIN * eff(chosenMode));
      if (better) { mUnder = { s: cen2, any: top0, centered: true }; chosenMode = mUnder; cropMode = true; thinUnder = true; }
      else HIT_TOL = HIT_BASE;
    }
    if (!chosenMode) return null;
    var sStar = chosenMode.s;
    var kappa = cropMode ? CROP_MAX : CROP_NONE;
    var valid = function (c) { return c.hit <= HIT_TOL && c.crop <= kappa + 1e-9 && c.cov !== false; };

    function bestAt(S) {
      var grid = feasibleGrid(an, S, A, hardC);
      if (!grid) return null;
      var cs = freeCells(grid, 900);
      if (!cs.list.length) return null;
      var cand = [], q, r;
      for (q = 0; q < cs.list.length; q += 2) {
        var i = cs.list[q], j = cs.list[q + 1];
        r = score(grid.Xlo + i * grid.g, grid.Ylo + j * grid.g, grid.kx, grid.ky, cropMode);
        r.i = i; r.j = j; cand.push(r);
      }
      var anyValid = cand.some(valid);
      var pool = anyValid ? cand.filter(valid) : cand;
      // Выбор: среди положений, где воздуха достаточно (не меньше половины нормы или почти максимум),
      // — ближайшее к оси холста; при равенстве — лучший воздух и баланс сверху/снизу
      var pick = function (list) {
        var jmax = -Infinity;
        list.forEach(function (c) { if (c.J > jmax) jmax = c.J; });
        var enough = Math.min(jmax, AIR_OK) - DELTA;
        var good = list.filter(function (c) { return c.J >= enough; });
        good.sort(function (a, b) { return Math.abs(a.dc - b.dc) > 0.5 ? a.dc - b.dc : b.J - a.J; });
        return good;
      };
      if (cs.step > 1) {
        var seen = {}, extra = [];
        pool.forEach(function (c) { seen[c.i + ',' + c.j] = 1; });
        var byJ = pool.slice().sort(function (a, b) { return b.J - a.J; }).slice(0, 6);
        var seeds = byJ.concat(pick(pool).slice(0, 6));
        seeds.forEach(function (c0) {
          for (var dj = -cs.step; dj <= cs.step; dj++) for (var di = -cs.step; di <= cs.step; di++) {
            var ii = c0.i + di, jj = c0.j + dj, key = ii + ',' + jj;
            if (seen[key] || ii < 0 || jj < 0 || ii >= grid.nx || jj >= grid.ny || grid.cov[jj * grid.W1 + ii] !== 0) continue;
            seen[key] = 1;
            var rr = score(grid.Xlo + ii * grid.g, grid.Ylo + jj * grid.g, grid.kx, grid.ky, cropMode);
            rr.i = ii; rr.j = jj;
            if (valid(rr) || !anyValid) extra.push(rr);
          }
        });
        pool = pool.concat(extra);
      }
      var best = pick(pool)[0];
      best.X = grid.Xlo + best.i * grid.g; best.Y = grid.Ylo + best.j * grid.g;
      best.S = S; best.kx = grid.kx; best.ky = grid.ky; best.ok = valid(best);
      return best;
    }
    var best = bestAt(sStar * o.fill);
    if (!best || !best.ok) { var b2 = bestAt(sStar); if (b2 && (b2.ok || !best)) best = b2; }
    if (!best) return null;

    var S = best.S, X = best.X, Y = best.Y, kx = best.kx, ky = best.ky;
    return {
      scale: S, maxScale: sStar, scaleWhole: s0, scaleCrop: s1, cropMode: cropMode, ok: best.ok, thinUnder: thinUnder,
      centered: chosenMode.centered, sizeForCenter: chosenMode.centered ? chosenMode.s / chosenMode.any : 1,
      after: { x: X, y: Y, w: an.pngW * S, h: an.pngH * S },
      visible: { x: X + mb.x0 * kx, y: Y + mb.y0 * ky, w: (mb.x1 - mb.x0) * kx, h: (mb.y1 - mb.y0) * ky },
      massBox: { x: X + cb.x0 * kx, y: Y + cb.y0 * ky, w: (cb.x1 - cb.x0) * kx, h: (cb.y1 - cb.y0) * ky },
      air: best.air, hit: best.hit, crop: best.crop, soft: best.soft, clearance: C
    };
  }

  /*
   * Фото обрезано снизу (человек по пояс, товар «из-за края»): обрезанный край прижимается к низу холста,
   * при необходимости уходит за него ещё на anchorCrop видимой высоты. Под элементы не может заходить
   * только верхняя часть силуэта (anchorProtect — голова, лицо); нижняя может уходить под цену, кнопку,
   * бейджи — они лежат поверх. Размер — максимальный, по центру холста, если так не мельче anchorCenterKeep
   * (по умолчанию 60%: человек сбоку у края, вплотную к заголовку, выглядит хуже, чем чуть меньший по центру).
   */
  // Вид задачи, где обрезанный край — нижний: транспонирование (лево/право) и отражение по вертикали
  function anchorView(an, env, side) {
    var ops = { bottom: [], top: ['flip'], right: ['tr'], left: ['tr', 'flip'] }[side];
    var mw = an.mw, mh = an.mh, mask = an.mask, core = an.core, qx = an.qx, qy = an.qy, pw = an.pngW, ph = an.pngH, W = env.W, H = env.H, i, x, y;
    var boxes = { hard: env.hard.slice(), A: env.A };
    ops.forEach(function (op) {
      var m2 = new Uint8Array(mw * mh), c2 = new Uint8Array(mw * mh);
      if (op === 'tr') {
        for (y = 0; y < mh; y++) for (x = 0; x < mw; x++) { m2[x * mh + y] = mask[y * mw + x]; c2[x * mh + y] = core[y * mw + x]; }
        var t = mw; mw = mh; mh = t; t = qx; qx = qy; qy = t; t = pw; pw = ph; ph = t; t = W; W = H; H = t;
        var tb = function (b) { return { x: b.y, y: b.x, w: b.h, h: b.w }; };
        boxes.hard = boxes.hard.map(tb); boxes.A = tb(boxes.A);
      } else {
        for (y = 0; y < mh; y++) for (x = 0; x < mw; x++) { m2[(mh - 1 - y) * mw + x] = mask[y * mw + x]; c2[(mh - 1 - y) * mw + x] = core[y * mw + x]; }
        var hh = H, fb = function (b) { return { x: b.x, y: hh - b.y - b.h, w: b.w, h: b.h }; };
        boxes.hard = boxes.hard.map(fb); boxes.A = fb(boxes.A);
      }
      mask = m2; core = c2;
    });
    var x0 = mw, y0 = mh, x1 = -1, y1 = -1;
    for (i = 0; i < mw * mh; i++) if (mask[i]) { x = i % mw; y = (i - x) / mw; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    var view = { mw: mw, mh: mh, mask: mask, core: core, cutThroughThin: an.cutThroughThin, qx: qx, qy: qy, pngW: pw, pngH: ph, maskBox: { x0: x0, y0: y0, x1: x1 + 1, y1: y1 + 1 } };
    var venv = { W: W, H: H, A: boxes.A, hard: boxes.hard, soft: [], opts: env.opts };
    // обратное преобразование прямоугольника из вида в холст
    var back = function (b) {
      var r = { x: b.x, y: b.y, w: b.w, h: b.h }, Wc = W, Hc = H;
      for (var k = ops.length - 1; k >= 0; k--) {
        if (ops[k] === 'flip') r = { x: r.x, y: Hc - r.y - r.h, w: r.w, h: r.h };
        else { r = { x: r.y, y: r.x, w: r.h, h: r.w }; var t2 = Wc; Wc = Hc; Hc = t2; }
      }
      return r;
    };
    return { view: view, env: venv, back: back };
  }
  function placeAnchoredSide(an, env, side) {
    var v = anchorView(an, env, side), res = placeAnchored(v.view, v.env);
    if (!res) return null;
    res.anchored = side;
    res.after = v.back(res.after); res.visible = v.back(res.visible); res.massBox = v.back(res.massBox);
    return res;
  }

  function placeAnchored(an, env) {
    var o = env.opts, tu = o.tuning, W = env.W, H = env.H, A = env.A, C = Math.max(0, o.clearance);
    var mb = an.maskBox, visRows = mb.y1 - mb.y0;
    // Защищённая часть: если край перерезан тонкой частью (ручка) — вся масса товара, под элементы уходят
    // только тонкие части; если массой (человек по пояс) — доля силуэта у противоположного края.
    var protMask = an.cutThroughThin ? an.core : an.mask;
    var protStart = mb.y0, protEnd = an.cutThroughThin ? mb.y1 : mb.y0 + Math.max(1, Math.ceil(tu.anchorProtect * visRows));
    var rows = [], px0 = Infinity, px1 = -Infinity, py0 = Infinity, py1 = -Infinity, v, u;
    for (v = protStart; v < protEnd; v++) {
      var spans = [], run = -1;
      for (u = 0; u <= an.mw; u++) {
        var on = u < an.mw && protMask[v * an.mw + u] === 1;
        if (on && run < 0) run = u;
        else if (!on && run >= 0) { spans.push(run, u); if (run < px0) px0 = run; if (u > px1) px1 = u; run = -1; }
      }
      if (spans.length) { rows.push({ v: v, s: spans }); if (v < py0) py0 = v; py1 = v + 1; }
    }
    if (!rows.length) return null;
    var hardC = env.hard.map(function (b) { return inflate(b, C); });
    var axisTol = Math.max(24, tu.axisTolerance * W);

    // Допустимые X (левый край PNG) при масштабе S и доле дополнительной обрезки t
    function allowed(S, t) {
      var kx = an.qx * S, ky = an.qy * S, visH = visRows * ky;
      var Y = H + t * visH - mb.y1 * ky;
      if (Y + py0 * ky < A.y) return null;                         // защищённая часть выше поля
      var lo = Math.max(-mb.x0 * kx, A.x - px0 * kx), hi = Math.min(W - mb.x1 * kx, A.x + A.w - px1 * kx);
      if (hi < lo) return null;
      var bad = [];
      rows.forEach(function (r) {
        var y0 = Y + r.v * ky, y1 = y0 + ky;
        hardC.forEach(function (O) {
          if (O.y >= y1 || O.y + O.h <= y0) return;
          for (var q = 0; q < r.s.length; q += 2) bad.push([O.x - r.s[q + 1] * kx, O.x + O.w - r.s[q] * kx]);
        });
      });
      bad.sort(function (a, b) { return a[0] - b[0]; });
      var free = [], cur = lo;
      for (var i = 0; i < bad.length && cur <= hi; i++) {
        if (bad[i][1] <= cur) continue;
        if (bad[i][0] > cur) free.push([cur, Math.min(hi, bad[i][0])]);
        cur = Math.max(cur, bad[i][1]);
      }
      if (cur <= hi) free.push([cur, hi]);
      return free.length ? { free: free, Y: Y, kx: kx, ky: ky } : null;
    }
    function nearestX(f, kx) {
      var target = W / 2 - (mb.x0 + mb.x1) / 2 * kx, best = null;
      f.free.forEach(function (iv) {
        var x = Math.min(iv[1], Math.max(iv[0], target)), d = Math.abs(x - target);
        if (!best || d < best.d) best = { X: x, d: d };
      });
      return best;
    }
    function ok(S, t, centered) {
      var f = allowed(S, t); if (!f) return false;
      return !centered || nearestX(f, f.kx).d <= axisTol;
    }
    // Сколько можно срезать краем кадра: у человека — anchorCrop видимой высоты; если за край уходит
    // тонкая часть — сколько угодно, но не задевая массу
    var tMax = an.cutThroughThin ? Math.max(0, (mb.y1 - py1) / visRows) : tu.anchorCrop;
    var sTop = Math.min(W / ((mb.x1 - mb.x0) * an.qx), (H - A.y) / (Math.max(1, mb.y1 - py0) * an.qy * Math.max(0.05, 1 - tMax)));
    function maxS(t, centered) {
      var S = sTop, bad = null, good = null;
      for (var it = 0; it < 60 && S > sTop * 0.03; it++) { if (ok(S, t, centered)) { good = S; break; } bad = S; S *= 0.93; }
      if (good === null) return null;
      if (bad !== null) { var lo = good, hi = bad; for (var b = 0; b < 7; b++) { var mid = Math.sqrt(lo * hi); if (ok(mid, t, centered)) lo = mid; else hi = mid; } good = lo; }
      return good;
    }
    var ts = an.cutThroughThin ? [0, 0.25, 0.5, 0.75, 1].map(function (f) { return f * tMax; }) : [0, tMax / 2, tMax], opts = [];
    ts.forEach(function (t) { opts.push({ t: t, any: maxS(t, false), cen: maxS(t, true) }); });
    var anyMax = 0;
    opts.forEach(function (q) { if (q.any > anyMax) anyMax = q.any; });
    if (!anyMax) return null;
    // меньше обрезки, если размер почти тот же; по центру, если не мельче centerKeep
    var pickT = function (key, ref) { for (var i = 0; i < opts.length; i++) if (opts[i][key] && opts[i][key] >= 0.97 * ref) return opts[i]; return null; };
    var cenMax = 0;
    opts.forEach(function (q) { if (q.cen > cenMax) cenMax = q.cen; });
    var centered = cenMax >= tu.anchorCenterKeep * anyMax;
    var chosen = centered ? pickT('cen', cenMax) : pickT('any', anyMax);
    var sStar = centered ? chosen.cen : chosen.any;
    var S = sStar * o.fill, f = allowed(S, chosen.t);
    if (!f) { S = sStar; f = allowed(S, chosen.t); }
    var nx = nearestX(f, f.kx), X = nx.X, Y = f.Y, kx = f.kx, ky = f.ky;
    var cut = Math.max(0, Y + an.mh * ky - H);
    return {
      anchored: 'bottom', scale: S, maxScale: sStar, centered: centered, sizeForCenter: centered ? cenMax / anyMax : 1,
      cropPx: cut, cropMode: false, ok: true, crop: 0, hit: 0, soft: 0, air: 0, clearance: C,
      after: { x: X, y: Y, w: an.pngW * S, h: an.pngH * S },
      visible: { x: X + mb.x0 * kx, y: Y + mb.y0 * ky, w: (mb.x1 - mb.x0) * kx, h: (mb.y1 - mb.y0) * ky },
      massBox: { x: X + px0 * kx, y: Y + py0 * ky, w: (px1 - px0) * kx, h: (py1 - py0) * ky }
    };
  }

  var SIDE_RU = { bottom: ['снизу', 'нижнему', 'нижний'], top: ['сверху', 'верхнему', 'верхний'], left: ['слева', 'левому', 'левый'], right: ['справа', 'правому', 'правый'] };

  // Самая крупная вписанная рамка товара с пропорцией aspect (w/h)
  function fitIn(rect, aspect) {
    var w = Math.min(rect.w, rect.h * aspect), h = w / aspect;
    return { w: w, h: h };
  }
  function chooseRect(rects, aspect, canvas) {
    var cx = canvas.width / 2, cy = canvas.height / 2;
    var scored = rects.map(function (r) {
      var f = fitIn(r, aspect);
      var d = Math.hypot(r.x + r.w / 2 - cx, r.y + r.h / 2 - cy);
      return { rect: r, area: f.w * f.h, rectArea: r.w * r.h, dist: d };
    });
    scored.sort(function (a, b) {
      if (Math.abs(b.area - a.area) > 1) return b.area - a.area;     // крупнее товар
      if (Math.abs(b.rectArea - a.rectArea) > 1) return b.rectArea - a.rectArea;
      return a.dist - b.dist;                                        // ближе к центру холста
    });
    return scored.length ? scored[0].rect : null;
  }

  function safeZones(scene) {
    var z = { top: 0, left: 0, right: 0, bottom: 0 };
    var list = scene && scene.settings && scene.settings.safeZones;
    if (Array.isArray(list)) list.forEach(function (q) { if (q && q.key in z) z[q.key] = num(q.value) || 0; });
    return z;
  }

  function findLayout(project, layoutId) {
    var scenes = project.scenes || [];
    for (var i = 0; i < scenes.length; i++) {
      var ls = scenes[i].layouts || [];
      for (var j = 0; j < ls.length; j++) if (ls[j].id === layoutId) return { scene: scenes[i], layout: ls[j] };
    }
    return null;
  }

  // Список всех лейаутов (для выбора в интерфейсе)
  function listLayouts(project) {
    var out = [];
    (project.scenes || []).forEach(function (s) {
      (s.layouts || []).forEach(function (l) {
        out.push({
          layoutId: l.id, layoutName: l.name, sceneId: s.id,
          sceneName: s.placement && s.placement.name, canvas: s.canvas,
          hasProduct: (l.elements || []).some(function (e) { return e.type === 'product-image'; })
        });
      });
    });
    return out;
  }

  /*
   * Расчёт для одного лейаута.
   * product (необязательно): { width, height, trim: {x, y, w, h} } — размеры PNG и рамка его видимой части.
   */
  function computeLayout(project, layoutId, options, product) {
    var opts = merge(DEFAULT_OPTIONS, options);
    var found = findLayout(project, layoutId);
    if (!found) return { ok: false, error: 'Лейаут не найден' };
    var scene = found.scene, layout = found.layout, canvas = scene.canvas;
    var palette = paletteOf(project);
    var items = (layout.elements || []).map(function (el, i) { return { el: el, index: i, info: classify(el, opts, palette, { layoutId: layoutId, index: i }) }; });
    var targetItem = null;
    items.forEach(function (it) { if (!targetItem && it.info.role === 'target') targetItem = it; });
    if (!targetItem) return { ok: false, error: 'В лейауте нет элемента «Фото товара» (product-image)', canvas: canvas, items: items };

    var tp = propsOf(targetItem.el);
    var before = { x: num(tp.x), y: num(tp.y), w: num(tp.w), h: num(tp.h) };

    var sz = opts.useSafeZones ? safeZones(scene) : { top: 0, left: 0, right: 0, bottom: 0 };
    var m = opts.margin;
    var area = {
      x: m + sz.left, y: m + sz.top,
      w: canvas.width - 2 * m - sz.left - sz.right,
      h: canvas.height - 2 * m - sz.top - sz.bottom
    };
    var obstacles = items.filter(function (it) { return (it.info.role === 'obstacle' || it.info.role === 'thin') && it.info.box; })
      .map(function (it) { return it.info.box; });
    // для тонких частей препятствия — только 'obstacle'; под 'thin' (заголовок, старая цена) они могут проходить
    var thinBlockers = items.filter(function (it) { return it.info.role === 'obstacle' && it.info.box; })
      .map(function (it) { return it.info.box; });
    var rects = freeRects(area, obstacles, opts.padding, opts.minSide);
    if (!rects.length) {
      return { ok: false, error: 'Не нашлось свободного места: уменьшите поле или отступ', canvas: canvas, items: items, area: area, rects: [], before: before };
    }

    var aspect = product && product.trim ? product.trim.w / product.trim.h : opts.productAspect;
    var chosen = chooseRect(rects, aspect, canvas);
    var after = null, visible, warnings = (opts.warnings || []).map(function (w) { return 'Настройки: ' + w; }), infos = [], mass = null;

    if (product && product.analysis) {
      // Посадка по массе: щётка/корпус — по центру свободного места с воздухом, ручки и шнуры — куда поместятся
      var softBoxes = items.filter(function (it) { return it.info.role === 'soft' && it.info.box; })
        .map(function (it) { return it.info.box; });
      var envM = { W: canvas.width, H: canvas.height, A: area, hard: obstacles, hardThin: thinBlockers, soft: softBoxes, opts: opts };
      var an = product.analysis, side = opts.anchor === 'auto' ? an.cutSide : (opts.anchor === 'none' ? null : opts.anchor);
      if (side && SIDE_RU[side]) {
        // Два способа скрыть обрезанный край: прижать его к краю холста или спрятать под элемент (ручка за заголовком)
        var mA = placeAnchoredSide(an, envM, side);
        var mB = (an.cutPts && an.cutPts.length) ? placeByMass(an, Object.assign({}, envM, { hideCut: true })) : null;
        if (mB && !mB.ok) mB = null;
        if (mA && (!mB || (mA.scale >= opts.tuning.anchorKeep * mB.scale && (mA.centered || !mB.centered)))) mass = mA;
        else if (mB) { mass = mB; mass.hiddenCut = side; }
      } else mass = placeByMass(an, envM);
      if (mass && mass.anchored) {
        after = mass.after; visible = mass.visible;
        infos.push('Фото обрезано ' + SIDE_RU[mass.anchored][0] + ' — прижато к ' + SIDE_RU[mass.anchored][1] + ' краю' + (mass.cropPx > 1 ? ' и срезано ещё на ' + Math.round(mass.cropPx) + ' px' : '') + '. ' +
          (an.cutThroughThin ? 'За край уходит тонкая часть — масса товара не заходит под элементы, под них может уходить только она.'
            : 'Часть силуэта у противоположного края (' + Math.round(opts.tuning.anchorProtect * 100) + '%) не заходит под элементы, остальное — может.'));
        if (mass.centered && mass.sizeForCenter < 0.97) infos.push('Чтобы товар встал по центру, он на ' + Math.round((1 - mass.sizeForCenter) * 100) + '% мельче максимума.');
      } else if (mass) {
        after = mass.after; visible = mass.visible;
        if (mass.hiddenCut) infos.push('Фото обрезано ' + SIDE_RU[mass.hiddenCut][0] + ' — прижать к краю холста можно только совсем мелко, поэтому обрезанный край спрятан под элементом или за краем, а масса товара стоит в свободном месте.');
        if (!mass.ok) warnings.push('Тонкие части товара задевают элементы — свободного места мало. Уменьшите «Воздух вокруг массы» или проверьте лейаут в редакторе.');
        if (mass.centered && mass.sizeForCenter < 0.97) infos.push('Чтобы товар встал по центру, он на ' + Math.round((1 - mass.sizeForCenter) * 100) + '% мельче максимума — крупнее он поместился бы только сбоку.');
        if (mass.thinUnder) infos.push('Длинная тонкая часть (ручка) проходит под элементами и уходит за край — иначе товар не встаёт по центру. Проверьте читаемость текста над ней.');
        if (mass.crop > 0.005) infos.push('Тонкие части обрезаны краем кадра (' + Math.round(mass.crop * 100) + '%) — так масса товара крупнее в ' + (mass.scaleWhole ? (mass.maxScale / mass.scaleWhole).toFixed(1).replace('.', ',') + ' раза' : 'разы') + '. Отключается в параметрах.');
      } else {
        warnings.push('Массе товара не хватило места с воздухом ' + opts.clearance + ' px — товар вписан по видимой части. Уменьшите «Воздух вокруг массы» или поле.');
      }
    }

    if (after) {
      var outM = Math.max(0, -after.x, -after.y, after.x + after.w - canvas.width, after.y + after.h - canvas.height);
      if (outM > 0.5 && mass && mass.anchored) infos.push('Контейнер выходит за ' + SIDE_RU[mass.anchored][2] + ' край холста на ' + Math.round(outM) + ' px — так задумано (обрезанное фото). Проверьте, что редактор это принимает.');
      else if (outM > 0.5) warnings.push('Контейнер выходит за холст на ' + Math.round(outM) + ' px (прозрачные поля PNG' + (mass && mass.crop > 0.005 ? ', обрезка тонких частей' : '') + '). Если редактор этого не допускает — обрежьте поля у PNG.');
    } else if (product && product.trim) {
      // Видимая часть PNG вписывается в свободную область и встаёт по её центру;
      // контейнер = весь PNG в том же масштабе (картинка вписывается в контейнер целиком).
      var t = product.trim;
      var s = Math.min(chosen.w / t.w, chosen.h / t.h);
      var cx = chosen.x + chosen.w / 2, cy = chosen.y + chosen.h / 2;
      after = { x: cx - (t.x + t.w / 2) * s, y: cy - (t.y + t.h / 2) * s, w: product.width * s, h: product.height * s };
      visible = { x: cx - t.w * s / 2, y: cy - t.h * s / 2, w: t.w * s, h: t.h * s };
      var out = Math.max(0, -after.x, -after.y, after.x + after.w - canvas.width, after.y + after.h - canvas.height);
      if (out > 0.5) warnings.push('Контейнер выходит за холст на ' + Math.round(out) + ' px из-за прозрачных полей PNG. Если редактор этого не допускает — обрежьте поля у PNG.');
    } else {
      // PNG нет: контейнер занимает всю свободную область — картинка впишется целиком и встанет по центру.
      after = { x: chosen.x, y: chosen.y, w: chosen.w, h: chosen.h };
      var f = fitIn(chosen, aspect);
      visible = { x: chosen.x + (chosen.w - f.w) / 2, y: chosen.y + (chosen.h - f.h) / 2, w: f.w, h: f.h };
    }
    after = { x: round2(after.x), y: round2(after.y), w: round2(after.w), h: round2(after.h) };

    items.forEach(function (it) {
      if (it.info.role === 'soft' && it.info.box && intersects(it.info.box, visible)) {
        infos.push('Товар может зайти под «' + it.info.name + '» — это допустимо, проверьте читаемость в редакторе.');
      }
    });

    return {
      ok: true, layoutId: layoutId, layoutName: layout.name, sceneName: scene.placement && scene.placement.name,
      canvas: canvas, items: items, area: area, rects: rects, chosen: chosen,
      before: before, after: after, visible: visible, aspect: aspect, warnings: warnings, infos: infos, options: opts,
      mode: mass ? 'mass' : (product && product.trim ? 'trim' : 'container'), mass: mass
    };
  }

  function setProp(el, key, value) {
    var list = el.properties || (el.properties = []);
    for (var i = 0; i < list.length; i++) if (list[i].key === key) { list[i].value = value; return; }
    list.push({ key: key, value: value });
  }

  /*
   * Применяет расчёт к копии проекта. Исходный объект не меняется.
   * Возвращает { project, results[] }.
   */
  function applyToProject(project, layoutIds, options, product) {
    var copy = JSON.parse(JSON.stringify(project));
    var results = layoutIds.map(function (id) {
      var r = computeLayout(copy, id, options, product);
      if (r.ok) {
        var found = findLayout(copy, id);
        var target = (found.layout.elements || []).filter(function (e) { return e.type === 'product-image'; })[0];
        setProp(target, 'x', r.after.x);
        setProp(target, 'y', r.after.y);
        setProp(target, 'w', r.after.w);
        setProp(target, 'h', r.after.h);
      }
      return r;
    });
    return { project: copy, results: results };
  }

  var api = {
    VERSION: '33036895',
    DEFAULT_OPTIONS: DEFAULT_OPTIONS,
    ROLES: ROLES,
    TEXT_METRICS: TEXT_METRICS,
    resolveOptions: resolveOptions,
    layerKey: function (layoutId, index) { return layoutId + '/' + index; },
    listLayouts: listLayouts,
    computeLayout: computeLayout,
    applyToProject: applyToProject,
    analyzeProduct: analyzeProduct,
    freeRects: freeRects,
    classify: classify,
    propsOf: propsOf,
    paletteOf: paletteOf
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ProductCentering = api;
})(typeof window !== 'undefined' ? window : this);
