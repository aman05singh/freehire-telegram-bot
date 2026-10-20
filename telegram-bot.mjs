#!/usr/bin/env node
import http from 'node:http';

// Render Web Service requires binding to process.env.PORT for health checks
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Freehire Telegram Bot is running 24/7!');
}).listen(PORT, () => {
  console.log(`Health check server listening on port ${PORT}`);
});

const botToken = process.env.TELEGRAM_BOT_TOKEN;

if (!botToken) {
  console.error('ERROR: TELEGRAM_BOT_TOKEN environment variable is missing!');
  process.exit(1);
}

const TELEGRAM_API = `https://api.telegram.org/bot${botToken}`;

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
    badge = '⚡ Fresh';
  } else if (ageDays === 1) {
    ageText = 'Yesterday';
    badge = '⚡ Fresh';
  } else if (ageDays <= 7) {
    ageText = `${ageDays}d ago`;
    badge = '⚡ Fresh';
  } else if (ageDays <= 30) {
    ageText = `${ageDays}d ago`;
    badge = '⏳ Recent';
  } else {
    const months = Math.floor(ageDays / 30);
    ageText = `${ageDays}d ago (~${months}mo old)`;
    badge = '⚠️ Repost';
  }

  return `${dateFormatted || ''} (${ageText}) [${badge}]`;
}

async function searchJobs(queryText) {
  let isRemote = false;
  let maxDays = null;
  let cleanQuery = queryText;

  if (/\bremote\b/i.test(cleanQuery)) {
    isRemote = true;
    cleanQuery = cleanQuery.replace(/\bremote\b/gi, '').trim();
  }

  const daysMatch = cleanQuery.match(/\b(\d+)\s*d(ays)?\b/i);
  if (daysMatch) {
    maxDays = parseInt(daysMatch[1], 10);
    cleanQuery = cleanQuery.replace(/\b\d+\s*d(ays)?\b/gi, '').trim();
  } else if (/\btoday\b/i.test(cleanQuery)) {
    maxDays = 1;
    cleanQuery = cleanQuery.replace(/\btoday\b/gi, '').trim();
  } else if (/\bweek\b/i.test(cleanQuery)) {
    maxDays = 7;
    cleanQuery = cleanQuery.replace(/\bweek\b/gi, '').trim();
  }

  const fetchLimit = maxDays ? 25 : 6;
  const params = new URLSearchParams();
  if (cleanQuery) params.set('q', cleanQuery);
  params.set('limit', String(fetchLimit));
  if (isRemote) params.set('work_mode', 'remote');

  const apiUrl = `https://freehire.me/api/v1/jobs/search?${params.toString()}`;
  const res = await fetch(apiUrl);
  if (!res.ok) throw new Error(`Freehire API error: ${res.status}`);
  
  const data = await res.json();
  let jobs = data.data || [];

  if (maxDays != null) {
    jobs = jobs.filter((job) => {
      const d = job.posted_at ? new Date(job.posted_at) : null;
      const age = job.reality?.age_days != null 
        ? job.reality.age_days 
        : (d ? Math.floor((Date.now() - d.getTime()) / 86400000) : null);
      return age === null || age <= maxDays;
    });
  }

  return {
    total: data.meta?.total || jobs.length,
    jobs: jobs.slice(0, 5),
    isRemote,
    maxDays,
    query: cleanQuery || 'All jobs'
  };
}

