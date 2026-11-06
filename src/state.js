/**
 * Keyword Radar — Turn Lifecycle, Multi-Stage World Info Interception & Diagnostic Flight Recorder
 * https://github.com/serioos/Keyword-Radar
 */

import {
    getChatRadarMetadata,
    getSettings,
    getSTContext,
    saveChatRadarMetadata,
} from './st-bridge.js';
import { DEFAULT_SETTINGS } from './constants.js';
import { makeEntryKey } from './utils.js';

const MAX_DIAGNOSTIC_LOGS = 80;

export class RadarStateManager {
    /**
     * @param {() => void} onStateChange
     */
    constructor(onStateChange = () => {}) {
        this.onStateChange = onStateChange;
        /** @type {Map<string, any>} */
        this.mutes = new Map();
        /** @type {Map<string, any>} */
        this.boosts = new Map();

        /**
         * Stores 1-turn mutes/boosts after they are applied to a generation so:
         * 1. The Radar Bar immediately clears after the turn finishes (no manual unmute needed).
         * 2. Swipes/Regenerations on that same turn still re-apply the mute/boost.
         * 3. Deleting the user message (e.g. after Inspect Prompts) restores the 1-turn mute automatically.
         * @type {{
         *   userMsgCount: number,
         *   mutes: Map<string, any>,
         *   boosts: Map<string, any>,
         *   recursiveMutedKeys: Set<string>,
         *   recursiveMutedEntries: Array<any>,
         *   aiReplyReceived: boolean
         * } | null}
         */
        this.lastTurnSwipeMemory = null;

        /** @type {{ recursiveMutedKeys: Set<string>, recursiveMutedEntries: Array<any> } | null} */
        this.inFlightRecursiveSnapshot = null;

        /** @type {'new-only'|'new-and-history'|'all-active'|null} */
        this.filterModeOverride = null;
        this.isCollapsed = false;
        this.lastGenerationActions = [];
        this.diagnosticLogs = [];
        this.initTimestamp = Date.now();
        this.environmentEventTypes = {};
        this.currentGenerationMeta = null;
    }

    logDiagnosticEvent(eventName, details = {}) {
        const now = Date.now();
        this.diagnosticLogs.push({
            ts: new Date(now).toISOString(),
            elapsedMs: now - this.initTimestamp,
            event: eventName,
            details,
        });
        if (this.diagnosticLogs.length > MAX_DIAGNOSTIC_LOGS) {
            this.diagnosticLogs.splice(0, this.diagnosticLogs.length - MAX_DIAGNOSTIC_LOGS);
        }
    }

    clearDiagnosticLogs() {
        this.diagnosticLogs = [];
        this.logDiagnosticEvent('DIAGNOSTICS_CLEARED', {
            userMessageCount: this.getUserMessageCount(),
        });
    }

    recordEnvironmentEventTypes(rawEventTypes, boundEventsInfo) {
        const relevantKeys = [
            'WORLDINFO_ENTRIES_LOADED',
            'WORLDINFO_SCAN_DONE',
            'WORLD_INFO_ACTIVATED',
            'WORLDINFO_FORCE_ACTIVATE',
            'CHAT_COMPLETION_PROMPT_READY',
            'GENERATE_AFTER_DATA',
            'GENERATION_STARTED',
            'GENERATION_STOPPED',
            'GENERATION_ENDED',
            'MESSAGE_SENT',
            'MESSAGE_RECEIVED',
            'MESSAGE_SWIPED',
            'MESSAGE_EDITED',
            'MESSAGE_DELETED',
        ];
        const availableInST = {};
        for (const k of relevantKeys) {
            availableInST[k] = rawEventTypes?.[k] ?? null;
        }
        this.environmentEventTypes = {
            availableInST,
            boundByKeywordRadar: boundEventsInfo,
            totalSTEventKeys: Object.keys(rawEventTypes || {}).length,
        };
        this.logDiagnosticEvent('EVENTS_BOUND', this.environmentEventTypes);
    }

    buildDiagnosticReport(extraContext = {}) {
        const ctx = getSTContext();
        const settings = getSettings();

        return {
            reportGeneratedAt: new Date().toISOString(),
            extension: 'Keyword Radar v1.2.1',
            environment: {
                userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : 'node',
                mainApi: ctx.mainApi ?? ctx.main_api ?? null,
                characterId: ctx.characterId ?? null,
                characterName: ctx.name2 ?? null,
                groupId: ctx.groupId ?? null,
                chatLength: Array.isArray(ctx.chat) ? ctx.chat.length : 0,
                userMessageCount: this.getUserMessageCount(),
                eventTypesInfo: this.environmentEventTypes,
            },
            settings: Object.fromEntries(
                Object.keys(DEFAULT_SETTINGS).map((key) => [key, settings[key]]),
            ),
            // Preserve visibility of stale preferences from older extension versions
            // without mixing them into the active settings shown in the report.
            legacySettingsIgnored: Object.keys(settings).filter((key) => !(key in DEFAULT_SETTINGS)),
            activeState: {
                mutes: Array.from(this.mutes.values()).map((m) => ({
                    entryKey: m.entryKey,
                    world: m.world,
                    uid: m.uid,
                    comment: m.comment,
                    mode: m.mode,
                    turnsRemaining: m.turnsRemaining === Infinity ? 'Infinity (session)' : m.turnsRemaining,
                    armedAtUserMsgCount: m.armedAtUserMsgCount,
                    lastAppliedAtUserMsgCount: m.lastAppliedAtUserMsgCount,
                    consumedInGeneration: m.consumedInGeneration,
                    contentLength: (m.content || '').length,
                })),
                boosts: Array.from(this.boosts.values()).map((b) => ({
                    entryKey: b.entryKey,
                    world: b.world,
                    uid: b.uid,
                    comment: b.comment,
                    mode: b.mode,
                    turnsRemaining: b.turnsRemaining,
                })),
                swipeMemoryForCurrentTurn: this.lastTurnSwipeMemory
                    ? {
                          userMsgCount: this.lastTurnSwipeMemory.userMsgCount,
                          aiReplyReceived: this.lastTurnSwipeMemory.aiReplyReceived,
                          mutes: Array.from(this.lastTurnSwipeMemory.mutes.keys()),
                          boosts: Array.from(this.lastTurnSwipeMemory.boosts.keys()),
                      }
                    : null,
                lastGenerationActions: this.lastGenerationActions,
            },
            scannerContext: extraContext,
            eventTrace: this.diagnosticLogs,
        };
    }

