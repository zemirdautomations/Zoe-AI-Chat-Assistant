/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║   ZemiRD Automations — Zoe AI Assistant v6.0                ║
 * ║   Built for the Dominican Republic Market                   ║
 * ║   Colmados · Restaurants · Barbershops · Salons             ║
 * ║   support@zemirdautomations.com                             ║
 * ╚══════════════════════════════════════════════════════════════╝
 *
 * CLEAN BUILD — No patches, no leftovers.
 *
 * Features:
 * - Tier system: Basic / Pro / Premium (single source of truth)
 * - Voice notes: AssemblyAI transcription (Pro+)
 * - Address collected AFTER order closes (never mid-browse)
 * - Zero "OK" ghost messages (res.status(200).end())
 * - Promo mentioned inline, never as separate message
 * - SSE live feed for dashboard sync (/api/stream)
 * - Runtime tier upgrade (/api/upgrade)
 * - Demo endpoint for onboarding portal (/api/demo)
 * - Full 50-product bilingual inventory preloaded
 */

'use strict';
require('dotenv').config();

const express      = require('express');
const twilio       = require('twilio');
const Anthropic    = require('@anthropic-ai/sdk');
const { Pool }     = require('pg');
const https        = require('https');

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// ─── CORS ─────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  next();
});

// ─── CONFIG ───────────────────────────────────────────────────
const CONFIG = {
  colmadoName:    process.env.COLMADO_NAME      || 'Colmado ZemiRD Demo',
  industry:       process.env.INDUSTRY           || 'Colmado',
  location:       process.env.LOCATION           || 'Los Mina, Santo Domingo Este, República Dominicana',
  colmadoOwner:   process.env.COLMADO_OWNER     || 'Danilo Pierre',
  colmadoBarrio:  process.env.COLMADO_BARRIO    || 'Los Mina',
  colmadoAddress: process.env.COLMADO_ADDRESS   || 'Calle Principal #1, Los Mina, Santo Domingo Este',
  colmadoPhone:   process.env.COLMADO_PHONE     || '8094666253',
  colmadoHours:   process.env.COLMADO_HOURS     || 'Lun-Dom 8am-11pm',
  deliveryTime:   process.env.DELIVERY_TIME     || '20-30 minutos',
  deliveryZone:   process.env.DELIVERY_ZONE     || 'Los Mina y alrededores',
  minDelivery:    process.env.MIN_DELIVERY      || 'RD$100',
  promoSemana:    process.env.PROMO_SEMANA      || 'Compra 2 frías y llévate 3 por precio de 2',
  ownerWhatsapp:  process.env.OWNER_WHATSAPP    || '',
  planTier:       process.env.PLAN_TIER         || 'pro',
  twilioNumber:   process.env.TWILIO_WHATSAPP_NUMBER || 'whatsapp:+14155238886',
  port:           parseInt(process.env.PORT)    || 8080,
  googleSheetsId: process.env.GOOGLE_SHEETS_ID  || '',
  googleSheetsKey:process.env.GOOGLE_SHEETS_API_KEY || '',
  dashboardPass:  process.env.DASHBOARD_PASSWORD || 'zemird2026',
  timezone:       'America/Santo_Domingo',
  support:        'support@zemirdautomations.com',
  website:        'zemirdautomations.com',
  prices: {
    basic:   { monthly: 4500, onb_min: 6750,  onb_max: 13500 },
    pro:     { monthly: 5500, onb_min: 8250,  onb_max: 16500 },
    premium: { monthly: 9000, onb_min: 13500, onb_max: 27000 },
  },
};

// ─── TIER SYSTEM — single source of truth ─────────────────────
const getTier = () => (CONFIG.planTier || 'basic').toLowerCase();

const TIER = {
  // All tiers
  hasOrderFlow:       () => true,
  hasOwnerNotif:      () => true,
  hasReceipt:         () => true,
  hasPromo:           () => true,
  hasHoursEnforce:    () => true,
  hasGoodbye:         () => true,
  hasFiaoCheck:       () => true,
  hasEnviado:         () => true,
  hasInventoryFAQ:    () => true,
  // Pro+
  hasVoiceIn:         () => ['pro','premium'].includes(getTier()),
  hasGoogleSheets:    () => ['pro','premium'].includes(getTier()),
  hasPersistentDB:    () => ['pro','premium'].includes(getTier()),
  hasDashboard:       () => ['pro','premium'].includes(getTier()),
  hasReturningMem:    () => ['pro','premium'].includes(getTier()),
  hasSentimentCheck:  () => ['pro','premium'].includes(getTier()),
  hasWeeklyReport:    () => ['pro','premium'].includes(getTier()),
  // Premium only
  hasMultiLocation:   () => getTier() === 'premium',
  hasCustomPersona:   () => getTier() === 'premium',
  hasProactiveFollow: () => getTier() === 'premium',
  hasCustomWebhook:   () => getTier() === 'premium',
  hasCRMBrain:        () => getTier() === 'premium',
};

// ─── CLIENTS ──────────────────────────────────────────────────
const anthropic    = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const db           = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

// ─── SSE CLIENTS ──────────────────────────────────────────────
const sseClients = new Set();
function broadcastSSE(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    try { client.res.write(msg); } catch (e) { sseClients.delete(client); }
  }
}

// ─── IN-MEMORY STATE ──────────────────────────────────────────
const conversations      = new Map(); // phone → { messages[], lastActivity }
const customerLocations  = new Map(); // phone → { address, lat, lng }
const orderStates        = new Map(); // phone → order state machine
const pendingOrders      = new Map(); // phone → stalled order
const lastCompletedOrder = new Map(); // phone → last completed order
const ownerLastCustomer  = new Map(); // ownerPhone → last customer phone
let   orderCounter       = 1000;

