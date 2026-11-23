/**
 * Keyword Radar — Non-Intrusive Radar Bar & Right-Click Mute Context Menu
 *
 * Performance Optimizations:
 *  - Single delegated event listeners on rootEl (zero per-pill listener churn)
 *  - Render HTML diff skip (skips DOM writes & repaints when nothing changed)
 *  - Respects `reduceAnimations` (skips pop-in animation)
 */

import { ACTIVATION_SOURCE, DISPLAY_MODE, FILTER_MODE, MUTE_MODE } from '../constants.js';
import { escapeHtml, formatTokenCount } from '../utils.js';

function cssEscapeSafe(val) {
    const str = String(val ?? '');
    if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
        return CSS.escape(str);
    }
    return str.replace(/["\\]/g, '\\$&');
}

export function createRadarBar({
    state,
    onToggleMute,
    onMuteWithDuration,
    onUnmute,
    onUnboost,
    onOpenBoostPicker,
    onHoverEntry,
    onLeaveEntry,
    onClickEntry,
    onEditEntry,
    onToggleFilterMode,
    onClearAllOverrides,
}) {
    let rootEl = null;
    let contextMenuEl = null;
    let hoverIntentTimer = null;
    let showAllPills = false;
    let inputFocused = false;
    let lastHasActiveLorebooks = true;
    let lastRenderedHtml = '';
    let activeMatchByKey = new Map();
    let currentHoveredPillKey = null;

    function closeContextMenu() {
        if (contextMenuEl && contextMenuEl.parentElement) {
            contextMenuEl.parentElement.removeChild(contextMenuEl);
        }
        contextMenuEl = null;
    }

    function onGlobalClick(e) {
        if (contextMenuEl && !contextMenuEl.contains(e.target)) {
            closeContextMenu();
        }
    }

    function onGlobalKeyDown(e) {
        if (e.key === 'Escape' && contextMenuEl) {
            e.stopPropagation();
            closeContextMenu();
        }
    }

    document.addEventListener('click', onGlobalClick);
    document.addEventListener('keydown', onGlobalKeyDown);

    function bindDelegatedEvents(el) {
        el.addEventListener('click', (e) => {
            const barActBtn = e.target.closest('[data-bar-act]');
            if (barActBtn) {
                const act = barActBtn.dataset.barAct;
                const settings = state.getSettings();
                if (act === 'toggle-compact' && settings.displayMode === DISPLAY_MODE.COMPACT) {
                    state.setCompactExpanded(!state.isCompactExpanded());
                    render(state.getLastScanResult(), { hasActiveLorebooks: lastHasActiveLorebooks });
                } else if (act === 'toggle-filter') {
                    onToggleFilterMode?.();
                } else if (act === 'open-boost') {
                    onOpenBoostPicker?.();
                } else if (act === 'clear-overrides') {
                    onClearAllOverrides?.();
                } else if (act === 'toggle-show-all') {
                    showAllPills = !showAllPills;
                    render(state.getLastScanResult(), { hasActiveLorebooks: lastHasActiveLorebooks });
                }
                return;
            }

            const pillEl = e.target.closest('.kr-pill');
            if (!pillEl) return;
            const match = activeMatchByKey.get(pillEl.dataset.key);
            if (!match) return;

            const actionBtn = e.target.closest('[data-pill-act]');
            if (actionBtn) {
                e.stopPropagation();
                const act = actionBtn.dataset.pillAct;
                if (act === 'mute') onToggleMute?.(match);
                else if (act === 'unmute') onUnmute?.(match);
                else if (act === 'unboost') onUnboost?.(match);
                return;
            }
            onClickEntry?.(match, pillEl);
        });

        el.addEventListener('contextmenu', (e) => {
            const pillEl = e.target.closest('.kr-pill');
            if (!pillEl) return;
            const match = activeMatchByKey.get(pillEl.dataset.key);
            if (!match) return;
            e.preventDefault();
            e.stopPropagation();
            openContextMenu(match, e.clientX, e.clientY);
        });

        el.addEventListener('mouseover', (e) => {
            const pillEl = e.target.closest('.kr-pill');
            if (!pillEl) return;
            const key = pillEl.dataset.key;
            if (key === currentHoveredPillKey) return;

            currentHoveredPillKey = key;
            const match = activeMatchByKey.get(key);
            if (!match) return;

            if (hoverIntentTimer) clearTimeout(hoverIntentTimer);
            onHoverEntry?.(match, pillEl, false);

            if (state.getSettings().hoverPreview) {
                hoverIntentTimer = setTimeout(() => {
                    onHoverEntry?.(match, pillEl, true);
                }, 220);
            }
        });

        el.addEventListener('mouseout', (e) => {
            const pillEl = e.target.closest('.kr-pill');
            if (!pillEl) return;
            if (e.relatedTarget && pillEl.contains(e.relatedTarget)) return;

            const key = pillEl.dataset.key;
            if (key === currentHoveredPillKey) {
                currentHoveredPillKey = null;
            }
            if (hoverIntentTimer) {
                clearTimeout(hoverIntentTimer);
                hoverIntentTimer = null;
            }
            const match = activeMatchByKey.get(key);
            if (match) onLeaveEntry?.(match);
        });
    }

    function mount() {
        if (rootEl && rootEl.isConnected) return rootEl;

        const formSheld = document.getElementById('form_sheld');
        const sendForm = document.getElementById('send_form');
        const anchorParent = formSheld || sendForm?.parentElement;
        if (!anchorParent) return null;

        rootEl = document.createElement('div');
        rootEl.id = 'kr-radar-bar';
        rootEl.className = 'kr-radar-bar';
        rootEl.setAttribute('aria-live', 'polite');

        bindDelegatedEvents(rootEl);

        if (sendForm && sendForm.parentElement === anchorParent) {
            anchorParent.insertBefore(rootEl, sendForm);
        } else {
            anchorParent.prepend(rootEl);
        }

        if (inputFocused) {
            rootEl.classList.add('kr-input-active');
        }

        return rootEl;
    }

    function setInputFocused(focused) {
        inputFocused = Boolean(focused);
        if (rootEl) {
            rootEl.classList.toggle('kr-input-active', inputFocused);
        }
    }

    function unmount() {
        closeContextMenu();
        if (hoverIntentTimer) {
            clearTimeout(hoverIntentTimer);
            hoverIntentTimer = null;
        }
        if (rootEl && rootEl.parentElement) {
            rootEl.parentElement.removeChild(rootEl);
        }
        rootEl = null;
        lastRenderedHtml = '';
        currentHoveredPillKey = null;
        activeMatchByKey.clear();
        document.removeEventListener('click', onGlobalClick);
        document.removeEventListener('keydown', onGlobalKeyDown);
    }

    function openContextMenu(match, x, y) {
        closeContextMenu();

        contextMenuEl = document.createElement('div');
        contextMenuEl.className = 'kr-context-menu';
        contextMenuEl.innerHTML = `
            <div class="kr-ctx-header">${escapeHtml(match.title)}</div>
            ${match.isDirectlyMuted
                ? `<button type="button" class="kr-ctx-item" data-act="unmute"><i class="fa-solid fa-volume-high"></i> Unmute Entry</button>`
                : `<button type="button" class="kr-ctx-item" data-act="mute1"><i class="fa-solid fa-volume-xmark"></i> Mute for 1 turn</button>
                   <button type="button" class="kr-ctx-item" data-act="mute3"><i class="fa-solid fa-clock"></i> Mute for 3 turns</button>
                   <button type="button" class="kr-ctx-item" data-act="mute5"><i class="fa-solid fa-clock"></i> Mute for 5 turns</button>
                   <div class="kr-ctx-custom-row">
                       <input type="number" min="1" max="99" value="2" class="kr-ctx-turns-input text_pole" aria-label="Custom turn count" />
                       <button type="button" class="menu_button kr-ctx-custom-btn" data-act="mutecustom">Mute N turns</button>
                   </div>
                   <button type="button" class="kr-ctx-item kr-ctx-danger" data-act="mutesession"><i class="fa-solid fa-ban"></i> Mute for this chat session</button>`
            }
            ${match.isBoosted ? `<button type="button" class="kr-ctx-item" data-act="unboost"><i class="fa-solid fa-thumbtack-slash"></i> Remove Manual Boost</button>` : ''}
            <div class="kr-ctx-sep"></div>
            <button type="button" class="kr-ctx-item" data-act="inspect"><i class="fa-solid fa-eye"></i> Inspect Entry</button>
            <button type="button" class="kr-ctx-item" data-act="edit"><i class="fa-solid fa-pen-to-square"></i> Edit in World Info</button>
        `;

        document.body.appendChild(contextMenuEl);

        const rect = contextMenuEl.getBoundingClientRect();
        const left = Math.max(8, Math.min(window.innerWidth - rect.width - 8, x));
        const top = Math.max(8, Math.min(window.innerHeight - rect.height - 8, y - rect.height));
        contextMenuEl.style.left = `${Math.round(left)}px`;
        contextMenuEl.style.top = `${Math.round(top)}px`;

        const submitCustomTurns = () => {
            const input = contextMenuEl?.querySelector('.kr-ctx-turns-input');
            const turns = Math.max(1, Math.min(99, parseInt(input?.value || '2', 10) || 2));
            onMuteWithDuration?.(match, { mode: MUTE_MODE.TURNS, turns });
            closeContextMenu();
        };

        contextMenuEl.querySelector('.kr-ctx-turns-input')?.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                submitCustomTurns();
            }
        });

        contextMenuEl.addEventListener('click', (e) => {
            const btn = e.target.closest('[data-act]');
            if (!btn) return;
            const act = btn.dataset.act;
            if (act === 'unmute') onUnmute?.(match);
            else if (act === 'mute1') onMuteWithDuration?.(match, { mode: MUTE_MODE.TURNS, turns: 1 });
            else if (act === 'mute3') onMuteWithDuration?.(match, { mode: MUTE_MODE.TURNS, turns: 3 });
            else if (act === 'mute5') onMuteWithDuration?.(match, { mode: MUTE_MODE.TURNS, turns: 5 });
            else if (act === 'mutecustom') {
                submitCustomTurns();
                return;
            } else if (act === 'mutesession') onMuteWithDuration?.(match, { mode: MUTE_MODE.SESSION });
            else if (act === 'unboost') onUnboost?.(match);
            else if (act === 'inspect') {
                const pillEl = rootEl?.querySelector(`.kr-pill[data-key="${cssEscapeSafe(match.key)}"]`);
                onClickEntry?.(match, pillEl || rootEl);
            } else if (act === 'edit') onEditEntry?.(match);
            closeContextMenu();
        });
    }

    function getSourceBadgeIcon(match) {
        if (match.isMuted) return '<i class="fa-solid fa-volume-xmark kr-pill-type-icon" title="Muted"></i>';
        switch (match.source) {
            case ACTIVATION_SOURCE.BOOSTED:
                return '<i class="fa-solid fa-thumbtack kr-pill-type-icon" title="Manually boosted (1 turn)"></i>';
            case ACTIVATION_SOURCE.RECURSIVE_DRAFT:
                return '<i class="fa-solid fa-diagram-project kr-pill-type-icon" title="Triggered recursively by draft"></i>';
            case ACTIVATION_SOURCE.DRAFT:
                return '<i class="fa-solid fa-bolt kr-pill-type-icon" title="Newly triggered by draft"></i>';
            case ACTIVATION_SOURCE.STICKY:
                return '<i class="fa-solid fa-magnet kr-pill-type-icon" title="Active via sticky timer"></i>';
            case ACTIVATION_SOURCE.CONSTANT:
                return '<i class="fa-solid fa-infinity kr-pill-type-icon" title="Constant entry"></i>';
            default:
                return '<i class="fa-solid fa-clock-rotate-left kr-pill-type-icon" title="Already active from chat history"></i>';
        }
    }

    function getMuteBadgeLabel(match) {
        if (match.suppressedByParentMute) return 'via parent';
        if (!match.muteInfo) return '';
        if (match.muteInfo.mode === MUTE_MODE.SESSION) return 'chat';
        return `${match.muteInfo.remainingTurns}t`;
    }

    function render(scanResult, { hasActiveLorebooks = true } = {}) {
        lastHasActiveLorebooks = hasActiveLorebooks;
        const el = mount();
        if (!el) return;

        const settings = state.getSettings();
        if (!settings.enabled || !hasActiveLorebooks) {
            el.classList.add('kr-hidden');
            return;
        }

        const matches = scanResult?.matches || [];
        const summary = scanResult?.summary || {
            newCount: 0,
            activeNewCount: 0,
            activeNewTokens: 0,
            mutedCount: 0,
            mutedTokens: 0,
            alreadyActiveCount: 0,
            boostedCount: 0,
            budgetTokens: 0,
            budgetUsedTokens: 0,
            budgetExceeded: false,
            overflowCount: 0,
        };

        const hasNewOrBoost = summary.newCount > 0 || summary.boostedCount > 0;
        if (settings.autoHideWhenNoNewTriggers && !hasNewOrBoost) {
            el.classList.add('kr-hidden');
            return;
        }

        const wasHidden = el.classList.contains('kr-hidden');
        el.classList.remove('kr-hidden');
        if (wasHidden && settings.autoHideWhenNoNewTriggers && !settings.reduceAnimations) {
            el.classList.remove('kr-pop-in');
            void el.offsetWidth;
            el.classList.add('kr-pop-in');
        }

        const visibleMatches = settings.filterMode === FILTER_MODE.DRAFT_ONLY
            ? matches.filter((m) => m.isNew || m.isDirectlyMuted)
            : matches;

        const maxBadges = Math.max(4, Number(settings.maxVisibleBadges) || 24);
        if (visibleMatches.length <= maxBadges) {
            showAllPills = false;
        }
        const shownMatches = showAllPills ? visibleMatches : visibleMatches.slice(0, maxBadges);
        const overflowCount = Math.max(0, visibleMatches.length - shownMatches.length);

        const isCompact = settings.displayMode === DISPLAY_MODE.COMPACT;
        const isExpanded = !isCompact || state.isCompactExpanded();

        const summaryParts = [];
        if (summary.activeNewCount > 0) {
            summaryParts.push(`<span class="kr-sum-new">+${formatTokenCount(summary.activeNewTokens)} tok (${summary.activeNewCount} new)</span>`);
        } else if (visibleMatches.length === 0) {
            summaryParts.push(`<span class="kr-sum-idle">No draft triggers</span>`);
        }
        if (summary.mutedCount > 0) {
            summaryParts.push(`<span class="kr-sum-muted">${summary.mutedCount} muted (-${formatTokenCount(summary.mutedTokens)}t)</span>`);
        }
        if (summary.alreadyActiveCount > 0 && settings.filterMode === FILTER_MODE.DRAFT_ONLY) {
            summaryParts.push(`<span class="kr-sum-bg">${summary.alreadyActiveCount} active</span>`);
        }
        if (settings.showBudgetWarning && summary.budgetTokens > 0 && summary.budgetExceeded) {
            summaryParts.push(
                `<span class="kr-sum-budget-warn" title="Lorebook budget (${formatTokenCount(summary.budgetTokens)}t) exceeded; ${summary.overflowCount} lower-order entry(ies) may be dropped"><i class="fa-solid fa-triangle-exclamation"></i> Budget (${summary.overflowCount} over)</span>`,
            );
        }

        const filterLabel = settings.filterMode === FILTER_MODE.DRAFT_ONLY ? 'New' : 'All';
        const hasOverrides = state.getMutes().size > 0 || state.getBoosts().size > 0;
        const boostHint = settings.enableHotkeys ? ' (Alt+B)' : '';

        const headerHtml = `
            <div class="kr-bar-header">
                <button type="button" class="kr-radar-toggle" data-bar-act="toggle-compact" title="Keyword Radar — Pre-Send Lorebook Scanner">
                    <i class="fa-solid fa-satellite-dish kr-radar-icon ${summary.activeNewCount > 0 ? 'kr-radar-active' : ''}"></i>
                    <span class="kr-summary-text">${summaryParts.join('<span class="kr-sum-dot">·</span>')}</span>
                    ${isCompact ? `<i class="fa-solid fa-chevron-${isExpanded ? 'down' : 'up'} kr-compact-chevron"></i>` : ''}
                </button>
                <div class="kr-bar-controls">
                    <button type="button" class="menu_button kr-mini-btn" data-bar-act="toggle-filter" title="Switch between newly triggered draft entries and all active entries">
                        <i class="fa-solid fa-filter"></i> ${filterLabel}
                    </button>
                    <button type="button" class="menu_button kr-mini-btn kr-mini-boost" data-bar-act="open-boost" title="Open Boost & Pre-Flight Manager${boostHint}">
                        <i class="fa-solid fa-thumbtack"></i> Boost
                    </button>
                    ${hasOverrides
                        ? `<button type="button" class="menu_button kr-mini-btn kr-mini-clear" data-bar-act="clear-overrides" title="Clear all active mutes and manual boosts">
                               <i class="fa-solid fa-rotate-left"></i>
                           </button>`
                        : ''}
                </div>
            </div>
        `;

        let pillsHtml = '';
        if (isExpanded && shownMatches.length > 0) {
            const pillItems = shownMatches.map((m) => {
                const classes = ['kr-pill', `kr-pill-${m.source}`];
                if (m.isMuted) classes.push('kr-pill-muted');
                if (m.suppressedByParentMute) classes.push('kr-pill-parent-muted');
                if (m.budgetOverflow && !m.isMuted) classes.push('kr-pill-overflow-warn');

                const draftKw = (m.matchedKeywords || []).find((k) => k.inDraft)?.substituted || '';
                const tooltipParts = [
                    `${m.title} (${m.world})`,
                    `~${formatTokenCount(m.tokens)} tokens`,
                    draftKw ? `Matched: "${draftKw}"` : '',
                    m.isRecursive && m.triggeredBy?.[0] ? `Recursive from: ${m.triggeredBy[0].title}` : '',
                    m.hasProbability ? `Probability: ${m.probability}%` : '',
                    m.groupCompetitors?.length ? `Competes in group "${m.inclusionGroup}" with: ${m.groupCompetitors.join(', ')}` : '',
                    m.budgetOverflow ? 'Warning: may be dropped by World Info token budget' : '',
                    'Click to inspect · Right-click for mute options',
                ].filter(Boolean);

                const muteLabel = getMuteBadgeLabel(m);
                const probTag = m.hasProbability
                    ? `<span class="kr-pill-meta-tag" title="Trigger probability: ${m.probability}%"><i class="fa-solid fa-dice"></i> ${m.probability}%</span>`
                    : '';
                const groupTag = m.groupCompetitors?.length
                    ? `<span class="kr-pill-meta-tag" title="Inclusion group conflict: ${escapeHtml(m.inclusionGroup)}"><i class="fa-solid fa-layer-group"></i></span>`
                    : '';
                const budgetTag = m.budgetOverflow && !m.isMuted
                    ? `<span class="kr-pill-warn-tag" title="Exceeds World Info token budget"><i class="fa-solid fa-triangle-exclamation"></i></span>`
                    : '';

                const actionBtn = m.isBoosted
                    ? `<button type="button" class="kr-pill-action" data-pill-act="unboost" title="Remove 1-turn boost"><i class="fa-solid fa-xmark"></i></button>`
                    : (m.isDirectlyMuted
                        ? `<button type="button" class="kr-pill-action" data-pill-act="unmute" title="Unmute entry"><i class="fa-solid fa-rotate-left"></i></button>`
                        : `<button type="button" class="kr-pill-action" data-pill-act="mute" title="Mute for next turn (right-click for more)"><i class="fa-solid fa-volume-xmark"></i></button>`
                    );

                return `
                    <div class="${classes.join(' ')}" data-key="${escapeHtml(m.key)}" title="${escapeHtml(tooltipParts.join(' — '))}">
                        ${getSourceBadgeIcon(m)}
                        <span class="kr-pill-title">${escapeHtml(m.title)}</span>
                        ${settings.showLorebookName ? `<span class="kr-pill-world">${escapeHtml(m.world)}</span>` : ''}
                        ${settings.showTokenEstimate ? `<span class="kr-pill-tokens">~${formatTokenCount(m.tokens)}t</span>` : ''}
                        ${probTag}${groupTag}${budgetTag}
                        ${muteLabel ? `<span class="kr-pill-mute-tag">${escapeHtml(muteLabel)}</span>` : ''}
                        ${actionBtn}
                    </div>
                `;
            }).join('');

            let overflowHtml = '';
            if (overflowCount > 0) {
                overflowHtml = `<button type="button" class="kr-pill-overflow-btn" data-bar-act="toggle-show-all" title="Click to show all ${visibleMatches.length} entries">+${overflowCount} more</button>`;
            } else if (showAllPills && visibleMatches.length > maxBadges) {
                overflowHtml = `<button type="button" class="kr-pill-overflow-btn" data-bar-act="toggle-show-all" title="Collapse extra entries">Show less</button>`;
            }

            pillsHtml = `<div class="kr-pill-list ${showAllPills ? 'kr-pill-list-expanded' : ''}">${pillItems}${overflowHtml}</div>`;
        }

        // Always keep match lookup fresh for delegated events
        activeMatchByKey = new Map(shownMatches.map((m) => [m.key, m]));
        if (currentHoveredPillKey && !activeMatchByKey.has(currentHoveredPillKey)) {
            currentHoveredPillKey = null;
        }

        el.classList.toggle('kr-compact-mode', isCompact && !isExpanded);
        el.classList.toggle('kr-input-active', inputFocused);

        const nextHtml = `${headerHtml}${pillsHtml}`;
        if (nextHtml !== lastRenderedHtml) {
            el.innerHTML = nextHtml;
            lastRenderedHtml = nextHtml;
        }
    }

    return {
        mount,
        unmount,
        render,
        setInputFocused,
    };
}
