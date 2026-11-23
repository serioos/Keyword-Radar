/**
 * Keyword Radar — Pre-Send Lorebook Scanner & One-Turn Mute for SillyTavern
 * https://github.com/serioos/Keyword-Radar
 */

import { EXTENSION_NAME, EXTENSION_VERSION, FILTER_MODE, LOG_PREFIX, MUTE_MODE } from './src/constants.js';
import { createInterceptor } from './src/interceptor.js';
import { findMatchesAtCaret, scanDraftAgainstLorebooks } from './src/scanner.js';
import { registerRadarSlashCommands } from './src/slashCommands.js';
import { createRadarState } from './src/state.js';
import {
    countTokensAccurate,
    getStContext,
    getWorldInfoModule,
    getWorldInfoScanConfig,
    openEntryInWorldInfoEditor,
} from './src/stBridge.js';
import { createBoostPicker } from './src/ui/boostPicker.js';
import { createDraftHighlighter } from './src/ui/draftHighlighter.js';
import { createPreviewPopover } from './src/ui/previewPopover.js';
import { createRadarBar } from './src/ui/radarBar.js';
import { createDebouncer, getEntryKey } from './src/utils.js';

function getEventTypes(ctx) {
    return ctx?.eventTypes || ctx?.event_types || null;
}

function getScopedChatKey(ctx, explicitChatId = null) {
    const rawId = explicitChatId ?? ctx?.getCurrentChatId?.() ?? ctx?.chatId ?? null;
    if (!rawId) return null;
    if (ctx?.groupId) {
        return `group:${ctx.groupId}:${rawId}`;
    }
    if (ctx?.characterId !== undefined && ctx?.characterId !== null && Array.isArray(ctx?.characters)) {
        const avatar = ctx.characters[ctx.characterId]?.avatar;
        if (avatar) return `char:${avatar}:${rawId}`;
    }
    return String(rawId);
}

/**
 * Compute a lightweight signature for the recent chat window + timed World Info state
 * so baseline caching invalidates accurately when messages are edited or timers shift.
 */
function buildBaselineSignature({ entriesVersion, chatMessages, characterFilename, userName, scanConfig, timedWorldInfo }) {
    const depth = Math.max(1, Number(scanConfig.scanDepth ?? 2));
    let msgSig = `${chatMessages.length}`;
    let seen = 0;
    for (let i = chatMessages.length - 1; i >= 0 && seen < depth; i--) {
        const m = chatMessages[i];
        if (!m || m.is_system || typeof m.mes !== 'string') continue;
        seen++;
        const len = m.mes.length;
        const head = m.mes.slice(0, 12);
        const tail = len > 12 ? m.mes.slice(-12) : '';
        msgSig += `;${m.name || ''}:${len}:${head}:${tail}`;
    }

    const stickySig = timedWorldInfo?.sticky
        ? Object.entries(timedWorldInfo.sticky).map(([k, v]) => `${k}:${v?.start}:${v?.end}`).join(',')
        : '';
    const cooldownSig = timedWorldInfo?.cooldown
        ? Object.entries(timedWorldInfo.cooldown).map(([k, v]) => `${k}:${v?.start}:${v?.end}`).join(',')
        : '';

    return [
        entriesVersion,
        msgSig,
        characterFilename,
        userName,
        scanConfig.scanDepth,
        scanConfig.recursive,
        scanConfig.maxRecursionSteps,
        scanConfig.caseSensitive,
        scanConfig.matchWholeWords,
        scanConfig.includeNames,
        stickySig,
        cooldownSig,
    ].join('|');
}

const state = createRadarState({}, {
    onSettingsDirty: () => saveSettingsNow(),
});
const tokenCache = new Map();
let cachedEntries = null;
let entriesCacheDirty = true;
let hasActiveLorebooks = false;
let scanSequence = 0;
let entriesVersion = 0;
let cachedBaselineSig = '';
let cachedBaselineMap = null;
let initialized = false;
let initRetryCount = 0;
const MAX_INIT_RETRIES = 40;

