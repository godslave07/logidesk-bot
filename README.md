# LogiDesk Bot — Інструкція деплою

## Крок 1 — GitHub

1. Зайди на github.com → New repository
2. Назви: `logidesk-bot` → Create repository
3. Завантаж три файли: `index.js`, `package.json`, `.gitignore`
   (кнопка "uploading an existing file" на сторінці репозиторію)

## Крок 2 — Railway

1. Зайди на railway.app → Login with GitHub
2. New Project → Deploy from GitHub repo → вибери `logidesk-bot`
3. Railway сам задеплоїть

## Крок 3 — Змінні середовища (Variables)

В Railway → твій проект → Variables → Add:

| Назва | Значення |
|-------|----------|
| `TELEGRAM_TOKEN` | твій токен від BotFather |
| `ANTHROPIC_API_KEY` | твій ключ від claude.ai/settings/keys |
| `WEBHOOK_URL` | URL який дасть Railway (Settings → Domains) |

## Крок 4 — Домен

Railway → Settings → Networking → Generate Domain
Скопіюй URL (наприклад `logidesk-bot.up.railway.app`)
Встав його в WEBHOOK_URL (без слешу в кінці)

## Крок 5 — Активація webhook

Відкрий в браузері:
```
https://твій-домен.railway.app/setup
```
Повинно відповісти: `{"ok":true}`

## Готово! 🎉

Напиши боту будь-яку заявку і він відповість.