    getUserMessageCount() {
        const ctx = getSTContext();
        const chat = Array.isArray(ctx.chat) ? ctx.chat : [];
        let count = 0;
        for (const msg of chat) {
            if (msg && msg.is_user && !msg.is_system) count++;
        }
        return count;
    }

    enrichMutesFromLoadedEntries(loadedEntries) {
        if (!Array.isArray(loadedEntries) || this.mutes.size === 0) return;
        for (const entry of loadedEntries) {
            if (!entry) continue;
            const mute = this.mutes.get(entry.entryKey);
            if (mute) {
                if (!mute.content && entry.content) mute.content = entry.content;
                if ((!mute.key || mute.key.length === 0) && Array.isArray(entry.key)) mute.key = entry.key;
                if (!mute.comment && entry.comment) mute.comment = entry.comment;
            }
        }
    }

    syncFromChatMetadata() {
        this.mutes.clear();
        this.boosts.clear();
        this.lastTurnSwipeMemory = null;
        this.inFlightRecursiveSnapshot = null;
        this.lastGenerationActions = [];

        const meta = getChatRadarMetadata();
        if (Array.isArray(meta.sessionMutes)) {
            for (const item of meta.sessionMutes) {
                const entryKey = typeof item === 'string' ? item : item?.entryKey;
                if (!entryKey) continue;
                this.mutes.set(entryKey, {
                    entryKey,
                    world: (typeof item === 'object' ? item.world : entryKey.split(':::')[0]) || '',
                    uid: (typeof item === 'object' ? item.uid : entryKey.split(':::')[1]) ?? '',
                    comment: (typeof item === 'object' ? item.comment : '') || '',
                    content: (typeof item === 'object' ? item.content : '') || '',
                    key: Array.isArray(item?.key) ? item.key : [],
                    mode: 'session',
                    turnsRemaining: Infinity,
                    armedAtUserMsgCount: this.getUserMessageCount(),
                    lastAppliedAtUserMsgCount: null,
                    consumedInGeneration: false,
                });
            }
        }
        this.logDiagnosticEvent('SYNC_CHAT_METADATA', { sessionMutesLoaded: this.mutes.size });
        this.notify();
    }

    persistSessionMutes() {
        const meta = getChatRadarMetadata();
        const sessionList = [];
        for (const mute of this.mutes.values()) {
            if (mute.mode === 'session') {
                sessionList.push({
                    entryKey: mute.entryKey,
                    world: mute.world,
                    uid: mute.uid,
                    comment: mute.comment,
                });
            }
        }
        meta.sessionMutes = sessionList;
        saveChatRadarMetadata();
    }

    isMuted(entryKey) {
        return this.mutes.has(entryKey);
    }

    getMuteInfo(entryKey) {
        return this.mutes.get(entryKey) || null;
    }

    isBoosted(entryKey) {
        return this.boosts.has(entryKey);
    }

    getBoostInfo(entryKey) {
        return this.boosts.get(entryKey) || null;
    }

    toggleOneTurnMute(entry) {
        const key = entry.entryKey || makeEntryKey(entry.world, entry.uid);
        if (this.mutes.has(key)) {
            this.removeMute(key);
            return false;
        }
        this.setMute(entry, 'one-turn', 1);
        return true;
    }

    setMute(entry, mode = 'one-turn', turns = 1) {
        const key = entry.entryKey || makeEntryKey(entry.world, entry.uid);
        // A boost may have moved into swipe memory after the previous response.
        // Remove both active and swipe-persisted boosts before arming a mute, or a
        // swipe/regeneration could carry conflicting force-activate + suppress actions.
        if (this.boosts.has(key) || this.lastTurnSwipeMemory?.boosts?.has(key)) {
            this.removeBoost(key, false);
        }

        const userMsgCount = this.getUserMessageCount();
        const muteRecord = {
            entryKey: key,
            world: String(entry.world ?? '').trim(),
            uid: entry.uid,
            comment: entry.comment || `Entry #${entry.uid}`,
            content: String(entry.content ?? ''),
            key: Array.isArray(entry.key) ? [...entry.key] : [],
            mode,
            turnsRemaining: mode === 'session' ? Infinity : Math.max(1, Number(turns) || 1),
            armedAtUserMsgCount: userMsgCount,
            lastAppliedAtUserMsgCount: null,
            consumedInGeneration: false,
        };

        this.mutes.set(key, muteRecord);
        this.logDiagnosticEvent('MUTE_ARMED', {
            entryKey: key,
            world: muteRecord.world,
            uid: muteRecord.uid,
            comment: muteRecord.comment,
            mode,
            turnsRemaining: muteRecord.turnsRemaining === Infinity ? 'session' : muteRecord.turnsRemaining,
            armedAtUserMsgCount: userMsgCount,
            contentLength: muteRecord.content.length,
        });

        if (mode === 'session') this.persistSessionMutes();
        this.notify();
    }

    removeMute(entryKey, notify = true) {
        let removedFromSwipeMemory = false;
        if (this.lastTurnSwipeMemory?.mutes?.has(entryKey)) {
            this.lastTurnSwipeMemory.mutes.delete(entryKey);
            removedFromSwipeMemory = true;
        }
        const existing = this.mutes.get(entryKey);
        const removedFromActiveState = Boolean(existing);
        if (removedFromActiveState) this.mutes.delete(entryKey);
        if (!removedFromActiveState && !removedFromSwipeMemory) return;

        this.logDiagnosticEvent('MUTE_REMOVED', {
            entryKey,
            comment: existing?.comment,
            reason: 'manual_unmute',
            removedFromActiveState,
            removedFromSwipeMemory,
        });
        if (existing?.mode === 'session') this.persistSessionMutes();
        if (notify) this.notify();
    }

    clearAllMutes(includeSession = true) {
        this.lastTurnSwipeMemory = null;
        if (includeSession) {
            this.mutes.clear();
            this.persistSessionMutes();
        } else {
            for (const [k, v] of this.mutes.entries()) {
                if (v.mode !== 'session') this.mutes.delete(k);
            }
        }
        this.logDiagnosticEvent('MUTES_CLEARED_ALL', { includeSession });
        this.notify();
    }

    toggleBoost(normalizedEntry, turns = 1) {
        const key = normalizedEntry.entryKey || makeEntryKey(normalizedEntry.world, normalizedEntry.uid);
        if (this.boosts.has(key)) {
            this.removeBoost(key);
            return false;
        }
        this.addBoost(normalizedEntry, turns);
        return true;
    }

