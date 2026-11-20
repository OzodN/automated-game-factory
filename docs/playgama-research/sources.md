# Реестр официальных источников исследования (Official Sources Registry)

> **Статус документа:** `VERIFIED`  
> **Дата последней верификации всех источников:** `2026-11-08`  
> **Методология:** В качестве нормативной базы для всех технических, рекламных, дистрибуционных и финансовых требований использованы **исключительно официальные ресурсы Playgama** (`wiki.playgama.com`, `github.com/Playgama/Bridge`, `playgama.com`, `developer.playgama.com`, `bridge.playgama.com`).

---

## 1. Общая документация, быстрый старт и модерация (`Playgama Wiki — Core & Requirements`)

| № | Официальный URL | Краткое описание содержимого | Статус | Дата проверки |
|---|---|---|---|---|
| 1 | https://wiki.playgama.com/playgama | Главная страница Playgama Wiki: обзор платформы, ключевые преимущества, примечание об отсутствии прямой публикации на Poki и CrazyGames. | `VERIFIED` | `2026-11-08` |
| 2 | https://wiki.playgama.com/playgama/llms.txt | Полный машиночитаемый индекс разделов документации Playgama Wiki. | `VERIFIED` | `2026-11-08` |
| 3 | https://wiki.playgama.com/playgama/quick-start | Пошаговое руководство быстрого старта: интеграция SDK, тестирование в QA Tool (`bridge.playgama.com`) и загрузка в Dashboard. | `VERIFIED` | `2026-11-08` |
| 4 | https://wiki.playgama.com/playgama/submitting-a-game | Регламент загрузки игры в Developer Dashboard, требования к иконкам, обложкам, скриншотам, видео и автоматической валидации билда. | `VERIFIED` | `2026-11-08` |
| 5 | https://wiki.playgama.com/playgama/game-requirements | Обзор структуры обязательных требований к играм при прохождении модерации Playgama. | `VERIFIED` | `2026-11-08` |
| 6 | https://wiki.playgama.com/playgama/game-requirements/technical-requirements | **Раздел 1 правил (`1.1–1.8`):** SDK (`1.1`), внешние сервисы и ссылки (`1.2`), лимиты архива `<= 300 MB` и RAM `< 2 GB` (`1.3`), управление и запрет `Esc` (`1.4–1.5`), адаптивность и квадрат `1:1` (`1.6`), стабильность и браузеры (`1.7–1.8`). | `VERIFIED` | `2026-11-08` |
| 7 | https://wiki.playgama.com/playgama/game-requirements/advertising-requirements | **Раздел 2 правил (`2.1–2.5`):** правила показа Interstitial (`2.1`), Rewarded (`2.2`, включая лимит 1 возрождения `2.2.4` и условие `rewarded` `2.2.5`), баннеров (`2.3`) и общие правила рекламы. | `VERIFIED` | `2026-11-08` |
| 8 | https://wiki.playgama.com/playgama/game-requirements/user-experience-requirements | **Раздел 3 правил (`3.1–3.5`):** экран загрузки (`3.1`), онбординг (`3.2`), звук и запрет процедурных Web Audio писков (`3.3.1–3.3.5`), прогрессия (`3.4`) и запрет обманных паттернов (`3.5`). | `VERIFIED` | `2026-11-08` |
| 9 | https://wiki.playgama.com/playgama/game-requirements/content-requirements | **Раздел 4 правил (`4.1–4.4`):** запрещённые темы (`4.1`), защита IP (`4.2`), запрет 100% сырых AI-игр и эмодзи в UI (`4.3.1–4.3.2`), запрет сбора персональных данных игроков (`4.4.1`). | `VERIFIED` | `2026-11-08` |
| 10 | https://wiki.playgama.com/playgama/game-requirements/localization-requirements | **Раздел 5 правил (`5.1.1–5.1.3`):** обязательность английского языка и автоматического определения языка через `bridge.platform.language`. | `VERIFIED` | `2026-11-08` |
| 11 | https://wiki.playgama.com/playgama/game-requirements/platform-specific-requirements | **Раздел 6 правил:** индивидуальные квоты партнёрских площадок (YouTube `<30 MB`/`<=8,000` files, MSN `<50 MB`, Facebook `<200 MB`/`<=500` files, Xiaomi `<100 MB`/`<15s`, GameSnacks `<15 MiB` initial, Yandex RU, Discord) и статус Poki/CrazyGames/VK/TikTok. | `VERIFIED` | `2026-11-08` |
| 12 | https://wiki.playgama.com/playgama/game-requirements/game-self-check | **Раздел 7 правил:** чеклист самопроверки перед отправкой игры на модерацию. | `VERIFIED` | `2026-11-08` |
| 13 | https://wiki.playgama.com/playgama/game-requirements/engine-specific-requirements | **Раздел 8 правил:** специфические настройки экспорта для Unity, Construct 3, Godot (отключение `SharedArrayBuffer`) и др. | `VERIFIED` | `2026-11-08` |

