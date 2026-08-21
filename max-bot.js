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

// Хранилище заявок: requestId -> объект заявки
const requests = new Map();

// Генерация уникального ID заявки
function generateRequestId(userId) {
  return `${Date.now()}_${userId}`;
}

// Получение занятых дат (заглушка, пока нет ICAL_URL)
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

// Функция показа занятости (для команды /dates)
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

// Текст с правилами
function getRulesText() {
  return '⚠️ *Важно знать:*\n' +
    '• Только для граждан РФ\n' +
    '• Возраст от 21 года\n' +
    '• Правила проживания:\n' +
    '  - не курить, не шуметь после 22:00\n' +
    '  - не проводить вечеринки\n' +
    '  - соблюдать чистоту';
}

// Главная клавиатура (теперь с кнопкой Правила)
function getMainKeyboard() {
  return [{
    type: 'inline_keyboard',
    payload: {
      buttons: [
        [{ type: 'callback', text: '📅 Выбрать дату', payload: 'choose_date' }],
        [{ type: 'callback', text: '📋 Меню', payload: 'main_menu' }],
        [{ type: 'callback', text: '📜 Правила проживания', payload: 'rules' }]
      ]
    }
  }];
}

// Клавиатура меню (с доп. информацией)
function getMenuKeyboard() {
  const infoText = getRulesText();
  return {
    text: infoText,
    attachments: [{
      type: 'inline_keyboard',
      payload: {
        buttons: [
          [{ type: 'callback', text: '📅 Выбрать дату', payload: 'choose_date' }],
          [{ type: 'callback', text: '📞 Позвонить владельцу', payload: 'call_owner' }],
          [{ type: 'callback', text: '💬 Написать владельцу', payload: 'message_owner' }]
        ]
      }
    }]
  };
}

// Клавиатура подтверждения брони (гость)
function getConfirmationKeyboard(requestId) {
  return [{
    type: 'inline_keyboard',
    payload: {
      buttons: [
        [{ type: 'callback', text: '✅ Подтвердить бронь', payload: `confirm_${requestId}` }]
      ]
    }
  }];
}

// Клавиатура для гостя после резервирования
function getReservationKeyboard(requestId) {
  return [{
    type: 'inline_keyboard',
    payload: {
      buttons: [
        [{ type: 'callback', text: '📝 Оформить договор', payload: `contract_${requestId}` }],
        [{ type: 'callback', text: '❌ Отменить резерв', payload: `cancel_reserve_${requestId}` }]
      ]
    }
  }];
}

// Клавиатура для владельца (подтверждение оплаты или отмена)
function getOwnerConfirmationKeyboard(requestId, dates) {
  return [{
    type: 'inline_keyboard',
    payload: {
      buttons: [
        [{ type: 'callback', text: `✅ Бронь на ${dates} оплачена`, payload: `paid_${requestId}` }],
        [{ type: 'callback', text: '❌ Отменить бронь', payload: `owner_cancel_${requestId}` }]
      ]
    }
  }];
}

// Клавиатура для добавления ещё одной даты
function getAddDateKeyboard() {
  return [{
    type: 'inline_keyboard',
    payload: {
      buttons: [
        [{ type: 'callback', text: '➕ Добавить дату', payload: 'add_date' }],
        [{ type: 'callback', text: '✅ Готово', payload: 'dates_done' }]
      ]
    }
  }];
}

// Отправка приветствия с главным меню
async function sendWelcome(userId) {
  const text = 'Привет! Я бот Кинозала 4K. 👋\n\n' +
               'Выберите действие ниже или напишите мне любое сообщение — я сразу открою меню.';
  await sendMessage(userId, text, getMainKeyboard());
}

// Установка команд бота
async function setCommands() {
  const commands = [
    { name: 'start', description: 'Начать общение и открыть меню' },
    { name: 'dates', description: 'Показать свободные даты' }
  ];

  try {
    const response = await axios.patch(
      'https://platform-api2.max.ru/me/commands',
      { commands: commands },
      {
        headers: {
          'Authorization': process.env.BOT_TOKEN,
          'Content-Type': 'application/json'
        }
      }
    );
    console.log('Команды бота установлены:', JSON.stringify(response.data));
  } catch (error) {
    console.error('Ошибка установки команд:', error.response ? JSON.stringify(error.response.data) : error.message);
  }
}

