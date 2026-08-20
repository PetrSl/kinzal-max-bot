require('dotenv').config();
const express = require('express');
const axios = require('axios');
const ical = require('ical');
const { Bot } = require('@maxhub/max-bot-api');

const app = express();
app.use(express.json());

app.get('/', (req, res) => res.send('KinZal MAX Bot is running'));

// Функция получения занятых дат (аналогична VK)
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
      console.error('Ошибка iCal:', e);
      return [];
    }
  } else {
    return [];
  }
}

// Инициализация MAX бота (если есть токен)
if (process.env.BOT_TOKEN) {
  const bot = new Bot(process.env.BOT_TOKEN);

  bot.command('start', (ctx) => {
    ctx.reply('Привет! Я бот Кинозала 4K. Напишите "Даты" для проверки занятости, или "Хочу [дата]" для брони.');
  });

  bot.hears(/^(даты|свободные даты|занятость)$/i, async (ctx) => {
    const busy = await getBusyDates();
    if (busy.length === 0) {
      ctx.reply('Пока нет данных о занятости. Попробуйте позже.');
    } else {
      let responseText = '🎬 *Кинозал 4K: занятость на 30 дней*\n\n';
      const today = new Date();
      for (let i = 0; i < 30; i++) {
        const d = new Date(today);
        d.setDate(d.getDate() + i);
        const dateStr = d.toISOString().slice(0, 10);
        const isBusy = busy.includes(dateStr);
        const day = d.getDate().toString().padStart(2, '0');
        const month = (d.getMonth() + 1).toString().padStart(2, '0');
        responseText += `${isBusy ? '❌' : '✅'} ${day}.${month}\n`;
      }
      responseText += '\nЧтобы забронировать, напишите "Хочу [дата]" и я передам хозяину.';
      ctx.reply(responseText, { format: 'markdown' });
    }
  });

  bot.hears(/^хочу\s+(.+)$/i, async (ctx) => {
    const userId = ctx.message.sender.user_id;
    const ownerId = process.env.OWNER_ID;
    if (ownerId) {
      try {
        await bot.api.sendMessageToUser(ownerId, `🔔 Новая заявка от пользователя (id: ${userId}): ${ctx.message.text}`);
      } catch (err) {
        console.error('Ошибка отправки владельцу:', err);
      }
    }
    ctx.reply('Спасибо! Я передал запрос хозяину, он скоро свяжется с вами.');
  });

  bot.on('message_created', (ctx) => {
    ctx.reply('Привет! Я бот Кинозала 4K. Напишите "Даты" для проверки занятости, или "Хочу [дата]" для брони.');
  });

  // Обработка входящего вебхука
  app.post('/callback', (req, res) => {
    // Проверяем секрет, если он задан
    const secret = req.headers['x-max-bot-api-secret'];
    if (process.env.WEBHOOK_SECRET && secret !== process.env.WEBHOOK_SECRET) {
      console.error('Неверный секрет webhook');
      return res.status(403).send('Invalid secret');
    }

    // Отвечаем сразу, чтобы MAX не ждал
    res.send('ok');

    // Обрабатываем обновление в фоне
    bot.handleUpdate(req.body).catch(err => {
      console.error('Ошибка обработки webhook:', err);
    });
  });

  // Установка подписки на вебхук при старте
  async function setWebhook() {
    const webhookUrl = process.env.WEBHOOK_URL; // https://kinzal-max-bot.onrender.com/callback
    const secret = process.env.WEBHOOK_SECRET || '';
    const updateTypes = ['message_created', 'bot_started', 'message_callback'];

    if (!webhookUrl) {
      console.error('WEBHOOK_URL не задан, вебхук не установлен');
      return;
    }

    try {
      const response = await axios.post(
        'https://platform-api2.max.ru/subscriptions',
        {
          url: webhookUrl,
          update_types: updateTypes,
          secret: secret || undefined // не отправляем, если пусто
        },
        {
          headers: {
            'Authorization': process.env.BOT_TOKEN,
            'Content-Type': 'application/json'
          }
        }
      );
      console.log('Ответ на подписку:', JSON.stringify(response.data));
    } catch (e) {
      console.error('Ошибка установки вебхука:', e.response ? JSON.stringify(e.response.data) : e.message);
    }
  }

  // Запуск HTTP-сервера и установка вебхука
  app.listen(process.env.PORT || 3000, () => {
    console.log('KinZal MAX Bot server started');
    setWebhook();
  });
} else {
  console.log('BOT_TOKEN не задан, MAX бот не запущен');

  // Даже без токена запускаем HTTP-сервер
  app.listen(process.env.PORT || 3000, () => {
    console.log('KinZal MAX Bot server started (без бота)');
  });
}