async function sendMessage(chatId, text, replyMarkup = null) {
  const payload = {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  };
  if (replyMarkup) payload.reply_markup = replyMarkup;

  try {
    await fetch(`${TELEGRAM_API}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    console.error('Failed to send telegram message:', err.message);
  }
}

async function handleUpdate(update) {
  const msg = update.message;
  if (!msg || !msg.text) return;

  const chatId = msg.chat.id;
  const text = msg.text.trim();

  if (text === '/start' || text === '/help') {
    const welcome = `👋 <b>Welcome to Freehire Job Bot!</b>\n\n` +
      `Search <b>3.3M+ live IT jobs</b> directly from official company career sites & ATS portals (Greenhouse, Lever, Workday).\n\n` +
      `🔍 <b>How to search:</b>\n` +
      `Just send me any role, tech stack, or company:\n\n` +
      `• <code>python remote</code>\n` +
      `• <code>react developer 7d</code>\n` +
      `• <code>wordpress remote</code>\n` +
      `• <code>devops senior</code>\n` +
      `• <code>golang 14d</code>\n\n` +
      `<i>Tip: Add 'remote' for remote-only roles, or '7d' to see jobs posted in the last 7 days!</i>`;
    await sendMessage(chatId, welcome);
    return;
  }

  await sendMessage(chatId, `🔍 Searching live ATS listings for: <b>${text}</b>...`);

  try {
    const result = await searchJobs(text);

    if (result.jobs.length === 0) {
      await sendMessage(chatId, `❌ No active vacancies found matching "<b>${text}</b>".\n\nTry broader terms or widen your date filter.`);
      return;
    }

    const filters = [];
    if (result.isRemote) filters.push('🌐 Remote');
    if (result.maxDays) filters.push(`📅 Last ${result.maxDays}d`);
    const filterInfo = filters.length ? ` (${filters.join(', ')})` : '';

    let header = `✨ <b>Found ${result.total.toLocaleString()} vacancies</b> for <i>${result.query}</i>${filterInfo}:\n`;
    header += `Showing top ${result.jobs.length} roles straight from company ATS:`;
    await sendMessage(chatId, header);

    for (let i = 0; i < result.jobs.length; i++) {
      const job = result.jobs[i];
      const skills = (job.skills || []).slice(0, 5).join(', ');
      const location = job.location || (job.countries?.join(', ').toUpperCase()) || 'Location not specified';
      const remoteBadge = job.regions?.includes('worldwide') || job.location?.toLowerCase().includes('remote') ? ' 🌐 <b>[REMOTE]</b>' : '';
      const dateStr = formatPostingDate(job);

      let card = `<b>[${i + 1}] ${escapeHtml(job.title)}</b>${remoteBadge}\n`;
      card += `🏢 <b>Company:</b> ${escapeHtml(job.company || 'Unknown')}\n`;
      card += `📅 <b>Posted:</b> ${dateStr}\n`;
      card += `📍 <b>Location:</b> ${escapeHtml(location)}\n`;
      if (skills) card += `⚡ <b>Skills:</b> <code>${escapeHtml(skills)}</code>\n`;

      if (job.enrichment?.summary) {
        const smry = job.enrichment.summary.length > 150 ? job.enrichment.summary.slice(0, 147) + '...' : job.enrichment.summary;
        card += `📝 <i>${escapeHtml(smry)}</i>\n`;
      }

      const button = {
        inline_keyboard: [
          [
            {
              text: '🚀 Apply on Official Site',
              url: job.url
            }
          ]
        ]
      };

      await sendMessage(chatId, card, button);
    }
  } catch (err) {
    console.error('Search error:', err);
    await sendMessage(chatId, `⚠️ Error searching jobs: ${err.message}`);
  }
}

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function pollUpdates() {
  let offset = 0;
  console.log('🤖 Freehire Telegram Bot is running in the cloud...');

  while (true) {
    try {
      const res = await fetch(`${TELEGRAM_API}/getUpdates?offset=${offset}&timeout=25`);
      if (!res.ok) {
        console.error('Polling error:', res.status, res.statusText);
        await new Promise((r) => setTimeout(r, 5000));
        continue;
      }
      const data = await res.json();
      if (data.ok && Array.isArray(data.result)) {
        for (const update of data.result) {
          offset = update.update_id + 1;
          await handleUpdate(update);
        }
      }
    } catch (err) {
      console.error('Poll network error:', err.message);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

pollUpdates();
