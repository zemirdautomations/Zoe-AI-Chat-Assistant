/**
 * ╔══════════════════════════════════════════════════════════╗
 * ║     ZemiRD Automations — Zoe AI Colmado Bot v4.4         ║
 * ║     Built for the Dominican Republic Market              ║
 * ║     support@zemirdautomations.com                        ║
 * ╚══════════════════════════════════════════════════════════╝
 *
 * v4.4 Fixes:
 * - Voice messages via Twilio native transcription (no OGG issues)
 * - Persistent order counter saved to DB (no more ZRD-1001 every restart)
 * - Goodbye/thanks detection closes order flow cleanly
 * - Seller notification guaranteed on every completed order
 * - ENVIADO dispatch works reliably
 * - Address detection improved further
 */

require('dotenv').config();
const express   = require('express');
const twilio    = require('twilio');
const Anthropic = require('@anthropic-ai/sdk');
const { Pool }  = require('pg');

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
        last_credit DECIMAL(10,2) DEFAULT 0,
        last_payment DECIMAL(10,2) DEFAULT 0,
        last_credit_at TIMESTAMP,
        last_payment_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS inventory (
        id SERIAL PRIMARY KEY,
        name VARCHAR(200),
        price DECIMAL(10,2),
        available BOOLEAN DEFAULT true,
        category VARCHAR(100),
        emoji VARCHAR(10) DEFAULT '📦',
        sales_type VARCHAR(30) DEFAULT 'unit',
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
        email VARCHAR(100),
        barrio VARCHAR(100),
        address TEXT,
        plan_tier VARCHAR(20) DEFAULT 'starter',
        status VARCHAR(20) DEFAULT 'active',
        dashboard_password VARCHAR(100),
        twilio_number VARCHAR(30),
        railway_url TEXT,
        notes TEXT,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);

    // Add missing columns if upgrading from older version
    await db.query(`
      ALTER TABLE fiao ADD COLUMN IF NOT EXISTS last_credit DECIMAL(10,2) DEFAULT 0;
      ALTER TABLE fiao ADD COLUMN IF NOT EXISTS last_payment DECIMAL(10,2) DEFAULT 0;
      ALTER TABLE fiao ADD COLUMN IF NOT EXISTS last_credit_at TIMESTAMP;
      ALTER TABLE fiao ADD COLUMN IF NOT EXISTS last_payment_at TIMESTAMP;
      ALTER TABLE inventory ADD COLUMN IF NOT EXISTS sales_type VARCHAR(30) DEFAULT 'unit';
    `).catch(() => {}); // ignore if already exist

    // Load persistent order counter
    const counterRes = await db.query(`SELECT value FROM config_store WHERE key='order_counter'`);
    if (counterRes.rows.length > 0) {
      orderCounter = parseInt(counterRes.rows[0].value) || 1000;
    } else {
      await db.query(`INSERT INTO config_store (key, value) VALUES ('order_counter', '1000') ON CONFLICT DO NOTHING`);
    }

    console.log('✅ Database initialized | Order counter:', orderCounter);
  } catch (e) {
    console.error('❌ DB init error:', e.message);
  }
}