// ─── DATABASE ─────────────────────────────────────────────────
async function initDB() {
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS orders (
        id SERIAL PRIMARY KEY,
        order_number VARCHAR(20) UNIQUE,
        phone VARCHAR(30),
        items TEXT,
        items_summary TEXT,
        total DECIMAL(10,2),
        address TEXT,
        latitude DECIMAL(10,7),
        longitude DECIMAL(10,7),
        status VARCHAR(30) DEFAULT 'completed',
        plan_tier VARCHAR(20),
        voice_order BOOLEAN DEFAULT false,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS conversations (
        id SERIAL PRIMARY KEY,
        phone VARCHAR(30) UNIQUE,
        messages JSONB DEFAULT '[]',
        customer_type VARCHAR(20) DEFAULT 'new',
        last_address TEXT,
        last_lat DECIMAL(10,7),
        last_lng DECIMAL(10,7),
        order_count INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS fiao (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100),
        phone VARCHAR(30) UNIQUE,
        balance DECIMAL(10,2) DEFAULT 0,
        last_credit DECIMAL(10,2) DEFAULT 0,
        last_payment DECIMAL(10,2) DEFAULT 0,
        last_credit_at TIMESTAMP,
        last_payment_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS inventory (
        id SERIAL PRIMARY KEY,
        name_es VARCHAR(200),
        name_en VARCHAR(200),
        price DECIMAL(10,2),
        available BOOLEAN DEFAULT true,
        category VARCHAR(100),
        emoji VARCHAR(10) DEFAULT '📦',
        sale_type VARCHAR(50) DEFAULT 'unit',
        created_at TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS config_store (
        key VARCHAR(100) PRIMARY KEY,
        value TEXT,
        updated_at TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS clients (
        id SERIAL PRIMARY KEY,
        business_name VARCHAR(200),
        owner_name VARCHAR(100),
        phone VARCHAR(30) UNIQUE,
        whatsapp VARCHAR(30),
        barrio VARCHAR(100),
        address TEXT,
        plan_tier VARCHAR(20) DEFAULT 'basic',
        status VARCHAR(20) DEFAULT 'active',
        dashboard_password VARCHAR(100),
        railway_url TEXT,
        notes TEXT,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);

    // Load order counter
    const res = await db.query(`SELECT value FROM config_store WHERE key='order_counter'`);
    if (res.rows.length > 0) {
      orderCounter = parseInt(res.rows[0].value) || 1000;
    } else {
      await db.query(`INSERT INTO config_store (key,value) VALUES ('order_counter','1000') ON CONFLICT DO NOTHING`);
    }

    // Load persisted tier
    const tierRes = await db.query(`SELECT value FROM config_store WHERE key='plan_tier'`);
    if (tierRes.rows.length > 0) CONFIG.planTier = tierRes.rows[0].value;

    // Seed inventory if empty
    const invCount = await db.query('SELECT COUNT(*) FROM inventory');
    if (parseInt(invCount.rows[0].count) === 0) await seedInventory();

    console.log(`✅ DB ready | Plan: ${CONFIG.planTier} | Counter: ${orderCounter}`);
  } catch (e) {
    console.error('❌ DB init error:', e.message);
  }
}

async function seedInventory() {
  const products = [
    // Abarrotes
    ['Arroz Blanco','White Rice',35,'Abarrotes','🌾','libra'],
    ['Habichuelas Rojas','Red Beans',40,'Abarrotes','🫘','libra'],
    ['Aceite de Cocina','Cooking Oil',120,'Abarrotes','🫙','unidad'],
    ['Azúcar Crema','Refined Sugar',30,'Abarrotes','🍬','libra'],
    ['Sal Molida','Salt',15,'Abarrotes','🧂','sobre'],
    ['Pasta de Tomate','Tomato Paste',25,'Abarrotes','🍅','lata'],
    ['Soportita (Caldo de Pollo)','Chicken Bouillon',10,'Abarrotes','🍗','tableta'],
    ['Espaguetis','Spaghetti',45,'Abarrotes','🍝','paquete'],
    ['Ajo','Garlic',20,'Abarrotes','🧄','unidad'],
    ['Vinagre','Vinegar',35,'Abarrotes','🫙','botella'],
    // Fresco
    ['Plátanos','Green Plantains',15,'Fresco','🫛','unidad'],
    ['Huevos','Eggs',16,'Fresco','🥚','unidad'],
    ['Pollo Fresco','Whole Chicken',95,'Fresco','🍗','libra'],
    ['Salami Induveca','Salami',85,'Fresco','🥩','libra'],
    ['Cebollas Rojas','Red Onions',25,'Fresco','🧅','unidad'],
    ['Guineos Verdes','Green Bananas',10,'Fresco','🍌','unidad'],
    ['Yuca','Cassava',30,'Fresco','🌿','libra'],
    ['Aguacate','Avocado',40,'Fresco','🥑','unidad'],
    ['Papas','Potatoes',35,'Fresco','🥔','libra'],
    ['Verdurita','Cilantro/Vegetables',20,'Fresco','🌿','atado'],
    // Desayuno
    ['Café Santo Domingo','Ground Coffee',35,'Desayuno','☕','sobre'],
    ['Leche Evaporada','Evaporated Milk',75,'Desayuno','🥛','lata'],
    ['Leche en Polvo Milex','Powdered Milk',120,'Desayuno','🥛','lata'],
    ['Pan de Agua','Water Bread',10,'Desayuno','🍞','unidad'],
    ['Pan Sobao','Soft Bread',12,'Desayuno','🍞','unidad'],
    ['Chocolate Embajador','Hot Chocolate',45,'Desayuno','🍫','tableta'],
    ['Mantequilla','Butter/Margarine',55,'Desayuno','🧈','barra'],
    ['Avena','Oatmeal',25,'Desayuno','🌾','sobre'],
    ['Corn Flakes','Corn Flakes',85,'Desayuno','🥣','cajita'],
    ['Mermelada','Jam',65,'Desayuno','🍓','unidad'],
    // Bebidas
    ['Cerveza Presidente Grande','Large Beer',120,'Bebidas','🍺','botella'],
    ['Cerveza Presidente Pequeña','Small Beer',80,'Bebidas','🍺','botella'],
    ['Cerveza Presidente Mediana','Medium Beer',100,'Bebidas','🍺','botella'],
    ['Cerveza Brahma','Brahma Beer',100,'Bebidas','🍺','botella'],
    ['Refresco 2L','Soft Drink 2L',95,'Bebidas','🥤','botella'],
    ['Refresquito','Small Soda',25,'Bebidas','🥤','unidad'],
    ['Agua Botella','Bottled Water',30,'Bebidas','💧','botella'],
    ['Botellón de Agua','Water Jug',120,'Bebidas','💧','botellón'],
    ['Malta Morena','Malt Drink',55,'Bebidas','🍺','botella'],
    ['Ron Brugal Chatita','Rum (Small)',150,'Bebidas','🥃','chatita'],
    ['Bebida Energizante','Energy Drink',75,'Bebidas','⚡','unidad'],
    ['Jugo de Cartón','Juice (Carton)',45,'Bebidas','🧃','unidad'],
    // Higiene
    ['Jabón de Cuaba','Laundry Soap',35,'Higiene','🧼','barra'],
    ['Papel Higiénico','Toilet Paper',30,'Higiene','🧻','rollo'],
    ['Detergente Ace','Detergent',25,'Higiene','🫧','sobre'],
    ['Lavaplatos Axión','Dish Soap',45,'Higiene','🫧','unidad'],
    ['Cloro','Bleach',50,'Higiene','🫙','unidad'],
    ['Jabón de Baño','Bath Soap',30,'Higiene','🧼','unidad'],
    ['Pasta Dental','Toothpaste',75,'Higiene','🦷','unidad'],
    ['Desodorante','Deodorant',120,'Higiene','✨','unidad'],
    // Snacks
    ['Platanitos','Plantain Chips',30,'Snacks','🍟','paquete'],
    ['Galletitas de Soda','Crackers',25,'Snacks','🍘','paquete'],
    // Hielo
    ['Hielo (Bolsa)','Ice Bag',75,'Bebidas','🧊','bolsa'],
  ];

  for (const [name_es, name_en, price, category, emoji, sale_type] of products) {
    await db.query(
      `INSERT INTO inventory (name_es,name_en,price,available,category,emoji,sale_type)
       VALUES ($1,$2,$3,true,$4,$5,$6) ON CONFLICT DO NOTHING`,
      [name_es, name_en, price, category, emoji, sale_type]
    ).catch(() => {});
  }
  console.log(`🛒 Inventory seeded: ${products.length} products`);
}

// ─── INVENTORY IN MEMORY ──────────────────────────────────────
let productosList = [];
let fiaoCuentas   = [];

async function loadInventory() {
  try {
    const res = await db.query('SELECT * FROM inventory WHERE available=true ORDER BY category, name_es');
    productosList = res.rows;
  } catch (e) {}
}

async function loadFiao() {
  try {
    const res = await db.query('SELECT * FROM fiao');
    fiaoCuentas = res.rows;
  } catch (e) {}
}

function getInventoryText() {
  if (!productosList.length) return 'Inventario completo disponible en tienda.';
  const byCat = {};
  for (const p of productosList) {
    if (!byCat[p.category]) byCat[p.category] = [];
    byCat[p.category].push(`${p.emoji} ${p.name_es} (${p.name_en}): RD$${p.price} por ${p.sale_type}`);
  }
  return Object.entries(byCat)
    .map(([cat, items]) => `[${cat}]\n${items.join('\n')}`)
    .join('\n\n');
}

function getFiaoBalance(phone) {
  const clean = phone.replace(/\D/g, '').slice(-10);
  const acc = fiaoCuentas.find(f => f.phone?.replace(/\D/g, '').slice(-10) === clean);
  return acc ? acc.balance : null;
}

// ─── GOOGLE SHEETS SYNC (Pro+) ────────────────────────────────
async function syncGoogleSheets() {
  if (!TIER.hasGoogleSheets() || !CONFIG.googleSheetsId || !CONFIG.googleSheetsKey) return;
  try {
    const base = `https://sheets.googleapis.com/v4/spreadsheets/${CONFIG.googleSheetsId}/values`;
    const key  = `?key=${CONFIG.googleSheetsKey}`;
    const [invRes, fiaoRes, cfgRes] = await Promise.all([
      fetch(`${base}/Inventario!A2:G200${key}`),
      fetch(`${base}/Fiao!A2:D200${key}`),
      fetch(`${base}/Config!A1:B20${key}`),
    ]);
    if (invRes.ok) {
      const d = await invRes.json();
      productosList = (d.values || []).map(r => ({
        name_es: r[0], name_en: r[1] || r[0],
        price: parseFloat(r[2]) || 0,
        available: (r[3]||'si').toLowerCase() === 'si',
        category: r[4] || 'General',
        emoji: r[5] || '📦',
        sale_type: r[6] || 'unidad',
      })).filter(p => p.available);
    }
    if (fiaoRes.ok) {
      const d = await fiaoRes.json();
      fiaoCuentas = (d.values || []).map(r => ({ name: r[0], phone: r[1], balance: parseFloat(r[2]) || 0 }));
    }
    if (cfgRes.ok) {
      const d = await cfgRes.json();
      (d.values || []).forEach(r => { if (r[0] === 'Promocion_semana') CONFIG.promoSemana = r[1]; });
    }
    console.log(`✅ Sheets synced: ${productosList.length} products`);
  } catch (e) { console.error('⚠️ Sheets sync:', e.message); }
}

// ─── TIME HELPERS ─────────────────────────────────────────────
function getNowDR() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: CONFIG.timezone }));
}
function isOpen() {
  const now = getNowDR();
  const h   = now.getHours();
  const m   = CONFIG.colmadoHours.match(/(\d+)(am|pm).*?(\d+)(am|pm)/i);
  if (!m) return true;
  let open  = parseInt(m[1]); if (m[2].toLowerCase() === 'pm' && open  !== 12) open  += 12;
  let close = parseInt(m[3]); if (m[4].toLowerCase() === 'pm' && close !== 12) close += 12;
  return h >= open && h < close;
}
function timeStr() {
  return getNowDR().toLocaleTimeString('es-DO', { hour: '2-digit', minute: '2-digit', hour12: true, timeZone: CONFIG.timezone });
}
function dateStr() {
  return getNowDR().toLocaleDateString('es-DO', { weekday: 'long', day: 'numeric', month: 'long', timeZone: CONFIG.timezone });
}