    addBoost(normalizedEntry, turns = 1) {
        const key = normalizedEntry.entryKey || makeEntryKey(normalizedEntry.world, normalizedEntry.uid);
        // Symmetrically clear a mute retained for a possible swipe/regeneration;
        // boost and mute must never coexist for the same entry across the two stores.
        if (this.mutes.has(key) || this.lastTurnSwipeMemory?.mutes?.has(key)) {
            this.removeMute(key, false);
        }

        const userMsgCount = this.getUserMessageCount();
        this.boosts.set(key, {
            entryKey: key,
            world: normalizedEntry.world,
            uid: normalizedEntry.uid,
            comment: normalizedEntry.comment || `Entry #${normalizedEntry.uid}`,
            entrySnapshot: normalizedEntry,
            mode: turns > 1 ? 'multi-turn' : 'one-turn',
            turnsRemaining: Math.max(1, Number(turns) || 1),
            armedAtUserMsgCount: userMsgCount,
            lastAppliedAtUserMsgCount: null,
            consumedInGeneration: false,
        });

        this.logDiagnosticEvent('BOOST_ARMED', {
            entryKey: key,
            world: normalizedEntry.world,
            uid: normalizedEntry.uid,
            comment: normalizedEntry.comment,
            turns,
            armedAtUserMsgCount: userMsgCount,
        });
        this.notify();
    }

    removeBoost(entryKey, notify = true) {
        let removedFromSwipeMemory = false;
        if (this.lastTurnSwipeMemory?.boosts?.has(entryKey)) {
            this.lastTurnSwipeMemory.boosts.delete(entryKey);
            removedFromSwipeMemory = true;
        }
        const removedFromActiveState = this.boosts.delete(entryKey);
        if (removedFromActiveState || removedFromSwipeMemory) {
            this.logDiagnosticEvent('BOOST_REMOVED', {
                entryKey,
                removedFromActiveState,
                removedFromSwipeMemory,
            });
            if (notify) this.notify();
        }
    }

    _getEffectiveTurnOverrides(currentUserCount, passedRecursiveKeys = new Set(), passedRecursiveEntries = []) {
        const settings = getSettings();
        const effectiveMutes = new Map(this.mutes);
        const effectiveBoosts = new Map(this.boosts);

        const baseRecKeys = this.inFlightRecursiveSnapshot?.recursiveMutedKeys?.size
            ? this.inFlightRecursiveSnapshot.recursiveMutedKeys
            : passedRecursiveKeys;
        const baseRecEntries = this.inFlightRecursiveSnapshot?.recursiveMutedEntries?.length
            ? this.inFlightRecursiveSnapshot.recursiveMutedEntries
            : passedRecursiveEntries;

        const effectiveRecursiveKeys = new Set(baseRecKeys || []);
        const effectiveRecursiveEntries = Array.isArray(baseRecEntries) ? [...baseRecEntries] : [];

        const genType = this.currentGenerationMeta?.type || 'normal';
        const isSwipeOrRegen =
            genType === 'swipe' ||
            genType === 'regenerate' ||
            (this.lastTurnSwipeMemory && !this.lastTurnSwipeMemory.aiReplyReceived);

        if (
            settings.persistMuteAcrossSwipes &&
            this.lastTurnSwipeMemory &&
            this.lastTurnSwipeMemory.userMsgCount === currentUserCount &&
            isSwipeOrRegen
        ) {
            for (const [k, m] of this.lastTurnSwipeMemory.mutes.entries()) {
                if (!effectiveMutes.has(k)) effectiveMutes.set(k, m);
            }
            for (const [k, b] of this.lastTurnSwipeMemory.boosts.entries()) {
                if (!effectiveBoosts.has(k)) effectiveBoosts.set(k, b);
            }
            for (const rk of this.lastTurnSwipeMemory.recursiveMutedKeys) {
                effectiveRecursiveKeys.add(rk);
            }
            for (const re of this.lastTurnSwipeMemory.recursiveMutedEntries) {
                if (!effectiveRecursiveEntries.some((x) => x.entryKey === re.entryKey)) {
                    effectiveRecursiveEntries.push(re);
                }
            }
        }

        return {
            effectiveMutes,
            effectiveBoosts,
            effectiveRecursiveKeys,
            effectiveRecursiveEntries,
        };
    }

    matchMutedItem(
        rawItem,
        recursiveMutedKeys = new Set(),
        recursiveMutedEntries = [],
        fallbackWorldName = '',
        mutesMapOverride = null,
    ) {
        if (!rawItem || typeof rawItem !== 'object') {
            return { matched: false, reason: null, matchedKey: null, muteObj: null };
        }

        const activeMutesMap = mutesMapOverride || this.mutes;
        const settings = getSettings();
        const itemWorld = String(rawItem.world ?? fallbackWorldName ?? '').trim();
        const itemUid = String(rawItem.uid ?? rawItem.id ?? '').trim();
        const compositeKey = makeEntryKey(itemWorld, itemUid);

        if (activeMutesMap.has(compositeKey)) {
            return {
                matched: true,
                reason: 'muted',
                matchedKey: compositeKey,
                muteObj: activeMutesMap.get(compositeKey),
            };
        }

        const itemWorldLower = itemWorld.toLowerCase();
        const itemComment = String(rawItem.comment ?? '').trim();
        const itemContent = String(rawItem.content ?? '').trim();

        for (const [mKey, mute] of activeMutesMap.entries()) {
            const muteUidStr = String(mute.uid ?? '').trim();
            const muteWorldLower = String(mute.world ?? '').trim().toLowerCase();

            if (itemUid && muteUidStr === itemUid) {
                if (itemWorldLower && muteWorldLower && itemWorldLower === muteWorldLower) {
                    return { matched: true, reason: 'muted', matchedKey: mKey, muteObj: mute };
                }
                if (!itemWorld && mute.comment && itemComment && mute.comment === itemComment) {
                    return { matched: true, reason: 'muted', matchedKey: mKey, muteObj: mute };
                }
                if (mute.content && itemContent && mute.content.trim() === itemContent) {
                    return { matched: true, reason: 'muted', matchedKey: mKey, muteObj: mute };
                }
            }
        }

        if (settings.muteBlocksRecursion) {
            if (recursiveMutedKeys && recursiveMutedKeys.has(compositeKey)) {
                return {
                    matched: true,
                    reason: 'muted-recursive',
                    matchedKey: compositeKey,
                    muteObj: null,
                };
            }
            if (Array.isArray(recursiveMutedEntries) && recursiveMutedEntries.length > 0) {
                for (const recEntry of recursiveMutedEntries) {
                    const recUidStr = String(recEntry.uid ?? '').trim();
                    const recWorldLower = String(recEntry.world ?? '').trim().toLowerCase();
                    if (itemUid && recUidStr === itemUid && itemWorldLower === recWorldLower) {
                        return {
                            matched: true,
                            reason: 'muted-recursive',
                            matchedKey: recEntry.entryKey,
                            muteObj: null,
                        };
                    }
                }
            }
        }

        return { matched: false, reason: null, matchedKey: null, muteObj: null };
    }

