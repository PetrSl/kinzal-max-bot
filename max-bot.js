require('dotenv').config();
const express = require('express');
const axios = require('axios');
const ical = require('ical');
const fs = require('fs');
const { Bot } = require('@maxhub/max-bot-api');

const app = express();
app.use(express.json());

if (!process.env.BOT_TOKEN) {
  console.error('BOT_TOKEN не задан, завершение работы');
  process.exit(1);
}

const bot = new Bot(process.env.BOT_TOKEN);

// Загрузка конфигурации цен
let pricingConfig = {
  current_stage: 'start',
  stages: {
    start: { weekday: 3500, weekend: 3500, third_guest_fee: 700 },
    growth: { weekday: 3500, weekend: 3900, third_guest_fee: 700 },
    confident: { weekday: 3900, weekend: 4500, third_guest_fee: 700 }
  },
  holidays: [],
  manual_override: {},
  discounts: { enabled: false, rules: [] },
  early_booking_discount: { enabled: false, min_days_before: 14, discount_percent: 10 },
  min_price_per_night: 2500,
  deposit: 1500
};
try {
  const raw = fs.readFileSync('./pricing.json', 'utf8');
  pricingConfig = JSON.parse(raw);
  console.log('pricing.json загружен');
} catch (e) {
  console.warn('pricing.json не найден, используются цены по умолчанию');
}

const requests = new Map();

function generateRequestId(userId) {
  return `${Date.now()}_${userId}`;
}

// Функция расчёта стоимости
function calculatePrice(dates, guestsCount) {
  const stage = pricingConfig.current_stage;
  const stageConfig = pricingConfig.stages[stage] || pricingConfig.stages.start;
  let total = 0;
  let baseTotal = 0;
  let discountTotal = 0;
  let thirdGuestTotal = 0;
  let details = [];

  const firstDate = new Date(dates[0]);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const daysBefore = Math.floor((firstDate - today) / (1000 * 60 * 60 * 24));

  dates.forEach(dateStr => {
    const date = new Date(dateStr);
    const dayOfWeek = date.getDay();
    const isWeekend = (dayOfWeek === 5 || dayOfWeek === 6 || dayOfWeek === 0);

    let price = 0;
    let type = '';

    if (pricingConfig.manual_override && pricingConfig.manual_override[dateStr]) {
      price = pricingConfig.manual_override[dateStr];
      type = 'ручная цена';
    } else if (stage === 'confident') {
      const holiday = pricingConfig.holidays.find(h => {
        const start = new Date(h.date_start);
        const end = new Date(h.date_end);
        return date >= start && date <= end;
      });
      if (holiday) {
        price = holiday.price;
        type = 'праздничный тариф';
      }
    }

    if (price === 0) {
      price = isWeekend ? stageConfig.weekend : stageConfig.weekday;
      type = isWeekend ? 'выходной' : 'будний';
    }

    baseTotal += price;
    details.push(`${dateStr}: ${price}₽ (${type})`);
  });

  // Раннее бронирование (14+ дней)
  if (pricingConfig.early_booking_discount?.enabled && daysBefore >= pricingConfig.early_booking_discount.min_days_before) {
    const basePerNight = baseTotal / dates.length;
    const maxDiscount = Math.max(0, basePerNight - pricingConfig.min_price_per_night);
    const discountPerNight = Math.min(basePerNight * pricingConfig.early_booking_discount.discount_percent / 100, maxDiscount);
    discountTotal = discountPerNight * dates.length;
    details.push(`Скидка за раннее бронирование (${pricingConfig.early_booking_discount.discount_percent}%): -${discountTotal}₽ (${discountPerNight.toFixed(0)}₽/ночь)`);
  }
  // Оптовая скидка за длительность (только если бронь в ближайшие 13 дней)
  else if (daysBefore < 14 && pricingConfig.discounts?.enabled) {
    const nights = dates.length;
    const rules = pricingConfig.discounts.rules || [];
    let selectedRule = null;
    for (let rule of rules) {
      if (nights >= rule.min_nights) {
        selectedRule = rule;
      }
    }
    if (selectedRule) {
      const basePerNight = baseTotal / nights;
      const maxDiscount = Math.max(0, basePerNight - pricingConfig.min_price_per_night);
      const discountPerNight = Math.min(selectedRule.discount_per_night, maxDiscount);
      discountTotal = discountPerNight * nights;
      details.push(`Скидка за длительность (${nights} ноч.): -${discountTotal}₽ (${discountPerNight}₽/ночь)`);
    }
  }

  if (discountTotal > 0) {
    // уже добавлено
  } else {
    details.push('Скидка: 0₽');
  }

  total = baseTotal - discountTotal;

  if (guestsCount === 3) {
    const thirdGuestFee = stageConfig.third_guest_fee || 700;
    thirdGuestTotal = thirdGuestFee * dates.length;
    total += thirdGuestTotal;
    details.push(`Доплата за 3-го гостя: ${thirdGuestTotal}₽`);
  }

  if (pricingConfig.deposit > 0) {
    total += pricingConfig.deposit;
    details.push(`Депозит: ${pricingConfig.deposit}₽`);
  }

  return {
    total,
    baseTotal,
    discountTotal,
    thirdGuestTotal,
    deposit: pricingConfig.deposit || 0,
    details: details.join('\n')
  };
}

