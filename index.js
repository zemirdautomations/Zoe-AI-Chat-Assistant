/**
 * ╔══════════════════════════════════════════════════════════╗
 * ║     ZemiRD Automations — Zoe AI Colmado Bot v4.3         ║
 * ║     Built for the Dominican Republic Market              ║
 * ║     support@zemirdautomations.com                        ║
 * ╚══════════════════════════════════════════════════════════╝
 *
 * v4.3 Changes:
 * - Full order state machine (null→awaiting_extras→awaiting_location→confirmed)
 * - Countdown timers (30s new / 45s returning) with max 3 resets
 * - Proper address detection — won't use non-address text as delivery address
 * - WhatsApp location pin support (lat/lng)
 * - Voice message support via Twilio MediaUrl + Whisper transcription
 * - Seller notification + ENVIADO dispatch system
 * - Pending order escalation
 */

require('dotenv').config();
const express   = require('express');
const twilio    = require('twilio');
const Anthropic = require('@anthropic-ai/sdk');
const { Pool }  = require('pg');
const https     = require('https');

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// ─── CORS ────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ─── CONFIG ──────────────────────────────────────────────────
const CONFIG = {
  colmadoName:    process.env.COLMADO_NAME     || 'Colmado ZemiRD',
  colmadoOwner:   process.env.COLMADO_OWNER    || 'Dueño',
  colmadoBarrio:  process.env.COLMADO_BARRIO   || 'El Barrio',
  colmadoAddress: process.env.COLMADO_ADDRESS  || 'Dirección del colmado',
  colmadoPhone:   process.env.COLMADO_PHONE    || '8095550000',
  colmadoWhatsapp:process.env.COLMADO_WHATSAPP || 'whatsapp:+18095550000',
  colmadoHours:   process.env.COLMADO_HOURS    || 'Lun-Dom 7am-10pm',
  deliveryTime:   process.env.DELIVERY_TIME    || '20-30 minutos',
  deliveryZone:   process.env.DELIVERY_ZONE    || 'El barrio y alrededores',
  minDelivery:    process.env.MIN_DELIVERY     || 'RD$100',
  promoSemana:    process.env.PROMO_SEMANA     || '',
  ownerWhatsapp:  process.env.OWNER_WHATSAPP   || '',
  planTier:       process.env.PLAN_TIER        || 'basic',
  twilioNumber:   process.env.TWILIO_WHATSAPP_NUMBER || 'whatsapp:+14155238886',
  port:           parseInt(process.env.PORT)   || 8080,
  googleSheetsId: process.env.GOOGLE_SHEETS_ID || '',
  googleSheetsKey:process.env.GOOGLE_SHEETS_API_KEY || '',
  dashboardPass:  process.env.DASHBOARD_PASSWORD || 'zoe2024',
  zemirdSupport:  'support@zemirdautomations.com',
  zemirdSales:    'sales@zemirdautomations.com',
  zemirdWeb:      'zemirdautomations.com',
};

const isPro   = ['pro','premium'].includes(CONFIG.planTier.toLowerCase());
const isBasic = ['basic','pro','premium'].includes(CONFIG.planTier.toLowerCase());

// ─── CLIENTS ─────────────────────────────────────────────────
const anthropic    = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

