/**
 * Keyword Radar — State, Settings & Swipe-Friendly Mute/Boost Lifecycle Manager
 *
 * Persistent per-chat mutes ("Mute Chat") are stored solely inside the extension's own
 * settings map (`extension_settings.keyword_radar.chatMutes[chatKey]`), leaving all
 * SillyTavern chat files completely untouched.
 */

import { DEFAULT_SETTINGS, EXTENSION_NAME, MUTE_MODE } from './constants.js';
import { getEntryKey } from './utils.js';

export function createRadarState(initialSettings = {}, { onSettingsDirty = null } = {}) {
    let settings = {
        ...DEFAULT_SETTINGS,
        chatMutes: {},
        ...initialSettings,
    };
    if (!settings.chatMutes || typeof settings.chatMutes !== 'object') {
        settings.chatMutes = {};
    }

    /** @type {Map<string, object>} */
    const mutes = new Map();

    /** @type {Map<string, object>} */
    const boosts = new Map();

    /** @type {Set<() => void>} */
    const listeners = new Set();

    let lastScanResult = null;
    let hoveredEntryKey = null;
    let compactExpanded = false;
    let currentChatId = null;
    let activeGenerationContext = null;

    function notify() {
        for (const fn of listeners) {
            try {
                fn();
            } catch {
                // ignore listener errors
            }
        }
    }

    function markSettingsDirty() {
        if (typeof onSettingsDirty === 'function') {
            try {
                onSettingsDirty();
            } catch {
                // ignore
            }
        }
    }

    function ensureChatMutesStore() {
        if (!settings.chatMutes || typeof settings.chatMutes !== 'object') {
            settings.chatMutes = {};
        }
        return settings.chatMutes;
    }

    function serializeSessionMutes() {
        const list = [];
        for (const rec of mutes.values()) {
            if (rec.mode === MUTE_MODE.SESSION) {
                list.push({
                    key: rec.key,
                    world: rec.world,
                    uid: rec.uid,
                    title: rec.title,
                    createdAt: rec.createdAt,
                });
            }
        }
        return list;
    }

    function syncCurrentChatMutesToSettings() {
        if (!currentChatId) return;
        const store = ensureChatMutesStore();
        const serialized = serializeSessionMutes();
        if (serialized.length > 0) {
            store[currentChatId] = serialized;
        } else {
            delete store[currentChatId];
        }
        markSettingsDirty();
    }

    function hydrateSessionMutesForChat(chatId) {
        if (!chatId) return;
        const store = ensureChatMutesStore();
        const records = store[chatId];
        if (!Array.isArray(records)) return;
        for (const r of records) {
            if (!r || (!r.key && (r.world === undefined || r.uid === undefined))) continue;
            const key = r.key || getEntryKey(r);
            mutes.set(key, {
                key,
                world: r.world ?? '',
                uid: r.uid ?? '',
                title: r.title || `Entry #${r.uid ?? '?'}`,
                mode: MUTE_MODE.SESSION,
                remainingTurns: Infinity,
                activeOnTurn: null,
                createdAt: Number(r.createdAt) || Date.now(),
            });
        }
    }

    function subscribe(fn) {
        listeners.add(fn);
        return () => listeners.delete(fn);
    }

    function getSettings() {
        return settings;
    }

    function bindExtensionSettings(extensionSettingsObj) {
        if (!extensionSettingsObj) return settings;
        if (!extensionSettingsObj[EXTENSION_NAME] || typeof extensionSettingsObj[EXTENSION_NAME] !== 'object') {
            extensionSettingsObj[EXTENSION_NAME] = { ...DEFAULT_SETTINGS, chatMutes: {} };
        } else {
            for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
                if (extensionSettingsObj[EXTENSION_NAME][k] === undefined) {
                    extensionSettingsObj[EXTENSION_NAME][k] = k === 'chatMutes' ? {} : v;
                }
            }
            if (!extensionSettingsObj[EXTENSION_NAME].chatMutes || typeof extensionSettingsObj[EXTENSION_NAME].chatMutes !== 'object') {
                extensionSettingsObj[EXTENSION_NAME].chatMutes = {};
            }
        }
        settings = extensionSettingsObj[EXTENSION_NAME];
        return settings;
    }

    function updateSetting(key, value) {
        settings[key] = value;
        notify();
    }

    function computeTurnKey(chat, { upcoming = false } = {}) {
        const list = Array.isArray(chat) ? chat : [];
        let userMessageCount = 0;
        for (const msg of list) {
            if (msg && msg.is_user && !msg.is_system) {
                userMessageCount++;
            }
        }
        const turnNum = upcoming ? userMessageCount + 1 : userMessageCount;
        return `turn:${turnNum}`;
    }

    function muteEntry(entry, { mode = MUTE_MODE.TURNS, turns = 1 } = {}) {
        const key = getEntryKey(entry);
        const safeTurns = Math.max(1, Math.floor(Number(turns) || 1));
        const prev = mutes.get(key);
        const resolvedMode = mode === MUTE_MODE.SESSION ? MUTE_MODE.SESSION : MUTE_MODE.TURNS;
        boosts.delete(key);
        mutes.set(key, {
            key,
            world: entry.world,
            uid: entry.uid,
            title: entry.title || entry.comment || `Entry #${entry.uid}`,
            mode: resolvedMode,
            remainingTurns: resolvedMode === MUTE_MODE.SESSION ? Infinity : safeTurns,
            activeOnTurn: null,
            createdAt: Date.now(),
        });
        if (resolvedMode === MUTE_MODE.SESSION || prev?.mode === MUTE_MODE.SESSION) {
            syncCurrentChatMutesToSettings();
        }
        notify();
    }

    function unmuteEntry(entryOrKey) {
        const key = typeof entryOrKey === 'string' ? entryOrKey : getEntryKey(entryOrKey);
        const prev = mutes.get(key);
        if (mutes.delete(key)) {
            if (prev?.mode === MUTE_MODE.SESSION) {
                syncCurrentChatMutesToSettings();
            }
            notify();
        }
    }

    function boostEntry(entry) {
        const key = getEntryKey(entry);
        const prevMute = mutes.get(key);
        mutes.delete(key);
        if (prevMute?.mode === MUTE_MODE.SESSION) {
            syncCurrentChatMutesToSettings();
        }
        boosts.set(key, {
            key,
            world: entry.world,
            uid: entry.uid,
            title: entry.title || entry.comment || `Entry #${entry.uid}`,
            activeOnTurn: null,
            createdAt: Date.now(),
        });
        notify();
    }

    function unboostEntry(entryOrKey) {
        const key = typeof entryOrKey === 'string' ? entryOrKey : getEntryKey(entryOrKey);
        if (boosts.delete(key)) {
            notify();
        }
    }

    function toggleOneTurnMute(entry) {
        const key = getEntryKey(entry);
        if (mutes.has(key)) {
            unmuteEntry(key);
        } else {
            muteEntry(entry, { mode: MUTE_MODE.TURNS, turns: 1 });
        }
    }

    function toggleBoost(entry) {
        const key = getEntryKey(entry);
        if (boosts.has(key)) {
            unboostEntry(key);
        } else {
            boostEntry(entry);
        }
    }

    function getEffectiveMuteForTurn(entryKey, turnKey) {
        const rec = mutes.get(entryKey);
        if (!rec) return null;
        if (rec.mode === MUTE_MODE.SESSION) return rec;

        if (rec.activeOnTurn === null) {
            return rec.remainingTurns > 0 ? rec : null;
        }
        if (rec.activeOnTurn === turnKey) {
            return settings.keepMuteOnSwipe ? rec : null;
        }
        const projectedRemaining = rec.remainingTurns - 1;
        if (projectedRemaining <= 0) return null;
        return { ...rec, remainingTurns: projectedRemaining };
    }

    function getEffectiveBoostForTurn(entryKey, turnKey) {
        const rec = boosts.get(entryKey);
        if (!rec) return null;
        if (rec.activeOnTurn === null) return rec;
        if (rec.activeOnTurn === turnKey) {
            return settings.keepMuteOnSwipe ? rec : null;
        }
        return null;
    }

    function getEffectiveControlsForTurn(turnKey) {
        const effectiveMutes = new Map();
        for (const key of mutes.keys()) {
            const eff = getEffectiveMuteForTurn(key, turnKey);
            if (eff) effectiveMutes.set(key, eff);
        }

        const effectiveBoosts = new Map();
        for (const key of boosts.keys()) {
            const eff = getEffectiveBoostForTurn(key, turnKey);
            if (eff) effectiveBoosts.set(key, eff);
        }

        return { effectiveMutes, effectiveBoosts };
    }

    function onGenerationStart({ type = 'normal', chat = [], turnKey: explicitTurnKey } = {}) {
        const genType = String(type || 'normal').toLowerCase();

        if (genType === 'quiet' || genType === 'impersonate') {
            return {
                mutedKeys: new Set(),
                boostedRecords: [],
                turnKey: explicitTurnKey || computeTurnKey(chat),
                ignored: true,
            };
        }

        const turnKey = explicitTurnKey || computeTurnKey(chat);
        const isSameTurnRetry = genType === 'swipe' || genType === 'regenerate' || genType === 'continue';
        const keepOnSwipe = Boolean(settings.keepMuteOnSwipe);
        let changed = false;

        for (const [key, rec] of Array.from(mutes.entries())) {
            if (rec.mode === MUTE_MODE.SESSION) {
                rec.activeOnTurn = turnKey;
                continue;
            }

            if (rec.activeOnTurn === null) {
                rec.activeOnTurn = turnKey;
                changed = true;
            } else if (rec.activeOnTurn === turnKey) {
                if (!(isSameTurnRetry && keepOnSwipe)) {
                    rec.remainingTurns -= 1;
                    changed = true;
                    if (rec.remainingTurns <= 0) {
                        mutes.delete(key);
                    }
                }
            } else {
                rec.remainingTurns -= 1;
                changed = true;
                if (rec.remainingTurns <= 0) {
                    mutes.delete(key);
                } else {
                    rec.activeOnTurn = turnKey;
                }
            }
        }

        for (const [key, rec] of Array.from(boosts.entries())) {
            if (rec.activeOnTurn === null) {
                rec.activeOnTurn = turnKey;
                changed = true;
            } else if (rec.activeOnTurn === turnKey) {
                if (!(isSameTurnRetry && keepOnSwipe)) {
                    boosts.delete(key);
                    changed = true;
                }
            } else {
                boosts.delete(key);
                changed = true;
            }
        }

        if (changed) notify();

        return {
            mutedKeys: new Set(mutes.keys()),
            boostedRecords: Array.from(boosts.values()),
            turnKey,
            ignored: false,
        };
    }

    function clearAllOverrides() {
        const hadSessionMute = Array.from(mutes.values()).some((r) => r.mode === MUTE_MODE.SESSION);
        const hadAny = mutes.size > 0 || boosts.size > 0;
        mutes.clear();
        boosts.clear();
        activeGenerationContext = null;
        if (hadSessionMute) syncCurrentChatMutesToSettings();
        if (hadAny) notify();
    }

    function getGlobalChatMuteStats() {
        const store = ensureChatMutesStore();
        let chatCount = 0;
        let entryCount = 0;
        for (const list of Object.values(store)) {
            if (Array.isArray(list) && list.length > 0) {
                chatCount++;
                entryCount += list.length;
            }
        }
        return { chatCount, entryCount };
    }

    function clearAllChatMutesGlobally() {
        settings.chatMutes = {};
        let removedAny = false;
        for (const [key, rec] of Array.from(mutes.entries())) {
            if (rec.mode === MUTE_MODE.SESSION) {
                mutes.delete(key);
                removedAny = true;
            }
        }
        markSettingsDirty();
        if (removedAny) notify();
    }

    function migrateChatKey(oldKey, newKey) {
        if (!oldKey || !newKey || oldKey === newKey) return;
        const store = ensureChatMutesStore();
        if (Array.isArray(store[oldKey]) && store[oldKey].length > 0) {
            store[newKey] = store[oldKey];
            delete store[oldKey];
            markSettingsDirty();
        }
        if (currentChatId === oldKey) {
            currentChatId = newKey;
        }
    }

    function handleChatChanged(chatId) {
        const nextChatId = chatId ?? null;
        if (nextChatId !== currentChatId) {
            currentChatId = nextChatId;
            mutes.clear();
            boosts.clear();
            activeGenerationContext = null;
            lastScanResult = null;
            hoveredEntryKey = null;
            hydrateSessionMutesForChat(currentChatId);
            notify();
        }
    }

    return {
        subscribe,
        getSettings,
        bindExtensionSettings,
        updateSetting,
        computeTurnKey,
        muteEntry,
        unmuteEntry,
        boostEntry,
        unboostEntry,
        toggleOneTurnMute,
        toggleBoost,
        getEffectiveMuteForTurn,
        getEffectiveBoostForTurn,
        getEffectiveControlsForTurn,
        onGenerationStart,
        clearAllOverrides,
        getGlobalChatMuteStats,
        clearAllChatMutesGlobally,
        migrateChatKey,
        handleChatChanged,
        serializeSessionMutes,
        getCurrentChatId: () => currentChatId,
        getMutes: () => mutes,
        getBoosts: () => boosts,
        getLastScanResult: () => lastScanResult,
        setLastScanResult: (res) => { lastScanResult = res; },
        getHoveredEntryKey: () => hoveredEntryKey,
        setHoveredEntryKey: (key) => { hoveredEntryKey = key; },
        isCompactExpanded: () => compactExpanded,
        setCompactExpanded: (val) => { compactExpanded = Boolean(val); },
        getActiveGenerationContext: () => activeGenerationContext,
        setActiveGenerationContext: (ctx) => { activeGenerationContext = ctx; },
    };
}
