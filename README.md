# Telegram Order Bot

Flow: /start -> product code -> full name -> exact address -> receipt photo/document -> one consolidated admin message containing the receipt and all order details.

## Vercel environment variables
- TELEGRAM_BOT_TOKEN: BotFather token (never commit it)
- ADMIN_CHAT_ID: admin Telegram chat ID
- SUPABASE_URL: https://afgjkvoacpgbrmunvslf.supabase.co
- SUPABASE_SERVICE_ROLE_KEY: Supabase service-role key (never expose client-side)

After deployment, set Telegram webhook to:
https://YOUR-VERCEL-DOMAIN.vercel.app/api/telegram

Open that URL in a browser; it should say: Telegram Order Bot is running.
