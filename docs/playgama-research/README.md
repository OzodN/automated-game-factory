# Исполнительное резюме и навигатор спецификации Playgama (Executive Summary & Master Index)

> **Статус пакета документации:** `VERIFIED`  
> **Дата последней верификации:** `2026-11-08`  
> **Целевая версия SDK:** **Playgama Bridge SDK `v2.4.1`** (`@playgama/bridge@2.4.1`, релиз `2026-11-05`)  
> **Целевая модель дистрибуции:** Исключительно через единое окно **Playgama** (`Game Development → Playgama Bridge v2.4.1 → Playgama Developer Dashboard / MCP → QA → Moderation → Playgama.com & Managed Partner Network → Unified Payout`).

---

## Навигатор по полному комплекту из 17 документов (`docs/playgama-research/`)

| № | Документ | Назначение и ключевой Deliverable |
|---|---|---|
| 00 | [`README.md`](./README.md) | **Исполнительное резюме (Executive Summary)** — главные выводы по 8 ключевым направлениям исследования. |
| 01 | [`01-platform-overview.md`](./01-platform-overview.md) | Архитектура экосистемы Playgama (`LeadToChanges L.L.C-FZ`), 3 уровня дистрибуции, роль Bridge SDK, Dashboard, QA Tool и MCP Server. |
| 02 | [`02-technical-requirements.md`](./02-technical-requirements.md) | **Deliverable A:** Полная спецификация технических, UX, звуковых, AI и локализационных требований (`Rules 1.1–5.1` + Performance Targets). |
| 03 | [`03-bridge-sdk-reference.md`](./03-bridge-sdk-reference.md) | **Deliverable B:** Полный технический аудит `@playgama/bridge@2.4.1` (17 модулей, `playgama-bridge-config.json`, `BridgeError`, матрица 25 платформ, миграция `v1 → v2`). |
| 04 | [`04-advertising-and-monetization.md`](./04-advertising-and-monetization.md) | **Deliverable C:** Руководство по рекламе и монетизации (Interstitial, Rewarded, Sticky/Advanced Banners, Intrinsic Ads, IAP, устройство `InterstitialController.ts`, запреты). |
| 05 | [`05-partner-distribution.md`](./05-partner-distribution.md) | **Deliverable E:** Полная матрица партнёрских каналов Playgama (активные managed-каналы vs исключённые Poki/CrazyGames/VK/TikTok) и «Золотой стандарт» единого билда. |
| 06 | [`06-youtube-playables.md`](./06-youtube-playables.md) | **Deliverable F:** Специальное досье по выходу на **YouTube Playables** через Playgama (`< 30 MB`, `<= 8,000` файлов, 0 чёрных полос, `YoutubePlatformBridge.ts`, 75%/25% vs 70%–90%). |
| 07 | [`07-publishing-workflow.md`](./07-publishing-workflow.md) | **Deliverable D:** Пошаговый регламент публикации игры из 18 этапов (через веб-интерфейс Dashboard и через автоматизацию Playgama MCP Server). |
| 08 | [`08-moderation-and-qa.md`](./08-moderation-and-qa.md) | Методология трёхступенчатого QA, работа с песочницей `bridge.playgama.com` и таблица всех причин отклонения на модерации. |
| 10 | [`10-privacy-and-legal.md`](./10-privacy-and-legal.md) | Юридический аудит (`Terms of Use` от `07.10.2026`, `License Agreement`, сохранение 100% IP, неэксклюзивность, запрет сбора ПДн `4.4.1`, санкционный комплаенс). |
| 11 | [`11-analytics.md`](./11-analytics.md) | Телеметрия и аналитика: встроенный `GameplayMilestoneTracker` (`0s–600s`), метрики Dashboard/MCP (`get_games_analytics`) и кастомные воронки `bridge.analytics.send()`. |
| 12 | [`12-updates-and-maintenance.md`](./12-updates-and-maintenance.md) | Безопасный выпуск патчей (`create_new_game_version`) без остановки дохода, миграция схемы сохранений и автообновление CDN `v2/stable`. |
| 13 | [`13-technical-architecture.md`](./13-technical-architecture.md) | **Implementation Blueprint:** Готовая эталонная архитектура на TypeScript + Vite (`AudioController`, `SaveManager`, `AdManager`, `AdaptiveInput`, скрипт `validate-release.mjs`). |
| 14 | [`14-risk-register.md`](./14-risk-register.md) | **Deliverable I:** Полный реестр из 12 технических, рекламных, продуктовых и финансовых рисков с мерами превенции. |
| 15 | [`15-unresolved-questions.md`](./15-unresolved-questions.md) | **Deliverable J:** Список открытых вопросов (`REQUIRES SUPPORT`) и готовое письмо на английском языке для отправки на `developer.success@playgama.com`. |
| 16 | [`16-release-checklist.md`](./16-release-checklist.md) | **Deliverable H:** Практический предрелизный чеклист из 35 пунктов перед отправкой билда на модерацию. |
| 17 | [`sources.md`](./sources.md) | Полный реестр из 68 проверенных официальных источников Playgama с датой верификации `2026-11-08`. |

