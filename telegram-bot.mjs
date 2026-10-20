#!/usr/bin/env node
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

// --- Configuration & 24/7 Keep-Alive ---
const PORT = process.env.PORT || 10000;
const RENDER_EXTERNAL_URL = process.env.RENDER_EXTERNAL_URL || 'https://freehire-telegram-bot.onrender.com';

// HTTP Server for Render health checks & keep-alive pings
const server = http.createServer((req, res) => {
  if (req.url === '/ping' || req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ 
      status: 'active', 
      uptime_seconds: Math.floor(process.uptime()), 
      service: 'Freehire Job Radar Pro',
      timestamp: new Date().toISOString() 
    }));
  } else {
    res.writeHead(404);
    res.end();
  }
});

server.listen(PORT, () => {
  console.log(`[HTTP] Health check & Keep-alive server listening on port ${PORT}`);
});

// Self-ping every 8 minutes to prevent Render Free tier from sleeping
setInterval(async () => {
  try {
    const res = await fetch(`${RENDER_EXTERNAL_URL}/ping`);
    console.log(`[Keep-Alive] Pinged ${RENDER_EXTERNAL_URL}: ${res.status}`);
  } catch (err) {
    console.log(`[Keep-Alive] Ping note: ${err.message}`);
  }
}, 8 * 60 * 1000);

// Resolve Telegram Bot Token
let botToken = process.env.TELEGRAM_BOT_TOKEN;
if (!botToken) {
  const localConfigPath = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1')), 'telegram-config.json');
  if (fs.existsSync(localConfigPath)) {
    try {
      botToken = JSON.parse(fs.readFileSync(localConfigPath, 'utf8')).token;
    } catch (e) {}
  }
}

if (!botToken) {
  console.error('[Error] TELEGRAM_BOT_TOKEN is not configured!');
  process.exit(1);
}

const TELEGRAM_API = `https://api.telegram.org/bot${botToken}`;

// User State (Sessions, Filters, Bookmarks, and Active Page Cache)
const userSessions = new Map();

function getSession(chatId) {
  if (!userSessions.has(chatId)) {
    userSessions.set(chatId, {
      query: '',
      company_slug: null,
      page: 0,
      pageSize: 4,
      currentJobs: [], // Cache of jobs currently on screen [0, 1, 2, 3]
      savedListCache: [], // Cache for bookmarks screen
      filters: {
        work_mode: null,  // 'remote' or null
        maxDays: null,    // 1, 7, 14, 30, or null
        seniority: null,  // 'junior', 'mid', 'senior', 'lead', or null
        is_tech: null,    // null = all jobs (prevents query over-filtering)
      },
      saved: new Map(), // key: public_slug -> job object
    });
  }
  return userSessions.get(chatId);
}

// Helper: Format Date & Freshness Badges
function formatPostingDate(job) {
  const d = job.posted_at ? new Date(job.posted_at) : null;
  const dateFormatted = d ? d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : null;
  const ageDays = job.reality?.age_days != null 
    ? job.reality.age_days 
    : (d ? Math.floor((Date.now() - d.getTime()) / 86400000) : null);
  
  if (ageDays === null && !dateFormatted) return 'Date unknown';

  let ageText = '';
  let badge = '';

  if (ageDays === 0) {
    ageText = 'Today';
    badge = '⚡ Fresh: Today';
  } else if (ageDays === 1) {
    ageText = 'Yesterday';
    badge = '⚡ Fresh: 1d ago';
  } else if (ageDays <= 7) {
    ageText = `${ageDays}d ago`;
    badge = `⚡ Fresh: ${ageDays}d`;
  } else if (ageDays <= 14) {
    ageText = `${ageDays}d ago`;
    badge = `⏳ Recent: ${ageDays}d`;
  } else if (ageDays <= 30) {
    ageText = `${ageDays}d ago (~${Math.floor(ageDays / 7)}w)`;
    badge = `⏳ ${ageDays}d ago`;
  } else {
    const months = Math.floor(ageDays / 30);
    ageText = `${ageDays}d ago (~${months}mo old)`;
    badge = `⚠️ Repost / ${months}mo+`;
  }

  return `${dateFormatted || ''} (${ageText}) [${badge}]`;
}

