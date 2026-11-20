# 05. Матрица партнёрской дистрибуции Playgama (Partner Distribution Matrix — Deliverable E)

> **Статус документа:** `VERIFIED`  
> **Дата последней верификации:** `2026-11-08`  
> **Модель дистрибуции:** 100% через единое окно Playgama (без регистрации в сторонних девелоперских порталах)  
> **Первичные источники:**  
> - [6. Platform-Specific Requirements](https://wiki.playgama.com/playgama/game-requirements/platform-specific-requirements)  
> - [Platform Launch Guide](https://wiki.playgama.com/playgama/guides/platform-launch)  
> - [Playgama Wiki — Introduction (`readme.md`)](https://wiki.playgama.com/playgama)  
> - [Submitting a Game](https://wiki.playgama.com/playgama/submitting-a-game)  
> - [Publish on YouTube Playables](https://playgama.com/publish-your-game-on-youtube-playables/)  
> - [How to Publish Game on MSN](https://playgama.com/how-to-publish-game-on-msn)  
> - [Исходный код `src/constants/platformId.ts` и `src/platform-bridges/*`](https://github.com/Playgama/Bridge/tree/main/src/platform-bridges)

---

## 1. Как устроена партнёрская дистрибуция внутри Playgama

Когда вы загружаете игру в **Playgama Developer Dashboard** и она проходит базовую модерацию Playgama:
1. Игра **немедленно** публикуется на флагманском портале `playgama.com` и становится доступной для встраивания в партнёрскую iframe-сеть из **100+ веб-порталов** (`VERIFIED`).
2. Во вкладке **Platforms** вашей игры в Dashboard отображается список партнёрских каналов и их индивидуальные статусы (`In Review`, `Published`, `Rejected`).
3. Playgama берёт на себя подготовку метаданных, инжект нативных загрузчиков, подачу заявки в кабинеты партнёров, прохождение сертификации и сбор выручки в единый кошелёк разработчика.

> [!IMPORTANT]
> **Критическое различие: «Поддержка в Bridge SDK» vs «Публикация силами Playgama»**  
> В коде `@playgama/bridge@2.4.1` зарегистрировано **25 идентификаторов `PLATFORM_ID`** (включая тестовые `mock` и `qa`). Однако не все площадки из SDK доступны для managed-публикации через Playgama:
> - **Активно публикуются через Playgama (`Managed Partner Distribution`):** `playgama`, `youtube`, `msn`, `microsoft_store`, `facebook`, `yandex` (включая Playhop), `gamedistribution`, `xiaomi`, `discord`, `gamesnacks`, `y8`, `lagged`, `huawei`, `samsung`, `telegram`, `reddit`, `jio_games`, `dlightek` (Aha), `ok`.
> - **НЕ публикуются силами Playgama (`Direct-Only in SDK`):** **`poki`**, **`crazy_games`**, **`vk`** (`VERIFIED`: в документации прямо указано, что Playgama не публикует игры на этих трёх площадках самостоятельно).
> - **Поставлены на паузу (`Paused by Playgama`):** **`tiktok`** (`VERIFIED`: публикация приостановлена из-за низкого трафика).

---

## 2. Полная матрица партнёрской дистрибуции (Deliverable E)

### 2.1. Активные каналы дистрибуции через Playgama (`Managed by Playgama`)

| Platform (`PLATFORM_ID`) | Managed by Playgama? | Selection Process (Как игра попадает на площадку) | Technical Limits (Размер билда, файлы, загрузка) | Additional Requirements (Специфические правила площадки) | Monetization (Форматы дохода) | Verification Status | Official Source URL |
|---|---|---|---|---|---|---|---|
| **Playgama.com + 100+ Iframe Partner Sites** (`playgama`) | **Yes (Automatic)** | Автоматически сразу после прохождения базовой модерации Playgama (3–5 рабочих дней). | Архив **`<= 300 MB`**, пик RAM при старте **`< 2 GB`**, `index.html` в корне, только латиница в путях. | Соблюдение всех базовых правил `1.1–5.1`, наличие `playgama-bridge-config.json`. | Interstitial, Rewarded, Advanced Banners (`%`), Payments (Coins), Intrinsic Ads. (**50% Net Revenue**) | `VERIFIED` | https://wiki.playgama.com/playgama/game-requirements/technical-requirements |
| **YouTube Playables** (`youtube`) | **Yes (Curated Pitch)** | Кураторы Playgama отбирают игры с лучшими метриками и качеством, питчат их команде YouTube и сопровождают 2–4 недельную сертификацию (YouTube Test Suite). | Initial build size **`< 30 MB`**, количество файлов **`<= 8,000`**, имена файлов строго `[a-zA-Z0-9._-]`. | Поддержка **обеих ориентаций** (Portrait + Landscape) **без чёрных полос по краям**, облачное сохранение `< 1 MB` (`ytgame.game`), мгновенное глушение звука при паузе/сворачивании, 0 внешних ссылок. | Interstitial Ads, Rewarded Ads (в рамках YouTube Playables Monetization Pilot). (**75% Dev / 25% PG** или **70%–90%**; см. Раздел 06) | `VERIFIED` | https://wiki.playgama.com/playgama/game-requirements/platform-specific-requirements <br/> https://playgama.com/publish-your-game-on-youtube-playables/ |
| **MSN / Microsoft Start** (`msn`) | **Yes (Curated Pitch)** | Курируемый отбор: Microsoft утверждает **2–4 игры в месяц** от партнёра. Отбираются отполированные казуальные/головоломочные игры с высоким Retention. | Размер билда **`< 50 MB`**. | Рекомендуется **Landscape** ориентация (основной трафик — десктоп Windows / Edge), высокое качество UI и отсутствие AI-артефактов. | Interstitial, Rewarded, Sticky Banner, Advanced Banners, Payments (IAP). (**70%–90% Net Revenue**) | `VERIFIED` | https://wiki.playgama.com/playgama/game-requirements/platform-specific-requirements <br/> https://playgama.com/how-to-publish-game-on-msn |
| **Microsoft Store** (`microsoft_store`) | **Yes (Managed)** | Синдикация одобренных игр в каталог приложений экосистемы Windows через Playgama. | Базовые лимиты Playgama (рекомендуется **`< 50–100 MB`**). | Полная поддержка управления мышью/клавиатурой на Windows Desktop и корректный ресайз окна. | Interstitial, Rewarded, Sticky Banner, Payments (IAP). (**70%–90% Net Revenue**) | `VERIFIED` | https://wiki.playgama.com/playgama/guides/platform-launch |
| **Facebook Gaming** (`facebook`) | **Yes (Play Lab → Play Tab)** | Двухэтапный запуск: сначала игра публикуется в тестовом песочном каталоге **Play Lab**, при достижении целевых метрик удержания и монетизации переводится в основной каталог **Play Tab**. | Размер архива **`< 200 MB`**, жёсткий лимит количества файлов — **`<= 500 файлов`** в архиве! | Обязательна реализация **минимум 2 из 4 социальных/платформенных фич**: In-App Purchases (`payments`), Leaderboards, Multiplayer или Social (`share`/`inviteFriends`). | Interstitial, Rewarded, Sticky Banner, Payments (IAP). (**70%–90% Net Revenue**) | `VERIFIED` | https://wiki.playgama.com/playgama/game-requirements/platform-specific-requirements |
| **Playhop & Yandex Games** (`yandex`) | **Yes (Managed)** | Автоматическая/полуавтоматическая подача в международный каталог **Playhop** и витрину **Yandex Games** после модерации Playgama. | Базовый лимит **`<= 300 MB`** (рекомендуется `< 100 MB`). | 1) **Обязательна полная локализация на русский язык (`ru`)** и автоопределение `bridge.platform.language`; 2) минимум **10+ минут уникального геймплея**; 3) строгое соблюдение правил звука и паузы. | Interstitial, Rewarded, Sticky Banner, Payments (Yans), Leaderboards. (**70%–90% Net Revenue**) | `VERIFIED` | https://wiki.playgama.com/playgama/game-requirements/platform-specific-requirements |
| **GameDistribution** (`gamedistribution`) | **Yes (Managed)** | Подача в B2B-каталог GameDistribution силами релиз-команды Playgama. | До **`300 MB`** (рекомендуется `< 50 MB` для быстрой загрузки на сайтах-паблишерах). | Полное отсутствие внешних ссылок и sitelock-скриптов. | Interstitial, Rewarded, Sticky Banner. (**70%–90% Net Revenue**) | `VERIFIED` | https://wiki.playgama.com/playgama/guides/platform-launch |
| **Xiaomi Games** (`xiaomi`) | **Yes (Managed)** | Дистрибуция в мобильную экосистему устройств Xiaomi / MIUI / HyperOS. | Размер билда **`< 100 MB`**, время холодной загрузки до геймплея — **строго `< 15 секунд`**! | Фокус на **Android WebView**: безупречное сенсорное управление (touch), адаптация под вертикальные/горизонтальные экраны смартфонов, стабильные 30–60 FPS на среднем железе. | Interstitial, Rewarded, Sticky Banner. (**70%–90% Net Revenue**) | `VERIFIED` | https://wiki.playgama.com/playgama/game-requirements/platform-specific-requirements |
| **GameSnacks (Google)** (`gamesnacks`) | **Yes (Quarterly Pitch)** | Отбор игр раз в квартал совместно с командой Google GameSnacks (фокус на сверхлёгких гиперказуальных и пазл-играх для развивающихся рынков и Android). | Общий размер билда **`< 100 MB`**, начальная загрузка (Initial Load) **`< 15 MiB`**, размер любого отдельного файла **`< 10 MiB`**! | Предпочтительна портретная ориентация (**`9:16`**) или адаптивная вёрстка, мгновенный старт в геймплей, работа при медленном 3G/4G соединении. | Interstitial, Rewarded. (**70%–90% Net Revenue**) | `VERIFIED` | https://wiki.playgama.com/playgama/game-requirements/platform-specific-requirements |
| **Discord Activities** (`discord`) | **Yes (Curated / Feature-Gated)** | Отбор кооперативных, соревновательных и социальных игр для запуска внутри голосовых каналов Discord. | Рекомендуется **`< 50–100 MB`**. | **Обязательны** одновременно: 1) **Мультиплеер / Социальный геймплей** и 2) **Внутриигровые покупки (`bridge.payments`)**, так как на Discord нет классической Interstitial-рекламы. | Payments (IAP) + Rewarded Ads. (**70%–90% Net Revenue**) | `VERIFIED` | https://wiki.playgama.com/playgama/game-requirements/platform-specific-requirements |
| **Y8** (`y8`) | **Yes (Managed)** | Синдикация в каталог портала Y8 через аккаунт Playgama. | До **`300 MB`** (рекомендуется `< 50 MB`). | Поддержка десктопного и мобильного браузера; опционально таблицы лидеров и достижения Y8. | Interstitial, Rewarded. (**70%–90% Net Revenue**) | `VERIFIED` | https://wiki.playgama.com/playgama/guides/platform-launch |
| **Lagged** (`lagged`) | **Yes (Managed)** | Синдикация в каталог портала Lagged через Playgama. | До **`300 MB`** (рекомендуется `< 50 MB`). | Стандартные требования Playgama, опционально `leaderboards` и `achievements`. | Interstitial, Rewarded. (**70%–90% Net Revenue**) | `VERIFIED` | https://wiki.playgama.com/playgama/guides/platform-launch |
| **Huawei AppGallery / Quick Games** (`huawei`) | **Yes (Managed)** | Дистрибуция в облачный каталог быстрых игр Huawei. | Рекомендуется **`< 50–100 MB`**. | Полная поддержка мобильного тач-управления Android / HarmonyOS WebView. | Interstitial, Rewarded, Sticky Banner, Payments. (**70%–90% Net Revenue**) | `VERIFIED` | https://wiki.playgama.com/playgama/guides/platform-launch |
| **Samsung Gaming Hub / Instant Plays** (`samsung`) | **Yes (Managed / Curated)** | Подача в мобильный игровой хаб устройств Samsung Galaxy. | Рекомендуется **`< 50–100 MB`**. | Безупречный мобильный UX, отсутствие подвисаний при переключении контекста. | Interstitial, Rewarded, Sticky Banner, Payments. (**70%–90% Net Revenue**) | `VERIFIED` | https://wiki.playgama.com/playgama/guides/platform-launch |
| **Telegram Mini Apps** (`telegram`) | **Yes (Managed)** | Публикация в экосистеме игровых ботов/каталогов Telegram через Playgama. | Рекомендуется **`< 30–50 MB`** для быстрой загрузки в мобильном Telegram WebView. | Портретная или адаптивная ориентация, учёт системного хедера Telegram Mini App. | Interstitial & Rewarded (через Adsgram интеграцию в Bridge), Payments (Telegram Stars). (**70%–90% Net Revenue**) | `VERIFIED` | https://wiki.playgama.com/playgama/guides/platform-launch |
| **Reddit Games / Developer Platform** (`reddit`) | **Yes (Managed / Pilot)** | Запуск игр внутри сообществ Reddit через адаптер `RedditPlatformBridge`. | Строгие ограничения песочницы Devvit (рекомендуется **`< 30–50 MB`**). | Монетизация строится вокруг микротранзакций (`bridge.payments`), так как внешние рекламные скрипты ограничены CSP Reddit. | Payments (Reddit Gold / IAP). (**70%–90% Net Revenue**) | `VERIFIED` | https://github.com/Playgama/Bridge/blob/main/src/platform-bridges/RedditPlatformBridge.ts |
| **JioGames** (`jio_games`) | **Yes (Managed)** | Дистрибуция в крупнейшую телеком-экосистему Индии (Jio Mobile & Set-Top Box). | Рекомендуется **`< 30–50 MB`**. | Оптимизация под бюджетные Android-устройства и медленные сети (`PERF-1`–`PERF-4`). | Interstitial, Rewarded, Sticky Banner. (**70%–90% Net Revenue**) | `VERIFIED` | https://github.com/Playgama/Bridge/blob/main/src/platform-bridges/JioGamesPlatformBridge.ts |
| **Dlightek / Aha Games** (`dlightek`) | **Yes (Managed)** | Дистрибуция в предустановленный игровой центр смартфонов Transsion (Tecno, Infinix, Itel). | Рекомендуется **`< 50 MB`**. | Оптимизация под мобильный Android WebView и тач-управление. | Interstitial, Rewarded, Sticky Banner. (**70%–90% Net Revenue**) | `VERIFIED` | https://github.com/Playgama/Bridge/blob/main/src/platform-bridges/DlightekPlatformBridge.ts |
| **OK (Одноклассники)** (`ok`) | **Yes (Managed)** | Социальная сеть ОК (веб + мобильное приложение). | До **`100–300 MB`**. | Наличие русской локализации (`ru`). | Interstitial, Rewarded, Sticky Banner, Payments. (**70%–90% Net Revenue**) | `VERIFIED` | https://github.com/Playgama/Bridge/blob/main/src/platform-bridges/OkPlatformBridge.ts |

---

### 2.2. Платформы, присутствующие в SDK, но НЕ публикуемые силами Playgama (`Excluded / Paused`)

| Platform (`PLATFORM_ID`) | Managed by Playgama? | Официальная причина отсутствия управляемой публикации | Статус верификации | Официальный источник |
|---|---|---|---|---|
| **Poki** (`poki`) | **No (`Direct-Only`)** | *"We don’t publish games on Poki and Crazygames ourselves, but you can try uploading the game there directly with our SDK integrated."* (В рамках выбранной стратегии «только через Playgama» канал не используется). | `VERIFIED` | https://wiki.playgama.com/playgama <br/> https://wiki.playgama.com/playgama/game-requirements/platform-specific-requirements |
| **CrazyGames** (`crazy_games`) | **No (`Direct-Only`)** | Аналогично Poki: Playgama не выступает паблишером на CrazyGames; адаптер `CrazyGamesPlatformBridge` в SDK предназначен только для тех, кто загружает билд вручную. | `VERIFIED` | https://wiki.playgama.com/playgama/game-requirements/platform-specific-requirements |
| **VK Play / ВКонтакте** (`vk`) | **No (`Not Published`)** | *"Playgama currently doesn't publish games on VK."* | `VERIFIED` | https://wiki.playgama.com/playgama/game-requirements/platform-specific-requirements |
| **TikTok** (`tiktok`) | **Paused (`Low Traffic`)** | *"At the moment, we've paused publishing games on TikTok due to low traffic."* | `VERIFIED` | https://wiki.playgama.com/playgama/game-requirements/platform-specific-requirements |

---

## 3. «Золотой стандарт» единого билда для максимального охвата всех площадок

Чтобы один и тот же ZIP-архив без пересборок прошёл базовую модерацию Playgama **и** удовлетворил квотам всех ключевых партнёров (включая **YouTube Playables**, **MSN**, **Facebook**, **Xiaomi**, **GameSnacks**, **Playhop/Yandex**), сборка должна проектироваться по формуле **наименьшего общего знаменателя лимитов**:

| Параметр сборки | Базовый лимит Playgama | Строгий лимит партнёров (Кто диктует) | Целевой стандарт нашей сборки (`Golden Build Target`) |
|---|---|---|---|
| **Общий размер распакованного архива** | `<= 300 MB` | **`< 30 MB`** (YouTube Playables initial build) | **`<= 25 MB`** (гарантированный запас под инжект SDK-обёрток) |
| **Размер стартовой загрузки (Initial Load до `game_ready`)** | Не лимитирован жёстко (`< 5 MB` rec.) | **`< 15 MiB`** (GameSnacks) | **`<= 4.5 MB`** |
| **Максимальный размер одного файла** | Не лимитирован жёстко | **`< 10 MiB`** (GameSnacks) | **`<= 5 MB`** на любой отдельный атлас/аудио/бандл |
| **Общее количество файлов в архиве** | Не лимитировано | **`<= 500 файлов`** (Facebook Gaming) / `<= 8,000` (YouTube) | **`<= 250 файлов`** (упаковка спрайтов в атласы и аудио-спрайты) |
| **Имена файлов и папок** | Латиница без пробелов | Строгий ASCII `[a-zA-Z0-9._-]` (YouTube Playables) | Только нижний регистр `[a-z0-9._-]`, относительные пути `./assets/...` |
| **Время холодного старта до геймплея** | `< 5–10 сек` (rec.) | **`< 15 секунд`** (Xiaomi) | **`<= 4 секунды`** на Fast 4G |
| **Ориентация и пропорции окна** | Любая + `1:1` квадрат | **Portrait + Landscape без чёрных полос** (YouTube Playables) | **Responsive Canvas (`100vw × 100vh`)** с адаптивным UI для `9:16`, `1:1` и `16:9` |
| **Языки локализации** | `en` (обязателен) | **`ru` обязателен** (Playhop / Yandex Games) | Минимум **`en` + `ru`** (оптимально `+ es, pt, de, fr, tr`) с автоопределением `bridge.platform.language` |
| **Платформенные фичи для охвата FB/Discord** | Save + Interstitial | **2 из 4 фич** для Facebook (`Leaderboards`, `Social`, `IAP`, `Multiplayer`) | Интеграция **`bridge.leaderboards`** + **`bridge.social`** (+ опционально `bridge.payments`) |
