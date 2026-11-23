/**
 * Keyword Radar — Status-Aware One-Turn Manual Boost & Pre-Flight Control Modal
 *
 * Features:
 *  - Title-first fuzzy search ranking (entry name > keywords > lorebook > content)
 *  - Delegated click listeners (zero per-keystroke listener churn)
 *  - Async double-open guard & memoized recursive cascade previews
 */

import { ACTIVATION_SOURCE } from '../constants.js';
import { previewRecursiveCascade } from '../scanner.js';
import {
    createDebouncer,
    escapeHtml,
    estimateTokensFast,
    formatTokenCount,
    getEntryKey,
    getEntryTitle,
    scoreBoostEntry,
} from '../utils.js';

const STATUS_BADGE_MAP = {
    [ACTIVATION_SOURCE.DRAFT]: { label: 'Draft', cls: 'kr-st-draft', icon: 'fa-bolt' },
    [ACTIVATION_SOURCE.RECURSIVE_DRAFT]: { label: 'Recursive (Draft)', cls: 'kr-st-rec', icon: 'fa-diagram-project' },
    [ACTIVATION_SOURCE.BOOSTED]: { label: 'Boosted', cls: 'kr-st-boost', icon: 'fa-thumbtack' },
    [ACTIVATION_SOURCE.HISTORY]: { label: 'History', cls: 'kr-st-active', icon: 'fa-clock-rotate-left' },
    [ACTIVATION_SOURCE.RECURSIVE_HISTORY]: { label: 'Recursive (History)', cls: 'kr-st-active', icon: 'fa-diagram-project' },
    [ACTIVATION_SOURCE.CONSTANT]: { label: 'Constant', cls: 'kr-st-active', icon: 'fa-infinity' },
    [ACTIVATION_SOURCE.STICKY]: { label: 'Sticky', cls: 'kr-st-active', icon: 'fa-magnet' },
};