async function fetchActiveEntries(forceReload = false) {
    if (!forceReload && !entriesCacheDirty && Array.isArray(cachedEntries)) {
        return cachedEntries;
    }
    const wi = await getWorldInfoModule();
    if (!wi || typeof wi.getSortedEntries !== 'function') {
        cachedEntries = [];
        hasActiveLorebooks = false;
        entriesCacheDirty = false;
        entriesVersion++;
        cachedBaselineSig = '';
        cachedBaselineMap = null;
        return cachedEntries;
    }
    try {
        cachedEntries = await interceptor.runAsInternalScan(() => wi.getSortedEntries());
        hasActiveLorebooks = Array.isArray(cachedEntries) && cachedEntries.length > 0;
        entriesCacheDirty = false;
        entriesVersion++;
        cachedBaselineSig = '';
        cachedBaselineMap = null;
        return cachedEntries;
    } catch (err) {
        console.error(`${LOG_PREFIX} Error fetching sorted World Info entries:`, err);
        const fallback = cachedEntries || [];
        hasActiveLorebooks = fallback.length > 0;
        return fallback;
    }
}

const interceptor = createInterceptor(state, {
    fetchAllEntries: () => fetchActiveEntries(false),
    emitForceActivate: async (entries) => {
        const ctx = getStContext();
        const eventTypes = getEventTypes(ctx);
        if (ctx?.eventSource && eventTypes?.WORLDINFO_FORCE_ACTIVATE) {
            await ctx.eventSource.emit(eventTypes.WORLDINFO_FORCE_ACTIVATE, entries);
        }
    },
    onAfterStateChange: () => {
        scheduleScan();
    },
});

globalThis.keywordRadarGenerateInterceptor = interceptor.handleGenerateInterceptor;

const highlighter = createDraftHighlighter();

function openEntryEditorWithPref(entryOrMatch) {
    const expand = Boolean(state.getSettings().expandOnEditInWorldInfo);
    openEntryInWorldInfoEditor(entryOrMatch.world, entryOrMatch.uid, { expand });
}

const popover = createPreviewPopover({
    onMute: (match, opts) => {
        state.muteEntry(match, opts);
        runScanNow();
    },
    onUnmute: (match) => {
        state.unmuteEntry(match.key);
        runScanNow();
    },
    onUnboost: (match) => {
        state.unboostEntry(match.key);
        runScanNow();
    },
    onEditInWorldInfo: (match) => openEntryEditorWithPref(match),
});

const boostPicker = createBoostPicker({
    getEntries: () => fetchActiveEntries(true),
    getScanResult: () => state.getLastScanResult(),
    getScanConfig: () => getWorldInfoScanConfig(),
    getSubstituteParams: () => {
        const ctx = getStContext();
        return typeof ctx?.substituteParams === 'function' ? ctx.substituteParams : (s) => s;
    },
    getBoostedKeys: () => {
        const ctx = getStContext();
        const upcomingTurn = state.computeTurnKey(ctx?.chat || [], { upcoming: true });
        return new Set(state.getEffectiveControlsForTurn(upcomingTurn).effectiveBoosts.keys());
    },
    getMutedKeys: () => {
        const ctx = getStContext();
        const upcomingTurn = state.computeTurnKey(ctx?.chat || [], { upcoming: true });
        return new Set(state.getEffectiveControlsForTurn(upcomingTurn).effectiveMutes.keys());
    },
    getHideTriggeredPref: () => Boolean(state.getSettings().boostHideAlreadyTriggered),
    onToggleHideTriggered: (val) => {
        state.updateSetting('boostHideAlreadyTriggered', Boolean(val));
        saveSettingsNow();
    },
    onToggleBoost: (entry) => {
        state.toggleBoost(entry);
        runScanNow();
    },
    onToggleMute: (entry) => {
        state.toggleOneTurnMute(entry);
        runScanNow();
    },
    onEditEntry: (entry) => openEntryEditorWithPref(entry),
});