// ─── HELPERS ──────────────────────────────────────────────────
function isGoodbye(text) {
  const t = text.toLowerCase().trim();
  return [
    /^(gracias|thank|thanks|ty|thx)$/,
    /^(adiós|adios|hasta luego|bye|chao|chau|ciao)$/,
    /^(eso es todo|that'?s? all|nothing else|nada más|nada mas)$/,
    /^(ok gracias|ok thanks|listo gracias|ya gracias|perfecto gracias)$/,
    /^(listo|todo bien|ya estamos|eso sería todo)$/,
  ].some(r => r.test(t));
}

function looksLikeAddress(text) {
  if (!text || text.length < 6) return false;
  const t = text.toLowerCase();
  const reject = [
    /^(hola|ok|okay|sí|si|no|gracias|buenas|noche|día|eso es todo|nada)/,
    /^(dame|quiero|mándame|agrega|también|otro|otra|y )/,
    /^(espera|wait|momento|enviado|pagado|listo|perfecto)/,
    /litro|libra|unidad|bolsa|jugo|leche|agua|cerveza|refresco|pollo|carne|arroz|pan|huevo|plátano/,
    /RD\$|\d+\s*(peso|libra|litro)/i,
  ];
  if (reject.some(r => r.test(t))) return false;
  const accept = [
    /calle|ave\b|avenida|blvd|carretera/i,
    /\#\s*\d+|\d+\s*[a-z]?\s*,/,
    /sector|residencial|urb|barrio|edificio|apt|apto|piso/i,
    /esquina|entre|frente|detrás|cerca|al lado/i,
    /santo domingo|santiago|la romana|mina|ozama|ensanche|naco|piantini/i,
  ];
  if (accept.some(r => r.test(t))) return true;
  return t.split(/\s+/).length >= 4;
}

async function getNextOrderNumber() {
  orderCounter++;
  try { await db.query(`UPDATE config_store SET value=$1, updated_at=NOW() WHERE key='order_counter'`, [String(orderCounter)]); } catch (e) {}
  return `ZRD-${orderCounter}`;
}

// ─── VOICE: AssemblyAI transcription ──────────────────────────
async function transcribeVoiceNote(mediaUrl) {
  const KEY = process.env.ASSEMBLYAI_API_KEY;
  if (!KEY) { console.error('🎤 ASSEMBLYAI_API_KEY not set'); return null; }

  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken  = process.env.TWILIO_AUTH_TOKEN;
  const authHeader = Buffer.from(`${accountSid}:${authToken}`).toString('base64');

  try {
    // Submit job
    const submitBody = JSON.stringify({
      audio_url:     mediaUrl,
      language_code: 'es',
      speech_model:  'universal-2',
      http_headers:  { Authorization: `Basic ${authHeader}` },
    });

    const submitRes = await new Promise((resolve, reject) => {
      const opts = {
        hostname: 'api.assemblyai.com', path: '/v2/transcript', method: 'POST',
        headers: { Authorization: KEY, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(submitBody) },
      };
      let data = '';
      const req = https.request(opts, r => { r.on('data', c => data += c); r.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } }); });
      req.on('error', reject);
      req.write(submitBody);
      req.end();
    });

    if (!submitRes.id) { console.error('🎤 Submit failed:', JSON.stringify(submitRes)); return null; }
    console.log(`🎤 AssemblyAI job: ${submitRes.id}`);

    // Poll (max 20 seconds)
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 1000));
      const poll = await new Promise((resolve, reject) => {
        const opts = { hostname: 'api.assemblyai.com', path: `/v2/transcript/${submitRes.id}`, method: 'GET', headers: { Authorization: KEY } };
        let data = '';
        https.get(opts, r => { r.on('data', c => data += c); r.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } }); }).on('error', reject);
      });
      if (poll.status === 'completed') {
        const text = poll.text?.trim();
        console.log(`🎤 Transcribed: ${text}`);
        return text?.length > 1 ? text : null;
      }
      if (poll.status === 'error') { console.error('🎤 AssemblyAI error:', poll.error); return null; }
    }
    console.error('🎤 AssemblyAI timeout');
    return null;
  } catch (e) {
    console.error('🎤 AssemblyAI exception:', e.message);
    return null;
  }
}