export function createBoostPicker({
    getEntries,
    getScanResult,
    getScanConfig,
    getSubstituteParams,
    getBoostedKeys,
    getMutedKeys,
    getHideTriggeredPref,
    onToggleHideTriggered,
    onToggleBoost,
    onToggleMute,
    onEditEntry,
}) {
    let backdropEl = null;
    let isOpening = false;
    let allEntries = [];
    let entryByKey = new Map();
    let cascadeCache = new Map();
    let lastActiveKeysSig = '';
    let scanConfig = {};
    let searchQuery = '';
    let selectedWorld = '__all__';
    let activeFilterChip = 'all';
    let hideAlreadyTriggered = false;

    const debouncedRefresh = createDebouncer(() => refreshView(), 60);

    function isOpen() {
        return Boolean(backdropEl && backdropEl.isConnected);
    }

    function close() {
        debouncedRefresh.cancel();
        if (backdropEl && backdropEl.parentElement) {
            backdropEl.parentElement.removeChild(backdropEl);
        }
        backdropEl = null;
        cascadeCache.clear();
        lastActiveKeysSig = '';
        document.removeEventListener('keydown', onKeyDown);
    }

    function onKeyDown(e) {
        if (e.key === 'Escape') {
            e.stopPropagation();
            close();
        }
    }

    function buildMatchIndex() {
        const scanResult = getScanResult?.();
        const matchByKey = new Map();
        const activeKeys = new Set();
        if (scanResult?.matches) {
            for (const m of scanResult.matches) {
                matchByKey.set(m.key, m);
                if (!m.isMuted) activeKeys.add(m.key);
            }
        }
        return { matchByKey, activeKeys };
    }

    function getCachedCascade(entry, activeKeys, subFn) {
        const key = getEntryKey(entry);
        if (cascadeCache.has(key)) {
            return cascadeCache.get(key);
        }
        const res = previewRecursiveCascade(entry, allEntries, activeKeys, scanConfig, subFn);
        cascadeCache.set(key, res);
        return res;
    }

    function renderChips(chipsEl, counts) {
        const defs = [
            { id: 'all', label: 'All', count: counts.all },
            { id: 'untriggered', label: 'Untriggered', count: counts.untriggered },
            { id: 'triggered', label: 'Triggered', count: counts.triggered },
            { id: 'boosted', label: 'Boosted', count: counts.boosted },
            { id: 'muted', label: 'Muted', count: counts.muted },
        ];

        chipsEl.innerHTML = defs.map((c) => `
            <button type="button" class="kr-filter-chip ${activeFilterChip === c.id ? 'kr-chip-active' : ''}" data-chip="${c.id}">
                <span>${c.label}</span>
                <span class="kr-chip-count">${c.count}</span>
            </button>
        `).join('');
    }

    function refreshView() {
        if (!backdropEl) return;
        const listEl = backdropEl.querySelector('.kr-picker-list');
        const chipsEl = backdropEl.querySelector('.kr-picker-chips');
        if (!listEl || !chipsEl) return;

        const boostedKeys = getBoostedKeys?.() || new Set();
        const mutedKeys = getMutedKeys?.() || new Set();
        const { matchByKey, activeKeys } = buildMatchIndex();
        const subFn = getSubstituteParams?.() || ((s) => s);
        const q = searchQuery.trim();

        const activeSig = Array.from(activeKeys).sort().join('|');
        if (activeSig !== lastActiveKeysSig) {
            cascadeCache.clear();
            lastActiveKeysSig = activeSig;
        }

        // Score & filter by world and fuzzy search (title > keywords > lorebook > content)
        const scoredScoped = [];
        for (const entry of allEntries) {
            if (selectedWorld !== '__all__' && entry.world !== selectedWorld) continue;
            const searchScore = q ? scoreBoostEntry(entry, q) : 1;
            if (q && searchScore <= 0) continue;
            scoredScoped.push({ entry, searchScore });
        }

        const counts = { all: scoredScoped.length, untriggered: 0, triggered: 0, boosted: 0, muted: 0 };
        for (const { entry } of scoredScoped) {
            const key = getEntryKey(entry);
            const match = matchByKey.get(key);
            const isBoosted = boostedKeys.has(key);
            const isMuted = mutedKeys.has(key);
            const isTriggered = Boolean(match && !isBoosted);

            if (isBoosted) counts.boosted++;
            if (isMuted) counts.muted++;
            if (isTriggered) counts.triggered++;
            else if (!isBoosted) counts.untriggered++;
        }

        renderChips(chipsEl, counts);

        const filtered = scoredScoped.filter(({ entry }) => {
            const key = getEntryKey(entry);
            const match = matchByKey.get(key);
            const isBoosted = boostedKeys.has(key);
            const isMuted = mutedKeys.has(key);
            const isAlreadyTriggered = Boolean(match && !isBoosted);

            if (hideAlreadyTriggered && isAlreadyTriggered) return false;

            if (activeFilterChip === 'untriggered') return !isAlreadyTriggered && !isBoosted;
            if (activeFilterChip === 'triggered') return isAlreadyTriggered;
            if (activeFilterChip === 'boosted') return isBoosted;
            if (activeFilterChip === 'muted') return isMuted;
            return true;
        });

        if (filtered.length === 0) {
            listEl.innerHTML = `<div class="kr-picker-empty">No matching Lorebook entries in this view.</div>`;
            return;
        }

        const priorityOf = (entry) => {
            const key = getEntryKey(entry);
            if (boostedKeys.has(key)) return 0;
            const m = matchByKey.get(key);
            if (m?.source === ACTIVATION_SOURCE.DRAFT) return 1;
            if (m?.source === ACTIVATION_SOURCE.RECURSIVE_DRAFT) return 2;
            if (m) return 3;
            return 4;
        };

        // When user is actively searching, rank strictly by fuzzy relevance (title first, then keywords/world/content)
        filtered.sort((a, b) => {
            if (q) {
                if (b.searchScore !== a.searchScore) return b.searchScore - a.searchScore;
            }
            const diff = priorityOf(a.entry) - priorityOf(b.entry);
            if (diff !== 0) return diff;
            return getEntryTitle(a.entry).localeCompare(getEntryTitle(b.entry));
        });

        const limited = filtered.slice(0, 120);
        listEl.innerHTML = limited.map(({ entry }) => {
            const key = getEntryKey(entry);
            const title = getEntryTitle(entry);
            const match = matchByKey.get(key);
            const isBoosted = boostedKeys.has(key);
            const isMuted = mutedKeys.has(key);
            const isDisabled = Boolean(entry.disable);
            const tokens = match?.tokens ?? estimateTokensFast(entry.content || '');
            const preview = String(entry.content || '').replace(/\s+/g, ' ').slice(0, 115);
            const keysText = Array.isArray(entry.key) && entry.key.length
                ? entry.key.slice(0, 4).join(', ')
                : (entry.constant ? 'Constant' : 'No keywords');

            const statusTags = [];
            if (match && STATUS_BADGE_MAP[match.source]) {
                const info = STATUS_BADGE_MAP[match.source];
                let extra = '';
                if (match.isRecursive && match.triggeredBy?.[0]?.title) {
                    extra = ` · via ${match.triggeredBy[0].title}`;
                } else {
                    const draftHit = (match.matchedKeywords || []).find((k) => k.inDraft);
                    if (draftHit) extra = ` · "${draftHit.substituted}"`;
                }
                statusTags.push(`<span class="kr-st-tag ${info.cls}"><i class="fa-solid ${info.icon}"></i> ${escapeHtml(info.label + extra)}</span>`);
            }
            if (isMuted) {
                statusTags.push('<span class="kr-st-tag kr-st-muted"><i class="fa-solid fa-volume-xmark"></i> Muted</span>');
            }
            if (match?.budgetOverflow) {
                statusTags.push('<span class="kr-st-tag kr-st-warn" title="Exceeds World Info token budget"><i class="fa-solid fa-triangle-exclamation"></i> Budget</span>');
            }
            if (entry.useProbability && Number(entry.probability ?? 100) < 100) {
                statusTags.push(`<span class="kr-st-tag kr-st-info" title="Trigger probability"><i class="fa-solid fa-dice"></i> ${Number(entry.probability)}%</span>`);
            }
            if (typeof entry.group === 'string' && entry.group.trim()) {
                statusTags.push(`<span class="kr-st-tag kr-st-info" title="Inclusion group"><i class="fa-solid fa-layer-group"></i> ${escapeHtml(entry.group.trim())}</span>`);
            }
            if (isDisabled) {
                statusTags.push('<span class="kr-st-tag kr-st-muted">Disabled in WI</span>');
            }

            let cascadeHtml = '';
            if (!match && !isBoosted && scanConfig?.recursive && !entry.preventRecursion) {
                const cascade = getCachedCascade(entry, activeKeys, subFn);
                if (cascade.children.length > 0) {
                    const childTitles = cascade.children.map((c) => c.title).join(', ');
                    cascadeHtml = `
                        <div class="kr-picker-cascade" title="Recursive children: ${escapeHtml(childTitles)}">
                            <i class="fa-solid fa-diagram-project"></i>
                            Boosting also wakes up +${cascade.children.length} recursive (+~${formatTokenCount(cascade.totalTokens)}t): ${escapeHtml(childTitles)}
                        </div>
                    `;
                }
            }

            const rowClasses = ['kr-picker-row'];
            if (isBoosted) rowClasses.push('kr-picker-row-boosted');
            else if (match?.isNew && !isMuted) rowClasses.push('kr-picker-row-draft');
            if (isMuted) rowClasses.push('kr-picker-row-muted');

            return `
                <div class="${rowClasses.join(' ')}" data-key="${escapeHtml(key)}">
                    <div class="kr-picker-row-main">
                        <div class="kr-picker-row-top">
                            <span class="kr-picker-row-title">${escapeHtml(title)}</span>
                            <span class="kr-picker-row-world">${escapeHtml(entry.world || 'Lorebook')}</span>
                            <span class="kr-picker-row-tokens">~${formatTokenCount(tokens)}t</span>
                        </div>
                        ${statusTags.length ? `<div class="kr-picker-tags">${statusTags.join('')}</div>` : ''}
                        <div class="kr-picker-row-keys"><i class="fa-solid fa-key"></i> ${escapeHtml(keysText)}</div>
                        ${preview ? `<div class="kr-picker-row-preview">${escapeHtml(preview)}${entry.content?.length > 115 ? '…' : ''}</div>` : ''}
                        ${cascadeHtml}
                    </div>
                    <div class="kr-picker-row-actions">
                        <button type="button" class="menu_button kr-btn-sm ${isBoosted ? 'kr-btn-boosted' : ''}" data-boost-key="${escapeHtml(key)}" title="${isBoosted ? 'Remove 1-turn boost' : 'Force-trigger for next turn'}">
                            <i class="fa-solid fa-thumbtack"></i> ${isBoosted ? 'Boosted' : 'Boost'}
                        </button>
                        <button type="button" class="menu_button kr-btn-sm ${isMuted ? 'kr-btn-muted-active' : ''}" data-mute-key="${escapeHtml(key)}" title="${isMuted ? 'Unmute entry' : 'Mute for 1 turn'}">
                            <i class="fa-solid ${isMuted ? 'fa-volume-high' : 'fa-volume-xmark'}"></i>
                        </button>
                        <button type="button" class="menu_button kr-btn-sm" data-edit-key="${escapeHtml(key)}" title="Locate in World Info">
                            <i class="fa-solid fa-pen-to-square"></i>
                        </button>
                    </div>
                </div>
            `;
        }).join('');
    }

    async function open() {
        if (isOpen()) {
            close();
            return;
        }
        if (isOpening) return;
        isOpening = true;

        try {
            [allEntries, scanConfig] = await Promise.all([
                getEntries?.() || [],
                getScanConfig?.() || {},
            ]);
            entryByKey = new Map(allEntries.map((e) => [getEntryKey(e), e]));
            cascadeCache.clear();
            lastActiveKeysSig = '';
        } finally {
            isOpening = false;
        }

        // Guard in case close() or another modal occurred during await
        if (isOpen()) return;

        searchQuery = '';
        selectedWorld = '__all__';
        activeFilterChip = 'all';
        hideAlreadyTriggered = Boolean(getHideTriggeredPref?.());

        const worlds = [...new Set(allEntries.map((e) => e.world).filter(Boolean))].sort();

        backdropEl = document.createElement('div');
        backdropEl.id = 'kr-boost-picker-backdrop';
        backdropEl.className = 'kr-modal-backdrop';
        backdropEl.innerHTML = `
            <div class="kr-modal popup" role="dialog" aria-modal="true" aria-label="Keyword Radar Boost & Pre-Flight Manager">
                <div class="kr-modal-header">
                    <div>
                        <div class="kr-modal-title"><i class="fa-solid fa-thumbtack"></i> Lorebook Boost &amp; Pre-Flight Manager</div>
                        <div class="kr-modal-subtitle">Inspect live trigger status, mute false positives, or force-trigger any entry for the next turn.</div>
                    </div>
                    <button type="button" class="menu_button kr-icon-close" title="Close">&times;</button>
                </div>
                <div class="kr-modal-toolbar">
                    <input type="text" class="kr-search-input text_pole" placeholder="Fuzzy search by entry name, keyword, lorebook, or content..." autocomplete="off" />
                    <select class="kr-world-select text_pole">
                        <option value="__all__">All Active Lorebooks (${worlds.length})</option>
                        ${worlds.map((w) => `<option value="${escapeHtml(w)}">${escapeHtml(w)}</option>`).join('')}
                    </select>
                </div>
                <div class="kr-modal-subbar">
                    <div class="kr-picker-chips"></div>
                    <label class="checkbox_label kr-hide-triggered-label" for="kr-picker-hide-triggered">
                        <input id="kr-picker-hide-triggered" type="checkbox" ${hideAlreadyTriggered ? 'checked' : ''} />
                        <span>Hide already triggered</span>
                    </label>
                </div>
                <div class="kr-picker-list"></div>
            </div>
        `;

        // Single delegated click listener for backdrop, chips, and row actions
        backdropEl.addEventListener('click', (e) => {
            if (e.target === backdropEl) {
                close();
                return;
            }

            const chipBtn = e.target.closest('[data-chip]');
            if (chipBtn) {
                activeFilterChip = chipBtn.dataset.chip;
                if (activeFilterChip === 'triggered' && hideAlreadyTriggered) {
                    hideAlreadyTriggered = false;
                    const cb = backdropEl?.querySelector('#kr-picker-hide-triggered');
                    if (cb) cb.checked = false;
                    onToggleHideTriggered?.(false);
                }
                refreshView();
                return;
            }

            const boostBtn = e.target.closest('[data-boost-key]');
            if (boostBtn) {
                e.stopPropagation();
                const entry = entryByKey.get(boostBtn.dataset.boostKey);
                if (entry) {
                    onToggleBoost?.(entry);
                    refreshView();
                }
                return;
            }

            const muteBtn = e.target.closest('[data-mute-key]');
            if (muteBtn) {
                e.stopPropagation();
                const entry = entryByKey.get(muteBtn.dataset.muteKey);
                if (entry) {
                    onToggleMute?.(entry);
                    refreshView();
                }
                return;
            }

            const editBtn = e.target.closest('[data-edit-key]');
            if (editBtn) {
                e.stopPropagation();
                const entry = entryByKey.get(editBtn.dataset.editKey);
                if (entry) {
                    close();
                    onEditEntry?.(entry);
                }
            }
        });

        const closeBtn = backdropEl.querySelector('.kr-icon-close');
        const searchInput = backdropEl.querySelector('.kr-search-input');
        const worldSelect = backdropEl.querySelector('.kr-world-select');
        const hideCb = backdropEl.querySelector('#kr-picker-hide-triggered');

        closeBtn?.addEventListener('click', close);
        searchInput?.addEventListener('input', () => {
            searchQuery = searchInput.value;
            debouncedRefresh();
        });
        worldSelect?.addEventListener('change', () => {
            selectedWorld = worldSelect.value;
            refreshView();
        });
        hideCb?.addEventListener('change', () => {
            hideAlreadyTriggered = Boolean(hideCb.checked);
            onToggleHideTriggered?.(hideAlreadyTriggered);
            refreshView();
        });

        document.body.appendChild(backdropEl);
        document.addEventListener('keydown', onKeyDown);
        refreshView();
        setTimeout(() => searchInput?.focus(), 30);
    }

    return {
        open,
        close,
        isOpen,
        refreshView,
    };
}
