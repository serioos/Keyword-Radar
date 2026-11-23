/**
 * Keyword Radar — Quick Entry Preview & Inspection Popover
 *
 * Uses native SillyTavern SmartTheme surfaces and `.menu_button` controls.
 * Displays full content, keywords, recursive chain trace, probability, inclusion group
 * competitors, budget overflow warning, and "Edit in World Info".
 */

import { ACTIVATION_SOURCE, MUTE_MODE, WI_LOGIC_LABELS, WI_POSITION_LABELS } from '../constants.js';
import { escapeHtml, formatTokenCount } from '../utils.js';

const SOURCE_DESCRIPTIONS = {
    [ACTIVATION_SOURCE.DRAFT]: 'Newly triggered by your current draft',
    [ACTIVATION_SOURCE.RECURSIVE_DRAFT]: 'Triggered recursively by your draft',
    [ACTIVATION_SOURCE.BOOSTED]: 'Manually force-triggered (1 turn)',
    [ACTIVATION_SOURCE.HISTORY]: 'Already active from recent chat history',
    [ACTIVATION_SOURCE.RECURSIVE_HISTORY]: 'Already active recursively from chat history',
    [ACTIVATION_SOURCE.CONSTANT]: 'Always active (Constant / @@activate)',
    [ACTIVATION_SOURCE.STICKY]: 'Already active via Sticky timer',
};

