require('dotenv').config();
const express = require('express');
const axios = require('axios');
const ical = require('ical');
const { Bot } = require('@maxhub/max-bot-api');

const app = express();
app.use(express.json());

app.get('/', (req, res) => res.send('KinZal MAX Bot is running'));

// Проверка обязательных переменных
if (!process.env.BOT_TOKEN) {
  console.error('BOT_TOKEN не задан, завершение работы');
  process.exit(1);
}

const bot = new Bot(process.env.BOT_TOKEN);

// Функция получения занятых дат
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

// Отправка сообщения пользователю через SDK
async function sendMessage(userId, text, attachments = []) {
  try {
    console.log(`Отправляю сообщение пользователю ${userId}: ${text}`);
    await bot.api.sendMessageToUser(userId, text, {
      attachments: attachments,
      format: 'markdown'
    });
    console.log('Сообщение отправлено');
  } catch (error) {
    console.error('Ошибка отправки сообщения:', error);
  }
}

// Функция показа занятости
async function sendBusyDates(userId) {
  const busy = await getBusyDates();
  if (busy.length === 0) {
    await sendMessage(userId, 'Пока нет данных о занятости. Попробуйте позже.');
    return;
  }

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
  await sendMessage(userId, responseText);
}

// Создание inline-клавиатуры
function getMainKeyboard() {
  return [{
    type: 'inline_keyboard',
    payload: {
      buttons: [
        [
          { type: 'callback', text: '📅 Свободные даты', payload: 'free_dates' }
        ],
        [
          { type: 'callback', text: '📝 Забронировать', payload: 'book' }
        ],
        [
          { type: 'callback', text: '📞 Связаться с хозяином', payload: 'contact_owner' }
        ]
      ]
    }
  }];
}

// Отправка приветствия с кнопками
async function sendWelcome(userId) {
  const text = 'Привет! Я бот Кинозала 4K. Выберите действие:';
  await sendMessage(userId, text, getMainKeyboard());
}

// Обработка входящего вебхука
app.post('/callback', async (req, res) => {
  console.log('Webhook received:', JSON.stringify(req.body));

  const secret = req.headers['x-max-bot-api-secret'];
  if (process.env.WEBHOOK_SECRET && secret !== process.env.WEBHOOK_SECRET) {
    console.error('Неверный секрет webhook');
    return res.status(403).send('Invalid secret');
  }

  res.send('ok');

  try {
    const body = req.body;
    const updateType = body.update_type;

    if (updateType === 'message_created' || updateType === 'bot_started') {
      let userId;
      let text = '';

      if (updateType === 'bot_started') {
        userId = body.user ? body.user.user_id : null;
      } else if (updateType === 'message_created' && body.message) {
        const message = body.message;
        userId = message.sender ? message.sender.user_id : null;
        if (message.body && typeof message.body.text === 'string') {
          text = message.body.text;
        }
      }

      if (!userId) {
        console.error('Не удалось определить user_id из события:', updateType);
        return;
      }

      console.log(`Событие: ${updateType}, user_id: ${userId}, текст: "${text}"`);

      if (updateType === 'bot_started' || text.startsWith('/start')) {
        await sendWelcome(userId);
      } else if (/^(даты|свободные даты|занятость)$/i.test(text)) {
        await sendBusyDates(userId);
      } else if (/^хочу\s+(.+)$/i.test(text)) {
        const ownerId = process.env.OWNER_ID;
        if (ownerId) {
          await sendMessage(ownerId, `🔔 Новая заявка от пользователя (id: ${userId}): ${text}`);
        }
        await sendMessage(userId, 'Спасибо! Я передал запрос хозяину, он скоро свяжется с вами.');
      } else {
        await sendWelcome(userId);
      }
    } else if (updateType === 'message_callback') {
      console.log('Получен callback:', JSON.stringify(body));

      let userId = body.user ? body.user.user_id : null;
      let payload = body.payload;

      if (!payload && body.message && body.message.payload) {
        payload = body.message.payload;
      } else if (!payload && body.callback && body.callback.payload) {
        payload = body.callback.payload;
      }

      if (!userId) {
        console.error('Не удалось определить user_id из callback');
        return;
      }

      if (payload === 'free_dates') {
        await sendBusyDates(userId);
      } else if (payload === 'book') {
        await sendMessage(userId, 'Для бронирования напишите желаемую дату в формате: Хочу 25.12.2024');
      } else if (payload === 'contact_owner') {
        await sendMessage(userId, 'Свяжитесь с хозяином: @petrsl или напишите сюда, я передам.');
      } else {
        console.log('Неизвестный payload:', payload);
      }
    }
  } catch (error) {
    console.error('Ошибка обработки вебхука:', error);
  }
});

// Установка подписки на вебхук при старте
async function setWebhook() {
  const webhookUrl = process.env.WEBHOOK_URL;
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
        secret: secret || undefined
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

app.listen(process.env.PORT || 3000, () => {
  console.log('KinZal MAX Bot server started');
  setWebhook();
});
