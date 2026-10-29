# Центровка фото товара (DOOH)

Прототип автопозиционирования товара на баннере. Берёт JSON экспорта проекта DOOH и возвращает тот же JSON, где у контейнера «Фото товара» (`product-image`) пересчитаны `x`, `y`, `w`, `h`. Остальные поля не меняются.

Всё считается в браузере: JSON и PNG никуда не отправляются, сервер для расчёта не нужен.

## Файлы

- `index.html` — интерфейс.
- `engine.js` — ядро расчёта без DOM. Работает в браузере (`window.ProductCentering`) и в Node (`require('./engine.js')`).

## Запуск у себя

Открыть `index.html` в браузере двойным кликом.

## Публикация на GitHub Pages

1. На github.com: **New repository** → имя, например `product-centering` → **Create repository**.
2. На странице репозитория: **uploading an existing file** → перетащить `index.html`, `engine.js`, `README.md` → **Commit changes**.
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
  const plain = E.applyToProject(project, layoutIds, {});

  // С PNG: нужен альфа-канал копии PNG до 256 px по длинной стороне
  const meta = await sharp('product.png').metadata();
  const { data, info } = await sharp('product.png')
    .resize({ width: 256, height: 256, fit: 'inside', withoutEnlargement: true })
    .ensureAlpha().extractChannel('alpha').raw()
    .toBuffer({ resolveWithObject: true });
  const analysis = E.analyzeProduct(data, info.width, info.height, meta.width, meta.height, {});
  const res = E.applyToProject(project, layoutIds, {}, { width: meta.width, height: meta.height, analysis });

  fs.writeFileSync('layouts-import-centered.json', JSON.stringify(res.project, null, 2));
  res.results.forEach(r => console.log(r.layoutName, r.ok ? r.after : r.error));
})();
```

Параметры (третий аргумент, значения по умолчанию — `E.DEFAULT_OPTIONS`):

| Параметр | По умолчанию | Что делает |
|---|---|---|
| `margin` | 16 | Поле от краёв холста, px |
| `padding` | 8 | Отступ от элементов без PNG и для тонких частей товара, px |
| `clearance` | 40 | С PNG: воздух между массой товара и элементами, px |
| `fill` | 0.9 | С PNG: доля от максимально возможного размера |
| `thinCrop` | true | Тонкие части можно обрезать краем кадра, если масса станет крупнее в 1,5+ раза |
| `thinRatio` | 0.22 | Порог «тонкой» части от толщины самой толстой |
| `disclaimerIsObstacle` | false | Дисклеймер — препятствие (по умолчанию товар может заходить под него) |
| `useSafeZones` | true | Учитывать `settings.safeZones` сцены |

## Как считается

1. **Элементы.** Все элементы, кроме фона и служебных, — препятствия; дисклеймер — «мягкий», товар может заходить под него. Если в JSON нет ширины или высоты, размер оценивается: лого, скидка, «цена и кнопка» — по высоте, тексты — по кеглю и длине текста.
2. **Масса и тонкие части (с PNG).** Силуэт делится на плотную часть (щётка, корпус) и тонкие части (ручка, шнур). Тонкое — всё, что тоньше 22% самой толстой части.
3. **Размер.** Масса — как можно крупнее, но не ближе 40 px к элементам. Тонкие части не должны задевать элементы. Если по центру холста товар выходит не мельче 80% от максимума — он ставится по центру. Итог × 0,9 — запас воздуха.
4. **Место.** Ближе всего к вертикальной оси холста, где воздуха достаточно. По вертикали — ровные зазоры сверху и снизу, снизу чуть больше.