const radarBar = createRadarBar({
    state,
    onToggleMute: (match) => {
        state.toggleOneTurnMute(match);
        runScanNow();
    },
    onMuteWithDuration: (match, opts) => {
        state.muteEntry(match, opts);
        runScanNow();
    },
    onUnmute: (match) => {
        state.unmuteEntry(match.key);
        runScanNow();
    },
    onUnboost: (match) => {
        state.unboostEntry(match.key);
        runScanNow();
    },
    onOpenBoostPicker: () => {
        boostPicker.open();
    },
    onHoverEntry: (match, pillEl, openPopover) => {
        state.setHoveredEntryKey(match.key);
        highlighter.setFocusedEntry(match.key);
        if (openPopover && !popover.isPinned()) {
            popover.show(match, pillEl, { isPinned: false });
        }
    },
    onLeaveEntry: () => {
        state.setHoveredEntryKey(null);
        highlighter.setFocusedEntry(null);
        if (!popover.isPinned()) {
            popover.scheduleHide(220);
        }
    },
    onClickEntry: (match, pillEl) => {
        popover.show(match, pillEl, { isPinned: true });
    },
    onEditEntry: (match) => openEntryEditorWithPref(match),
    onToggleFilterMode: () => {
        const cur = state.getSettings().filterMode;
        const next = cur === FILTER_MODE.DRAFT_ONLY ? FILTER_MODE.ALL_ACTIVE : FILTER_MODE.DRAFT_ONLY;
        state.updateSetting('filterMode', next);
        saveSettingsNow();
        syncSettingsUi();
        runScanNow();
    },
    onClearAllOverrides: () => {
        state.clearAllOverrides();
        runScanNow();
    },
});

function saveSettingsNow() {
    const ctx = getStContext();
    if (typeof ctx?.saveSettingsDebounced === 'function') {
        ctx.saveSettingsDebounced();
    }
}

async function hydrateAccurateTokens(matches, expectedSeq) {
    // Only hydrate newly triggered / boosted entries (capped batch) to avoid stalling on large constant lorebooks
    const toHydrate = matches
        .filter((m) => m.isNew || m.isBoosted)
        .filter((m) => {
            const cached = tokenCache.get(m.key);
            return !(cached && cached.content === (m.content || ''));
        })
        .slice(0, 10);

    if (toHydrate.length === 0) return;

    const results = await Promise.all(
        toHydrate.map(async (m) => ({
            m,
            accurate: await countTokensAccurate(m.content || ''),
        })),
    );

    if (expectedSeq !== scanSequence) return;

    let updated = false;
    for (const { m, accurate } of results) {
        if (typeof accurate === 'number' && accurate >= 0) {
            tokenCache.set(m.key, { content: m.content || '', tokens: accurate });
            if (accurate !== m.tokens) updated = true;
        }
    }

    if (updated && expectedSeq === scanSequence) {
        runScanNow({ skipTokenHydration: true });
    }
}