// ===== ВАЖНО: функция sendMessage =====
async function sendMessage(userId, text, attachments = [], useMarkdown = true) {
  try {
    console.log(`Отправляю сообщение пользователю ${userId}: ${text}`);
    await bot.api.sendMessageToUser(Number(userId), text, {
      attachments: attachments,
      format: useMarkdown ? 'markdown' : undefined
    });
    console.log('Сообщение отправлено');
  } catch (error) {
    console.error('Ошибка отправки сообщения:', error);
  }
}
// =======================================

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

function getRulesText() {
  return '⚠️ *Важно знать:*\n' +
    '• Только для граждан РФ\n' +
    '• Возраст от 21 года\n' +
    '• Правила проживания:\n' +
    '  - не курить, не шуметь после 22:00\n' +
    '  - не проводить вечеринки\n' +
    '  - соблюдать чистоту';
}

// Главная клавиатура (без правил)
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

// Меню (теперь с правилами)
function getMenuKeyboard() {
  return [{
    type: 'inline_keyboard',
    payload: {
      buttons: [
        [{ type: 'callback', text: '📅 Выбрать дату', payload: 'choose_date' }],
        [{ type: 'callback', text: '📜 Правила проживания', payload: 'rules' }],
        [{ type: 'callback', text: '📞 Позвонить владельцу', payload: 'call_owner' }],
        [{ type: 'callback', text: '💬 Написать владельцу', payload: 'message_owner' }]
      ]
    }
  }];
}

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

function getGuestsKeyboard() {
  return [{
    type: 'inline_keyboard',
    payload: {
      buttons: [
        [{ type: 'callback', text: '👤 2 гостя', payload: 'guests_2' }],
        [{ type: 'callback', text: '👥 3 гостя', payload: 'guests_3' }]
      ]
    }
  }];
}

function getContractSignKeyboard(requestId) {
  return [{
    type: 'inline_keyboard',
    payload: {
      buttons: [
        [{ type: 'callback', text: '✅ Подтверждаю и подписываю', payload: `sign_contract_${requestId}` }],
        [{ type: 'callback', text: '❌ Отклонить', payload: `reject_contract_${requestId}` }]
      ]
    }
  }];
}

// Клавиатура с кнопкой копирования текста
function getClipboardKeyboard(textToCopy) {
  return [{
    type: 'inline_keyboard',
    payload: {
      buttons: [
        [{ type: 'clipboard', text: '📋 Скопировать текст', payload: textToCopy }]
      ]
    }
  }];
}

