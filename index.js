const { default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
const { createClient } = require('redis');
const express = require('express');

ffmpeg.setFfmpegPath(ffmpegPath);

// ══════════════════════════════════════════
// تحميل yt-dlp تلقائياً إذا لم يكن مثبتاً
// ══════════════════════════════════════════
const https = require('https');
const YT_DLP_LOCAL = path.join(__dirname, 'yt-dlp');
let YT_DLP_BIN = 'yt-dlp'; // يستخدم PATH أولاً

async function downloadBinary(url, dest) {
    return new Promise((resolve, reject) => {
        const file = fs.createWriteStream(dest);
        const request = (reqUrl) => {
            https.get(reqUrl, (res) => {
                if (res.statusCode === 301 || res.statusCode === 302) {
                    return request(res.headers.location);
                }
                if (res.statusCode !== 200) {
                    return reject(new Error(`HTTP ${res.statusCode}`));
                }
                res.pipe(file);
                file.on('finish', () => file.close(resolve));
            }).on('error', reject);
        };
        request(url);
    });
}

async function ensureYtDlp() {
    // تحقق من وجود yt-dlp في PATH
    try {
        await new Promise((resolve, reject) => {
            execFile('yt-dlp', ['--version'], { timeout: 8000 }, (err) => err ? reject(err) : resolve());
        });
        console.log('✅ yt-dlp موجود في PATH');
        YT_DLP_BIN = 'yt-dlp';
        return;
    } catch (_) {}

    // تحقق من الملف المحلي
    if (fs.existsSync(YT_DLP_LOCAL)) {
        try {
            await new Promise((resolve, reject) => {
                execFile(YT_DLP_LOCAL, ['--version'], { timeout: 8000 }, (err) => err ? reject(err) : resolve());
            });
            console.log('✅ yt-dlp موجود محلياً');
            YT_DLP_BIN = YT_DLP_LOCAL;
            return;
        } catch (_) {
            fs.unlinkSync(YT_DLP_LOCAL);
        }
    }

    // تحميل yt-dlp من GitHub (النسخة المستقلة - لا تحتاج Python)
    console.log('⬇️ yt-dlp غير موجود، جاري التحميل من GitHub...');
    const dlUrl = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux';
    try {
        await downloadBinary(dlUrl, YT_DLP_LOCAL);
        fs.chmodSync(YT_DLP_LOCAL, '755');
        YT_DLP_BIN = YT_DLP_LOCAL;
        console.log('✅ تم تحميل yt-dlp بنجاح!');
    } catch (err) {
        console.log(`⚠️ فشل تحميل yt-dlp: ${err.message}`);
    }
}

// ══════════════════════════════════════════
// اتصال Redis
// ══════════════════════════════════════════
const redis = createClient({ url: process.env.REDIS_URL });
redis.on('error', (err) => console.log('⚠️ Redis Error:', err));

async function isWarned(sender) {
    try {
        const result = await redis.get(`warned:${sender}`);
        return result !== null;
    } catch (e) { return false; }
}

async function addWarned(sender) {
    try {
        await redis.set(`warned:${sender}`, '1', { EX: 604800 });
    } catch (e) { console.log('⚠️ فشل الحفظ في Redis'); }
}

// ══════════════════════════════════════════
// تتبع الرسائل المعالجة في Redis لمنع التكرار
// ══════════════════════════════════════════
async function isProcessed(msgId) {
    try {
        const result = await redis.get(`processed:${msgId}`);
        return result !== null;
    } catch (e) { return false; }
}
async function markProcessed(msgId) {
    try {
        // تُحفظ لمدة 10 دقائق فقط
        await redis.set(`processed:${msgId}`, '1', { EX: 600 });
    } catch (e) { console.log('⚠️ فشل تسجيل الرسالة في Redis'); }
}

// ══════════════════════════════════════════
// OTP - تخزين في Redis
// ══════════════════════════════════════════
function generateOTP() {
    return Math.floor(100000 + Math.random() * 900000).toString();
}
async function saveOTP(phone, otp) {
    await redis.set(`otp:${phone}`, otp, { EX: 300 });
}
async function getOTP(phone) {
    return await redis.get(`otp:${phone}`);
}
async function deleteOTP(phone) {
    await redis.del(`otp:${phone}`);
}

// ══════════════════════════════════════════
// عد الكلمات
// ══════════════════════════════════════════
function countWords(text) {
    if (!text || text.trim().length === 0) return 0;
    return text.trim().split(/\s+/).length;
}

// ══════════════════════════════════════════
// تحويل MP3 إلى OGG
// ══════════════════════════════════════════
function convertToOgg(inputPath) {
    const outputPath = inputPath.replace('.mp3', '_converted.ogg');
    return new Promise((resolve, reject) => {
        if (fs.existsSync(outputPath)) return resolve(outputPath);
        ffmpeg(inputPath)
            .audioCodec('libopus')
            .audioBitrate('128k')
            .format('ogg')
            .on('end', () => { console.log('✅ تم تحويل الصوت.'); resolve(outputPath); })
            .on('error', (err) => { console.log('⚠️ فشل التحويل:', err.message); reject(err); })
            .save(outputPath);
    });
}

// ══════════════════════════════════════════
// فك تغليف الرسائل المتداخلة في Baileys
// ══════════════════════════════════════════
function unwrapMessage(msg) {
    let m = msg.message;
    if (!m) return null;
    const wrappers = [
        'ephemeralMessage',
        'viewOnceMessage',
        'viewOnceMessageV2',
        'viewOnceMessageV2Extension',
        'documentWithCaptionMessage',
        'editedMessage',
    ];
    for (const wrapper of wrappers) {
        if (m[wrapper]?.message) {
            m = m[wrapper].message;
        }
    }
    return m;
}

// ══════════════════════════════════════════
// استخراج الرابط مباشرة من كائن الرسالة
// (يعمل حتى مع معاينات الروابط)
// ══════════════════════════════════════════
function extractDirectUrl(msg) {
    const m = unwrapMessage(msg);
    if (!m) return null;

    // الأولوية: matchedText و canonicalUrl من رسائل الروابط
    if (m.extendedTextMessage?.matchedText) return m.extendedTextMessage.matchedText;
    if (m.extendedTextMessage?.canonicalUrl) return m.extendedTextMessage.canonicalUrl;

    return null;
}

// ══════════════════════════════════════════
// استخراج النص من أي نوع رسالة
// ══════════════════════════════════════════
function extractText(msg) {
    const m = unwrapMessage(msg);
    if (!m) return '';

    return (
        m.conversation ||
        m.extendedTextMessage?.text ||
        m.imageMessage?.caption ||
        m.videoMessage?.caption ||
        m.documentMessage?.caption ||
        m.documentWithCaptionMessage?.message?.documentMessage?.caption ||
        m.buttonsResponseMessage?.selectedDisplayText ||
        m.listResponseMessage?.singleSelectReply?.selectedRowId ||
        m.templateButtonReplyMessage?.selectedDisplayText ||
        ''
    );
}

// ══════════════════════════════════════════
// كشف أي رابط في النص
// ══════════════════════════════════════════
function detectVideoUrl(text) {
    if (!text) return null;

    const knownPatterns = [
        /https?:\/\/(?:www\.)?(?:facebook\.com|fb\.watch|fb\.com)\/\S+/i,
        /https?:\/\/(?:www\.)?(?:tiktok\.com|vm\.tiktok\.com)\/@?\S+/i,
        /https?:\/\/(?:www\.)?(?:instagram\.com|instagr\.am)\/(?:p|reel|tv|stories)\/\S+/i,
        /https?:\/\/(?:www\.)?youtube\.com\/\S+/i,
        /https?:\/\/youtu\.be\/\S+/i,
        /https?:\/\/(?:www\.)?twitter\.com\/\S+\/status\/\S+/i,
        /https?:\/\/(?:www\.)?x\.com\/\S+\/status\/\S+/i,
        /https?:\/\/(?:www\.)?vimeo\.com\/\S+/i,
        /https?:\/\/(?:www\.)?dailymotion\.com\/\S+/i,
        /https?:\/\/(?:www\.)?twitch\.tv\/\S+/i,
        /https?:\/\/(?:www\.)?snapchat\.com\/\S+/i,
    ];

    for (const pattern of knownPatterns) {
        const match = text.match(pattern);
        if (match) return match[0].replace(/[)>\]"',]+$/, '');
    }

    const generalMatch = text.match(/https?:\/\/[^\s]+/i);
    if (generalMatch) return generalMatch[0].replace(/[)>\]"',]+$/, '');

    return null;
}

// ══════════════════════════════════════════
// دالة موحدة: استخراج الرابط من الرسالة
// تجمع بين الطريقتين المباشرة والنصية
// ══════════════════════════════════════════
function getUrlFromMessage(msg) {
    // أولاً: محاولة استخراج مباشر من كائن الرسالة (matchedText / canonicalUrl)
    const directUrl = extractDirectUrl(msg);
    if (directUrl) return directUrl;

    // ثانياً: استخراج من النص
    const text = extractText(msg);
    if (text) return detectVideoUrl(text);

    return null;
}

// ══════════════════════════════════════════
// تحميل الفيديو باستخدام yt-dlp
// ══════════════════════════════════════════
function downloadVideo(url) {
    return new Promise((resolve, reject) => {
        if (!fs.existsSync('./downloads')) {
            fs.mkdirSync('./downloads', { recursive: true });
        }

        const timestamp = Date.now();
        const outputTemplate = path.join('./downloads', `video_${timestamp}.%(ext)s`);

        const args = [
            '-f', 'bestvideo[ext=mp4][height<=720]+bestaudio[ext=m4a]/best[ext=mp4][height<=720]/best[height<=720]/best',
            '--merge-output-format', 'mp4',
            '--no-playlist',
            '--no-warnings',
            '--socket-timeout', '30',
            '--retries', '3',
            '-o', outputTemplate,
            url
        ];

        console.log(`🔄 [yt-dlp] بدء التحميل (${YT_DLP_BIN}): ${url}`);

        execFile(YT_DLP_BIN, args, { timeout: 180000 }, (error, stdout, stderr) => {
            if (error) {
                console.log(`⚠️ [yt-dlp] خطأ: ${error.message}`);
                if (stderr) console.log(`⚠️ [yt-dlp] stderr: ${stderr}`);
                return reject(new Error(`فشل yt-dlp: ${error.message}`));
            }

            const downloadsDir = './downloads';
            try {
                const files = fs.readdirSync(downloadsDir)
                    .filter(f => f.endsWith('.mp4') || f.endsWith('.mkv') || f.endsWith('.webm'))
                    .map(f => ({
                        name: f,
                        time: fs.statSync(path.join(downloadsDir, f)).mtime.getTime()
                    }))
                    .sort((a, b) => b.time - a.time);

                if (files.length > 0) {
                    const latestFile = path.join(downloadsDir, files[0].name);
                    console.log(`✅ [yt-dlp] ملف الفيديو: ${latestFile}`);
                    resolve(latestFile);
                } else {
                    reject(new Error('الملف لم يُنشأ بعد التحميل'));
                }
            } catch (fsErr) {
                reject(new Error(`خطأ في قراءة مجلد التحميل: ${fsErr.message}`));
            }
        });
    });
}

function deleteFile(filePath) {
    try {
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch (e) {}
}

// ══════════════════════════════════════════
// القائمة الأولى (نقطة واحدة .) - 9 فيديوهات
// ══════════════════════════════════════════
const MENU1_IMAGE = 'https://c.top4top.io/p_37781yeyc0.jpg';
const menu1Videos = [
    { id: 1, url: 'https://g.top4top.io/m_3778hj5380.mp4' },
    { id: 2, url: 'https://h.top4top.io/m_3778uievg1.mp4' },
    { id: 3, url: 'https://i.top4top.io/m_37780x2tk2.mp4' },
    { id: 4, url: 'https://g.top4top.io/m_37782xaku3.mp4' },
    { id: 5, url: 'https://h.top4top.io/m_37789uhnr4.mp4' },
    { id: 6, url: 'https://i.top4top.io/m_3778uiqzi5.mp4' },
    { id: 7, url: 'https://j.top4top.io/m_37787kkgr6.mp4' },
    { id: 8, url: 'https://k.top4top.io/m_3778ywkrs7.mp4' },
    { id: 9, url: 'https://l.top4top.io/m_3778ooi3b8.mp4' },
];

// ══════════════════════════════════════════
// القائمة الثانية (نقطتين ..) - 4 فيديوهات
// ══════════════════════════════════════════
const MENU2_IMAGE = 'https://h.top4top.io/p_3778tpspl0.jpg';
const menu2Videos = [
    { id: 1, url: 'https://d.top4top.io/m_37780m36g0.mp4' },
    { id: 2, url: 'https://e.top4top.io/m_3778qeanq1.mp4' },
    { id: 3, url: 'https://f.top4top.io/m_37783am272.mp4' },
    { id: 4, url: 'https://g.top4top.io/m_3778ya3nw3.mp4' },
];

// ══════════════════════════════════════════
// 📩 معالج رسائل الخاص - ميزة التحميل فقط
// ══════════════════════════════════════════
async function handlePrivateMessage(sock, msg, from) {
    try {
        const msgType = Object.keys(msg.message || {})[0] || 'unknown';
        const text = extractText(msg);

        console.log(`📩 [خاص] من: ${from} | نوع: ${msgType} | نص: "${text}"`);

        // تجاهل الأنواع التي لا تحتاج رد (ستيكر، صوت، فيديو مرسل، بروتوكول)
        const silentTypes = ['stickerMessage', 'audioMessage', 'protocolMessage', 'reactionMessage', 'pollUpdateMessage'];
        if (silentTypes.includes(msgType)) {
            console.log(`🔕 [خاص] نوع صامت: ${msgType}`);
            return;
        }

        // ── استخراج الرابط: أولاً مباشرة من الكائن، ثم من النص ──
        const videoUrl = getUrlFromMessage(msg);
        console.log(`🔗 [خاص] رابط مكتشف: ${videoUrl || 'لا يوجد'}`);

        if (!videoUrl) {
            // لا يوجد رابط → رسالة مساعدة دائماً (حتى لو النص فارغ)
            console.log(`ℹ️ [خاص] لا يوجد رابط، إرسال رسالة مساعدة.`);
            try {
                await sock.sendMessage(from, {
                    text: `🦅 *أهلاً بك في خدمة التحميل*\n\nأرسل لي رابط الفيديو من:\n• يوتيوب 🎬\n• تيكتوك 🎵\n• انستقرام 📸\n• فيسبوك 👍\n• وغيرها...\n\n🛠️ *ورشة الصقور للتصميم والبرمجة*`
                });
                console.log(`✅ [خاص] تم إرسال رسالة المساعدة`);
            } catch (e) {
                console.log(`⚠️ [خاص] فشل إرسال رسالة المساعدة: ${e.message}`);
            }
            return;
        }

        console.log(`🎬 [خاص] جاري المعالجة: ${videoUrl}`);

        // رسالة الانتظار
        try {
            await sock.sendMessage(from, {
                text: `🦅 *أهلاً وسهلاً بكم بميزة التحميل المقدمة من صقور العراق* 🦅\n\n⏳ جاري تحميل الفيديو...\n🔗 ${videoUrl}\n\n🙏 شكراً لصبركم\n\n🛠️ *ورشة الصقور للتصميم والبرمجة*`
            });
        } catch (e) {
            console.log(`⚠️ [خاص] فشل إرسال رسالة الانتظار: ${e.message}`);
        }

        let videoPath = null;
        try {
            videoPath = await downloadVideo(videoUrl);
            const stats = fs.statSync(videoPath);
            const fileSizeMB = (stats.size / (1024 * 1024)).toFixed(2);
            console.log(`📦 [خاص] حجم الفيديو: ${fileSizeMB} MB`);

            if (stats.size > 64 * 1024 * 1024) {
                await sock.sendMessage(from, {
                    text: `⚠️ *الفيديو كبير جداً (${fileSizeMB} MB)*\n\nواتساب لا يقبل ملفات أكبر من 64MB.\n\nحاول رابطاً لفيديو أقصر.\n\n🛠️ *ورشة الصقور للتصميم والبرمجة*`
                });
                return;
            }

            const videoBuffer = fs.readFileSync(videoPath);
            await sock.sendMessage(from, {
                video: videoBuffer,
                mimetype: 'video/mp4',
                caption: `✅ *تم التحميل بنجاح* 🦅\n_صقور العراق - ورشة الصقور للتصميم والبرمجة_`
            });

            console.log(`✅ [خاص] تم إرسال الفيديو إلى: ${from}`);

        } catch (dlErr) {
            console.log(`⚠️ [خاص] فشل التحميل: ${dlErr.message}`);
            try {
                await sock.sendMessage(from, {
                    text: `⚠️ *عذراً، لم يتمكن البوت من تحميل الفيديو*\n\nقد يكون السبب:\n• الفيديو خاص أو محذوف\n• الرابط غير صحيح أو منتهي\n• الفيديو طويل جداً\n• المنصة غير مدعومة\n\n🔗 الرابط: ${videoUrl}\n\n🛠️ *ورشة الصقور للتصميم والبرمجة*`
                });
            } catch (e2) {
                console.log(`⚠️ [خاص] فشل إرسال رسالة الخطأ: ${e2.message}`);
            }
        } finally {
            if (videoPath) deleteFile(videoPath);
        }

    } catch (err) {
        console.log(`⚠️ [خاص] خطأ غير متوقع: ${err.message}`);
    }
}

// ══════════════════════════════════════════
// الدالة الرئيسية
// ══════════════════════════════════════════
async function startBot() {
    await redis.connect();
    console.log('✅ Redis متصل!');

    // تأكد من وجود yt-dlp وحمّله تلقائياً إذا لزم
    await ensureYtDlp();

    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }),
        browser: ["Ubuntu", "Chrome", "20.0.04"],
        getMessage: async (key) => {
            return { conversation: '' };
        }
    });

    let oggPath = null;
    if (fs.existsSync('./voice.mp3')) {
        try {
            oggPath = await convertToOgg('./voice.mp3');
            console.log(`🎵 الصوت جاهز: ${oggPath}`);
        } catch (err) { console.log('⚠️ تعذّر تحويل الصوت.'); }
    } else {
        console.log('⚠️ voice.mp3 غير موجود!');
    }

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

    // ══════════════════════════════════════════
    // Express API - OTP Service
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

    app.get('/', (req, res) => {
        res.json({ status: '🦅 صقور العراق - OTP Service يعمل', time: new Date().toISOString() });
    });

    app.post('/send-otp', async (req, res) => {
        const { phone, secret } = req.body;
        if (secret !== OTP_SECRET) return res.status(401).json({ success: false, error: 'Unauthorized' });
        if (!phone) return res.status(400).json({ success: false, error: 'رقم الهاتف مطلوب' });

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
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`🚀 OTP API يعمل على port ${PORT}`);
    });

    // ══════════════════════════════════════════
    // 🎬 معالج الرسائل الرئيسي
    // ══════════════════════════════════════════
    sock.ev.on('messages.upsert', async (m) => {
        try {
            if (!m.messages || m.messages.length === 0) return;

            const msg = m.messages[0];

            if (!msg || !msg.message) return;
            if (msg.key.fromMe) return;

            const msgId = msg.key.id;

            // فحص Redis لمنع معالجة نفس الرسالة مرتين حتى بعد إعادة التشغيل
            if (await isProcessed(msgId)) {
                console.log(`🔁 [SKIP] رسالة مكررة: ${msgId}`);
                return;
            }
            await markProcessed(msgId);

            const from = msg.key.remoteJid;
            if (!from) return;

            // @lid هو صيغة جديدة في واتساب للرسائل الخاصة
            const isPrivate = from.endsWith('@s.whatsapp.net') || from.endsWith('@lid');
            const isGroup = from.endsWith('@g.us');

            // ── الخاص: ميزة التحميل فقط ──
            if (isPrivate) {
                await handlePrivateMessage(sock, msg, from);
                return;
            }

            // ── المجموعات: المنطق الأصلي ──
            if (!isGroup) return;

            const sender = msg.key.participant || msg.key.remoteJid;
            const type = Object.keys(msg.message)[0];
            const content = msg.message.conversation || msg.message.extendedTextMessage?.text || "";

            if (type === 'imageMessage') {
                const caption = msg.message.imageMessage?.caption || "";
                const wordCount = countWords(caption);
                console.log(`🖼️ صورة من ${sender} - عدد الكلمات: ${wordCount}`);
                if (wordCount > 10) {
                    try {
                        await sock.sendMessage(from, { delete: msg.key });
                        console.log(`🗑️ حذف صورة (+10 كلمة) من: ${sender}`);
                    } catch (err) { console.log("⚠️ فشل الحذف."); }
                } else if (wordCount > 5) {
                    if (oggPath && fs.existsSync(oggPath)) {
                        try {
                            await sock.sendMessage(from, {
                                audio: fs.readFileSync(oggPath),
                                mimetype: 'audio/ogg; codecs=opus',
                                ptt: true,
                            }, { quoted: msg });
                        } catch (err) { console.log(`⚠️ فشل إرسال الصوت: ${err.message}`); }
                    }
                }
                return;
            }

            const isMedia = ['videoMessage', 'stickerMessage', 'audioMessage', 'documentMessage'].includes(type);
            if (isMedia) return;

            const isText = type === 'conversation' || type === 'extendedTextMessage';
            if (!isText) return;

            if (!content || content.trim().length === 0) return;

            const mentionedJids = msg.message.extendedTextMessage?.contextInfo?.mentionedJid || [];
            const hasMention = mentionedJids.length > 0 || content.includes('@');
            const trimmed = content.trim();
            console.log(`📨 رسالة من ${sender}: "${trimmed}"`);

            if (trimmed === '..') {
                const quotedParticipant2 = msg.message.extendedTextMessage?.contextInfo?.participant || null;
                try {
                    const sendOpts = quotedParticipant2
                        ? { quoted: { key: { remoteJid: from, id: msg.message.extendedTextMessage?.contextInfo?.stanzaId, participant: quotedParticipant2 }, message: {} } }
                        : { quoted: msg };
                    await sock.sendMessage(from, {
                        image: { url: MENU2_IMAGE },
                        caption: '✏️ *اكتب رقم من 1 إلى 4 لإرسال الفيديو المطلوب*'
                    }, sendOpts);
                    await redis.set('menu2:' + from, '1', { EX: 3600 });
                    await redis.del('menu1:' + from);
                    console.log('📋 قائمة 2 لمجموعة: ' + from);
                } catch (err) { console.log('⚠️ فشل قائمة 2: ' + err.message); }
                return;
            }

            if (trimmed === '.') {
                const quotedParticipant1 = msg.message.extendedTextMessage?.contextInfo?.participant || null;
                try {
                    const sendOpts = quotedParticipant1
                        ? { quoted: { key: { remoteJid: from, id: msg.message.extendedTextMessage?.contextInfo?.stanzaId, participant: quotedParticipant1 }, message: {} } }
                        : { quoted: msg };
                    await sock.sendMessage(from, {
                        image: { url: MENU1_IMAGE },
                        caption: '✏️ *اكتب رقم من 1 إلى 9 لإرسال الفيديو المطلوب*'
                    }, sendOpts);
                    await redis.set('menu1:' + from, '1', { EX: 3600 });
                    await redis.del('menu2:' + from);
                    console.log('📋 قائمة 1 لمجموعة: ' + from);
                } catch (err) { console.log('⚠️ فشل قائمة 1: ' + err.message); }
                return;
            }

            const choice = parseInt(trimmed);
            if (!isNaN(choice) && choice >= 1) {
                const quotedParticipant = msg.message.extendedTextMessage?.contextInfo?.participant || null;
                const targetJid = (hasMention && mentionedJids.length > 0)
                    ? mentionedJids[0]
                    : (quotedParticipant || sender);
                const quotedMsg = quotedParticipant
                    ? { key: { remoteJid: from, id: msg.message.extendedTextMessage?.contextInfo?.stanzaId, participant: quotedParticipant }, message: {} }
                    : msg;

                const inMenu2 = await redis.get('menu2:' + from);
                if (inMenu2 && choice >= 1 && choice <= menu2Videos.length) {
                    const selected = menu2Videos[choice - 1];
                    try {
                        const targetNumber = targetJid.replace('@s.whatsapp.net', '');
                        await sock.sendMessage(from, {
                            video: { url: selected.url },
                            mimetype: 'video/mp4',
                            caption: `@${targetNumber}`,
                            mentions: [targetJid]
                        }, { quoted: quotedMsg });
                        await redis.del('menu2:' + from);
                        console.log(`✅ [قائمة2] فيديو ${choice} → ${targetJid}`);
                    } catch (err) { console.log('⚠️ فشل فيديو قائمة 2: ' + err.message); }
                    return;
                }

                const inMenu1 = await redis.get('menu1:' + from);
                if (inMenu1 && choice >= 1 && choice <= menu1Videos.length) {
                    const selected = menu1Videos[choice - 1];
                    try {
                        const targetNumber = targetJid.replace('@s.whatsapp.net', '');
                        await sock.sendMessage(from, {
                            video: { url: selected.url },
                            mimetype: 'video/mp4',
                            caption: `@${targetNumber}`,
                            mentions: [targetJid]
                        }, { quoted: quotedMsg });
                        await redis.del('menu1:' + from);
                        console.log(`✅ [قائمة1] فيديو ${choice} → ${targetJid}`);
                    } catch (err) { console.log('⚠️ فشل فيديو قائمة 1: ' + err.message); }
                    return;
                }
            }

            if (hasMention) {
                console.log(`🔕 تجاهل تاك من: ${sender}`);
                return;
            }

            const warned = await isWarned(sender);
            if (!warned) {
                console.log(`🆕 مستخدم جديد: ${sender} → إرسال البصمة + حذف رسالته`);
                // إرسال الصوت
                if (oggPath && fs.existsSync(oggPath)) {
                    try {
                        await sock.sendMessage(from, {
                            audio: fs.readFileSync(oggPath),
                            mimetype: 'audio/ogg; codecs=opus',
                            ptt: true,
                        }, { quoted: msg });
                        console.log(`🎙️ تم إرسال البصمة لـ: ${sender}`);
                        await addWarned(sender);
                    } catch (err) {
                        console.log(`⚠️ فشل إرسال الصوت: ${err.message} → لن يُسجَّل كمحذَّر`);
                    }
                } else {
                    console.log(`⚠️ voice.mp3 غير موجود → لن يُسجَّل ${sender} كمحذَّر`);
                }
                // حذف رسالته فوراً
                try {
                    await sock.sendMessage(from, { delete: msg.key });
                    console.log(`🗑️ حذف رسالة الجديد: ${sender}`);
                } catch (err) { console.log("⚠️ فشل حذف رسالة الجديد."); }
            } else {
                // محفوظ: حذف كل رسائله بدون استثناء
                console.log(`🗑️ حذف رسالة ${sender} (محفوظ مسبقاً)`);
                try {
                    await sock.sendMessage(from, { delete: msg.key });
                } catch (err) { console.log("⚠️ فشل الحذف - تأكد أن البوت مشرف."); }
            }

        } catch (globalErr) {
            console.log(`⚠️ خطأ عام في معالج الرسائل: ${globalErr.message}`);
        }
    });

    sock.ev.on('connection.update', async (up) => {
        const { connection, lastDisconnect } = up;
        if (connection === 'open') console.log('🦅 صقور العراق: البوت متصل!');
        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== 401;
            if (shouldReconnect) {
                console.log('🔄 إعادة الاتصال...');
                startBot();
            }
        }
    });
}

startBot();