// ─── WHATSAPP SENDER ──────────────────────────────────────────
async function sendWA(to, body) {
  try {
    const toNum = to.startsWith('whatsapp:') ? to : `whatsapp:${to}`;
    await twilioClient.messages.create({ from: CONFIG.twilioNumber, to: toNum, body });
  } catch (e) { console.error('❌ WA send error:', e.message); }
}

// ─── FORMATTERS ───────────────────────────────────────────────
function fmtReceipt(o) {
  return `🧾 RECIBO DE PEDIDO
━━━━━━━━━━━━━━━━━━━━
🏪 ${CONFIG.colmadoName}
📍 ${CONFIG.colmadoBarrio}
📞 ${CONFIG.colmadoPhone}
━━━━━━━━━━━━━━━━━━━━
🔖 Pedido #: ${o.orderNumber}
📅 ${dateStr()} — ${timeStr()}${o.voiceOrder ? '\n🎤 Pedido por nota de voz' : ''}
━━━━━━━━━━━━━━━━━━━━
📦 DETALLE:
${o.items}
━━━━━━━━━━━━━━━━━━━━
💰 TOTAL: RD$${o.total}
🛵 Delivery: ${CONFIG.deliveryTime}
📬 Dirección: ${o.address}
━━━━━━━━━━━━━━━━━━━━
¡Gracias por preferirnos! 🙏`;
}

function fmtSellerNotif(o) {
  return `🛒 NUEVO PEDIDO — ${CONFIG.colmadoName}
━━━━━━━━━━━━━━━━━━━━
🔖 #${o.orderNumber} | ⏰ ${timeStr()}${o.voiceOrder ? ' 🎤' : ''}
👤 Cliente: +${o.phone}
━━━━━━━━━━━━━━━━━━━━
📦 ${o.items}
━━━━━━━━━━━━━━━━━━━━
💰 TOTAL: RD$${o.total}
📬 ${o.address}
━━━━━━━━━━━━━━━━━━━━
✅ Responde ENVIADO cuando salga 🛵`;
}

function fmtDispatch(o) {
  return `🛵 ¡Tu pedido está en camino! 🎉
━━━━━━━━━━━━━━━━━━━━
🔖 Pedido #${o.orderNumber}
📦 ${o.items}
💰 Total: RD$${o.total}
⏱️ Llega en: ${CONFIG.deliveryTime}
📬 ${o.address}
━━━━━━━━━━━━━━━━━━━━
¡Gracias por preferirnos! 😊🙏`;
}

function detectOrder(text) { return text.includes('TOTAL: RD$') || text.includes('TOTAL:RD$'); }

function extractOrder(text) {
  const lines = text.split('\n').filter(l => l.includes('RD$') && (l.includes('x') || l.includes('•') || l.includes('×')));
  const total = text.match(/TOTAL[^:]*:\s*RD\$([0-9,]+)/)?.[1]?.replace(',', '') || '0';
  return { items: lines.join('\n').trim(), total };
}

// ─── DB HELPERS ───────────────────────────────────────────────
async function saveOrder(o) {
  if (!TIER.hasPersistentDB()) return;
  try {
    await db.query(
      `INSERT INTO orders (order_number,phone,items,items_summary,total,address,latitude,longitude,status,plan_tier,voice_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'completed',$9,$10)
       ON CONFLICT (order_number) DO UPDATE SET updated_at=NOW()`,
      [o.orderNumber, o.phone, o.items, o.items?.substring(0,200), o.total, o.address, o.lat||null, o.lng||null, CONFIG.planTier, o.voiceOrder||false]
    );
  } catch (e) { console.error('❌ DB save order:', e.message); }
}

async function saveConversation(phone, messages, loc) {
  if (!TIER.hasPersistentDB()) return;
  try {
    await db.query(
      `INSERT INTO conversations (phone,messages,last_address,last_lat,last_lng,customer_type,order_count,updated_at)
       VALUES ($1,$2,$3,$4,$5,'returning',1,NOW())
       ON CONFLICT (phone) DO UPDATE SET
         messages=$2, last_address=COALESCE($3,conversations.last_address),
         last_lat=COALESCE($4,conversations.last_lat), last_lng=COALESCE($5,conversations.last_lng),
         customer_type='returning', order_count=conversations.order_count+1, updated_at=NOW()`,
      [phone, JSON.stringify(messages), loc?.address||null, loc?.lat||null, loc?.lng||null]
    );
  } catch (e) {}
}

async function getCustomer(phone) {
  if (!TIER.hasPersistentDB()) return null;
  try {
    const r = await db.query('SELECT * FROM conversations WHERE phone=$1', [phone]);
    return r.rows[0] || null;
  } catch (e) { return null; }
}

// ─── MASTER PROMPT TEMPLATES (business-agnostic) ─────────────
const MASTER_PROMPT_TPL =
  'Eres Zoe 🤖✨, la asistente IA bilingüe de {{BUSINESS_NAME}} ({{INDUSTRY}} en {{LOCATION}}).\n' +
  'Idioma por defecto: Español Dominicano (coloquial, cálido, directo).\n' +
  'Detecta idioma automáticamente y responde en el mismo idioma del cliente.\n' +
  'Tu meta: resolver la necesidad del cliente en el menor número de pasos posibles.\n' +
  'Tier activo: {{TIER}}.';

const TIER_RULES = {
  basic: [
    '📋 TIER BÁSICO:',
    '- Responde FAQs (horario, dirección, precios, inventario)',
    '- Captura nombre y teléfono del cliente para seguimiento',
    '- NO completes reservas directas — di: "Alguien del equipo te confirmará pronto 😊"',
  ].join('\n'),
  pro: [
    '📋 TIER PRO (incluye todo el Basic):',
    '- Toma pedidos completos con precios y TOTAL',
    '- Aplica promociones automáticamente',
    '- Maneja clientes recurrentes (dirección guardada)',
    '- Procesa notas de voz',
    '- Sugiere upsells: "¿Le agrego un hielo? 🧊"',
  ].join('\n'),
  premium: [
    '📋 TIER PREMIUM (incluye todo el Pro):',
    '- Memoria CRM: recuerda pedidos anteriores y preferencias',
    '- Múltiples sucursales',
    '- Seguimiento proactivo de pedidos pendientes',
    '- Reportes semanales automáticos',
  ].join('\n'),
};

