import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;

async function tg(method, body) {
  const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify(body)
  });
  const data = await r.json();
  if (!data.ok) throw new Error(`Telegram ${method}: ${JSON.stringify(data)}`);
  return data.result;
}

function textOf(m) { return (m?.text || m?.caption || '').trim(); }
function validReceipt(m) { return Array.isArray(m?.photo) || !!m?.document; }
function receiptData(m) {
  if (Array.isArray(m.photo) && m.photo.length) {
    const p = m.photo[m.photo.length - 1];
    return { file_id:p.file_id, unique_id:p.file_unique_id, type:'photo' };
  }
  if (m.document) return { file_id:m.document.file_id, unique_id:m.document.file_unique_id, type:'document' };
  return null;
}

export async function POST(req) {
  try {
    const update = await req.json();
    const m = update?.message;
    if (!m?.chat?.id) return Response.json({ok:true});
    const chatId = m.chat.id;
    const from = m.from || {};

    // Ignore duplicate Telegram webhook deliveries.
    const { data: customer } = await supabase.from('bot_customers').upsert({
      telegram_chat_id: chatId,
      telegram_user_id: from.id ?? null,
      username: from.username ?? null,
      first_name: from.first_name ?? null,
      last_name: from.last_name ?? null,
      updated_at: new Date().toISOString()
    }, { onConflict:'telegram_chat_id' }).select().single();

    if (textOf(m).toLowerCase() === '/start') {
      await supabase.from('orders').update({status:'cancelled', current_step:'completed', updated_at:new Date().toISOString()})
        .eq('telegram_chat_id', chatId).in('status',['collecting','pending_admin']);
      const { data: order } = await supabase.from('orders').insert({
        customer_id: customer.id, telegram_chat_id: chatId, status:'collecting', current_step:'product_code'
      }).select().single();
      await tg('sendMessage',{chat_id:chatId,text:'سلام 👋\nبرای ثبت سفارش، کد محصول را ارسال کنید.\n\nدر هر مرحله فقط همان اطلاعات خواسته‌شده را بفرستید.'});
      return Response.json({ok:true});
    }

    let { data: order } = await supabase.from('orders').select('*').eq('telegram_chat_id',chatId)
      .eq('status','collecting').order('created_at',{ascending:false}).limit(1).maybeSingle();
    if (!order) {
      await tg('sendMessage',{chat_id:chatId,text:'برای شروع ثبت سفارش، /start را ارسال کنید.'});
      return Response.json({ok:true});
    }

    const value = textOf(m);
    const now = new Date().toISOString();

    if (order.current_step === 'product_code') {
      if (!value || value.length > 100) {
        await tg('sendMessage',{chat_id:chatId,text:'کد محصول معتبر نیست. لطفاً فقط کد محصول را ارسال کنید.'});
      } else {
        const { data } = await supabase.from('orders').update({product_code:value,current_step:'customer_name',updated_at:now}).eq('id',order.id).select().single();
        order=data;
        await tg('sendMessage',{chat_id:chatId,text:'نام و نام خانوادگی خود را ارسال کنید.'});
      }
    } else if (order.current_step === 'customer_name') {
      if (!value || value.length > 150) {
        await tg('sendMessage',{chat_id:chatId,text:'نام و نام خانوادگی را به‌صورت کامل ارسال کنید.'});
      } else {
        const { data } = await supabase.from('orders').update({customer_name:value,current_step:'address',updated_at:now}).eq('id',order.id).select().single();
        order=data;
        await tg('sendMessage',{chat_id:chatId,text:'آدرس دقیق دریافت سفارش را ارسال کنید.'});
      }
    } else if (order.current_step === 'address') {
      if (!value || value.length < 5 || value.length > 1000) {
        await tg('sendMessage',{chat_id:chatId,text:'لطفاً آدرس دقیق و کامل را ارسال کنید.'});
      } else {
        const { data } = await supabase.from('orders').update({address:value,current_step:'receipt',updated_at:now}).eq('id',order.id).select().single();
        order=data;
        await tg('sendMessage',{chat_id:chatId,text:'حالا تصویر یا فایل رسید پرداخت را ارسال کنید. 📎'});
      }
    } else if (order.current_step === 'receipt') {
      if (!validReceipt(m)) {
        await tg('sendMessage',{chat_id:chatId,text:'لطفاً رسید پرداخت را به‌صورت عکس یا فایل ارسال کنید.'});
      } else {
        const rec=receiptData(m);
        const { data } = await supabase.from('orders').update({receipt_file_id:rec.file_id,receipt_file_unique_id:rec.unique_id,receipt_type:rec.type,status:'pending_admin',current_step:'completed',completed_at:now,updated_at:now}).eq('id',order.id).select().single();
        order=data;
        const caption = `🛒 سفارش جدید\n\n📦 کد محصول: ${order.product_code}\n👤 نام و نام خانوادگی: ${order.customer_name}\n📍 آدرس: ${order.address}\n🆔 شناسه سفارش: ${order.id}\n\n📱 Telegram Chat ID: ${chatId}`;
        if (rec.type === 'photo') await tg('sendPhoto',{chat_id:ADMIN_CHAT_ID,photo:rec.file_id,caption});
        else await tg('sendDocument',{chat_id:ADMIN_CHAT_ID,document:rec.file_id,caption});
        await tg('sendMessage',{chat_id:chatId,text:'✅ سفارش شما با موفقیت ثبت شد.\nاطلاعات سفارش برای مدیریت ارسال شد.'});
      }
    } else {
      await tg('sendMessage',{chat_id:chatId,text:'این سفارش قبلاً ثبت شده است. برای سفارش جدید /start را ارسال کنید.'});
    }

    return Response.json({ok:true});
  } catch (e) {
    console.error(e);
    return Response.json({ok:false}, {status:200});
  }
}

export async function GET() { return new Response('Telegram Order Bot is running.', {status:200}); }