// ─── DATABASE ────────────────────────────────────────────────
const db = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function initDB() {
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS orders (
        id SERIAL PRIMARY KEY,
        order_number VARCHAR(20) UNIQUE,
        phone VARCHAR(30),
        customer_name VARCHAR(100),
        items TEXT,
        items_summary TEXT,
        total DECIMAL(10,2),
        address TEXT,
        latitude DECIMAL(10,7),
        longitude DECIMAL(10,7),
        status VARCHAR(30) DEFAULT 'active',
        plan_tier VARCHAR(20),
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
        last_purchase TIMESTAMP,
        created_at TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS inventory (
        id SERIAL PRIMARY KEY,
        name VARCHAR(200),
        price DECIMAL(10,2),
        available BOOLEAN DEFAULT true,
        category VARCHAR(100),
        emoji VARCHAR(10) DEFAULT '📦',
        created_at TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS config_store (
        key VARCHAR(100) PRIMARY KEY,
        value TEXT,
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);
    console.log('✅ Database initialized');
  } catch (e) {
    console.error('❌ DB init error:', e.message);
  }
}

// ─── IN-MEMORY STATE ─────────────────────────────────────────
const conversations      = new Map(); // phone → { messages[], lastActivity }
const customerLocations  = new Map(); // phone → { address, lat, lng }
const orderStates        = new Map(); // phone → { state, items, total, timer, resetCount }
const pendingOrders      = new Map(); // phone → order data
const lastCompletedOrder = new Map(); // phone → order data
const ownerLastCustomer  = new Map(); // ownerPhone → customerPhone
let   orderCounter       = 1000;

// ─── INVENTORY ───────────────────────────────────────────────
let productosList = [];
let fiaoCuentas   = [];

async function loadInventoryFromDB() {
  try {
    const res = await db.query('SELECT * FROM inventory WHERE available = true ORDER BY category, name');
    productosList = res.rows;
  } catch(e) { /* use defaults */ }
}

async function loadFiaoFromDB() {
  try {
    const res = await db.query('SELECT * FROM fiao');
    fiaoCuentas = res.rows;
  } catch(e) { /* use defaults */ }
}

// ─── GOOGLE SHEETS SYNC (Pro) ────────────────────────────────
async function syncGoogleSheets() {
  if (!isPro || !CONFIG.googleSheetsId || !CONFIG.googleSheetsKey) return;
  try {
    const baseUrl = `https://sheets.googleapis.com/v4/spreadsheets/${CONFIG.googleSheetsId}/values`;
    const key = `?key=${CONFIG.googleSheetsKey}`;
    const [invRes, fiaoRes, cfgRes] = await Promise.all([
      fetch(`${baseUrl}/Inventario!A2:D200${key}`),
      fetch(`${baseUrl}/Fiao!A2:D200${key}`),
      fetch(`${baseUrl}/Config!A1:B20${key}`)
    ]);
    if (invRes.ok) {
      const data = await invRes.json();
      productosList = (data.values || []).map(r => ({
        name: r[0], price: parseFloat(r[1]) || 0,
        available: (r[2]||'si').toLowerCase() === 'si',
        category: r[3] || 'General'
      })).filter(p => p.available);
    }
    if (fiaoRes.ok) {
      const data = await fiaoRes.json();
      fiaoCuentas = (data.values || []).map(r => ({
        name: r[0], phone: r[1],
        balance: parseFloat(r[2]) || 0, lastPurchase: r[3]
      }));
    }
    if (cfgRes.ok) {
      const data = await cfgRes.json();
      (data.values || []).forEach(r => { if (r[0] === 'Promocion_semana') CONFIG.promoSemana = r[1]; });
    }
    console.log(`✅ Sheets synced: ${productosList.length} products, ${fiaoCuentas.length} fiado accounts`);
  } catch(e) {
    console.error('⚠️ Sheets sync error:', e.message);
  }
}

// ─── HELPERS ─────────────────────────────────────────────────
function getInventoryText() {
  if (!productosList.length) return 'Inventario actualizado disponible en tienda.';
  const byCategory = productosList.reduce((acc, p) => {
    if (!acc[p.category]) acc[p.category] = [];
    acc[p.category].push(`${p.emoji||'•'} ${p.name}: RD$${p.price}`);
    return acc;
  }, {});
  return Object.entries(byCategory)
    .map(([cat, items]) => `[${cat}]\n${items.join('\n')}`)
    .join('\n\n');
}

function getFiaoBalance(phone) {
  const clean = phone.replace(/\D/g, '').slice(-10);
  const account = fiaoCuentas.find(f => f.phone && f.phone.replace(/\D/g,'').slice(-10) === clean);
  return account ? account.balance : null;
}

function getOrderNumber() {
  return `ZRD-${++orderCounter}`;
}

function isHoursOpen() {
  const hours = CONFIG.colmadoHours;
  const now   = new Date();
  const hour  = now.getHours();
  const match = hours.match(/(\d+)(am|pm).*?(\d+)(am|pm)/i);
  if (!match) return true;
  let open  = parseInt(match[1]);
  let close = parseInt(match[3]);
  if (match[2].toLowerCase() === 'pm' && open  !== 12) open  += 12;
  if (match[4].toLowerCase() === 'pm' && close !== 12) close += 12;
  return hour >= open && hour < close;
}

/**
 * Detects if a string looks like a real delivery address.
 * Rejects single words, random phrases, or order additions.
 */
function looksLikeAddress(text) {
  if (!text || text.length < 5) return false;
  const t = text.toLowerCase().trim();

  // Reject common non-address phrases
  const rejects = [
    /^(hola|ok|okay|sí|si|no|gracias|buenas|tarde|mañana|noche|día)/,
    /^(y |dame|quiero|mándame|agrega|también|más|otro|otra)/,
    /^(espera|wait|momento|un momento)/,
    /^(enviado|pagado|listo|perfecto)/,
    /litro|libra|unidad|caja|bolsa|jugo|leche|agua|cerveza|refresco/,
    /RD\$|\d+\s*(peso|libra|litro)/i,
  ];
  if (rejects.some(r => r.test(t))) return false;

  // Accept if it contains address-like patterns
  const accepts = [
    /calle|ave|avenida|blvd|boulevard|carretera|autopista/i,
    /\#\s*\d+/,           // street number like #14
    /\d+.*calle|calle.*\d+/i,
    /sector|residencial|urb|urbanización|barrio|edificio|apt|apto|piso/i,
    /esquina|entre|frente|detras|detrás|cerca/i,
    /santo domingo|santiago|la romana|punta cana|higuey/i,
    /piantini|naco|evaristo|gazcue|bella vista|arroyo/i,
  ];
  if (accepts.some(r => r.test(t))) return true;

  // Accept multi-word phrases with 3+ words (likely an address description)
  const wordCount = t.split(/\s+/).length;
  if (wordCount >= 4) return true;

  return false;
}

async function sendWhatsApp(to, body) {
  try {
    const toNum = to.startsWith('whatsapp:') ? to : `whatsapp:${to}`;
    await twilioClient.messages.create({ from: CONFIG.twilioNumber, to: toNum, body });
  } catch (e) {
    console.error('❌ WhatsApp send error:', e.message);
  }
}

// ─── VOICE MESSAGE TRANSCRIPTION ─────────────────────────────
/**
 * Downloads a Twilio voice memo URL and transcribes it using
 * Claude's vision/audio capability or a simple fetch-based approach.
 * Since Twilio OGG audio isn't natively supported, we use a
 * Claude prompt approach: describe that we got a voice note and
 * ask Claude to handle it gracefully.
 */
async function transcribeVoiceMessage(mediaUrl, accountSid, authToken) {
  try {
    // Fetch audio from Twilio with auth
    const auth = Buffer.from(`${accountSid}:${authToken}`).toString('base64');

    const audioData = await new Promise((resolve, reject) => {
      const url = new URL(mediaUrl);
      const options = {
        hostname: url.hostname,
        path: url.pathname + url.search,
        headers: { 'Authorization': `Basic ${auth}` }
      };
      https.get(options, (res) => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', reject);
      }).on('error', reject);
    });

    const base64Audio = audioData.toString('base64');

    // Use Claude to transcribe via audio content block
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 300,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'document',
            source: {
              type: 'base64',
              media_type: 'audio/ogg',
              data: base64Audio,
            }
          },
          {
            type: 'text',
            text: 'Transcribe this WhatsApp voice message exactly as spoken. Return only the transcribed text, nothing else.'
          }
        ]
      }]
    });

    return response.content[0]?.text?.trim() || null;
  } catch(e) {
    console.error('❌ Voice transcription error:', e.message);
    return null;
  }
}