async function sendWelcome(userId) {
  const text = 'Привет! Я бот Кинозала 4K. 👋\n\n' +
               '⚠️ *Важно знать:*\n' +
               '• Только для граждан РФ\n' +
               '• Возраст от 21 года\n\n' +
               'Выберите действие ниже или напишите мне любое сообщение — я сразу открою меню.';
  await sendMessage(userId, text, getMainKeyboard());
}

async function setCommands() {
  const commands = [
    { name: 'start', description: 'Начать общение и открыть меню' },
    { name: 'dates', description: 'Показать свободные даты' }
  ];

  try {
    const response = await axios.patch(
      'https://platform-api2.max.ru/me/commands',
      { commands: commands },
      { headers: { 'Authorization': process.env.BOT_TOKEN, 'Content-Type': 'application/json' } }
    );
    console.log('Команды бота установлены:', JSON.stringify(response.data));
  } catch (error) {
    console.error('Ошибка установки команд:', error.response ? JSON.stringify(error.response.data) : error.message);
  }
}

function normalizePhone(phone) {
  let digits = phone.replace(/\D/g, '');
  if (digits.startsWith('8')) digits = '7' + digits.slice(1);
  if (digits.startsWith('9')) digits = '7' + digits;
  if (digits.length !== 11 || !digits.startsWith('7')) return null;
  return '+' + digits;
}

function isValidPassport(input) {
  if (!/^[\d\s-]+$/.test(input)) return false;
  const digits = input.replace(/\D/g, '');
  return digits.length === 10;
}

function buildContractText(request) {
  const fullName = request.contractData.fullName || '______________';
  const passport = request.contractData.passport || '______________';
  const phone = request.contractData.phone || '______________';
  const dates = request.dates.join(', ');
  const dateStart = request.dates[0] || '__________';
  const dateEnd = request.dates[request.dates.length - 1] || '__________';
  const guestsCount = request.contractData.guestsCount || 2;
  const price = request.price || { total: 0, discountTotal: 0, baseTotal: 0 };
  const owner = process.env.OWNER_NAME || 'Собственник';
  const ownerPhone = process.env.OWNER_PHONE || '________________';
  const address = process.env.ADDRESS || '[адрес]';

  return `📄 *ДОГОВОР КРАТКОСРОЧНОГО НАЙМА ЖИЛОГО ПОМЕЩЕНИЯ*\n\n` +
    `1. Стороны\n` +
    `Наймодатель: ${owner}, телефон: ${ownerPhone}\n` +
    `Наниматель: ${fullName}, паспорт: ${passport}, телефон: ${phone}\n\n` +
    `2. Предмет договора\n` +
    `Наймодатель предоставляет Нанимателю для временного проживания квартиру по адресу: ${address}.\n\n` +
    `3. Срок найма и стоимость\n` +
    `Даты проживания: с ${dateStart} 15:00 по ${dateEnd} 11:00.\n` +
    `Количество гостей: ${guestsCount}\n` +
    `Базовая стоимость: ${price.baseTotal} ₽\n` +
    `Скидка: ${price.discountTotal > 0 ? `-${price.discountTotal}₽` : '0₽'}\n` +
    (price.thirdGuestTotal > 0 ? `Доплата за 3-го гостя: ${price.thirdGuestTotal} ₽\n` : '') +
    `Депозит: ${price.deposit} ₽\n` +
    `Итого к оплате: ${price.total} ₽\n\n` +
    `4. Обязанности Нанимателя\n` +
    `• Соблюдать тишину с 22:00 до 08:00\n` +
    `• Не курить в квартире и на балконе\n` +
    `• Не передавать код доступа третьим лицам\n` +
    `• Бережно относиться к имуществу\n\n` +
    `5. Ответственность\n` +
    `Наниматель несёт полную материальную ответственность за ущерб имуществу и соседям.\n\n` +
    `6. Подтверждение личности и номера телефона\n` +
    `Наниматель подтверждает, что номер телефона принадлежит ему, и согласен с условиями договора.\n\n` +
    `7. Согласие на обработку персональных данных\n` +
    `Данные хранятся на сервере на территории РФ и не передаются третьим лицам.\n\n` +
    `8. Расторжение\n` +
    `При грубом нарушении правил Наймодатель вправе расторгнуть договор досрочно. Депозит в этом случае не возвращается. При отмене брони по инициативе Нанимателя предоплата не возвращается.\n\n` +
    `9. Подписание\n` +
    `Договор подписывается путём обмена электронными сообщениями.\n\n` +
    `Для подписания нажмите кнопку «✅ Подтверждаю и подписываю».`;
}