async function runScanNow({ forceReloadEntries = false, skipTokenHydration = false } = {}) {
    const settings = state.getSettings();
    const textarea = document.getElementById('send_textarea');

    if (!settings.enabled) {
        radarBar.render(null, { hasActiveLorebooks: false });
        highlighter.setEnabled(false);
        popover.hide();
        return;
    }

    const seq = ++scanSequence;
    const entries = await fetchActiveEntries(forceReloadEntries);
    if (seq !== scanSequence) return;

    // Zero-overhead idle path: if no Lorebooks are attached/active, do not scan or render
    if (!entries || entries.length === 0) {
        state.setLastScanResult(null);
        radarBar.render(null, { hasActiveLorebooks: false });
        highlighter.render('', [], null);
        popover.hide();
        return;
    }

    const ctx = getStContext();
    const draftText = textarea?.value ?? '';
    const chatMessages = Array.isArray(ctx?.chat) ? ctx.chat : [];
    const userName = ctx?.name1 || 'User';
    const timedWorldInfo = ctx?.chatMetadata?.timedWorldInfo || null;
    const substituteFn = typeof ctx?.substituteParams === 'function' ? ctx.substituteParams : (s) => s;

    let characterFilename = '';
    let characterTags = null;
    if (ctx?.groupId) {
        if (ctx?.tagMap && Array.isArray(ctx.tagMap[ctx.groupId])) {
            characterTags = ctx.tagMap[ctx.groupId];
        }
    } else if (ctx?.characterId !== undefined && ctx?.characterId !== null && Array.isArray(ctx?.characters)) {
        const char = ctx.characters[ctx.characterId];
        characterFilename = char?.avatar || '';
        if (characterFilename && ctx?.tagMap && Array.isArray(ctx.tagMap[characterFilename])) {
            characterTags = ctx.tagMap[characterFilename];
        }
    }

    const scanConfig = await getWorldInfoScanConfig();
    if (seq !== scanSequence) return;

    const upcomingTurn = state.computeTurnKey(chatMessages, { upcoming: true });
    const { effectiveMutes, effectiveBoosts } = state.getEffectiveControlsForTurn(upcomingTurn);

    const flatTokenMap = new Map();
    for (const entry of entries) {
        const key = getEntryKey(entry);
        const cached = tokenCache.get(key);
        if (cached && cached.content === (entry.content || '')) {
            flatTokenMap.set(key, cached.tokens);
        }
    }

    const baselineSig = buildBaselineSignature({
        entriesVersion,
        chatMessages,
        characterFilename,
        userName,
        scanConfig,
        timedWorldInfo,
    });
    const reusableBaseline = baselineSig === cachedBaselineSig ? cachedBaselineMap : null;

    const result = scanDraftAgainstLorebooks({
        entries,
        chatMessages,
        draftText,
        userName,
        timedWorldInfo,
        scanConfig,
        substituteParams: substituteFn,
        characterFilename,
        characterTags,
        effectiveMutes,
        effectiveBoosts,
        muteBlocksRecursiveChildren: Boolean(settings.muteBlocksRecursiveChildren),
        tokenCache: flatTokenMap,
        cachedBaseline: reusableBaseline,
    });

    if (!reusableBaseline && result.baselineActivated) {
        cachedBaselineSig = baselineSig;
        cachedBaselineMap = result.baselineActivated;
    }

    state.setLastScanResult(result);
    radarBar.render(result, { hasActiveLorebooks: true });
    if (boostPicker.isOpen()) {
        boostPicker.refreshView();
    }

    if (textarea) {
        highlighter.mount(textarea);
        highlighter.setEnabled(Boolean(settings.highlightDraftKeywords));
        highlighter.render(draftText, result.draftSpans, state.getHoveredEntryKey());
    }

    if (!skipTokenHydration && result.matches.length > 0) {
        hydrateAccurateTokens(result.matches, seq);
    }
}

const scheduleScan = createDebouncer(
    () => runScanNow(),
    () => Number(state.getSettings().debounceMs) || 180,
);

async function mountSettingsPanel() {
    const container = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
    if (!container) return;
    if (document.getElementById('kr-settings-drawer')) return;

    let html = '';
    try {
        const settingsUrl = new URL('./settings.html', import.meta.url).href;
        const resp = await fetch(settingsUrl);
        if (resp.ok) {
            html = await resp.text();
        }
    } catch (err) {
        console.error(`${LOG_PREFIX} Failed to fetch settings.html:`, err);
        return;
    }

    if (!html) return;

    const wrapper = document.createElement('div');
    wrapper.innerHTML = html.trim();
    const drawer = wrapper.firstElementChild;
    if (!drawer) return;

    container.appendChild(drawer);
    bindSettingsControls(drawer);
    syncSettingsUi();
}

