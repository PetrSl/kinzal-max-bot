require('dotenv').config();
const express = require('express');
const { Bot } = require('@maxhub/max-bot-api');
const axios = require('axios');
const ical = require('ical');

const app = express();
app.use(express.json());

app.get('/', (req, res) => res.send('KinZal MAX Bot is running'));

// Ôóíêöèÿ ïîëó÷åíèÿ çàíÿòûõ äàò (àíàëîãè÷íà VK)
async function getBusyDates() {
  if (process.env.ICAL_URL) {
    try {
      const response = await axios.get(process.env.ICAL_URL);
      const data = ical.parseICS(response.data);
      const busyDates = new Set();
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const thirtyDaysLater = new Date(today);
      thirtyDaysLater.setDate(thirtyDaysLater.getDate() + 30);

      for (let k in data) {
        if (data[k].type === 'VEVENT') {
          const start = new Date(data[k].start);
          const end = new Date(data[k].end);
          for (let d = new Date(start); d < end; d.setDate(d.getDate() + 1)) {
            const current = new Date(d);
            if (current >= today && current <= thirtyDaysLater) {
              busyDates.add(current.toISOString().slice(0, 10));
            }
          }
        }
      }
      return Array.from(busyDates).sort();
    } catch (e) {
      console.error('Îøèáêà iCal:', e);
      return [];
    }
  } else {
    return [];
  }
}

// Èíèöèàëèçàöèÿ MAX áîòà (òîëüêî åñëè åñòü òîêåí)
if (process.env.BOT_TOKEN) {
  const bot = new Bot(process.env.BOT_TOKEN);

  // Êîìàíäà /start
  bot.command('start', (ctx) => {
    ctx.reply('Ïðèâåò! ß áîò Êèíîçàëà 4K. Íàïèøèòå "Äàòû" äëÿ ïðîâåðêè çàíÿòîñòè, èëè "Õî÷ó [äàòà]" äëÿ áðîíè.');
  });

  // Îáðàáîòêà òåêñòîâûõ êîìàíä
  bot.hears(/^(äàòû|ñâîáîäíûå äàòû|çàíÿòîñòü)$/i, async (ctx) => {
    const busy = await getBusyDates();
    if (busy.length === 0) {
      ctx.reply('Ïîêà íåò äàííûõ î çàíÿòîñòè. Ïîïðîáóéòå ïîçæå.');
    } else {
      let responseText = '?? *Êèíîçàë 4K: çàíÿòîñòü íà 30 äíåé*\n\n';
      const today = new Date();
      for (let i = 0; i < 30; i++) {
        const d = new Date(today);
        d.setDate(d.getDate() + i);
        const dateStr = d.toISOString().slice(0, 10);
        const isBusy = busy.includes(dateStr);
        const day = d.getDate().toString().padStart(2, '0');
        const month = (d.getMonth() + 1).toString().padStart(2, '0');
        responseText += `${isBusy ? '?' : '?'} ${day}.${month}\n`;
      }
      responseText += '\n×òîáû çàáðîíèðîâàòü, íàïèøèòå "Õî÷ó [äàòà]" è ÿ ïåðåäàì õîçÿèíó.';
      ctx.reply(responseText, { format: 'markdown' });
    }
  });

  // Çàÿâêà "Õî÷ó [äàòà]"
  bot.hears(/^õî÷ó\s+(.+)$/i, async (ctx) => {
    const userId = ctx.message.from.id; // èëè êàê â MAX API
    const ownerId = process.env.OWNER_ID;
    if (ownerId) {
      try {
        await bot.api.sendMessageToUser(ownerId, `?? Íîâàÿ çàÿâêà îò ïîëüçîâàòåëÿ (id: ${userId}): ${ctx.message.text}`);
      } catch (err) {
        console.error('Îøèáêà îòïðàâêè âëàäåëüöó:', err);
      }
    }
    ctx.reply('Ñïàñèáî! ß ïåðåäàë çàïðîñ õîçÿèíó, îí ñêîðî ñâÿæåòñÿ ñ âàìè.');
  });

  // Îáðàáîòêà ëþáûõ äðóãèõ ñîîáùåíèé
  bot.on('message_created', (ctx) => {
    ctx.reply('Ïðèâåò! ß áîò Êèíîçàëà 4K. Íàïèøèòå "Äàòû" äëÿ ïðîâåðêè çàíÿòîñòè, èëè "Õî÷ó [äàòà]" äëÿ áðîíè.');
  });

  // Çàïóñê long polling
  bot.start().catch(err => {
    console.error('Îøèáêà çàïóñêà MAX áîòà:', err);
  });
} else {
  console.log('BOT_TOKEN íå çàäàí, MAX áîò íå çàïóùåí');
}

// HTTP ñåðâåð äëÿ Render (÷òîáû ñåðâèñ íå ïàäàë)
app.listen(process.env.PORT || 3000, () => {
  console.log('KinZal MAX Bot server started');
});