    onGenerationStarted(
        type = 'normal',
        dryRun = false,
        recursiveMutedKeys = new Set(),
        recursiveMutedEntries = [],
    ) {
        const userMsgCount = this.getUserMessageCount();
        this.currentGenerationMeta = {
            type: String(type || 'normal'),
            dryRun: Boolean(dryRun),
            startedAt: Date.now(),
            userMsgCount,
        };
        // Keep per-generation diagnostics scoped to this generation. Without this
        // reset, a generation that does not apply a new override can report stale
        // mute/boost actions from the previous generation.
        this.lastGenerationActions = [];

        if (!dryRun) {
            this.inFlightRecursiveSnapshot = {
                recursiveMutedKeys: new Set(recursiveMutedKeys || []),
                recursiveMutedEntries: Array.isArray(recursiveMutedEntries) ? [...recursiveMutedEntries] : [],
            };
            this._expirePreviousTurnConsumablesIfNeeded(userMsgCount, 'GENERATION_STARTED');
        }

        this.logDiagnosticEvent('GENERATION_STARTED', {
            type: String(type || 'normal'),
            dryRun: Boolean(dryRun),
            userMsgCount,
            activeMutesCount: this.mutes.size,
            activeBoostsCount: this.boosts.size,
        });
    }

    onUserMessageSent(recursiveMutedKeys = new Set(), recursiveMutedEntries = []) {
        const currentUserCount = this.getUserMessageCount();
        if (this.lastTurnSwipeMemory && currentUserCount > this.lastTurnSwipeMemory.userMsgCount) {
            this.lastTurnSwipeMemory = null;
        }
        if (recursiveMutedKeys?.size > 0 && !this.inFlightRecursiveSnapshot?.recursiveMutedKeys?.size) {
            this.inFlightRecursiveSnapshot = {
                recursiveMutedKeys: new Set(recursiveMutedKeys),
                recursiveMutedEntries: Array.isArray(recursiveMutedEntries) ? [...recursiveMutedEntries] : [],
            };
        }

        const changed = this._expirePreviousTurnConsumablesIfNeeded(currentUserCount, 'MESSAGE_SENT');

        this.logDiagnosticEvent('MESSAGE_SENT', {
            currentUserCount,
            activeMutesRemaining: Array.from(this.mutes.keys()),
            activeBoostsRemaining: Array.from(this.boosts.keys()),
        });

        if (changed) this.notify();
    }

    onAiMessageReceived() {
        const currentUserCount = this.getUserMessageCount();
        if (this.lastTurnSwipeMemory && this.lastTurnSwipeMemory.userMsgCount === currentUserCount) {
            this.lastTurnSwipeMemory.aiReplyReceived = true;
        }
        const changed = this._finalizeTurnAndMoveOneTurnToSwipeMemory(currentUserCount, true);

        this.logDiagnosticEvent('MESSAGE_RECEIVED', {
            currentUserCount,
            activeMutesCount: this.mutes.size,
        });

        if (changed) this.notify();
    }

    onGenerationStoppedOrEnded(eventName) {
        const hasConsumedOverrides =
            Array.from(this.mutes.values()).some((item) => item.consumedInGeneration) ||
            Array.from(this.boosts.values()).some((item) => item.consumedInGeneration);
        const hasActiveLifecycle = Boolean(
            this.currentGenerationMeta || this.inFlightRecursiveSnapshot || hasConsumedOverrides,
        );

        // SillyTavern can emit both GENERATION_STOPPED and GENERATION_ENDED for a
        // stopped request. Some generation paths can also deliver another terminal
        // notification after the first one. Finalize the one-turn state only once.
        // The consumed-override fallback still supports prompt inspections / older
        // integrations where WORLDINFO hooks ran without GENERATION_STARTED.
        if (!hasActiveLifecycle) {
            this.logDiagnosticEvent('GENERATION_TERMINAL_DUPLICATE_IGNORED', {
                eventName,
                userMessageCount: this.getUserMessageCount(),
                reason: 'no_active_generation_or_consumed_overrides',
            });
            return false;
        }

        const currentUserCount = this.getUserMessageCount();
        const changed = this._finalizeTurnAndMoveOneTurnToSwipeMemory(currentUserCount, false);
        this.inFlightRecursiveSnapshot = null;
        this.currentGenerationMeta = null;

        this.logDiagnosticEvent(eventName, {
            userMessageCount: currentUserCount,
            activeMutesCount: this.mutes.size,
            swipeMemoryMutes: this.lastTurnSwipeMemory ? Array.from(this.lastTurnSwipeMemory.mutes.keys()) : [],
            swipeMemoryBoosts: this.lastTurnSwipeMemory ? Array.from(this.lastTurnSwipeMemory.boosts.keys()) : [],
            lastGenerationActions: this.lastGenerationActions,
        });

        if (changed) this.notify();
        return true;
    }