function bindSettingsControls(root) {
    const bindCheckbox = (id, settingKey, extraFn) => {
        const el = root.querySelector(`#${id}`);
        if (!el) return;
        el.addEventListener('change', () => {
            state.updateSetting(settingKey, Boolean(el.checked));
            saveSettingsNow();
            extraFn?.(Boolean(el.checked));
            runScanNow();
        });
    };

    const bindSelect = (id, settingKey) => {
        const el = root.querySelector(`#${id}`);
        if (!el) return;
        el.addEventListener('change', () => {
            state.updateSetting(settingKey, el.value);
            saveSettingsNow();
            runScanNow();
        });
    };

    bindCheckbox('kr_enabled', 'enabled');
    bindCheckbox('kr_auto_hide_idle', 'autoHideWhenNoNewTriggers');
    bindCheckbox('kr_reduce_animations', 'reduceAnimations', (val) => document.body.classList.toggle('kr-reduce-motion', val));
    bindCheckbox('kr_mute_blocks_children', 'muteBlocksRecursiveChildren');
    bindCheckbox('kr_keep_mute_on_swipe', 'keepMuteOnSwipe');
    bindCheckbox('kr_highlight_draft', 'highlightDraftKeywords', (val) => highlighter.setEnabled(val));
    bindCheckbox('kr_hover_preview', 'hoverPreview');
    bindCheckbox('kr_show_tokens', 'showTokenEstimate');
    bindCheckbox('kr_show_lorebook', 'showLorebookName');
    bindCheckbox('kr_show_budget_warning', 'showBudgetWarning');
    bindCheckbox('kr_expand_on_edit', 'expandOnEditInWorldInfo');
    bindCheckbox('kr_enable_hotkeys', 'enableHotkeys');

    bindSelect('kr_filter_mode', 'filterMode');
    bindSelect('kr_display_mode', 'displayMode');

    const debounceRange = root.querySelector('#kr_debounce_ms');
    const debounceValue = root.querySelector('#kr_debounce_ms_value');
    if (debounceRange) {
        debounceRange.addEventListener('input', () => {
            const val = Math.max(50, Math.min(1000, parseInt(debounceRange.value, 10) || 180));
            if (debounceValue) debounceValue.textContent = `${val} ms`;
            state.updateSetting('debounceMs', val);
            saveSettingsNow();
        });
    }

    root.querySelector('#kr_clear_overrides_btn')?.addEventListener('click', () => {
        state.clearAllOverrides();
        runScanNow();
    });

    root.querySelector('#kr_clear_all_chats_mutes_btn')?.addEventListener('click', async () => {
        const { chatCount, entryCount } = state.getGlobalChatMuteStats();
        if (entryCount === 0) {
            if (typeof globalThis.toastr?.info === 'function') {
                globalThis.toastr.info('There are no chat-muted entries in any chat.', 'Keyword Radar');
            }
            return;
        }
        const ctx = getStContext();
        const promptMsg = `Unmute ${entryCount} chat-muted entry(ies) across ${chatCount} chat(s)? (Turn-based mutes in this chat are unaffected.)`;
        let confirmed = true;
        if (typeof ctx?.callGenericPopup === 'function' && ctx?.POPUP_TYPE?.CONFIRM !== undefined) {
            confirmed = Boolean(await ctx.callGenericPopup(promptMsg, ctx.POPUP_TYPE.CONFIRM));
        } else if (typeof window.confirm === 'function') {
            confirmed = window.confirm(promptMsg);
        }
        if (!confirmed) return;

        state.clearAllChatMutesGlobally();
        saveSettingsNow();
        runScanNow();
        if (typeof globalThis.toastr?.success === 'function') {
            globalThis.toastr.success('All chat-muted Lorebook entries have been unmuted across all chats.', 'Keyword Radar');
        }
    });
}

function syncSettingsUi() {
    const s = state.getSettings();
    const setChecked = (id, val) => {
        const el = document.getElementById(id);
        if (el) el.checked = Boolean(val);
    };
    const setVal = (id, val) => {
        const el = document.getElementById(id);
        if (el) el.value = String(val);
    };

    setChecked('kr_enabled', s.enabled);
    setChecked('kr_auto_hide_idle', s.autoHideWhenNoNewTriggers);
    setChecked('kr_reduce_animations', s.reduceAnimations);
    document.body.classList.toggle('kr-reduce-motion', Boolean(s.reduceAnimations));
    setChecked('kr_mute_blocks_children', s.muteBlocksRecursiveChildren);
    setChecked('kr_keep_mute_on_swipe', s.keepMuteOnSwipe);
    setChecked('kr_highlight_draft', s.highlightDraftKeywords);
    setChecked('kr_hover_preview', s.hoverPreview);
    setChecked('kr_show_tokens', s.showTokenEstimate);
    setChecked('kr_show_lorebook', s.showLorebookName);
    setChecked('kr_show_budget_warning', s.showBudgetWarning);
    setChecked('kr_expand_on_edit', s.expandOnEditInWorldInfo);
    setChecked('kr_enable_hotkeys', s.enableHotkeys);

    setVal('kr_filter_mode', s.filterMode);
    setVal('kr_display_mode', s.displayMode);
    setVal('kr_debounce_ms', s.debounceMs);

    const debounceValue = document.getElementById('kr_debounce_ms_value');
    if (debounceValue) debounceValue.textContent = `${s.debounceMs} ms`;
}

