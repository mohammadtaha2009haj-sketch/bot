const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function envCheck() {
  const missing = ['TELEGRAM_BOT_TOKEN','ADMIN_CHAT_ID','SUPABASE_URL','SUPABASE_SERVICE_ROLE_KEY']
    .filter(k => !process.env[k]);
  if (missing.length) throw new Error(`Missing environment variables: ${missing.join(', ')}`);
}

async function telegram(method, body) {
  const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await r.json();
  if (!data.ok) throw new Error(`Telegram ${method}: ${JSON.stringify(data)}`);
  return data.result;
}

async function supabase(path, options = {}) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: options.prefer || 'return=representation',
      ...(options.headers || {})
    }
  });
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!r.ok) throw new Error(`Supabase ${r.status}: ${text}`);
  return data;
}

function textOf(m) { return (m?.text || m?.caption || '').trim(); }
function receiptData(m) {
  if (Array.isArray(m?.photo) && m.photo.length) {
    const p = m.photo[m.photo.length - 1];
    return { file_id: p.file_id, unique_id: p.file_unique_id, type: 'photo' };
  }
  if (m?.document) return {
    file_id: m.document.file_id,
    unique_id: m.document.file_unique_id,
    type: 'document'
  };
  return null;
}

function esc(value) {
  return String(value ?? '').replace(/([\\`*_{}\[\]()<>#+\-.!|])/g, '\\$1');
}

export default async function handler(req, res) {
  if (req.method === 'GET') return res.status(200).send('Telegram Order Bot is running.');
  if (req.method !== 'POST') return res.status(405).json({ ok: false });

  try {
    envCheck();
    const update = req.body || {};
    const message = update.message;
    if (!message?.chat?.id) return res.status(200).json({ ok: true });

    const chatId = message.chat.id;
    const from = message.from || {};
    const now = new Date().toISOString();
    const incomingText = textOf(message);

    const customers = await supabase(
      `bot_customers?telegram_chat_id=eq.${encodeURIComponent(chatId)}&select=*`
    );
    let customer = customers?.[0];

    if (!customer) {
      const created = await supabase('bot_customers', {
        method: 'POST',
        body: JSON.stringify({
          telegram_chat_id: chatId,
          telegram_user_id: from.id ?? null,
          username: from.username ?? null,
          first_name: from.first_name ?? null,
          last_name: from.last_name ?? null,
          updated_at: now
        })
      });
      customer = created?.[0];
    } else {
      const updated = await supabase(`bot_customers?id=eq.${customer.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          telegram_user_id: from.id ?? customer.telegram_user_id ?? null,
          username: from.username ?? customer.username ?? null,
          first_name: from.first_name ?? customer.first_name ?? null,
          last_name: from.last_name ?? customer.last_name ?? null,
          updated_at: now
        })
      });
      customer = updated?.[0] || customer;
    }

    if (incomingText.toLowerCase() === '/start' || incomingText.toLowerCase() === '/cancel') {
      await supabase(`orders?telegram_chat_id=eq.${encodeURIComponent(chatId)}&status=in.(collecting,pending_admin)`, {
        method: 'PATCH',
        body: JSON.stringify({ status: 'cancelled', current_step: 'completed', updated_at: now })
      });

      if (incomingText.toLowerCase() === '/cancel') {
        await telegram('sendMessage', { chat_id: chatId, text: 'سفارش فعلی لغو شد. برای ثبت سفارش جدید /start را بفرستید.' });
        return res.status(200).json({ ok: true });
      }

      const created = await supabase('orders', {
        method: 'POST',
        body: JSON.stringify({
          customer_id: customer.id,
          telegram_chat_id: chatId,
          product_code: 'PENDING',
          status: 'collecting',
          current_step: 'product_code'
        })
      });
      if (!created?.[0]) throw new Error('Could not create order');
      await telegram('sendMessage', {
        chat_id: chatId,
        text: 'سلام 👋\nبرای ثبت سفارش، کد محصول را ارسال کنید.\n\nدر هر مرحله فقط اطلاعات خواسته‌شده را بفرستید.'
      });
      return res.status(200).json({ ok: true });
    }

    const orders = await supabase(
      `orders?telegram_chat_id=eq.${encodeURIComponent(chatId)}&status=eq.collecting&order=created_at.desc&limit=1&select=*`
    );
    let order = orders?.[0];

    if (!order) {
      await telegram('sendMessage', { chat_id: chatId, text: 'برای شروع ثبت سفارش، /start را ارسال کنید.' });
      return res.status(200).json({ ok: true });
    }

    if (order.current_step === 'product_code') {
      if (!incomingText || incomingText.length > 100) {
        await telegram('sendMessage', { chat_id: chatId, text: 'کد محصول معتبر نیست. لطفاً فقط کد محصول را ارسال کنید.' });
      } else {
        const updated = await supabase(`orders?id=eq.${order.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ product_code: incomingText, current_step: 'customer_name', updated_at: now })
        });
        order = updated?.[0] || order;
        await telegram('sendMessage', { chat_id: chatId, text: 'نام و نام خانوادگی خود را ارسال کنید.' });
      }
    } else if (order.current_step === 'customer_name') {
      if (!incomingText || incomingText.length > 150) {
        await telegram('sendMessage', { chat_id: chatId, text: 'نام و نام خانوادگی را به‌صورت کامل ارسال کنید.' });
      } else {
        const updated = await supabase(`orders?id=eq.${order.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ customer_name: incomingText, current_step: 'address', updated_at: now })
        });
        order = updated?.[0] || order;
        await telegram('sendMessage', { chat_id: chatId, text: 'آدرس دقیق دریافت سفارش را ارسال کنید.' });
      }
    } else if (order.current_step === 'address') {
      if (!incomingText || incomingText.length < 5 || incomingText.length > 1000) {
        await telegram('sendMessage', { chat_id: chatId, text: 'لطفاً آدرس دقیق و کامل را ارسال کنید.' });
      } else {
        const updated = await supabase(`orders?id=eq.${order.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ address: incomingText, current_step: 'receipt', updated_at: now })
        });
        order = updated?.[0] || order;
        await telegram('sendMessage', { chat_id: chatId, text: 'حالا تصویر یا فایل رسید پرداخت را ارسال کنید. 📎' });
      }
    } else if (order.current_step === 'receipt') {
      const rec = receiptData(message);
      if (!rec) {
        await telegram('sendMessage', { chat_id: chatId, text: 'لطفاً رسید پرداخت را به‌صورت عکس یا فایل ارسال کنید.' });
      } else {
        const updated = await supabase(`orders?id=eq.${order.id}`, {
          method: 'PATCH',
          body: JSON.stringify({
            receipt_file_id: rec.file_id,
            receipt_file_unique_id: rec.unique_id,
            receipt_type: rec.type,
            status: 'pending_admin',
            current_step: 'completed',
            completed_at: now,
            updated_at: now
          })
        });
        order = updated?.[0] || order;

        // Telegram media captions have a 1024-character limit.
        const caption = `🛒 سفارش جدید\n\n📦 کد محصول: ${order.product_code}\n👤 نام: ${order.customer_name}\n📍 آدرس: ${order.address}\n🆔 سفارش: ${order.id}`;
        if (caption.length > 1024) throw new Error('Order caption exceeds Telegram 1024-character media caption limit');

        let adminMessage;
        if (rec.type === 'photo') {
          adminMessage = await telegram('sendPhoto', { chat_id: ADMIN_CHAT_ID, photo: rec.file_id, caption });
        } else {
          adminMessage = await telegram('sendDocument', { chat_id: ADMIN_CHAT_ID, document: rec.file_id, caption });
        }

        await supabase(`orders?id=eq.${order.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ admin_message_id: adminMessage.message_id, updated_at: now })
        });

        await telegram('sendMessage', {
          chat_id: chatId,
          text: '✅ سفارش شما با موفقیت ثبت شد.\nاطلاعات سفارش برای مدیریت ارسال شد.'
        });
      }
    }

    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error(error);
    return res.status(200).json({ ok: false, error: 'internal_error' });
  }
}