    /**
     * When the user deletes a message (e.g. deleting their test user message after Inspect Prompts),
     * restore any 1-turn mutes/boosts from `lastTurnSwipeMemory` if no AI reply was received!
     */
    onMessageDeleted() {
        const currentUserCount = this.getUserMessageCount();
        let restoredMutes = 0;
        let restoredBoosts = 0;

        if (
            this.lastTurnSwipeMemory &&
            currentUserCount < this.lastTurnSwipeMemory.userMsgCount &&
            !this.lastTurnSwipeMemory.aiReplyReceived
        ) {
            for (const [k, m] of this.lastTurnSwipeMemory.mutes.entries()) {
                m.consumedInGeneration = false;
                m.lastAppliedAtUserMsgCount = null;
                m.armedAtUserMsgCount = currentUserCount;
                this.mutes.set(k, m);
                restoredMutes++;
            }
            for (const [k, b] of this.lastTurnSwipeMemory.boosts.entries()) {
                b.consumedInGeneration = false;
                b.lastAppliedAtUserMsgCount = null;
                b.armedAtUserMsgCount = currentUserCount;
                this.boosts.set(k, b);
                restoredBoosts++;
            }
            this.lastTurnSwipeMemory = null;
        }

        for (const mute of this.mutes.values()) {
            if (mute.lastAppliedAtUserMsgCount !== null && mute.lastAppliedAtUserMsgCount > currentUserCount) {
                mute.lastAppliedAtUserMsgCount = currentUserCount;
            }
        }

        const restoredAnyOverrides = restoredMutes + restoredBoosts > 0;
        this.logDiagnosticEvent('MESSAGE_DELETED', {
            currentUserCount,
            restoredOneTurnMutesAfterInspectAbort: restoredMutes > 0,
            restoredOneTurnBoostsAfterInspectAbort: restoredBoosts > 0,
            restoredOneTurnOverridesAfterInspectAbort: restoredAnyOverrides,
            restoredMutesCount: restoredMutes,
            restoredBoostsCount: restoredBoosts,
        });

        if (restoredAnyOverrides) this.notify();
    }

    /**
     * Moves consumed 1-turn mutes/boosts out of `this.mutes` into `this.lastTurnSwipeMemory`
     * once the generation finishes so the Radar Bar immediately clears for the next draft,
     * while still remembering them if the user swipes/regenerates on this turn.
     */
    _finalizeTurnAndMoveOneTurnToSwipeMemory(currentUserCount, aiReplyArrived = false) {
        const settings = getSettings();
        let changed = false;

        for (const [key, mute] of this.mutes.entries()) {
            if (mute.mode === 'session') continue;
            if (!mute.consumedInGeneration) continue;

            if (mute.mode === 'one-turn' || mute.turnsRemaining <= 1) {
                this.mutes.delete(key);
                changed = true;

                if (settings.persistMuteAcrossSwipes) {
                    if (!this.lastTurnSwipeMemory || this.lastTurnSwipeMemory.userMsgCount !== currentUserCount) {
                        this.lastTurnSwipeMemory = {
                            userMsgCount: currentUserCount,
                            mutes: new Map(),
                            boosts: new Map(),
                            recursiveMutedKeys: new Set(this.inFlightRecursiveSnapshot?.recursiveMutedKeys || []),
                            recursiveMutedEntries: [...(this.inFlightRecursiveSnapshot?.recursiveMutedEntries || [])],
                            aiReplyReceived: aiReplyArrived,
                        };
                    }
                    this.lastTurnSwipeMemory.mutes.set(key, { ...mute });
                }
            }
        }

        for (const [key, boost] of this.boosts.entries()) {
            if (!boost.consumedInGeneration) continue;

            if (boost.mode === 'one-turn' || boost.turnsRemaining <= 1) {
                this.boosts.delete(key);
                changed = true;

                if (settings.persistMuteAcrossSwipes) {
                    if (!this.lastTurnSwipeMemory || this.lastTurnSwipeMemory.userMsgCount !== currentUserCount) {
                        this.lastTurnSwipeMemory = {
                            userMsgCount: currentUserCount,
                            mutes: new Map(),
                            boosts: new Map(),
                            recursiveMutedKeys: new Set(this.inFlightRecursiveSnapshot?.recursiveMutedKeys || []),
                            recursiveMutedEntries: [...(this.inFlightRecursiveSnapshot?.recursiveMutedEntries || [])],
                            aiReplyReceived: aiReplyArrived,
                        };
                    }
                    this.lastTurnSwipeMemory.boosts.set(key, { ...boost });
                }
            }
        }

        return changed;
    }

    _expirePreviousTurnConsumablesIfNeeded(currentUserCount, triggerSource) {
        let changed = false;

        for (const [key, mute] of this.mutes.entries()) {
            if (mute.mode === 'session') continue;
            if (
                mute.consumedInGeneration &&
                mute.lastAppliedAtUserMsgCount !== null &&
                currentUserCount > mute.lastAppliedAtUserMsgCount
            ) {
                mute.turnsRemaining -= 1;
                mute.consumedInGeneration = false;
                mute.lastAppliedAtUserMsgCount = null;
                mute.armedAtUserMsgCount = currentUserCount;
                if (mute.turnsRemaining <= 0) {
                    this.mutes.delete(key);
                    this.logDiagnosticEvent('MUTE_EXPIRED_NEXT_TURN', {
                        entryKey: key,
                        comment: mute.comment,
                        triggerSource,
                        currentUserCount,
                    });
                }
                changed = true;
            }
        }

        for (const [key, boost] of this.boosts.entries()) {
            if (
                boost.consumedInGeneration &&
                boost.lastAppliedAtUserMsgCount !== null &&
                currentUserCount > boost.lastAppliedAtUserMsgCount
            ) {
                boost.turnsRemaining -= 1;
                boost.consumedInGeneration = false;
                boost.lastAppliedAtUserMsgCount = null;
                boost.armedAtUserMsgCount = currentUserCount;
                if (boost.turnsRemaining <= 0) {
                    this.boosts.delete(key);
                }
                changed = true;
            }
        }

        return changed;
    }

    _markActiveOverridesApplied(currentUserCount) {
        const isDryRun = Boolean(this.currentGenerationMeta?.dryRun);
        if (isDryRun) return;

        for (const mute of this.mutes.values()) {
            if (mute.mode === 'session') continue;
            mute.consumedInGeneration = true;
            mute.lastAppliedAtUserMsgCount = currentUserCount;
        }

        for (const boost of this.boosts.values()) {
            boost.consumedInGeneration = true;
            boost.lastAppliedAtUserMsgCount = currentUserCount;
        }
    }

