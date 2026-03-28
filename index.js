/**
 * ╔══════════════════════════════════════════════════════════╗
 * ║     ZemiRD Automations — Zoe AI Colmado Bot v4.6         ║
 * ║     Built for the Dominican Republic Market              ║
 * ║     support@zemirdautomations.com                        ║
 * ╚══════════════════════════════════════════════════════════╝
 *
 * v4.5 Changes:
 * - Timezone fixed to America/Santo_Domingo (UTC-4)
 * - Zoe personality: more human, funny, warm, lots of emojis
 * - Removed robotic "OK" acknowledgments
 * - Closed hours: empathetic response + next-day follow-up promise
 * - Voice: uses Twilio Speech Recognition (set webhook to /webhook?transcribe=1)
 * - Persistent order counter
 * - Seller notification guaranteed
 * - Goodbye detection closes order cleanly
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
  timezone:       'America/Santo_Domingo',
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
        quantity_on_hand INTEGER DEFAULT 0,
        image_url TEXT,
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

    // Safe column additions for upgrades
    const alterations = [
      `ALTER TABLE fiao ADD COLUMN IF NOT EXISTS last_credit DECIMAL(10,2) DEFAULT 0`,
      `ALTER TABLE fiao ADD COLUMN IF NOT EXISTS last_payment DECIMAL(10,2) DEFAULT 0`,
      `ALTER TABLE fiao ADD COLUMN IF NOT EXISTS last_credit_at TIMESTAMP`,
      `ALTER TABLE fiao ADD COLUMN IF NOT EXISTS last_payment_at TIMESTAMP`,
      `ALTER TABLE inventory ADD COLUMN IF NOT EXISTS sales_type VARCHAR(30) DEFAULT 'unit'`,
      `ALTER TABLE inventory ADD COLUMN IF NOT EXISTS quantity_on_hand INTEGER DEFAULT 0`,
      `ALTER TABLE inventory ADD COLUMN IF NOT EXISTS image_url TEXT`,
    ];
    for (const sql of alterations) {
      await db.query(sql).catch(() => {});
    }

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
      fetch(`${baseUrl}/Inventario!A2:F200${key}`),
      fetch(`${baseUrl}/Fiao!A2:D200${key}`),
      fetch(`${baseUrl}/Config!A1:B20${key}`)
    ]);
    if (invRes.ok) {
      const data = await invRes.json();
      productosList = (data.values || []).map(r => ({
        name: r[0], price: parseFloat(r[1]) || 0,
        available: (r[2]||'si').toLowerCase() === 'si',
        category: r[3] || 'General',
        sales_type: r[4] || 'unit',
        emoji: r[5] || '📦'
      })).filter(p => p.available);
    }
    if (fiaoRes.ok) {
      const data = await fiaoRes.json();
      fiaoCuentas = (data.values || []).map(r => ({
        name: r[0], phone: r[1],
        balance: parseFloat(r[2]) || 0
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

// ─── TIME HELPERS (Santo Domingo timezone) ───────────────────
function getNowInDR() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: CONFIG.timezone }));
}

function isHoursOpen() {
  const hours = CONFIG.colmadoHours;
  const now   = getNowInDR();
  const hour  = now.getHours();
  const match = hours.match(/(\d+)(am|pm).*?(\d+)(am|pm)/i);
  if (!match) return true;
  let open  = parseInt(match[1]);
  let close = parseInt(match[3]);
  if (match[2].toLowerCase() === 'pm' && open  !== 12) open  += 12;
  if (match[4].toLowerCase() === 'pm' && close !== 12) close += 12;
  return hour >= open && hour < close;
}

function getDRTimeString() {
  const now = getNowInDR();
  return now.toLocaleTimeString('es-DO', { hour: '2-digit', minute: '2-digit', hour12: true, timeZone: CONFIG.timezone });
}

function getDRDateString() {
  const now = getNowInDR();
  return now.toLocaleDateString('es-DO', { weekday: 'long', day: 'numeric', month: 'long', timeZone: CONFIG.timezone });
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

function isGoodbye(text) {
  const t = text.toLowerCase().trim();
  return [
    /^(gracias|thank|thanks|ty|thx)$/,
    /^(adiós|adios|hasta luego|bye|chao|chau|ciao)$/,
    /^(eso es todo|that'?s? all|nothing else|nada más|nada mas)$/,
    /^(ok gracias|ok thanks|listo gracias|ya gracias|perfecto gracias)$/,
  ].some(r => r.test(t));
}

function looksLikeAddress(text) {
  if (!text || text.length < 5) return false;
  const t = text.toLowerCase().trim();
  const rejects = [
    /^(hola|ok|okay|sí|si|no|gracias|buenas|tarde|mañana|noche|día|eso es todo|nada más)/,
    /^(y |dame|quiero|mándame|agrega|también|más|otro|otra)/,
    /^(espera|wait|momento)/,
    /^(enviado|pagado|listo|perfecto|excelente)/,
    /^(gracias|thank|thanks|bye|adiós|chao)/,
    /litro|libra|unidad|caja|bolsa|jugo|leche|agua|cerveza|refresco|pollo|carne|arroz|pan|huevo|guineo|platano/,
    /RD\$|\d+\s*(peso|libra|litro)/i,
  ];
  if (rejects.some(r => r.test(t))) return false;
  const accepts = [
    /calle|ave\b|avenida|blvd|boulevard|carretera|autopista/i,
    /\#\s*\d+|\d+\s*[a-z]?\s*,/,
    /sector|residencial|urb|urbanización|barrio|edificio|apt|apto|piso|torre/i,
    /esquina|entre|frente|detrás|detras|cerca|al lado/i,
    /santo domingo|santiago|la romana|punta cana|higuey|moca|barahona/i,
    /piantini|naco|evaristo|gazcue|bella vista|arroyo hondo|los prados|ensanche|dumas|ozama|miramar/i,
  ];
  if (accepts.some(r => r.test(t))) return true;
  return t.split(/\s+/).length >= 4;
}

async function sendWhatsApp(to, body) {
  try {
    const toNum = to.startsWith('whatsapp:') ? to : `whatsapp:${to}`;
    await twilioClient.messages.create({ from: CONFIG.twilioNumber, to: toNum, body });
    console.log(`📤 Sent to ${toNum.substring(0,20)}: ${body.substring(0,50)}...`);
  } catch (e) {
    console.error('❌ WhatsApp send error:', e.message);
  }
}

// ─── FORMATTERS ──────────────────────────────────────────────
function formatReceipt(orderData) {
  const now     = getNowInDR();
  const dateStr = now.toLocaleDateString('es-DO', { timeZone: CONFIG.timezone });
  const timeStr = now.toLocaleTimeString('es-DO', { hour: '2-digit', minute: '2-digit', timeZone: CONFIG.timezone });
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
  const now     = getNowInDR();
  const timeStr = now.toLocaleTimeString('es-DO', { hour: '2-digit', minute: '2-digit', timeZone: CONFIG.timezone });
  return `🛒 NUEVO PEDIDO — ${CONFIG.colmadoName}
━━━━━━━━━━━━━━━━━━━━
🔖 Pedido #: ${orderData.orderNumber}
⏰ ${timeStr}
👤 Cliente: +${orderData.phone}
━━━━━━━━━━━━━━━━━━━━
📦 DETALLE:
${orderData.items}
━━━━━━━━━━━━━━━━━━━━
💰 TOTAL: RD$${orderData.total}
📬 Dirección: ${orderData.address}
━━━━━━━━━━━━━━━━━━━━
✅ Cuando salga el pedido responde:
ENVIADO
(o: ENVIADO +1809XXXXXXX para otro cliente)`;
}

function formatDispatchNotification(orderData) {
  return `🛵 ¡Tu pedido está en camino! 🎉
━━━━━━━━━━━━━━━━━━━━
🔖 Pedido #: ${orderData.orderNumber}
📦 Lo que viene:
${orderData.items}
━━━━━━━━━━━━━━━━━━━━
💰 Total: RD$${orderData.total}
⏱️ Llega en: ${CONFIG.deliveryTime}
📬 Dirección: ${orderData.address}
━━━━━━━━━━━━━━━━━━━━
¡Gracias por preferirnos! 🙏😊`;
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
  const drTime    = getDRTimeString();
  const drDate    = getDRDateString();
  const inventory = getInventoryText();
  const promoText = CONFIG.promoSemana ? `\n🎉 PROMOCIÓN ESTA SEMANA: ${CONFIG.promoSemana}` : '';
  const fiaoText  = fiaoBalance !== null
    ? `\n💳 FIADO ESTE CLIENTE: RD$${fiaoBalance}`
    : '\n💳 FIADO: Sin cuenta registrada';
  const locationInfo = customerType === 'returning'
    ? `\n📍 CLIENTE RECURRENTE: Tiene dirección guardada. NO pedir dirección.`
    : `\n📍 CLIENTE NUEVO: NO pedir dirección — el sistema lo maneja automáticamente.`;

  const closedInstructions = !open ? `
⚠️ ESTAMOS CERRADOS AHORA (son las ${drTime}).
Cuando el cliente pida algo cerrado:
- Reconoce su pedido con entusiasmo
- Explica amablemente que están cerrados
- Promete: "Mañana cuando abramos te confirmo si aún necesitas que te enviemos eso 😊"
- NO generes TOTAL ni actives el flujo de pedido cuando estamos cerrados
- Anota el pedido en tu respuesta pero sin formato de recibo
` : '';

  return `Eres Zoe 🤖✨, la asistente virtual más chévere del ${CONFIG.colmadoName} en ${CONFIG.colmadoBarrio}, República Dominicana.
Creada con mucho amor por ZemiRD Automations (${CONFIG.zemirdWeb}).

🕐 HORA ACTUAL EN RD: ${drTime} — ${drDate}
📅 ESTADO: ${open ? '✅ ABIERTOS Y LISTOS PARA SERVIRTE' : `❌ CERRADOS (Horario: ${CONFIG.colmadoHours})`}
${closedInstructions}

🎭 PERSONALIDAD — MUY IMPORTANTE:
- Eres dominicana, cálida, graciosa y carismática. Como la vecina más cool del barrio. 🏘️
- Hablas con mucho sabor dominicano: "¡Ta' bien!", "¡Claro que sí, mi amor!", "¡Ay, qué rico!", "¡Tamo' con eso!"
- Usas emojis generosamente pero con estilo 😄🛵🎉🔥💚
- Eres rápida, eficiente y nunca dejas al cliente esperando mucho
- Tienes sentido del humor — si el cliente dice algo gracioso, ríete con él 😂
- NUNCA respondas con "OK" seco. Eso es aburrido. Siempre agrega personalidad.
- NUNCA digas "Entendido" como primera palabra. Suena robótico.
- Saluda diferente cada vez: "¡Hola!", "¡Buenas!", "¡Qué hay!", "¡Bienvenido!"
- Auto-detecta idioma: si hablan inglés, responde en inglés con el mismo sabor

🌟 EJEMPLOS DE RESPUESTAS CON PERSONALIDAD:
- En vez de "OK": "¡Tamo' con eso! 🔥"
- En vez de "Entendido": "¡Anotado! Ya lo estoy procesando 📝"
- En vez de "¿Algo más?": "¿Y qué más le pongo, que la cocina está encendida? 🔥😄"
- Cuando completan el pedido: "¡Perfecto! Tu pedido ya está volando 🛵💨"

📦 FORMATO DE PEDIDO (CRÍTICO — EXACTAMENTE ASÍ):
• [Producto] x[cantidad] = RD$[subtotal]
• [Producto] x[cantidad] = RD$[subtotal]
TOTAL: RD$[total]
¿Y qué más? 🛵

REGLAS DE PEDIDO:
- NUNCA incluyas texto conversacional ANTES de los bullets
- NUNCA preguntes por dirección — el sistema lo maneja mágicamente 🪄
- NUNCA digas "en camino" o "ya salió" — eso lo confirma el dueño
- Si ESTAMOS CERRADOS: NO generes TOTAL: RD$ — solo anota el pedido sin formato de recibo
- Máximo 5 líneas de respuesta. WhatsApp no es una novela. 📱

🛑 CUANDO EL CLIENTE SE DESPIDE ("gracias", "eso es todo", "bye"):
Despídete con cariño y humor. NO preguntes por dirección. NO hagas nada más.
Ejemplo: "¡Hasta luego! Fue un placer servirte 😊🙌 ¡Vuelve pronto!"

💳 RESPUESTAS CLAVE:
1. PEDIDO: bullets → TOTAL: RD$X → pregunta creativa tipo "¿Y qué más?"
2. FIADO: balance exacto. Si cero: "¡Estás limpio! ✅ No debes nada 🎉"
3. INFO: horas, dirección, zona, mínimo — con entusiasmo
4. CONTACTO: toda la info. Termina con "¡Con gusto te atendemos! 😊🙌"

🏪 INFO:
${CONFIG.colmadoName} | ${CONFIG.colmadoAddress}, ${CONFIG.colmadoBarrio}
📞 ${CONFIG.colmadoPhone} | ⏰ ${CONFIG.colmadoHours}
🛵 Delivery: ${CONFIG.deliveryTime} | Zona: ${CONFIG.deliveryZone} | Mínimo: ${CONFIG.minDelivery}
${promoText}${fiaoText}${locationInfo}

📋 INVENTARIO DISPONIBLE:
${inventory}`;
}

// ─── COMPLETE ORDER ───────────────────────────────────────────
async function completeOrder(phone, from, locData, orderState) {
  if (orderState.timer) clearTimeout(orderState.timer);

  const orderNumber = await getNextOrderNumber();
  const orderData   = {
    orderNumber, phone,
    items:   orderState.items,
    total:   orderState.total,
    address: locData.address,
    lat:     locData.lat,
    lng:     locData.lng,
    status:  'completed',
  };

  customerLocations.set(phone, locData);
  await saveConversationToDB(phone, conversations.get(phone)?.messages || [], locData);
  await sendWhatsApp(from, formatReceipt(orderData));
  await saveOrderToDB(orderData);

  // Seller notification — ALWAYS fires
  // Normalize OWNER_WHATSAPP to ensure whatsapp: prefix
  let ownerDest = CONFIG.ownerWhatsapp;
  if (ownerDest && !ownerDest.startsWith('whatsapp:')) {
    ownerDest = `whatsapp:${ownerDest.startsWith('+') ? ownerDest : '+' + ownerDest}`;
  }

  if (ownerDest) {
    console.log(`📱 Sending seller notification to: ${ownerDest}`);
    await sendWhatsApp(ownerDest, formatSellerNotification(orderData));
    const ownerPhone = ownerDest.replace('whatsapp:','').replace('+','');
    ownerLastCustomer.set(ownerPhone, phone);
    console.log(`✅ Seller notified | Order: ${orderNumber} | To: ${ownerDest}`);
  } else {
    console.warn('⚠️ OWNER_WHATSAPP not set — seller not notified! Set it in Railway variables.');
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
    address: dbCustomer.last_address, lat: dbCustomer.last_lat, lng: dbCustomer.last_lng
  } : null;
  const location = savedLoc || dbLoc;

  if (location) {
    await completeOrder(phone, from, location, orderState);
  } else if (orderState.state === 'awaiting_extras') {
    orderState.state = 'awaiting_location';
    orderStates.set(phone, orderState);
    await sendWhatsApp(from, '📍 ¿A qué dirección te lo enviamos?\nEscríbela o comparte tu ubicación 📌');

    orderState.timer = setTimeout(async () => {
      const os = orderStates.get(phone);
      if (os?.state === 'awaiting_location') {
        await sendWhatsApp(from, '📍 Oye, ¿cuál es tu dirección? ¡El delivery está listo para salir! 🛵');
        orderState.timer = setTimeout(async () => {
          const os2 = orderStates.get(phone);
          if (os2?.state === 'awaiting_location') {
            os2.state = 'pending';
            pendingOrders.set(phone, os2);
            orderStates.delete(phone);
            if (CONFIG.ownerWhatsapp) {
              await sendWhatsApp(CONFIG.ownerWhatsapp,
                `⚠️ PEDIDO PENDIENTE — Cliente no respondió con dirección\n👤 ${phone}\n📦 ${os2.items}\n💰 RD$${os2.total}`);
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

  // ── VOICE MESSAGE HANDLING ──
  // Twilio sends WhatsApp voice notes as audio/ogg media attachments
  if (numMedia > 0 && (mediaType.includes('audio') || mediaType.includes('ogg') || mediaType.includes('mpeg') || mediaType.includes('amr'))) {
    console.log(`🎤 Voice note from ${phone} | type: ${mediaType}`);
    await sendWhatsApp(from, `🎤 ¡Recibí tu nota de voz! Déjame escucharla... 👂`);

    try {
      const mediaUrl = req.body.MediaUrl0 || '';
      if (!mediaUrl) throw new Error('No media URL');

      // Download audio from Twilio with authentication
      const https = require('https');
      const audioBuffer = await new Promise((resolve, reject) => {
        const url = new URL(mediaUrl);
        const options = {
          hostname: url.hostname,
          path: url.pathname + url.search,
          headers: {
            'Authorization': 'Basic ' + Buffer.from(
              `${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`
            ).toString('base64')
          }
        };
        https.get(options, (res) => {
          // Follow redirects
          if (res.statusCode === 301 || res.statusCode === 302) {
            const redirectUrl = new URL(res.headers.location);
            const redirectOptions = {
              hostname: redirectUrl.hostname,
              path: redirectUrl.pathname + redirectUrl.search,
              headers: {
                'Authorization': 'Basic ' + Buffer.from(
                  `${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`
                ).toString('base64')
              }
            };
            https.get(redirectOptions, (res2) => {
              const chunks = [];
              res2.on('data', c => chunks.push(c));
              res2.on('end', () => resolve(Buffer.concat(chunks)));
              res2.on('error', reject);
            }).on('error', reject);
            return;
          }
          const chunks = [];
          res.on('data', c => chunks.push(c));
          res.on('end', () => resolve(Buffer.concat(chunks)));
          res.on('error', reject);
        }).on('error', reject);
      });

      // Use Claude to transcribe by sending as base64
      const base64Audio = audioBuffer.toString('base64');
      const transcribeResponse = await anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 300,
        messages: [{
          role: 'user',
          content: [
            {
              type: 'text',
              text: `This is a WhatsApp voice note audio file (OGG/OPUS format) from a customer of ${CONFIG.colmadoName} in the Dominican Republic. Please transcribe exactly what is said. Return ONLY the transcribed text, nothing else. If you cannot transcribe it, return the text: UNTRANSCRIBABLE`
            },
            {
              type: 'document',
              source: {
                type: 'base64',
                media_type: 'application/octet-stream',
                data: base64Audio
              }
            }
          ]
        }]
      });

      const transcribed = transcribeResponse.content[0]?.text?.trim();

      if (!transcribed || transcribed === 'UNTRANSCRIBABLE' || transcribed.length < 2) {
        throw new Error('Could not transcribe');
      }

      console.log(`🎤 Transcribed: ${transcribed}`);
      body = `[Nota de voz transcrita]: ${transcribed}`;

    } catch(e) {
      console.error('❌ Voice transcription failed:', e.message);
      // Fallback — ask user to type
      await sendWhatsApp(from, `😅 ¡Lo intenté pero no pude entender la nota!\n¿Puedes escribir tu pedido? Prometo que soy más rápida leyendo. 😄`);
      return;
    }
  }

  console.log(`📩 [${getDRTimeString()}] From: ${phone} | Msg: ${body.substring(0,80)}`);

  // ── OWNER ENVIADO COMMAND ──
  const ownerPhone = CONFIG.ownerWhatsapp.replace('whatsapp:','').replace('+','');
  if (body.toUpperCase().startsWith('ENVIADO') && CONFIG.ownerWhatsapp &&
      (phone === ownerPhone || `+${phone}` === CONFIG.ownerWhatsapp.replace('whatsapp:', ''))) {

    const parts       = body.trim().split(/\s+/);
    const targetRaw   = parts[1];
    const targetPhone = targetRaw ? targetRaw.replace('+','') : null;
    const customerPhone = targetPhone || ownerLastCustomer.get(ownerPhone);

    if (customerPhone) {
      const lastOrder = lastCompletedOrder.get(customerPhone);
      if (lastOrder) {
        const customerWA = customerPhone.startsWith('whatsapp:') ? customerPhone : `whatsapp:+${customerPhone}`;
        await sendWhatsApp(customerWA, formatDispatchNotification(lastOrder));
        orderStates.delete(customerPhone);
        await sendWhatsApp(from, `✅ Cliente notificado que su pedido #${lastOrder.orderNumber} está en camino 🛵`);
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
    address: dbCustomer.last_address, lat: dbCustomer.last_lat, lng: dbCustomer.last_lng
  } : null;
  const savedLocation = memLoc || dbLoc;
  if (savedLocation) customerType = 'returning';

  // ── LOCATION PIN ──
  if (lat && lng) {
    const locAddress = address || `${lat}, ${lng}`;
    const locData    = { address: locAddress, lat: parseFloat(lat), lng: parseFloat(lng) };
    customerLocations.set(phone, locData);
    const orderState = orderStates.get(phone);
    if (orderState && (orderState.state === 'awaiting_location' || orderState.state === 'awaiting_extras')) {
      await completeOrder(phone, from, locData, orderState);
      return;
    }
    await sendWhatsApp(from, `📍 ¡Ubicación guardada! ${locAddress} 👌\n¿En qué más te puedo ayudar?`);
    return;
  }

  const orderState = orderStates.get(phone);

  // ── GOODBYE — close order flow ──
  if (isGoodbye(body)) {
    if (orderState?.timer) clearTimeout(orderState.timer);
    if (orderState) orderStates.delete(phone);
  }

  // ── TEXT ADDRESS ──
  if (orderState && orderState.state === 'awaiting_location' && !isGoodbye(body)) {
    if (looksLikeAddress(body)) {
      const locData = { address: body };
      customerLocations.set(phone, locData);
      await completeOrder(phone, from, locData, orderState);
      return;
    }
  }

  // ── WAIT/RESET ──
  if (orderState && !isGoodbye(body) &&
      ['espera','wait','momento','add more','agrega','añade','también','tambien','y también','y tambien'].some(w => body.toLowerCase().includes(w))) {
    if ((orderState.resetCount || 0) >= 3) {
      const loc = savedLocation || customerLocations.get(phone);
      if (loc) {
        await completeOrder(phone, from, loc, orderState);
      } else {
        orderState.state = 'awaiting_location';
        orderStates.set(phone, orderState);
        await sendWhatsApp(from, '📍 ¿A qué dirección te lo enviamos? 😊');
      }
    } else {
      orderState.resetCount = (orderState.resetCount || 0) + 1;
      if (orderState.timer) clearTimeout(orderState.timer);
      orderState.timer = setTimeout(() => triggerOrderTimeout(phone, from), 45000);
      orderStates.set(phone, orderState);
      await sendWhatsApp(from, '¡Claro, tómate tu tiempo! ⏰ ¿Qué más le agregamos? 😄');
    }
    return;
  }

  // ── CONVERSATION ──
  let convData = conversations.get(phone) || { messages: [], lastActivity: Date.now() };
  convData.lastActivity = Date.now();
  if (!conversations.has(phone) && dbCustomer?.messages) {
    try {
      const dbMessages = typeof dbCustomer.messages === 'string'
        ? JSON.parse(dbCustomer.messages) : dbCustomer.messages;
      convData.messages = dbMessages.slice(-12);
    } catch(e) {}
  }

  const fiaoBalance  = getFiaoBalance(phone);
  const systemPrompt = buildSystemPrompt(phone, customerType, fiaoBalance);
  convData.messages.push({ role: 'user', content: body });
  if (convData.messages.length > 16) convData.messages = convData.messages.slice(-16);

  let claudeReply = '';
  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514', max_tokens: 500,
      system: systemPrompt, messages: convData.messages,
    });
    claudeReply = response.content[0]?.text || '¡Hola! ¿En qué te puedo ayudar? 😊';
  } catch(e) {
    console.error('❌ Claude error:', e.message);
    claudeReply = `¡Ay, se me fue la luz por un momento! 😅 Llámanos al ${CONFIG.colmadoPhone} que te atendemos ahí mismo.`;
  }

  convData.messages.push({ role: 'assistant', content: claudeReply });
  conversations.set(phone, convData);
  await sendWhatsApp(from, claudeReply);

  // ── DETECT ORDER — only when open ──
  if (detectOrderSummary(claudeReply) && !isGoodbye(body) && isHoursOpen()) {
    const { items, total } = extractOrderItems(claudeReply);
    if (orderState?.timer) clearTimeout(orderState.timer);
    const newOrderState = { state: 'awaiting_extras', items, total, resetCount: 0, phone, from };
    const timerMs = customerType === 'returning' ? 45000 : 30000;
    newOrderState.timer = setTimeout(() => triggerOrderTimeout(phone, from), timerMs);
    orderStates.set(phone, newOrderState);
    console.log(`📦 Order detected: ${phone} | RD$${total} | ${timerMs/1000}s timer`);
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

app.get('/', (req, res) => res.json({
  status: 'online', system: `ZemiRD — ${CONFIG.colmadoName}`,
  plan: CONFIG.planTier, version: '4.5',
  drTime: getDRTimeString(), isOpen: isHoursOpen(),
  contact: CONFIG.zemirdSupport, uptime: process.uptime(),
}));

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
  res.json({ success: true });
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
      const current    = existing.rows[0];
      const newBalance = payment
        ? Math.max(0, parseFloat(current.balance) - parseFloat(payment))
        : parseFloat(balance) ?? current.balance;
      await db.query(`UPDATE fiao SET
        name=COALESCE($1,name), balance=$2,
        last_payment=CASE WHEN $3::numeric > 0 THEN $3::numeric ELSE last_payment END,
        last_payment_at=CASE WHEN $3::numeric > 0 THEN NOW() ELSE last_payment_at END
        WHERE phone=$4`, [name, newBalance, payment||0, phone]);
    } else {
      await db.query(`INSERT INTO fiao (name, phone, balance, last_credit, last_credit_at) VALUES ($1,$2,$3,$3,NOW())`,
        [name, phone, balance||0]);
    }
    await loadFiaoFromDB();
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/fiao/credit', checkAuth, async (req, res) => {
  const { phone, amount } = req.body;
  try {
    await db.query(`UPDATE fiao SET balance=balance+$1, last_credit=$1, last_credit_at=NOW() WHERE phone=$2`, [amount, phone]);
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
  const { name, price, available, category, emoji, sales_type, quantity_on_hand, image_url } = req.body;
  try {
    await db.query(`INSERT INTO inventory (name, price, available, category, emoji, sales_type, quantity_on_hand, image_url)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [name, price, available !== false, category||'General', emoji||'📦', sales_type||'unit', quantity_on_hand||0, image_url||null]);
    await loadInventoryFromDB();
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/inventory/:id', checkAuth, async (req, res) => {
  const { name, price, available, category, emoji, sales_type, quantity_on_hand, image_url } = req.body;
  try {
    await db.query(`UPDATE inventory SET name=$1,price=$2,available=$3,category=$4,emoji=$5,sales_type=$6,quantity_on_hand=$7,image_url=$8 WHERE id=$9`,
      [name, price, available, category, emoji, sales_type, quantity_on_hand||0, image_url||null, req.params.id]);
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
  try {
    await db.query('UPDATE inventory SET available=$1 WHERE id=$2', [req.body.available, req.body.id]);
    await loadInventoryFromDB();
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Clients
app.get('/api/clients', checkAuth, async (req, res) => {
  try {
    const result = await db.query('SELECT * FROM clients ORDER BY created_at DESC');
    res.json({ clients: result.rows, count: result.rowCount });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/clients', checkAuth, async (req, res) => {
  const { business_name, owner_name, phone, whatsapp, email, barrio, address, plan_tier, dashboard_password, twilio_number, railway_url, notes } = req.body;
  try {
    await db.query(`INSERT INTO clients (business_name,owner_name,phone,whatsapp,email,barrio,address,plan_tier,dashboard_password,twilio_number,railway_url,notes)
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
    await db.query(`UPDATE clients SET status='suspended',updated_at=NOW() WHERE id=$1`, [req.params.id]);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/clients/:id/activate', checkAuth, async (req, res) => {
  try {
    await db.query(`UPDATE clients SET status='active',updated_at=NOW() WHERE id=$1`, [req.params.id]);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/clients/:id/upgrade', checkAuth, async (req, res) => {
  try {
    await db.query(`UPDATE clients SET plan_tier=$1,updated_at=NOW() WHERE id=$2`, [req.body.plan_tier, req.params.id]);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/promo/update', checkAuth, (req, res) => {
  CONFIG.promoSemana = req.body.promo || '';
  res.json({ success: true });
});

app.get('/api/config', checkAuth, (req, res) => {
  const { dashboardPass, googleSheetsKey, ...safeConfig } = CONFIG;
  res.json(safeConfig);
});

app.post('/api/config/update', checkAuth, (req, res) => {
  const allowed = ['colmadoName','colmadoBarrio','colmadoAddress','colmadoPhone','colmadoHours','deliveryTime','deliveryZone','minDelivery','promoSemana'];
  allowed.forEach(k => { if (req.body[k] !== undefined) CONFIG[k] = req.body[k]; });
  res.json({ success: true });
});

app.get('/api/customers', checkAuth, async (req, res) => {
  try {
    const result = await db.query('SELECT phone,customer_type,last_address,order_count,updated_at FROM conversations ORDER BY updated_at DESC');
    res.json({ customers: result.rows, count: result.rowCount });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/stats', checkAuth, async (req, res) => {
  try {
    const [today, total, convCount] = await Promise.all([
      db.query(`SELECT COUNT(*) as count, COALESCE(SUM(total),0) as revenue FROM orders WHERE status='completed' AND created_at >= NOW() - INTERVAL '24 hours'`),
      db.query(`SELECT COALESCE(SUM(total),0) as total FROM orders WHERE status='completed'`),
      db.query(`SELECT COUNT(DISTINCT phone) as count FROM conversations`),
    ]);
    res.json({
      today:         { orders: parseInt(today.rows[0].count), revenue: parseFloat(today.rows[0].revenue) },
      allTime:       { revenue: parseFloat(total.rows[0].total) },
      customers:     parseInt(convCount.rows[0].count),
      activeOrders:  orderStates.size,
      pendingOrders: pendingOrders.size,
      planTier:      CONFIG.planTier,
      systemUptime:  process.uptime(),
      orderCounter,
      drTime:        getDRTimeString(),
      isOpen:        isHoursOpen(),
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── START ────────────────────────────────────────────────────
app.listen(CONFIG.port, async () => {
  console.log(`
╔══════════════════════════════════════════════════════╗
║     ZemiRD ColmadoBot Zoe v4.6 — ONLINE 🤖           ║
╠══════════════════════════════════════════════════════╣
║  Plan    : ${CONFIG.planTier.toUpperCase().padEnd(42)}║
║  Port    : ${String(CONFIG.port).padEnd(42)}║
║  Colmado : ${CONFIG.colmadoName.substring(0,42).padEnd(42)}║
║  DR Time : ${getDRTimeString().padEnd(42)}║
║  Open    : ${String(isHoursOpen()).padEnd(42)}║
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
