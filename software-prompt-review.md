# Ревью репозитория `laneAlien/SoftwarePrompt`

> TypeScript CLI-приложение: образовательный ИИ-ассистент по криптотрейдингу с симуляцией рынка, техническим анализом, управлением рисками и опциональной LLM-интеграцией (OpenAI / DeepSeek). 140 коммитов.

---

## 1. Сводка приоритетов

| Приоритет | Что | Где |
|---|---|---|
| 🔴 High | `analyzeNewsBrief` не перехватывает ошибки API — падение без fallback | `llmClient.ts:analyzeNewsBrief()` |
| 🔴 High | `LLM_MODEL` не задан → `throw new Error` при инициализации без DeepSeek key | `llmClient.ts:constructor()` |
| 🔴 High | `xlsx` версии `^0.18.5` — устаревший пакет с известными уязвимостями (CVE-2023-30533) | `package.json` |
| 🟠 Med | `author: ""` в `package.json` — не заполнено | `package.json` |
| 🟠 Med | API-ключи могут попасть в git если `.env` не исключён | `.gitignore` |
| 🟠 Med | `node-telegram-bot-api` использует polling — не подходит для продакшн-бота | `package.json` |
| 🟠 Med | RSS-ссылки жёстко прописаны в `.softwarepromptrc.json` без возможности переопределить через env | `.softwarepromptrc.json` |
| 🟠 Med | `temperature: 0.7` задана константой для торговых решений — должна быть конфигурируемой | `llmClient.ts` |
| 🟡 Low | `max_tokens: 1000` — лимит может обрезать аналитический ответ | `llmClient.ts` |
| 🟡 Low | `console.warn` используется для логирования ошибок API — непоследовательно с остальным кодом | `llmClient.ts` |
| 🟡 Low | Нет Rate Limit handling для LLM API (retry при 429) | `llmClient.ts` |
| 🟡 Low | `ccxt ^4.2.0` — стоит зафиксировать минорную версию для стабильности | `package.json` |
| 🟡 Low | `report.json` присутствует в репозитории — выходной артефакт не должен быть в git | `report.json` |

---

## 2. Критические проблемы

### 2.1 `analyzeNewsBrief` без error handling

**Файл:** `llmClient.ts`

```typescript
async analyzeNewsBrief(items: NewsItem[]): Promise<...> {
  const response = await this.openai.chat.completions.create({...});
  // ← нет try/catch
  const content = response.choices[0]?.message?.content || '';
  ...
}
```

В отличие от `analyze()`, который имеет `try/catch` с fallback, `analyzeNewsBrief` пробрасывает исключение наружу. При ошибке API — вся программа падает. Добавить:

```typescript
async analyzeNewsBrief(items: NewsItem[]): Promise<...> {
  try {
    const response = await this.openai.chat.completions.create({...});
    ...
  } catch (error) {
    console.warn('News brief API call failed:', error);
    return { summary: 'News analysis unavailable', riskFlags: [], watch: [] };
  }
}
```

### 2.2 `throw new Error` при отсутствии `LLM_MODEL`

```typescript
if (!resolvedModel) {
  throw new Error('OpenAI model is not set. Define LLM_MODEL or use --no-llm.');
}
```

Это правильная валидация, но ошибка выбрасывается в конструкторе при инициализации. Если `--no-llm` флаг не передан, пользователь получает необработанное исключение без понятной инструкции. Добавить проверку CLI-флагов до инициализации клиента.

### 2.3 Уязвимый `xlsx` пакет

`xlsx@^0.18.5` содержит CVE-2023-30533 (прототипное загрязнение). Обновить на `exceljs` или `xlsx@^0.20.0` (SheetJS Community Edition):

```json
"exceljs": "^4.4.0"
```

---

## 3. Серьёзные замечания

### 3.1 Нет retry для Rate Limit (HTTP 429)

LLM API возвращает 429 при превышении лимита. Нужен exponential backoff:

```typescript
async _callWithRetry(fn: () => Promise<any>, maxRetries = 3): Promise<any> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (error: any) {
      if (error?.status === 429 && i < maxRetries - 1) {
        await new Promise(r => setTimeout(r, 2 ** i * 1000));
        continue;
      }
      throw error;
    }
  }
}
```

### 3.2 `temperature: 0.7` для торговых решений

Торговый анализ требует детерминированных ответов. `temperature: 0.7` добавляет случайность. Для финансовых рекомендаций лучше `temperature: 0` или `0.1`.

### 3.3 `node-telegram-bot-api` с polling

Polling-режим Telegram Bot API:
- Не масштабируется
- Не работает корректно при нескольких инстансах
- Добавляет задержку

Для продакшн рекомендуется webhook через `@grammyjs/web-fetch` или `telegraf`.

### 3.4 `report.json` в репозитории

Выходной файл с результатами анализа не должен быть в git. Добавить в `.gitignore`:
```
report.json
reports/
*.json.report
```

---

## 4. Качество кода

### 4.1 `author: ""` в package.json

```json
"author": "",  // Заполнить
```

### 4.2 API-ключи и `.env`

Убедиться что в `.gitignore` есть:
```
.env
.env.local
.env.*.local
```

Создать `.env.example`:
```
OPENAI_API_KEY=
DEEPSEEK_API_KEY=
LLM_MODEL=gpt-4o-mini
DEEPSEEK_MODEL=deepseek-chat
```

### 4.3 RSS hardcoded

```json
// .softwarepromptrc.json
"rss": ["https://cointelegraph.com/rss", ...]
```

RSS-источники лучше вынести в `.env` или позволить переопределять через CLI-флаг, чтобы пользователи могли добавлять свои источники без правки конфига.

---

## 5. Положительные стороны

- Грамотный dual-key механизм (OpenAI / DeepSeek) с автоопределением провайдера
- Fallback-ответ при ошибке `analyze()` — хорошая практика
- Богатый набор технических индикаторов (RSI, MACD, EMA, Bollinger Bands)
- Чёткое разделение на слои: `indicators/`, `strategies/`, `simulation/`, `llm/`, `ui/`
- Jest конфигурация готова — есть инфраструктура для тестов
- Явное образовательное позиционирование в документации

---

## 6. Чек-лист правок

- [ ] Добавить `try/catch` в `analyzeNewsBrief`
- [ ] Обновить `xlsx` → `exceljs` или `xlsx@^0.20.0`
- [ ] Добавить retry с backoff для Rate Limit ошибок
- [ ] Снизить `temperature` до `0` или `0.1` для торгового анализа
- [ ] Добавить `report.json` и `reports/` в `.gitignore`
- [ ] Заполнить `author` в `package.json`
- [ ] Создать `.env.example`
- [ ] Рассмотреть замену `node-telegram-bot-api` на `telegraf`
- [ ] Сделать RSS-источники конфигурируемыми через env/CLI