// API Call: Search Freehire Live Database
async function searchFreehire(query, session, offset = 0, limit = 4) {
  const params = new URLSearchParams();
  if (query) params.set('q', query);
  params.set('limit', String(limit));
  params.set('offset', String(offset));

  if (session.company_slug) {
    params.set('company_slug', session.company_slug);
  }

  const { filters } = session;
  if (filters.work_mode) params.set('work_mode', filters.work_mode);
  if (filters.seniority) params.set('seniority', filters.seniority);
  if (filters.is_tech) params.set('is_tech', filters.is_tech);

  const apiUrl = `https://freehire.me/api/v1/jobs/search?${params.toString()}`;
  const res = await fetch(apiUrl);
  if (!res.ok) throw new Error(`Freehire API HTTP ${res.status}`);

  const data = await res.json();
  let jobs = data.data || [];

  if (filters.maxDays != null) {
    jobs = jobs.filter((job) => {
      const d = job.posted_at ? new Date(job.posted_at) : null;
      const age = job.reality?.age_days != null 
        ? job.reality.age_days 
        : (d ? Math.floor((Date.now() - d.getTime()) / 86400000) : null);
      return age === null || age <= filters.maxDays;
    });
  }

  return {
    total: data.meta?.total || jobs.length,
    jobs,
    offset,
    limit,
  };
}

