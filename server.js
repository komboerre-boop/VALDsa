/**
 * server.js — Bot Manager v3
 * npm install express socket.io mineflayer
 */

const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const mineflayer = require('mineflayer');
const os         = require('os');
const path       = require('path');
const crypto     = require('crypto');
const fs         = require('fs');

let SocksClient = null;
try { SocksClient = require('socks').SocksClient; } catch {}

const app    = express();
const server = http.createServer(app);
const io     = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// ── Константы ────────────────────────────────
const USERNAME_MAX_LEN      = 16;
const AUTH_PASSWORD_MAX_LEN = 32;
const FREE_REWARDS_MIN      = [15, 45, 75, 120, 180, 300, 420, 520, 720, 1440];
const AUTH_RETRY_WINDOW_MS  = 4000;
const DEFAULT_AUTH_DELAY_MS = 1400;
const AUTO_NAV_DELAY_MS     = 4500;
const AUTO_AFK_DELAY_MS     = 20000; // ждём дольше чтобы навигация по грифам успела завершиться
const LIVE_STATS_INTERVAL_MS = 3000;
const AFK_TELEPORT_TIMEOUT_MS = 12000;
const AFK_MOVE_DURATION_MS  = 3200;
const AFK_MIN_MOVEMENT_BLOCKS = 1.35;
const MAX_LOGS_PER_BOT      = 60;
const MAX_LOG_TEXT_LEN      = 220;
const CHUNK_GC_INTERVAL_MS  = 30000;
const CHUNK_COMPACT_DELAY_MS = 4000;
const LOW_MEMORY_VIEW_DISTANCE = 'tiny';
const BATCH_START_STAGGER_MS = 450;
const DEFAULT_START_WAVE_SIZE = 10;
const MAX_START_WAVE_SIZE   = 500;
const DEFAULT_WAVE_DELAY_MS = 4000;
const MAX_WAVE_DELAY_MS     = 60000;
const AUTO_RECONNECT_BASE_MS = 5000;
const AUTO_RECONNECT_MAX_MS  = 60000;
const RILIKY_LABEL_REGEX     = /(?:рилл|рилик|relic)/iu;
const RILIKY_VALUE_REGEX     = /(?:рилл|рилик|relic)[^0-9\-]*([0-9][\d\s,.']*)/iu;

// ── Изменяемые настройки (сохраняются в settings.json) ───────────────────────
const SETTINGS_FILE = path.join(__dirname, 'settings.json');
const SETTINGS_DEFAULTS = {
    chatGapMs:          600,
    startStaggerMs:     700,   // ~1.4 бота/сек — вписывается в BungeeCord throttle
    waveSize:           8,
    waveDelayMs:        5000,
    warpTimeoutMs:      8000,
    afkWalkMs:          3200,
    chunkGcMs:          30000,
    shopOpenTimeoutMs:  4000,
    shopClickTimeoutMs: 1200,
    freeSlotDelayMs:    250,
    antiTimeoutMinSec:  32,
    antiTimeoutMaxSec:  55,
    freeRewardsMin:     [15, 45, 75, 120, 180, 300, 420, 520, 720, 1440],
};
let S = { ...SETTINGS_DEFAULTS };
try {
    const stored = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    S = { ...SETTINGS_DEFAULTS, ...stored };
} catch {}
function saveSettings() {
    try { fs.writeFileSync(SETTINGS_FILE, JSON.stringify(S, null, 2)); } catch {}
}

// ── Прокси-пул ─────────────────────────────────────────────────────────────
const PROXIES_FILE = path.join(__dirname, 'proxies.json');
let proxyPool = [];     // { url, alive, lastCheck, botsLimit }
let proxyCheckRunning = false;

(function loadProxiesFromDisk() {
    try {
        const raw = JSON.parse(fs.readFileSync(PROXIES_FILE, 'utf8'));
        proxyPool = Array.isArray(raw)
            ? raw.map(p => {
                const url = normalizeProxyUrl(p.url || p);
                if (!url) return null;
                return { url, alive: p.alive ?? null, lastCheck: p.lastCheck || 0, botsLimit: Math.max(1, parseInt(p.botsLimit) || 10) };
            }).filter(Boolean)
            : [];
    } catch {}
})();

function saveProxiesToDisk() {
    try {
        fs.writeFileSync(PROXIES_FILE, JSON.stringify(
            proxyPool.map(({ url, alive, lastCheck, botsLimit }) => ({ url, alive, lastCheck, botsLimit })),
            null, 2
        ));
    } catch {}
}

function normalizeProxyUrl(raw) {
    raw = String(raw || '').trim();
    if (!raw) return null;
    if (/^socks[45]:\/\//i.test(raw)) return raw;
    // ip:port  or  user:pass@ip:port
    if (/^\d{1,3}(\.\d{1,3}){3}:\d{2,5}$/.test(raw)) return `socks5://${raw}`;
    if (/^[^@\s]+@\d{1,3}(\.\d{1,3}){3}:\d{2,5}$/.test(raw)) return `socks5://${raw}`;
    return null;
}

function parseProxyText(text) {
    const seen = new Set();
    return text.split(/[\r\n,;|\t]+/)
        .map(l => normalizeProxyUrl(l.trim()))
        .filter(u => u && !seen.has(u) && seen.add(u));
}

async function checkProxyUrl(url, timeoutMs = 3500) {
    if (!SocksClient) return false;
    try {
        let pHost, pPort = 1080, pType = 5, pUser, pPass;
        if (url.includes('://')) {
            const u = new URL(url);
            pType  = url.startsWith('socks4') ? 4 : 5;
            pHost  = u.hostname; pPort = parseInt(u.port) || 1080;
            pUser  = u.username || undefined; pPass = u.password || undefined;
        } else {
            const [h, p] = url.split(':'); pHost = h; pPort = parseInt(p) || 1080;
        }
        const res = await SocksClient.createConnection({
            proxy:       { host: pHost, port: pPort, type: pType, userId: pUser, password: pPass },
            command:     'connect',
            destination: { host: '8.8.8.8', port: 53 },
            timeout:     timeoutMs,
        });
        try { res?.socket?.destroy(); } catch {}
        return true;
    } catch { return false; }
}

async function fetchUrlText(url) {
    const mod = url.startsWith('https') ? require('https') : require('http');
    return new Promise((resolve, reject) => {
        const req = mod.get(url, { timeout: 12000, headers: { 'User-Agent': 'Mozilla/5.0' } }, res => {
            if (res.statusCode !== 200) { reject(new Error(`HTTP ${res.statusCode}`)); return; }
            let d = '';
            res.setEncoding('utf8');
            res.on('data', c => { if (d.length < 3_000_000) d += c; });
            res.on('end', () => resolve(d));
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    });
}

const PROXY_SOURCES = [
    'https://api.proxyscrape.com/v2/?request=displayproxies&protocol=socks5&timeout=10000&country=all',
    'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/socks5.txt',
    'https://raw.githubusercontent.com/ShiftyTR/Proxy-List/master/socks5.txt',
    'https://api.openproxylist.xyz/socks5.txt',
    'https://raw.githubusercontent.com/roosterkid/openproxylist/main/SOCKS5_RAW.txt',
];

async function fetchProxiesFromSources() {
    const seen = new Set();
    for (const url of PROXY_SOURCES) {
        try {
            const text = await fetchUrlText(url);
            parseProxyText(text).forEach(p => seen.add(p));
        } catch {}
    }
    return [...seen];
}

function proxyUsageMap() {
    const m = new Map();
    for (const b of bots.values()) {
        if (b.config.proxy) m.set(b.config.proxy, (m.get(b.config.proxy) || 0) + 1);
    }
    return m;
}

function getProxyList() {
    const usage = proxyUsageMap();
    return proxyPool.map((p, i) => ({
        index: i, url: p.url, alive: p.alive,
        lastCheck: p.lastCheck, botsLimit: p.botsLimit,
        botsActive: usage.get(p.url) || 0,
    }));
}

// Выбрать прокси с наименьшей нагрузкой (игнорируем confirmed-dead если есть живые)
function pickProxy() {
    if (!proxyPool.length) return null;
    const usage  = proxyUsageMap();
    const hasAlive = proxyPool.some(p => p.alive === true);
    const pool   = proxyPool.filter(p => hasAlive ? p.alive === true : p.alive !== false);
    if (!pool.length) return null;
    const sorted = pool
        .map(p => ({ url: p.url, ratio: (usage.get(p.url) || 0) / p.botsLimit }))
        .filter(x => x.ratio < 1)
        .sort((a, b) => a.ratio - b.ratio);
    return sorted[0]?.url ?? null;
}

// ── Стадии бота (для явного отображения в UI) ─
const STAGE = {
    QUEUED:     'queued',
    CONNECTING: 'connecting',
    AUTH:       'auth',
    LOBBY:      'lobby',
    SERVER:     'server',
    AFK:        'afk',
    FARMING:    'farming',
    BANNED:     'banned',
    OFFLINE:    'offline',
    ERROR:      'error',
};

const LOG = {
    INFO:'info', WARN:'warn', ERROR:'error',
    SUCCESS:'success', SYSTEM:'system', ACTION:'action', BAN:'ban'
};

// ── Хранилище ────────────────────────────────
const bots  = new Map();
let   nextId = 1;

// CPU сэмплинг
const cpuCoreCount = Math.max(1, os.cpus().length);
let   cpuSnapshot = { ts: process.hrtime.bigint(), usage: process.cpuUsage() };
let   currentCpu  = 0;

const sleep   = ms => new Promise(r => setTimeout(r, ms));
function jitter(ms, pct = 0.25) {
    return Math.max(50, Math.round(ms * (1 - pct + Math.random() * pct * 2)));
}
const navWindowHandled = new Set();

// ── Безопасный чат (не флудим — ждём между командами) ──
const CHAT_MIN_GAP_MS = 600;
const chatQueues = new Map(); // id → Promise

function chatSafe(id, cmd) {
    const b = bots.get(id);
    if (!b?.mc) return Promise.resolve();
    const prev = chatQueues.get(id) || Promise.resolve();
    const token = b.mc; // привязываем к текущей сессии
    const next = prev.then(async () => {
        const cur = bots.get(id);
        // Не отправляем если бот сменился или не онлайн
        if (!cur?.mc || cur.mc !== token || cur.status !== 'online') return;
        try { cur.mc.chat(cmd); } catch(e) {
            addLog(id, LOG.WARN, `chatSafe ошибка: ${e.message}`);
        }
        await sleep(Math.max(S.chatGapMs, CHAT_MIN_GAP_MS));
    });
    chatQueues.set(id, next.catch(() => {}));
    return next;
}

function clearChatQueue(id) {
    chatQueues.delete(id);
}

// ── Ждём телепорт (смещение ≥ 2 блока или таймаут) ──────
function waitWarp(mc, timeoutMs = 8000) {
    if (!mc?.entity) return sleep(timeoutMs).then(() => false);
    return new Promise(resolve => {
        let done = false;
        const finish = val => {
            if (done) return; done = true;
            clearTimeout(timer);
            mc.removeListener('forcedMove', onMove);
            resolve(val);
        };
        const timer = setTimeout(() => finish(false), timeoutMs);
        const onMove = () => finish(true);
        mc.on('forcedMove', onMove);
    });
}

// ── Ждём чат-сообщение по regex (таймаут мс) ────────────
function waitChatMsg(mc, regex, timeoutMs = 4000) {
    return new Promise(resolve => {
        const t = setTimeout(() => { mc.removeListener('message', h); resolve(null); }, timeoutMs);
        function h(msg) {
            const s = msg.toString();
            if (regex.test(s)) { clearTimeout(t); mc.removeListener('message', h); resolve(s); }
        }
        mc.on('message', h);
    });
}

// ── Утилиты ──────────────────────────────────
function normalizeUsername(raw) {
    return String(raw ?? '').trim().replace(/\s+/g, '').slice(0, USERNAME_MAX_LEN);
}
function normalizePassword(raw, fallback) {
    const n = String(raw ?? '').trim().replace(/\s+/g, '').slice(0, AUTH_PASSWORD_MAX_LEN);
    return n || normalizeUsername(fallback).slice(0, AUTH_PASSWORD_MAX_LEN);
}
function clampInt(raw, min, max, fallback) {
    const value = parseInt(raw, 10);
    if (Number.isNaN(value)) return fallback;
    return Math.min(max, Math.max(min, value));
}
function makeUniqueUsername(rawUsername) {
    const requested = normalizeUsername(rawUsername);
    if (!requested) return '';
    const used = new Set([...bots.values()].map(b => String(b?.config?.username||'').toLowerCase()));
    if (!used.has(requested.toLowerCase())) return requested;
    for (let i = 2; i <= 9999; i++) {
        const suffix = `_${i}`;
        const base   = USERNAME_MAX_LEN - suffix.length;
        if (base < 1) break;
        const candidate = requested.slice(0, base) + suffix;
        if (!used.has(candidate.toLowerCase())) return candidate;
    }
    const fb = '_' + Date.now().toString().slice(-4);
    return requested.slice(0, Math.max(1, USERNAME_MAX_LEN - fb.length)) + fb;
}

function extractText(obj) {
    if (typeof obj === 'string') return obj;
    let t = obj.text || obj.translate || '';
    if (obj.extra) t += obj.extra.map(extractText).join('');
    return t;
}
function stringifyChatLike(value) {
    if (value == null) return '';
    if (typeof value === 'string' || typeof value === 'number') return String(value);
    if (Array.isArray(value)) return value.map(stringifyChatLike).join('');
    if (value?.json) return stringifyChatLike(value.json);
    if (typeof value?.toJSON === 'function') {
        try {
            const json = value.toJSON();
            const rendered = stringifyChatLike(json);
            if (rendered) return rendered;
        } catch {}
    }
    if (typeof value?.toString === 'function') {
        try {
            const rendered = String(value.toString());
            if (rendered && rendered !== '[object Object]') return rendered;
        } catch {}
    }
    if (typeof value === 'object') return extractText(value);
    return '';
}
function normalizeScoreboardText(value) {
    return String(value ?? '')
        .replace(/§./g, '')
        .replace(/[\u200B-\u200D\uFEFF]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}
function trimLogText(text) {
    const compact = String(text ?? '').replace(/\s+/g, ' ').trim();
    if (!compact) return '';
    if (compact.length <= MAX_LOG_TEXT_LEN) return compact;
    return compact.slice(0, MAX_LOG_TEXT_LEN - 1) + '…';
}
// ── Shop item parsing ─────────────────────────
const DECO_ITEMS = new Set([
    'gray_stained_glass_pane','black_stained_glass_pane','white_stained_glass_pane',
    'red_stained_glass_pane','green_stained_glass_pane','blue_stained_glass_pane',
    'cyan_stained_glass_pane','magenta_stained_glass_pane','light_blue_stained_glass_pane',
    'lime_stained_glass_pane','pink_stained_glass_pane','yellow_stained_glass_pane',
    'orange_stained_glass_pane','purple_stained_glass_pane','brown_stained_glass_pane',
]);

function extractSlotName(slot) {
    if (!slot) return '';
    try {
        const n = normalizeScoreboardText(stringifyChatLike(slot.displayName));
        if (n) return n;
    } catch {}
    try {
        const raw = slot.nbt?.value?.display?.value?.Name?.value;
        if (raw) {
            const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
            const n = normalizeScoreboardText(stringifyChatLike(parsed));
            if (n) return n;
        }
    } catch {}
    return slot.name || '';
}

function extractSlotLore(slot) {
    if (!slot) return [];
    const lines = [];
    try {
        const loreArr = slot.nbt?.value?.display?.value?.Lore?.value?.value;
        if (Array.isArray(loreArr)) {
            for (const l of loreArr) {
                try {
                    const parsed = typeof l === 'string' ? JSON.parse(l) : l;
                    const text = normalizeScoreboardText(stringifyChatLike(parsed));
                    if (text) lines.push(text);
                } catch { if (l) lines.push(normalizeScoreboardText(String(l))); }
            }
        }
    } catch {}
    return lines;
}

function parseShopSlot(slot, index, windowSize) {
    if (!slot || slot.type === 0 || slot.name === 'air') return null;
    const name = extractSlotName(slot);
    const lore = extractSlotLore(slot);
    const isDecorative = DECO_ITEMS.has(slot.name) || (!name && !lore.length);
    const allText = name + ' ' + lore.join(' ');

    // Back: по имени ИЛИ по позиции (нижний-левый слот последней строки)
    const lastRowStart = windowSize > 9 ? Math.floor((windowSize - 1) / 9) * 9 : -1;
    const isBackByPos  = lastRowStart >= 0 && index === lastRowStart;
    const isBack = /назад|back|вернуть|←|◄|❮/i.test(allText) || slot.name === 'arrow' || isBackByPos;

    // Пропускаем правый-нижний слот (обычно счётчик валюты/страниц)
    const isPageIndicator = windowSize > 9 && index === windowSize - 1;
    if (isPageIndicator) return null;

    let price = null;
    const lower = allText.toLowerCase();
    const pricePatterns = [
        /(?:цена|стоимость|price|cost)[^\d]*(\d[\d ]*)/i,
        /(\d[\d ]*)\s*(?:рилик|relic|монет|💎|🪙)/i,
    ];
    for (const pat of pricePatterns) {
        const m = lower.match(pat);
        if (m) { price = parseInt(m[1].replace(/\s/g, '')); break; }
    }
    // Fallback: count > 1 используется как цена в кастомных магазинах
    if (price == null && (slot.count || 1) > 1) price = slot.count;

    return { index, name, lore, itemType: slot.name, count: slot.count || 1, price, isDecorative, isBack };
}

function parseShopWindow(window) {
    if (!window) return null;
    const rawTitle = window.title || '';
    const title = normalizeScoreboardText(
        stringifyChatLike(typeof rawTitle === 'string' ? (() => { try { return JSON.parse(rawTitle); } catch { return rawTitle; } })() : rawTitle)
    );
    const slots = [];
    const size = window.slots?.length || 0;
    for (let i = 0; i < size; i++) {
        const p = parseShopSlot(window.slots[i], i, size);
        if (p) slots.push(p);
    }
    return { title, size, slots };
}

async function openShopCmd(id, cmd = '/shop') {
    const b = bots.get(id);
    if (!b?.mc) return null;
    return new Promise(resolve => {
        const timer = setTimeout(() => { b.mc?.removeListener?.('windowOpen', onWin); resolve(null); }, S.shopOpenTimeoutMs);
        const onWin = w => { clearTimeout(timer); resolve(w); };
        b.mc.once('windowOpen', onWin);
        b.mc.chat(cmd);
    });
}

async function clickAndWaitWin(id, slot) {
    const b = bots.get(id);
    if (!b?.mc) return null;
    return new Promise(async resolve => {
        const timer = setTimeout(() => { b.mc?.removeListener?.('windowOpen', onWin); resolve(null); }, S.shopClickTimeoutMs);
        const onWin = w => { clearTimeout(timer); resolve(w); };
        b.mc.once('windowOpen', onWin);
        try { await b.mc.clickWindow(slot, 0, 0); } catch { clearTimeout(timer); b.mc?.removeListener?.('windowOpen', onWin); resolve(null); }
    });
}

async function scanShopFull(id) {
    const b = bots.get(id);
    if (!b?.mc) return;
    addLog(id, LOG.ACTION, 'Сканирование магазина...');
    const result = { sections: [], items: [] };
    try {
        let rootWin = await openShopCmd(id, '/shop');
        if (!rootWin) { addLog(id, LOG.ERROR, 'Магазин не открылся'); return; }
        const rootParsed = parseShopWindow(rootWin);
        const candidates = rootParsed.slots.filter(s => !s.isDecorative && !s.isBack);
        for (const cand of candidates) {
            const cur = bots.get(id);
            if (!cur?.mc) break;
            const newWin = await clickAndWaitWin(id, cand.index);
            if (newWin) {
                const secParsed = parseShopWindow(newWin);
                const items = secParsed.slots.filter(s => !s.isDecorative && !s.isBack);
                result.sections.push({ name: cand.name, items });
                result.items.push(...items.map(i => ({ ...i, section: cand.name })));
                addLog(id, LOG.INFO, `  ${cand.name}: ${items.length} позиций`);
                try { cur.mc.closeWindow(newWin); } catch {}
                await sleep(150);
                rootWin = await openShopCmd(id, '/shop');
                if (!rootWin) break;
            } else if (cand.price != null) {
                result.items.push({ ...cand, section: 'root' });
            }
            await sleep(100);
        }
        const cur = bots.get(id);
        try { if (cur?.mc?.currentWindow) cur.mc.closeWindow(cur.mc.currentWindow); } catch {}
        addLog(id, LOG.SUCCESS, `Сканирование: ${result.sections.length} разделов, ${result.items.length} товаров`);
        b.shopScanResult = result;
        io.emit('shop:scan', { id, result });
    } catch(e) {
        addLog(id, LOG.ERROR, 'Скан магазина: ' + e.message);
    }
}

function compactChunks(mc) {
    try { mc?.world?.unloadAllChunks?.(); } catch {}
    try {
        if (mc?.entities) {
            for (const id of Object.keys(mc.entities)) {
                if (mc.entities[id] !== mc.entity) delete mc.entities[id];
            }
        }
    } catch {}
    if (typeof gc === 'function') { try { gc(); } catch {} }
}
function getScoreboardItemText(item) {
    if (!item) return '';
    const candidates = [
        item.displayName,
        item.displayName?.json,
        item.name,
        item.text,
        item.id,
    ];
    const parts = [];
    for (const candidate of candidates) {
        const text = trimLogText(normalizeScoreboardText(stringifyChatLike(candidate)));
        if (!text || parts.includes(text)) continue;
        parts.push(text);
    }
    return trimLogText(parts.join(' '));
}
function getScoreboardItems(scoreboard) {
    if (Array.isArray(scoreboard?.items) && scoreboard.items.length) return scoreboard.items;
    if (scoreboard?.itemsMap && typeof scoreboard.itemsMap === 'object') {
        return Object.values(scoreboard.itemsMap);
    }
    return [];
}
function parseLooseInt(text) {
    const chunks = String(text ?? '').match(/-?\d[\d\s.,]*/g);
    if (!chunks?.length) return null;
    const values = chunks
        .map(chunk => {
            const normalized = chunk.replace(/[^\d-]/g, '');
            if (!normalized || normalized === '-') return null;
            const parsed = parseInt(normalized, 10);
            return Number.isFinite(parsed) ? parsed : null;
        })
        .filter(Number.isFinite);
    if (!values.length) return null;
    return values[values.length - 1];
}
function parseRelicsFromScoreboard(scoreboard) {
    const items = getScoreboardItems(scoreboard);
    if (!items.length) return null;
    for (const item of items) {
        const line = getScoreboardItemText(item);
        if (!RILIKY_LABEL_REGEX.test(line)) continue;
        // Берём число прямо из текста строки (запятая/пробел как разделитель тысяч)
        const inlineMatch = line.match(RILIKY_VALUE_REGEX);
        const inlineValue = inlineMatch ? parseInt(inlineMatch[1].replace(/[\s,.']/g, ''), 10) : null;
        const scoreValue = Number.isFinite(item.value) && item.value !== 0 ? item.value : null;
        const value = Number.isFinite(inlineValue) ? inlineValue : scoreValue;
        if (!Number.isFinite(value)) continue;
        return {
            value: Math.max(0, value),
            line,
            sidebarTitle: trimLogText(normalizeScoreboardText(stringifyChatLike(scoreboard.title || scoreboard.name || ''))),
        };
    }
    const titleText = trimLogText(normalizeScoreboardText(stringifyChatLike(scoreboard?.title || scoreboard?.name || '')));
    if (RILIKY_LABEL_REGEX.test(titleText)) {
        const values = items
            .map(item => Number.isFinite(item?.value) && item.value !== 0 ? item.value : parseLooseInt(item?.value))
            .filter(v => Number.isFinite(v) && v !== 0);
        if (values.length) {
            return {
                value: Math.max(0, values[values.length - 1]),
                line: titleText,
                sidebarTitle: titleText,
            };
        }
    }
    return null;
}
function listKnownScoreboards(mc, preferred = null) {
    const seen = new Set();
    const result = [];
    const push = scoreboard => {
        if (!scoreboard || typeof scoreboard !== 'object') return;
        if (seen.has(scoreboard)) return;
        seen.add(scoreboard);
        result.push(scoreboard);
    };
    push(preferred);
    push(mc?.scoreboard?.sidebar);
    push(mc?.scoreboard?.[1]);
    if (mc?.scoreboard && typeof mc.scoreboard === 'object') {
        Object.values(mc.scoreboard).forEach(push);
    }
    if (mc?.scoreboards && typeof mc.scoreboards === 'object') {
        Object.values(mc.scoreboards).forEach(push);
    }
    return result;
}
function findRelicsScoreboard(mc, preferred = null) {
    const scoreboards = listKnownScoreboards(mc, preferred);
    for (const scoreboard of scoreboards) {
        const parsed = parseRelicsFromScoreboard(scoreboard);
        if (parsed) return { parsed, scoreboardsFound: scoreboards.length };
    }
    return { parsed: null, scoreboardsFound: scoreboards.length };
}
function createRelicsState() {
    return {
        value: null,
        updatedAt: null,
        line: '',
        sidebarTitle: '',
        stale: true,
        live: false,
    };
}
function scheduleWorldCompaction(id, delay = CHUNK_COMPACT_DELAY_MS) {
    const t = setTimeout(() => {
        const b = bots.get(id);
        if (!b?.mc) return;
        compactChunks(b.mc);
    }, delay);
    t.unref?.();
}
function buildBotState(id, config, status = 'connecting', stage = STAGE.CONNECTING) {
    return { id, config, logs: [], mc: null, relics: createRelicsState(), ...createRuntimeState(), status, stage };
}
function queueBotStart(id, delayMs = 0) {
    const b = bots.get(id);
    if (!b) return;
    if (b.startTimer) {
        clearTimeout(b.startTimer);
        b.startTimer = null;
    }
    if (delayMs <= 0) {
        createBot(id, b.config);
        return;
    }
    b.startTimer = setTimeout(() => {
        const cur = bots.get(id);
        if (!cur) return;
        cur.startTimer = null;
        createBot(id, cur.config);
    }, delayMs);
}
function scheduleBatchStart(ids, waveSize, waveDelayMs) {
    const safeWaveSize = clampInt(
        waveSize,
        1,
        Math.min(MAX_START_WAVE_SIZE, Math.max(1, ids.length)),
        Math.min(DEFAULT_START_WAVE_SIZE, Math.max(1, ids.length))
    );
    const safeWaveDelayMs = clampInt(waveDelayMs, 0, MAX_WAVE_DELAY_MS, DEFAULT_WAVE_DELAY_MS);
    ids.forEach((id, index) => {
        const waveIndex = Math.floor(index / safeWaveSize);
        const positionInWave = index % safeWaveSize;
        const delayMs =
            waveIndex * (safeWaveDelayMs + safeWaveSize * S.startStaggerMs) +
            positionInWave * S.startStaggerMs;
        queueBotStart(id, delayMs);
    });
    return {
        waveSize: safeWaveSize,
        waveDelayMs: safeWaveDelayMs,
        waves: Math.ceil(ids.length / safeWaveSize),
    };
}
function getReconnectDelay(attempt) {
    const safeAttempt = Math.max(1, attempt || 1);
    return Math.min(AUTO_RECONNECT_MAX_MS, AUTO_RECONNECT_BASE_MS * (2 ** Math.min(safeAttempt - 1, 4)));
}
function scheduleReconnect(id, reason = 'disconnect') {
    const b = bots.get(id);
    if (!b || b.config.autoReconnect === false || b.status === 'banned' || b.suppressReconnect) return;
    if (b.reconnectTimer || b.startTimer || b.mc) return;
    b.reconnectAttempts = (b.reconnectAttempts || 0) + 1;
    const delayMs = getReconnectDelay(b.reconnectAttempts);
    const attempt = b.reconnectAttempts;
    const why = trimLogText(reason);
    addLog(
        id,
        LOG.SYSTEM,
        why
            ? `Авто-реконнект через ${Math.ceil(delayMs / 1000)}с (попытка ${attempt}) — ${why}`
            : `Авто-реконнект через ${Math.ceil(delayMs / 1000)}с (попытка ${attempt})`
    );
    b.reconnectTimer = setTimeout(() => {
        const cur = bots.get(id);
        if (!cur || cur.suppressReconnect || cur.status === 'banned') return;
        cur.reconnectTimer = null;
        createBot(id, cur.config, { preserveReconnect: true });
    }, delayMs);
    b.reconnectTimer.unref?.();
}
function stopBotSession(id, { suppressReconnect = true, stage = null } = {}) {
    const b = bots.get(id);
    if (!b) return null;
    b.suppressReconnect = suppressReconnect;
    cleanup(id);
    const mc = b.mc;
    b.mc = null;
    try { mc?.quit(); } catch {}
    if (stage) setStage(id, stage);
    return b;
}
function buildRelicsSummary() {
    const all = [...bots.values()];
    const tracked = all
        .map(b => ({
            id: b.id,
            username: b.config.username,
            host: b.config.host,
            status: b.status,
            stage: b.stage,
            relics: Number.isFinite(b.riliky) ? b.riliky : (Number.isFinite(b.relics?.value) ? b.relics.value : null),
            updatedAt: b.relics?.updatedAt || null,
            stale: b.relics?.stale !== false,
            live: b.relics?.live === true,
            line: b.relics?.line || '',
            sidebarTitle: b.relics?.sidebarTitle || '',
        }))
        .sort((a, b) => {
            const av = a.relics ?? -1;
            const bv = b.relics ?? -1;
            if (bv !== av) return bv - av;
            return a.username.localeCompare(b.username, 'ru');
        });

    const withRelics = tracked.filter(item => Number.isFinite(item.relics));
    const totalRelics = withRelics.reduce((sum, item) => sum + item.relics, 0);
    const latestUpdatedAt = withRelics.reduce((max, item) => Math.max(max, item.updatedAt || 0), 0) || null;
    const topBot = withRelics[0] || null;

    return {
        totalRelics,
        botsTracked: all.length,
        botsWithRelics: withRelics.length,
        liveRelicBots: withRelics.filter(item => item.live && !item.stale).length,
        staleRelicBots: withRelics.filter(item => item.stale).length,
        onlineBots: all.filter(b => b.status === 'online').length,
        averageRelics: withRelics.length ? Math.round(totalRelics / withRelics.length) : 0,
        maxRelics: topBot?.relics || 0,
        latestUpdatedAt,
        topBot: topBot ? { id: topBot.id, username: topBot.username, relics: topBot.relics } : null,
        settings: {
            autoAuthOn: all.filter(b => b.config.autoAuth !== false).length,
            autoNavOn: all.filter(b => b.config.autoNav !== false).length,
            autoAfkOn: all.filter(b => b.config.autoAfk !== false).length,
            autoFreeOn: all.filter(b => b.config.autoFree !== false).length,
            autoReconnectOn: all.filter(b => b.config.autoReconnect !== false).length,
        },
        leaderboard: tracked,
    };
}
function broadcastRelicsSummary() {
    io.emit('relics:summary', buildRelicsSummary());
}
function emitBotRiliky(id) {
    const b = bots.get(id);
    if (!b) return;
    io.emit('bot:riliky', { id, riliky: Number.isFinite(b.riliky) ? b.riliky : null });
}
function emitBotRelics(id) {
    const b = bots.get(id);
    if (!b) return;
    io.emit('bot:relics', { id, relics: b.relics });
    emitBotRiliky(id);
}
function setRelicsLiveState(id, { live, stale = true, clearSidebar = false } = {}) {
    const b = bots.get(id);
    if (!b?.relics) return;
    const prev = JSON.stringify(b.relics);
    b.relics.live = !!live;
    b.relics.stale = stale;
    if (clearSidebar) {
        b.relics.line = '';
        b.relics.sidebarTitle = '';
    }
    if (JSON.stringify(b.relics) !== prev) {
        emitBotRelics(id);
        broadcastRelicsSummary();
    }
}
function updateBotRelics(id, scoreboard = null) {
    const b = bots.get(id);
    if (!b?.relics) return;

    const found = findRelicsScoreboard(b.mc, scoreboard);
    if (!found.scoreboardsFound) {
        setRelicsLiveState(id, { live: false, stale: b.relics.value != null, clearSidebar: true });
        return;
    }
    const parsed = found.parsed;
    if (!parsed) {
        setRelicsLiveState(id, { live: true, stale: true, clearSidebar: true });
        return;
    }
    markEnteredGrief(id);
    const changed =
        b.riliky !== parsed.value ||
        b.relics.value !== parsed.value ||
        b.relics.line !== parsed.line ||
        b.relics.sidebarTitle !== parsed.sidebarTitle ||
        b.relics.stale ||
        !b.relics.live;
    if (!changed) return;
    b.riliky = parsed.value;
    Object.assign(b.relics, {
        value: parsed.value,
        updatedAt: Date.now(),
        line: parsed.line,
        sidebarTitle: parsed.sidebarTitle,
        stale: false,
        live: true,
    });
    emitBotRelics(id);
    broadcastRelicsSummary();
}
function scheduleRelicsRefresh(id, delay = 1200) {
    const b = bots.get(id);
    if (!b) return;
    if (b.relicsTimer) {
        clearTimeout(b.relicsTimer);
        b.relicsTimer = null;
    }
    const t = setTimeout(() => {
        const cur = bots.get(id);
        if (!cur) return;
        cur.relicsTimer = null;
        updateBotRelics(id);
    }, delay);
    b.relicsTimer = t;
    t.unref?.();
}
function handleDisconnect(id, mc, {
    logType = null,
    message = '',
    stage = STAGE.OFFLINE,
    ban = false,
    stopReconnect = false,
    reconnectReason = '',
} = {}) {
    const b = bots.get(id);
    if (!b || b.mc !== mc || b.disconnectHandled) return;
    b.disconnectHandled = true;
    if (logType && message) addLog(id, logType, message);
    if (ban) {
        b.suppressReconnect = true;
        setStage(id, STAGE.BANNED);
    } else {
        if (stopReconnect) b.suppressReconnect = true;
        setStage(id, stage);
    }
    cleanup(id);
    b.mc = null;
    compactChunks(mc);
    setRelicsLiveState(id, { live: false, stale: b.relics?.value != null, clearSidebar: true });
    if (!ban && !stopReconnect) scheduleReconnect(id, reconnectReason || message);
}

// ── Лог и статус ────────────────────────────
function addLog(id, type, text) {
    const b = bots.get(id); if (!b) return;
    const safeText = trimLogText(text);
    if (!safeText) return;
    const entry = { type, text: safeText, ts: Date.now() };
    b.logs.push(entry);
    if (b.logs.length > MAX_LOGS_PER_BOT) b.logs.shift();
    io.emit('bot:log', { id, ...entry });
}

function setStage(id, stage) {
    const b = bots.get(id); if (!b) return;
    b.stage = stage;
    // Маппинг стадии на общий статус
    const statusMap = {
        [STAGE.QUEUED]:     'offline',
        [STAGE.CONNECTING]: 'connecting',
        [STAGE.AUTH]:       'connecting',
        [STAGE.LOBBY]:      'online',
        [STAGE.SERVER]:     'online',
        [STAGE.AFK]:        'online',
        [STAGE.FARMING]:    'online',
        [STAGE.BANNED]:     'banned',
        [STAGE.OFFLINE]:    'offline',
        [STAGE.ERROR]:      'error',
    };
    b.status = statusMap[stage] || stage;
    io.emit('bot:stage', { id, stage, status: b.status });
    broadcastStats();
}

function broadcastStats() {
    const all = [...bots.values()];
    const mem = process.memoryUsage();
    const rilksCasesTotal = all.reduce((s,b) => s + (b.rilksCases||0), 0);
    const casesGotTotal   = all.reduce((s,b) => s + (b.casesGot||0), 0);
    io.emit('stats', {
        total:   all.length,
        online:  all.filter(b => b.status === 'online').length,
        offline: all.filter(b => b.status === 'offline' || b.status === 'error').length,
        banned:  all.filter(b => b.status === 'banned').length,
        ram:     Math.round(mem.rss / 1024 / 1024),
        heap:    Math.round(mem.heapUsed / 1024 / 1024),
        cpu:     currentCpu,
        rilksCasesTotal,
        casesGotTotal,
    });
    broadcastRelicsSummary();
}

function sampleCpu() {
    const nowTs  = process.hrtime.bigint();
    const nowU   = process.cpuUsage();
    const elapsedUs = Number(nowTs - cpuSnapshot.ts) / 1000;
    const usedUs = (nowU.user - cpuSnapshot.usage.user) + (nowU.system - cpuSnapshot.usage.system);
    cpuSnapshot  = { ts: nowTs, usage: nowU };
    if (elapsedUs <= 0) return currentCpu;
    currentCpu = Math.max(0, Math.min(100, Math.round((usedUs / (elapsedUs * cpuCoreCount)) * 1000) / 10));
    return currentCpu;
}

// Живая статистика каждые 3 сек
setInterval(() => {
    const mem = process.memoryUsage();
    io.emit('stats:live', {
        ram:  Math.round(mem.rss / 1024 / 1024),
        heap: Math.round(mem.heapUsed / 1024 / 1024),
        cpu:  sampleCpu(),
        bots: [...bots.entries()].map(([id, b]) => ({
            id,
            uptime:    b.connectedAt ? Math.floor((Date.now() - b.connectedAt) / 1000) : 0,
            nextFree:  calcNextFreeMs(b),
            stage:     b.stage,
            riliky:    Number.isFinite(b.riliky) ? b.riliky : null,
        }))
    });
}, LIVE_STATS_INTERVAL_MS);

function calcNextFreeMs(b) {
    if (!b.griefJoinedAt || b.nextFreeIndex >= FREE_REWARDS_MIN.length) return null;
    const target  = FREE_REWARDS_MIN[b.nextFreeIndex] * 60000;
    const elapsed = Date.now() - b.griefJoinedAt;
    return Math.max(0, target - elapsed);
}

// ── Очистка таймеров ─────────────────────────
function createRuntimeState() {
    return {
        connectedAt: null, freeTimer: null, navTimer: null,
        griefJoinedAt: null,
        afkTimer: null, authTimer: null, chunkTimer: null,
        startTimer: null,
        reconnectTimer: null,
        relicsTimer: null,
        antiTimeoutTimer: null,
        pasxaTimer: null,
        riliky: null,
        afkDone: false, nextFreeIndex: 0, collectingFree: false,
        navStarted: false, afkStarted: false,
        pasxaDone: false,
        kitFarmDone: false,
        kitFarmReady: false,
        reconnectAttempts: 0,
        disconnectHandled: false,
        suppressReconnect: false,
        stage: STAGE.OFFLINE,
        auth: { authenticated: false, lastMode: null, lastAt: 0, attempts: { register: 0, login: 0 }, pendingMode: null },
        shopSession: null, shopScanResult: null,
        // Дропы с кейсов
        drops: [],          // [{type, prize, ts}] — последние 30 выбитых наград
        rilksCases: 0,      // сколько riliks-кейсов получено
        casesGot: 0,        // всего кейсов любого типа получено
        _pendingCaseType: null,
    };
}
function cleanupTimers(b) {
    if (!b) return;
    ['freeTimer','navTimer','afkTimer','authTimer','chunkTimer','startTimer','reconnectTimer','relicsTimer','pasxaTimer'].forEach(k => {
        if (b[k]) { clearTimeout(b[k]); b[k] = null; }
    });
    if (b.antiTimeoutTimer) { clearTimeout(b.antiTimeoutTimer); b.antiTimeoutTimer = null; }
}
function resetRuntime(b, { preserveReconnect = false } = {}) {
    const reconnectAttempts = preserveReconnect ? (b.reconnectAttempts || 0) : 0;
    cleanupTimers(b);
    navWindowHandled.delete(b.id);
    Object.assign(b, createRuntimeState(), { reconnectAttempts, suppressReconnect: false, disconnectHandled: false });
}

// ── Парсинг дропов с кейсов ──────────────────
function parseCaseDrop(id, text) {
    const b = bots.get(id);
    if (!b) return;

    // "Кейсы >> Вы получили 1 кейсов типа pasxa2026"
    // "Кейсы >> Вы получили 1 кейсов типа riliks"
    const caseRx = /кейс[ыов]*\s*[»>]+\s*вы\s+получили\s+\d+\s+кейсов?\s+типа\s+(\S+)/iu;
    const caseM  = text.match(caseRx);
    if (caseM) {
        const caseType = caseM[1];
        const isRiliks = /riliks|рилл|рилик/i.test(caseType);
        b._pendingCaseType = caseType;
        b.casesGot = (b.casesGot || 0) + 1;
        if (isRiliks) b.rilksCases = (b.rilksCases || 0) + 1;
        const label = isRiliks ? `${caseType} 🏆` : caseType;
        addLog(id, LOG.SUCCESS, `Кейс получен: ${label}`);
        io.emit('bot:drop', { id, event: 'case_received', caseType, isRiliks, ts: Date.now() });
        broadcastStats();
        return;
    }

    // "Риллики >> Вы получили 250 [R]."
    const riliksRx = /рилл?ик[иа]?\s*[»>]+\s*вы\s+получили\s+([\d\s,.]+)\s*\[?р\]?/iu;
    const riliksM  = text.match(riliksRx);
    if (riliksM) {
        const amount = parseInt(riliksM[1].replace(/[\s,.]/g, '')) || 0;
        if (amount > 0) {
            const drop = { type: b._pendingCaseType || 'riliks', prize: amount + ' R', ts: Date.now() };
            b.drops = [drop, ...(b.drops || [])].slice(0, 30);
            addLog(id, LOG.SUCCESS, `Риллики: +${amount} R 🏆`);
            io.emit('bot:drop', { id, event: 'riliks', ...drop });
            b._pendingCaseType = null;
        }
        return;
    }

    // "Награды >> Вы успешно получили награду." (после /pasxa или открытия кейса)
    if (/награды?\s*[»>]+\s*вы\s+успешно\s+получили\s+награду/iu.test(text)) {
        const drop = { type: b._pendingCaseType || 'кейс', prize: 'награда', ts: Date.now() };
        b.drops = [drop, ...(b.drops || [])].slice(0, 30);
        addLog(id, LOG.SUCCESS, `Награда получена ✓`);
        io.emit('bot:drop', { id, event: 'reward', ...drop });
        b._pendingCaseType = null;
        return;
    }

    // Broadcast-сообщение о выигрыше (видно всем): "Игрок X выиграл 500,000 [R]"
    // Проверяем что это наш бот
    const winRx = /игрок\s+(\S+)\s+выиграл\s+([\d\s,.']+)\s*\[?р\]?/iu;
    const winM  = text.match(winRx);
    if (winM) {
        const winner  = winM[1];
        const amount  = parseInt(winM[2].replace(/[\s,.']/g, '')) || 0;
        if (winner === b.config.username && amount > 0) {
            const drop = { type: b._pendingCaseType || 'кейс', prize: amount + ' R', ts: Date.now() };
            b.drops = [drop, ...(b.drops || [])].slice(0, 30);
            addLog(id, LOG.SUCCESS, `Выиграно: ${amount} R 🎉`);
            io.emit('bot:drop', { id, event: 'win', ...drop });
            b._pendingCaseType = null;
        }
    }
}

// ── Авторизация ──────────────────────────────
function detectAuthIntent(text) {
    if (/(добро пожаловать|welcome)/i.test(text) && !/(login|register|регист|войд)/i.test(text))
        return { mode: 'authenticated' };
    if (/(успешно вош|успешная авторизац|logged in|авторизован|вход выполнен)/i.test(text))
        return { mode: 'authenticated' };
    if (/(already registered|уже зарегистрир)/i.test(text))
        return { mode: 'login', prompt: text };
    if (/(\/register\b|\/reg\b|зарегистрируй|register)/i.test(text) && !/(успешно зарегистр)/i.test(text))
        return { mode: 'register', prompt: text };
    if (/(\/login\b|\/l\b|авторизуй|войдите|login)/i.test(text) && !/(успешно вош|logged in)/i.test(text))
        return { mode: 'login', prompt: text };
    return null;
}
function getAuthPrefix(mode, prompt = '') {
    const l = prompt.toLowerCase();
    if (mode === 'register') return /\/register\b/.test(l) ? '/register' : '/reg';
    return /\/l\b/.test(l) ? '/l' : '/login';
}
function markAuthenticated(id) {
    const b = bots.get(id); if (!b) return;
    b.auth.authenticated = true;
    b.auth.lastMode = 'authenticated';
    b.auth.lastAt   = Date.now();
    if (b.authTimer) { clearTimeout(b.authTimer); b.authTimer = null; }
    addLog(id, LOG.SUCCESS, 'Авторизован');

    // Сразу запускаем навигацию — не ждём таймера из spawn
    if (b.config.autoNav && !b.navStarted) {
        b.navStarted = true;
        if (b.navTimer) { clearTimeout(b.navTimer); b.navTimer = null; }
        b.navTimer = setTimeout(() => {
            doCompassNav(id).catch(e => addLog(id, LOG.ERROR, 'Навигация: ' + e.message));
        }, 800);
    }
}
function scheduleAuth(id, mode, prompt = '', delay = jitter(DEFAULT_AUTH_DELAY_MS)) {
    const b = bots.get(id);
    if (!b?.mc || b.status === 'banned' || b.config.autoAuth === false) return;
    // Уже авторизованы — не нужно повторно отправлять /register или /login
    if (b.auth.authenticated) return;
    const now = Date.now();
    if (b.auth.lastMode === mode && now - b.auth.lastAt < AUTH_RETRY_WINDOW_MS) return;
    if (b.auth.attempts[mode] >= 4) return;
    // Если таймер уже запущен для ТОГО ЖЕ режима — не сбрасываем.
    // Иначе сервер, шлющий несколько сообщений со словом "register" подряд,
    // будет вечно откладывать команду: каждое сообщение сбрасывает таймер.
    if (b.authTimer && b.auth.pendingMode === mode) return;
    if (b.authTimer) clearTimeout(b.authTimer);
    b.auth.pendingMode = mode;
    b.authTimer = setTimeout(() => {
        b.auth.pendingMode = null;
        sendAuth(id, mode, prompt);
    }, delay);
}
function sendAuth(id, mode, prompt = '') {
    const b = bots.get(id);
    if (!b?.mc || b.status === 'banned' || b.config.autoAuth === false) return;
    if (mode === 'login' && b.auth.authenticated) return;
    const prefix = getAuthPrefix(mode, prompt);
    const pass   = b.config.authPassword || b.config.username;
    const cmd    = mode === 'register' ? `${prefix} ${pass} ${pass}` : `${prefix} ${pass}`;
    b.auth.lastMode = mode; b.auth.lastAt = Date.now();
    b.auth.attempts[mode]++;
    b.authTimer = null;
    try {
        b.mc.chat(cmd);
        setStage(id, STAGE.AUTH);
        addLog(id, LOG.ACTION, mode === 'register' ? `Авто-регистрация: ${prefix} ***` : `Авто-логин: ${prefix} ***`);
    } catch(e) { addLog(id, LOG.ERROR, 'Ошибка авторизации: ' + e.message); }
}

// ── Создание бота ────────────────────────────
function createBot(id, config, opts = {}) {
    const b = bots.get(id); if (!b) return;
    resetRuntime(b, opts);
    setRelicsLiveState(id, { live: false, stale: b.relics?.value != null, clearSidebar: true });
    setStage(id, STAGE.CONNECTING);
    addLog(id, LOG.SYSTEM, `Подключаюсь → ${config.host}:${config.port} как ${config.username}`);

    const proxyUrl = config.proxy ? config.proxy.trim() : null;
    let connectOpt = {};
    if (proxyUrl && SocksClient) {
        connectOpt.connect = (client) => {
            let pHost, pPort = 1080, pType = 5, pUser, pPass;
            try {
                let u = proxyUrl;
                if (u.includes('://')) {
                    const url = new URL(u);
                    pType  = url.protocol.startsWith('socks4') ? 4 : 5;
                    pHost  = url.hostname;
                    pPort  = parseInt(url.port) || 1080;
                    pUser  = url.username || undefined;
                    pPass  = url.password || undefined;
                } else {
                    const [h, p] = u.split(':');
                    pHost = h; pPort = parseInt(p) || 1080;
                }
            } catch { pHost = proxyUrl.split(':')[0]; pPort = parseInt(proxyUrl.split(':')[1]) || 1080; }
            SocksClient.createConnection({
                proxy: { host: pHost, port: pPort, type: pType, userId: pUser, password: pPass },
                command: 'connect',
                destination: { host: config.host, port: parseInt(config.port) || 25565 },
            }, (err, info) => {
                if (err) { client.emit('error', err); return; }
                client.setSocket(info.socket);
                client.emit('connect');
            });
        };
    }

    let mc;
    try {
        mc = mineflayer.createBot({
            host:     config.host,
            port:     parseInt(config.port, 10) || 25565,
            username: config.username,
            version:  config.version || '1.20.1',
            auth:     'offline',
            hideErrors: true,
            checkTimeoutInterval: 60000, // 60 с вместо 30 — сервер под нагрузкой может пропускать keepalive
            physicsEnabled: false,
            disableChatSigning: true,   // без подписи чата (1.19+)
            skipValidation: true,       // не валидировать каждый входящий пакет — снижает CPU
            viewDistance: LOW_MEMORY_VIEW_DISTANCE,
            keepAlive: true,
            ...connectOpt,
        });
        // Заглушаем встроенный логгер mineflayer чтобы не спамил в консоль
        try { mc.logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }; } catch {}
        try { if (mc._client?.logger) mc._client.logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }; } catch {}
    } catch(e) {
        addLog(id, LOG.ERROR, 'Не удалось создать: ' + e.message);
        setStage(id, STAGE.ERROR);
        scheduleReconnect(id, e.message);
        return;
    }

    b.mc = mc;

    // Перехватываем исходящий minecraft:brand — подменяем на 'vanilla' до отправки,
    // чтобы сервер не видел 'mineflayer'. Делаем это через обёртку write ОДИН раз,
    // не дублируя пакет.
    {
        const _write = mc._client.write.bind(mc._client);
        mc._client.write = (name, params, ...rest) => {
            if (name === 'custom_payload' && params?.channel === 'minecraft:brand') {
                try {
                    const brand = 'vanilla';
                    const buf = Buffer.alloc(1 + brand.length);
                    buf.writeUInt8(brand.length, 0);
                    buf.write(brand, 1, 'utf8');
                    params = { ...params, data: buf };
                } catch {}
            }
            return _write(name, params, ...rest);
        };
    }

    // Периодически чистим чанки из памяти
    b.chunkTimer = setInterval(() => {
        compactChunks(mc);
    }, S.chunkGcMs);

    // ── БАН: редирект Velocity ────────────────
    mc._client.on('transfer', packet => {
        handleDisconnect(id, mc, {
            logType: LOG.BAN,
            message: `⛔ БАН — редирект на ${packet.host}:${packet.port}`,
            stage: STAGE.BANNED,
            ban: true,
        });
    });

    mc.on('login', () => {
        if (b.mc !== mc) return;
        addLog(id, LOG.SUCCESS, 'Подключился к серверу');
        b.connectedAt = Date.now();
        b.reconnectAttempts = 0;
        b.disconnectHandled = false;
        setStage(id, STAGE.LOBBY);
        scheduleRelicsRefresh(id, 1800);
        // Запускаем keep-alive сразу — до spawn, чтобы фаза авторизации не таймаутила
        startAntiTimeout(id, mc);
    });

    mc.on('spawn', () => {
        if (b.mc !== mc) return;
        addLog(id, LOG.INFO, 'Заспавнился');
        // Отключаем физику принудительно после спауна — исключает автоотправку
        // position-пакетов (20/с) пока бот не двигается намеренно
        mc.physicsEnabled = false;
        startAntiTimeout(id, mc);
        const cur = bots.get(id); if (!cur) return;

        if (config.autoAuth !== false) {
            // Авторизуемся только если ещё не вошли.
            // На Velocity/BungeeCord spawn стреляет при КАЖДОМ переходе между серверами —
            // если бот уже авторизован на proxy1 и попал на grief-сервер, повторный
            // /register туда отправлять не нужно.
            if (!cur.auth.authenticated) {
                scheduleAuth(id, 'register');
            }
        } else {
            // Без авторизации: навигацию и AFK запускаем сразу
            if (config.autoNav && !cur.navStarted) {
                cur.navStarted = true;
                b.navTimer = setTimeout(() => {
                    doCompassNav(id).catch(e => addLog(id, LOG.ERROR, 'Навигация: ' + e.message));
                }, 800);
            }
            if (config.autoAfk && !cur.afkStarted) {
                cur.afkStarted = true;
                b.afkTimer = setTimeout(() => {
                    goAfk(id).catch(e => addLog(id, LOG.ERROR, 'AFK: ' + e.message));
                }, 2000);
            }
        }
        scheduleRelicsRefresh(id, 1200);
        scheduleRelicsRefresh(id, 3500);
    });

    mc.on('message', msg => {
        if (b.mc !== mc) return;
        const text = msg.toString().trim();
        if (!text) return;
        const isSystem = /login|register|добро пожаловать|welcome|free|награда|warp|afk|авториз|регист/i.test(text);
        if (isSystem) addLog(id, LOG.SYSTEM, text);
        // Парсим дропы кейсов
        parseCaseDrop(id, text);
        // Авторизация
        const intent = detectAuthIntent(text);
        if (!intent) return;
        if (intent.mode === 'authenticated') { markAuthenticated(id); return; }
        // Бот уже авторизован — сервер прислал сообщение с упоминанием /register или /login
        // (приветствие, подсказка, ответ на команду). Это «фантомный» триггер на grief-сервере
        // после перехода с прокси. Просто игнорируем.
        const cur2 = bots.get(id);
        if (cur2?.auth?.authenticated) return;
        scheduleAuth(id, intent.mode, intent.prompt || '');
    });

    mc.on('windowOpen', async window => {
        if (b.mc !== mc) return;
        const cur = bots.get(id); if (!cur) return;
        addLog(id, LOG.ACTION, `Окно: "${window.title}" (${window.slots.length} сл.)`);
        if (cur.collectingFree && cur.config.autoFree !== false) {
            await collectFreeRewards(id, window);
            return;
        }
        // Навигационные меню нужны только пока бот НЕ добрался до гриф-сервера.
        // На SERVER/AFK/FARMING стадии любое открытое окно — игровое (сундук, шалкер,
        // /free и т.п.), трогать его handleNavWindow нельзя — это ведёт к двойным кликам
        // и кику сервером.
        if (cur.config.autoNav &&
            cur.stage !== STAGE.SERVER &&
            cur.stage !== STAGE.AFK &&
            cur.stage !== STAGE.FARMING) {
            await handleNavWindow(id, window);
        }
    });

    // Ловим низкоуровневый пакет открытия окна (на случай если mineflayer пропускает)
    mc._client.on('open_window', packet => {
        if (b.mc !== mc) return;
        const cur = bots.get(id); if (!cur) return;
        const rawTitle = packet.windowTitle || packet.title || '';
        addLog(id, LOG.INFO, `[raw] open_window id=${packet.windowId} title=${rawTitle}`);
    });

    const queueRelicsRefresh = (delay = 80) => {
        if (b.mc !== mc) return;
        scheduleRelicsRefresh(id, delay);
    };

    mc.on('scoreboardCreated', () => queueRelicsRefresh(80));
    mc.on('scoreboardDeleted', () => queueRelicsRefresh(40));
    mc.on('scoreboardTitleChanged', () => queueRelicsRefresh(50));
    mc.on('scoreUpdated', () => queueRelicsRefresh(50));
    mc.on('scoreRemoved', () => queueRelicsRefresh(50));
    mc.on('scoreboardPosition', () => queueRelicsRefresh(20));
    mc._client.on('scoreboard_score', () => queueRelicsRefresh(25));
    mc._client.on('scoreboard_objective', () => queueRelicsRefresh(25));
    mc._client.on('scoreboard_display_objective', () => queueRelicsRefresh(25));

    mc.on('kicked', reason => {
        let text = '';
        try { text = extractText(JSON.parse(reason)); } catch { text = reason; }
        const isBan      = /ban|заблокир|banned/i.test(text);
        const isIpBlock  = /не прошел проверку|не прошёл проверку|список зараженных|зараженных/i.test(text);
        const isThrottle = /throttl|слишком много|too many|connection.*limit|connect.*fast/i.test(text);
        // При throttle сбрасываем счётчик попыток — иначе экспоненциальный backoff
        // вырастает до 60 сек, хотя throttle-окно на сервере 4–10 сек.
        // Фиксируем задержку ~5 сек (первая попытка reconnect) вместо роста.
        if (isThrottle) {
            const bThrottle = bots.get(id);
            if (bThrottle) bThrottle.reconnectAttempts = 0;
        }
        handleDisconnect(id, mc, {
            logType: (isBan || isIpBlock) ? LOG.BAN : LOG.WARN,
            message: isIpBlock
                ? `IP заблокирован сервером (реконнект остановлен)`
                : isBan
                ? `Бан: ${text}`
                : isThrottle
                ? `⚠️ Throttle — реконнект через 5 сек`
                : `Кикнут: ${text}`,
            stage: isBan ? STAGE.BANNED : STAGE.OFFLINE,
            ban: isBan,
            stopReconnect: isIpBlock,
            reconnectReason: text,
        });
    });

    mc.on('error', e => {
        // ECONNREFUSED / ECONNRESET обычно = per-IP лимит или throttle сервера.
        // Сбрасываем счётчик чтобы не уходить в экспоненциальный backoff (60 сек).
        const isConnRefused = /ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH/i.test(e.message);
        if (isConnRefused) {
            const bErr = bots.get(id);
            if (bErr) bErr.reconnectAttempts = 0;
        }
        handleDisconnect(id, mc, {
            logType: LOG.ERROR,
            message: e.message,
            stage: STAGE.ERROR,
            reconnectReason: e.message,
        });
    });

    mc.on('end', () => {
        // Если бот не успел залогиниться (b.connectedAt == null) — скорее всего
        // сервер сбросил соединение из-за per-IP лимита. Сбрасываем backoff.
        const bEnd = bots.get(id);
        if (bEnd && !bEnd.connectedAt) bEnd.reconnectAttempts = 0;
        handleDisconnect(id, mc, {
            logType: LOG.SYSTEM,
            message: 'Соединение закрыто',
            stage: STAGE.OFFLINE,
            reconnectReason: 'соединение закрыто',
        });
    });
}

// ── Навигация ─────────────────────────────────
async function doCompassNav(id) {
    const b = bots.get(id); if (!b?.mc) return;
    const mc = b.mc;

    // Ищем любой предмет в хотбаре (слоты 36-44).
    // Сервер может дать предметы с задержкой — ждём до 4 секунд.
    let hotbarSlot = null;
    for (let attempt = 0; attempt < 5; attempt++) {
        if (bots.get(id)?.mc !== mc) return; // реконнект
        // Слоты 36-44 — хотбар в порядке инвентаря mineflayer
        for (let i = 36; i <= 44; i++) {
            const s = mc.inventory.slots[i];
            if (s && s.type > 0 && s.name !== 'air') { hotbarSlot = i; break; }
        }
        if (hotbarSlot !== null) break;
        addLog(id, LOG.INFO, `Хотбар пуст (попытка ${attempt + 1}/5), жду предметы...`);
        await sleep(800);
    }

    if (hotbarSlot === null) {
        addLog(id, LOG.WARN, 'Хотбар пуст после ожидания — навигация отложена');
        // Пробуем ещё раз через 5 секунд
        const cur = bots.get(id);
        if (cur?.mc === mc && cur.navStarted) {
            cur.navStarted = false; // сбрасываем флаг чтобы markAuthenticated мог запустить ещё раз
            cur.navTimer = setTimeout(() => {
                if (bots.get(id)?.mc === mc) doCompassNav(id).catch(() => {});
            }, 5000);
        }
        return;
    }

    if (bots.get(id)?.mc !== mc) return;
    const item = mc.inventory.slots[hotbarSlot];
    try {
        await mc.equip(item, 'hand');
        addLog(id, LOG.ACTION, `Взял: ${item.name} (слот ${hotbarSlot})`);
        await sleep(500);
        mc.activateItem();
        addLog(id, LOG.ACTION, 'ПКМ — открываю меню');
    } catch(e) {
        addLog(id, LOG.WARN, 'Ошибка nav: ' + e.message);
    }
}

async function handleNavWindow(id, window) {
    const b = bots.get(id);
    if (!b?.mc || navWindowHandled.has(id)) return;
    navWindowHandled.add(id);
    try {
        const rawTitle = window?.title || b.mc.currentWindow?.title || '';
        const titleText = extractText(typeof rawTitle === 'string' ? (() => { try { return JSON.parse(rawTitle); } catch { return rawTitle; } })() : rawTitle);

        // Меню "Выбор сервера" — кликаем слот 22 (crafting_table = Гриферское выживание)
        if (/выбор сервера/i.test(titleText)) {
            navWindowHandled.delete(id);
            // сразу отменяем AFK чтобы не мешал навигации
            if (b.afkTimer) { clearTimeout(b.afkTimer); b.afkTimer = null; }
            await sleep(800);
            const slots = window.slots || [];
            slots.forEach((s, i) => { if (s && s.name !== 'air') addLog(id, LOG.INFO, `  слот ${i}: ${s.name}`); });
            await b.mc.clickWindow(22, 0, 0);
            addLog(id, LOG.ACTION, 'Выбор сервера → Гриферское выживание (слот 22)');
            return;
        }

        // Меню "Выбор мира грифа"
        if (/выбор мира грифа/i.test(titleText)) {
            const griefWorld = b.config.griefWorld || 1;
            const slotMap = { 1: 11, 2: 12, 3: 13, 4: 14, 5: 15 };
            const slot = slotMap[griefWorld] || 11;
            await sleep(800);
            await b.mc.clickWindow(slot, 0, 0);
            addLog(id, LOG.ACTION, `Выбор мира грифа → Гриф #${griefWorld} (слот ${slot})`);
            markEnteredGrief(id);
            setStage(id, STAGE.SERVER);
            scheduleWorldCompaction(id);
            // на грифе навигация не нужна, только AFK
            b.navStarted = true;
            b.afkStarted = false;
            b.afkDone    = false;
            navWindowHandled.delete(id);
            return;
        }

        // Неизвестное меню — ничего не делаем, просто логируем.
        // Раньше здесь был фолбэк с clickWindow(22), который кликал слот 22
        // в любом окне (шалкер, сундук и т.п.) → двойной клик → кик сервером.
        addLog(id, LOG.INFO, `Неизвестное навигационное меню: "${titleText}" — пропускаю`);
        navWindowHandled.delete(id);
    } catch(e) {
        addLog(id, LOG.ERROR, 'Клик меню: ' + e.message);
        navWindowHandled.delete(id); // сбрасываем чтобы можно было повторить
    }
}

// ── AFK ──────────────────────────────────────
async function goAfk(id) {
    const b = bots.get(id);
    if (!b?.mc || b.afkDone) return;
    const mc  = b.mc;
    addLog(id, LOG.ACTION, '/warp afk — иду в афк-пул');
    try {
        const startPos = mc.entity?.position?.clone?.();
        mc.chat('/warp afk');
        // ждём телепорт по факту смещения или по сообщению чата
        const warped = await Promise.race([
            waitWarp(mc, S.warpTimeoutMs),
            waitChatMsg(mc, /телепортир|варп|warp|afk/i, S.warpTimeoutMs).then(m => !!m),
        ]);
        if (!warped) addLog(id, LOG.WARN, '/warp afk — телепорт не подтверждён, идём дальше');
        await sleep(200);
        mc.physicsEnabled = true;
        const walked = await walkForward(mc, S.afkWalkMs);
        b.afkDone = true;
        setStage(id, STAGE.AFK);
        addLog(id, LOG.SUCCESS, `В афк-пуле, прошёл ${walked.toFixed(1)} блока`);
        scheduleWorldCompaction(id);
    } finally {
        mc.setControlState('forward', false);
        mc.setControlState('sprint', false);
        mc.physicsEnabled = false;
    }
}
function hDist(a, b) {
    if (!a||!b) return 0;
    const dx=(a.x||0)-(b.x||0), dz=(a.z||0)-(b.z||0);
    return Math.sqrt(dx*dx+dz*dz);
}
async function waitTeleport(mc, startPos, timeout) {
    if (!mc?.entity||!startPos) { await sleep(2500); return false; }
    const t0 = Date.now();
    while (Date.now()-t0 < timeout) {
        const p = mc.entity.position;
        if (hDist(p,startPos)>=2 || Math.abs((p?.y||0)-(startPos?.y||0))>=1) return true;
        await sleep(250);
    }
    return false;
}
async function walkForward(mc, dur) {
    const start = mc.entity?.position?.clone?.(); if (!start) return 0;
    mc.setControlState('sprint', true);
    mc.setControlState('forward', true);
    await sleep(dur);
    mc.setControlState('forward', false);
    mc.setControlState('sprint', false);
    await sleep(250);
    return hDist(mc.entity?.position, start);
}

// ── Анти-таймаут: лёгкий keep-alive через _client.write('keep_alive') ──────
// Запускаем сразу после login (ещё до spawn), чтобы не получить 30-секундный
// таймаут во время фазы авторизации. Интервал — каждые 15-25 секунд.
function startAntiTimeout(id, mc) {
    const b = bots.get(id);
    if (!b || b.antiTimeoutTimer) return;
    b._atBaseYaw = mc.entity?.yaw ?? 0;
    b._atDir = 1;

    const tick = () => {
        const cur = bots.get(id);
        if (!cur?.mc || cur.mc !== mc) return;
        try {
            // Если уже заспавнились — делаем миниатюрный поворот (выглядит как живой игрок)
            const e = cur.mc.entity;
            if (e && cur.status === 'online') {
                const deg = (0.02 + Math.random() * 0.02) * cur._atDir;
                cur._atDir *= -1;
                cur.mc.look(cur._atBaseYaw + deg, e.pitch ?? 0, false);
            }
        } catch {}
        // 15-25 секунд — гарантированно меньше checkTimeoutInterval (60 с)
        const delay = 15000 + Math.floor(Math.random() * 10000);
        const t = setTimeout(tick, delay);
        try { t.unref?.(); } catch {}
        cur.antiTimeoutTimer = t;
    };

    // Первый тик через 10-18 с — сразу после login чтобы перекрыть 30-секундный лаг
    const firstDelay = 10000 + Math.floor(Math.random() * 8000);
    const t0 = setTimeout(tick, firstDelay);
    try { t0.unref?.(); } catch {}
    b.antiTimeoutTimer = t0;
}

// ── Награды /free ─────────────────────────────
function tryStartKitFarm(id) {
    const b = bots.get(id);
    if (!b?.mc || b.status !== 'online' || !b.config.kitFarm || b.kitFarmDone) return;
    if (!b.griefJoinedAt) return;
    const isOwnerBot = b.config.kitFarmRegionOwner &&
        b.config.username.toLowerCase() === b.config.kitFarmRegionOwner.toLowerCase();
    if (isOwnerBot) {
        doOwnerSetup(id).catch(e => addLog(id, LOG.ERROR, 'OwnerSetup: ' + e.message));
    } else if (b.kitFarmReady) {
        doKitFarm(id).catch(e => addLog(id, LOG.ERROR, 'KitFarm: ' + e.message));
    }
}

function markEnteredGrief(id) {
    const b = bots.get(id);
    if (!b || b.griefJoinedAt) return;
    b.griefJoinedAt = Date.now();
    if (b.config.autoFree  !== false) scheduleRewards(id);
    if (b.config.autoPasxa !== false) schedulePasxa(id);

    // AFK — запускаем сразу после входа на гриф, а не через 20 сек от спауна
    if (b.config.autoAfk && !b.afkStarted) {
        b.afkStarted = true;
        if (b.afkTimer) { clearTimeout(b.afkTimer); b.afkTimer = null; }
        b.afkTimer = setTimeout(() => {
            goAfk(id).catch(e => addLog(id, LOG.ERROR, 'AFK: ' + e.message));
        }, 500);
    }

    setTimeout(() => tryStartKitFarm(id), 500);
}

// Овнер-бот прописывает всех остальных ботов и запускает их подключение
async function doOwnerSetup(id) {
    const b = bots.get(id);
    if (!b?.mc || b.status !== 'online') return;
    const mc = b.mc;
    const regionName = b.config.kitFarmRegion || 'ikump';

    // Все kitFarm-боты кроме себя которые ещё не готовы
    const targets = [...bots.values()].filter(other =>
        other.id !== id &&
        other.config.kitFarm &&
        !other.kitFarmDone &&
        !other.kitFarmReady   // ещё не прописаны
    );

    addLog(id, LOG.ACTION, `Овнер: прописываю ${targets.length} ботов в регион "${regionName}"`);

    for (const target of targets) {
        const cmd = `/rg addowner -w "world" ${regionName} ${target.config.username}`;
        addLog(id, LOG.ACTION, cmd);
        mc.chat(cmd);

        // ждём подтверждение от сервера (или таймаут 3 сек)
        const resp = await waitChatMsg(mc, /addowner|добавлен|добавлено|owner|region|регион/i, 3000);
        if (resp) addLog(id, LOG.SUCCESS, `RG ответ: ${resp}`);
        else      addLog(id, LOG.WARN,    `RG: нет ответа для ${target.config.username} — продолжаю`);

        await sleep(jitter(300));

        // Помечаем как готового
        target.kitFarmReady = true;

        if (target.griefJoinedAt && target.mc && target.status === 'online') {
            // Бот уже на грифе — сразу запускаем kitFarm
            tryStartKitFarm(target.id);
        } else {
            // Бот ещё не на грифе — запускаем подключение
            queueBotStart(target.id, 0);
        }
        addLog(target.id, LOG.SYSTEM, `Добавлен в регион "${regionName}" — подключаюсь...`);
    }

    addLog(id, LOG.SUCCESS, 'Все боты прописаны, запускаю свой KitFarm');
    await doKitFarm(id);
}
function scheduleRewards(id) {
    const b = bots.get(id);
    if (!b || b.config.autoFree === false || !b.griefJoinedAt) return;
    if (b.freeTimer) {
        clearTimeout(b.freeTimer);
        b.freeTimer = null;
    }
    b.nextFreeIndex = 0;
    setStage(id, b.stage === STAGE.AFK ? STAGE.AFK : STAGE.FARMING);
    scheduleNextReward(id);
}
function scheduleNextReward(id) {
    const b = bots.get(id);
    if (!b || b.config.autoFree === false || !b.griefJoinedAt || b.nextFreeIndex >= S.freeRewardsMin.length) return;
    const targetMin = S.freeRewardsMin[b.nextFreeIndex];
    const elapsed   = (Date.now()-b.griefJoinedAt)/60000;
    const waitMs    = Math.max(0, (targetMin-elapsed)*60000);
    addLog(id, LOG.INFO, `Следующая /free через ${Math.round(waitMs/60000)} мин (${targetMin} мин)`);
    b.freeTimer = setTimeout(async () => {
        const cur = bots.get(id);
        if (!cur?.mc || cur.status !== 'online' || cur.config.autoFree === false) return;
        addLog(id, LOG.ACTION, `/free → забираю награду за ${targetMin} мин`);
        cur.collectingFree = true;
        cur.mc.chat('/free');
        // collectFreeRewards (вызывается из windowOpen) сам сделает increment + reschedule
        // fallback: если окно не открылось за 7с
        await sleep(7000);
        if (cur.collectingFree) {
            cur.collectingFree = false;
            addLog(id, LOG.WARN, '/free — меню не открылось, пропускаю');
            cur.nextFreeIndex++;
            scheduleNextReward(id);
        }
    }, waitMs);
}
// Декоративные блоки GUI — кликать их бесполезно
const FREE_DECO_ITEMS = new Set([
    'air', 'gray_stained_glass_pane', 'black_stained_glass_pane',
    'white_stained_glass_pane', 'light_gray_stained_glass_pane',
]);

async function collectFreeRewards(id, window) {
    const b = bots.get(id); if (!b?.mc) return;
    const mc = b.mc;
    const size  = window.slots.length;
    // Собираем ВСЕ не-декоративные слоты (обычно это все награды за визит)
    const slots = [];
    for (let i = 0; i < size; i++) {
        const s = window.slots[i];
        if (s && !FREE_DECO_ITEMS.has(s.name)) slots.push(i);
    }
    if (!slots.length) {
        addLog(id, LOG.WARN, `Меню /free (${size} сл.) — нет наград`);
    } else {
        addLog(id, LOG.ACTION, `Меню /free (${size} сл.) — кликаю ${slots.length} слотов`);
        let collected = 0;
        for (const slot of slots) {
            if (bots.get(id)?.mc !== mc) break; // реконнект во время сбора
            try {
                await sleep(S.freeSlotDelayMs);
                await mc.clickWindow(slot, 0, 0);
                collected++;
            } catch(e) {
                addLog(id, LOG.ERROR, `Клик ${slot}: ` + e.message);
            }
        }
        if (collected > 0) addLog(id, LOG.SUCCESS, `Награды /free ✓ (${collected}/${slots.length})`);
    }
    await sleep(300);
    try { if (b.mc && b.mc === mc) b.mc.closeWindow(window); } catch {}
    b.collectingFree = false;
    b.nextFreeIndex++;
    scheduleWorldCompaction(id, 1500);
    scheduleNextReward(id);
}

// ── KIT FARM ─────────────────────────────────
// Предметы еды которые нужно выложить в сундук
const KIT_FARM_FOOD_ITEMS = new Set([
    'golden_apple',
    'enchanted_golden_apple',
    'golden_carrot',
    'gold_block',
    'chorus_fruit',
    'totem_of_undying',
]);
const KIT_FARM_KITS = ['dragon', 'imperator', 'pluspro'];

async function doKitFarm(id) {
    const b = bots.get(id);
    if (!b?.mc || b.status !== 'online' || b.kitFarmDone) return;
    b.kitFarmDone = true;
    const mc = b.mc;

    try {
        // 1. Телепорт на /warp mamka
        await sleep(500); // дать серверу зарегистрировать бота после входа
        addLog(id, LOG.ACTION, '/warp mamka');
        mc.chat('/warp mamka');
        const warped = await waitWarp(mc, 9000);
        if (!warped) addLog(id, LOG.WARN, '/warp mamka — телепорт не подтверждён, продолжаем');
        await sleep(jitter(300));

        // 2. Берём киты с повтором при кулдауне (до 3 попыток)
        for (const kit of KIT_FARM_KITS) {
            let attempts = 0;
            while (attempts < 3) {
                attempts++;
                addLog(id, LOG.ACTION, `/kit ${kit} (попытка ${attempts})`);
                mc.chat(`/kit ${kit}`);
                const resp = await waitChatMsg(mc, /kit|кит|получ|cooldown|кулдаун|подожди|wait|через|through/i, 3000);
                if (!resp) break; // нет ответа — считаем успехом
                if (/cooldown|кулдаун|подожди|wait|через/i.test(resp)) {
                    // пытаемся вытащить секунды из сообщения
                    const secMatch = resp.match(/(\d+)\s*с/);
                    const waitSec  = secMatch ? parseInt(secMatch[1]) * 1000 + 500 : 5000;
                    addLog(id, LOG.WARN, `/kit ${kit} кулдаун — жду ${Math.round(waitSec/1000)}с`);
                    await sleep(waitSec);
                } else {
                    break; // успешно или другой ответ
                }
            }
            await sleep(jitter(300));
        }

        // 3. Ищем ближайший сундук и выкладываем предметы
        await sleep(jitter(300));
        const chestPos = findNearestChest(mc);
        if (!chestPos) {
            addLog(id, LOG.WARN, 'Сундук не найден рядом (радиус 10) — пропускаю выгрузку');
        } else {
            addLog(id, LOG.ACTION, `Открываю сундук на ${chestPos}`);
            try {
                const chestBlock = mc.blockAt(chestPos);
                const container = await mc.openContainer(chestBlock);
                await sleep(200);
                await dumpFoodToChest(id, container);
                await sleep(100);
                container.close();
                await sleep(150);
            } catch(e) {
                addLog(id, LOG.ERROR, `Ошибка открытия сундука: ${e.message}`);
            }
        }

        // 4. Выходим с сервера
        addLog(id, LOG.ACTION, 'KitFarm завершён — выхожу');
        mc.quit();
    } catch(e) {
        addLog(id, LOG.ERROR, 'KitFarm ошибка: ' + e.message);
        b.kitFarmDone = false; // разрешаем повтор при реконнекте
    }
}

function findNearestChest(mc) {
    const pos = mc.entity?.position;
    if (!pos) return null;
    const chestNames = new Set(['chest', 'trapped_chest', 'barrel']);
    const blocks = mc.findBlocks({
        matching: block => block && chestNames.has(block.name),
        maxDistance: 10,
        count: 20,
    });
    if (!blocks.length) return null;
    let nearest = null;
    let nearestDist = Infinity;
    for (const bp of blocks) {
        const dx = bp.x - pos.x, dy = bp.y - pos.y, dz = bp.z - pos.z;
        const dist = Math.sqrt(dx*dx + dy*dy + dz*dz);
        if (dist < nearestDist) { nearestDist = dist; nearest = bp; }
    }
    return nearest;
}

async function dumpFoodToChest(id, container) {
    const b = bots.get(id); if (!b?.mc) return;
    const mc = b.mc;
    let dumped = 0;
    const items = mc.inventory.items().filter(item => KIT_FARM_FOOD_ITEMS.has(item.name));
    if (!items.length) {
        addLog(id, LOG.WARN, 'Нечего выкладывать — нужные предметы не найдены');
        return;
    }
    for (const item of items) {
        try {
            await container.deposit(item.type, null, item.count);
            addLog(id, LOG.SUCCESS, `Выложил ${item.name} x${item.count}`);
            dumped++;
            await sleep(250);
        } catch(e) {
            addLog(id, LOG.WARN, `Не смог выложить ${item.name}: ${e.message}`);
        }
    }
    addLog(id, LOG.INFO, `Итого выложено: ${dumped} стаков`);
}
async function doPasxa(id) {
    const b = bots.get(id);
    if (!b?.mc || b.status !== 'online' || b.pasxaDone) return;
    addLog(id, LOG.ACTION, '/pasxa — открываю меню наград');
    try {
        b.mc.chat('/pasxa');
        const window = await new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                b.mc?.removeListener('windowOpen', onWindow);
                reject(new Error('Окно /pasxa не открылось'));
            }, 5000);
            function onWindow(win) { clearTimeout(timer); resolve(win); }
            b.mc.once('windowOpen', onWindow);
        });

        // Ищем первый кликабельный слот (не стекло, не воздух)
        const slotIndex = window.slots.findIndex(s =>
            s && s.name !== 'air' &&
            !s.name.includes('stained_glass') &&
            s.name !== 'glass_pane' && s.name !== 'glass'
        );

        addLog(id, LOG.ACTION, `Окно "${window.title}" (${window.slots.length} сл.) — слот ${slotIndex}`);

        if (slotIndex < 0) {
            addLog(id, LOG.WARN, '/pasxa: наград нет (требуется 1 час на сервере?)');
            try { b.mc.closeWindow(window); } catch {}
            return;
        }

        await sleep(250);
        await b.mc.clickWindow(slotIndex, 0, 0);
        addLog(id, LOG.SUCCESS, 'Пасхальный кейс получен ✓');
        b.pasxaDone = true;
        await sleep(200);
        try { b.mc.closeWindow(window); } catch {}
        scheduleWorldCompaction(id, 1500);
    } catch(e) {
        addLog(id, LOG.ERROR, 'ПАСХА: ' + e.message);
    }
}

const PASXA_REQUIRED_MIN = 60;

function schedulePasxa(id) {
    const b = bots.get(id);
    if (!b || b.config.autoPasxa === false || !b.griefJoinedAt || b.pasxaDone) return;
    if (b.pasxaTimer) { clearTimeout(b.pasxaTimer); b.pasxaTimer = null; }
    const elapsed = (Date.now() - b.griefJoinedAt) / 60000;
    const waitMs  = Math.max(0, (PASXA_REQUIRED_MIN - elapsed) * 60000);
    addLog(id, LOG.INFO, waitMs > 5000
        ? `/pasxa через ${Math.round(waitMs / 60000)} мин (нужен 1 час)`
        : '/pasxa — пробую забрать...'
    );
    b.pasxaTimer = setTimeout(() => {
        const cur = bots.get(id);
        if (!cur?.mc || cur.status !== 'online' || cur.pasxaDone) return;
        cur.pasxaTimer = null;
        doPasxa(id).catch(e => addLog(id, LOG.ERROR, 'Авто-пасха: ' + e.message));
    }, waitMs);
    b.pasxaTimer?.unref?.();
}

// ── Открыть кейс с риликами ──────────────────
// Маршрут: /warp case → налево 90° → 6 блоков → направо 90° → 5 блоков → шалкер
// Логика: открываем шалкер спамом ПКМ → кликаем все кейсы → если выкинуло из меню →
//         снова открываем шалкер → повторяем до тех пор, пока шалкер не опустеет
async function doOpenCase(id) {
    const b = bots.get(id);
    if (!b?.mc || b.status !== 'online') return;
    const mc = b.mc;
    addLog(id, LOG.ACTION, '🏆 Рилики: /warp case → иду к шалкеру');

    try {
        // 1. Варп
        mc.chat('/warp case');
        const warped = await waitWarp(mc, S.warpTimeoutMs);
        if (!warped) addLog(id, LOG.WARN, '/warp case: телепорт не подтверждён, продолжаем');
        await sleep(800);

        // 2. Маршрут: налево 90° → 6 блоков → направо 90° → 5 блоков
        const initialYaw = mc.entity?.yaw ?? 0;
        mc.physicsEnabled = true;
        mc.setControlState('sprint', true);

        // Повернуть налево 90° и пройти 6 блоков
        mc.look(initialYaw - Math.PI / 2, 0, true);
        await sleep(250);
        mc.setControlState('forward', true);
        await sleep(1150);   // ~6 блоков вперёд (спринт ~5.2 бл/с)
        mc.setControlState('forward', false);
        await sleep(150);

        // Повернуть направо 90° (возврат к initialYaw) и пройти 5 блоков
        mc.look(initialYaw, 0, true);
        await sleep(250);
        mc.setControlState('forward', true);
        await sleep(970);    // ~5 блоков вперёд
        mc.setControlState('forward', false);
        mc.setControlState('sprint', false);
        mc.physicsEnabled = false;
        await sleep(300);

        // 3. Вспомогательная функция поиска шалкера
        const findShulker = () => {
            const blk = mc.findBlock({
                matching: bl => bl && (bl.name === 'shulker_box' || bl.name?.includes('shulker')),
                maxDistance: 4,
            });
            if (blk) return { type: 'block', ref: blk };
            const pos = mc.entity?.position;
            const ent = pos && Object.values(mc.entities).find(e =>
                (e.name === 'shulker' || e.type === 'shulker') &&
                Math.hypot(e.position.x - pos.x, e.position.z - pos.z) < 5
            );
            if (ent) return { type: 'entity', ref: ent };
            return null;
        };

        // 4. Открыть шалкер (спам ПКМ до windowOpen, макс 8 сек)
        const openShulker = () => new Promise((resolve, reject) => {
            let done = false;
            const deadline = setTimeout(() => {
                clearInterval(spamIv);
                mc.removeListener('windowOpen', onWin);
                if (!done) reject(new Error('Шалкер не открылся за 8 сек'));
            }, 8000);
            const onWin = (w) => {
                done = true; clearInterval(spamIv); clearTimeout(deadline);
                mc.removeListener('windowOpen', onWin);
                resolve(w);
            };
            mc.on('windowOpen', onWin);
            const spamIv = setInterval(async () => {
                if (done) return;
                try {
                    const t = findShulker();
                    if (t?.type === 'block') await mc.activateBlock(t.ref);
                    else if (t?.type === 'entity') await mc.activateEntityAt(t.ref);
                } catch {}
            }, 300);
            // первый клик сразу
            (async () => {
                try {
                    const t = findShulker();
                    if (t?.type === 'block') await mc.activateBlock(t.ref);
                    else if (t?.type === 'entity') await mc.activateEntityAt(t.ref);
                    else addLog(id, LOG.WARN, 'Шалкер не найден рядом — жду...');
                } catch {}
            })();
        });

        // Декоративные предметы — не кейсы
        const isDeco = s => !s || s.name === 'air' ||
            s.name?.includes('stained_glass') || s.name === 'glass_pane' || s.name === 'glass';

        // 5. Основной цикл: открываем шалкер → кликаем всё → переоткрываем если выкинуло
        let totalClicked = 0;
        let iterations   = 0;
        const MAX_ITERS  = 60; // защита от бесконечного цикла

        while (bots.get(id)?.mc === mc && b.status === 'online' && iterations < MAX_ITERS) {
            iterations++;
            addLog(id, LOG.ACTION, `Открываю шалкер (итерация ${iterations})...`);

            let win;
            try {
                win = await openShulker();
            } catch(e) {
                addLog(id, LOG.WARN, `Шалкер: ${e.message} — выход`);
                break;
            }
            await sleep(200);

            // Собираем слоты с кейсами (не декор)
            const slots = [];
            for (let i = 0; i < win.slots.length; i++) {
                if (!isDeco(win.slots[i])) slots.push(i);
            }

            if (slots.length === 0) {
                addLog(id, LOG.SUCCESS, `🏆 Шалкер пуст — открыто итого: ${totalClicked}`);
                try { mc.closeWindow(win); } catch {}
                break;
            }

            addLog(id, LOG.ACTION, `Шалкер: ${slots.length} кейс(ов) — кликаю`);

            // Кликаем все слоты с кейсами
            let kickedFromMenu = false;
            for (const slot of slots) {
                if (!mc.currentWindow) { kickedFromMenu = true; break; }

                try {
                    await mc.clickWindow(slot, 0, 0);
                    totalClicked++;
                    await sleep(jitter(250));

                    // Ожидаем sub-окно результата (если сервер его открывает)
                    const sub = await new Promise(resolve => {
                        const t = setTimeout(() => resolve(null), 1200);
                        const onSub = (w) => { clearTimeout(t); mc.removeListener('windowOpen', onSub); resolve(w); };
                        mc.once('windowOpen', onSub);
                    });
                    if (sub) {
                        addLog(id, LOG.SUCCESS, `Кейс #${totalClicked} ✓ (${sub.title})`);
                        await sleep(jitter(150));
                        try { mc.closeWindow(sub); } catch {}
                        await sleep(jitter(150));
                    } else {
                        addLog(id, LOG.SUCCESS, `Кейс #${totalClicked} ✓`);
                    }

                    if (!mc.currentWindow) { kickedFromMenu = true; break; }
                } catch(e) {
                    if (!mc.currentWindow) { kickedFromMenu = true; break; }
                    addLog(id, LOG.WARN, `clickWindow слот ${slot}: ${e.message}`);
                }
            }

            // Закрываем окно если ещё открыто
            if (mc.currentWindow) {
                try { mc.closeWindow(mc.currentWindow); } catch {}
            }

            if (kickedFromMenu) {
                addLog(id, LOG.ACTION, 'Выкинуло из меню — переоткрываю шалкер');
                await sleep(jitter(500));
            } else {
                await sleep(jitter(300));
            }

            if (!bots.get(id)?.mc || bots.get(id).status !== 'online') break;
        }

        scheduleWorldCompaction(id, 1500);
        addLog(id, LOG.INFO, `🏆 Рилики завершены: открыто ${totalClicked} кейс(ов)`);

    } catch(e) {
        addLog(id, LOG.ERROR, 'doOpenCase: ' + e.message);
    }
}

// ── Пасха + открыть кейс ─────────────────────
async function doPasxaCase(id) {
    await doPasxa(id);
    await sleep(600);
    await doOpenCase(id);
}

// ── Принудительная пасха (без проверки часа и pasxaDone) ──
async function doPasxaForce(id) {
    const b = bots.get(id);
    if (!b?.mc || b.status !== 'online') return;
    b.pasxaDone = false; // сбрасываем флаг чтобы doPasxa сработал
    await doPasxa(id);
}
async function doPasxaCaseForce(id) {
    await doPasxaForce(id);
    await sleep(600);
    await doOpenCase(id);
}

// ── Выбросить инвентарь (с опциональным фильтром) ───────────────────────
// only: массив строк — бросаем ТОЛЬКО предметы, чьё имя содержит хотя бы одну строку
// Если only пусто/null — бросаем всё
async function doDropAll(id, only = null) {
    const b = bots.get(id);
    if (!b?.mc || b.status !== 'online') return 0;
    const mc = b.mc;
    let slots = mc.inventory.slots.filter(s => s != null && s.type > 0);
    if (only && only.length > 0) {
        const filter = only.map(s => s.toLowerCase().trim()).filter(Boolean);
        slots = slots.filter(s => {
            const n = (s.name || '').toLowerCase();
            return filter.some(f => n.includes(f));
        });
    }
    let dropped = 0;
    for (const item of slots) {
        if (bots.get(id)?.mc !== mc) break;
        try { await mc.tossStack(item); dropped++; await sleep(60); } catch {}
    }
    if (dropped > 0) addLog(id, LOG.ACTION, `🎒 Выброшено: ${dropped} стаков${only?.length ? ` (фильтр: ${only.join(', ')})` : ''}`);
    return dropped;
}

// ── Очистка ──────────────────────────────────
function cleanup(id) {
    const b = bots.get(id); if (!b) return;
    cleanupTimers(b);
    clearChatQueue(id);
    navWindowHandled.delete(id);
}

// ── Авторизация дашборда ──────────────────────
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || 'admin';
const activeSessions = new Set();

function genToken() {
    return crypto.randomBytes(32).toString('hex');
}

app.post('/api/login', (req, res) => {
    const { password } = req.body || {};
    if (!password || String(password) !== DASHBOARD_PASSWORD) {
        return res.status(401).json({ success: false, message: 'Неверный пароль' });
    }
    const token = genToken();
    activeSessions.add(token);
    res.json({ success: true, token, user: { role: 'admin' } });
});

app.post('/api/logout', (req, res) => {
    const token = req.headers['x-auth-token'] || req.body?.token;
    if (token) activeSessions.delete(token);
    res.json({ ok: true });
});


app.get('/api/bots', (_req, res) => {
    res.json([...bots.values()].map(({id,config,status,stage,logs,connectedAt,nextFreeIndex,relics,riliky,drops,rilksCases,casesGot})=>
        ({id,config,status,stage,logs,connectedAt,nextFreeIndex,relics,riliky,
          drops:(drops||[]).slice(0,10), rilksCases:rilksCases||0, casesGot:casesGot||0})
    ));
});

app.get('/api/relics', (_req, res) => {
    res.json(buildRelicsSummary());
});

// Создать одного бота
app.post('/api/bots', (req, res) => {
    const host     = String(req.body.host||'').trim();
    const username = makeUniqueUsername(req.body.username);
    if (!host||!username) return res.status(400).json({error:'host и username обязательны'});
    // Прокси: явно указан → используем его, иначе авто из пула
    const explicitProxy = req.body.proxy ? normalizeProxyUrl(String(req.body.proxy).trim()) : null;
    const proxy = explicitProxy || pickProxy() || undefined;
    const config = {
        host, username,
        port:        String(req.body.port||'25565'),
        version:     String(req.body.version||'1.20.1'),
        authPassword:normalizePassword(req.body.authPassword, username),
        autoAuth:    req.body.autoAuth  !== false,
        autoNav:     req.body.autoNav   !== false,
        autoAfk:     req.body.autoAfk   !== false,
        autoFree:    req.body.autoFree   !== false,
        autoPasxa:   req.body.autoPasxa  !== false,
        autoReconnect:req.body.autoReconnect !== false,
        griefWorld:  parseInt(req.body.griefWorld)||1,
        kitFarm:     !!req.body.kitFarm,
        kitFarmRegionOwner: req.body.kitFarmRegionOwner ? String(req.body.kitFarmRegionOwner).trim() : null,
        kitFarmRegion: req.body.kitFarmRegion ? String(req.body.kitFarmRegion).trim() : null,
        ...(proxy ? { proxy } : {}),
    };
    const id = nextId++;
    bots.set(id, buildBotState(id, config, 'connecting', STAGE.CONNECTING));
    io.emit('bot:created', { id, config, status:'connecting', stage:STAGE.CONNECTING, logs:[], relics: createRelicsState(), riliky: null });
    createBot(id, config);
    broadcastStats();
    res.json({ id, username });
});

// Пакетное создание (один запрос вместо N) — экономим RTT
app.post('/api/bots/batch', async (req, res) => {
    const { base, count=1, ...rest } = req.body;
    const host = String(rest.host||'').trim();
    if (!host||!base) return res.status(400).json({error:'host и base обязательны'});
    const normalizedBase = normalizeUsername(base);
    const requestedCount = Math.min(Math.max(1,parseInt(count)||1), 500);
    const singleOnlyDueToMaxUsername = normalizedBase.length >= USERNAME_MAX_LEN && requestedCount > 1;
    const n = singleOnlyDueToMaxUsername ? 1 : requestedCount;

    const ownerUsername = rest.kitFarm && rest.kitFarmRegionOwner
        ? String(rest.kitFarmRegionOwner).trim()
        : null;

    const ids = [];
    let ownerBotId = null;

    // ── Создаём овнер-бота первым ──────────────
    if (ownerUsername) {
        const alreadyExists = [...bots.values()].find(b =>
            b.config.username.toLowerCase() === ownerUsername.toLowerCase()
        );
        if (!alreadyExists) {
            const config = {
                host,
                username:     ownerUsername,
                port:         String(rest.port||'25565'),
                version:      String(rest.version||'1.20.1'),
                authPassword: normalizePassword(rest.authPassword, ownerUsername),
                autoAuth:     rest.autoAuth !== false,
                autoNav:      rest.autoNav  !== false,
                autoAfk:      false, // овнер не идёт в афк
                autoFree:     false, // овнер не фармит /free
                autoReconnect:rest.autoReconnect !== false,
                griefWorld:   parseInt(rest.griefWorld)||1,
                kitFarm:      true,
                kitFarmRegionOwner: ownerUsername,
                kitFarmRegion: rest.kitFarmRegion ? String(rest.kitFarmRegion).trim() : null,
            };
            const id = nextId++;
            ownerBotId = id;
            bots.set(id, buildBotState(id, config, 'offline', STAGE.QUEUED));
            io.emit('bot:created', { id, config, status:'offline', stage:STAGE.QUEUED, logs:[], relics: createRelicsState(), riliky: null });
            ids.push({ id, username: ownerUsername, isOwner: true });
            // Овнер стартует сразу
            queueBotStart(id, 0);
        } else {
            ownerBotId = alreadyExists.id;
        }
    }

    // ── Создаём остальных ботов — они НЕ стартуют сразу ──
    const workerIds = [];
    const batchProxyOverride = rest.proxy ? normalizeProxyUrl(String(rest.proxy).trim()) : null;
    for (let i = 0; i < n; i++) {
        const username = makeUniqueUsername(base);
        if (ownerUsername && username.toLowerCase() === ownerUsername.toLowerCase()) continue;
        const assignedProxy = batchProxyOverride || pickProxy() || undefined;
        const config = {
            host, username,
            port:         String(rest.port||'25565'),
            version:      String(rest.version||'1.20.1'),
            authPassword: normalizePassword(rest.authPassword, username),
            autoAuth:     rest.autoAuth  !== false,
            autoNav:      rest.autoNav   !== false,
            autoAfk:      rest.autoAfk   !== false,
            autoFree:     rest.autoFree   !== false,
            autoPasxa:    rest.autoPasxa  !== false,
            autoReconnect:rest.autoReconnect !== false,
            griefWorld:   parseInt(rest.griefWorld)||1,
            kitFarm:      !!rest.kitFarm,
            kitFarmRegionOwner: ownerUsername || null,
            kitFarmRegion: rest.kitFarmRegion ? String(rest.kitFarmRegion).trim() : null,
            ...(assignedProxy ? { proxy: assignedProxy } : {}),
        };
        const id = nextId++;
        bots.set(id, buildBotState(id, config, 'offline', STAGE.QUEUED));
        io.emit('bot:created', { id, config, status:'offline', stage:STAGE.QUEUED, logs:[], relics: createRelicsState(), riliky: null });
        ids.push({ id, username });
        if (ownerUsername && rest.kitFarm) {
            // Ждут сигнала от овнера — НЕ стартуют сами
            workerIds.push(id);
        } else {
            // Обычный режим без kitFarm — стартуют по расписанию
            workerIds.push(id);
        }
    }

    let schedule;
    if (ownerBotId && rest.kitFarm && ownerUsername) {
        // Рабочие боты НЕ стартуют — овнер запустит их после rg addowner
        schedule = { waveSize: n, waveDelayMs: 0, waves: 1, pendingWorkers: workerIds.length };
    } else {
        schedule = scheduleBatchStart(workerIds, rest.waveSize, rest.waveDelayMs);
    }

    broadcastStats();
    res.json({ created: ids.length, bots: ids, singleOnlyDueToMaxUsername, ownerBotId, ...schedule });
});

app.delete('/api/bots/:id', (req, res) => {
    const id = parseInt(req.params.id,10);
    const b  = bots.get(id); if (!b) return res.status(404).json({error:'Не найден'});
    stopBotSession(id, { suppressReconnect: true });
    bots.delete(id);
    io.emit('bot:removed', {id}); broadcastStats();
    res.json({ok:true});
});

// Удалить всех
app.delete('/api/bots', (_req, res) => {
    [...bots.keys()].forEach(id => {
        stopBotSession(id, { suppressReconnect: true });
        bots.delete(id);
        io.emit('bot:removed', {id});
    });
    broadcastStats();
    res.json({ok:true});
});

app.post('/api/bots/:id/chat', (req, res) => {
    const id = parseInt(req.params.id,10);
    const b  = bots.get(id);
    if (!b?.mc || b.status !== 'online') return res.status(400).json({error:'Бот не онлайн'});
    const msg = String(req.body?.message || '').trim().slice(0, 256);
    if (!msg) return res.status(400).json({error:'Пустое сообщение'});
    chatSafe(id, msg);
    addLog(id, LOG.ACTION, '> ' + msg);
    res.json({ ok: true });
});

app.post('/api/bots/:id/reconnect', (req, res) => {
    const id = parseInt(req.params.id,10);
    const b  = bots.get(id); if (!b) return res.status(404).json({error:'Не найден'});
    if (b.status === 'banned') return res.status(400).json({error:'Бот забанен'});
    stopBotSession(id, { suppressReconnect: true });
    createBot(id, b.config);
    res.json({ok:true});
});

app.post('/api/bots/broadcast', async (req, res) => {
    const { message } = req.body || {};
    if (!message || typeof message !== 'string' || !message.trim())
        return res.status(400).json({ error: 'message required' });
    const msg = message.trim().slice(0, 256);
    const ids = [...bots.keys()];
    // Отдаём ответ сразу — не ждём пока все боты отправят
    const online = ids.filter(id => {
        const b = bots.get(id);
        return b?.mc && b.status === 'online';
    });
    res.json({ ok: true, sent: online.length });
    // Стаггер: распределяем отправку по времени чтобы не спамить сервер
    // Берём chatGapMs / 4 между ботами (мин 100мс, макс 400мс)
    const stagger = Math.min(400, Math.max(100, Math.floor(S.chatGapMs / 4)));
    for (const id of online) {
        const b = bots.get(id);
        if (!b?.mc || b.status !== 'online') continue;
        chatSafe(id, msg);
        await sleep(stagger);
    }
});

app.post('/api/bots/reconnect/all', async (req, res) => {
    const ids = [...bots.keys()];
    res.json({ ok: true, count: ids.length });
    for (const id of ids) {
        const b = bots.get(id);
        if (!b || b.status === 'banned') continue;
        stopBotSession(id, { suppressReconnect: true });
        createBot(id, b.config);
        await sleep(300);
    }
});

app.post('/api/bots/:id/afk', async (req, res) => {
    const id = parseInt(req.params.id,10);
    await goAfk(id);
    res.json({ok:true});
});

// ── ПАСХА — для одного бота ──────────────────
app.post('/api/bots/:id/pasxa', async (req, res) => {
    const id = parseInt(req.params.id,10);
    await doPasxa(id);
    res.json({ok:true});
});

// ── ПАСХА — для всех ботов ───────────────────
app.post('/api/bots/pasxa/all', async (req, res) => {
    const ids = [...bots.keys()];
    res.json({ ok: true, count: ids.length });
    for (const id of ids) {
        doPasxa(id).catch(() => {});
        await sleep(300);
    }
});

// ── Кейс — для одного бота ───────────────────
app.post('/api/bots/:id/case', async (req, res) => {
    const id = parseInt(req.params.id,10);
    doOpenCase(id).catch(() => {});
    res.json({ok:true});
});
app.post('/api/bots/case/all', async (req, res) => {
    const ids = [...bots.keys()];
    res.json({ ok: true, count: ids.length });
    for (const id of ids) { doOpenCase(id).catch(() => {}); await sleep(500); }
});

// ── Рилики (кейс) — для одного бота ─────────
app.post('/api/bots/:id/riliks', (req, res) => {
    const id = parseInt(req.params.id, 10);
    doOpenCase(id).catch(() => {});
    res.json({ ok: true });
});
app.post('/api/bots/riliks/all', async (req, res) => {
    const ids = [...bots.keys()];
    res.json({ ok: true, count: ids.length });
    for (const id of ids) { doOpenCase(id).catch(() => {}); await sleep(600); }
});

// ── Пасха → Кейс ─────────────────────────────
app.post('/api/bots/:id/pasxa-case', async (req, res) => {
    const id = parseInt(req.params.id,10);
    doPasxaCase(id).catch(() => {});
    res.json({ ok: true });
});
app.post('/api/bots/pasxa-case/all', async (req, res) => {
    const ids = [...bots.keys()];
    res.json({ ok: true, count: ids.length });
    for (const id of ids) { doPasxaCase(id).catch(() => {}); await sleep(600); }
});

// ── Забрать Пасху принудительно (без проверки часа) ──
app.post('/api/bots/:id/pasxa-grab', async (req, res) => {
    const id = parseInt(req.params.id,10);
    doPasxaForce(id).catch(() => {});
    res.json({ ok: true });
});
app.post('/api/bots/pasxa-grab/all', async (req, res) => {
    const ids = [...bots.keys()];
    res.json({ ok: true, count: ids.length });
    for (const id of ids) { doPasxaForce(id).catch(() => {}); await sleep(400); }
});
app.post('/api/bots/:id/pasxa-grab-case', async (req, res) => {
    const id = parseInt(req.params.id,10);
    doPasxaCaseForce(id).catch(() => {});
    res.json({ ok: true });
});
app.post('/api/bots/pasxa-grab-case/all', async (req, res) => {
    const ids = [...bots.keys()];
    res.json({ ok: true, count: ids.length });
    for (const id of ids) { doPasxaCaseForce(id).catch(() => {}); await sleep(600); }
});

// ── Выбросить инвентарь ────────────────────────
app.post('/api/bots/:id/drop-all', async (req, res) => {
    const id   = parseInt(req.params.id, 10);
    const b    = bots.get(id);
    if (!b?.mc || b.status !== 'online') return res.status(400).json({ error: 'Бот не онлайн' });
    const only = Array.isArray(req.body?.items) ? req.body.items : null;
    try {
        const dropped = await doDropAll(id, only);
        res.json({ ok: true, dropped });
    } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/bots/drop-all/all', async (req, res) => {
    const only = Array.isArray(req.body?.items) ? req.body.items : null;
    const ids  = [...bots.keys()];
    res.json({ ok: true, count: ids.length });
    for (const id of ids) { doDropAll(id, only).catch(() => {}); await sleep(200); }
});

// ── Прокси API ─────────────────────────────────
// Список
app.get('/api/proxies', (_req, res) => {
    res.json({ ok: true, proxies: getProxyList(), socks_available: !!SocksClient });
});

// Добавить / импортировать (текст или массив)
app.post('/api/proxies/import', (req, res) => {
    const raw   = req.body?.text || (Array.isArray(req.body?.urls) ? req.body.urls.join('\n') : '');
    const limit = Math.max(1, parseInt(req.body?.botsLimit) || 10);
    const parsed = parseProxyText(String(raw));
    const existing = new Set(proxyPool.map(p => p.url));
    let added = 0;
    for (const url of parsed) {
        if (!existing.has(url)) {
            proxyPool.push({ url, alive: null, lastCheck: 0, botsLimit: limit });
            existing.add(url);
            added++;
        }
    }
    saveProxiesToDisk();
    res.json({ ok: true, added, total: proxyPool.length });
});

// Скачать с популярных источников
app.post('/api/proxies/fetch', async (req, res) => {
    try {
        const sources = Array.isArray(req.body?.sources) ? req.body.sources : PROXY_SOURCES;
        const limit   = Math.max(1, parseInt(req.body?.botsLimit) || 10);
        const list    = await fetchProxiesFromSources(sources);
        const existing = new Set(proxyPool.map(p => p.url));
        let added = 0;
        for (const url of list) {
            if (!existing.has(url)) {
                proxyPool.push({ url, alive: null, lastCheck: 0, botsLimit: limit });
                existing.add(url);
                added++;
            }
        }
        saveProxiesToDisk();
        res.json({ ok: true, added, total: proxyPool.length });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Проверить все — стримим прогресс через Socket.IO
app.post('/api/proxies/check', async (req, res) => {
    if (proxyCheckRunning) return res.status(409).json({ error: 'Проверка уже запущена' });
    proxyCheckRunning = true;
    res.json({ ok: true, total: proxyPool.length });

    const timeout    = Math.max(1000, Math.min(8000, parseInt(req.body?.timeoutMs) || 2000));
    const CONCURRENCY = 25; // sliding window — не батч, а постоянно N задач в полёте
    let done = 0;
    const total = proxyPool.length;

    // Буфер обновлений для UI — не спамим Socket.IO на каждый результат,
    // а сбрасываем раз в 300 мс. Это снимает лаг при 1000+ прокси.
    let pendingEmits = [];
    const flushTimer = setInterval(() => {
        if (!pendingEmits.length) return;
        for (const ev of pendingEmits) io.emit('proxy:checked', ev);
        pendingEmits = [];
    }, 300);

    (async () => {
        try {
            // Sliding-window semaphore: всегда CONCURRENCY задач в параллели
            let nextIdx = 0;
            let active  = 0;
            await new Promise((resolve) => {
                function trySpawn() {
                    while (active < CONCURRENCY && nextIdx < total) {
                        const i = nextIdx++;
                        active++;
                        const p = proxyPool[i];
                        checkProxyUrl(p.url, timeout).then(alive => {
                            p.alive = alive; p.lastCheck = Date.now(); done++;
                            pendingEmits.push({ index: i, url: p.url, alive, done, total });
                            active--;
                            if (done === total) resolve();
                            else trySpawn();
                        });
                    }
                    if (active === 0 && nextIdx >= total) resolve();
                }
                trySpawn();
            });
        } finally {
            clearInterval(flushTimer);
            // Сбрасываем оставшиеся буферизованные события
            for (const ev of pendingEmits) io.emit('proxy:checked', ev);
            pendingEmits = [];
            proxyCheckRunning = false;
            saveProxiesToDisk();
            io.emit('proxy:check-done', { total, alive: proxyPool.filter(p => p.alive).length });
        }
    })();
});

// Проверить один
app.post('/api/proxies/:index/check', async (req, res) => {
    const i = parseInt(req.params.index, 10);
    const p = proxyPool[i];
    if (!p) return res.status(404).json({ error: 'Не найден' });
    const alive = await checkProxyUrl(p.url, 3500);
    p.alive = alive; p.lastCheck = Date.now();
    saveProxiesToDisk();
    res.json({ ok: true, alive });
});

// Обновить лимит ботов / метку
app.patch('/api/proxies/:index', (req, res) => {
    const i = parseInt(req.params.index, 10);
    const p = proxyPool[i];
    if (!p) return res.status(404).json({ error: 'Не найден' });
    if (req.body?.botsLimit != null) p.botsLimit = Math.max(1, parseInt(req.body.botsLimit) || 10);
    saveProxiesToDisk();
    res.json({ ok: true, proxy: { ...p, index: i } });
});

// Удалить всех мёртвых (должен быть ПЕРЕД /:index)
app.delete('/api/proxies/dead', (_req, res) => {
    const before = proxyPool.length;
    proxyPool = proxyPool.filter(p => p.alive !== false);
    saveProxiesToDisk();
    res.json({ ok: true, removed: before - proxyPool.length, total: proxyPool.length });
});

// Очистить всё
app.delete('/api/proxies', (_req, res) => {
    proxyPool = [];
    saveProxiesToDisk();
    res.json({ ok: true });
});

// Удалить один (должен быть ПОСЛЕ специфичных путей)
app.delete('/api/proxies/:index', (req, res) => {
    const i = parseInt(req.params.index, 10);
    if (!proxyPool[i]) return res.status(404).json({ error: 'Не найден' });
    proxyPool.splice(i, 1);
    saveProxiesToDisk();
    res.json({ ok: true, total: proxyPool.length });
});

// ── Дропы ─────────────────────────────────────
app.get('/api/drops', (_req, res) => {
    const all = [];
    for (const b of bots.values()) {
        for (const d of (b.drops || [])) all.push({ ...d, username: b.config.username, id: b.id });
    }
    all.sort((a,b) => b.ts - a.ts);
    res.json(all.slice(0, 100));
});

// ── Магазин ────────────────────────────────────
app.post('/api/bots/:id/shop/open', async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const b = bots.get(id);
    if (!b?.mc || b.status !== 'online') return res.status(400).json({ error: 'Бот не онлайн' });
    try {
        const win = await openShopCmd(id, '/shop');
        if (!win) return res.status(408).json({ error: 'Магазин не открылся (таймаут)' });
        const parsed = parseShopWindow(win);
        b.shopSession = { rawWindow: win, parsed };
        addLog(id, LOG.ACTION, `Магазин открыт: ${parsed.title}`);
        res.json({ ok: true, shop: parsed });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/bots/:id/shop/click', async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const b = bots.get(id);
    if (!b?.mc || b.status !== 'online') return res.status(400).json({ error: 'Бот не онлайн' });
    if (!b.shopSession) return res.status(400).json({ error: 'Магазин не открыт' });
    const slot = parseInt(req.body?.slot, 10);
    if (isNaN(slot)) return res.status(400).json({ error: 'slot required' });
    const qty = Math.max(1, Math.min(99, parseInt(req.body?.qty, 10) || 1));
    try {
        const newWin = await clickAndWaitWin(id, slot);
        if (newWin) {
            const parsed = parseShopWindow(newWin);
            b.shopSession = { rawWindow: newWin, parsed };
            res.json({ ok: true, navigated: true, shop: parsed });
        } else {
            const slotInfo = b.shopSession.parsed.slots.find(s => s.index === slot);
            let bought = 0;
            if (slotInfo?.price != null) {
                bought = 1;
                for (let i = 1; i < qty; i++) {
                    await sleep(400);
                    if (!b.mc || !b.shopSession) break;
                    try { await b.mc.clickWindow(slot, 0, 0); bought++; } catch { break; }
                }
                addLog(id, LOG.SUCCESS, `Куплено: ${slotInfo.name} x${bought} (${slotInfo.price} каждый)`);
            }
            res.json({ ok: true, navigated: false, bought: bought > 0, boughtQty: bought, shop: b.shopSession?.parsed });
        }
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/bots/:id/shop/close', (req, res) => {
    const id = parseInt(req.params.id, 10);
    const b = bots.get(id);
    if (b?.mc) { try { if (b.mc.currentWindow) b.mc.closeWindow(b.mc.currentWindow); } catch {} }
    if (b) b.shopSession = null;
    res.json({ ok: true });
});

app.post('/api/bots/:id/shop/scan', (req, res) => {
    const id = parseInt(req.params.id, 10);
    const b = bots.get(id);
    if (!b?.mc || b.status !== 'online') return res.status(400).json({ error: 'Бот не онлайн' });
    res.json({ ok: true, message: 'Сканирование запущено' });
    scanShopFull(id).catch(e => addLog(id, LOG.ERROR, 'Скан: ' + e.message));
});

// ── Импорт ботов из TXT ──────────────────────
app.post('/api/bots/import', (req, res) => {
    const { host, port, version, bots: botList, waveSize, waveDelay, proxyList: rawProxyList, ...rest } = req.body;
    if (!String(host||'').trim()) return res.status(400).json({ error: 'host обязателен' });
    if (!Array.isArray(botList) || !botList.length) return res.status(400).json({ error: 'bots[] обязателен' });
    const proxyList = Array.isArray(rawProxyList) ? rawProxyList.filter(Boolean) : [];
    const created = [];
    botList.slice(0, 500).forEach((entry, idx) => {
        const username = makeUniqueUsername(entry.username);
        if (!username) return;
        const proxy = proxyList.length ? proxyList[idx % proxyList.length] : null;
        const config = {
            host: String(host).trim(),
            username,
            port:         String(port  || '25565'),
            version:      String(version || '1.20.1'),
            authPassword: normalizePassword(entry.password || rest.authPassword, username),
            autoAuth:     rest.autoAuth     !== false,
            autoNav:      rest.autoNav      !== false,
            autoAfk:      rest.autoAfk      !== false,
            autoFree:     rest.autoFree     !== false,
            autoPasxa:    rest.autoPasxa    !== false,
            autoReconnect:rest.autoReconnect !== false,
            griefWorld:   parseInt(rest.griefWorld) || 1,
            kitFarm: false, kitFarmRegionOwner: null, kitFarmRegion: null,
            proxy: proxy || null,
        };
        const id = nextId++;
        bots.set(id, buildBotState(id, config, 'connecting', STAGE.CONNECTING));
        io.emit('bot:created', { id, config, status:'connecting', stage:STAGE.CONNECTING, logs:[], relics: createRelicsState(), riliky: null });
        created.push(id);
    });
    broadcastStats();
    const schedule = scheduleBatchStart(created, waveSize, waveDelay);
    res.json({ ok: true, created: created.length, ...schedule });
});

// ── Экспорт ботов ─────────────────────────────
app.get('/api/bots/export', (req, res) => {
    const lines = ['# CakeWorld Bot Manager'];
    for (const b of bots.values()) {
        lines.push(`${b.config.username}:${b.config.authPassword || b.config.username}`);
    }
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="bots.txt"');
    res.send(lines.join('\n'));
});

// ── MC Monitor + Agent status ─────────────────
let mcStatus   = { online: false, rtt: 0, players: 0, max: 0, motd: '', downStreak: 0, updatedAt: null };
let agentStatus = { active: false, totalBots: 0, onlineBots: 0, restarted: 0, stale: 0, lastAction: '', updatedAt: null };

app.post('/api/mc-status', (req, res) => {
    const b = req.body || {};
    mcStatus = {
        online:      !!b.online,
        rtt:         Number(b.rtt)         || 0,
        players:     Number(b.players)     || 0,
        max:         Number(b.max)         || 0,
        motd:        String(b.motd  || '').slice(0, 120),
        downStreak:  Number(b.downStreak)  || 0,
        updatedAt:   Date.now(),
    };
    io.emit('mc:status', mcStatus);
    res.json({ ok: true });
});
app.get('/api/mc-status', (_req, res) => res.json(mcStatus));

app.post('/api/agent-status', (req, res) => {
    const b = req.body || {};
    agentStatus = {
        active:     !!b.active,
        totalBots:  Number(b.totalBots)  || 0,
        onlineBots: Number(b.onlineBots) || 0,
        restarted:  Number(b.restarted)  || 0,
        stale:      Number(b.stale)      || 0,
        lastAction: String(b.lastAction || '').slice(0, 120),
        updatedAt:  Date.now(),
    };
    io.emit('agent:status', agentStatus);
    res.json({ ok: true });
});
app.get('/api/agent-status', (_req, res) => res.json(agentStatus));

// ── Настройки ─────────────────────────────────
app.get('/api/settings', (_req, res) => {
    res.json({ settings: S, defaults: SETTINGS_DEFAULTS });
});
app.post('/api/settings', (req, res) => {
    const body = req.body || {};
    const numKeys = ['chatGapMs','startStaggerMs','waveSize','waveDelayMs','warpTimeoutMs',
        'afkWalkMs','chunkGcMs','shopOpenTimeoutMs','shopClickTimeoutMs','freeSlotDelayMs',
        'antiTimeoutMinSec','antiTimeoutMaxSec'];
    for (const k of numKeys) {
        const v = parseFloat(body[k]);
        if (!isNaN(v) && v > 0) S[k] = Math.round(v);
    }
    if (Array.isArray(body.freeRewardsMin) && body.freeRewardsMin.length > 0) {
        S.freeRewardsMin = body.freeRewardsMin.map(Number).filter(n => n > 0);
    }
    saveSettings();
    res.json({ ok: true, settings: S });
});
app.post('/api/settings/reset', (_req, res) => {
    S = { ...SETTINGS_DEFAULTS };
    saveSettings();
    res.json({ ok: true, settings: S });
});

io.on('connection', () => broadcastStats());

const PORT = process.env.PORT || 3000;
server.on('error', err => {
    if (err?.code === 'EADDRINUSE') {
        console.error(`[Server] Port ${PORT} is already in use. Open http://localhost:${PORT} or start with another PORT.`);
        process.exit(1);
    }
    console.error('[Server] Fatal error:', err);
    process.exit(1);
});
server.listen(PORT, () => console.log(`[Server] http://localhost:${PORT}`));