// Обработка шагов оформления договора
async function processContractStep(userId, text, attachments, request) {
  const step = request.step;

  if (step === 'full_name') {
    request.contractData.fullName = text.trim();
    request.step = 'passport';
    await sendMessage(userId, 'Спасибо! Теперь укажите серию и номер паспорта (например, 4510 123456):');
  } else if (step === 'passport') {
    request.contractData.passport = text.trim();
    request.step = 'phone';
    await sendMessage(userId, 'Укажите номер телефона в формате +7XXXXXXXXXX:');
  } else if (step === 'phone') {
    request.contractData.phone = text.trim();
    request.smsCode = '1234';
    request.step = 'sms_code';
    await sendMessage(userId, `На номер ${text.trim()} отправлен SMS-код (заглушка: ${request.smsCode}). Введите код:`);
  } else if (step === 'sms_code') {
    if (text.trim() === request.smsCode) {
      request.step = 'selfie';
      await sendMessage(userId, 'Код верный! Теперь отправьте селфи с паспортом в развернутом виде (фото).');
    } else {
      await sendMessage(userId, 'Неверный код, попробуйте ещё раз:');
    }
  } else if (step === 'selfie') {
    const hasImage = attachments && attachments.some(att => att.type === 'image');
    if (hasImage) {
      request.contractData.selfie = attachments.find(att => att.type === 'image').payload?.token || 'received';
      request.status = 'contract_signed';
      request.step = null;
      console.log(`Договор по заявке ${request.requestId} оформлен`);

      const ownerText = `🔔 Гость оформил договор.\n\n` +
        `Даты: ${request.dates.join(', ')}\n` +
        `ФИО: ${request.contractData.fullName}\n` +
        `Паспорт: ${request.contractData.passport}\n` +
        `Телефон: ${request.contractData.phone}\n\n` +
        `Статус: ожидает оплаты`;
      await sendMessage(request.ownerId, ownerText, getOwnerConfirmationKeyboard(request.requestId, request.dates.join(', ')));

      await sendMessage(userId, 'Договор оформлен! Ожидайте подтверждения оплаты от владельца.');
    } else {
      await sendMessage(userId, 'Пожалуйста, отправьте фото (селфи с паспортом).');
    }
  }
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
      let attachments = [];

      if (updateType === 'bot_started') {
        userId = body.user ? body.user.user_id : null;
      } else if (updateType === 'message_created' && body.message) {
        const message = body.message;
        userId = message.sender ? message.sender.user_id : null;
        if (message.body && typeof message.body.text === 'string') {
          text = message.body.text;
        }
        if (message.body && Array.isArray(message.body.attachments)) {
          attachments = message.body.attachments;
        }
      }

      if (!userId) {
        console.error('Не удалось определить user_id из события:', updateType);
        return;
      }

      console.log(`Событие: ${updateType}, user_id: ${userId}, текст: "${text}", attachments: ${attachments.length}`);

      // Проверка активного договора
      let activeContractRequest = null;
      for (let [id, req] of requests) {
        if (req.guestUserId === userId && req.status === 'contract_in_progress') {
          activeContractRequest = req;
          break;
        }
      }

      if (activeContractRequest) {
        await processContractStep(userId, text, attachments, activeContractRequest);
        return;
      }

      // Если заявка в статусе выбора дат и пришло текстовое сообщение с датой
      if (/^\d{2}\.\d{2}\.\d{4}$/.test(text)) {
        let activeSelectingRequest = null;
        for (let [id, req] of requests) {
          if (req.guestUserId === userId && req.status === 'selecting_dates') {
            activeSelectingRequest = req;
            break;
          }
        }

        if (activeSelectingRequest) {
          activeSelectingRequest.dates.push(text);
          await sendMessage(userId, `Дата ${text} добавлена. Добавить ещё дату?`, getAddDateKeyboard());
        } else {
          const requestId = generateRequestId(userId);
          const request = {
            requestId,
            guestUserId: userId,
            ownerId: process.env.OWNER_ID,
            dates: [text],
            status: 'selecting_dates',
            timestamp: Date.now(),
            step: null,
            contractData: {}
          };
          requests.set(requestId, request);
          await sendMessage(userId, `Вы выбрали дату: ${text}. Добавить ещё дату?`, getAddDateKeyboard());
        }
      } else if (updateType === 'bot_started' || text.startsWith('/start')) {
        await sendWelcome(userId);
      } else if (text === '/dates' || /^(даты|свободные даты|занятость)$/i.test(text)) {
        await sendBusyDates(userId);
      } else {
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

      if (payload === 'choose_date') {
        let activeSelectingRequest = null;
        for (let [id, req] of requests) {
          if (req.guestUserId === userId && req.status === 'selecting_dates') {
            activeSelectingRequest = req;
            break;
          }
        }
        if (activeSelectingRequest) {
          await sendMessage(userId, `У вас уже начат выбор дат. Текущие даты: ${activeSelectingRequest.dates.join(', ')}. Введите ещё дату или нажмите «Готово».`, getAddDateKeyboard());
        } else {
          await sendMessage(userId, 'Введите желаемую дату в формате ДД.ММ.ГГГГ (например, 25.12.2026).');
        }
      } else if (payload === 'main_menu') {
        const menu = getMenuKeyboard();
        await sendMessage(userId, menu.text, menu.attachments);
      } else if (payload === 'rules') {
        // Новая обработка кнопки "Правила проживания"
        await sendMessage(userId, getRulesText());
      } else if (payload === 'call_owner') {
        await sendMessage(userId, 'Вы можете позвонить владельцу: +7 (900) 000-00-00 (заглушка)');
      } else if (payload === 'message_owner') {
        await sendMessage(userId, 'Напишите сообщение владельцу, и я передам его.');
      } else if (payload === 'add_date') {
        await sendMessage(userId, 'Введите ещё дату в формате ДД.ММ.ГГГГ:');
      } else if (payload === 'dates_done') {
        let activeSelectingRequest = null;
        for (let [id, req] of requests) {
          if (req.guestUserId === userId && req.status === 'selecting_dates') {
            activeSelectingRequest = req;
            break;
          }
        }
        if (activeSelectingRequest && activeSelectingRequest.dates.length > 0) {
          activeSelectingRequest.status = 'pending_confirmation';
          const datesStr = activeSelectingRequest.dates.join(', ');
          await sendMessage(userId, `Вы выбрали даты: ${datesStr}. Подтвердите бронь:`, getConfirmationKeyboard(activeSelectingRequest.requestId));
        } else {
          await sendMessage(userId, 'Нет выбранных дат. Начните выбор заново.', getMainKeyboard());
        }
      } else if (payload.startsWith('confirm_')) {
        const requestId = payload.replace('confirm_', '');
        const request = requests.get(requestId);
        if (request && request.status === 'pending_confirmation' && request.guestUserId === userId) {
          request.status = 'reserved';
          request.reservationExpires = Date.now() + 30 * 60 * 1000;
          console.log(`Заявка ${requestId} переведена в статус reserved`);
          const datesStr = request.dates.join(', ');
          await sendMessage(userId, `✅ Дата(ы) ${datesStr} зарезервированы на 30 минут. Пожалуйста, оформите договор за это время.`, getReservationKeyboard(requestId));
        } else {
          await sendMessage(userId, 'Заявка не найдена или уже обработана.');
        }
      } else if (payload.startsWith('contract_')) {
        const requestId = payload.replace('contract_', '');
        const request = requests.get(requestId);
        if (request && request.status === 'reserved' && request.guestUserId === userId) {
          request.status = 'contract_in_progress';
          request.step = 'full_name';
          await sendMessage(userId, 'Для оформления договора, пожалуйста, укажите ваше полное ФИО (например, Иванов Иван Иванович):');
        } else {
          await sendMessage(userId, 'Резерв не найден или уже истёк.');
        }
      } else if (payload.startsWith('cancel_reserve_')) {
        const requestId = payload.replace('cancel_reserve_', '');
        const request = requests.get(requestId);
        if (request && request.status === 'reserved' && request.guestUserId === userId) {
          request.status = 'cancelled';
          console.log(`Резерв ${requestId} отменён гостем`);
          await sendMessage(userId, 'Резерв отменён.');
          requests.delete(requestId);
        } else {
          await sendMessage(userId, 'Не удалось отменить резерв.');
        }
      } else if (payload.startsWith('paid_')) {
        const requestId = payload.replace('paid_', '');
        const request = requests.get(requestId);
        if (request && userId === request.ownerId && request.status === 'contract_signed') {
          request.status = 'paid';
          console.log(`Заявка ${requestId} оплачена`);
          const datesStr = request.dates.join(', ');
          const key = `KEY-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
          await sendMessage(request.guestUserId, `✅ Оплата получена! Бронь на даты ${datesStr} подтверждена.\n\nВаш электронный ключ: ${key}\n\nПриятного просмотра!`);
          requests.delete(requestId);
        } else {
          await sendMessage(userId, 'Заявка не найдена или её статус не позволяет подтвердить оплату.');
        }
      } else if (payload.startsWith('owner_cancel_')) {
        const requestId = payload.replace('owner_cancel_', '');
        const request = requests.get(requestId);
        if (request && userId === request.ownerId) {
          request.status = 'cancelled';
          console.log(`Заявка ${requestId} отменена владельцем`);
          await sendMessage(request.guestUserId, `К сожалению, бронь на даты ${request.dates.join(', ')} отменена владельцем.`);
          requests.delete(requestId);
        } else {
          await sendMessage(userId, 'Заявка не найдена.');
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
  setCommands();
});
