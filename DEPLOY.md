# Как выложить приложение на fin.smeta.space

## 1. Ключи
Откройте `config.js` и вставьте:
- `url` — Project URL из Supabase (Project Settings → Data API);
- `key` — publishable-ключ (Project Settings → API Keys).
Secret / service_role ключ сюда не вставлять.

## 2. Репозиторий на GitHub
1. github.com → New repository → имя `fin` → **Public** → Create.
2. Add file → Upload files → перетащите все файлы этой папки (вместе с папкой `icons`,
   файлами `CNAME` и `.nojekyll`) → Commit changes.
   В этот репозиторий НЕ класть `seed.sql` и бэкапы базы.
3. Settings → Pages → Source: Deploy from a branch → Branch: `main`, папка `/ (root)` → Save.

## 3. Домен
1. У регистратора домена smeta.space добавьте DNS-запись:
   тип `CNAME`, имя `fin`, значение `ВАШ_ЛОГИН.github.io`.
2. GitHub → Settings → Pages → Custom domain: `fin.smeta.space` → Save.
3. Когда проверка DNS пройдёт (от минут до пары часов), включите **Enforce HTTPS**.

## 4. Supabase
Authentication → URL Configuration → Site URL: `https://fin.smeta.space`.

## 5. Установка на телефон
Откройте https://fin.smeta.space в Chrome на Android → меню ⋮ → «Установить приложение»
(или «Добавить на главный экран»). Войдите почтой и паролем пользователя из Supabase.

## Обновления
Меняете файлы в репозитории → через 1–2 минуты сайт обновлён.
Если изменили `styles.css`, `app.js` или `engine.js`, поменяйте в `sw.js` строку
`const CACHE = 'fin-v1'` на `fin-v2`, `fin-v3` и т. д., чтобы телефон точно подтянул новую версию.