const INDUSTRY_RULES = {
  colmado: [
    '🏪 COLMADO — Formato de pedido OBLIGATORIO (sin texto antes):',
    '• [Producto] x[cantidad] = RD$[subtotal]',
    'TOTAL: RD$[total]',
    '¿Y qué más le pongo? 🛵',
    'NUNCA preguntes por dirección durante el pedido.',
    'NUNCA digas "en camino" — eso lo confirma el dueño con ENVIADO.',
    'Promos siempre inline, nunca como mensaje separado.',
  ].join('\n'),
  restaurant: [
    '🍔 RESTAURANTE — Toma el pedido con modificaciones ("sin cebolla", "extra picante").',
    'Confirma: ¿para llevar o delivery? Si delivery, captura dirección.',
    'Da tiempo estimado de preparación. Sugiere bebida o postre.',
  ].join('\n'),
  barbershop: [
    '✂️ BARBERÍA/SALÓN — Pregunta por barbero/estilista de preferencia.',
    'Ofrece servicios disponibles con precios. Confirma fecha y hora del turno.',
  ].join('\n'),
  general: [
    '📋 NEGOCIO GENERAL — Responde FAQs. Captura nombre y teléfono.',
    'Transfiere a humano si la consulta es compleja.',
  ].join('\n'),
};

// ─── SYSTEM PROMPT BUILDER ────────────────────────────────────
function buildPrompt(phone, customerType, fiaoBalance) {
  const open         = isOpen();
  const inventory    = getInventoryText();
  const promo        = CONFIG.promoSemana ? `\n🎉 PROMOCIÓN ACTIVA: ${CONFIG.promoSemana}` : '';
  const fiao         = fiaoBalance !== null ? `\n💳 FIADO ESTE CLIENTE: RD$${fiaoBalance}` : '';
  const locInfo      = TIER.hasReturningMem() && customerType === 'returning'
    ? '\n📍 CLIENTE RECURRENTE: Dirección guardada — NO pedir dirección.'
    : '\n📍 CLIENTE NUEVO: NO pedir dirección — el sistema la solicita al cerrar el pedido.';
  const industryKey  = (CONFIG.industry || 'colmado').toLowerCase();
  const industryRule = INDUSTRY_RULES[industryKey] || INDUSTRY_RULES.general;
  const tierRule     = TIER_RULES[getTier()] || TIER_RULES.basic;

  const basePrompt = MASTER_PROMPT_TPL
    .replace('{{BUSINESS_NAME}}', CONFIG.colmadoName)
    .replace('{{INDUSTRY}}',      CONFIG.industry || 'Colmado')
    .replace('{{LOCATION}}',      CONFIG.location || `${CONFIG.colmadoBarrio}, República Dominicana`)
    .replace('{{TIER}}',          getTier().toUpperCase());

  const closedMsg = !open
    ? `\n⚠️ CERRADOS AHORA (${timeStr()}). Anota el pedido SIN generar TOTAL. Promete: "Mañana cuando abramos te confirmo 😊".`
    : '';

  return `${basePrompt}
${tierRule}
${industryRule}

🕐 AHORA: ${timeStr()} — ${dateStr()}
📅 ${open ? '✅ ABIERTOS' : `❌ CERRADOS (${CONFIG.colmadoHours})`}${closedMsg}

🎭 PERSONALIDAD (CRÍTICO):
- Dominicana, cálida, graciosa. La vecina más cool del barrio 🏘️
- "¡Tamo' con eso! 🔥", "¡Claro mi amor!", "¡Qué bueno!"
- NUNCA "OK" solo. NUNCA "Entendido". NUNCA mensaje vacío.
- Máximo 5 líneas. Saluda diferente cada vez. Detecta idioma automático.

💡 EJEMPLOS: "OK" → "¡Tamo' con eso! 🔥" | "Entendido" → "¡Claro que sí! 💪"

🛑 DESPEDIDA ("gracias","eso es todo","bye","listo"): Cariño + humor. NO pidas dirección.

🏪 NEGOCIO: ${CONFIG.colmadoName} | ${CONFIG.colmadoAddress}
📞 ${CONFIG.colmadoPhone} | ⏰ ${CONFIG.colmadoHours}
🛵 ${CONFIG.deliveryTime} | Zona: ${CONFIG.deliveryZone} | Mínimo: ${CONFIG.minDelivery}
${promo}${fiao}${locInfo}

📋 INVENTARIO:
${inventory}`;
}

// ─── COMPLETE ORDER ───────────────────────────────────────────
async function completeOrder(phone, from, locData, state) {
  if (state.timer) clearTimeout(state.timer);
  const orderNumber = await getNextOrderNumber();
  const orderData   = {
    orderNumber, phone,
    items:      state.items,
    total:      state.total,
    address:    locData.address,
    lat:        locData.lat,
    lng:        locData.lng,
    voiceOrder: state.voiceOrder || false,
  };

  if (TIER.hasReturningMem()) customerLocations.set(phone, locData);
  await saveConversation(phone, conversations.get(phone)?.messages || [], locData);
  await sendWA(from, fmtReceipt(orderData));
  await saveOrder(orderData);

  if (CONFIG.ownerWhatsapp) {
    await sendWA(CONFIG.ownerWhatsapp, fmtSellerNotif(orderData));
    const ownerPhone = CONFIG.ownerWhatsapp.replace('whatsapp:','').replace('+','');
    ownerLastCustomer.set(ownerPhone, phone);
  }

  lastCompletedOrder.set(phone, orderData);
  broadcastSSE('new_order', {
    orderNumber: orderData.orderNumber,
    phone:       orderData.phone,
    items:       orderData.items,
    total:       orderData.total,
    address:     orderData.address,
    voiceOrder:  orderData.voiceOrder,
    timestamp:   new Date().toISOString(),
  });

  setTimeout(() => orderStates.delete(phone), 500);
  console.log(`✅ Order ${orderNumber} | ${phone} | RD$${orderData.total}`);
}

// ─── ORDER TIMEOUT ────────────────────────────────────────────
async function orderTimeout(phone, from) {
  const state = orderStates.get(phone);
  if (!state) return;

  const memLoc = TIER.hasReturningMem() ? customerLocations.get(phone) : null;
  const dbCust = await getCustomer(phone);
  const dbLoc  = dbCust?.last_address ? { address: dbCust.last_address, lat: dbCust.last_lat, lng: dbCust.last_lng } : null;
  const loc    = memLoc || dbLoc;

  if (loc) {
    await completeOrder(phone, from, loc, state);
    return;
  }

  // No saved location — ask for address (AFTER order is closed)
  state.state = 'awaiting_location';
  orderStates.set(phone, state);
  await sendWA(from, '📍 ¡Perfecto! ¿A qué dirección te lo enviamos? 🛵\nEscríbela o comparte tu ubicación 📌');

  state.timer = setTimeout(async () => {
    const s = orderStates.get(phone);
    if (s?.state === 'awaiting_location') {
      await sendWA(from, '📍 Oye, ¿cuál es tu dirección? ¡El delivery está listo pa\' salir! 🛵');
      state.timer = setTimeout(async () => {
        const s2 = orderStates.get(phone);
        if (s2?.state === 'awaiting_location') {
          s2.state = 'pending';
          pendingOrders.set(phone, s2);
          orderStates.delete(phone);
          if (CONFIG.ownerWhatsapp) {
            await sendWA(CONFIG.ownerWhatsapp, `⚠️ PEDIDO PENDIENTE — Sin dirección\n👤 +${phone}\n📦 ${s2.items}\n💰 RD$${s2.total}`);
          }
          broadcastSSE('pending_order', { phone, items: s2.items, total: s2.total });
        }
      }, 60000);
      orderStates.set(phone, state);
    }
  }, 30000);
  orderStates.set(phone, state);
}