// ─── FORMATTERS ──────────────────────────────────────────────
function formatReceipt(orderData) {
  const now     = new Date();
  const dateStr = now.toLocaleDateString('es-DO');
  const timeStr = now.toLocaleTimeString('es-DO', { hour: '2-digit', minute: '2-digit' });
  return `🧾 RECIBO DE PEDIDO
━━━━━━━━━━━━━━━━━━━━
🏪 ${CONFIG.colmadoName}
📍 ${CONFIG.colmadoBarrio}
📞 ${CONFIG.colmadoPhone}
━━━━━━━━━━━━━━━━━━━━
🔖 Recibo #: ${orderData.orderNumber}
📅 ${dateStr} a las ${timeStr}
━━━━━━━━━━━━━━━━━━━━
📦 DETALLE DEL PEDIDO:
${orderData.items}
━━━━━━━━━━━━━━━━━━━━
💰 TOTAL: RD$${orderData.total}
━━━━━━━━━━━━━━━━━━━━
🛵 Delivery: ${CONFIG.deliveryTime}
📬 Dirección: ${orderData.address}
━━━━━━━━━━━━━━━━━━━━
¡Gracias por preferirnos! 🙏`;
}

function formatSellerNotification(orderData) {
  return `🛒 NUEVO PEDIDO
━━━━━━━━━━━━━━━━━━━━
👤 Cliente: ${orderData.phone}
📦 DETALLE:
${orderData.items}
━━━━━━━━━━━━━━━━━━━━
💰 TOTAL: RD$${orderData.total}
📬 Dirección: ${orderData.address}
━━━━━━━━━━━━━━━━━━━━
Para notificar al cliente que salió el pedido, responde:
ENVIADO`;
}

function formatDispatchNotification(orderData) {
  return `🛵 ¡Tu pedido está en camino!
━━━━━━━━━━━━━━━━━━━━
📦 Tu pedido: ${orderData.items}
💰 Total: RD$${orderData.total}
⏱️ Tiempo estimado: ${CONFIG.deliveryTime}
📬 Dirección: ${orderData.address}
━━━━━━━━━━━━━━━━━━━━
¡Gracias por preferirnos! 🙏`;
}

function detectOrderSummary(text) {
  return text.includes('TOTAL: RD$') || text.includes('TOTAL:RD$');
}