function attachTextareaListeners() {
    const textarea = document.getElementById('send_textarea');
    if (!textarea || textarea.dataset.krBound === 'true') return;
    textarea.dataset.krBound = 'true';

    textarea.addEventListener('input', () => {
        // Short-circuit completely if disabled or no active Lorebooks are hooked up
        if (!state.getSettings().enabled) return;
        if (!entriesCacheDirty && !hasActiveLorebooks) return;
        scheduleScan();
    });

    textarea.addEventListener('focus', () => {
        radarBar.setInputFocused(true);
        highlighter.syncGeometry();
    });

    textarea.addEventListener('blur', () => {
        radarBar.setInputFocused(false);
    });

    radarBar.setInputFocused(document.activeElement === textarea);
    highlighter.mount(textarea);
}

function attachGlobalHotkeys() {
    if (document.body.dataset.krHotkeysBound === 'true') return;
    document.body.dataset.krHotkeysBound = 'true';

    document.addEventListener('keydown', (e) => {
        const s = state.getSettings();
        if (!s.enabled || !s.enableHotkeys) return;
        if (!entriesCacheDirty && !hasActiveLorebooks) return;
        if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;

        const key = e.key.toLowerCase();
        if (key === 'b') {
            e.preventDefault();
            boostPicker.open();
        } else if (key === 'm') {
            const textarea = document.getElementById('send_textarea');
            if (!textarea || document.activeElement !== textarea) return;

            const scan = state.getLastScanResult();
            const caretMatches = findMatchesAtCaret(scan, textarea.selectionStart, textarea.selectionEnd)
                .filter((m) => !m.isBoosted);

            if (caretMatches.length === 0) return;
            e.preventDefault();

            const unmutedAtCaret = caretMatches.filter((m) => !m.isDirectlyMuted);
            if (unmutedAtCaret.length > 0) {
                for (const m of unmutedAtCaret) {
                    state.muteEntry(m, { mode: MUTE_MODE.TURNS, turns: 1 });
                }
            } else {
                for (const m of caretMatches) {
                    state.unmuteEntry(m.key);
                }
            }
            runScanNow();
        }
    });
}