---

## 1. Как работает публикация игры исключительно через Playgama (`Executive Summary — Point 1`)

Модель «единого окна Playgama» полностью избавляет разработчика от необходимости регистрироваться в десятках сторонних девелоперских порталов:
1. Вы разрабатываете **один универсальный HTML5-билд** с интегрированным **`@playgama/bridge@2.4.1`** и файлом **`playgama-bridge-config.json`**.
2. Загружаете ZIP-архив и промо-материалы в **Playgama Developer Dashboard** (`developer.playgama.com`) или через **Playgama MCP Server** (`developer.playgama.com/api/mcp`).
3. После автоматической проверки сборки и ручной модерации (3–5 рабочих дней) игра **автоматически публикуется** на `playgama.com` и в сети из **100+ партнёрских iframe-сайтов**.
4. Далее релиз-команда Playgama самостоятельно синдицирует игру в открытые партнёрские каталоги (**Playhop / Yandex Games, GameDistribution, Xiaomi, Y8, Lagged, Huawei, Samsung, Telegram, Reddit, JioGames, Dlightek/Aha, OK**) и питчит игры с лучшими метриками на закрытые курируемые платформы (**YouTube Playables, MSN, Microsoft Store, Facebook Gaming, GameSnacks, Discord**).
5. **Важное ограничение (`VERIFIED`):** Playgama официально **не публикует** игры самостоятельно на **Poki**, **CrazyGames** и **VK**, а публикация на **TikTok** поставлена на паузу. Вся стратегия строится вокруг 19 активных каналов Playgama.

---

## 2. Самые важные технические ограничения (`Executive Summary — Point 2`)

Чтобы один и тот же билд без переделок прошёл и базовую модерацию Playgama, и жёсткую сертификацию партнёров (YouTube Playables, MSN, Facebook, Xiaomi, GameSnacks):
- **Квоты размера и файлов:** Базовый лимит Playgama — `<= 300 MB` (`Rule 1.3.1`), пик RAM при старте — `< 2 GB` (`Rule 1.3.3`). Однако для прохождения на **YouTube Playables** распакованный размер должен быть **`< 30 MB`** (`<= 8,000` файлов), а для **Facebook Gaming** — **`<= 500` файлов**. **Целевой стандарт сборки: `<= 25 MB` и `<= 250 файлов`.**
- **Обязательный `playgama-bridge-config.json` и `game_ready` (`Rules 1.1.1–1.1.2`):** В SDK v2 отсутствие `playgama-bridge-config.json` рядом с корневым `index.html` блокирует приёмку билда, а неотправленный сигнал `bridge.platform.sendMessage('game_ready')` полностью отключает показ Interstitial-рекламы и трекинг аналитики.
- **Строгая автономность (`Rules 1.2.4–1.2.7`):** 0 внешних сетевых запросов (никаких Google Fonts, внешних CDN или Google Analytics/Firebase), 0 проверок домена (`sitelock`) и полное скрытие любых внешних ссылок при `bridge.platform.isExternalLinksAllowed === false`.
- **Вёрстка и управление (`Rules 1.4–1.6`):** Полная поддержка Desktop + Mobile (с адаптивными подсказками по `bridge.device.type`), **полный запрет клавиши `Esc`** (`Rule 1.5.2`), подавление выделения текста и контекстного меню при долгом тапе (`Rule 1.4.5`), обязательная работа в **квадратном окне `1:1`** (`Rule 1.6.8`) и отсутствие чёрных полос при смене ориентации.
- **Качество звука и запрет «сырого AI» (`Rules 3.3.1–3.3.5`, `4.3.1–4.3.2`):** **Категорически запрещены процедурно синтезированные кодом звуки (осцилляторы Web Audio API)** и **системные эмодзи вместо иконок UI**. Звук обязан мгновенно замолкать при открытии рекламы, паузе платформы и сворачивании вкладки.