// ─── MAIN WEBHOOK ─────────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  res.status(200).end(); // ← empty body — no "OK" ghost message

  const from      = req.body.From || '';
  let   body      = (req.body.Body || '').trim();
  const lat       = req.body.Latitude;
  const lng       = req.body.Longitude;
  const address   = req.body.Address || req.body.Label || '';
  const phone     = from.replace('whatsapp:', '').replace('+', '');
  const numMedia  = parseInt(req.body.NumMedia || '0');
  const mediaType = (req.body.MediaContentType0 || '').toLowerCase();
  let   isVoice   = false;

  if (!from) return;

  // ── VOICE ────────────────────────────────────────────────────
  if (numMedia > 0 && (mediaType.includes('audio') || mediaType.includes('ogg') || mediaType.includes('mpeg'))) {
    if (TIER.hasVoiceIn()) {
      const transcribed = await transcribeVoiceNote(req.body.MediaUrl0);
      if (transcribed && transcribed.length > 2) {
        body    = transcribed;
        isVoice = true;
        await sendWA(from, `🎤 Entendí: "${transcribed.substring(0,80)}${transcribed.length>80?'...':''}" ✅`);
        console.log(`🎤 [${phone}]: ${transcribed}`);
      } else {
        await sendWA(from, '🎤 No pude entender bien la nota de voz 😅\n¿Puedes repetirlo o escribirlo?');
        return;
      }
    } else {
      await sendWA(from, '🎤 ¡Las notas de voz están disponibles en el plan Pro! 🚀\nEscríbeme tu pedido y te atiendo enseguida 😊');
      return;
    }
  }

  console.log(`📩 [${timeStr()}] +${phone}: ${body.substring(0, 80)}`);

  // ── ENVIADO (owner command) ───────────────────────────────────
  const ownerPhone = CONFIG.ownerWhatsapp.replace('whatsapp:','').replace('+','');
  if (body.toUpperCase().startsWith('ENVIADO') && CONFIG.ownerWhatsapp &&
      (phone === ownerPhone || `+${phone}` === CONFIG.ownerWhatsapp.replace('whatsapp:',''))) {
    const parts       = body.trim().split(/\s+/);
    const targetPhone = parts[1] ? parts[1].replace('+','') : ownerLastCustomer.get(ownerPhone);
    if (targetPhone) {
      const lastOrder = lastCompletedOrder.get(targetPhone);
      if (lastOrder) {
        await sendWA(`whatsapp:+${targetPhone}`, fmtDispatch(lastOrder));
        orderStates.delete(targetPhone);
        await sendWA(from, `✅ Cliente notificado — pedido #${lastOrder.orderNumber} en camino 🛵`);
        broadcastSSE('order_dispatched', { orderNumber: lastOrder.orderNumber, phone: targetPhone });
      } else {
        await sendWA(from, '⚠️ No encontré pedido reciente para ese cliente.');
      }
    } else {
      await sendWA(from, '⚠️ No hay cliente activo. Usa: ENVIADO +18091234567');
    }
    return;
  }

  // ── CUSTOMER STATE ────────────────────────────────────────────
  const dbCust        = await getCustomer(phone);
  let   customerType  = dbCust?.customer_type || 'new';
  const memLoc        = TIER.hasReturningMem() ? customerLocations.get(phone) : null;
  const dbLoc         = dbCust?.last_address ? { address: dbCust.last_address, lat: dbCust.last_lat, lng: dbCust.last_lng } : null;
  const savedLoc      = memLoc || dbLoc;
  if (savedLoc) customerType = 'returning';

  // ── LOCATION PIN ──────────────────────────────────────────────
  if (lat && lng) {
    const locAddr = address || `${lat}, ${lng}`;
    const locData = { address: locAddr, lat: parseFloat(lat), lng: parseFloat(lng) };
    if (TIER.hasReturningMem()) customerLocations.set(phone, locData);
    const state = orderStates.get(phone);
    if (state && (state.state === 'awaiting_location' || state.state === 'awaiting_extras')) {
      await completeOrder(phone, from, locData, state);
      return;
    }
    await sendWA(from, `📍 ¡Ubicación guardada! ${locAddr} 👌\n¿En qué más te puedo ayudar?`);
    return;
  }

  const state = orderStates.get(phone);

  // ── GOODBYE ───────────────────────────────────────────────────
  if (isGoodbye(body)) {
    if (state?.timer) clearTimeout(state.timer);
    if (state) orderStates.delete(phone);
    // Let Claude generate the farewell naturally (fall through to conversation)
  }

  // ── TEXT ADDRESS ──────────────────────────────────────────────
  if (state?.state === 'awaiting_location' && !isGoodbye(body) && looksLikeAddress(body)) {
    const locData = { address: body };
    if (TIER.hasReturningMem()) customerLocations.set(phone, locData);
    await completeOrder(phone, from, locData, state);
    return;
  }

  // ── WAIT / ADD MORE ───────────────────────────────────────────
  if (state && !isGoodbye(body) &&
      ['espera','wait','momento','agrega','añade','también','tambien','y también','y tambien','más','mas'].some(w => body.toLowerCase().includes(w))) {
    if ((state.resetCount || 0) >= 3) {
      const loc = savedLoc || customerLocations.get(phone);
      if (loc) { await completeOrder(phone, from, loc, state); }
      else { state.state = 'awaiting_location'; orderStates.set(phone, state); await sendWA(from, '📍 ¿A qué dirección te lo enviamos? 😊'); }
    } else {
      state.resetCount = (state.resetCount || 0) + 1;
      if (state.timer) clearTimeout(state.timer);
      state.timer = setTimeout(() => orderTimeout(phone, from), 45000);
      orderStates.set(phone, state);
      await sendWA(from, '¡Claro! ⏰ ¿Qué más le agregamos? 😄');
    }
    return;
  }

  // ── CONVERSATION ──────────────────────────────────────────────
  let conv = conversations.get(phone) || { messages: [], lastActivity: Date.now() };
  conv.lastActivity = Date.now();

  if (!conversations.has(phone) && dbCust?.messages) {
    try {
      const msgs = typeof dbCust.messages === 'string' ? JSON.parse(dbCust.messages) : dbCust.messages;
      conv.messages = msgs.slice(-12);
    } catch (e) {}
  }

  const fiaoBalance = TIER.hasFiaoCheck() ? getFiaoBalance(phone) : null;
  conv.messages.push({ role: 'user', content: body });
  if (conv.messages.length > 16) conv.messages = conv.messages.slice(-16);

  let reply = '';
  try {
    const r = await anthropic.messages.create({
      model:      'claude-sonnet-4-20250514',
      max_tokens: 500,
      system:     buildPrompt(phone, customerType, fiaoBalance),
      messages:   conv.messages,
    });
    reply = r.content[0]?.text || '¡Hola! ¿En qué te puedo ayudar? 😊';
  } catch (e) {
    console.error('❌ Claude error:', e.message);
    reply = `¡Ay, se me fue la luz por un momento! 😅 Llámanos al ${CONFIG.colmadoPhone}`;
  }

  conv.messages.push({ role: 'assistant', content: reply });
  conversations.set(phone, conv);
  await sendWA(from, reply);

  // ── DETECT ORDER ──────────────────────────────────────────────
  if (detectOrder(reply) && !isGoodbye(body) && isOpen()) {
    const { items, total } = extractOrder(reply);
    if (state?.timer) clearTimeout(state.timer);
    const timerMs   = TIER.hasReturningMem() && customerType === 'returning' ? 45000 : 30000;
    const newState  = { state: 'awaiting_extras', items, total, resetCount: 0, phone, from, voiceOrder: isVoice };
    newState.timer  = setTimeout(() => orderTimeout(phone, from), timerMs);
    orderStates.set(phone, newState);
    broadcastSSE('order_started', { phone, total, items: items.substring(0, 100) });
  }
});