    /**
     * STAGE 1 (PRIMARY): Intercepts `WORLDINFO_ENTRIES_LOADED` (`{ globalLore, characterLore, chatLore, personaLore }`)
     */
    applyToLoadedEntries(loadedEntriesPayload, recursiveMutedKeys = new Set(), recursiveMutedEntries = []) {
        const removed = [];
        const added = [];

        if (!loadedEntriesPayload || typeof loadedEntriesPayload !== 'object') {
            return { removed, added };
        }

        const currentUserCount = this.getUserMessageCount();
        this._expirePreviousTurnConsumablesIfNeeded(currentUserCount, 'WORLDINFO_ENTRIES_LOADED');

        const {
            effectiveMutes,
            effectiveBoosts,
            effectiveRecursiveKeys,
            effectiveRecursiveEntries,
        } = this._getEffectiveTurnOverrides(currentUserCount, recursiveMutedKeys, recursiveMutedEntries);

        const bucketNames = ['globalLore', 'characterLore', 'chatLore', 'personaLore'];
        const countsBefore = {};
        const countsAfter = {};

        const filterArrayInPlace = (arr, bucketLabel) => {
            if (!Array.isArray(arr)) return;
            countsBefore[bucketLabel] = arr.length;

            for (let i = arr.length - 1; i >= 0; i--) {
                const item = arr[i];
                if (!item) continue;

                const matchRes = this.matchMutedItem(
                    item,
                    effectiveRecursiveKeys,
                    effectiveRecursiveEntries,
                    '',
                    effectiveMutes,
                );
                if (matchRes.matched) {
                    if (matchRes.muteObj && !matchRes.muteObj.content && item.content) {
                        matchRes.muteObj.content = String(item.content);
                    }
                    arr.splice(i, 1);
                    removed.push({
                        entryKey: matchRes.matchedKey || makeEntryKey(item.world, item.uid),
                        world: item.world || '',
                        uid: item.uid,
                        comment: item.comment || `Entry #${item.uid}`,
                        reason: matchRes.reason || 'muted',
                        bucket: bucketLabel,
                        stage: 'WORLDINFO_ENTRIES_LOADED',
                    });
                }
            }

            countsAfter[bucketLabel] = arr.length;
        };

        for (const bName of bucketNames) {
            if (Array.isArray(loadedEntriesPayload[bName])) {
                filterArrayInPlace(loadedEntriesPayload[bName], bName);
            }
        }
        if (Array.isArray(loadedEntriesPayload)) {
            filterArrayInPlace(loadedEntriesPayload, 'rootArray');
        }

        if (effectiveBoosts.size > 0) {
            const chooseTargetBucket = (scope) => {
                const preferredName = ({
                    global: 'globalLore',
                    chat: 'chatLore',
                    character: 'characterLore',
                    persona: 'personaLore',
                })[scope];
                if (preferredName && Array.isArray(loadedEntriesPayload[preferredName])) {
                    return loadedEntriesPayload[preferredName];
                }
                // Older ST payloads may not expose every scope bucket. Preserve a
                // safe fallback rather than dropping a requested boost.
                return ['globalLore', 'chatLore', 'characterLore', 'personaLore']
                    .map((name) => loadedEntriesPayload[name])
                    .find(Array.isArray)
                    || (Array.isArray(loadedEntriesPayload) ? loadedEntriesPayload : null);
            };

            let targetBucket = null;

            {
                const existingKeys = new Set();
                for (const bName of bucketNames) {
                    const arr = loadedEntriesPayload[bName];
                    if (Array.isArray(arr)) {
                        for (const it of arr) {
                            if (it) existingKeys.add(makeEntryKey(it.world, it.uid));
                        }
                    }
                }

                for (const [key, boost] of effectiveBoosts.entries()) {
                    if (!boost.entrySnapshot) continue;
                    const snap = boost.entrySnapshot;
                    targetBucket = chooseTargetBucket(snap.scope);

                    let forcedExisting = false;
                    for (const bName of bucketNames) {
                        const arr = loadedEntriesPayload[bName];
                        if (!Array.isArray(arr)) continue;
                        for (const it of arr) {
                            if (it && makeEntryKey(it.world, it.uid) === key) {
                                it.constant = true;
                                it.disable = false;
                                it.probability = 100;
                                // SillyTavern checks delayUntilRecursion before constant
                                // activation. A manual boost is intended to force the
                                // entry now, so clear this gate for this scan only.
                                it.delayUntilRecursion = 0;
                                it.delay = 0;
                                forcedExisting = true;
                            }
                        }
                    }

                    if (!forcedExisting && !existingKeys.has(key) && Array.isArray(targetBucket)) {
                        const rawClone = snap.raw ? { ...snap.raw } : {};
                        targetBucket.push({
                            ...rawClone,
                            uid: snap.uid,
                            world: snap.world,
                            key: Array.isArray(snap.key) ? [...snap.key] : [],
                            keysecondary: Array.isArray(snap.keysecondary) ? [...snap.keysecondary] : [],
                            comment: snap.comment,
                            content: snap.content,
                            order: snap.order ?? 100,
                            position: snap.position ?? 0,
                            depth: snap.depth ?? 4,
                            role: snap.role ?? 0,
                            constant: true,
                            disable: false,
                            probability: 100,
                            delayUntilRecursion: 0,
                            delay: 0,
                        });
                    }

                    added.push({
                        entryKey: key,
                        world: snap.world,
                        uid: snap.uid,
                        comment: snap.comment,
                        stage: 'WORLDINFO_ENTRIES_LOADED',
                    });
                }
            }
        }

        if (effectiveMutes.size > 0 || effectiveBoosts.size > 0) {
            this._markActiveOverridesApplied(currentUserCount);
        }

        if (removed.length > 0 || added.length > 0) {
            this.lastGenerationActions = [
                ...removed.map((r) => ({ ...r, action: /** @type {'muted'} */ ('muted') })),
                ...added.map((a) => ({ ...a, action: /** @type {'boosted'} */ ('boosted') })),
            ];
        }

        this.logDiagnosticEvent('STAGE1_WORLDINFO_ENTRIES_LOADED', {
            currentUserCount,
            activeMutesCount: effectiveMutes.size,
            activeBoostsCount: effectiveBoosts.size,
            countsBefore,
            countsAfter,
            removedEntries: removed,
            addedBoosts: added,
        });

        return { removed, added };
    }