// ─── IN-MEMORY STATE ─────────────────────────────────────────
const conversations      = new Map();
const customerLocations  = new Map();
const orderStates        = new Map();
const pendingOrders      = new Map();
const lastCompletedOrder = new Map();
const ownerLastCustomer  = new Map();
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
      fetch(`${baseUrl}/Inventario!A2:E200${key}`),
      fetch(`${baseUrl}/Fiao!A2:D200${key}`),
      fetch(`${baseUrl}/Config!A1:B20${key}`)
    ]);
    if (invRes.ok) {
      const data = await invRes.json();
      productosList = (data.values || []).map(r => ({
        name: r[0], price: parseFloat(r[1]) || 0,
        available: (r[2]||'si').toLowerCase() === 'si',
        category: r[3] || 'General',
        sales_type: r[4] || 'unit'
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
    const salesLabel = p.sales_type && p.sales_type !== 'unit' ? ` (por ${p.sales_type})` : '';
    acc[p.category].push(`${p.emoji||'•'} ${p.name}${salesLabel}: RD$${p.price}`);
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

async function getNextOrderNumber() {
  orderCounter++;
  try {
    await db.query(`UPDATE config_store SET value=$1, updated_at=NOW() WHERE key='order_counter'`, [String(orderCounter)]);
  } catch(e) {}
  return `ZRD-${orderCounter}`;
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
 * Detects goodbye/thank you messages that should close the order flow
 */
function isGoodbye(text) {
  const t = text.toLowerCase().trim();
  const goodbyes = [
    /^(gracias|thank|thanks|ok gracias|ok thanks|ty|thx)$/,
    /^(adiós|adios|hasta luego|bye|chao|chau|ciao)$/,
    /^(eso es todo|that'?s? all|nothing else|nada más|nada mas)$/,
    /^(perfecto gracias|ok ok|listo gracias|ya gracias)$/,
  ];
  return goodbyes.some(r => r.test(t));
}

/**
 * Detects if a string looks like a real delivery address.
 */
function looksLikeAddress(text) {
  if (!text || text.length < 5) return false;
  const t = text.toLowerCase().trim();

  const rejects = [
    /^(hola|ok|okay|sí|si|no|gracias|buenas|tarde|mañana|noche|día|eso es todo|nada más)/,
    /^(y |dame|quiero|mándame|agrega|también|más|otro|otra)/,
    /^(espera|wait|momento|un momento)/,
    /^(enviado|pagado|listo|perfecto|excelente)/,
    /^(gracias|thank|thanks|bye|adiós|chao)/,
    /litro|libra|unidad|caja|bolsa|jugo|leche|agua|cerveza|refresco|pollo|carne|arroz|pan|huevo/,
    /RD\$|\d+\s*(peso|libra|litro)/i,
  ];
  if (rejects.some(r => r.test(t))) return false;

  const accepts = [
    /calle|ave\b|avenida|blvd|boulevard|carretera|autopista/i,
    /\#\s*\d+|\d+\s*[a-z]?\s*,/,
    /sector|residencial|urb|urbanización|barrio|edificio|apt|apto|piso|torre/i,
    /esquina|entre|frente|detrás|detras|cerca|al lado/i,
    /santo domingo|santiago|la romana|punta cana|higuey|moca|barahona/i,
    /piantini|naco|evaristo|gazcue|bella vista|arroyo hondo|los prados|ensanche/i,
    /dumas|tropical|ozama|miramar|fernández|fernandez/i,
  ];
  if (accepts.some(r => r.test(t))) return true;

  const wordCount = t.split(/\s+/).length;
  if (wordCount >= 4) return true;

  return false;
}

async function sendWhatsApp(to, body) {
  try {
    const toNum = to.startsWith('whatsapp:') ? to : `whatsapp:${to}`;
    await twilioClient.messages.create({ from: CONFIG.twilioNumber, to: toNum, body });
    console.log(`📤 Sent to ${toNum}: ${body.substring(0,60)}...`);
  } catch (e) {
    console.error('❌ WhatsApp send error:', e.message);
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
  return `🛒 NUEVO PEDIDO — ${CONFIG.colmadoName}
━━━━━━━━━━━━━━━━━━━━
🔖 Pedido #: ${orderData.orderNumber}
👤 Cliente: ${orderData.phone}
━━━━━━━━━━━━━━━━━━━━
📦 DETALLE:
${orderData.items}
━━━━━━━━━━━━━━━━━━━━
💰 TOTAL: RD$${orderData.total}
📬 Dirección: ${orderData.address}
━━━━━━━━━━━━━━━━━━━━
✅ Para confirmar envío responde:
ENVIADO
(o: ENVIADO +1809XXXXXXX para otro cliente)`;
}

function formatDispatchNotification(orderData) {
  return `🛵 ¡Tu pedido está en camino!
━━━━━━━━━━━━━━━━━━━━
🔖 Pedido #: ${orderData.orderNumber}
📦 Tu pedido:
${orderData.items}
━━━━━━━━━━━━━━━━━━━━
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
  const total = text.match(/TOTAL[^:]*:\s*RD\$([0-9,]+)/)?.[1]?.replace(',','') || '0';
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
    : `\n📍 CLIENTE NUEVO: No pedir dirección — el sistema lo maneja.`;

  return `Eres Zoe, el asistente WhatsApp de ${CONFIG.colmadoName} en ${CONFIG.colmadoBarrio}, República Dominicana.
Creado por ZemiRD Automations (${CONFIG.zemirdWeb}).

PERSONALIDAD:
- Amigable, rápido, dominicano. Habla como un vecino de confianza.
- Usa: "¡Claro que sí!", "¡Tá bien!", "¿Qué más?", "¡Con mucho gusto!"
- MÁXIMO 4 líneas por respuesta. Esto es WhatsApp.
- Auto-detecta idioma. Responde en español o inglés según el cliente.
- Si recibes un mensaje de voz transcrito, respóndelo normalmente.
- Horario: ${open ? '✅ ABIERTOS AHORA' : '❌ CERRADO — ' + CONFIG.colmadoHours}
${!open ? '⚠️ Explica amablemente que están cerrados pero anota el pedido para cuando abran.' : ''}

FORMATO DE PEDIDO (CRÍTICO):
• [Producto] x[cantidad] = RD$[subtotal]
• [Producto] x[cantidad] = RD$[subtotal]
TOTAL: RD$[total]
¿Algo más? 🛵

NUNCA incluyas texto antes de los bullets en un pedido.
NUNCA preguntes por dirección — el sistema lo maneja.
NUNCA digas "en camino" o "ya va saliendo" — eso lo confirma el dueño.

CUANDO EL CLIENTE DICE "gracias", "eso es todo", "nada más", "bye":
Responde con despedida amistosa. NO hagas nada más.

RESPUESTAS VALIDADAS:
1. PEDIDO: bullets → TOTAL: RD$X → ¿Algo más?
2. FIADO ("¿cuánto le debo?"): balance exacto. Si cero: "Estás al día ✅"
3. INFO: horas, dirección, zona, mínimo
4. CONTACTO: toda la info. Termina con "¡Con gusto te atendemos! 😊"

INFO:
🏪 ${CONFIG.colmadoName} | 📍 ${CONFIG.colmadoAddress}, ${CONFIG.colmadoBarrio}
📞 ${CONFIG.colmadoPhone} | ⏰ ${CONFIG.colmadoHours}
🛵 Delivery: ${CONFIG.deliveryTime} | Zona: ${CONFIG.deliveryZone} | Mínimo: ${CONFIG.minDelivery}
${promoText}${fiaoText}${locationInfo}

INVENTARIO:
${inventory}`;
}

// ─── COMPLETE ORDER ───────────────────────────────────────────
async function completeOrder(phone, from, locData, orderState) {
  if (orderState.timer) clearTimeout(orderState.timer);

  const orderNumber = await getNextOrderNumber();
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

  // Save location
  customerLocations.set(phone, locData);
  await saveConversationToDB(phone, conversations.get(phone)?.messages || [], locData);

  // Send receipt to customer
  await sendWhatsApp(from, formatReceipt(orderData));

  // Save to DB
  await saveOrderToDB(orderData);

  // Seller notification — always fires
  if (CONFIG.ownerWhatsapp) {
    await sendWhatsApp(CONFIG.ownerWhatsapp, formatSellerNotification(orderData));
    const ownerPhone = CONFIG.ownerWhatsapp.replace('whatsapp:','').replace('+','');
    ownerLastCustomer.set(ownerPhone, phone);
    console.log(`📱 Seller notified: ${CONFIG.ownerWhatsapp} | Order: ${orderNumber}`);
  } else {
    console.warn('⚠️ OWNER_WHATSAPP not set — seller not notified');
  }

  lastCompletedOrder.set(phone, orderData);
  setTimeout(() => orderStates.delete(phone), 500);

  console.log(`✅ Order completed: ${orderNumber} | ${phone} | RD$${orderData.total}`);
}

// ─── ORDER TIMEOUT ────────────────────────────────────────────
async function triggerOrderTimeout(phone, from) {
  const orderState = orderStates.get(phone);
  if (!orderState) return;

  const savedLoc   = customerLocations.get(phone);
  const dbCustomer = await getCustomerFromDB(phone);
  const dbLoc      = dbCustomer?.last_address ? {
    address: dbCustomer.last_address,
    lat:     dbCustomer.last_lat,
    lng:     dbCustomer.last_lng
  } : null;
  const location = savedLoc || dbLoc;

  if (location) {
    // Has saved address — auto complete
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

        // Final — mark pending after 60s more
        orderState.timer = setTimeout(async () => {
          const os2 = orderStates.get(phone);
          if (os2?.state === 'awaiting_location') {
            os2.state = 'pending';
            pendingOrders.set(phone, os2);
            orderStates.delete(phone);
            if (CONFIG.ownerWhatsapp) {
              await sendWhatsApp(CONFIG.ownerWhatsapp,
                `⚠️ PEDIDO PENDIENTE\nCliente: ${phone}\nNo dio dirección.\nProductos: ${os2.items}\nTotal: RD$${os2.total}`);
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
  res.sendStatus(200);

  const from      = req.body.From || '';
  let   body      = (req.body.Body || '').trim();
  const lat       = req.body.Latitude;
  const lng       = req.body.Longitude;
  const address   = req.body.Address || req.body.Label || '';
  const phone     = from.replace('whatsapp:', '').replace('+', '');
  const numMedia  = parseInt(req.body.NumMedia || '0');
  const mediaType = (req.body.MediaContentType0 || '').toLowerCase();

  if (!from) return;

  // ── VOICE MESSAGE — use Twilio transcription ──
  // Twilio can auto-transcribe voice notes when configured.
  // If body contains transcription text from Twilio, use it directly.
  // If it's a media message with no body, prompt user to type.
  if (numMedia > 0 && (mediaType.includes('audio') || mediaType.includes('ogg') || mediaType.includes('mpeg'))) {
    if (body && body.length > 3) {
      // Twilio provided a transcription in the Body field
      console.log(`🎤 Voice transcription: ${body}`);
      body = `[Nota de voz]: ${body}`;
    } else {
      // No transcription available — ask to type
      await sendWhatsApp(from, `🎤 Recibí tu nota de voz pero no pude transcribirla.\n¿Puedes escribir tu pedido? 😊`);
      return;
    }
  }

  console.log(`📩 [${new Date().toISOString()}] From: ${phone} | Msg: ${body.substring(0,80)}`);

  // ── OWNER ENVIADO COMMAND ──
  const ownerPhone = CONFIG.ownerWhatsapp.replace('whatsapp:','').replace('+','');
  if (body.toUpperCase().startsWith('ENVIADO') && CONFIG.ownerWhatsapp &&
      (phone === ownerPhone || from === CONFIG.ownerWhatsapp || `+${phone}` === CONFIG.ownerWhatsapp.replace('whatsapp:',''))) {

    const parts       = body.trim().split(/\s+/);
    const targetRaw   = parts[1];
    const targetPhone = targetRaw
      ? (targetRaw.startsWith('+') ? targetRaw.replace('+','') : targetRaw)
      : null;

    const customerPhone = targetPhone || ownerLastCustomer.get(ownerPhone);

    if (customerPhone) {
      const lastOrder = lastCompletedOrder.get(customerPhone);
      if (lastOrder) {
        const customerWA = `whatsapp:+${customerPhone.replace('+','')}`;
        await sendWhatsApp(customerWA, formatDispatchNotification(lastOrder));
        orderStates.delete(customerPhone);
        await sendWhatsApp(from, `✅ Cliente +${customerPhone} notificado que su pedido #${lastOrder.orderNumber} está en camino.`);
        console.log(`🛵 Dispatch sent to ${customerPhone}`);
      } else {
        await sendWhatsApp(from, '⚠️ No encontré pedido reciente para ese cliente.');
      }
    } else {
      await sendWhatsApp(from, '⚠️ No hay cliente activo. Usa: ENVIADO +18091234567');
    }
    return;
  }

  // ── GET CUSTOMER STATE ──
  let dbCustomer   = await getCustomerFromDB(phone);
  let customerType = dbCustomer?.customer_type || 'new';

  const memLoc = customerLocations.get(phone);
  const dbLoc  = dbCustomer?.last_address ? {
    address: dbCustomer.last_address,
    lat:     dbCustomer.last_lat,
    lng:     dbCustomer.last_lng
  } : null;
  const savedLocation = memLoc || dbLoc;
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

  const orderState = orderStates.get(phone);

  // ── GOODBYE DETECTION — close order flow cleanly ──
  if (isGoodbye(body)) {
    if (orderState?.timer) clearTimeout(orderState.timer);
    if (orderState) orderStates.delete(phone);
    // Let Claude give a friendly goodbye — don't trigger order flow
  }

  // ── TEXT ADDRESS (only if awaiting AND looks like address) ──
  if (orderState && orderState.state === 'awaiting_location' && !isGoodbye(body)) {
    if (looksLikeAddress(body)) {
      const locData = { address: body };
      customerLocations.set(phone, locData);
      await completeOrder(phone, from, locData, orderState);
      return;
    }
    // Doesn't look like address — fall through to Claude
  }

  // ── WAIT/RESET HANDLING ──
  if (orderState && !isGoodbye(body) &&
      ['espera','wait','momento','add more','agrega','añade','también','tambien','y también','y tambien'].some(w => body.toLowerCase().includes(w))) {
    if ((orderState.resetCount || 0) >= 3) {
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
  const fiaoBalance  = getFiaoBalance(phone);
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
    claudeReply = `Lo siento, hubo un error. Llámanos al ${CONFIG.colmadoPhone}`;
  }

  convData.messages.push({ role: 'assistant', content: claudeReply });
  conversations.set(phone, convData);

  await sendWhatsApp(from, claudeReply);

  // ── DETECT NEW ORDER ──
  if (detectOrderSummary(claudeReply) && !isGoodbye(body)) {
    const { items, total } = extractOrderItems(claudeReply);

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
    console.log(`📦 Order detected: ${phone} | RD$${total} | Timer: ${timerMs/1000}s`);
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
    status: 'online', system: `ZemiRD — ${CONFIG.colmadoName}`,
    plan: CONFIG.planTier, version: '4.4',
    contact: CONFIG.zemirdSupport, web: CONFIG.zemirdWeb,
    uptime: process.uptime(), timestamp: new Date().toISOString(),
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
  const phone     = req.params.phone;
  const lastOrder = lastCompletedOrder.get(phone);
  if (!lastOrder) return res.status(404).json({ error: 'No recent order for this customer' });
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
  const { name, phone, balance, payment } = req.body;
  try {
    const existing = await db.query('SELECT * FROM fiao WHERE phone=$1', [phone]);
    if (existing.rows.length > 0) {
      const current = existing.rows[0];
      const newBalance = payment
        ? Math.max(0, parseFloat(current.balance) - parseFloat(payment))
        : parseFloat(balance) || current.balance;
      await db.query(`UPDATE fiao SET
        name=COALESCE($1,name),
        balance=$2,
        last_payment=CASE WHEN $3::numeric > 0 THEN $3::numeric ELSE last_payment END,
        last_payment_at=CASE WHEN $3::numeric > 0 THEN NOW() ELSE last_payment_at END
        WHERE phone=$4`,
        [name, newBalance, payment || 0, phone]);
    } else {
      await db.query(`INSERT INTO fiao (name, phone, balance, last_credit, last_credit_at) VALUES ($1,$2,$3,$3,NOW())`,
        [name, phone, balance || 0]);
    }
    await loadFiaoFromDB();
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/fiao/credit', checkAuth, async (req, res) => {
  const { phone, amount } = req.body;
  try {
    await db.query(`UPDATE fiao SET
      balance=balance+$1,
      last_credit=$1,
      last_credit_at=NOW()
      WHERE phone=$2`, [amount, phone]);
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
  const { name, price, available, category, emoji, sales_type } = req.body;
  try {
    await db.query(`INSERT INTO inventory (name, price, available, category, emoji, sales_type) VALUES ($1,$2,$3,$4,$5,$6)
      ON CONFLICT DO NOTHING`, [name, price, available !== false, category || 'General', emoji || '📦', sales_type || 'unit']);
    await loadInventoryFromDB();
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/inventory/:id', checkAuth, async (req, res) => {
  const { name, price, available, category, emoji, sales_type } = req.body;
  try {
    await db.query(`UPDATE inventory SET name=$1,price=$2,available=$3,category=$4,emoji=$5,sales_type=$6 WHERE id=$7`,
      [name, price, available, category, emoji, sales_type, req.params.id]);
    await loadInventoryFromDB();
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/inventory/:id', checkAuth, async (req, res) => {
  try {
    await db.query('DELETE FROM inventory WHERE id=$1', [req.params.id]);
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

// Clients (Master Panel)
app.get('/api/clients', checkAuth, async (req, res) => {
  try {
    const result = await db.query('SELECT * FROM clients ORDER BY created_at DESC');
    res.json({ clients: result.rows, count: result.rowCount });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/clients', checkAuth, async (req, res) => {
  const { business_name, owner_name, phone, whatsapp, email, barrio, address, plan_tier, dashboard_password, twilio_number, railway_url, notes } = req.body;
  try {
    await db.query(`INSERT INTO clients (business_name, owner_name, phone, whatsapp, email, barrio, address, plan_tier, dashboard_password, twilio_number, railway_url, notes)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [business_name, owner_name, phone, whatsapp, email, barrio, address, plan_tier||'starter', dashboard_password, twilio_number, railway_url, notes]);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/clients/:id', checkAuth, async (req, res) => {
  const { business_name, owner_name, phone, whatsapp, email, barrio, address, plan_tier, status, dashboard_password, twilio_number, railway_url, notes } = req.body;
  try {
    await db.query(`UPDATE clients SET business_name=$1,owner_name=$2,phone=$3,whatsapp=$4,email=$5,barrio=$6,address=$7,plan_tier=$8,status=$9,dashboard_password=$10,twilio_number=$11,railway_url=$12,notes=$13,updated_at=NOW() WHERE id=$14`,
      [business_name, owner_name, phone, whatsapp, email, barrio, address, plan_tier, status||'active', dashboard_password, twilio_number, railway_url, notes, req.params.id]);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/clients/:id/suspend', checkAuth, async (req, res) => {
  try {
    await db.query(`UPDATE clients SET status='suspended', updated_at=NOW() WHERE id=$1`, [req.params.id]);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/clients/:id/activate', checkAuth, async (req, res) => {
  try {
    await db.query(`UPDATE clients SET status='active', updated_at=NOW() WHERE id=$1`, [req.params.id]);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/clients/:id/upgrade', checkAuth, async (req, res) => {
  const { plan_tier } = req.body;
  try {
    await db.query(`UPDATE clients SET plan_tier=$1, updated_at=NOW() WHERE id=$2`, [plan_tier, req.params.id]);
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

app.get('/api/customers', checkAuth, async (req, res) => {
  try {
    const result = await db.query('SELECT phone, customer_type, last_address, order_count, updated_at FROM conversations ORDER BY updated_at DESC');
    res.json({ customers: result.rows, count: result.rowCount });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/customers/locations', checkAuth, (req, res) => {
  const locs = Array.from(customerLocations.entries()).map(([phone, loc]) => ({ phone, ...loc }));
  res.json({ locations: locs, count: locs.length });
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
      orderCounter,
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── START SERVER ─────────────────────────────────────────────
app.listen(CONFIG.port, async () => {
  console.log(`
╔══════════════════════════════════════════════════════╗
║     ZemiRD ColmadoBot Zoe v4.4 — ONLINE 🤖           ║
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