---

## 2. Документация Playgama Bridge SDK v2 (`wiki.playgama.com/playgama/bridge-sdk/*`)

| № | Официальный URL | Краткое описание содержимого | Статус | Дата проверки |
|---|---|---|---|---|
| 14 | https://wiki.playgama.com/playgama/bridge-sdk/getting-started | Обзор возможностей Playgama Bridge SDK v2 и сводная матрица поддержки модулей по всем платформам. | `VERIFIED` | `2026-11-08` |
| 15 | https://wiki.playgama.com/playgama/bridge-sdk/setup | Способы установки SDK: CDN (`v2/stable`), npm `@playgama/bridge` и Vite-плагин `@playgama/bridge/vite`. | `VERIFIED` | `2026-11-08` |
| 16 | https://wiki.playgama.com/playgama/bridge-sdk/config | Спецификация обязательного конфигурационного файла `playgama-bridge-config.json` и переопределений `platforms`. | `VERIFIED` | `2026-11-08` |
| 17 | https://wiki.playgama.com/playgama/bridge-sdk/api | Базовый API ядра `bridge`, `BridgeError` и полный перечень кодов ошибок `ERROR_CODE`. | `VERIFIED` | `2026-11-08` |
| 18 | https://wiki.playgama.com/playgama/bridge-sdk/platform | Модуль `bridge.platform`: язык, серверное время, сообщения жизненного цикла (`game_ready`, `gameplay_started`), пауза, звук, `isExternalLinksAllowed`. | `VERIFIED` | `2026-11-08` |
| 19 | https://wiki.playgama.com/playgama/bridge-sdk/device | Модуль `bridge.device`: определение `desktop`/`mobile`/`tablet`/`tv` и ориентации экрана. | `VERIFIED` | `2026-11-08` |
| 20 | https://wiki.playgama.com/playgama/bridge-sdk/player | Модуль `bridge.player`: профиль игрока, гостевой режим и опциональная авторизация. | `VERIFIED` | `2026-11-08` |
| 21 | https://wiki.playgama.com/playgama/bridge-sdk/storage | Модуль `bridge.storage`: чтение, запись, удаление и автоматическая синхронизация облачного и локального хранилища в v2. | `VERIFIED` | `2026-11-08` |
| 22 | https://wiki.playgama.com/playgama/bridge-sdk/advertisement | Обзор модуля `bridge.advertisement`. | `VERIFIED` | `2026-11-08` |
| 23 | https://wiki.playgama.com/playgama/bridge-sdk/advertisement/interstitial | Документация по Interstitial-рекламе и состояниям `INTERSTITIAL_STATE`. | `VERIFIED` | `2026-11-08` |
| 24 | https://wiki.playgama.com/playgama/bridge-sdk/advertisement/rewarded | Документация по Rewarded-рекламе и состояниям `REWARDED_STATE`. | `VERIFIED` | `2026-11-08` |
| 25 | https://wiki.playgama.com/playgama/bridge-sdk/advertisement/banner | Документация по классическим Sticky-баннерам (`showBanner` / `hideBanner`). | `VERIFIED` | `2026-11-08` |
| 26 | https://wiki.playgama.com/playgama/bridge-sdk/advertisement/advanced-banners | Документация по адаптивным HTML-баннерам (`showAdvancedBanners`), настраиваемым в `%` в `playgama-bridge-config.json`. | `VERIFIED` | `2026-11-08` |
| 27 | https://wiki.playgama.com/playgama/bridge-sdk/advertisement/adblock | Проверка блокировщиков рекламы через `bridge.advertisement.checkAdBlock()`. | `VERIFIED` | `2026-11-08` |
| 28 | https://wiki.playgama.com/playgama/bridge-sdk/payments | Модуль внутриигровых покупок `bridge.payments` (`purchase`, `consumePurchase`, `getCatalog`, `getPurchases`). | `VERIFIED` | `2026-11-08` |
| 29 | https://wiki.playgama.com/playgama/bridge-sdk/leaderboards | Модуль таблиц рекордов `bridge.leaderboards`. | `VERIFIED` | `2026-11-08` |
| 30 | https://wiki.playgama.com/playgama/bridge-sdk/achievements | Модуль достижений `bridge.achievements`. | `VERIFIED` | `2026-11-08` |
| 31 | https://wiki.playgama.com/playgama/bridge-sdk/social | Модуль социальных функций `bridge.social` (`share`, `inviteFriends`, `createPost`, `rate`, `addToFavorites`). | `VERIFIED` | `2026-11-08` |
| 32 | https://wiki.playgama.com/playgama/bridge-sdk/tasks | Модуль платформенных заданий `bridge.tasks`. | `VERIFIED` | `2026-11-08` |
| 33 | https://wiki.playgama.com/playgama/bridge-sdk/daily-rewards | Модуль ежедневных наград `bridge.dailyRewards`. | `VERIFIED` | `2026-11-08` |
| 34 | https://wiki.playgama.com/playgama/bridge-sdk/notifications | Модуль пуш-уведомлений `bridge.notifications`. | `VERIFIED` | `2026-11-08` |
| 35 | https://wiki.playgama.com/playgama/bridge-sdk/multiplayer | Модуль мультиплеера `bridge.multiplayer` (Beta). | `VERIFIED` | `2026-11-08` |
| 36 | https://wiki.playgama.com/playgama/bridge-sdk/cross-promo | Модуль кросс-промо `bridge.crossPromo`. | `VERIFIED` | `2026-11-08` |
| 37 | https://wiki.playgama.com/playgama/bridge-sdk/remote-config | Модуль удалённой конфигурации `bridge.remoteConfig`. | `VERIFIED` | `2026-11-08` |
| 38 | https://wiki.playgama.com/playgama/bridge-sdk/clipboard | Модуль буфера обмена `bridge.clipboard`. | `VERIFIED` | `2026-11-08` |
| 39 | https://wiki.playgama.com/playgama/bridge-sdk/analytics | Модуль кастомной аналитики `bridge.analytics.send()`. | `VERIFIED` | `2026-11-08` |
| 40 | https://wiki.playgama.com/playgama/bridge-sdk/changelog | Официальная история изменений Playgama Bridge SDK v2. | `VERIFIED` | `2026-11-08` |
| 41 | https://wiki.playgama.com/playgama/bridge-sdk/migration-v1-to-v2 | Официальное руководство по миграции с Playgama Bridge v1 на v2 (список breaking changes). | `VERIFIED` | `2026-11-08` |

