const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY;

function envCheck() {
  const missing = [
    'TELEGRAM_BOT_TOKEN',
    'ADMIN_CHAT_ID',
    'SUPABASE_URL',
    'SUPABASE_SERVICE_ROLE_KEY'
  ].filter((key) => !process.env[key]);

  if (missing.length) {
    throw new Error(
      `Missing environment variables: ${missing.join(', ')}`
    );
  }
}

async function telegram(method, body) {
  const response = await fetch(
    `https://api.telegram.org/bot${BOT_TOKEN}/${method}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    }
  );

  const data = await response.json();

  if (!response.ok || !data.ok) {
    throw new Error(
      `Telegram ${method}: ${JSON.stringify(data)}`
    );
  }

  return data.result;
}

async function supabase(path, options = {}) {
  const response = await fetch(
    `${SUPABASE_URL}/rest/v1/${path}`,
    {
      ...options,
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: options.prefer || 'return=representation',
        ...(options.headers || {})
      }
    }
  );

  const responseText = await response.text();
  let data = null;

  try {
    data = responseText ? JSON.parse(responseText) : null;
  } catch {
    data = responseText;
  }

  if (!response.ok) {
    throw new Error(
      `Supabase ${response.status}: ${responseText}`
    );
  }

  return data;
}

function textOf(message) {
  return (message?.text || message?.caption || '').trim();
}

function receiptData(message) {
  if (Array.isArray(message?.photo) && message.photo.length) {
    const photo = message.photo[message.photo.length - 1];

    return {
      file_id: photo.file_id,
      unique_id: photo.file_unique_id,
      type: 'photo',
      mime_type: 'image/jpeg'
    };
  }

  if (message?.document) {
    return {
      file_id: message.document.file_id,
      unique_id: message.document.file_unique_id,
      type: 'document',
      mime_type:
        message.document.mime_type || 'application/octet-stream',
      file_name: message.document.file_name || null
    };
  }

  return null;
}

/**
 * دانلود رسید از Telegram و ذخیره در Supabase Storage خصوصی.
 * مسیر ذخیره‌شده در orders.receipt_storage_path قرار می‌گیرد.
 */
async function storeReceiptInStorage(orderId, receipt) {
  const fileInfo = await telegram('getFile', {
    file_id: receipt.file_id
  });

  if (!fileInfo?.file_path) {
    throw new Error('Telegram did not return file_path');
  }

  const downloadUrl =
    `https://api.telegram.org/file/bot${BOT_TOKEN}/${fileInfo.file_path}`;

  const fileResponse = await fetch(downloadUrl);

  if (!fileResponse.ok) {
    throw new Error(
      `Telegram file download failed: ${fileResponse.status}`
    );
  }

  const fileBuffer = await fileResponse.arrayBuffer();

  let extension = '.bin';

  if (receipt.type === 'photo') {
    extension = '.jpg';
  } else {
    const originalName =
      receipt.file_name ||
      fileInfo.file_path.split('/').pop() ||
      '';

    const match = originalName.match(/\.[a-zA-Z0-9]{1,10}$/);

    if (match) {
      extension = match[0].toLowerCase();
    }
  }

  extension = extension.replace(/[^a-zA-Z0-9.]/g, '');

  const storagePath =
    `orders/${orderId}/receipt-${Date.now()}${extension}`;

  const uploadResponse = await fetch(
    `${SUPABASE_URL}/storage/v1/object/order-receipts/${storagePath}`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        'Content-Type':
          receipt.mime_type || 'application/octet-stream',
        'x-upsert': 'true'
      },
      body: fileBuffer
    }
  );

  const uploadText = await uploadResponse.text();

  if (!uploadResponse.ok) {
    throw new Error(
      `Supabase Storage ${uploadResponse.status}: ${uploadText}`
    );
  }

  await supabase(
    `orders?id=eq.${encodeURIComponent(orderId)}`,
    {
      method: 'PATCH',
      body: JSON.stringify({
        receipt_storage_path: storagePath,
        updated_at: new Date().toISOString()
      })
    }
  );

  return storagePath;
}

async function sendMessage(chatId, text) {
  return telegram('sendMessage', {
    chat_id: chatId,
    text
  });
}