---

## 3. Самые важные рекламные ограничения (`Executive Summary — Point 3`)

- **Interstitial Ads (`Rules 2.1.1–2.1.4`):** Обязательны к интеграции. Вызывайте `bridge.advertisement.showInterstitial()` **на каждой логической паузе** (победа, поражение, возврат в меню). **Запрещено** писать собственные таймеры ограничения частоты в коде игры (контроллер `InterstitialController` в SDK сам выдерживает 60-секундный cooldown и слушает платформенный `configureAdFrequency`). Запрещено показывать Interstitial во время загрузки или посреди активного экшена.
- **Rewarded Ads (`Rules 2.2.1–2.2.6`):** Строго по инициативе игрока (opt-in по клику на кнопку с видео-иконкой). Возрождение (`Revive`) разрешено предлагать **не более 1 раза за попытку** (`Rule 2.2.4`). Награда начисляется **только** при получении события `REWARDED_STATE.REWARDED` (никогда по событию `'closed'` без `'rewarded'`, `Rule 2.2.5`).
- **Аудио-дисциплина во время рекламы (`Rule 2.1.3`):** При переходе любой рекламы в состояние `'opened'` игровой процесс и весь звук обязаны мгновенно ставиться на паузу.

---

## 4. Как игра попадает на YouTube Playables через Playgama (`Executive Summary — Point 4`)

1. Playgama — официальный партнёр-издатель YouTube Playables (200+ опубликованных игр, 125M+ запусков в месяц, участник Monetization Pilot).
2. После релиза игры на `playgama.com` кураторы отслеживают метрики первой сессии (`Bounce Rate`, вехи геймплея `30s–600s`, Retention) и номинируют лучшие игры в команду YouTube.
3. Интеграция с нативным `window.ytgame` уже полностью встроена в `YoutubePlatformBridge.ts` внутри `@playgama/bridge@2.4.1` (вызов `sendMessage('game_ready')` автоматически вызывает `ytgame.game.firstFrameReady()` и `gameReady()`, а `bridge.storage` прозрачно пишет в облачный `ytgame.game.saveData`).
4. Процесс сертификации в YouTube Test Suite занимает **2–4 недели** (само ревью YouTube — 3–7 рабочих дней). Главные условия прохождения: вес **`< 30 MB`**, работа в **Portrait + Landscape без чёрных полос**, мгновенная реакция на системную кнопку Mute в тулбаре YouTube и 0 внешних ссылок.

---

## 5. Как устроена монетизация и выплаты (`Executive Summary — Point 5`)

- **Распределение чистой выручки (Net Revenue Share):**
  - **50%** разработчику — с собственной витрины `playgama.com` и сети из 100+ iframe-сайтов (`VERIFIED`).
  - **70% / 80% / 90%** разработчику — прогрессивная шкала на партнёрских площадках в зависимости от месячного оборота (`< $1,000` / `$1,000–$10,000` / `> $10,000`; `VERIFIED`).
  - **75% разработчику / 25% Playgama** — специальный фиксированный сплит, заявленный на официальном лендинге YouTube Playables (`VERIFIED`, соотношение с прогрессивной сеткой включено в запрос поддержке).