---

## 3. Исходный код репозитория GitHub `Playgama/Bridge` (`v2.4.1`)

| № | Официальный URL | Краткое описание содержимого | Статус | Дата проверки |
|---|---|---|---|---|
| 42 | https://github.com/Playgama/Bridge | Официальный GitHub-репозиторий Playgama Bridge SDK (`v2.4.1`, релиз от `2026-11-05`). | `VERIFIED` | `2026-11-08` |
| 43 | https://github.com/Playgama/Bridge/blob/main/package.json | Метаданные пакета `@playgama/bridge@2.4.1`, точки экспорта (`.`, `./constants`, `./global`, `./vite`). | `VERIFIED` | `2026-11-08` |
| 44 | https://github.com/Playgama/Bridge/blob/main/src/PlaygamaBridge.ts | Главный класс-фасад SDK: загрузка конфига, выбор платформы, инициализация 17 модулей и `GameplayMilestoneTracker`. | `VERIFIED` | `2026-11-08` |
| 45 | https://github.com/Playgama/Bridge/blob/main/src/modules/advertisement/InterstitialController.ts | Реализация контроллера частоты Interstitial: зависимость от `onGameReady()` (`#initTime`), дефолтный `60s` cooldown и `configureAdFrequency`. | `VERIFIED` | `2026-11-08` |
| 46 | https://github.com/Playgama/Bridge/blob/main/src/modules/storage/StorageModule.ts | Реализация хранилища v2: `MemoryCache`, `OperationQueue`, авто-миграция `#migrateLocalToPlatformStorage()` и удаление при пустых строках. | `VERIFIED` | `2026-11-08` |
| 47 | https://github.com/Playgama/Bridge/blob/main/src/platform-bridges/YoutubePlatformBridge.ts | Исходный код адаптера YouTube Playables (`window.ytgame` v1: `firstFrameReady`, `gameReady`, `saveData`, `requestAd`, `sendScore`). | `VERIFIED` | `2026-11-08` |
| 48 | https://github.com/Playgama/Bridge/blob/main/src/platform-bridges/PlaygamaPlatformBridge.ts | Исходный код адаптера собственной площадки `playgama.com`. | `VERIFIED` | `2026-11-08` |
| 49 | https://github.com/Playgama/Bridge/blob/main/src/lib/bridge-config/types.ts | Строгие TypeScript-интерфейсы файла `playgama-bridge-config.json`. | `VERIFIED` | `2026-11-08` |
| 50 | https://github.com/Playgama/Bridge/blob/main/src/constants/errors.ts | Определения `BridgeError` и всех кодов `ERROR_CODE`. | `VERIFIED` | `2026-11-08` |

