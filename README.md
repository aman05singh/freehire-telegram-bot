# 🤖 Freehire Job Radar — 24/7 Telegram Job Search Bot

[![Node.js Version](https://img.shields.io/badge/Node.js-%3E%3D18.0.0-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Telegram Bot API](https://img.shields.io/badge/Telegram_Bot_API-Enabled-26A5E4?logo=telegram&logoColor=white)](https://core.telegram.org/bots/api)
[![Status](https://img.shields.io/badge/Status-24%2F7_Cloud_Live-success?style=flat-square)]()
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

An intelligent, interactive **Telegram Job Search Bot** providing instant mobile access to over **3.3 Million+ live IT vacancies** crawled directly from genuine employer Applicant Tracking Systems (**Workday, Greenhouse, Lever, Ashby, iCIMS**) — with **zero recruiter middlemen, zero dead links, and zero spam reposts**.

---

## 🌟 Why Freehire Job Radar?

Traditional job boards (LinkedIn, Indeed, aggregators) monetize by promoting sponsored agency posts, harvesting candidate resumes, and keeping stale "ghost jobs" active.

**Freehire Job Radar connects directly to the open [Freehire API](https://freehire.me)** to give job seekers:
* 🎯 **Direct ATS Links**: Every job includes an official application link sending you straight to the employer's authentic careers portal.
* ⚡ **Ghost Job & Repost Detection**: Automatically calculates posting age and flags reposted listings (`⚡ Fresh: Today` vs `⚠️ Repost / 2mo+ old`).
* 📱 **Seamless Mobile Interface**: Search, filter, paginate, and bookmark vacancies directly from your smartphone on Telegram.
* ☁️ **24/7 Always-On Cloud Architecture**: Built with automated keep-alive self-pinging for zero-cost, continuous hosting on Render.

---

## ✨ Key Features

| Feature | Description |
| :--- | :--- |
| **Interactive Pagination** | Seamless `[ ⬅️ Prev Page ]` and `[ Next Page ➡️ ]` navigation updating in-place without message flooding. |
| **Smart In-Line Filters** | Filter live results by **Work Mode** (Remote only), **Posting Date** (Last 24h, 7d, 14d), and **Seniority**. |
| **🏢 Company Deep-Dive** | `/company <name>` (e.g. `/company Spotify`, `/company Google`) shows company HQ, total open jobs, and one-tap listings. |
| **📊 Market Telemetry** | `/market` displays real-time global hiring trends and top in-demand skills (AI, Cloud, DevOps) across 480k+ companies. |
| **🧭 Category Hub** | `/browse` provides quick 1-tap categories: Frontend, Backend, AI/ML, DevOps, Mobile, and Worldwide Remote. |
| **⭐ Bookmarking System** | Tap `[ ☆ Save ]` on any job to save it to your bookmarks; review all saved positions anytime with `/saved`. |
| **🔄 24/7 Keep-Alive** | Includes an internal HTTP server and auto-pinger to prevent cloud free tiers from idling to sleep. |

---

## 🚀 Live Demo

You can try the live bot on Telegram:
👉 **[@FreehireRadarBot](https://t.me/FreehireRadarBot)**

---

## ⌨️ Bot Commands & Search Syntax

### Commands
* `/start` or `/menu` — Welcome menu with quick search shortcuts.
* `/search <query>` — Search for specific roles (e.g. `/search React Remote`).
* `/company <name>` — Look up company details and live job counts (e.g. `/company Spotify`).
* `/browse` — Interactive craft & category browser.
* `/filter` — Open the search filter configuration panel.
* `/market` — View live hiring statistics and top skill demand.
* `/saved` — View all your bookmarked vacancies.
* `/help` — Full command cheat sheet and pro tips.

### Natural Language Search
You can send plain messages directly to the bot:
* `python remote 7d` — Remote Python jobs posted within the last 7 days.
* `wordpress remote today` — Remote WordPress positions published today.
* `devops senior 14d` — Senior DevOps vacancies from the last 2 weeks.

---

## 🛠️ Architecture & Tech Stack

```
   Telegram App (User)
           ↕️  Telegram Bot API (Long-Polling & Webhooks)
  Node.js Bot Server (Render.com / Cloud)
     ├── HTTP Keep-Alive Engine (/ping @ 8 min interval)
     ├── In-Memory State & Session Management
     └── Freehire API Client (REST)
           ↕️
   Freehire Core Index (3.3M+ Postings across 120+ ATS Platforms)
```

* **Runtime**: Node.js (ES Modules, `>=18.0.0`)
* **Transport**: Native `fetch` with Telegram Bot API
* **Cloud Infrastructure**: Render Web Service (Free Tier) with automated keep-alive daemon
* **Data Provider**: [Freehire.me](https://freehire.me) Open API

---

## 📦 Local Setup & Deployment

### Prerequisites
* [Node.js](https://nodejs.org/) `>= 18.0.0`
* A Telegram Bot Token from [@BotFather](https://t.me/botfather)

### 1. Clone & Install
```bash
git clone https://github.com/aman05singh/freehire-telegram-bot.git
cd freehire-telegram-bot
npm install
```

### 2. Configure Environment
Set your bot token in your terminal or in a `.env` file:
```bash
export TELEGRAM_BOT_TOKEN="your_bot_token_here"
```

### 3. Run Locally
```bash
npm start
```

---

## ☁️ Deploying 24/7 on Render (Free)

1. Fork or create a repository with this code on GitHub.
2. Go to **[Render.com](https://render.com)** and create a **New Web Service**.
3. Connect your repository.
4. Set the following settings:
   * **Runtime**: `Node`
   * **Build Command**: `npm install`
   * **Start Command**: `node telegram-bot.mjs`
   * **Instance Type**: `Free`
5. In **Environment Variables**, add:
   * `TELEGRAM_BOT_TOKEN` = `your_token_from_botfather`
6. Click **Deploy Web Service**!

> [!TIP]
> To guarantee 100% continuous uptime without cold starts, add your Render URL (`https://your-app.onrender.com/ping`) to a free 5-minute pinger like [cron-job.org](https://cron-job.org) or [UptimeRobot](https://uptimerobot.com).

---

## 📄 License

This project is open-source and available under the [MIT License](LICENSE).

---

## 👏 Acknowledgments

* [strelov1/freehire](https://github.com/strelov1/freehire) for the incredible open-source ATS job aggregation platform and API.
* [Telegram Bot API](https://core.telegram.org/bots/api) for powering rich interactive inline keyboards and mobile UI.
