require('dotenv').config();
const express = require('express');
const axios = require('axios');
const ical = require('ical');

const app = express();
app.use(express.json());

app.get('/', (req, res) => res.send('KinZal MAX Bot is running'));

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

// Функция отправки сообщения (текст + опциональные attachments)
async function sendMessage(userId, text, attachments = []) {
  try {
    console.log(`Отправляю сообщение на user_id ${userId}: ${text}`);
    const response = await axios.post(
      'https://platform-api2.max.ru/messages',
      {
        user_id: userId, // используем user_id, если не сработает — заменим на chat_id
        text: text,
        attachments: attachments,
        format: 'markdown'
      },
      {
        headers: {
          'Authorization': process.env.BOT_TOKEN,
          'Content-Type': 'application/json'
        }
      }
    );
    console.log('Сообщение отправлено, ответ API:', JSON.stringify(response.data));
  } catch (error) {
    console.error('Ошибка отправки сообщения:', error.response ? JSON.stringify(error.response.data) : error.message);
  }
}

// Функция создания inline-клавиатуры в формате MAX
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

    // Обработка обычных сообщений и bot_started
    if (updateType === 'message_created' || updateType === 'bot_started') {
      let userId;
      let text = '';

      if (body.message) {
        // message_created
        userId = body.message.sender.user_id;
        if (body.message.body && body.message.body.text) {
          text = body.message.body.text;
        }
      } else if (body.sender) {
        // bot_started может содержать sender
        userId = body.sender.user_id;
      }

      if (!userId) {
        console.error('Не удалось определить user_id из события:', updateType);
        return;
      }

      console.log(`Событие: ${updateType}, user_id: ${userId}, текст: "${text}"`);

      // Команда /start или bot_started
      if (updateType === 'bot_started' || text.startsWith('/start')) {
        await sendWelcome(userId);
      }
      // Команда "Даты"
      else if (/^(даты|свободные даты|занятость)$/i.test(text)) {
        const busy = await getBusyDates();
        if (busy.length === 0) {
          await sendMessage(userId, 'Пока нет данных о занятости. Попробуйте позже.');
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
          await sendMessage(userId, responseText);
        }
      }
      // Команда "Хочу ..."
      else if (/^хочу\s+(.+)$/i.test(text)) {
        const ownerId = process.env.OWNER_ID;
        if (ownerId) {
          await sendMessage(ownerId, `🔔 Новая заявка от пользователя (id: ${userId}): ${text}`);
        }
        await sendMessage(userId, 'Спасибо! Я передал запрос хозяину, он скоро свяжется с вами.');
      }
      // Любое другое сообщение
      else {
        await sendWelcome(userId);
      }
    }
    // Обработка нажатий на кнопки (callback)
    else if (updateType === 'message_callback') {
      console.log('Получен callback:', JSON.stringify(body));
      // Определяем user_id и payload
      let userId = body.user ? body.user.user_id : null;
      let payload = body.payload;

      if (!userId) {
        console.error('Не удалось определить user_id из callback');
        return;
      }

      if (payload === 'free_dates') {
        const busy = await getBusyDates();
        if (busy.length === 0) {
          await sendMessage(userId, 'Пока нет данных о занятости. Попробуйте позже.');
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
          await sendMessage(userId, responseText);
        }
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
