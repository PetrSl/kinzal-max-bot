require('dotenv').config();
const express = require('express');
const axios = require('axios');
const ical = require('ical');
const { Bot } = require('@maxhub/max-bot-api');

const app = express();
app.use(express.json());

if (!process.env.BOT_TOKEN) {
  console.error('BOT_TOKEN не задан, завершение работы');
  process.exit(1);
}

const bot = new Bot(process.env.BOT_TOKEN);

// Хранилище заявок (requestId -> объект заявки)
const requests = new Map();

// Функция генерации уникального ID заявки
function generateRequestId(userId) {
  return `${Date.now()}_${userId}`;
}

// Функция получения занятых дат (заглушка, пока нет ICAL_URL)
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

// Функция показа занятости (для текстовой команды, если понадобится)
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
  responseText += '\nЧтобы забронировать, нажмите «Выбрать дату».';
  await sendMessage(userId, responseText);
}

// Главная клавиатура (две кнопки)
function getMainKeyboard() {
  return [{
    type: 'inline_keyboard',
    payload: {
      buttons: [
        [{ type: 'callback', text: '📅 Выбрать дату', payload: 'choose_date' }],
        [{ type: 'callback', text: '📋 Меню', payload: 'main_menu' }]
      ]
    }
  }];
}

// Клавиатура меню (дубль "Выбрать дату", контакты)
function getMenuKeyboard() {
  return [{
    type: 'inline_keyboard',
    payload: {
      buttons: [
        [{ type: 'callback', text: '📅 Выбрать дату', payload: 'choose_date' }],
        [{ type: 'callback', text: '📞 Позвонить владельцу', payload: 'call_owner' }],
        [{ type: 'callback', text: '💬 Написать владельцу', payload: 'message_owner' }]
      ]
    }
  }];
}

// Клавиатура подтверждения брони для гостя (после ввода даты)
function getConfirmationKeyboard(requestId) {
  return [{
    type: 'inline_keyboard',
    payload: {
      buttons: [
        [{ type: 'callback', text: '✅ Подтвердить бронь', payload: `confirm_${requestId}` }],
        [{ type: 'callback', text: '❌ Отменить', payload: `cancel_${requestId}` }]
      ]
    }
  }];
}

// Клавиатура для гостя после подтверждения (кнопка отмены до оплаты)
function getGuestPendingPaymentKeyboard(requestId) {
  return [{
    type: 'inline_keyboard',
    payload: {
      buttons: [
        [{ type: 'callback', text: '❌ Отменить заявку', payload: `cancel_${requestId}` }]
      ]
    }
  }];
}

// Клавиатура для владельца (подтверждение оплаты или отмена)
function getOwnerConfirmationKeyboard(requestId, date) {
  return [{
    type: 'inline_keyboard',
    payload: {
      buttons: [
        [{ type: 'callback', text: `✅ Бронь на ${date} оплачена`, payload: `paid_${requestId}` }],
        [{ type: 'callback', text: '❌ Отменить бронь', payload: `owner_cancel_${requestId}` }]
      ]
    }
  }];
}