- **Вывод средств:**
  - Плательщик: **LeadToChanges L.L.C-FZ** (Дубай, ОАЭ). Минимальный порог вывода — **$100 USD**.
  - Каналы выплат: банковский перевод и **криптовалюты** (по запросу через поддержку); актуальные условия — в [Payments FAQ](https://wiki.playgama.com/playgama/faq/payments-and-statistics). Налоговые и юридические вопросы своей юрисдикции разработчик решает самостоятельно.

---

## 6. Критические риски проекта (`Executive Summary — Point 6`)

1. **Забытый вызов `sendMessage('game_ready')`** → 100% отказ Interstitial-рекламы (`#initTime === null` в `InterstitialController`) и зависание сплэш-скрина на YouTube Playables.
2. **Использование процедурных Web Audio звуков или эмодзи-иконок** → 100% отказ на ручной модерации по правилам `3.3.2` и `4.3.2`.
3. **Неучтённый фоновый звук при открытии рекламы или сворачивании вкладки на iOS/Android** → возврат билда на модерации Playgama и YouTube Test Suite.
4. **Превышение лимита `< 30 MB` или отсутствие адаптации под `1:1` и `9:16` / `16:9` без чёрных полос** → блокировка выхода на YouTube Playables.
5. **Использование устаревших методов SDK v1 (`bridge.game`, `storage.defaultType`)** → падение игры в рантайме на SDK v2.4.1.

---

## 7. Что нужно уточнить у поддержки Playgama (`Executive Summary — Point 7`)

В файле [`15-unresolved-questions.md`](./15-unresolved-questions.md) подготовлено готовое письмо на английском языке для отправки на **`developer.success@playgama.com`** по 4 вопросам:
1. Применяется ли к YouTube Playables фиксированный сплит **75%/25%** с лендинга или прогрессивная шкала **70%/80%/90%** из FAQ, и как именно считаются пороги $1k / $10k (ретроактивно или ступенчато)?
2. Какие точные бенчмарки первой сессии на `playgama.com` нужны для быстрой номинации игры на YouTube Playables и MSN?
3. Какие документы KYC нужны для первого вывода средств и каковы комиссии банковского перевода и крипто-выплат?
4. Доступна ли в Dashboard разбивка рекламной выручки по кастомным строкам `placement`?

---

## 8. Практические рекомендации перед стартом разработки (`Executive Summary — Point 8`)

1. **Инициализируйте проект на базе архитектурного шаблона из [`13-technical-architecture.md`](./13-technical-architecture.md):** TypeScript + Vite + `@playgama/bridge@2.4.1` (`@playgama/bridge/vite`) с готовыми классами `AudioController`, `SaveManager`, `AdManager` и `AdaptiveInput`.
2. **Сразу подключите скрипт `scripts/validate-release.mjs` к команде `npm run build`**, чтобы автоматически контролировать квоту `< 25–30 MB`, `<= 500` файлов, чистые ASCII-пути и наличие `playgama-bridge-config.json`.
3. **Проектируйте камеру и UI под три референсных вьюпорта одновременно:** `375×812` (`9:16` Portrait), `600×600` (`1:1` Square) и `1920×1080` (`16:9` Landscape) с заливкой фона без чёрных полос.
4. **Заложите локализацию минимум на 2 языка со старта (`en` + `ru`)** с автоопределением `bridge.platform.language` — это сразу откроет и глобальные витрины (YouTube, MSN), и каталог Playhop / Yandex Games.
5. **Интегрируйте `bridge.leaderboards` и `bridge.social.share()`**, чтобы выполнить требование «2 из 4 социальных фич» для прохождения в каталог Facebook Gaming.
