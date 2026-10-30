# Центровка фото товара (DOOH)

Прототип автопозиционирования товара на баннере. Берёт JSON экспорта проекта DOOH и возвращает тот же JSON, где у контейнера «Фото товара» (`product-image`) пересчитаны `x`, `y`, `w`, `h`. Остальные поля не меняются.

Всё считается в браузере: JSON и PNG никуда не отправляются, сервер для расчёта не нужен.

## Файлы

- `index.html` — интерфейс.
- `engine.js` — ядро расчёта без DOM. Работает в браузере (`window.ProductCentering`) и в Node (`require('./engine.js')`).
- `config.example.json` — все настройки со значениями по умолчанию.

## Запуск у себя

Открыть `index.html` в браузере двойным кликом.

## Публикация на GitHub Pages

1. На github.com: **New repository** → имя, например `product-centering` → **Create repository**.
2. На странице репозитория: **uploading an existing file** → перетащить `index.html`, `engine.js`, `config.example.json`, `README.md` → **Commit changes**.
3. **Settings → Pages** → Source: **Deploy from a branch**, Branch: **main**, папка **/ (root)** → **Save**.
4. Через 1–2 минуты страница откроется по адресу `https://<логин>.github.io/product-centering/`.

На бесплатном аккаунте Pages работает только для публичных репозиториев: код и страница будут видны всем. Данных WB в файлах нет — встроенный пример обезличен.

## На своём сервере

Это статические файлы, подойдёт любой веб-сервер:

- `python3 -m http.server 8080` в папке с файлами → http://localhost:8080
- nginx: положить файлы в корень сайта.
- Docker: `docker run -d -p 8080:80 -v "$PWD":/usr/share/nginx/html:ro nginx:alpine`

## Ядро для разработчиков

```js
const fs = require('fs');
const sharp = require('sharp');            // npm i sharp — только для режима с PNG
const E = require('./engine.js');

(async () => {
  const project = JSON.parse(fs.readFileSync('layouts-import.json', 'utf8'));
  const layoutIds = E.listLayouts(project).filter(l => l.hasProduct).map(l => l.layoutId);

  // Без PNG: контейнер = самая крупная свободная область
  const cfg = JSON.parse(fs.readFileSync('config.json', 'utf8'));   // необязательно: можно передать {}
  const plain = E.applyToProject(project, layoutIds, cfg);

  // С PNG: нужен альфа-канал копии PNG до 256 px по длинной стороне
  const meta = await sharp('product.png').metadata();
  const { data, info } = await sharp('product.png')
    .resize({ width: 256, height: 256,   // = tuning.analysisSize
            fit: 'inside', withoutEnlargement: true })
    .ensureAlpha().extractChannel('alpha').raw()
    .toBuffer({ resolveWithObject: true });
  const analysis = E.analyzeProduct(data, info.width, info.height, meta.width, meta.height, cfg);
  const res = E.applyToProject(project, layoutIds, cfg, { width: meta.width, height: meta.height, analysis });

  fs.writeFileSync('layouts-import-centered.json', JSON.stringify(res.project, null, 2));
  res.results.forEach(r => console.log(r.layoutName, r.ok ? r.after : r.error));
})();
```

## Настройки

Все константы передаются снаружи третьим аргументом `computeLayout` / `applyToProject` (и в `analyzeProduct`). Полный объект со значениями по умолчанию — в `config.example.json`, в интерфейсе — «Параметры расчёта → Все настройки в JSON».

Правила слияния:
- передавать можно только нужные поля, остальное берётся по умолчанию;
- некорректное значение (не число, не true/false) игнорируется, остаётся значение по умолчанию; предупреждение попадает в `result.warnings` с префиксом «Настройки:»;
- неизвестные параметры верхнего уровня пропускаются с предупреждением;
- `E.resolveOptions(cfg)` возвращает итоговый объект и список предупреждений — удобно проверять конфиг до расчёта.