// Отправка приветствия с главным меню
async function sendWelcome(userId) {
  await sendMessage(userId, 'Привет! Я бот Кинозала 4K. Выберите действие:', getMainKeyboard());
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
      } else if (/^\d{2}\.\d{2}\.\d{4}$/.test(text)) {
        // Гость ввёл дату в формате ДД.ММ.ГГГГ
        const requestId = generateRequestId(userId);
        const request = {
          requestId,
          guestUserId: userId,
          ownerId: process.env.OWNER_ID,
          date: text,
          status: 'pending_confirmation',
          timestamp: Date.now()
        };
        requests.set(requestId, request);
        console.log(`Создана заявка ${requestId}:`, request);

        await sendMessage(userId, `Вы выбрали дату: ${text}. Подтвердите бронь:`, getConfirmationKeyboard(requestId));
      } else {
        // Любое другое сообщение — отправляем приветствие
        await sendWelcome(userId);
      }
    } else if (updateType === 'message_callback') {
      console.log('Получен callback:', JSON.stringify(body));

      let userId = null;
      let payload = null;

      if (body.callback && body.callback.user) {
        userId = body.callback.user.user_id;
      }
      if (body.callback && body.callback.payload) {
        payload = body.callback.payload;
      }

      console.log(`Callback: user_id = ${userId}, payload = ${payload}`);

      if (!userId) {
        console.error('Не удалось определить user_id из callback');
        return;
      }

      // Обработка кнопок главного меню
      if (payload === 'choose_date') {
        await sendMessage(userId, 'Введите желаемую дату в формате ДД.ММ.ГГГГ (например, 25.12.2026):');
      } else if (payload === 'main_menu') {
        await sendMessage(userId, 'Меню:', getMenuKeyboard());
      } else if (payload === 'call_owner') {
        await sendMessage(userId, 'Вы можете позвонить владельцу: +7 (900) 000-00-00 (заглушка)');
      } else if (payload === 'message_owner') {
        await sendMessage(userId, 'Напишите сообщение владельцу, и я передам его.');
      }
      // Обработка подтверждения гостем
      else if (payload.startsWith('confirm_')) {
        const requestId = payload.replace('confirm_', '');
        const request = requests.get(requestId);
        if (request && request.status === 'pending_confirmation' && request.guestUserId === userId) {
          request.status = 'confirmed';
          console.log(`Заявка ${requestId} подтверждена гостем`);

          // Уведомляем владельца
          const ownerMsg = `🔔 Новая заявка на бронь:\nДата: ${request.date}\nОт гостя (id: ${userId})\n\nСтатус: ожидает оплаты`;
          await sendMessage(request.ownerId, ownerMsg, getOwnerConfirmationKeyboard(requestId, request.date));

          // Отвечаем гостю
          await sendMessage(userId, 'Заявка отправлена! Ожидайте подтверждения оплаты.', getGuestPendingPaymentKeyboard(requestId));
        } else {
          await sendMessage(userId, 'Заявка не найдена или уже обработана.');
        }
      }
      // Обработка отмены гостем (до оплаты)
      else if (payload.startsWith('cancel_')) {
        const requestId = payload.replace('cancel_', '');
        const request = requests.get(requestId);
        if (request && request.guestUserId === userId && request.status !== 'paid') {
          request.status = 'cancelled';
          console.log(`Заявка ${requestId} отменена гостем`);

          // Уведомляем владельца, если заявка была подтверждена
          if (request.status === 'cancelled' && request.status !== 'pending_confirmation') {
            // Если заявка уже была confirmed, шлём владельцу отмену
            await sendMessage(request.ownerId, `❌ Заявка на дату ${request.date} отменена гостем.`);
          }
          await sendMessage(userId, 'Заявка отменена.');
          requests.delete(requestId);
        } else {
          await sendMessage(userId, 'Не удалось отменить заявку (возможно, она уже оплачена или не существует).');
        }
      }
      // Обработка подтверждения оплаты владельцем
      else if (payload.startsWith('paid_')) {
        const requestId = payload.replace('paid_', '');
        const request = requests.get(requestId);
        if (request && userId === request.ownerId && request.status === 'confirmed') {
          request.status = 'paid';
          console.log(`Заявка ${requestId} оплачена, бронь подтверждена`);

          // Уведомляем гостя
          await sendMessage(request.guestUserId, `✅ Оплата получена! Бронь на ${request.date} подтверждена.`);

          // Здесь в будущем будет отметка в календаре
          requests.delete(requestId);
        } else {
          await sendMessage(userId, 'Заявка не найдена или уже обработана.');
        }
      }
      // Обработка отмены владельцем
      else if (payload.startsWith('owner_cancel_')) {
        const requestId = payload.replace('owner_cancel_', '');
        const request = requests.get(requestId);
        if (request && userId === request.ownerId) {
          request.status = 'cancelled';
          console.log(`Заявка ${requestId} отменена владельцем`);

          // Уведомляем гостя
          await sendMessage(request.guestUserId, `К сожалению, бронь на ${request.date} отменена владельцем.`);
          requests.delete(requestId);
        } else {
          await sendMessage(userId, 'Заявка не найдена или уже обработана.');
        }
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
