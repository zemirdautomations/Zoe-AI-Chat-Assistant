# ZemiRD Automations — Zoe v4.2 Deployment Guide
## zemirdautomations.com

---

## STEP 1 — Update your Railway environment variables

Go to Railway → Zoe-AI-Chat-Assistant → Variables → Raw Editor and paste ALL of these:

```
ANTHROPIC_API_KEY=sk-ant-...
TWILIO_ACCOUNT_SID=AC...
TWILIO_AUTH_TOKEN=...
TWILIO_WHATSAPP_NUMBER=whatsapp:+14155238886
OWNER_WHATSAPP=whatsapp:+18098094666253
DATABASE_URL=postgresql://postgres:...@caboose.proxy.rlwy.net:44469/railway
COLMADO_NAME=Colmado ZemiRD Demo
COLMADO_OWNER=Danilo Pierre
COLMADO_BARRIO=Piantini
COLMADO_ADDRESS=Calle Principal #1, Piantini, Santo Domingo
COLMADO_PHONE=8094666253
COLMADO_WHATSAPP=whatsapp:+18094666253
COLMADO_HOURS=Lun-Dom 7am-10pm
DELIVERY_TIME=20-30 minutos
DELIVERY_ZONE=Piantini y alrededores
MIN_DELIVERY=RD$100
PLAN_TIER=basic
DASHBOARD_PASSWORD=zoe2024
PROMO_SEMANA=
PORT=8080
NODE_ENV=production
```

---

## STEP 2 — Replace index.js on GitHub

```cmd
cd "C:\Users\danil\OneDrive\Desktop\BUSINESS PROJECT\ZOE CHATBOT FILES\Zoe_AI_Chat_Assistant\Zoe AI Chat Assistant"

copy index.js index.js.backup

:: Copy the new index.js here, then:
git add index.js
git commit -m "Zoe v4.2 - complete rebuild with all plan tiers"
git push origin main
```

Railway will auto-deploy from GitHub.

---

## STEP 3 — Update package.json

Make sure your package.json has pg (PostgreSQL):

```json
{
  "name": "zemird-colmado-bot",
  "version": "4.2.0",
  "main": "index.js",
  "scripts": {
    "start": "node index.js"
  },
  "dependencies": {
    "@anthropic-ai/sdk": "^0.20.0",
    "dotenv": "^16.0.0",
    "express": "^4.18.0",
    "twilio": "^4.19.0",
    "pg": "^8.11.0"
  }
}
```

---

## STEP 4 — Deploy Dashboard to Railway

The dashboard.html is a standalone file. Deploy it as a static site on Railway:

1. In Railway → Your Project → click "+ New Service"
2. Choose "Empty Service"
3. Name it: "zoe-dashboard"
4. Upload dashboard.html
5. Or: add it to your GitHub repo and Railway auto-deploys

OR — Deploy to Cloudflare Pages (FREE, uses your domain):

1. Go to dash.cloudflare.com
2. Click "Pages" → "Create a project" → "Direct Upload"
3. Upload dashboard.html
4. Set custom domain: dashboard.zemirdautomations.com
5. Done! Your dashboard is at dashboard.zemirdautomations.com

---

## STEP 5 — Configure Cloudflare DNS (zemirdautomations.com)

In Cloudflare → zemirdautomations.com → DNS:

| Type  | Name        | Content                                    | Notes           |
|-------|-------------|--------------------------------------------|-----------------|
| CNAME | www         | zemirdautomations.com                      | Main site       |
| CNAME | dashboard   | [your-cf-pages-url].pages.dev              | Admin dashboard |
| CNAME | api         | zoe-ai-chat-assistant-production.up.railway.app | Bot API    |
| MX    | @           | route1.mx.cloudflare.net                   | Email routing   |

Email routing (free in Cloudflare):
- support@zemirdautomations.com → zemird.automations@gmail.com
- sales@zemirdautomations.com → zemird.automations@gmail.com
- billing@zemirdautomations.com → zemird.automations@gmail.com
- partners@zemirdautomations.com → zemird.automations@gmail.com

Go to: Cloudflare → zemirdautomations.com → Email → Email Routing → Enable
Add each address above as a "Custom address" and route to your Gmail.

---

## STEP 6 — Disconnect Replit NeonDB

In Railway → Zoe-AI-Chat-Assistant → Variables:
- DATABASE_URL should point to Railway PostgreSQL (caboose.proxy.rlwy.net)
- NOT the NeonDB URL (neondb_owner@...)

In Replit → if you still have it running, just stop using it.
The Railway bot now saves everything to Railway PostgreSQL.
The new dashboard connects directly to Railway.

---

## STEP 7 — Test Everything

Send these 4 test messages to your WhatsApp bot:

1. "Mándame 2 Presidente jumbo y una bolsa de hielo"
   → Should reply with itemized order + TOTAL: RD$

2. "¿Cuánto le debo?"
   → Should check fiado balance

3. "Hello, are you open?"
   → Should respond in English with hours

4. "Quiero hablar con alguien"
   → Should return ALL contact info

5. Complete an order → owner should receive WhatsApp notification
6. Owner replies "ENVIADO" → customer should get delivery notification

---

## DASHBOARD LOGIN

URL: https://dashboard.zemirdautomations.com (after Cloudflare setup)
Or: Your Railway dashboard service URL

- API URL: https://zoe-ai-chat-assistant-production.up.railway.app
- Password: whatever you set as DASHBOARD_PASSWORD in Railway

---

## PER-CLIENT DEPLOYMENT (when onboarding new colmados)

```cmd
:: 1. Create client folder
mkdir zemird-colmado-[nombre-cliente]
cd zemird-colmado-[nombre-cliente]

:: 2. Copy bot files
xcopy "..\Zoe_AI_Chat_Assistant\Zoe AI Chat Assistant\*" . /E /H /Y

:: 3. Install
npm install

:: 4. Create .env with client data
:: 5. Railway: New project → deploy
railway init
railway up
railway domain

:: 6. Update Twilio webhook with new URL/webhook
:: 7. Give client their dashboard URL
```

---

## CONTACTS

| Role        | Email                              |
|-------------|-------------------------------------|
| Support     | support@zemirdautomations.com       |
| Sales       | sales@zemirdautomations.com         |
| Billing     | billing@zemirdautomations.com       |
| Partners    | partners@zemirdautomations.com      |
| Web         | zemirdautomations.com               |

Built by ZemiRD Automations — Dominican Republic's AI Agency