async function sendOwnerInterruptedNotice(request) {
  if (!request || !request.ownerId) return;
  const collected = [];
  collected.push(`🔔 *Гость прервал оформление.*`);
  collected.push(`Даты: ${request.dates.join(', ')}`);
  if (request.contractData.fullName) collected.push(`ФИО: ${request.contractData.fullName}`);
  if (request.contractData.passport) collected.push(`Паспорт: ${request.contractData.passport}`);
  if (request.contractData.phone) collected.push(`Телефон: ${request.contractData.phone}`);
  if (request.contractData.guestsCount) collected.push(`Количество гостей: ${request.contractData.guestsCount}`);
  collected.push(`Шаг остановки: ${request.step || 'не начат'}`);
  collected.push(`Статус: ${request.status}`);
  await sendMessage(request.ownerId, collected.join('\n'));
}

async function checkExpiredRequests() {
  const now = Date.now();
  for (let [id, request] of requests) {
    if ((request.status === 'reserved' || request.status === 'contract_in_progress' || request.status === 'contract_sent' || request.status === 'contract_awaiting_signature') && request.reservationExpires && request.reservationExpires < now) {
      console.log(`Заявка ${id} просрочена`);
      await sendOwnerInterruptedNotice(request);
      if (request.guestUserId) {
        await sendMessage(request.guestUserId, 'Время резерва истекло. Бронь отменена.');
      }
      requests.delete(id);
    }
  }
}