---

## 4. Руководства, FAQ, MCP Server, Юридические документы и Лендинги Playgama

| № | Официальный URL | Краткое описание содержимого | Статус | Дата проверки |
|---|---|---|---|---|
| 51 | https://wiki.playgama.com/playgama/faq/general | Общий FAQ: неэксклюзивность лицензии, запрет кастомных таймеров Interstitial, общие вопросы работы. | `VERIFIED` | `2026-11-08` |
| 52 | https://wiki.playgama.com/playgama/faq/submitting-a-game | FAQ по загрузке игры и подготовке билда. | `VERIFIED` | `2026-11-08` |
| 53 | https://wiki.playgama.com/playgama/faq/game-moderation | FAQ по срокам (3–5 рабочих дней) и процедуре модерации. | `VERIFIED` | `2026-11-08` |
| 54 | https://wiki.playgama.com/playgama/faq/payments-and-statistics | Финансовый FAQ: 50% на `playgama.com`/iframe-сети, тиры 70%/80%/90% на партнёрах, минимальный порог $100, SWIFT и крипто-выплаты. | `VERIFIED` | `2026-11-08` |
| 55 | https://wiki.playgama.com/playgama/faq/how-to-contact-the-playgama-team | Официальные контакты поддержки (`developer.success@playgama.com`, Discord, соцсети). | `VERIFIED` | `2026-11-08` |
| 56 | https://wiki.playgama.com/playgama/guides/performance-and-optimization | Целевые показатели производительности (`<5 MB` initial load, `<5s` TTI, 60 FPS, `<500 MB` mobile RAM, WebP/Opus). | `VERIFIED` | `2026-11-08` |
| 57 | https://wiki.playgama.com/playgama/guides/monetization | Руководство по лучшим практикам размещения Interstitial и Rewarded рекламы. | `VERIFIED` | `2026-11-08` |
| 58 | https://wiki.playgama.com/playgama/guides/intrinsic-ads | Документация по внутримировой нативной рекламе (`@playgama/ads`). | `VERIFIED` | `2026-11-08` |
| 59 | https://wiki.playgama.com/playgama/guides/platform-launch | Руководство по запуску и отслеживанию статусов игры на партнёрских площадках во вкладке `Platforms`. | `VERIFIED` | `2026-11-08` |
| 60 | https://wiki.playgama.com/playgama/mcp | Документация по подключению к официальному **Playgama MCP Server** (`https://developer.playgama.com/api/mcp`). | `VERIFIED` | `2026-11-08` |
| 61 | https://wiki.playgama.com/playgama/mcp/tools | Справочник всех 14 MCP-инструментов Playgama (включая `upload_build`, `submit_game_version`, `get_games_analytics`). | `VERIFIED` | `2026-11-08` |
| 62 | https://playgama.com/publish-your-game-on-youtube-playables/ | Официальный лендинг публикации на YouTube Playables через Playgama (200+ игр, 125M+ plays, 2–4 недели сертификация, 75%/25% revenue split). | `VERIFIED` | `2026-11-08` |
| 63 | https://playgama.com/how-to-publish-game-on-msn | Официальный лендинг публикации игр на MSN / Microsoft Start через Playgama (отбор 2–4 игр в месяц). | `VERIFIED` | `2026-11-08` |
| 64 | https://playgama.com/termsofuse | Пользовательское соглашение Playgama (`LeadToChanges L.L.C-FZ`, Дубай, ОАЭ; ред. `07.10.2026`, включая санкционную оговорку п. `3.6`). | `VERIFIED` | `2026-11-08` |
| 65 | https://playgama.com/license | Лицензионное соглашение Playgama (неэксклюзивность, сохранение IP, право сублицензирования партнёрам). | `VERIFIED` | `2026-11-08` |
| 66 | https://playgama.com/confidential | Политика конфиденциальности и обработки персональных данных Playgama. | `VERIFIED` | `2026-11-08` |
| 67 | https://developer.playgama.com/terms | Условия работы личного кабинета разработчика (`Playgama Developer Dashboard`). | `VERIFIED` | `2026-11-08` |
| 68 | https://bridge.playgama.com | Официальный интерактивный инструмент тестирования **Playgama QA Tool**. | `VERIFIED` | `2026-11-08` |