Основные параметры:

| Параметр | По умолчанию | Что делает |
|---|---|---|
| `margin` | 16 | Поле от краёв холста, px |
| `padding` | 8 | Отступ от элементов без PNG и для тонких частей товара, px |
| `clearance` | 40 | С PNG: воздух между массой товара и элементами, px |
| `fill` | 0.9 | С PNG: доля от максимально возможного размера |
| `thinCrop` | true | Тонкие части можно обрезать краем кадра |
| `thinRatio` | 0.22 | Порог «тонкой» части от толщины самой толстой |
| `anchor` | `auto` | Обрезанное фото: `auto` — определить по PNG (видимые пиксели на краю ≥ `tuning.cutEdgeMin`), `bottom` — всегда прижимать к низу, `none` — не учитывать |
| `disclaimerIsObstacle` | false | Дисклеймер — препятствие |
| `splitHeadlineIsSoft` | false | Под заголовок с `splitByProductImage` товар может заходить |
| `useSafeZones` | true | Учитывать `settings.safeZones` сцены |
| `widthFactors` | лого 1.7, скидка 2.5, CTA 2.07… | Ширина = коэффициент × высота, если в JSON нет `w` |
| `textMetrics` | `{}` | Переопределение метрик текста по типу: `{ charW, lineH, pad, placeholder }` |
| `tuning` | см. `config.example.json` | Внутренние константы алгоритма: допуски обрезки, «центр важнее размера» (`centerKeep` 0.8), баланс, размер копии PNG и др. |

### Какие слои учитываются

Роль слоя: `obstacle` — товар обходит, `soft` — товар может заходить под слой, `ignore` — не учитывается, `auto` — по умолчанию.

- `roles` — по типу элемента для всех лейаутов: `{ "disclaimer": "obstacle", "media": "ignore" }`.
- `layers` — для конкретного слоя, сильнее `roles`. Ключ — `id` элемента, `"<layoutId>/<индекс в elements>"` или `"<layoutId>/<тип>"`. Значение — роль или `true` / `false` (учитывать / не учитывать).

```json
{
  "roles": { "disclaimer": "obstacle" },
  "layers": {
    "6ae262a818f039ea9a541431/4": "ignore",
    "6ab276f5f49c22afc64c5db9/wb-logo": false
  }
}
```

Без настроек роли такие: фон, градиент, слайдшоу, служебные — не учитываются; дисклеймеры — `soft`; выключенные (`enabled: false`) — не учитываются; остальное — `obstacle`. Фото товара (`product-image`) всегда пересчитывается. В результате у каждого элемента есть `info.role`, `info.defaultRole` и `info.override`.

## Как считается

1. **Элементы.** Все элементы, кроме фона и служебных, — препятствия; дисклеймер — «мягкий», товар может заходить под него. Если в JSON нет ширины или высоты, размер оценивается: лого, скидка, «цена и кнопка» — по высоте, тексты — по кеглю и длине текста.
2. **Масса и тонкие части (с PNG).** Силуэт делится на плотную часть (щётка, корпус) и тонкие части (ручка, шнур). Тонкое — всё, что тоньше 22% самой толстой части.
3. **Размер.** Масса — как можно крупнее, но не ближе 40 px к элементам. Тонкие части не должны задевать элементы. Если по центру холста товар выходит не мельче 80% от максимума — он ставится по центру. Итог × 0,9 — запас воздуха.
4. **Обрезанное фото** (человек по пояс): обрезанный нижний край прижимается к низу холста и может уйти за него ещё на `tuning.anchorCrop` (20%) видимой высоты. Под элементы не заходит только верх силуэта — `tuning.anchorProtect` (45%: голова, лицо); ниже фото может уходить под цену, кнопку, бейджи.
5. **Место.** Ближе всего к вертикальной оси холста, где воздуха достаточно. По вертикали — ровные зазоры сверху и снизу, снизу чуть больше.