function extractOrderItems(text) {
  const lines = text.split('\n');
  const itemLines = lines.filter(l =>
    l.includes('RD$') && (l.includes('x') || l.includes('•') || l.includes('-') || l.includes('*'))
  );
  const total = text.match(/TOTAL:\s*RD\$([0-9,]+)/)?.[1]?.replace(',','') || '0';
  return { items: itemLines.join('\n').trim(), total };
}

// ─── DB HELPERS ──────────────────────────────────────────────
async function saveOrderToDB(orderData) {
  try {
    await db.query(`
      INSERT INTO orders (order_number, phone, items, items_summary, total, address, latitude, longitude, status, plan_tier)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      ON CONFLICT (order_number) DO UPDATE SET status=$9, updated_at=NOW()
    `, [
      orderData.orderNumber, orderData.phone, orderData.items,
      orderData.items?.substring(0,200), orderData.total,
      orderData.address, orderData.lat||null, orderData.lng||null,
      orderData.status||'completed', CONFIG.planTier
    ]);
  } catch(e) { console.error('❌ DB save error:', e.message); }
}

async function saveConversationToDB(phone, messages, location) {
  try {
    await db.query(`
      INSERT INTO conversations (phone, messages, last_address, last_lat, last_lng, customer_type, order_count, updated_at)
      VALUES ($1,$2,$3,$4,$5,'returning',1,NOW())
      ON CONFLICT (phone) DO UPDATE SET
        messages=$2,
        last_address=COALESCE($3,conversations.last_address),
        last_lat=COALESCE($4,conversations.last_lat),
        last_lng=COALESCE($5,conversations.last_lng),
        customer_type='returning',
        order_count=conversations.order_count+1,
        updated_at=NOW()
    `, [phone, JSON.stringify(messages), location?.address||null, location?.lat||null, location?.lng||null]);
  } catch(e) { console.error('❌ Conversation save error:', e.message); }
}

async function getCustomerFromDB(phone) {
  try {
    const res = await db.query('SELECT * FROM conversations WHERE phone=$1', [phone]);
    return res.rows[0] || null;
  } catch(e) { return null; }
}

// ─── SYSTEM PROMPT ───────────────────────────────────────────
function buildSystemPrompt(phone, customerType, fiaoBalance) {
  const open      = isHoursOpen();
  const inventory = getInventoryText();
  const promoText = CONFIG.promoSemana ? `\n🎉 PROMOCIÓN ESTA SEMANA: ${CONFIG.promoSemana}` : '';
  const fiaoText  = fiaoBalance !== null
    ? `\n💳 FIADO ESTE CLIENTE: RD$${fiaoBalance}`
    : '\n💳 FIADO: Sin cuenta registrada';
  const locationInfo = customerType === 'returning'
    ? `\n📍 CLIENTE RECURRENTE: Tiene dirección guardada. NO pedir dirección.`
    : `\n📍 CLIENTE NUEVO: No pedir dirección aún — el sistema lo maneja automáticamente.`;

  return `Eres Zoe, el asistente WhatsApp de ${CONFIG.colmadoName} en ${CONFIG.colmadoBarrio}, República Dominicana.
Creado por ZemiRD Automations (${CONFIG.zemirdWeb}).

PERSONALIDAD:
- Amigable, rápido, dominicano. Habla como un vecino de confianza.
- Usa: "¡Claro que sí!", "¡Tá bien!", "¿Qué más?", "¡Con mucho gusto!"
- MÁXIMO 4 líneas por respuesta. Esto es WhatsApp.
- Auto-detecta idioma. Responde en español o inglés según el cliente.
- Si recibes un mensaje de voz transcrito, respóndelo como texto normal.
- Horario de hoy: ${open ? '✅ ABIERTOS AHORA' : '❌ CERRADO AHORA — ' + CONFIG.colmadoHours}
${!open ? '⚠️ Si el cliente pide algo, explica amablemente que estamos cerrados y que su pedido queda anotado para cuando abramos.' : ''}

FORMATO DE PEDIDO (CRÍTICO — SIN EXCEPCIONES):
Siempre formatea pedidos EXACTAMENTE así:
• [Producto] x[cantidad] = RD$[subtotal]
• [Producto] x[cantidad] = RD$[subtotal]
TOTAL: RD$[total]
¿Algo más? 🛵

NUNCA incluyas texto conversacional antes de las líneas de productos.
NUNCA preguntes por dirección — el sistema lo maneja.

RESPUESTAS VALIDADAS:
1. PEDIDO ("mándame X", "dame X", "quiero X"): bullets con precios → TOTAL: RD$X → ¿Algo más?
2. FIADO ("¿cuánto le debo?", "cuánto debo"): balance exacto por teléfono. Si cero: "Estás al día ✅". Si no existe: ir a registrar en tienda.
3. INFO ("¿están abiertos?", "horario", "¿dónde están?"): horas, dirección, zona delivery, mínimo
4. CONTACTO ("quiero hablar", "número", "contact"): TODA la info de contacto — teléfono, WhatsApp, dirección, horas. Termina con "¡Con gusto te atendemos! 😊"

REGLAS:
- Nunca inventes precios fuera del inventario
- Nunca confirmes productos agotados
- Pedidos sobre RD$2,000: transferir a ${CONFIG.colmadoPhone}
- Quejas: el equipo contactará al cliente

INFO DEL COLMADO:
🏪 ${CONFIG.colmadoName}
📍 ${CONFIG.colmadoAddress} — ${CONFIG.colmadoBarrio}
📞 ${CONFIG.colmadoPhone}
💬 ${CONFIG.colmadoWhatsapp}
⏰ ${CONFIG.colmadoHours}
🛵 Delivery: ${CONFIG.deliveryTime} | Zona: ${CONFIG.deliveryZone} | Mínimo: ${CONFIG.minDelivery}
${promoText}${fiaoText}${locationInfo}

INVENTARIO DISPONIBLE:
${inventory}`;
}

