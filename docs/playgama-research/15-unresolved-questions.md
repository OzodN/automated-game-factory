# 15. Открытые вопросы и готовое письмо в поддержку Playgama (Unresolved Questions & Support Inquiry — Deliverable J)

> **Статус документа:** `REQUIRES SUPPORT` / `UNVERIFIED`  
> **Дата последней верификации:** `2026-11-08`  
> **Официальные каналы связи с Playgama (`VERIFIED`):**  
> - Email поддержки разработчиков: **`developer.success@playgama.com`**  
> - Чат в личном кабинете: `https://developer.playgama.com`  
> - Официальное Discord-сообщество разработчиков: ссылка в [How to Contact the Playgama Team](https://wiki.playgama.com/playgama/faq/how-to-contact-the-playgama-team)

---

## 1. Реестр вопросов, не раскрытых полностью в публичной документации (Deliverable J)

В соответствии с правилом «не домысливать отсутствующие нормы», ниже сгруппированы все вопросы со статусами `REQUIRES SUPPORT` и `UNVERIFIED`, выявленные при перекрёстной сверке Wiki, лендингов и юридических документов Playgama.

### 1.1. Финансы, Revenue Share и YouTube Playables (`Revenue & YouTube`)
1. **Приоритет ставки Revenue Share для YouTube Playables (`75%` vs `70% / 80% / 90%`):**
   - На официальном лендинге `https://playgama.com/publish-your-game-on-youtube-playables/` указан фиксированный сплит **75% разработчику / 25% Playgama**, тогда как в `https://wiki.playgama.com/playgama/faq/payments-and-statistics` для партнёрских площадок указана прогрессивная шкала **70% / 80% / 90%** (до $1k / $1k–$10k / свыше $10k в месяц). Какая именно ставка применяется к доходу с YouTube Playables в 2026 году, и суммируется ли оборот YouTube с остальными партнёрами для расчёта тиров 80%/90%?
2. **Механика расчёта прогрессивных тиров 70% / 80% / 90%:**
   - Применяется ли повышенный процент (80% при `>= $1,000` и 90% при `>= $10,000`) ко **всей** партнёрской выручке за календарный месяц или только к сумме, превышающей порог (ступенчатая/маржинальная шкала)? Рассчитывается ли порог суммарно по всему аккаунту разработчика или по каждой игре отдельно?
3. **График закрытия отчётных периодов внешних партнёров:**
   - Каков точный регламентный срок (например, 15-е или 30-е число следующего месяца), когда в баланс кошелька Dashboard зачисляется подтверждённая выручка от YouTube Playables, MSN и Yandex Games?

### 1.2. Выплаты (`Payments`)
4. **Способы выплаты и KYC:**
   - Какова комиссия при выборе банковского перевода в сравнении с выплатой в криптовалюте (которая в FAQ помечена как *"upon request"*)?
   - Какие именно документы KYC/KYB требуются при первом выводе средств?

### 1.3. Партнёрский питчинг и сертификация (`Publishing & Partners`)
5. **Целевые бенчмарки для отбора на YouTube Playables и MSN:**
   - Какие конкретные пороговые значения метрик первой сессии на `playgama.com` (например, минимальное среднее время сессии в минутах, конверсия вех `30s → 300s`, Retention D1) использует релиз-команда Playgama для автоматического включения игры в питч-лист на YouTube Playables и MSN? Можно ли запросить ревью игры для YouTube Playables вручную через поддержку сразу после прохождения базовой модерации?

### 1.4. Технические квоты и аналитика (`Technical & Analytics`)
6. **Детализация рекламных метрик по плейсментам (`placement`):**
   - Отображается ли в разделе Analytics (или в выгрузке MCP `get_games_analytics`) разбивка eCPM и Fill Rate по конкретным строковым идентификаторам `placement`, переданным в `showInterstitial(placement)` и `showRewarded(placement)`?

---

## 2. Готовое к отправке письмо в поддержку Playgama (на английском языке)

Вы можете скопировать и отправить это письмо на **`developer.success@playgama.com`** (или в чат поддержки внутри `https://developer.playgama.com`):

```text
Subject: Pre-Publishing Technical & Financial Clarification (YouTube Playables, Revenue Tiers & Payouts)

Hello Playgama Developer Success Team,

We are preparing to launch our new HTML5 game exclusively through Playgama (integrated with Playgama Bridge SDK v2.4.1 and engineered specifically to meet both Playgama base requirements and YouTube Playables <30 MB / dual-orientation quotas).

After thoroughly reviewing the official Playgama Wiki, SDK v2 source code, and legal terms, we would appreciate your clarification on a few specific points not fully detailed in the public documentation:

1. YouTube Playables Revenue Share vs. Progressive Partner Tiers:
The official YouTube Playables landing page (https://playgama.com/publish-your-game-on-youtube-playables/) states a fixed 75% Developer / 25% Playgama revenue split, while the Payments FAQ (https://wiki.playgama.com/playgama/faq/payments-and-statistics) lists progressive partner tiers of 70% (<$1,000/mo), 80% ($1,000-$10,000/mo), and 90% (>$10,000/mo).
- Which revenue share model currently applies to YouTube Playables traffic?
- For the 70% / 80% / 90% tiers, is the higher percentage applied retroactively to the entire monthly partner net revenue or marginally to the amount above each threshold, and is the threshold calculated per developer account or per individual game?

2. Selection & Nomination Process for YouTube Playables and MSN:
- What target benchmark metrics on Playgama.com (e.g., average session duration, 30s-600s gameplay milestones, D1 retention, bounce rate) does your release team look for when nominating a title for YouTube Playables and MSN?
- Once our game passes initial Playgama moderation, can we proactively request a YouTube Playables nomination check from our release manager if the build already complies with all YouTube technical limits (<30 MB, <=8,000 files, portrait & landscape support with no black bars)?

3. Payouts:
- Which KYC/KYB documents are required for the first withdrawal?
- What are the fees or minimum recommended withdrawal amounts for bank transfers vs. requesting payouts in cryptocurrency as mentioned in the FAQ?
- Could you confirm the standard reporting/settlement timeline (e.g., Net 30 / Net 60) for when partner revenue from YouTube Playables, MSN, and Yandex/Playhop becomes available for withdrawal in the Dashboard balance?

4. Ad Placement Granularity in Analytics:
- Does the Developer Dashboard or MCP analytics API (`get_games_analytics`) break down ad impressions and revenue by the custom `placement` string passed to `bridge.advertisement.showInterstitial(placement)` and `showRewarded(placement)`?

Thank you very much for your time and support. We look forward to publishing with Playgama!

Best regards,
[Your Name / Studio Name]
[Your Playgama Developer Account Email]
```