    /**
     * STAGE 2: Intercepts `WORLDINFO_SCAN_DONE`
     */
    applyToScanDone(
        scanDonePayload,
        recursiveMutedKeys = new Set(),
        recursiveMutedEntries = [],
        substituteFn = (value) => value,
    ) {
        const removed = [];
        if (!scanDonePayload || typeof scanDonePayload !== 'object') return { removed };

        const currentUserCount = this.getUserMessageCount();
        const {
            effectiveMutes,
            effectiveRecursiveKeys,
            effectiveRecursiveEntries,
        } = this._getEffectiveTurnOverrides(currentUserCount, recursiveMutedKeys, recursiveMutedEntries);

        const reportedRemovedKeys = new Set();
        const reportRemoved = (item, matchRes, colName) => {
            const entryKey = matchRes.matchedKey || makeEntryKey(item?.world, item?.uid);
            if (reportedRemovedKeys.has(entryKey)) return;
            reportedRemovedKeys.add(entryKey);
            removed.push({
                entryKey,
                comment: item?.comment,
                content: item?.content,
                collection: colName,
                reason: matchRes.reason || 'muted',
            });
        };

        const cleanCollection = (col, colName) => {
            if (col instanceof Map) {
                // Current SillyTavern stores activated World Info entries in a Map
                // keyed by `${world}.${uid}`. Mutate that Map in-place: the core reads
                // it after WORLDINFO_SCAN_DONE listeners return to build the prompt.
                for (const [mapKey, item] of Array.from(col.entries())) {
                    const mapKeyText = String(mapKey);
                    const separator = mapKeyText.lastIndexOf('.');
                    const matchTarget = item && typeof item === 'object'
                        ? {
                              ...item,
                              world: item.world ?? (separator >= 0 ? mapKeyText.slice(0, separator) : ''),
                              uid: item.uid ?? (separator >= 0 ? mapKeyText.slice(separator + 1) : mapKeyText),
                          }
                        : item;
                    const matchRes = this.matchMutedItem(
                        matchTarget,
                        effectiveRecursiveKeys,
                        effectiveRecursiveEntries,
                        '',
                        effectiveMutes,
                    );
                    if (matchRes.matched) {
                        col.delete(mapKey);
                        reportRemoved(matchTarget, matchRes, colName);
                    }
                }
            } else if (col instanceof Set) {
                for (const item of Array.from(col)) {
                    const matchRes = this.matchMutedItem(
                        item,
                        effectiveRecursiveKeys,
                        effectiveRecursiveEntries,
                        '',
                        effectiveMutes,
                    );
                    if (matchRes.matched) {
                        col.delete(item);
                        reportRemoved(item, matchRes, colName);
                    }
                }
            } else if (Array.isArray(col)) {
                for (let i = col.length - 1; i >= 0; i--) {
                    const item = col[i];
                    const matchRes = this.matchMutedItem(
                        item,
                        effectiveRecursiveKeys,
                        effectiveRecursiveEntries,
                        '',
                        effectiveMutes,
                    );
                    if (matchRes.matched) {
                        col.splice(i, 1);
                        reportRemoved(item, matchRes, colName);
                    }
                }
            }
        };

        // Current SillyTavern emits a structured object for every scan loop:
        // { state, new: { all, successful }, activated: { entries: Map, text }, ... }.
        // Keep compatibility with older builds that supplied arrays/sets at the root.
        if (scanDonePayload instanceof Set || Array.isArray(scanDonePayload)) {
            cleanCollection(scanDonePayload, 'root');
        } else {
            cleanCollection(scanDonePayload.new?.all, 'new.all');
            cleanCollection(scanDonePayload.new?.successful, 'new.successful');
            cleanCollection(scanDonePayload.activated?.entries, 'activated.entries');
            cleanCollection(scanDonePayload.sortedEntries, 'sortedEntries');

            // The event's text string is consumed by the core after listeners return.
            // Remove each muted injection from that exact mutable field as a final
            // safeguard; Stage 4 also verifies the final outgoing prompt.
            if (typeof scanDonePayload.activated?.text === 'string' && removed.length > 0) {
                let text = scanDonePayload.activated.text;
                for (const item of removed) {
                    const rawContent = String(item.content || '').trim();
                    if (!rawContent || rawContent.length < 4) continue;
                    const candidates = [rawContent];
                    try {
                        const substituted = String(substituteFn(rawContent) || '').trim();
                        if (substituted && substituted !== rawContent) candidates.push(substituted);
                    } catch {
                        // Macro substitution is best-effort; raw content remains available.
                    }
                    for (const needle of candidates) {
                        const index = text.indexOf(needle);
                        if (index >= 0) {
                            text = `${text.slice(0, index)}${text.slice(index + needle.length)}`;
                            break;
                        }
                    }
                }
                scanDonePayload.activated.text = text.replace(/\n{3,}/g, '\n\n').trim();
            }
        }

        this.logDiagnosticEvent('STAGE2_WORLDINFO_SCAN_DONE', {
            payloadKeys: Object.keys(scanDonePayload),
            scanState: scanDonePayload.state && typeof scanDonePayload.state === 'object'
                ? {
                      current: scanDonePayload.state.current ?? null,
                      next: scanDonePayload.state.next ?? null,
                      loopCount: scanDonePayload.state.loopCount ?? null,
                  }
                : null,
            recursionDelay: scanDonePayload.recursionDelay && typeof scanDonePayload.recursionDelay === 'object'
                ? {
                      currentLevel: scanDonePayload.recursionDelay.currentLevel ?? null,
                      availableLevels: Array.isArray(scanDonePayload.recursionDelay.availableLevels)
                          ? [...scanDonePayload.recursionDelay.availableLevels]
                          : [],
                  }
                : null,
            budget: scanDonePayload.budget && typeof scanDonePayload.budget === 'object'
                ? {
                      current: scanDonePayload.budget.current ?? null,
                      overflowed: Boolean(scanDonePayload.budget.overflowed),
                  }
                : null,
            removedCount: removed.length,
            removed: removed.map(({ content, ...item }) => ({ ...item, contentLength: String(content || '').length })),
        });

        return { removed };
    }