export default async function handler(req, res) {
  if (req.method === 'GET') {
    return res.status(200).send('Telegram Order Bot is running.');
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false });
  }

  try {
    envCheck();

    const update = req.body || {};
    const message = update.message;

    if (!message?.chat?.id) {
      return res.status(200).json({ ok: true });
    }

    const chatId = message.chat.id;
    const from = message.from || {};
    const now = new Date().toISOString();
    const incomingText = textOf(message);
    const normalizedText = incomingText.toLowerCase();

    // پیدا کردن یا ثبت مشتری
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
      const updated = await supabase(
        `bot_customers?id=eq.${customer.id}`,
        {
          method: 'PATCH',
          body: JSON.stringify({
            telegram_user_id:
              from.id ?? customer.telegram_user_id ?? null,
            username:
              from.username ?? customer.username ?? null,
            first_name:
              from.first_name ?? customer.first_name ?? null,
            last_name:
              from.last_name ?? customer.last_name ?? null,
            updated_at: now
          })
        }
      );

      customer = updated?.[0] || customer;
    }

    if (!customer?.id) {
      throw new Error('Could not find or create customer');
    }

    // شروع یا لغو سفارش
    if (normalizedText === '/start' || normalizedText === '/cancel') {
      await supabase(
        `orders?telegram_chat_id=eq.${encodeURIComponent(chatId)}&status=in.(collecting,pending_admin)`,
        {
          method: 'PATCH',
          body: JSON.stringify({
            status: 'cancelled',
            current_step: 'completed',
            updated_at: now
          })
        }
      );

      if (normalizedText === '/cancel') {
        await sendMessage(
          chatId,
          'سفارش فعلی لغو شد. برای ثبت سفارش جدید /start را بفرستید.'
        );

        return res.status(200).json({ ok: true });
      }

      const created = await supabase('orders', {
        method: 'POST',
        body: JSON.stringify({
          customer_id: customer.id,
          telegram_chat_id: chatId,
          product_code: 'PENDING',
          quantity: 1,
          status: 'collecting',
          current_step: 'product_code'
        })
      });

      if (!created?.[0]) {
        throw new Error('Could not create order');
      }

      await sendMessage(
        chatId,
        'سلام 👋\nبرای ثبت سفارش، کد محصول را ارسال کنید.'
      );

      return res.status(200).json({ ok: true });
    }

    // پیدا کردن سفارش در حال تکمیل
    const orders = await supabase(
      `orders?telegram_chat_id=eq.${encodeURIComponent(chatId)}&status=eq.collecting&order=created_at.desc&limit=1&select=*`
    );

    let order = orders?.[0];

    if (!order) {
      await sendMessage(
        chatId,
        'برای شروع ثبت سفارش، /start را ارسال کنید.'
      );

      return res.status(200).json({ ok: true });
    }

    // مرحله ۱: کد محصول
    if (order.current_step === 'product_code') {
      if (!incomingText || incomingText.length > 100) {
        await sendMessage(
          chatId,
          'کد محصول معتبر نیست. لطفاً فقط کد محصول را ارسال کنید.'
        );
      } else {
        const updated = await supabase(
          `orders?id=eq.${encodeURIComponent(order.id)}`,
          {
            method: 'PATCH',
            body: JSON.stringify({
              product_code: incomingText,
              current_step: 'quantity',
              updated_at: now
            })
          }
        );

        order = updated?.[0] || order;

        await sendMessage(
          chatId,
          '🔢 چه تعداد از این محصول می‌خواهید؟\nلطفاً یک عدد صحیح بین 1 تا 10000 وارد کنید.'
        );
      }
    }

    // مرحله ۲: تعداد محصول
    else if (order.current_step === 'quantity') {
      const quantityText = incomingText;
      const quantity = Number(quantityText);

      if (
        !/^[0-9]+$/.test(quantityText) ||
        !Number.isSafeInteger(quantity) ||
        quantity < 1 ||
        quantity > 10000
      ) {
        await sendMessage(
          chatId,
          '❌ تعداد نامعتبر است.\nلطفاً یک عدد صحیح بین 1 تا 10000 وارد کنید؛ مثلاً 3.'
        );
      } else {
        const updated = await supabase(
          `orders?id=eq.${encodeURIComponent(order.id)}`,
          {
            method: 'PATCH',
            body: JSON.stringify({
              quantity,
              current_step: 'customer_name',
              updated_at: now
            })
          }
        );

        order = updated?.[0] || {
          ...order,
          quantity,
          current_step: 'customer_name'
        };

        await sendMessage(
          chatId,
          'نام و نام خانوادگی خود را ارسال کنید.'
        );
      }
    }

    // مرحله ۳: نام مشتری
    else if (order.current_step === 'customer_name') {
      if (!incomingText || incomingText.length > 150) {
        await sendMessage(
          chatId,
          'نام و نام خانوادگی را به‌صورت کامل ارسال کنید.'
        );
      } else {
        const updated = await supabase(
          `orders?id=eq.${encodeURIComponent(order.id)}`,
          {
            method: 'PATCH',
            body: JSON.stringify({
              customer_name: incomingText,
              current_step: 'address',
              updated_at: now
            })
          }
        );

        order = updated?.[0] || order;

        await sendMessage(
          chatId,
          'آدرس دقیق دریافت سفارش را ارسال کنید.'
        );
      }
    }

    // مرحله ۴: آدرس
    else if (order.current_step === 'address') {
      if (
        !incomingText ||
        incomingText.length < 5 ||
        incomingText.length > 1000
      ) {
        await sendMessage(
          chatId,
          'لطفاً آدرس دقیق و کامل را ارسال کنید.'
        );
      } else {
        const updated = await supabase(
          `orders?id=eq.${encodeURIComponent(order.id)}`,
          {
            method: 'PATCH',
            body: JSON.stringify({
              address: incomingText,
              current_step: 'receipt',
              updated_at: now
            })
          }
        );

        order = updated?.[0] || order;

        await sendMessage(
          chatId,
          'حالا تصویر یا فایل رسید پرداخت را ارسال کنید. 📎'
        );
      }
    }

    // مرحله ۵: رسید و تکمیل سفارش
    else if (order.current_step === 'receipt') {
      const receipt = receiptData(message);

      if (!receipt) {
        await sendMessage(
          chatId,
          'لطفاً رسید پرداخت را به‌صورت عکس یا فایل ارسال کنید.'
        );
      } else {
        // ذخیره اطلاعات سفارش و رسید پیش از انتقال فایل
        const updated = await supabase(
          `orders?id=eq.${encodeURIComponent(order.id)}`,
          {
            method: 'PATCH',
            body: JSON.stringify({
              receipt_file_id: receipt.file_id,
              receipt_file_unique_id: receipt.unique_id,
              receipt_type: receipt.type,
              status: 'pending_admin',
              current_step: 'completed',
              completed_at: now,
              updated_at: now
            })
          }
        );

        order = updated?.[0] || order;

        // انتقال رسید به Storage؛ خطای Storage سفارش را حذف نمی‌کند
        try {
          const storagePath = await storeReceiptInStorage(
            order.id,
            receipt
          );

          order.receipt_storage_path = storagePath;

          console.log(
            `Receipt stored successfully for order ${order.id}`
          );
        } catch (storageError) {
          console.error(
            `Receipt Storage error for order ${order.id}:`,
            storageError
          );
        }

        const caption =
          `🛒 سفارش جدید\n\n` +
          `📦 کد محصول: ${order.product_code}\n` +
          `🔢 تعداد: ${order.quantity ?? 1}\n` +
          `👤 نام: ${order.customer_name}\n` +
          `📍 آدرس: ${order.address}\n` +
          `🆔 سفارش: ${order.id}`;

        let adminMessage;

        if (receipt.type === 'photo') {
          adminMessage = await telegram('sendPhoto', {
            chat_id: ADMIN_CHAT_ID,
            photo: receipt.file_id,
            caption
          });
        } else {
          adminMessage = await telegram('sendDocument', {
            chat_id: ADMIN_CHAT_ID,
            document: receipt.file_id,
            caption
          });
        }

        await supabase(
          `orders?id=eq.${encodeURIComponent(order.id)}`,
          {
            method: 'PATCH',
            body: JSON.stringify({
              admin_message_id: adminMessage.message_id,
              updated_at: new Date().toISOString()
            })
          }
        );

        await sendMessage(
          chatId,
          '✅ سفارش شما با موفقیت ثبت شد.\nاطلاعات سفارش برای مدیریت ارسال شد.'
        );
      }
    }

    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error(error);

    return res.status(200).json({
      ok: false,
      error: 'internal_error'
    });
  }
}