// Telegram Helpers
async function callTelegram(method, payload) {
  try {
    const res = await fetch(`${TELEGRAM_API}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const json = await res.json();
    if (!json.ok) {
      console.error(`[Telegram API Error] ${method}:`, json.description);
    }
    return json;
  } catch (err) {
    console.error(`Telegram ${method} network error:`, err.message);
    return { ok: false, error: err.message };
  }
}

async function sendMessage(chatId, text, replyMarkup = null) {
  const payload = {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  };
  if (replyMarkup) payload.reply_markup = replyMarkup;
  return await callTelegram('sendMessage', payload);
}

async function editMessage(chatId, messageId, text, replyMarkup = null) {
  const payload = {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  };
  if (replyMarkup) payload.reply_markup = replyMarkup;
  return await callTelegram('editMessageText', payload);
}

async function answerCallback(callbackQueryId, text = null, showAlert = false) {
  const payload = { callback_query_id: callbackQueryId };
  if (text) {
    payload.text = text;
    payload.show_alert = showAlert;
  }
  return await callTelegram('answerCallbackQuery', payload);
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// --- View: Search Results with Index-Based Buttons (< 15 bytes) ---
function buildResultsView(result, session) {
  const { jobs, total, offset, limit } = result;
  session.currentJobs = jobs; // Save in session so buttons use safe index: save:0, save:1

  const currentPage = Math.floor(offset / limit) + 1;
  const totalPages = Math.ceil(total / limit) || 1;

  const titleHeader = session.company_slug 
    ? `🏢 Company Openings: <b>${escapeHtml(session.company_slug.toUpperCase())}</b>`
    : `💼 Search Results for <b>"${escapeHtml(session.query || 'All Jobs')}"</b>`;

  let text = `${titleHeader}\n`;

  const activeFilters = [];
  if (session.filters.work_mode) activeFilters.push(`🌐 ${session.filters.work_mode.toUpperCase()}`);
  if (session.filters.maxDays) activeFilters.push(`📅 Last ${session.filters.maxDays}d`);
  if (session.filters.seniority) activeFilters.push(`👔 ${session.filters.seniority.toUpperCase()}`);
  if (activeFilters.length) {
    text += `<i>Filters: ${activeFilters.join(' • ')}</i>\n`;
  }

  text += `📊 Found <b>${total.toLocaleString()}</b> openings • Page <b>${currentPage} of ${totalPages.toLocaleString()}</b>\n`;
  text += `━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;

  if (jobs.length === 0) {
    text += `❌ No vacancies found on this page matching your criteria.\nTry relaxing your filters or choosing a wider date range.`;
    const keyboard = {
      inline_keyboard: [
        [
          { text: '⚙️ Change Filters', callback_data: 'menu:filters' },
          { text: '🔄 Reset Filters', callback_data: 'filter:reset' }
        ],
        [
          { text: '🏠 Main Menu', callback_data: 'menu:start' }
        ]
      ]
    };
    return { text, keyboard };
  }

  const inlineKeyboard = [];

  jobs.forEach((job, index) => {
    const jobNum = offset + index + 1;
    const skills = (job.skills || []).slice(0, 5).join(', ');
    const location = escapeHtml(job.location || (job.countries?.join(', ').toUpperCase()) || 'Location not specified');
    const remoteBadge = job.regions?.includes('worldwide') || job.location?.toLowerCase().includes('remote') ? ' 🌐 <b>[REMOTE]</b>' : '';
    const dateStr = formatPostingDate(job);
    const isSaved = session.saved.has(job.public_slug);

    text += `<b>${jobNum}. ${escapeHtml(job.title)}</b>${remoteBadge}\n`;
    text += `🏢 <b>${escapeHtml(job.company || 'Unknown')}</b> • 📍 ${location}\n`;
    text += `📅 <i>${dateStr}</i>\n`;
    if (skills) text += `⚡ Skills: <code>${escapeHtml(skills)}</code>\n`;
    
    if (job.enrichment?.summary) {
      const summary = job.enrichment.summary.length > 140 
        ? job.enrichment.summary.slice(0, 137) + '...' 
        : job.enrichment.summary;
      text += `📝 <i>${escapeHtml(summary)}</i>\n`;
    }
    text += `\n`;

    // SHORT callback_data (e.g. save:0, save:1) -> strictly under 10 bytes!
    inlineKeyboard.push([
      { text: `🚀 Apply #${jobNum}`, url: job.url || 'https://freehire.me' },
      { text: isSaved ? `⭐ Saved #${jobNum}` : `☆ Save #${jobNum}`, callback_data: `save:${index}` }
    ]);
  });

  // Navigation row
  const navRow = [];
  if (currentPage > 1) {
    navRow.push({ text: '⬅️ Prev Page', callback_data: `page:${currentPage - 2}` });
  }
  navRow.push({ text: `📄 ${currentPage}/${totalPages}`, callback_data: 'noop' });
  if (currentPage < totalPages) {
    navRow.push({ text: 'Next Page ➡️', callback_data: `page:${currentPage}` });
  }

  inlineKeyboard.push(navRow);

  // Tools row
  inlineKeyboard.push([
    { text: '⚙️ Filters', callback_data: 'menu:filters' },
    { text: '⭐ My Bookmarks', callback_data: 'menu:saved' }
  ]);
  
  // Return to Main Menu row
  inlineKeyboard.push([
    { text: '🏠 Main Menu', callback_data: 'menu:start' },
    { text: '🧭 Categories', callback_data: 'menu:browse' }
  ]);

  return { text, keyboard: { inline_keyboard: inlineKeyboard } };
}

// --- View: Filter Menu ---
function buildFilterMenuView(session) {
  const { filters } = session;

  let text = `⚙️ <b>Search Filters Configuration</b>\n\n`;
  text += `Customize your search parameters below. Results will update automatically:\n\n`;
  text += `• <b>Work Mode:</b> ${filters.work_mode ? filters.work_mode.toUpperCase() : 'Any (Remote + Onsite)'}\n`;
  text += `• <b>Posted Within:</b> ${filters.maxDays ? `Last ${filters.maxDays} days` : 'Any time'}\n`;
  text += `• <b>Seniority Level:</b> ${filters.seniority ? filters.seniority.toUpperCase() : 'Any level'}\n\n`;
  text += `<i>Tap any button to toggle:</i>`;

  const keyboard = {
    inline_keyboard: [
      [
        { text: filters.work_mode === 'remote' ? '✅ Remote Only' : '🌐 Set Remote Only', callback_data: 'filter:mode:remote' },
        { text: filters.work_mode === null ? '✅ Any Mode' : '🏢 Any Mode', callback_data: 'filter:mode:any' },
      ],
      [
        { text: filters.maxDays === 1 ? '✅ Last 24h' : '📅 24 Hours', callback_data: 'filter:days:1' },
        { text: filters.maxDays === 7 ? '✅ Past 7d' : '📅 7 Days', callback_data: 'filter:days:7' },
        { text: filters.maxDays === 14 ? '✅ Past 14d' : '📅 14 Days', callback_data: 'filter:days:14' },
      ],
      [
        { text: filters.seniority === 'junior' ? '✅ Junior' : 'Junior', callback_data: 'filter:level:junior' },
        { text: filters.seniority === 'mid' ? '✅ Mid' : 'Mid', callback_data: 'filter:level:mid' },
        { text: filters.seniority === 'senior' ? '✅ Senior' : 'Senior', callback_data: 'filter:level:senior' },
      ],
      [
        { text: '🔄 Reset Filters', callback_data: 'filter:reset' },
        { text: '🔍 View Results', callback_data: 'page:0' },
      ],
      [
        { text: '🏠 Main Menu', callback_data: 'menu:start' }
      ]
    ]
  };

  return { text, keyboard };
}

// --- View: Browse Categories ---
function buildBrowseCategoriesView() {
  const text = `🧭 <b>Browse Top Tech Crafts & Fields</b>\n\n` +
    `Tap any craft below to immediately load live vacancies:`;

  const keyboard = {
    inline_keyboard: [
      [
        { text: '💻 Frontend (React/Vue/Svelte)', callback_data: 'quick:Frontend React' },
        { text: '⚙️ Backend (Python/Go/Java)', callback_data: 'quick:Backend Python' }
      ],
      [
        { text: '🤖 AI & Machine Learning', callback_data: 'quick:AI Machine Learning' },
        { text: '☁️ DevOps & Cloud (AWS/K8s)', callback_data: 'quick:DevOps Cloud' }
      ],
      [
        { text: '📱 Mobile (iOS/Android/Flutter)', callback_data: 'quick:Mobile developer' },
        { text: '🛡️ Cybersecurity', callback_data: 'quick:Cybersecurity' }
      ],
      [
        { text: '🌐 100% Worldwide Remote', callback_data: 'quick:Remote worldwide' },
        { text: '🎓 Junior & Internships', callback_data: 'quick:Junior intern' }
      ],
      [
        { text: '🏠 Main Menu', callback_data: 'menu:start' }
      ]
    ]
  };

  return { text, keyboard };
}

// --- View: Live Market Insights ---
async function buildInsightsView() {
  try {
    const [scaleRes, skillsRes] = await Promise.all([
      fetch('https://freehire.me/api/v1/stats/catalog'),
      fetch('https://freehire.me/api/v1/insights/skills?limit=6')
    ]);

    const scale = await scaleRes.json();
    const skills = await skillsRes.json();

    const stats = scale.data || {};
    const topSkills = skills.data || [];

    let text = `📊 <b>Global IT Hiring Market Pulse</b>\n`;
    text += `<i>Direct real-time metrics across 120+ ATS platforms:</i>\n\n`;
    text += `• <b>Live Open Postings:</b> ${(stats.open_jobs || 5800000).toLocaleString()}\n`;
    text += `• <b>Monitored Companies:</b> ${(stats.companies || 480000).toLocaleString()}\n`;
    text += `• <b>Supported ATS Platforms:</b> ${stats.ats_platforms || 124} (Greenhouse, Lever, Workday, etc.)\n\n`;
    text += `🔥 <b>Top Skills in Highest Open Demand:</b>\n`;

    topSkills.forEach((s, i) => {
      text += `${i + 1}. <b>${s.skill.toUpperCase()}</b>: ${(s.open_count || 0).toLocaleString()} open jobs\n`;
    });

    text += `\n<i>Every vacancy is verified straight from official corporate careers pages without recruiter reposts.</i>`;

    const keyboard = {
      inline_keyboard: [
        [
          { text: '🔍 Search Top Skill: AI', callback_data: 'quick:AI' },
          { text: '🔍 Search Cloud Jobs', callback_data: 'quick:Cloud' }
        ],
        [
          { text: '🏠 Main Menu', callback_data: 'menu:start' },
          { text: '🔙 Back to Search', callback_data: 'page:0' }
        ]
      ]
    };

    return { text, keyboard };
  } catch (err) {
    return {
      text: `📊 <b>Market Insights</b>\n\nUnable to fetch latest telemetry: ${err.message}`,
      keyboard: { inline_keyboard: [[{ text: '🏠 Main Menu', callback_data: 'menu:start' }]] }
    };
  }
}

// --- View: Bookmarked Jobs ---
function buildSavedJobsView(session) {
  const savedList = Array.from(session.saved.values());
  session.savedListCache = savedList; // Cache for unsave:0, unsave:1 callback

  if (savedList.length === 0) {
    return {
      text: `⭐ <b>Saved Bookmarks</b>\n\nYou haven't bookmarked any jobs yet.\nSearch for jobs and tap <b>☆ Save</b> on any card to keep track of roles you want to apply for!`,
      keyboard: {
        inline_keyboard: [
          [{ text: '🔍 Search Jobs Now', callback_data: 'quick:Python remote' }],
          [{ text: '🏠 Main Menu', callback_data: 'menu:start' }]
        ]
      }
    };
  }

  let text = `⭐ <b>Your Saved Jobs (${savedList.length})</b>\n\n`;
  const inlineKeyboard = [];

  savedList.forEach((job, index) => {
    text += `<b>${index + 1}. ${escapeHtml(job.title)}</b>\n`;
    text += `🏢 ${escapeHtml(job.company)} • 📍 ${escapeHtml(job.location || 'Remote')}\n\n`;

    // SHORT callback: unsave:0, unsave:1 -> under 10 bytes!
    inlineKeyboard.push([
      { text: `🚀 Apply #${index + 1}`, url: job.url || 'https://freehire.me' },
      { text: `🗑️ Remove`, callback_data: `unsave:${index}` }
    ]);
  });

  inlineKeyboard.push([
    { text: '🔍 Back to Search', callback_data: 'page:0' },
    { text: '🏠 Main Menu', callback_data: 'menu:start' }
  ]);

  return { text, keyboard: { inline_keyboard: inlineKeyboard } };
}

// --- Company Search Handler ---
async function handleCompanySearch(chatId, companyName) {
  try {
    const res = await fetch(`https://freehire.me/api/v1/companies?q=${encodeURIComponent(companyName)}&limit=3`);
    const data = await res.json();
    const companies = data.data || [];

    if (companies.length === 0) {
      await sendMessage(chatId, `🏢 No company profile found matching "<b>${escapeHtml(companyName)}</b>".\n\nTry searching by the job title instead!`, {
        inline_keyboard: [[{ text: '🏠 Main Menu', callback_data: 'menu:start' }]]
      });
      return;
    }

    const comp = companies[0];
    let text = `🏢 <b>${escapeHtml(comp.name)}</b>\n`;
    if (comp.tagline) text += `<i>${escapeHtml(comp.tagline)}</i>\n\n`;
    text += `• <b>Open Vacancies:</b> <b>${comp.job_count || 0}</b> live postings\n`;
    if (comp.industries?.length) text += `• <b>Industry:</b> ${comp.industries.join(', ')}\n`;
    if (comp.hq_country) text += `• <b>HQ:</b> ${comp.hq_country.toUpperCase()}\n`;

    const keyboard = {
      inline_keyboard: [
        [{ text: `🔍 View All ${comp.job_count} Jobs at ${comp.name}`, callback_data: `compjobs:${comp.slug.slice(0, 45)}` }],
        [{ text: '🏠 Main Menu', callback_data: 'menu:start' }]
      ]
    };

    await sendMessage(chatId, text, keyboard);
  } catch (err) {
    await sendMessage(chatId, `⚠️ Error searching company: ${err.message}`, {
      inline_keyboard: [[{ text: '🏠 Main Menu', callback_data: 'menu:start' }]]
    });
  }
}

// --- Main Message & Command Router ---
async function handleMessage(msg) {
  const chatId = msg.chat.id;
  const text = (msg.text || '').trim();
  const session = getSession(chatId);

  // Command: /start or /menu
  if (text === '/start' || text === '/menu') {
    const welcome = `👋 <b>Welcome to Freehire Job Radar Pro!</b>\n\n` +
      `Search <b>3.3M+ real IT jobs</b> crawled directly from company career portals (Workday, Greenhouse, Lever, Ashby, iCIMS).\n\n` +
      `💎 <b>Pro Features:</b>\n` +
      `• <b>Interactive Pagination:</b> Next & Prev page buttons\n` +
      `• <b>Custom Filters:</b> Remote only, 24h/7d posting date, Seniority\n` +
      `• <b>Company Search:</b> Type <code>/company Spotify</code>\n` +
      `• <b>Market Telemetry:</b> Type <code>/market</code> for top skill trends\n` +
      `• <b>Bookmarks:</b> Save interesting roles to review with <code>/saved</code>\n\n` +
      `⚡ <b>Quick Start:</b> Tap an option below or just type what role you want:`;

    const keyboard = {
      inline_keyboard: [
        [
          { text: '🐍 Python Remote', callback_data: 'quick:Python remote' },
          { text: '⚛️ React / Frontend', callback_data: 'quick:React frontend' },
        ],
        [
          { text: '🌐 WordPress', callback_data: 'quick:WordPress' },
          { text: '☁️ DevOps / Cloud', callback_data: 'quick:DevOps cloud' },
        ],
        [
          { text: '🧭 Browse Categories', callback_data: 'menu:browse' },
          { text: '📊 Market Insights', callback_data: 'menu:insights' },
        ],
        [
          { text: '⚙️ Configure Filters', callback_data: 'menu:filters' },
          { text: '⭐ My Bookmarks', callback_data: 'menu:saved' }
        ]
      ]
    };

    await sendMessage(chatId, welcome, keyboard);
    return;
  }

  // Command: /help
  if (text === '/help' || text === '/tools') {
    const help = `📖 <b>Freehire Job Radar — Command & Help Center</b>\n\n` +
      `<b>Search Commands:</b>\n` +
      `• <code>/search &lt;query&gt;</code> — Search for roles or skills\n` +
      `• <code>/company &lt;name&gt;</code> — Look up any company (e.g. <code>/company Google</code>)\n` +
      `• <code>/browse</code> — Browse crafts (Frontend, Backend, AI, Mobile)\n` +
      `• <code>/filter</code> — Set work mode (Remote/Onsite), posting date, seniority\n` +
      `• <code>/saved</code> — View your bookmarked jobs\n` +
      `• <code>/market</code> — View live hiring demand & top skills\n\n` +
      `💡 <b>Search Pro-Tips:</b>\n` +
      `You can type naturally without commands:\n` +
      `• <code>python remote 7d</code> (Remote Python jobs from past 7 days)\n` +
      `• <code>wordpress remote today</code> (Remote WordPress jobs posted today)\n` +
      `• <code>devops senior 14d</code> (Senior DevOps roles in last 2 weeks)\n\n` +
      `<i>Every apply link connects you straight to the authentic employer portal with zero recruiter middlemen!</i>`;

    const keyboard = {
      inline_keyboard: [
        [
          { text: '⚙️ Set Filters', callback_data: 'menu:filters' },
          { text: '🧭 Browse Categories', callback_data: 'menu:browse' }
        ],
        [
          { text: '🏠 Main Menu', callback_data: 'menu:start' }
        ]
      ]
    };

    await sendMessage(chatId, help, keyboard);
    return;
  }

  // Command: /company <name>
  if (text.startsWith('/company')) {
    const query = text.replace('/company', '').trim();
    if (!query) {
      await sendMessage(chatId, '🏢 Please provide a company name, e.g.:\n<code>/company Spotify</code>\n<code>/company Google</code>\n<code>/company Stripe</code>');
      return;
    }
    await handleCompanySearch(chatId, query);
    return;
  }

  // Command: /market or /insights
  if (text === '/market' || text === '/insights') {
    const view = await buildInsightsView();
    await sendMessage(chatId, view.text, view.keyboard);
    return;
  }

  // Command: /browse or /categories
  if (text === '/browse' || text === '/categories') {
    const view = buildBrowseCategoriesView();
    await sendMessage(chatId, view.text, view.keyboard);
    return;
  }

  // Command: /saved
  if (text === '/saved') {
    const view = buildSavedJobsView(session);
    await sendMessage(chatId, view.text, view.keyboard);
    return;
  }

  // Command: /filter
  if (text === '/filter' || text === '/filters') {
    const view = buildFilterMenuView(session);
    await sendMessage(chatId, view.text, view.keyboard);
    return;
  }

  // Regular Natural Text Query (e.g. "React developer remote 7d")
  let cleanText = text.replace(/^\/search\s*/i, '').trim();
  session.query = cleanText;
  session.company_slug = null;
  session.page = 0;

  // Auto-detect filters in free text
  if (/\bremote\b/i.test(cleanText)) session.filters.work_mode = 'remote';
  const daysMatch = cleanText.match(/\b(\d+)\s*d(ays)?\b/i);
  if (daysMatch) session.filters.maxDays = parseInt(daysMatch[1], 10);
  if (/\btoday\b/i.test(cleanText)) session.filters.maxDays = 1;
  if (/\bweek\b/i.test(cleanText)) session.filters.maxDays = 7;

  const statusMsg = await sendMessage(chatId, `🔍 Searching 3.3M+ live postings for: <b>${escapeHtml(cleanText)}</b>...`);

  try {
    const result = await searchFreehire(session.query, session, 0, session.pageSize);
    const view = buildResultsView(result, session);
    
    let editOk = false;
    if (statusMsg && statusMsg.result?.message_id) {
      const editRes = await editMessage(chatId, statusMsg.result.message_id, view.text, view.keyboard);
      if (editRes && editRes.ok) editOk = true;
    }

    if (!editOk) {
      await sendMessage(chatId, view.text, view.keyboard);
    }
  } catch (err) {
    console.error('Search error:', err);
    await sendMessage(chatId, `⚠️ Search error: ${err.message}`, {
      inline_keyboard: [[{ text: '🏠 Main Menu', callback_data: 'menu:start' }]]
    });
  }
}

// --- Callback Query Router ---
async function handleCallbackQuery(cbQuery) {
  const chatId = cbQuery.message.chat.id;
  const messageId = cbQuery.message.message_id;
  const data = cbQuery.data;

  const session = getSession(chatId);

  if (data === 'noop') {
    await answerCallback(cbQuery.id);
    return;
  }

  if (data === 'menu:start') {
    await answerCallback(cbQuery.id);
    const welcome = `👋 <b>Welcome to Freehire Job Radar Pro!</b>\n\n` +
      `Search <b>3.3M+ real IT jobs</b> crawled directly from company career portals (Workday, Greenhouse, Lever, Ashby, iCIMS).\n\n` +
      `⚡ <b>Quick Start:</b> Tap an option below or just type what role you want:`;

    const keyboard = {
      inline_keyboard: [
        [
          { text: '🐍 Python Remote', callback_data: 'quick:Python remote' },
          { text: '⚛️ React / Frontend', callback_data: 'quick:React frontend' },
        ],
        [
          { text: '🌐 WordPress', callback_data: 'quick:WordPress' },
          { text: '☁️ DevOps / Cloud', callback_data: 'quick:DevOps cloud' },
        ],
        [
          { text: '🧭 Browse Categories', callback_data: 'menu:browse' },
          { text: '📊 Market Insights', callback_data: 'menu:insights' },
        ],
        [
          { text: '⚙️ Configure Filters', callback_data: 'menu:filters' },
          { text: '⭐ My Bookmarks', callback_data: 'menu:saved' }
        ]
      ]
    };

    await editMessage(chatId, messageId, welcome, keyboard);
    return;
  }

  if (data === 'menu:browse') {
    await answerCallback(cbQuery.id);
    const view = buildBrowseCategoriesView();
    await editMessage(chatId, messageId, view.text, view.keyboard);
    return;
  }

  if (data === 'menu:insights') {
    await answerCallback(cbQuery.id, 'Loading market telemetry...');
    const view = await buildInsightsView();
    await editMessage(chatId, messageId, view.text, view.keyboard);
    return;
  }

  if (data.startsWith('compjobs:')) {
    const slug = data.replace('compjobs:', '');
    session.query = '';
    session.company_slug = slug;
    session.page = 0;
    await answerCallback(cbQuery.id, `Loading jobs...`);
    try {
      const result = await searchFreehire('', session, 0, session.pageSize);
      const view = buildResultsView(result, session);
      await editMessage(chatId, messageId, view.text, view.keyboard);
    } catch (err) {
      await editMessage(chatId, messageId, `⚠️ Error: ${err.message}`, {
        inline_keyboard: [[{ text: '🏠 Main Menu', callback_data: 'menu:start' }]]
      });
    }
    return;
  }

  if (data.startsWith('quick:')) {
    const query = data.replace('quick:', '');
    session.query = query;
    session.company_slug = null;
    session.page = 0;
    await answerCallback(cbQuery.id, `Searching for ${query}...`);
    try {
      const result = await searchFreehire(session.query, session, 0, session.pageSize);
      const view = buildResultsView(result, session);
      await editMessage(chatId, messageId, view.text, view.keyboard);
    } catch (err) {
      await editMessage(chatId, messageId, `⚠️ Error: ${err.message}`, {
        inline_keyboard: [[{ text: '🏠 Main Menu', callback_data: 'menu:start' }]]
      });
    }
    return;
  }

  // Pagination Handler
  if (data.startsWith('page:')) {
    const pageIndex = parseInt(data.replace('page:', ''), 10);
    session.page = pageIndex;
    const offset = pageIndex * session.pageSize;

    await answerCallback(cbQuery.id, `Loading page ${pageIndex + 1}...`);

    try {
      const result = await searchFreehire(session.query, session, offset, session.pageSize);
      const view = buildResultsView(result, session);
      await editMessage(chatId, messageId, view.text, view.keyboard);
    } catch (err) {
      await editMessage(chatId, messageId, `⚠️ Error: ${err.message}`, {
        inline_keyboard: [[{ text: '🏠 Main Menu', callback_data: 'menu:start' }]]
      });
    }
    return;
  }

  // Bookmark / Save Handler by Safe Index (save:0, save:1, etc.)
  if (data.startsWith('save:')) {
    const idx = parseInt(data.replace('save:', ''), 10);
    const job = session.currentJobs && session.currentJobs[idx];
    
    if (job) {
      if (session.saved.has(job.public_slug)) {
        session.saved.delete(job.public_slug);
        await answerCallback(cbQuery.id, 'Removed from saved jobs!');
      } else {
        session.saved.set(job.public_slug, job);
        await answerCallback(cbQuery.id, '⭐ Saved to bookmarks!');
      }

      // Re-render current results page with updated star
      const offset = session.page * session.pageSize;
      const result = await searchFreehire(session.query, session, offset, session.pageSize);
      const view = buildResultsView(result, session);
      await editMessage(chatId, messageId, view.text, view.keyboard);
    } else {
      await answerCallback(cbQuery.id, 'Job reference expired. Please search again.');
    }
    return;
  }

  // Remove Bookmark by Safe Index (unsave:0, unsave:1)
  if (data.startsWith('unsave:')) {
    const idx = parseInt(data.replace('unsave:', ''), 10);
    const job = session.savedListCache && session.savedListCache[idx];
    
    if (job) {
      session.saved.delete(job.public_slug);
      await answerCallback(cbQuery.id, 'Removed from saved jobs.');
    } else {
      await answerCallback(cbQuery.id, 'Done.');
    }

    const view = buildSavedJobsView(session);
    await editMessage(chatId, messageId, view.text, view.keyboard);
    return;
  }

  // Filter Menu Navigation
  if (data === 'menu:filters') {
    await answerCallback(cbQuery.id);
    const view = buildFilterMenuView(session);
    await editMessage(chatId, messageId, view.text, view.keyboard);
    return;
  }

  if (data === 'menu:saved') {
    await answerCallback(cbQuery.id);
    const view = buildSavedJobsView(session);
    await editMessage(chatId, messageId, view.text, view.keyboard);
    return;
  }

  // Filter Options Toggles
  if (data.startsWith('filter:')) {
    const parts = data.split(':');
    if (parts[1] === 'mode') {
      session.filters.work_mode = parts[2] === 'any' ? null : parts[2];
      await answerCallback(cbQuery.id, `Work mode: ${parts[2]}`);
    } else if (parts[1] === 'days') {
      session.filters.maxDays = parseInt(parts[2], 10);
      await answerCallback(cbQuery.id, `Date filter: last ${parts[2]} days`);
    } else if (parts[1] === 'level') {
      session.filters.seniority = parts[2];
      await answerCallback(cbQuery.id, `Seniority: ${parts[2]}`);
    } else if (parts[1] === 'reset') {
      session.filters = { work_mode: null, maxDays: null, seniority: null, is_tech: null };
      await answerCallback(cbQuery.id, 'All filters reset.');
    }

    const view = buildFilterMenuView(session);
    await editMessage(chatId, messageId, view.text, view.keyboard);
    return;
  }

  await answerCallback(cbQuery.id);
}

// --- Telegram Polling Engine ---
async function pollTelegram() {
  let offset = 0;
  console.log('🤖 Freehire Job Radar Pro is actively listening on Telegram...');
  console.log('• 24/7 Keep-Alive self-pinger active');
  console.log('• Pagination, Categories, Bookmarks & Main Menu buttons fully enabled');

  while (true) {
    try {
      const res = await fetch(`${TELEGRAM_API}/getUpdates?offset=${offset}&timeout=25`);
      if (!res.ok) {
        await new Promise((r) => setTimeout(r, 4000));
        continue;
      }

      const data = await res.json();
      if (data.ok && Array.isArray(data.result)) {
        for (const update of data.result) {
          offset = update.update_id + 1;
          if (update.message) {
            await handleMessage(update.message);
          } else if (update.callback_query) {
            await handleCallbackQuery(update.callback_query);
          }
        }
      }
    } catch (err) {
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

pollTelegram();
