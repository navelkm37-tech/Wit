const { default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const pino = require('pino');
const express = require('express');

// ══════════════════════════════════════════
// ذاكرة محلية للـ OTP
// ══════════════════════════════════════════
const memStore = new Map();

function memSet(key, value, ttlSeconds) {
    const expiry = Date.now() + ttlSeconds * 1000;
    memStore.set(key, { value, expiry });
}
function memGet(key) {
    const entry = memStore.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiry) { memStore.delete(key); return null; }
    return entry.value;
}
function memDel(key) { memStore.delete(key); }

setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of memStore.entries()) {
        if (now > entry.expiry) memStore.delete(key);
    }
}, 5 * 60 * 1000);

function generateOTP() {
    return Math.floor(100000 + Math.random() * 900000).toString();
}
async function saveOTP(phone, otp) { memSet(`otp:${phone}`, otp, 300); }
async function getOTP(phone) { return memGet(`otp:${phone}`); }
async function deleteOTP(phone) { memDel(`otp:${phone}`); }

// ══════════════════════════════════════════
// Express - يبدأ أولاً قبل أي شيء
// ══════════════════════════════════════════
const app = express();
app.use(express.json());

app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    res.header('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

const OTP_SECRET = process.env.OTP_SECRET || 'suqoor_iraq_secret_2024';

// Health check - Railway يتحقق من هذا
app.get('/', (req, res) => {
    res.json({ status: 'ok', service: '🦅 صقور العراق - OTP Service', time: new Date().toISOString() });
});
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// سيتم تعيين sock لاحقاً بعد الاتصال
let sock = null;

app.post('/send-otp', async (req, res) => {
    const { phone, secret } = req.body;
    if (secret !== OTP_SECRET) return res.status(401).json({ success: false, error: 'Unauthorized' });
    if (!phone) return res.status(400).json({ success: false, error: 'رقم الهاتف مطلوب' });
    if (!sock) return res.status(503).json({ success: false, error: 'البوت غير متصل بعد' });

    const cleanPhone = phone.replace(/[^0-9]/g, '');
    const jid = `${cleanPhone}@s.whatsapp.net`;
    const otp = generateOTP();

    try {
        await saveOTP(cleanPhone, otp);
        await sock.sendMessage(jid, {
            text: `🦅 *صقور العراق*\n\nرمز التحقق الخاص بك:\n\n*${otp}*\n\n⏱️ صالح لمدة 5 دقائق\n🔒 لا تشارك هذا الرمز مع أحد.`
        });
        console.log(`✅ OTP أُرسل إلى: ${cleanPhone}`);
        res.json({ success: true, message: 'OTP أُرسل بنجاح' });
    } catch (err) {
        console.log(`⚠️ فشل إرسال OTP إلى ${cleanPhone}: ${err.message}`);
        res.status(500).json({ success: false, error: 'فشل إرسال الرسالة' });
    }
});

app.post('/verify-otp', async (req, res) => {
    const { phone, otp, secret } = req.body;
    if (secret !== OTP_SECRET) return res.status(401).json({ success: false, error: 'Unauthorized' });
    if (!phone || !otp) return res.status(400).json({ success: false, error: 'رقم الهاتف والرمز مطلوبان' });

    const cleanPhone = phone.replace(/[^0-9]/g, '');
    const savedOTP = await getOTP(cleanPhone);

    if (!savedOTP) return res.status(400).json({ success: false, error: 'الرمز غير موجود أو انتهت صلاحيته' });
    if (savedOTP !== otp.toString()) return res.status(400).json({ success: false, error: 'الرمز غير صحيح' });

    await deleteOTP(cleanPhone);
    console.log(`✅ OTP تم التحقق: ${cleanPhone}`);
    res.json({ success: true, message: 'تم التحقق بنجاح' });
});

const PORT = process.env.PORT || 3001;
const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 OTP API يعمل على port ${PORT}`);
});
server.keepAliveTimeout = 120000;
server.headersTimeout = 120000;

// منع Railway من إيقاف العملية عند SIGTERM أثناء الربط الأول
process.on('SIGTERM', () => {
    console.log('⚠️ SIGTERM استُقبل - البوت يستمر');
});
process.on('SIGINT', () => {
    process.exit(0);
});

// ══════════════════════════════════════════
// واتساب - يبدأ بعد Express
// ══════════════════════════════════════════
async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }),
        browser: ["Ubuntu", "Chrome", "20.0.04"],
        getMessage: async () => ({ conversation: '' })
    });

    if (!sock.authState.creds.registered) {
        const phoneNumber = "9647877132433";
        setTimeout(async () => {
            try {
                let code = await sock.requestPairingCode(phoneNumber);
                console.log(`\n************************************`);
                console.log(`✅ كود الربط: ${code}`);
                console.log(`************************************\n`);
            } catch (err) { console.log("⚠️ فشل طلب الكود."); }
        }, 8000);
    }

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (up) => {
        const { connection, lastDisconnect } = up;
        if (connection === 'open') console.log('🦅 صقور العراق: البوت متصل!');
        if (connection === 'close') {
            sock = null;
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== 401;
            if (shouldReconnect) {
                console.log('🔄 إعادة الاتصال...');
                setTimeout(startBot, 3000);
            }
        }
    });
}

startBot();