// ─── COMPLETE ORDER ───────────────────────────────────────────
async function completeOrder(phone, from, locData, orderState) {
  if (orderState.timer) clearTimeout(orderState.timer);

  const orderNumber = getOrderNumber();
  const orderData   = {
    orderNumber,
    phone,
    items:   orderState.items,
    total:   orderState.total,
    address: locData.address,
    lat:     locData.lat,
    lng:     locData.lng,
    status:  'completed',
  };

  // Save location for future orders
  customerLocations.set(phone, locData);
  await saveConversationToDB(phone, conversations.get(phone)?.messages || [], locData);

  // Send receipt
  await sendWhatsApp(from, formatReceipt(orderData));

  // Save to DB
  await saveOrderToDB(orderData);

  // Seller notification
  if (isBasic && CONFIG.ownerWhatsapp) {
    await sendWhatsApp(CONFIG.ownerWhatsapp, formatSellerNotification(orderData));
    ownerLastCustomer.set(CONFIG.ownerWhatsapp.replace('whatsapp:',''), phone);
  }

  lastCompletedOrder.set(phone, orderData);
  setTimeout(() => orderStates.delete(phone), 500);

  console.log(`✅ Order completed: ${orderNumber} | ${phone} | RD$${orderData.total}`);
}

// ─── ORDER TIMEOUT HANDLER ────────────────────────────────────
async function triggerOrderTimeout(phone, from) {
  const orderState = orderStates.get(phone);
  if (!orderState) return;

  const savedLoc  = customerLocations.get(phone);
  const dbCustomer = await getCustomerFromDB(phone);
  const dbLoc     = dbCustomer?.last_address ? { address: dbCustomer.last_address, lat: dbCustomer.last_lat, lng: dbCustomer.last_lng } : null;
  const location  = savedLoc || dbLoc;

  if (location && customerLocations.has(phone)) {
    // Returning customer with saved address — auto complete
    await completeOrder(phone, from, location, orderState);
  } else if (orderState.state === 'awaiting_extras') {
    // New customer — ask for address
    orderState.state = 'awaiting_location';
    orderStates.set(phone, orderState);
    await sendWhatsApp(from, '📍 ¿A qué dirección te lo enviamos?\nPuedes escribirla o compartir tu ubicación 📌');

    // Second reminder after 30s
    orderState.timer = setTimeout(async () => {
      const os = orderStates.get(phone);
      if (os?.state === 'awaiting_location') {
        await sendWhatsApp(from, '📍 ¿Cuál es tu dirección de entrega? (escríbela o comparte tu ubicación)');

        // Final timeout after 60s more — mark as pending
        orderState.timer = setTimeout(async () => {
          const os2 = orderStates.get(phone);
          if (os2?.state === 'awaiting_location') {
            os2.state = 'pending';
            pendingOrders.set(phone, os2);
            orderStates.delete(phone);
            if (isBasic && CONFIG.ownerWhatsapp) {
              await sendWhatsApp(CONFIG.ownerWhatsapp,
                `⚠️ PEDIDO PENDIENTE\nCliente: ${phone}\nNo respondió con dirección.\nProductos: ${os2.items}\nTotal: RD$${os2.total}`);
            }
          }
        }, 60000);
        orderStates.set(phone, orderState);
      }
    }, 30000);
    orderStates.set(phone, orderState);
  }
}