function registerSillyTavernEvents() {
    const ctx = getStContext();
    const eventSource = ctx?.eventSource;
    const eventTypes = getEventTypes(ctx);
    if (!eventSource || !eventTypes) return;

    if (eventTypes.WORLDINFO_ENTRIES_LOADED) {
        eventSource.on(eventTypes.WORLDINFO_ENTRIES_LOADED, (payload) => {
            interceptor.handleWorldInfoEntriesLoaded(payload);
        });
    }

    const invalidateAndScan = () => {
        entriesCacheDirty = true;
        scheduleScan();
    };

    const invalidateEvents = [
        eventTypes.WORLDINFO_UPDATED,
        eventTypes.WORLDINFO_SETTINGS_UPDATED,
        eventTypes.CHARACTER_EDITED,
        eventTypes.CHARACTER_RENAMED,
        eventTypes.GROUP_UPDATED,
        eventTypes.PERSONA_CHANGED,
        eventTypes.PERSONA_UPDATED,
        eventTypes.PERSONA_DELETED,
        eventTypes.APP_READY,
    ].filter(Boolean);

    for (const ev of invalidateEvents) {
        eventSource.on(ev, invalidateAndScan);
    }

    // Tokenizer / context budget changes
    const tokenizerChangeEvents = [
        eventTypes.MAIN_API_CHANGED,
        eventTypes.CHATCOMPLETION_MODEL_CHANGED,
        eventTypes.PRESET_CHANGED,
    ].filter(Boolean);

    for (const ev of tokenizerChangeEvents) {
        eventSource.on(ev, () => {
            tokenCache.clear();
            cachedBaselineSig = '';
            cachedBaselineMap = null;
            if (!entriesCacheDirty && !hasActiveLorebooks) return;
            scheduleScan();
        });
    }

    if (eventTypes.CHAT_RENAMED) {
        eventSource.on(eventTypes.CHAT_RENAMED, (oldName, newName) => {
            const curCtx = getStContext();
            const oldKey = oldName ? getScopedChatKey(curCtx, oldName) : state.getCurrentChatId();
            const newKey = getScopedChatKey(curCtx, newName || null);
            state.migrateChatKey(oldKey, newKey);
            invalidateAndScan();
        });
    }

    if (eventTypes.CHAT_CHANGED) {
        eventSource.on(eventTypes.CHAT_CHANGED, (chatId) => {
            entriesCacheDirty = true;
            state.handleChatChanged(getScopedChatKey(getStContext(), chatId));
            popover.hide();
            boostPicker.close();
            scheduleScan();
        });
    }

    if (eventTypes.GENERATION_STOPPED) {
        eventSource.on(eventTypes.GENERATION_STOPPED, () => {
            state.setActiveGenerationContext(null);
            if (!entriesCacheDirty && !hasActiveLorebooks) return;
            scheduleScan();
        });
    }

    const rescanEvents = [
        eventTypes.MESSAGE_SENT,
        eventTypes.MESSAGE_RECEIVED,
        eventTypes.MESSAGE_EDITED,
        eventTypes.MESSAGE_UPDATED,
        eventTypes.MESSAGE_DELETED,
        eventTypes.MESSAGE_SWIPED,
        eventTypes.GENERATION_ENDED,
    ].filter(Boolean);

    for (const ev of rescanEvents) {
        eventSource.on(ev, () => {
            if (!entriesCacheDirty && !hasActiveLorebooks) return;
            scheduleScan();
        });
    }
}

/**
 * SillyTavern 1.17+ lifecycle hook: called when the user cleans extension data.
 */
export function onExtensionClean() {
    state.clearAllChatMutesGlobally();
    state.clearAllOverrides();
    const ctx = getStContext();
    if (ctx?.extensionSettings && Object.hasOwn(ctx.extensionSettings, EXTENSION_NAME)) {
        delete ctx.extensionSettings[EXTENSION_NAME];
    }
    saveSettingsNow();
}

/**
 * SillyTavern 1.17+ lifecycle hook: called when the user disables the extension.
 */
export function onExtensionDisable() {
    scheduleScan.cancel();
    popover.destroy();
    boostPicker.close();
    highlighter.unmount();
    radarBar.unmount();
    document.body.classList.remove('kr-reduce-motion');
}

async function initKeywordRadar() {
    if (initialized) return;

    const ctx = getStContext();
    if (!ctx) {
        initRetryCount++;
        if (initRetryCount <= MAX_INIT_RETRIES) {
            setTimeout(initKeywordRadar, 500);
        } else {
            console.warn(`${LOG_PREFIX} Timed out waiting for SillyTavern context.`);
        }
        return;
    }

    initialized = true;
    state.bindExtensionSettings(ctx.extensionSettings);
    state.handleChatChanged(getScopedChatKey(ctx));

    await mountSettingsPanel();
    attachTextareaListeners();
    attachGlobalHotkeys();
    registerSillyTavernEvents();
    registerRadarSlashCommands({
        ctx,
        state,
        fetchActiveEntries,
        getCachedEntries: () => cachedEntries || [],
        onStateChanged: () => runScanNow(),
    });
    radarBar.mount();

    await runScanNow({ forceReloadEntries: true });
    console.log(`${LOG_PREFIX} Initialized v${EXTENSION_VERSION} successfully.`);
}

if (typeof jQuery !== 'undefined') {
    jQuery(() => {
        initKeywordRadar();
    });
} else if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => initKeywordRadar());
} else {
    initKeywordRadar();
}