export function createPreviewPopover({ onMute, onUnmute, onUnboost, onEditInWorldInfo }) {
    let popoverEl = null;
    let currentMatch = null;
    let pinned = false;
    let hideTimer = null;

    function ensureEl() {
        if (popoverEl && popoverEl.isConnected) return popoverEl;
        popoverEl = document.createElement('div');
        popoverEl.id = 'kr-preview-popover';
        popoverEl.className = 'kr-preview-popover kr-hidden';
        popoverEl.setAttribute('role', 'dialog');
        popoverEl.setAttribute('aria-label', 'Lorebook Entry Preview');

        popoverEl.addEventListener('mouseenter', () => {
            if (hideTimer) {
                clearTimeout(hideTimer);
                hideTimer = null;
            }
        });

        popoverEl.addEventListener('mouseleave', () => {
            if (!pinned) {
                scheduleHide(180);
            }
        });

        // Single delegated action handler (zero per-show listener churn)
        popoverEl.addEventListener('click', (e) => {
            const btn = e.target.closest('[data-action]');
            if (!btn) return;
            const act = btn.dataset.action;
            const match = currentMatch;

            if (act === 'close') {
                hide();
            } else if (match) {
                if (act === 'mute1') {
                    onMute?.(match, { mode: MUTE_MODE.TURNS, turns: 1 });
                    hide();
                } else if (act === 'mutesession') {
                    onMute?.(match, { mode: MUTE_MODE.SESSION });
                    hide();
                } else if (act === 'unmute') {
                    onUnmute?.(match);
                    hide();
                } else if (act === 'unboost') {
                    onUnboost?.(match);
                    hide();
                } else if (act === 'edit') {
                    onEditInWorldInfo?.(match);
                    hide();
                }
            }
        });

        document.body.appendChild(popoverEl);
        return popoverEl;
    }

    function onDocumentClick(e) {
        if (!popoverEl || popoverEl.classList.contains('kr-hidden')) return;
        if (popoverEl.contains(e.target)) return;
        if (e.target.closest?.('.kr-pill')) return;
        hide();
    }

    function onKeyDown(e) {
        if (e.key === 'Escape' && popoverEl && !popoverEl.classList.contains('kr-hidden')) {
            e.stopPropagation();
            hide();
        }
    }

    document.addEventListener('click', onDocumentClick);
    document.addEventListener('keydown', onKeyDown);

    function scheduleHide(delayMs = 200) {
        if (hideTimer) clearTimeout(hideTimer);
        hideTimer = setTimeout(() => {
            hideTimer = null;
            if (!pinned) hide();
        }, delayMs);
    }

    function cancelHide() {
        if (hideTimer) {
            clearTimeout(hideTimer);
            hideTimer = null;
        }
    }

    function hide() {
        cancelHide();
        pinned = false;
        currentMatch = null;
        if (popoverEl) {
            popoverEl.classList.add('kr-hidden');
        }
    }

    function positionNearAnchor(anchorEl) {
        if (!popoverEl || !anchorEl) return;
        const rect = anchorEl.getBoundingClientRect();
        const popRect = popoverEl.getBoundingClientRect();
        const margin = 10;

        let top = rect.top - popRect.height - margin;
        if (top < margin) {
            top = rect.bottom + margin;
        }
        top = Math.max(margin, Math.min(window.innerHeight - popRect.height - margin, top));

        let left = rect.left;
        if (left + popRect.width > window.innerWidth - margin) {
            left = window.innerWidth - popRect.width - margin;
        }
        left = Math.max(margin, left);

        popoverEl.style.top = `${Math.round(top)}px`;
        popoverEl.style.left = `${Math.round(left)}px`;
    }

    function renderKeywords(match) {
        const entry = match.entry || {};
        const primaryKeys = Array.isArray(entry.key) ? entry.key : [];
        const secondaryKeys = Array.isArray(entry.keysecondary) ? entry.keysecondary.filter(Boolean) : [];

        const matchedPrimarySet = new Set(
            (match.matchedKeywords || []).filter((k) => !k.isSecondary).map((k) => k.raw),
        );
        const matchedSecondarySet = new Set(
            (match.matchedKeywords || []).filter((k) => k.isSecondary).map((k) => k.raw),
        );

        const primaryHtml = primaryKeys.length > 0
            ? primaryKeys.map((k) => {
                const isHit = matchedPrimarySet.has(k);
                return `<span class="kr-kw-chip ${isHit ? 'kr-kw-hit' : ''}">${escapeHtml(k)}</span>`;
            }).join('')
            : '<span class="kr-muted-text">No primary keywords</span>';

        let secondaryHtml = '';
        if (entry.selective && secondaryKeys.length > 0) {
            const logicLabel = WI_LOGIC_LABELS[match.selectiveLogic] || 'AND ANY';
            const secChips = secondaryKeys.map((k) => {
                const isHit = matchedSecondarySet.has(k);
                return `<span class="kr-kw-chip kr-kw-secondary ${isHit ? 'kr-kw-hit' : ''}">${escapeHtml(k)}</span>`;
            }).join('');
            secondaryHtml = `
                <div class="kr-pop-kw-row">
                    <span class="kr-pop-label">Secondary (${escapeHtml(logicLabel)}):</span>
                    <div class="kr-kw-list">${secChips}</div>
                </div>
            `;
        }

        return `
            <div class="kr-pop-kw-section">
                <div class="kr-pop-kw-row">
                    <span class="kr-pop-label">Keywords:</span>
                    <div class="kr-kw-list">${primaryHtml}</div>
                </div>
                ${secondaryHtml}
            </div>
        `;
    }

    function renderTriggerTrace(match) {
        const reasonText = SOURCE_DESCRIPTIONS[match.source] || 'Active Lorebook entry';
        let detail = '';

        if (match.suppressedByParentMute) {
            detail += '<div class="kr-pop-trace-sub kr-trace-muted">Suppressed because its parent entry is muted.</div>';
        } else if (match.isDirectlyMuted && match.muteInfo) {
            const muteLabel = match.muteInfo.mode === MUTE_MODE.SESSION
                ? 'Muted for remainder of chat session'
                : `Muted for ${match.muteInfo.remainingTurns} turn${match.muteInfo.remainingTurns === 1 ? '' : 's'}`;
            detail += `<div class="kr-pop-trace-sub kr-trace-muted">${escapeHtml(muteLabel)}</div>`;
        }

        if (match.isRecursive && Array.isArray(match.triggeredBy) && match.triggeredBy.length > 0) {
            const parents = match.triggeredBy
                .map((p) => `<strong>${escapeHtml(p.title)}</strong>${p.matchedKeyword ? ` (<code>${escapeHtml(p.matchedKeyword)}</code>)` : ''}`)
                .join(', ');
            detail += `<div class="kr-pop-trace-sub">Recursive chain (depth ${match.recursionDepth}): ${parents} → this entry</div>`;
        } else {
            const draftHits = (match.matchedKeywords || []).filter((k) => k.inDraft);
            if (draftHits.length > 0) {
                const words = draftHits.map((k) => `<code>${escapeHtml(k.substituted)}</code>`).join(', ');
                detail += `<div class="kr-pop-trace-sub">Matched in draft: ${words}</div>`;
            }
        }

        if (match.hasProbability) {
            detail += `<div class="kr-pop-trace-sub"><i class="fa-solid fa-dice"></i> Trigger chance: <strong>${match.probability}%</strong></div>`;
        }

        if (match.inclusionGroup) {
            const comp = match.groupCompetitors?.length
                ? ` (competing with ${escapeHtml(match.groupCompetitors.join(', '))})`
                : '';
            detail += `<div class="kr-pop-trace-sub"><i class="fa-solid fa-layer-group"></i> Inclusion group: <strong>${escapeHtml(match.inclusionGroup)}</strong>${comp}</div>`;
        }

        if (match.budgetOverflow && !match.isMuted) {
            detail += `<div class="kr-pop-trace-sub kr-trace-warn"><i class="fa-solid fa-triangle-exclamation"></i> Exceeds World Info token budget — may be dropped on send.</div>`;
        }

        return `
            <div class="kr-pop-trace">
                <span class="kr-pop-source-tag kr-source-${escapeHtml(match.source)}">${escapeHtml(reasonText)}</span>
                ${detail}
            </div>
        `;
    }

    function show(match, anchorEl, { isPinned = false } = {}) {
        cancelHide();
        if (!match) return;

        currentMatch = match;
        pinned = Boolean(isPinned);
        const el = ensureEl();

        const posLabel = WI_POSITION_LABELS[match.entry?.position] || 'World Info';
        const depthSuffix = match.entry?.position === 4 ? ` (${match.entry?.depth ?? 4})` : '';

        const muteBtnHtml = match.isDirectlyMuted
            ? `<button type="button" class="menu_button kr-btn-sm kr-btn-boosted" data-action="unmute"><i class="fa-solid fa-volume-high"></i> Unmute</button>`
            : `<button type="button" class="menu_button kr-btn-sm kr-btn-warn" data-action="mute1"><i class="fa-solid fa-volume-xmark"></i> Mute 1 Turn</button>
               <button type="button" class="menu_button kr-btn-sm" data-action="mutesession" title="Mute for this entire chat"><i class="fa-solid fa-ban"></i> Mute Chat</button>`;

        const boostBtnHtml = match.isBoosted
            ? `<button type="button" class="menu_button kr-btn-sm" data-action="unboost"><i class="fa-solid fa-thumbtack-slash"></i> Unpin Boost</button>`
            : '';

        el.innerHTML = `
            <div class="kr-pop-header">
                <div class="kr-pop-title-wrap">
                    <div class="kr-pop-title">${escapeHtml(match.title)}</div>
                    <div class="kr-pop-meta">
                        <span><i class="fa-solid fa-book-open"></i> ${escapeHtml(match.world)}</span>
                        <span>·</span>
                        <span>~${formatTokenCount(match.tokens)} tok</span>
                        <span>·</span>
                        <span>${escapeHtml(posLabel + depthSuffix)}</span>
                        <span>·</span>
                        <span>UID ${escapeHtml(match.uid)}</span>
                    </div>
                </div>
                <button type="button" class="menu_button kr-icon-close" data-action="close" title="Close">&times;</button>
            </div>
            ${renderTriggerTrace(match)}
            ${renderKeywords(match)}
            <div class="kr-pop-content-wrap">
                <div class="kr-pop-content">${escapeHtml(match.content || '(Empty entry content)')}</div>
            </div>
            <div class="kr-pop-footer">
                <div class="kr-pop-actions-left">
                    ${muteBtnHtml}
                    ${boostBtnHtml}
                </div>
                <button type="button" class="menu_button kr-btn-sm" data-action="edit" title="Locate or edit this entry in SillyTavern World Info">
                    <i class="fa-solid fa-pen-to-square"></i> Edit in World Info
                </button>
            </div>
        `;

        el.classList.remove('kr-hidden');
        positionNearAnchor(anchorEl);
    }

    function destroy() {
        cancelHide();
        document.removeEventListener('click', onDocumentClick);
        document.removeEventListener('keydown', onKeyDown);
        if (popoverEl && popoverEl.parentElement) {
            popoverEl.parentElement.removeChild(popoverEl);
        }
        popoverEl = null;
        currentMatch = null;
        pinned = false;
    }

    return {
        show,
        hide,
        scheduleHide,
        cancelHide,
        isPinned: () => pinned,
        getCurrentKey: () => currentMatch?.key || null,
        destroy,
    };
}