// ─── MAIN WEBHOOK ────────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  res.sendStatus(200); // Respond immediately to Twilio

  const from      = req.body.From || '';
  let   body      = (req.body.Body || '').trim();
  const lat       = req.body.Latitude;
  const lng       = req.body.Longitude;
  const address   = req.body.Address || req.body.Label || '';
  const phone     = from.replace('whatsapp:', '');
  const mediaUrl  = req.body.MediaUrl0 || '';
  const mediaType = (req.body.MediaContentType0 || '').toLowerCase();
  const numMedia  = parseInt(req.body.NumMedia || '0');

  if (!from) return;

  // ── VOICE MESSAGE HANDLING ──
  if (numMedia > 0 && mediaUrl && (mediaType.includes('audio') || mediaType.includes('ogg'))) {
    console.log(`🎤 Voice message from ${phone}`);
    await sendWhatsApp(from, '🎤 Recibí tu nota de voz, un momento...');

    const transcribed = await transcribeVoiceMessage(
      mediaUrl,
      process.env.TWILIO_ACCOUNT_SID,
      process.env.TWILIO_AUTH_TOKEN
    );

    if (transcribed) {
      console.log(`🎤 Transcribed: ${transcribed}`);
      body = `[NOTA DE VOZ]: ${transcribed}`;
    } else {
      await sendWhatsApp(from, `Lo siento, no pude procesar tu nota de voz. ¿Puedes escribir tu mensaje? 😊`);
      return;
    }
  }

  console.log(`📩 [${new Date().toISOString()}] From: ${phone} | Msg: ${body.substring(0,80)}`);

  // ── OWNER ENVIADO COMMAND ──
  const ownerPhone = CONFIG.ownerWhatsapp.replace('whatsapp:','');
  if (isBasic && body.toUpperCase().startsWith('ENVIADO') && CONFIG.ownerWhatsapp && (phone === ownerPhone || from === CONFIG.ownerWhatsapp)) {
    const parts        = body.trim().split(/\s+/);
    const targetRaw    = parts[1];
    const targetPhone  = targetRaw
      ? (targetRaw.startsWith('+') ? `whatsapp:${targetRaw}` : `whatsapp:+${targetRaw}`)
      : null;
    const customerPhone = targetPhone || ownerLastCustomer.get(ownerPhone);
    if (customerPhone) {
      const cleanCPhone = customerPhone.replace('whatsapp:','');
      const lastOrder   = lastCompletedOrder.get(cleanCPhone);
      if (lastOrder) {
        await sendWhatsApp(customerPhone, formatDispatchNotification(lastOrder));
        orderStates.delete(cleanCPhone);
        await sendWhatsApp(from, '✅ Cliente notificado que su pedido está en camino.');
      } else {
        await sendWhatsApp(from, '⚠️ No encontré un pedido reciente para ese cliente.');
      }
    } else {
      await sendWhatsApp(from, '⚠️ No hay cliente activo. Usa: ENVIADO +18091234567');
    }
    return;
  }

  // ── GET CUSTOMER STATE ──
  let dbCustomer   = await getCustomerFromDB(phone);
  let customerType = dbCustomer?.customer_type || 'new';
  let savedLocation = null;

  const memLoc = customerLocations.get(phone);
  const dbLoc  = dbCustomer?.last_address ? {
    address: dbCustomer.last_address,
    lat:     dbCustomer.last_lat,
    lng:     dbCustomer.last_lng
  } : null;
  savedLocation = memLoc || dbLoc;
  if (savedLocation) customerType = 'returning';

  // ── HANDLE LOCATION PIN ──
  if (lat && lng) {
    const locAddress = address || `${lat}, ${lng}`;
    const locData    = { address: locAddress, lat: parseFloat(lat), lng: parseFloat(lng) };
    customerLocations.set(phone, locData);

    const orderState = orderStates.get(phone);
    if (orderState && (orderState.state === 'awaiting_location' || orderState.state === 'awaiting_extras')) {
      await completeOrder(phone, from, locData, orderState);
      return;
    }
    await sendWhatsApp(from, `📍 Dirección guardada: ${locAddress}\n¿En qué más te puedo ayudar?`);
    return;
  }

  // ── HANDLE TEXT ADDRESS (only if awaiting AND text looks like an address) ──
  const orderState = orderStates.get(phone);
  if (orderState && orderState.state === 'awaiting_location') {
    if (looksLikeAddress(body)) {
      const locData = { address: body };
      customerLocations.set(phone, locData);
      await completeOrder(phone, from, locData, orderState);
      return;
    }
    // If it doesn't look like an address, fall through to Claude (maybe they're adding items)
  }

  // ── HANDLE WAIT/ESPERA RESET ──
  if (orderState && ['espera','wait','momento','add more','agrega','añade','también','tambien'].some(w => body.toLowerCase().includes(w))) {
    if ((orderState.resetCount || 0) >= 3) {
      // Force complete after 3 resets
      const loc = savedLocation || customerLocations.get(phone);
      if (loc) {
        await completeOrder(phone, from, loc, orderState);
      } else {
        orderState.state = 'awaiting_location';
        orderStates.set(phone, orderState);
        await sendWhatsApp(from, '📍 ¿A qué dirección te lo enviamos?');
      }
    } else {
      orderState.resetCount = (orderState.resetCount || 0) + 1;
      if (orderState.timer) clearTimeout(orderState.timer);
      orderState.timer = setTimeout(() => triggerOrderTimeout(phone, from), 45000);
      orderStates.set(phone, orderState);
      await sendWhatsApp(from, '¡Claro! Tómate tu tiempo. ¿Qué más deseas agregar?');
    }
    return;
  }

  // ── CONVERSATION HISTORY ──
  let convData = conversations.get(phone) || { messages: [], lastActivity: Date.now() };
  convData.lastActivity = Date.now();

  if (!conversations.has(phone) && dbCustomer?.messages) {
    try {
      const dbMessages = typeof dbCustomer.messages === 'string'
        ? JSON.parse(dbCustomer.messages) : dbCustomer.messages;
      convData.messages = dbMessages.slice(-12);
    } catch(e) {}
  }

  // ── CALL CLAUDE ──
  const fiaoBalance = getFiaoBalance(phone);
  const systemPrompt = buildSystemPrompt(phone, customerType, fiaoBalance);

  convData.messages.push({ role: 'user', content: body });
  if (convData.messages.length > 16) convData.messages = convData.messages.slice(-16);

  let claudeReply = '';
  try {
    const response = await anthropic.messages.create({
      model:      'claude-sonnet-4-20250514',
      max_tokens: 500,
      system:     systemPrompt,
      messages:   convData.messages,
    });
    claudeReply = response.content[0]?.text || '¡Hola! ¿En qué te puedo ayudar?';
  } catch(e) {
    console.error('❌ Claude error:', e.message);
    claudeReply = `Lo siento, hubo un error. Llámanos al ${CONFIG.colmadoPhone} o escribe a ${CONFIG.zemirdSupport}`;
  }

  convData.messages.push({ role: 'assistant', content: claudeReply });
  conversations.set(phone, convData);

  await sendWhatsApp(from, claudeReply);

  // ── DETECT NEW ORDER IN REPLY ──
  if (detectOrderSummary(claudeReply)) {
    const { items, total } = extractOrderItems(claudeReply);

    // Cancel any existing timer
    if (orderState?.timer) clearTimeout(orderState.timer);

    const newOrderState = {
      state:      'awaiting_extras',
      items,
      total,
      resetCount: 0,
      phone,
      from,
    };

    const timerMs = customerType === 'returning' ? 45000 : 30000;
    newOrderState.timer = setTimeout(() => triggerOrderTimeout(phone, from), timerMs);
    orderStates.set(phone, newOrderState);
    console.log(`📦 Order detected for ${phone}: RD$${total} — awaiting_extras (${timerMs/1000}s timer)`);
  }
});