    /**
     * STAGE 3: Intercepts `WORLD_INFO_ACTIVATED`
     */
    applyToActivatedWorldInfo(entryList, recursiveMutedKeys = new Set(), recursiveMutedEntries = []) {
        if (!Array.isArray(entryList)) return { removed: [], added: [] };

        const currentUserCount = this.getUserMessageCount();
        this._expirePreviousTurnConsumablesIfNeeded(currentUserCount, 'WORLD_INFO_ACTIVATED');

        const {
            effectiveMutes,
            effectiveBoosts,
            effectiveRecursiveKeys,
            effectiveRecursiveEntries,
        } = this._getEffectiveTurnOverrides(currentUserCount, recursiveMutedKeys, recursiveMutedEntries);

        const countBefore = entryList.length;
        const removed = [];
        const added = [];

        for (let i = entryList.length - 1; i >= 0; i--) {
            const item = entryList[i];
            if (!item) continue;

            const matchRes = this.matchMutedItem(
                item,
                effectiveRecursiveKeys,
                effectiveRecursiveEntries,
                '',
                effectiveMutes,
            );
            if (matchRes.matched) {
                if (matchRes.muteObj && !matchRes.muteObj.content && item.content) {
                    matchRes.muteObj.content = String(item.content);
                }
                entryList.splice(i, 1);
                removed.push({
                    entryKey: matchRes.matchedKey || makeEntryKey(item.world, item.uid),
                    world: item.world,
                    uid: item.uid,
                    comment: item.comment || `Entry #${item.uid}`,
                    reason: matchRes.reason || 'muted',
                    stage: 'WORLD_INFO_ACTIVATED',
                });
            }
        }

        const existingKeys = new Set(entryList.map((item) => makeEntryKey(item?.world, item?.uid)));

        for (const [key, boost] of effectiveBoosts.entries()) {
            if (!existingKeys.has(key) && boost.entrySnapshot) {
                const snap = boost.entrySnapshot;
                const rawClone = snap.raw ? { ...snap.raw } : {};
                entryList.push({
                    ...rawClone,
                    uid: snap.uid,
                    world: snap.world,
                    key: Array.isArray(snap.key) ? [...snap.key] : [],
                    keysecondary: Array.isArray(snap.keysecondary) ? [...snap.keysecondary] : [],
                    comment: snap.comment,
                    content: snap.content,
                    order: snap.order ?? 100,
                    position: snap.position ?? 0,
                    depth: snap.depth ?? 4,
                    role: snap.role ?? 0,
                    constant: true,
                    disable: false,
                });
                existingKeys.add(key);
                added.push({
                    entryKey: key,
                    world: snap.world,
                    uid: snap.uid,
                    comment: snap.comment,
                    stage: 'WORLD_INFO_ACTIVATED',
                });
            }
        }

        if (effectiveMutes.size > 0 || effectiveBoosts.size > 0) {
            this._markActiveOverridesApplied(currentUserCount);
        }

        if (removed.length > 0 || added.length > 0) {
            this.lastGenerationActions = [
                ...removed.map((r) => ({ ...r, action: /** @type {'muted'} */ ('muted') })),
                ...added.map((a) => ({ ...a, action: /** @type {'boosted'} */ ('boosted') })),
            ];
        }

        this.logDiagnosticEvent('STAGE3_WORLD_INFO_ACTIVATED', {
            currentUserCount,
            countBefore,
            countAfter: entryList.length,
            removedInStage3: removed,
            addedInStage3: added,
            remainingActivatedEntries: entryList.map((e) => ({
                world: e?.world,
                uid: e?.uid,
                comment: e?.comment,
            })),
        });

        this.notify();
        return { removed, added };
    }

    /**
     * STAGE 4: Outgoing Prompt Verification & Safety Scrubber (`CHAT_COMPLETION_PROMPT_READY` / `GENERATE_AFTER_DATA`)
     */
    verifyAndScrubOutgoingPrompt(
        payload,
        hookName,
        recursiveMutedKeys = new Set(),
        recursiveMutedEntries = [],
        substituteFn = (s) => s,
    ) {
        const currentUserCount = this.getUserMessageCount();
        const {
            effectiveMutes,
            effectiveRecursiveEntries,
        } = this._getEffectiveTurnOverrides(currentUserCount, recursiveMutedKeys, recursiveMutedEntries);

        if (effectiveMutes.size === 0 && effectiveRecursiveEntries.length === 0) {
            return { leakedAndScrubbed: [] };
        }

        const targetsToVerify = [];
        for (const mute of effectiveMutes.values()) {
            const rawContent = String(mute.content || '').trim();
            if (!rawContent) continue;
            targetsToVerify.push({
                entryKey: mute.entryKey,
                comment: mute.comment,
                reason: 'muted',
                rawContent,
                subContent: substituteFn(rawContent).trim(),
            });
        }

        const settings = getSettings();
        if (settings.muteBlocksRecursion) {
            for (const rec of effectiveRecursiveEntries) {
                const rawContent = String(rec.content || '').trim();
                if (!rawContent) continue;
                targetsToVerify.push({
                    entryKey: rec.entryKey,
                    comment: rec.comment,
                    reason: 'muted-recursive',
                    rawContent,
                    subContent: substituteFn(rawContent).trim(),
                });
            }
        }

        if (targetsToVerify.length === 0) return { leakedAndScrubbed: [] };

        const leakedAndScrubbed = [];

        const scrubTextString = (text, locationLabel) => {
            if (typeof text !== 'string' || !text) return { text, modified: false };
            let updated = text;
            let modified = false;

            for (const target of targetsToVerify) {
                for (const needle of [target.subContent, target.rawContent]) {
                    if (needle && needle.length >= 4 && updated.includes(needle)) {
                        updated = updated.split(needle).join('').replace(/\n{3,}/g, '\n\n').trim();
                        modified = true;
                        leakedAndScrubbed.push({
                            entryKey: target.entryKey,
                            comment: target.comment,
                            reason: target.reason,
                            location: locationLabel,
                        });
                    }
                }
            }
            return { text: updated, modified };
        };

        const chatArray = Array.isArray(payload?.chat) ? payload.chat : null;
        if (chatArray) {
            for (let i = chatArray.length - 1; i >= 0; i--) {
                const msg = chatArray[i];
                if (!msg) continue;
                if (typeof msg.content === 'string') {
                    const res = scrubTextString(msg.content, `chat[${i}](role=${msg.role || 'unknown'})`);
                    if (res.modified) {
                        msg.content = res.text;
                        if (!msg.content.trim()) chatArray.splice(i, 1);
                    }
                }
            }
        }

        const genData = payload?.generateData;
        if (genData && typeof genData === 'object') {
            if (typeof genData.prompt === 'string') {
                const res = scrubTextString(genData.prompt, 'generateData.prompt');
                if (res.modified) genData.prompt = res.text;
            } else if (Array.isArray(genData.prompt)) {
                for (let i = genData.prompt.length - 1; i >= 0; i--) {
                    const m = genData.prompt[i];
                    if (m && typeof m.content === 'string') {
                        const res = scrubTextString(m.content, `generateData.prompt[${i}]`);
                        if (res.modified) m.content = res.text;
                    }
                }
            }
        }

        this.logDiagnosticEvent(`STAGE4_${hookName}_VERIFIED`, {
            checkedMutedTargets: targetsToVerify.map((t) => ({
                entryKey: t.entryKey,
                comment: t.comment,
                contentLen: t.subContent.length,
            })),
            cleanAtStage1: leakedAndScrubbed.length === 0,
            leakedAndScrubbedByStage4Fallback: leakedAndScrubbed,
        });

        return { leakedAndScrubbed };
    }

    notify() {
        if (typeof this.onStateChange === 'function') {
            this.onStateChange();
        }
    }
}