/**
 * Keyword Radar — Pre-Send Lorebook Scanner & One-Turn Mute for SillyTavern
 * https://github.com/serioos/Keyword-Radar
 *
 * Main Extension Entrypoint
 */

import { EXTENSION_DISPLAY_NAME, EXTENSION_NAME } from './src/constants.js';
import { DraftInputHighlighter } from './src/highlighter.js';
import { runPreSendRadarScan } from './src/scanner.js';
import {
    collectActiveLorebooksAndContext,
    countTokensAsync,
    getSettings,
    getSTContext,
    loadCoreModules,
    substituteMacros,
} from './src/st-bridge.js';
import { RadarStateManager } from './src/state.js';
import { RadarUIController } from './src/ui.js';
import { debounce, TokenCache } from './src/utils.js';

(() => {
    /** @type {Awaited<ReturnType<typeof collectActiveLorebooksAndContext>> | null} */
    let cachedLoreSnapshot = null;
    let lastSnapshotTimestamp = 0;
    const SNAPSHOT_TTL_MS = 3500;

    /** @type {ReturnType<typeof runPreSendRadarScan> | null} */
    let latestScanResult = null;

    /**
     * Preserves the scan result of the last non-empty draft so that when `#send_textarea`
     * is cleared on `MESSAGE_SENT`, the immediately following World Info generation hooks
     * still know which recursive children were blocked by a parent mute.
     * @type {ReturnType<typeof runPreSendRadarScan> | null}
     */
    let lastNonEmptyDraftScanResult = null;

    const tokenCache = new TokenCache(countTokensAsync);

    const highlighter = new DraftInputHighlighter();

    const stateManager = new RadarStateManager(() => {
        // Re-evaluate scan synchronously whenever mutes/boosts change
        runScanAgainstCachedLore(false);
    });

    const uiController = new RadarUIController({
        stateManager,
        highlighter,
        onRequestRescan: async (forceReload = true) => {
            await refreshLoreSnapshotAndScan(forceReload);
        },
        getAllLoadedEntries: () => cachedLoreSnapshot?.entries || [],
        getTokenCountForEntry: (entry) => getEntryTokensWithRefinement(entry),
        getDiagnosticSnapshotContext: () => ({
            cachedBookNames: (cachedLoreSnapshot?.books || []).map((b) => `${b.name} (${b.scope})`),
            totalLoadedEntries: cachedLoreSnapshot?.entries?.length || 0,
            globalSettings: cachedLoreSnapshot?.globalSettings || null,
            latestScanSummary: latestScanResult?.summary || null,
            lastNonEmptyDraftSummary: lastNonEmptyDraftScanResult?.summary || null,
            lastNonEmptyDraftDetected: (lastNonEmptyDraftScanResult?.items || []).map((it) => ({
                entryKey: it.entryKey,
                world: it.entry.world,
                uid: it.entry.uid,
                comment: it.entry.comment,
                status: it.status,
                isMuted: it.isMuted,
                isRecursive: it.isRecursive,
                tokens: it.tokens,
                matchedPrimaryKeys: it.matchedPrimaryKeys,
            })),
        }),
    });

    let debouncedDraftScan = debounce(() => {
        runScanAgainstCachedLore(false);
    }, 160);

    /**
     * Computes or retrieves cached token count for a Lorebook entry,
     * triggering a quiet UI re-render once exact async tokenization completes.
     * @param {any} entry
     * @returns {number}
     */
    function getEntryTokensWithRefinement(entry) {
        if (!entry || !entry.content) return 0;
        return tokenCache.getEntryTokens(entry.world, entry.uid, entry.content, () => {
            scheduleQuietTokenRefresh();
        });
    }

    const scheduleQuietTokenRefresh = debounce(() => {
        runScanAgainstCachedLore(false);
    }, 120);

    /**
     * Reads current draft text from `#send_textarea`.
     * @returns {string}
     */
    function getDraftText() {
        const ta = /** @type {HTMLTextAreaElement|null} */ (document.querySelector('#send_textarea'));
        return ta ? String(ta.value || '') : '';
    }

    /**
     * Synchronously updates `cachedLoreSnapshot.scanContext.chatMessages` from `getSTContext()`
     * so chat history depth buffers are always accurate right after send/delete/swipe.
     */
    function syncLiveChatMessagesIntoSnapshot() {
        if (!cachedLoreSnapshot?.scanContext) return;
        const ctx = getSTContext();
        const rawChat = Array.isArray(ctx.chat) ? ctx.chat : [];
        cachedLoreSnapshot.scanContext.chatMessages = rawChat
            .filter((m) => m && !m.is_system && typeof m.mes === 'string')
            .map((m) => ({
                name: m.name || (m.is_user ? (ctx.name1 || 'User') : (ctx.name2 || 'Character')),
                mes: m.mes,
                is_user: Boolean(m.is_user),
                is_system: Boolean(m.is_system),
            }));
        cachedLoreSnapshot.scanContext.totalChatLength = rawChat.length;
    }

    /**
     * Returns the active recursive-muted keys and entry metadata from either the current scan
     * or the last non-empty draft scan (if `#send_textarea` was just cleared by pressing Send).
     */
    function getActiveRecursiveMuteContext() {
        const activeScan =
            (latestScanResult?.recursiveMutedKeys?.size || 0) > 0
                ? latestScanResult
                : (lastNonEmptyDraftScanResult || latestScanResult);

        const recursiveMutedKeys = new Set(activeScan?.recursiveMutedKeys || []);
        const recursiveMutedEntries = [];

        if (activeScan?.resultsMap) {
            for (const key of recursiveMutedKeys) {
                const item = activeScan.resultsMap.get(key);
                if (item?.entry) {
                    recursiveMutedEntries.push({
                        entryKey: key,
                        world: item.entry.world,
                        uid: item.entry.uid,
                        comment: item.entry.comment,
                        content: item.entry.content,
                    });
                }
            }
        }

        return { recursiveMutedKeys, recursiveMutedEntries };
    }

    /**
     * Reloads active Lorebooks (Character, Chat, Persona, Global) if needed and runs the pre-send scan.
     * @param {boolean} [forceReload=false]
     */
    async function refreshLoreSnapshotAndScan(forceReload = false) {
        const settings = getSettings();
        if (!settings.enabled) {
            highlighter.setEnabled(false);
            uiController.render(null);
            return;
        }

        const now = Date.now();
        if (forceReload || !cachedLoreSnapshot || now - lastSnapshotTimestamp > SNAPSHOT_TTL_MS) {
            try {
                cachedLoreSnapshot = await collectActiveLorebooksAndContext();
                lastSnapshotTimestamp = Date.now();
                stateManager.enrichMutesFromLoadedEntries(cachedLoreSnapshot.entries);
            } catch (err) {
                console.warn(`[${EXTENSION_DISPLAY_NAME}] Failed to collect active lorebooks:`, err);
            }
        }

        runScanAgainstCachedLore(false);
    }

    /**
     * Executes `runPreSendRadarScan` synchronously using the cached Lorebook snapshot
     * and updates both the Radar Bar UI and the `#send_textarea` backdrop highlighter.
     * @param {boolean} [refreshSnapshotInBackground=true]
     */
    function runScanAgainstCachedLore(refreshSnapshotInBackground = true) {
        const settings = getSettings();
        if (!settings.enabled) {
            highlighter.setEnabled(false);
            uiController.render(null);
            return;
        }

        if (!cachedLoreSnapshot) {
            if (refreshSnapshotInBackground) {
                refreshLoreSnapshotAndScan(true);
            }
            return;
        }

        syncLiveChatMessagesIntoSnapshot();
        stateManager.enrichMutesFromLoadedEntries(cachedLoreSnapshot.entries);

        const draftText = getDraftText();
        const mutedKeys = new Set(stateManager.mutes.keys());

        latestScanResult = runPreSendRadarScan({
            draftText,
            entries: cachedLoreSnapshot.entries,
            globalSettings: cachedLoreSnapshot.globalSettings,
            scanContext: cachedLoreSnapshot.scanContext,
            mutedKeys,
            boostedEntriesMap: stateManager.boosts,
            muteBlocksRecursion: Boolean(settings.muteBlocksRecursion),
            simulateRecursionAlways: Boolean(settings.simulateRecursionAlways),
            maxRecursionDepth: Number(settings.maxRecursionDepth || 6),
            substituteFn: substituteMacros,
            tokenCounterFn: (entry) => getEntryTokensWithRefinement(entry),
        });

        // Only update lastNonEmptyDraftScanResult when the user actually has draft text
        if (draftText.trim().length > 0) {
            lastNonEmptyDraftScanResult = latestScanResult;
        }

        highlighter.setEnabled(Boolean(settings.highlightInInput));
        highlighter.render(draftText, latestScanResult.draftSpans);
        uiController.render(latestScanResult);
    }

    /**
     * Rebuilds the debounced input scanner when `scanDelayMs` changes in settings.
     */
    function updateDebounceTiming() {
        const settings = getSettings();
        debouncedDraftScan.cancel();
        debouncedDraftScan = debounce(() => {
            const now = Date.now();
            if (!cachedLoreSnapshot || now - lastSnapshotTimestamp > SNAPSHOT_TTL_MS) {
                refreshLoreSnapshotAndScan(true);
            } else {
                runScanAgainstCachedLore(false);
            }
        }, settings.scanDelayMs || 160);
    }

    /**
     * Loads and mounts `settings.html` into SillyTavern's `#extensions_settings2` (or `#extensions_settings`).
     */
    async function mountSettingsDrawer() {
        const container = document.querySelector('#extensions_settings2') || document.querySelector('#extensions_settings');
        if (!container) return;

        try {
            const settingsUrl = new URL('./settings.html', import.meta.url).href;
            const resp = await fetch(settingsUrl);
            if (!resp.ok) return;
            const html = await resp.text();

            const wrapper = document.createElement('div');
            wrapper.innerHTML = html;
            container.appendChild(wrapper);

            uiController.bindSettingsPanel(wrapper, () => {
                updateDebounceTiming();
                refreshLoreSnapshotAndScan(true);
            });
        } catch (err) {
            console.warn(`[${EXTENSION_DISPLAY_NAME}] Could not load settings.html:`, err);
        }
    }

    /**
     * Binds typing & focus listeners to `#send_textarea` and World Info UI selectors.
     */
    function bindDomListeners() {
        const textarea = /** @type {HTMLTextAreaElement|null} */ (document.querySelector('#send_textarea'));
        if (textarea) {
            highlighter.attach(textarea);

            textarea.addEventListener('input', () => {
                debouncedDraftScan();
            });

            textarea.addEventListener('focus', () => {
                const now = Date.now();
                if (!cachedLoreSnapshot || now - lastSnapshotTimestamp > SNAPSHOT_TTL_MS) {
                    refreshLoreSnapshotAndScan(true);
                } else {
                    runScanAgainstCachedLore(false);
                }
            });
        }

        // Watch Global World Info selector changes
        document.addEventListener('change', (e) => {
            const target = /** @type {HTMLElement|null} */ (e.target);
            if (!target) return;
            const id = target.id || '';
            if (
                id === 'world_info' ||
                id.startsWith('world_info_') ||
                target.closest('#WorldInfo')
            ) {
                setTimeout(() => refreshLoreSnapshotAndScan(true), 150);
            }
        });
    }

    /**
     * Registers SillyTavern lifecycle & World Info interception events across all 4 stages:
     * - Stage 1: WORLDINFO_ENTRIES_LOADED (`worldinfo_entries_loaded`) — Pre-scan mutable lore arrays
     * - Stage 2: WORLDINFO_SCAN_DONE (`worldinfo_scan_done`) — Post-scan mutable state
     * - Stage 3: WORLD_INFO_ACTIVATED (`world_info_activated`) — Post-activation entry list
     * - Stage 4: CHAT_COMPLETION_PROMPT_READY & GENERATE_AFTER_DATA — Outgoing prompt verification & fallback scrubber
     */
    async function bindSillyTavernEvents() {
        const core = await loadCoreModules();
        const ctx = getSTContext();
        const eventSource = ctx.eventSource || core.script?.eventSource;
        const eventTypes = ctx.eventTypes || ctx.event_types || core.script?.event_types || {};

        if (!eventSource || typeof eventSource.on !== 'function') {
            console.warn(`[${EXTENSION_DISPLAY_NAME}] SillyTavern eventSource not found.`);
            stateManager.logDiagnosticEvent('INIT_ERROR', { reason: 'eventSource not found' });
            return;
        }

        const boundEventsInfo = {
            WORLDINFO_ENTRIES_LOADED: eventTypes.WORLDINFO_ENTRIES_LOADED || 'worldinfo_entries_loaded',
            WORLDINFO_SCAN_DONE: eventTypes.WORLDINFO_SCAN_DONE || 'worldinfo_scan_done',
            WORLD_INFO_ACTIVATED: eventTypes.WORLD_INFO_ACTIVATED || 'world_info_activated',
            CHAT_COMPLETION_PROMPT_READY: eventTypes.CHAT_COMPLETION_PROMPT_READY || 'chat_completion_prompt_ready',
            GENERATE_AFTER_DATA: eventTypes.GENERATE_AFTER_DATA || 'generate_after_data',
            GENERATION_STARTED: eventTypes.GENERATION_STARTED || 'generation_started',
            GENERATION_STOPPED: eventTypes.GENERATION_STOPPED || 'generation_stopped',
            GENERATION_ENDED: eventTypes.GENERATION_ENDED || 'generation_ended',
            MESSAGE_SENT: eventTypes.MESSAGE_SENT || 'message_sent',
            MESSAGE_RECEIVED: eventTypes.MESSAGE_RECEIVED || 'message_received',
            MESSAGE_DELETED: eventTypes.MESSAGE_DELETED || 'message_deleted',
        };

        stateManager.recordEnvironmentEventTypes(eventTypes, boundEventsInfo);

        // Track GENERATION_STARTED (snapshots active mutes & recursive mutes for the entire generation)
        eventSource.on(boundEventsInfo.GENERATION_STARTED, (type, _options, dryRun) => {
            const { recursiveMutedKeys, recursiveMutedEntries } = getActiveRecursiveMuteContext();
            stateManager.onGenerationStarted(
                type,
                Boolean(dryRun),
                recursiveMutedKeys,
                recursiveMutedEntries,
            );
        });

        // Stage 1 (PRIMARY SUPPRESSION HOOK): WORLDINFO_ENTRIES_LOADED
        eventSource.on(boundEventsInfo.WORLDINFO_ENTRIES_LOADED, (loadedEntriesPayload) => {
            const settings = getSettings();
            if (!settings.enabled) return;

            const { recursiveMutedKeys, recursiveMutedEntries } = getActiveRecursiveMuteContext();
            const { removed, added } = stateManager.applyToLoadedEntries(
                loadedEntriesPayload,
                recursiveMutedKeys,
                recursiveMutedEntries,
            );

            if (removed.length > 0 || added.length > 0) {
                console.info(
                    `[${EXTENSION_DISPLAY_NAME}] [WORLDINFO_ENTRIES_LOADED] Pre-scan overrides applied — Muted: ${removed.length}, Boosted: ${added.length}`,
                );
            }
        });

        // Stage 2: WORLDINFO_SCAN_DONE (SillyTavern 1.15.0+)
        eventSource.on(boundEventsInfo.WORLDINFO_SCAN_DONE, (scanDonePayload) => {
            const settings = getSettings();
            if (!settings.enabled) return;

            const { recursiveMutedKeys, recursiveMutedEntries } = getActiveRecursiveMuteContext();
            stateManager.applyToScanDone(scanDonePayload, recursiveMutedKeys, recursiveMutedEntries);
        });

        // Stage 3: WORLD_INFO_ACTIVATED
        eventSource.on(boundEventsInfo.WORLD_INFO_ACTIVATED, (entryList) => {
            const settings = getSettings();
            if (!settings.enabled) return;

            const { recursiveMutedKeys, recursiveMutedEntries } = getActiveRecursiveMuteContext();
            const { removed, added } = stateManager.applyToActivatedWorldInfo(
                entryList,
                recursiveMutedKeys,
                recursiveMutedEntries,
            );

            if (removed.length > 0 || added.length > 0) {
                console.info(
                    `[${EXTENSION_DISPLAY_NAME}] [WORLD_INFO_ACTIVATED] Post-scan overrides applied — Muted: ${removed.length}, Boosted: ${added.length}`,
                );
            }
        });

        // Stage 4A: CHAT_COMPLETION_PROMPT_READY
        eventSource.on(boundEventsInfo.CHAT_COMPLETION_PROMPT_READY, (promptData) => {
            const settings = getSettings();
            if (!settings.enabled) return;

            const { recursiveMutedKeys, recursiveMutedEntries } = getActiveRecursiveMuteContext();
            stateManager.verifyAndScrubOutgoingPrompt(
                promptData,
                'CHAT_COMPLETION_PROMPT_READY',
                recursiveMutedKeys,
                recursiveMutedEntries,
                substituteMacros,
            );
        });

        // Stage 4B: GENERATE_AFTER_DATA
        eventSource.on(boundEventsInfo.GENERATE_AFTER_DATA, (generateData, dryRun) => {
            const settings = getSettings();
            if (!settings.enabled) return;

            const { recursiveMutedKeys, recursiveMutedEntries } = getActiveRecursiveMuteContext();
            stateManager.verifyAndScrubOutgoingPrompt(
                { generateData, dryRun },
                'GENERATE_AFTER_DATA',
                recursiveMutedKeys,
                recursiveMutedEntries,
                substituteMacros,
            );
        });

        // Track user message sends
        eventSource.on(boundEventsInfo.MESSAGE_SENT, () => {
            const { recursiveMutedKeys, recursiveMutedEntries } = getActiveRecursiveMuteContext();
            stateManager.onUserMessageSent(recursiveMutedKeys, recursiveMutedEntries);
            highlighter.render('', []);
            setTimeout(() => {
                runScanAgainstCachedLore(false);
            }, 350);
        });

        // Track AI reply arrival & generation stop/end
        eventSource.on(boundEventsInfo.MESSAGE_RECEIVED, () => {
            stateManager.onAiMessageReceived();
            setTimeout(() => refreshLoreSnapshotAndScan(true), 120);
        });

        eventSource.on(boundEventsInfo.GENERATION_STOPPED, () => {
            stateManager.onGenerationStoppedOrEnded('GENERATION_STOPPED');
            setTimeout(() => runScanAgainstCachedLore(false), 120);
        });

        eventSource.on(boundEventsInfo.GENERATION_ENDED, () => {
            stateManager.onGenerationStoppedOrEnded('GENERATION_ENDED');
            setTimeout(() => runScanAgainstCachedLore(false), 120);
        });

        eventSource.on(boundEventsInfo.MESSAGE_DELETED, () => {
            stateManager.onMessageDeleted();
            setTimeout(() => refreshLoreSnapshotAndScan(true), 120);
        });

        // Re-scan when messages are swiped, edited, or World Info settings change
        const rescanEvents = [
            eventTypes.MESSAGE_SWIPED || 'message_swiped',
            eventTypes.MESSAGE_EDITED || 'message_edited',
            eventTypes.WORLDINFO_SETTINGS_UPDATED || 'worldinfo_settings_updated',
            eventTypes.SETTINGS_UPDATED || 'settings_updated',
        ];

        for (const evName of rescanEvents) {
            if (evName) {
                eventSource.on(evName, () => {
                    setTimeout(() => refreshLoreSnapshotAndScan(true), 120);
                });
            }
        }

        // Synchronize per-chat session mutes when switching chats
        const chatChangedEvent = eventTypes.CHAT_CHANGED || 'chat_id_changed';
        eventSource.on(chatChangedEvent, () => {
            tokenCache.clear();
            lastNonEmptyDraftScanResult = null;
            stateManager.syncFromChatMetadata();
            setTimeout(() => {
                const ta = /** @type {HTMLTextAreaElement|null} */ (document.querySelector('#send_textarea'));
                if (ta) highlighter.attach(ta);
                uiController.mount();
                refreshLoreSnapshotAndScan(true);
            }, 180);
        });
    }

    /**
     * Registers Slash Commands (`/radar-scan`, `/radar-mute`, `/radar-unmute`, `/radar-boost`, `/radar-logs`)
     */
    async function registerSlashCommands() {
        const core = await loadCoreModules();
        const Parser = core.slashParser?.SlashCommandParser;
        const Cmd = core.slashCmd?.SlashCommand;
        const Arg = core.slashArg?.SlashCommandArgument;

        if (!Parser || !Cmd || typeof Parser.addCommandObject !== 'function') {
            return;
        }

        try {
            Parser.addCommandObject(
                Cmd.fromProps({
                    name: 'radar-scan',
                    callback: async () => {
                        await refreshLoreSnapshotAndScan(true);
                        const s = latestScanResult?.summary;
                        if (!s) return 'Keyword Radar: No active scan result.';
                        return `Keyword Radar: +${s.newTotalCount} new triggers (+${s.newDraftTokens} tok), ${s.mutedCount} muted (-${s.mutedSavedTokens} tok).`;
                    },
                    helpString: 'Rescans the current draft message in Keyword Radar and returns a summary.',
                }),
            );

            Parser.addCommandObject(
                Cmd.fromProps({
                    name: 'radar-mute',
                    callback: async (_namedArgs, unnamedArgs) => {
                        const query = String(unnamedArgs || '').trim().toLowerCase();
                        if (!query) return 'Usage: /radar-mute <entry title or keyword>';
                        await refreshLoreSnapshotAndScan(false);
                        const entries = cachedLoreSnapshot?.entries || [];
                        const match = entries.find(
                            (e) =>
                                e.comment.toLowerCase().includes(query) ||
                                e.key.some((k) => k.toLowerCase() === query),
                        );
                        if (!match) return `Keyword Radar: No active Lorebook entry matching "${query}".`;
                        stateManager.setMute(match, 'one-turn', 1);
                        return `Keyword Radar: Muted "${match.comment}" (${match.world}) for the next turn.`;
                    },
                    unnamedArgumentList: Arg
                        ? [
                              Arg.fromProps({
                                  description: 'Entry title or keyword to mute for 1 turn',
                                  isRequired: true,
                              }),
                          ]
                        : [],
                    helpString: 'Mutes a matching Lorebook entry for the next turn.',
                }),
            );

            Parser.addCommandObject(
                Cmd.fromProps({
                    name: 'radar-unmute',
                    callback: async () => {
                        stateManager.clearAllMutes(true);
                        return 'Keyword Radar: Cleared all muted entries.';
                    },
                    helpString: 'Unmutes all currently muted Lorebook entries in Keyword Radar.',
                }),
            );

            Parser.addCommandObject(
                Cmd.fromProps({
                    name: 'radar-boost',
                    callback: async (_namedArgs, unnamedArgs) => {
                        const query = String(unnamedArgs || '').trim().toLowerCase();
                        if (!query) {
                            uiController.openManualBoostModal();
                            return '';
                        }
                        await refreshLoreSnapshotAndScan(false);
                        const entries = cachedLoreSnapshot?.entries || [];
                        const match = entries.find(
                            (e) =>
                                e.comment.toLowerCase().includes(query) ||
                                e.key.some((k) => k.toLowerCase() === query),
                        );
                        if (!match) return `Keyword Radar: No active Lorebook entry matching "${query}".`;
                        stateManager.addBoost(match, 1);
                        return `Keyword Radar: Boosted "${match.comment}" (${match.world}) for the next turn.`;
                    },
                    helpString: 'Force-triggers (boosts) a Lorebook entry for the next turn, or opens the Boost modal if no argument is given.',
                }),
            );

            Parser.addCommandObject(
                Cmd.fromProps({
                    name: 'radar-logs',
                    callback: async () => {
                        uiController.openDiagnosticsModal();
                        return 'Keyword Radar: Opened Diagnostic Logs viewer.';
                    },
                    helpString: 'Opens the Keyword Radar Diagnostic Logs viewer & clipboard exporter.',
                }),
            );
        } catch (err) {
            console.warn(`[${EXTENSION_DISPLAY_NAME}] Slash command registration skipped:`, err);
        }
    }

    /**
     * Initializes Keyword Radar when SillyTavern's DOM is ready.
     */
    async function initKeywordRadar() {
        await loadCoreModules();
        getSettings(); // Ensure default settings exist
        updateDebounceTiming();

        await mountSettingsDrawer();
        uiController.mount();
        bindDomListeners();
        await bindSillyTavernEvents();
        await registerSlashCommands();

        stateManager.syncFromChatMetadata();
        await refreshLoreSnapshotAndScan(true);

        console.info(`[${EXTENSION_DISPLAY_NAME}] Initialized (${EXTENSION_NAME} v1.1.1).`);
    }

    if (typeof jQuery !== 'undefined') {
        jQuery(async () => {
            await initKeywordRadar();
        });
    } else if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => initKeywordRadar());
    } else {
        initKeywordRadar();
    }
})();