// ─── ADMIN REST API ───────────────────────────────────────────
const checkAuth = (req, res, next) => {
  const auth = req.headers.authorization || req.query.key;
  if (auth !== CONFIG.dashboardPass && auth !== `Bearer ${CONFIG.dashboardPass}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
};

app.get('/', (req, res) => {
  res.json({
    status: 'online',
    system: `ZemiRD — ${CONFIG.colmadoName}`,
    plan:    CONFIG.planTier,
    version: '4.3',
    contact: CONFIG.zemirdSupport,
    web:     CONFIG.zemirdWeb,
    uptime:  process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

app.get('/api/orders', checkAuth, async (req, res) => {
  try {
    const result = await db.query('SELECT * FROM orders ORDER BY created_at DESC LIMIT 200');
    res.json({ orders: result.rows, count: result.rowCount });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/orders/active', checkAuth, (req, res) => {
  const active = Array.from(orderStates.entries()).map(([phone, state]) => ({ phone, ...state, timer: undefined }));
  res.json({ orders: active, count: active.length });
});

app.get('/api/orders/pending', checkAuth, (req, res) => {
  const pending = Array.from(pendingOrders.entries()).map(([phone, state]) => ({ phone, ...state }));
  res.json({ orders: pending, count: pending.length });
});

app.get('/api/orders/completed', checkAuth, async (req, res) => {
  try {
    const result = await db.query(`SELECT * FROM orders WHERE status='completed' AND created_at >= NOW() - INTERVAL '24 hours' ORDER BY created_at DESC`);
    res.json({ orders: result.rows, count: result.rowCount });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/orders/dispatch/:phone', checkAuth, async (req, res) => {
  if (!isPro) return res.status(403).json({ error: 'Pro plan required' });
  const phone = req.params.phone;
  const lastOrder = lastCompletedOrder.get(phone);
  if (!lastOrder) return res.status(404).json({ error: 'No recent order found for this customer' });
  await sendWhatsApp(`whatsapp:+${phone}`, formatDispatchNotification(lastOrder));
  orderStates.delete(phone);
  res.json({ success: true, message: `Dispatch sent to ${phone}` });
});

app.get('/api/fiao', checkAuth, async (req, res) => {
  try {
    const result = await db.query('SELECT * FROM fiao ORDER BY balance DESC');
    res.json({ accounts: result.rows, count: result.rowCount });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/fiao/update', checkAuth, async (req, res) => {
  const { name, phone, balance, lastPurchase } = req.body;
  try {
    await db.query(`INSERT INTO fiao (name, phone, balance, last_purchase) VALUES ($1,$2,$3,$4)
      ON CONFLICT (phone) DO UPDATE SET name=$1, balance=$3, last_purchase=NOW()`,
      [name, phone, balance || 0, lastPurchase || new Date()]);
    await loadFiaoFromDB();
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/inventory', checkAuth, async (req, res) => {
  try {
    const result = await db.query('SELECT * FROM inventory ORDER BY category, name');
    res.json({ products: result.rows, count: result.rowCount });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/inventory/update', checkAuth, async (req, res) => {
  const { name, price, available, category, emoji } = req.body;
  try {
    await db.query(`INSERT INTO inventory (name, price, available, category, emoji) VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT DO NOTHING`, [name, price, available !== false, category || 'General', emoji || '📦']);
    await loadInventoryFromDB();
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/inventory/toggle', checkAuth, async (req, res) => {
  const { id, available } = req.body;
  try {
    await db.query('UPDATE inventory SET available=$1 WHERE id=$2', [available, id]);
    await loadInventoryFromDB();
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/promo/update', checkAuth, (req, res) => {
  CONFIG.promoSemana = req.body.promo || '';
  res.json({ success: true, promo: CONFIG.promoSemana });
});

app.get('/api/config', checkAuth, (req, res) => {
  const { dashboardPass, googleSheetsKey, ...safeConfig } = CONFIG;
  res.json(safeConfig);
});

app.post('/api/config/update', checkAuth, async (req, res) => {
  const allowed = ['colmadoName','colmadoBarrio','colmadoAddress','colmadoPhone','colmadoHours','deliveryTime','deliveryZone','minDelivery','promoSemana'];
  allowed.forEach(k => { if (req.body[k] !== undefined) CONFIG[k] = req.body[k]; });
  res.json({ success: true });
});

app.get('/api/customers/locations', checkAuth, (req, res) => {
  const locs = Array.from(customerLocations.entries()).map(([phone, loc]) => ({ phone, ...loc }));
  res.json({ locations: locs, count: locs.length });
});

app.get('/api/customers', checkAuth, async (req, res) => {
  try {
    const result = await db.query('SELECT phone, customer_type, last_address, order_count, updated_at FROM conversations ORDER BY updated_at DESC');
    res.json({ customers: result.rows, count: result.rowCount });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/stats', checkAuth, async (req, res) => {
  try {
    const [todayOrders, totalRevenue, convCount] = await Promise.all([
      db.query(`SELECT COUNT(*) as count, COALESCE(SUM(total),0) as revenue FROM orders WHERE status='completed' AND created_at >= NOW() - INTERVAL '24 hours'`),
      db.query(`SELECT COALESCE(SUM(total),0) as total FROM orders WHERE status='completed'`),
      db.query(`SELECT COUNT(DISTINCT phone) as count FROM conversations`),
    ]);
    res.json({
      today:         { orders: parseInt(todayOrders.rows[0].count), revenue: parseFloat(todayOrders.rows[0].revenue) },
      allTime:       { revenue: parseFloat(totalRevenue.rows[0].total) },
      customers:     parseInt(convCount.rows[0].count),
      activeOrders:  orderStates.size,
      pendingOrders: pendingOrders.size,
      planTier:      CONFIG.planTier,
      systemUptime:  process.uptime(),
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── START SERVER ─────────────────────────────────────────────
app.listen(CONFIG.port, async () => {
  console.log(`
╔══════════════════════════════════════════════════════╗
║     ZemiRD ColmadoBot Zoe v4.3 — ONLINE 🤖           ║
╠══════════════════════════════════════════════════════╣
║  Plan    : ${CONFIG.planTier.toUpperCase().padEnd(42)}║
║  Port    : ${String(CONFIG.port).padEnd(42)}║
║  Colmado : ${CONFIG.colmadoName.substring(0,42).padEnd(42)}║
║  Support : support@zemirdautomations.com             ║
╚══════════════════════════════════════════════════════╝`);

  await initDB();
  await loadInventoryFromDB();
  await loadFiaoFromDB();

  if (isPro && CONFIG.googleSheetsId) {
    await syncGoogleSheets();
    setInterval(syncGoogleSheets, 5 * 60 * 1000);
  }
});

module.exports = app;