async function processContractStep(userId, text, attachments, request) {
  if (/^(отменить|отмена|отменить резерв)$/i.test(text.trim())) {
    request.status = 'cancelled';
    console.log(`Заявка ${request.requestId} отменена гостем во время оформления`);
    await sendOwnerInterruptedNotice(request);
    await sendMessage(userId, 'Резерв отменён. Даты освобождены.');
    requests.delete(request.requestId);
    return;
  }

  const step = request.step;

  if (step === 'full_name') {
    request.contractData.fullName = text.trim();
    request.step = 'passport';
    await sendMessage(userId, 'Спасибо! Теперь укажите серию и номер паспорта (например, 4510 123456):');
  } else if (step === 'passport') {
    if (!isValidPassport(text)) {
      await sendMessage(userId, 'Неверный формат паспорта. Введите 10 цифр: 4 цифры серия и 6 цифр номер (можно с пробелами или дефисами).');
      return;
    }
    request.contractData.passport = text.trim();
    request.step = 'phone';
    await sendMessage(userId, 'Укажите номер телефона (можно с +7, 8 или просто 10 цифр):');
  } else if (step === 'phone') {
    const normalized = normalizePhone(text);
    if (!normalized) {
      await sendMessage(userId, 'Неверный формат номера. Введите ещё раз.');
      return;
    }
    request.contractData.phone = normalized;
    request.smsCode = '1234';
    request.step = 'sms_code';
    await sendMessage(userId, `На номер ${normalized} отправлен SMS-код (заглушка: ${request.smsCode}). Введите код:`);
  } else if (step === 'sms_code') {
    const code = text.trim();
    if (!/^\d+$/.test(code)) {
      await sendMessage(userId, 'Код должен содержать только цифры. Попробуйте ещё раз:');
      return;
    }
    if (code === request.smsCode) {
      request.step = 'guests_count';
      await sendMessage(userId, 'Сколько гостей будет проживать?', getGuestsKeyboard());
    } else {
      await sendMessage(userId, 'Неверный код, попробуйте ещё раз:');
    }
  } else if (step === 'guests_count') {
    await sendMessage(userId, 'Пожалуйста, выберите количество гостей кнопками.');
  } else if (step === 'selfie') {
    const hasAttachment = attachments && attachments.length > 0;
    if (hasAttachment) {
      const imageAttachment = attachments.find(att => att.type === 'image') || attachments[0];
      request.contractData.selfie = imageAttachment.payload?.token || imageAttachment.payload?.url || 'received';
      request.status = 'contract_sent';
      request.step = null;
      console.log(`Данные по заявке ${request.requestId} собраны, отправляем договор`);

      const price = calculatePrice(request.dates, request.contractData.guestsCount);
      request.price = price;

      const contractText = buildContractText(request);
      await sendMessage(userId, contractText, getContractSignKeyboard(request.requestId));
    } else {
      await sendMessage(userId, 'Пожалуйста, отправьте фото (селфи с паспортом).');
    }
  } else if (step === 'awaiting_phrase') {
    if (text && text.trim().length > 0) {
      request.status = 'contract_signed';
      request.step = null;
      console.log(`Договор по заявке ${request.requestId} подписан гостем`);
      const ownerText = `🔔 Гость подписал договор.\n\n` +
        `Даты: ${request.dates.join(', ')}\n` +
        `ФИО: ${request.contractData.fullName}\n` +
        `Паспорт: ${request.contractData.passport}\n` +
        `Телефон: ${request.contractData.phone}\n` +
        `Количество гостей: ${request.contractData.guestsCount}\n` +
        `Сумма к оплате: ${request.price.total} ₽\n\n` +
        `Статус: ожидает оплаты`;
      await sendMessage(request.ownerId, ownerText, getOwnerConfirmationKeyboard(request.requestId, request.dates.join(', ')));
      await sendMessage(userId, '✅ Договор подписан! Ожидайте подтверждения оплаты от владельца.');
    } else {
      await sendMessage(userId, 'Пожалуйста, отправьте текст подтверждения.');
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
    await checkExpiredRequests();

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

      let activeContractRequest = null;
      for (let [id, req] of requests) {
        if (req.guestUserId === userId && (req.status === 'contract_in_progress' || req.status === 'contract_awaiting_signature')) {
          activeContractRequest = req;
          break;
        }
      }

      if (activeContractRequest) {
        await processContractStep(userId, text, attachments, activeContractRequest);
        return;
      }

      if (/^\d{2}\.\d{2}\.\d{4}$/.test(text)) {
        let activeSelectingRequest = null;
        for (let [id, req] of requests) {
          if (req.guestUserId === userId && req.status === 'selecting_dates') {
            activeSelectingRequest = req;
            break;
          }
        }

        if (activeSelectingRequest) {
          if (activeSelectingRequest.dates.includes(text)) {
            await sendMessage(userId, `Дата ${text} уже выбрана. Добавьте другую дату или нажмите «Готово».`, getAddDateKeyboard());
          } else {
            activeSelectingRequest.dates.push(text);
            await sendMessage(userId, `Дата ${text} добавлена. Добавить ещё дату?`, getAddDateKeyboard());
          }
        } else {
          const requestId = generateRequestId(userId);
          const request = {
            requestId,
            guestUserId: userId,
            ownerId: Number(process.env.OWNER_ID),
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
        await sendMessage(userId, 'Меню:', getMenuKeyboard());
      } else if (payload === 'rules') {
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
      } else if (payload === 'guests_2' || payload === 'guests_3') {
        let activeContractRequest = null;
        for (let [id, req] of requests) {
          if (req.guestUserId === userId && req.status === 'contract_in_progress' && req.step === 'guests_count') {
            activeContractRequest = req;
            break;
          }
        }
        if (activeContractRequest) {
          const guestsCount = payload === 'guests_2' ? 2 : 3;
          activeContractRequest.contractData.guestsCount = guestsCount;
          activeContractRequest.step = 'selfie';

          const price = calculatePrice(activeContractRequest.dates, guestsCount);
          activeContractRequest.price = price;

          const priceText = `💰 *Стоимость бронирования:*\n${price.details}\n\nИтого: ${price.total} ₽\n\nТеперь отправьте селфи с паспортом в развернутом виде (фото).`;
          await sendMessage(userId, priceText);
        } else {
          await sendMessage(userId, 'Не удалось определить заявку для выбора гостей.');
        }
      } else if (payload.startsWith('confirm_')) {
        const requestId = payload.replace('confirm_', '');
        const request = requests.get(requestId);
        if (request && request.status === 'pending_confirmation' && request.guestUserId === userId) {
          request.status = 'reserved';
          request.reservationExpires = Date.now() + 60 * 60 * 1000; // 60 минут
          console.log(`Заявка ${requestId} переведена в статус reserved`);
          const datesStr = request.dates.join(', ');
          await sendMessage(userId, `✅ Дата(ы) ${datesStr} зарезервированы на 60 минут. Пожалуйста, оформите договор и оплатите за это время.`, getReservationKeyboard(requestId));
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
          await sendOwnerInterruptedNotice(request);
          await sendMessage(userId, 'Резерв отменён. Даты освобождены.');
          requests.delete(requestId);
        } else {
          await sendMessage(userId, 'Не удалось отменить резерв.');
        }
      } else if (payload.startsWith('sign_contract_')) {
        const requestId = payload.replace('sign_contract_', '');
        const request = requests.get(requestId);
        if (request && request.status === 'contract_sent' && request.guestUserId === userId) {
          request.status = 'contract_awaiting_signature';
          request.step = 'awaiting_phrase';
          const phrase = `${request.contractData.fullName}, паспорт ${request.contractData.passport}, даты проживания ${request.dates.join(', ')}, с условиями договора краткосрочного найма ознакомлен и согласен. Оплату произвёл. Скан договора со своей подписью обязуюсь предоставить.`;
          // Отправляем сообщение с фразой и кнопкой копирования
          await sendMessage(userId, `Для завершения подписания отправьте мне сообщение:\n\n"${phrase}"`, getClipboardKeyboard(phrase));
        } else {
          await sendMessage(userId, 'Не удалось подписать договор. Заявка не найдена или уже обработана.');
        }
      } else if (payload.startsWith('reject_contract_')) {
        const requestId = payload.replace('reject_contract_', '');
        const request = requests.get(requestId);
        if (request && request.status === 'contract_sent' && request.guestUserId === userId) {
          request.status = 'cancelled';
          console.log(`Гость отклонил договор по заявке ${requestId}`);
          await sendOwnerInterruptedNotice(request);
          await sendMessage(userId, 'Договор отклонён. Резерв отменён.');
          requests.delete(requestId);
        } else {
          await sendMessage(userId, 'Не удалось отклонить договор.');
        }
      } else if (payload.startsWith('paid_')) {
        const requestId = payload.replace('paid_', '');
        const request = requests.get(requestId);
        if (request && userId === request.ownerId && request.status === 'contract_signed') {
          request.status = 'paid';
          console.log(`Заявка ${requestId} оплачена`);
          const datesStr = request.dates.join(', ');
          const key = `KEY-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
          await sendMessage(request.guestUserId, `✅ Оплата получена! Бронь на даты ${datesStr} подтверждена.\n\nВаш электронный ключ: ${key}\n\nСмотри кино. Спи крепко.`);
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
      { url: webhookUrl, update_types: updateTypes, secret: secret || undefined },
      { headers: { 'Authorization': process.env.BOT_TOKEN, 'Content-Type': 'application/json' } }
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
