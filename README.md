# HomeSense Parser API

## Локальный запуск

```bash
npm install
npm start
```

Проверка:

```bash
curl http://localhost:3000/health
```

Парсинг:

```bash
curl -X POST http://localhost:3000/parse-newbuilding \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com"}'
```

## Render

Build Command:

```bash
npm install
```

Start Command:

```bash
npm start
```

После деплоя в Directual используй:

```js
const PARSER_API = "https://YOUR-SERVICE.onrender.com/parse-newbuilding";
```