// ─── AUTH MIDDLEWARE ──────────────────────────────────────────
const checkAuth = (req, res, next) => {
  const auth = req.headers.authorization || req.query.key;
  if (auth !== CONFIG.dashboardPass && auth !== `Bearer ${CONFIG.dashboardPass}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
};

// ─── SSE LIVE FEED ────────────────────────────────────────────
app.get('/api/stream', checkAuth, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  res.write(`event: connected\ndata: {"status":"connected","plan":"${CONFIG.planTier}"}\n\n`);
  const hb = setInterval(() => { try { res.write(':heartbeat\n\n'); } catch (e) {} }, 20000);
  const client = { res, id: Date.now() };
  sseClients.add(client);
  req.on('close', () => { clearInterval(hb); sseClients.delete(client); });
});

// ─── PLAN UPGRADE ─────────────────────────────────────────────
app.post('/api/upgrade', checkAuth, async (req, res) => {
  const { plan_tier } = req.body;
  if (!['basic','pro','premium'].includes(plan_tier)) return res.status(400).json({ error: 'Use: basic, pro, premium' });
  const prev = CONFIG.planTier;
  CONFIG.planTier = plan_tier;
  try {
    await db.query(`INSERT INTO config_store (key,value,updated_at) VALUES ('plan_tier',$1,NOW()) ON CONFLICT(key) DO UPDATE SET value=$1,updated_at=NOW()`, [plan_tier]);
    broadcastSSE('plan_upgraded', { from: prev, to: plan_tier, prices: CONFIG.prices });
    res.json({ success: true, plan: plan_tier, prices: CONFIG.prices[plan_tier] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── PLAN INFO ────────────────────────────────────────────────
app.get('/api/plan', (req, res) => res.json({
  current:  CONFIG.planTier,
  prices:   CONFIG.prices,
  features: {
    voiceIn:        TIER.hasVoiceIn(),
    googleSheets:   TIER.hasGoogleSheets(),
    persistentDB:   TIER.hasPersistentDB(),
    dashboard:      TIER.hasDashboard(),
    returningMem:   TIER.hasReturningMem(),
    multiLocation:  TIER.hasMultiLocation(),
    customPersona:  TIER.hasCustomPersona(),
    proactive:      TIER.hasProactiveFollow(),
    crmBrain:       TIER.hasCRMBrain(),
  },
}));

// ─── DEMO ENDPOINT (Onboarding Portal) ────────────────────────
app.post('/api/demo', async (req, res) => {
  const { message, history = [] } = req.body;
  if (!message) return res.status(400).json({ error: 'message required' });
  try {
    const demoPrompt = buildPrompt('demo', 'new', null) + '\n\n🎯 MODO DEMO: Estás siendo presentado a un posible cliente. Sé especialmente encantador y muestra todas tus capacidades.';
    const messages   = [...history.slice(-8), { role: 'user', content: message }];
    const r = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514', max_tokens: 400,
      system: demoPrompt, messages,
    });
    const reply         = r.content[0]?.text || '¡Hola! ¿En qué te puedo ayudar? 😊';
    const orderDetected = detectOrder(reply);
    const { total }     = orderDetected ? extractOrder(reply) : { total: 0 };
    res.json({ reply, orderDetected, total });
  } catch (e) {
    console.error('❌ Demo error:', e.message);
    res.status(500).json({ reply: `¡Ay, un problemita técnico! 😅 Llámanos al ${CONFIG.colmadoPhone}`, orderDetected: false });
  }
});

// ─── HEALTH CHECK ─────────────────────────────────────────────
app.get('/', (req, res) => res.json({
  status: 'online',
  system: `ZemiRD — ${CONFIG.colmadoName}`,
  version: '6.0',
  plan: CONFIG.planTier,
  voice: TIER.hasVoiceIn() ? 'AssemblyAI' : 'disabled',
  open: isOpen(),
  drTime: timeStr(),
}));

// ─── ORDERS API ───────────────────────────────────────────────
app.get('/api/orders', checkAuth, async (req, res) => {
  try { const r = await db.query('SELECT * FROM orders ORDER BY created_at DESC LIMIT 200'); res.json({ orders: r.rows, count: r.rowCount }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/orders/active', checkAuth, (req, res) => {
  const active = Array.from(orderStates.entries()).map(([p, s]) => ({ phone: p, ...s, timer: undefined }));
  res.json({ orders: active, count: active.length });
});
app.get('/api/orders/pending', checkAuth, (req, res) => {
  const pending = Array.from(pendingOrders.entries()).map(([p, s]) => ({ phone: p, ...s }));
  res.json({ orders: pending, count: pending.length });
});
app.get('/api/orders/completed', checkAuth, async (req, res) => {
  try {
    const r = await db.query(`SELECT * FROM orders WHERE status='completed' AND created_at >= NOW() - INTERVAL '24 hours' ORDER BY created_at DESC`);
    res.json({ orders: r.rows, count: r.rowCount });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/orders/dispatch/:phone', checkAuth, async (req, res) => {
  const lastOrder = lastCompletedOrder.get(req.params.phone);
  if (!lastOrder) return res.status(404).json({ error: 'No recent order' });
  await sendWA(`whatsapp:+${req.params.phone}`, fmtDispatch(lastOrder));
  orderStates.delete(req.params.phone);
  broadcastSSE('order_dispatched', { orderNumber: lastOrder.orderNumber, phone: req.params.phone });
  res.json({ success: true });
});

// ─── INVENTORY API ────────────────────────────────────────────
app.get('/api/inventory', checkAuth, async (req, res) => {
  try { const r = await db.query('SELECT * FROM inventory ORDER BY category, name_es'); res.json({ products: r.rows, count: r.rowCount }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/inventory', checkAuth, async (req, res) => {
  const { name_es, name_en, price, available, category, emoji, sale_type } = req.body;
  try {
    await db.query(`INSERT INTO inventory (name_es,name_en,price,available,category,emoji,sale_type) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [name_es, name_en||name_es, price, available!==false, category||'General', emoji||'📦', sale_type||'unidad']);
    await loadInventory();
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.put('/api/inventory/:id', checkAuth, async (req, res) => {
  const { name_es, name_en, price, available, category, emoji, sale_type } = req.body;
  try {
    await db.query(`UPDATE inventory SET name_es=$1,name_en=$2,price=$3,available=$4,category=$5,emoji=$6,sale_type=$7 WHERE id=$8`,
      [name_es, name_en, price, available, category, emoji, sale_type, req.params.id]);
    await loadInventory();
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/inventory/:id', checkAuth, async (req, res) => {
  try { await db.query('DELETE FROM inventory WHERE id=$1', [req.params.id]); await loadInventory(); res.json({ success: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/inventory/toggle', checkAuth, async (req, res) => {
  try { await db.query('UPDATE inventory SET available=$1 WHERE id=$2', [req.body.available, req.body.id]); await loadInventory(); res.json({ success: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── FIAO API ─────────────────────────────────────────────────
app.get('/api/fiao', checkAuth, async (req, res) => {
  try { const r = await db.query('SELECT * FROM fiao ORDER BY balance DESC'); res.json({ accounts: r.rows, count: r.rowCount }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/fiao/update', checkAuth, async (req, res) => {
  const { name, phone, balance, payment } = req.body;
  try {
    const ex = await db.query('SELECT * FROM fiao WHERE phone=$1', [phone]);
    if (ex.rows.length > 0) {
      const newBal = payment ? Math.max(0, parseFloat(ex.rows[0].balance) - parseFloat(payment)) : parseFloat(balance) ?? ex.rows[0].balance;
      await db.query(`UPDATE fiao SET name=COALESCE($1,name),balance=$2,last_payment=CASE WHEN $3::numeric>0 THEN $3::numeric ELSE last_payment END,last_payment_at=CASE WHEN $3::numeric>0 THEN NOW() ELSE last_payment_at END WHERE phone=$4`,
        [name, newBal, payment||0, phone]);
    } else {
      await db.query(`INSERT INTO fiao (name,phone,balance,last_credit,last_credit_at) VALUES ($1,$2,$3,$3,NOW())`, [name, phone, balance||0]);
    }
    await loadFiao();
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── CLIENTS API ──────────────────────────────────────────────
app.get('/api/clients', checkAuth, async (req, res) => {
  try { const r = await db.query('SELECT * FROM clients ORDER BY created_at DESC'); res.json({ clients: r.rows, count: r.rowCount }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/clients', checkAuth, async (req, res) => {
  const { business_name, owner_name, phone, whatsapp, barrio, address, plan_tier, dashboard_password, railway_url, notes } = req.body;
  try {
    await db.query(`INSERT INTO clients (business_name,owner_name,phone,whatsapp,barrio,address,plan_tier,dashboard_password,railway_url,notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [business_name, owner_name, phone, whatsapp, barrio, address, plan_tier||'basic', dashboard_password, railway_url, notes]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.put('/api/clients/:id', checkAuth, async (req, res) => {
  const { business_name, owner_name, phone, whatsapp, barrio, address, plan_tier, status, railway_url, notes } = req.body;
  try {
    await db.query(`UPDATE clients SET business_name=$1,owner_name=$2,phone=$3,whatsapp=$4,barrio=$5,address=$6,plan_tier=$7,status=$8,railway_url=$9,notes=$10,updated_at=NOW() WHERE id=$11`,
      [business_name, owner_name, phone, whatsapp, barrio, address, plan_tier, status||'active', railway_url, notes, req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/clients/:id/upgrade', checkAuth, async (req, res) => {
  const { plan_tier } = req.body;
  if (!['basic','pro','premium'].includes(plan_tier)) return res.status(400).json({ error: 'Invalid plan' });
  try {
    await db.query(`UPDATE clients SET plan_tier=$1,updated_at=NOW() WHERE id=$2`, [plan_tier, req.params.id]);
    res.json({ success: true, plan: plan_tier, prices: CONFIG.prices[plan_tier] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/clients/:id/suspend', checkAuth, async (req, res) => {
  try { await db.query(`UPDATE clients SET status='suspended',updated_at=NOW() WHERE id=$1`, [req.params.id]); res.json({ success: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/clients/:id/activate', checkAuth, async (req, res) => {
  try { await db.query(`UPDATE clients SET status='active',updated_at=NOW() WHERE id=$1`, [req.params.id]); res.json({ success: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── STATS & CONFIG API ───────────────────────────────────────
app.get('/api/stats', checkAuth, async (req, res) => {
  try {
    const [today, total, convs] = await Promise.all([
      db.query(`SELECT COUNT(*) as cnt, COALESCE(SUM(total),0) as rev FROM orders WHERE status='completed' AND created_at >= NOW() - INTERVAL '24 hours'`),
      db.query(`SELECT COALESCE(SUM(total),0) as total FROM orders WHERE status='completed'`),
      db.query(`SELECT COUNT(DISTINCT phone) as cnt FROM conversations`),
    ]);
    res.json({
      today:         { orders: parseInt(today.rows[0].cnt), revenue: parseFloat(today.rows[0].rev) },
      allTime:       { revenue: parseFloat(total.rows[0].total) },
      customers:     parseInt(convs.rows[0].cnt),
      activeOrders:  orderStates.size,
      pendingOrders: pendingOrders.size,
      sseClients:    sseClients.size,
      plan:          CONFIG.planTier,
      orderCounter,
      drTime:        timeStr(),
      isOpen:        isOpen(),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/config', checkAuth, (req, res) => {
  const { dashboardPass, googleSheetsKey, ...safe } = CONFIG;
  res.json(safe);
});
app.post('/api/config/update', checkAuth, (req, res) => {
  ['colmadoName','colmadoBarrio','colmadoAddress','colmadoPhone','colmadoHours','deliveryTime','deliveryZone','minDelivery','promoSemana']
    .forEach(k => { if (req.body[k] !== undefined) CONFIG[k] = req.body[k]; });
  res.json({ success: true });
});
app.post('/api/promo/update', checkAuth, (req, res) => {
  CONFIG.promoSemana = req.body.promo || '';
  res.json({ success: true });
});
app.get('/api/customers', checkAuth, async (req, res) => {
  try {
    const r = await db.query('SELECT phone,customer_type,last_address,order_count,updated_at FROM conversations ORDER BY updated_at DESC');
    res.json({ customers: r.rows, count: r.rowCount });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── START ────────────────────────────────────────────────────
app.listen(CONFIG.port, async () => {
  console.log(`
╔══════════════════════════════════════════════════════╗
║   ZemiRD Automations — Zoe v6.0 — ONLINE 🤖          ║
╠══════════════════════════════════════════════════════╣
║  Colmado : ${CONFIG.colmadoName.substring(0,42).padEnd(42)}║
║  Plan    : ${CONFIG.planTier.toUpperCase().padEnd(42)}║
║  Voice   : ${(TIER.hasVoiceIn() ? '✅ AssemblyAI (Pro+)' : '❌ Text only (Basic)').padEnd(42)}║
║  DB      : ${(TIER.hasPersistentDB() ? '✅ PostgreSQL' : '⚠️  Memory only (Basic)').padEnd(42)}║
║  Sheets  : ${(TIER.hasGoogleSheets() ? '✅ Enabled' : '❌ Pro+ only').padEnd(42)}║
║  SSE     : ${'✅ /api/stream (live dashboard)'.padEnd(42)}║
║  Port    : ${String(CONFIG.port).padEnd(42)}║
║  Support : support@zemirdautomations.com             ║
╚══════════════════════════════════════════════════════╝`);

  await initDB();
  await loadInventory();
  await loadFiao();

  if (TIER.hasGoogleSheets() && CONFIG.googleSheetsId) {
    await syncGoogleSheets();
    setInterval(syncGoogleSheets, 5 * 60 * 1000);
  }
});

module.exports = app;
