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
const MAX_START_WAVE_SIZE   = 50;
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
    startStaggerMs:     450,
    waveSize:           10,
    waveDelayMs:        4000,
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
const navWindowHandled = new Set();

// ── Безопасный чат (не флудим — ждём между командами) ──
const CHAT_MIN_GAP_MS = 600; // минимум между командами
const chatQueues = new Map(); // id → Promise
function chatSafe(id, cmd) {
    const b = bots.get(id);
    if (!b?.mc) return Promise.resolve();
    const prev = chatQueues.get(id) || Promise.resolve();
    const next = prev.then(async () => {
        const cur = bots.get(id);
        if (!cur?.mc || cur.status !== 'online') return;
        cur.mc.chat(cmd);
        await sleep(S.chatGapMs);
    });
    chatQueues.set(id, next.catch(() => {}));
    return next;
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
    io.emit('stats', {
        total:   all.length,
        online:  all.filter(b => b.status === 'online').length,
        offline: all.filter(b => b.status === 'offline' || b.status === 'error').length,
        banned:  all.filter(b => b.status === 'banned').length,
        ram:     Math.round(mem.rss / 1024 / 1024),
        heap:    Math.round(mem.heapUsed / 1024 / 1024),
        cpu:     currentCpu,
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
        auth: { authenticated: false, lastMode: null, lastAt: 0, attempts: { register: 0, login: 0 } },
        shopSession: null, shopScanResult: null,
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
function scheduleAuth(id, mode, prompt = '', delay = DEFAULT_AUTH_DELAY_MS) {
    const b = bots.get(id);
    if (!b?.mc || b.status === 'banned' || b.config.autoAuth === false) return;
    if (mode === 'login' && b.auth.authenticated) return;
    const now = Date.now();
    if (b.auth.lastMode === mode && now - b.auth.lastAt < AUTH_RETRY_WINDOW_MS) return;
    if (b.auth.attempts[mode] >= 4) return;
    if (b.authTimer) clearTimeout(b.authTimer);
    b.authTimer = setTimeout(() => sendAuth(id, mode, prompt), delay);
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

    let mc;
    try {
        mc = mineflayer.createBot({
            host:     config.host,
            port:     parseInt(config.port, 10) || 25565,
            username: config.username,
            version:  config.version || '1.20.1',
            auth:     'offline',
            hideErrors: true,
            checkTimeoutInterval: 30000,
            physicsEnabled: false,
            disableChatSigning: true,   // без подписи чата (1.19+)
            viewDistance: LOW_MEMORY_VIEW_DISTANCE,
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

        // Явно говорим серверу: view distance = 2, без подписей скина
        // уменьшает поток чанков и entity-данных от сервера
        try {
            mc._client.write('settings', {
                locale:              'ru_RU',
                viewDistance:        2,
                chatMode:            0,
                chatColors:          false,
                displayedSkinParts:  0,
                mainHand:            1,
                enableTextFiltering: false,
                allowServerListings: false,
            });
        } catch {}
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
            // С авторизацией: навигация запустится из markAuthenticated сразу после входа
            scheduleAuth(id, 'register');
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
        const intent = detectAuthIntent(text);
        if (!intent) return;
        if (intent.mode === 'authenticated') { markAuthenticated(id); return; }
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
        if (cur.config.autoNav) await handleNavWindow(id, window);
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
        const isBan    = /ban|заблокир|banned/i.test(text);
        const isIpBlock = /не прошел проверку|не прошёл проверку|список зараженных|зараженных/i.test(text);
        handleDisconnect(id, mc, {
            logType: (isBan || isIpBlock) ? LOG.BAN : LOG.WARN,
            message: isIpBlock
                ? `IP заблокирован сервером (реконнект остановлен)`
                : isBan
                ? `Бан: ${text}`
                : `Кикнут: ${text}`,
            stage: isBan ? STAGE.BANNED : STAGE.OFFLINE,
            ban: isBan,
            stopReconnect: isIpBlock,
            reconnectReason: text,
        });
    });

    mc.on('error', e => {
        handleDisconnect(id, mc, {
            logType: LOG.ERROR,
            message: e.message,
            stage: STAGE.ERROR,
            reconnectReason: e.message,
        });
    });

    mc.on('end', () => {
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
    const slot = b.mc.inventory.slots[36];
    if (!slot) { addLog(id, LOG.WARN, 'Хотбар пуст'); return; }
    await b.mc.equip(slot, 'hand');
    addLog(id, LOG.ACTION, `Взял: ${slot.name}`);
    await sleep(600);
    b.mc.activateItem();
    addLog(id, LOG.ACTION, 'ПКМ — открываю меню');
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

        // Фолбэк — неизвестное меню, пробуем стандартный путь
        addLog(id, LOG.WARN, `Неизвестное меню: "${titleText}" — фолбэк`);
        await sleep(800);
        await b.mc.clickWindow(2*9+4, 0, 0);
        addLog(id, LOG.ACTION, 'Фолбэк: клик слот 22 (Гриферское выживание)');
        // ждём пока откроется следующее окно (выбор мира грифа)
        await sleep(1500);
        const nextWin = b.mc.currentWindow;
        if (nextWin) {
            const nextRaw = nextWin.title || '';
            const nextTitle = extractText(typeof nextRaw === 'string' ? (() => { try { return JSON.parse(nextRaw); } catch { return nextRaw; } })() : nextRaw);
            if (/выбор мира грифа/i.test(nextTitle)) {
                navWindowHandled.delete(id);
                await handleNavWindow(id, nextWin);
                return;
            }
        }
        await b.mc.clickWindow(1*9+2, 0, 0);
        addLog(id, LOG.ACTION, 'Фолбэк: клик слот 11 → переход на сервер');
        markEnteredGrief(id);
        setStage(id, STAGE.SERVER);
        scheduleWorldCompaction(id);
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

// ── Анти-таймаут: редкие небольшие повороты, без накопления дрейфа ──
function startAntiTimeout(id, mc) {
    const b = bots.get(id);
    if (!b || b.antiTimeoutTimer) return;
    // Сохраняем базовый угол поворота — не даём дрейфу накапливаться
    b._atBaseYaw = mc.entity?.yaw ?? 0;
    b._atDir     = 1;

    const tick = () => {
        const cur = bots.get(id);
        if (!cur?.mc || cur.mc !== mc || cur.status !== 'online') return;
        try {
            const e = cur.mc.entity;
            if (e) {
                // Чередуем лево/право ±1.5–3° — выглядит как ручная подправка
                const deg = (0.026 + Math.random() * 0.026) * cur._atDir;
                cur._atDir *= -1;
                cur.mc.look(cur._atBaseYaw + deg, e.pitch, false);
            }
        } catch {}
        // Следующий тик — случайно через antiTimeoutMinSec–antiTimeoutMaxSec с
        const range = Math.max(1, S.antiTimeoutMaxSec - S.antiTimeoutMinSec) * 1000;
        const delay = S.antiTimeoutMinSec * 1000 + Math.floor(Math.random() * range);
        cur._atTimer = setTimeout(tick, delay);
        cur._atTimer?.unref?.();
        cur.antiTimeoutTimer = cur._atTimer;
    };

    const range0 = Math.max(1, S.antiTimeoutMaxSec - S.antiTimeoutMinSec) * 1000;
    const firstDelay = S.antiTimeoutMinSec * 1000 + Math.floor(Math.random() * range0);
    b.antiTimeoutTimer = setTimeout(tick, firstDelay);
    b.antiTimeoutTimer?.unref?.();
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

        await sleep(300);

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
async function collectFreeRewards(id, window) {
    const b = bots.get(id); if (!b?.mc) return;
    const size = window.slots.length;
    const slots = [];
    for (let i = 0; i < size; i++) {
        const s = window.slots[i];
        if (s && s.name !== 'gray_stained_glass_pane' && s.name !== 'air') slots.push(i);
    }
    if (!slots.length) {
        addLog(id, LOG.WARN, `Меню /free (${size} сл.) — нет наград`);
    } else {
        // Берём только первую доступную награду за один визит в меню
        const slot = slots[0];
        addLog(id, LOG.ACTION, `Меню /free (${size} сл.) — клик слот ${slot} (1 из ${slots.length})`);
        try {
            await sleep(S.freeSlotDelayMs);
            await b.mc.clickWindow(slot, 0, 0);
            addLog(id, LOG.SUCCESS, `Награда слот ${slot} ✓`);
        } catch(e) {
            addLog(id, LOG.ERROR, `Клик ${slot}: ` + e.message);
        }
    }
    await sleep(200);
    try { if (b.mc) b.mc.closeWindow(window); } catch {}
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
        await sleep(300);

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
            await sleep(300);
        }

        // 3. Ищем ближайший сундук и выкладываем предметы
        await sleep(300);
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

// ── Открыть кейс ─────────────────────────────
async function doOpenCase(id) {
    const b = bots.get(id);
    if (!b?.mc || b.status !== 'online') return;
    const mc = b.mc;
    addLog(id, LOG.ACTION, '/warp case — иду к шалкеру');
    try {
        // 1. телепорт
        mc.chat('/warp case');
        // ждём сообщение о телепорте или 3 сек
        await new Promise(resolve => {
            const t = setTimeout(resolve, 3000);
            function onMsg(msg) {
                if (/телепортир|варп|warp|case/i.test(msg.toString())) {
                    clearTimeout(t);
                    mc.removeListener('message', onMsg);
                    resolve();
                }
            }
            mc.on('message', onMsg);
            setTimeout(() => mc.removeListener('message', onMsg), 3000);
        });
        await sleep(300);

        // 2. включаем физику и идём 1 блок вправо
        const prevPhysics = mc.physicsEnabled;
        mc.physicsEnabled = true;
        mc.setControlState('right', true);
        await sleep(200);
        mc.setControlState('right', false);
        mc.physicsEnabled = prevPhysics;
        await sleep(150);

        // 3. поворачиваемся к шалкеру на 61 57 1
        const target = { x: 61, y: 57, z: 1 };
        const pos = mc.entity?.position;
        if (pos) {
            const dx = target.x - pos.x;
            const dz = target.z - pos.z;
            const yaw = Math.atan2(-dx, dz) * (180 / Math.PI);
            mc.entity.yaw = yaw * (Math.PI / 180);
        }
        await sleep(100);

        // 4. находим шалкер/блок один раз
        const findTarget = () => {
            const ent = Object.values(mc.entities).find(e =>
                e.name === 'shulker' &&
                Math.abs(e.position.x - 61) < 3 &&
                Math.abs(e.position.z - 1) < 3
            );
            if (ent) return { type: 'entity', ref: ent };
            const blk = mc.findBlock({
                matching: bl => bl.name === 'shulker_box' || (bl.name && bl.name.includes('shulker')),
                maxDistance: 5,
            });
            if (blk) return { type: 'block', ref: blk };
            return null;
        };

        // 5. спамим ПКМ пока окно не откроется (макс 8 сек)
        const window = await new Promise((resolve, reject) => {
            let opened = false;
            const deadline = setTimeout(() => {
                clearInterval(spamInterval);
                mc.removeListener('windowOpen', onWin);
                if (!opened) reject(new Error('Шалкер занят — окно не открылось'));
            }, 8000);

            function onWin(w) {
                opened = true;
                clearInterval(spamInterval);
                clearTimeout(deadline);
                mc.removeListener('windowOpen', onWin);
                resolve(w);
            }
            mc.once('windowOpen', onWin);

            // быстрый спам ПКМ каждые 150мс
            const spamInterval = setInterval(async () => {
                if (opened) return;
                try {
                    const t = findTarget();
                    if (t?.type === 'entity') await mc.activateEntityAt(t.ref);
                    else if (t?.type === 'block') await mc.activateBlock(t.ref);
                } catch {}
            }, 150);

            // первый клик сразу
            (async () => {
                try {
                    const t = findTarget();
                    if (t?.type === 'entity') { addLog(id, LOG.ACTION, 'Нашёл шалкер — спам ПКМ'); await mc.activateEntityAt(t.ref); }
                    else if (t?.type === 'block') { addLog(id, LOG.ACTION, 'Нашёл шалкер-блок — спам ПКМ'); await mc.activateBlock(t.ref); }
                    else addLog(id, LOG.WARN, 'Шалкер не найден, жду окно');
                } catch {}
            })();
        });

        // 6. окно открылось — кликаем слот 13
        addLog(id, LOG.ACTION, `Окно "${window.title}" — кликаю слот 13`);
        await sleep(100);
        await mc.clickWindow(13, 0, 0);
        addLog(id, LOG.SUCCESS, 'Кейс открыт');
        await sleep(150);
        try { mc.closeWindow(window); } catch {}
        scheduleWorldCompaction(id, 1500);

    } catch(e) {
        addLog(id, LOG.ERROR, 'Кейс: ' + e.message);
    }
}

// ── Очистка ──────────────────────────────────
function cleanup(id) {
    const b = bots.get(id); if (!b) return;
    cleanupTimers(b);
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
    res.json([...bots.values()].map(({id,config,status,stage,logs,connectedAt,nextFreeIndex,relics,riliky})=>
        ({id,config,status,stage,logs,connectedAt,nextFreeIndex,relics,riliky})
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
    const requestedCount = Math.min(Math.max(1,parseInt(count)||1), 100);
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
    for (let i = 0; i < n; i++) {
        const username = makeUniqueUsername(base);
        if (ownerUsername && username.toLowerCase() === ownerUsername.toLowerCase()) continue;
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
    if (!b?.mc) return res.status(400).json({error:'Бот не онлайн'});
    const msg = req.body.message?.trim();
    if (!msg) return res.status(400).json({error:'Пустое сообщение'});
    try { b.mc.chat(msg); addLog(id, LOG.ACTION, '> '+msg); res.json({ok:true}); }
    catch(e) { res.status(500).json({error:e.message}); }
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
    let sent = 0;
    for (const id of ids) {
        const b = bots.get(id);
        if (!b?.mc || b.status !== 'online') continue;
        chatSafe(id, msg);
        sent++;
        await sleep(50);
    }
    res.json({ ok: true, sent });
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

// ── Кейс — для всех ботов ────────────────────
app.post('/api/bots/case/all', async (req, res) => {
    const ids = [...bots.keys()];
    res.json({ ok: true, count: ids.length });
    for (const id of ids) {
        doOpenCase(id).catch(() => {});
        await sleep(500);
    }
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
    const { host, port, version, bots: botList, waveSize, waveDelay, ...rest } = req.body;
    if (!String(host||'').trim()) return res.status(400).json({ error: 'host обязателен' });
    if (!Array.isArray(botList) || !botList.length) return res.status(400).json({ error: 'bots[] обязателен' });
    const created = [];
    for (const entry of botList.slice(0, 500)) {
        const username = makeUniqueUsername(entry.username);
        if (!username) continue;
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
        };
        const id = nextId++;
        bots.set(id, buildBotState(id, config, 'connecting', STAGE.CONNECTING));
        io.emit('bot:created', { id, config, status:'connecting', stage:STAGE.CONNECTING, logs:[], relics: createRelicsState(), riliky: null });
        created.push(id);
    }
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