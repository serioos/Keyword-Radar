/**
 * Keyword Radar — Radar Bar, Badges, Inspection Popover, Context Menu, Quick Editor, Manual Boost & Diagnostics Modal
 * https://github.com/serioos/Keyword-Radar
 */

import {
    LORE_SCOPE_META,
    SELECTIVE_LOGIC_LABELS,
    SELECTIVE_LOGIC_SHORT,
    TRIGGER_STATUS,
    WI_POSITION_LABELS,
} from './constants.js';
import {
    getSettings,
    openWorldInfoEntryInEditor,
    saveLorebookEntryFields,
    saveSettings,
} from './st-bridge.js';
import { escapeAttr, escapeHtml, formatTokens } from './utils.js';

export class RadarUIController {
    constructor(deps) {
        this.state = deps.stateManager;
        this.highlighter = deps.highlighter;
        this.onRequestRescan = deps.onRequestRescan;
        this.getAllLoadedEntries = deps.getAllLoadedEntries;
        this.getTokenCountForEntry = deps.getTokenCountForEntry;
        this.getDiagnosticSnapshotContext = deps.getDiagnosticSnapshotContext || (() => ({}));

        this.barContainer = null;
        this.popoverEl = null;
        this.contextMenuEl = null;
        this.modalBackdropEl = null;
        this.lastScanResult = null;
        this.pinnedPopoverKey = null;
        this.hoverCloseTimer = null;
    }

    mount() {
        if (this.barContainer && document.body.contains(this.barContainer)) return;

        const sendForm = document.querySelector('#send_form') || document.querySelector('#form_sheld');
        if (!sendForm) return;

        const bar = document.createElement('div');
        bar.id = 'kr-radar-bar';
        bar.className = 'kr-radar-bar';
        bar.setAttribute('role', 'region');
        bar.setAttribute('aria-label', 'Keyword Radar Pre-Send Lorebook Scanner');

        const nonQRFormItems = sendForm.querySelector('#nonQRFormItems');
        if (nonQRFormItems) {
            sendForm.insertBefore(bar, nonQRFormItems);
        } else {
            sendForm.prepend(bar);
        }

        this.barContainer = bar;
        this._ensureOverlays();
        this._bindBarEvents();
    }

    _ensureOverlays() {
        if (!this.popoverEl) {
            const pop = document.createElement('div');
            pop.id = 'kr-entry-popover';
            pop.className = 'kr-popover kr-hidden';
            document.body.appendChild(pop);
            this.popoverEl = pop;

            pop.addEventListener('mouseenter', () => {
                if (this.hoverCloseTimer) {
                    clearTimeout(this.hoverCloseTimer);
                    this.hoverCloseTimer = null;
                }
            });
            pop.addEventListener('mouseleave', () => {
                if (!this.pinnedPopoverKey) this.scheduleClosePopover(180);
            });
        }

        if (!this.contextMenuEl) {
            const menu = document.createElement('div');
            menu.id = 'kr-context-menu';
            menu.className = 'kr-context-menu kr-hidden';
            document.body.appendChild(menu);
            this.contextMenuEl = menu;
        }

        if (!this.modalBackdropEl) {
            const modal = document.createElement('div');
            modal.id = 'kr-modal-backdrop';
            modal.className = 'kr-modal-backdrop kr-hidden';
            document.body.appendChild(modal);
            this.modalBackdropEl = modal;
        }

        document.addEventListener('mousedown', (e) => {
            const target = /** @type {HTMLElement} */ (e.target);
            if (this.contextMenuEl && !this.contextMenuEl.classList.contains('kr-hidden')) {
                if (!this.contextMenuEl.contains(target)) this.closeContextMenu();
            }
            if (this.popoverEl && !this.popoverEl.classList.contains('kr-hidden')) {
                if (!this.popoverEl.contains(target) && !target.closest('.kr-badge')) {
                    this.closePopover();
                }
            }
        });

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                this.closeContextMenu();
                this.closePopover();
                this.closeModal();
            }
        });
    }

    _bindBarEvents() {
        if (!this.barContainer) return;

        this.barContainer.addEventListener('click', async (e) => {
            const target = /** @type {HTMLElement} */ (e.target);

            const muteBtn = target.closest('[data-kr-action="toggle-mute"]');
            if (muteBtn) {
                e.stopPropagation();
                const badge = muteBtn.closest('.kr-badge');
                const entryKey = badge?.getAttribute('data-entry-key');
                if (entryKey) this._handleToggleMuteByKey(entryKey);
                return;
            }

            // Unmute parent(s) when clicking the speaker button on a recursive-muted child badge
            const unmuteParentsBtn = target.closest('[data-kr-action="unmute-parents"]');
            if (unmuteParentsBtn) {
                e.stopPropagation();
                const badge = unmuteParentsBtn.closest('.kr-badge');
                const entryKey = badge?.getAttribute('data-entry-key');
                if (entryKey) this._handleUnmuteParentsByChildKey(entryKey);
                return;
            }

            const unboostBtn = target.closest('[data-kr-action="remove-boost"]');
            if (unboostBtn) {
                e.stopPropagation();
                const badge = unboostBtn.closest('.kr-badge');
                const entryKey = badge?.getAttribute('data-entry-key');
                if (entryKey) this.state.removeBoost(entryKey);
                return;
            }

            const badgeEl = target.closest('.kr-badge');
            if (badgeEl) {
                e.stopPropagation();
                const entryKey = badgeEl.getAttribute('data-entry-key');
                if (!entryKey) return;
                if (this.pinnedPopoverKey === entryKey && !this.popoverEl?.classList.contains('kr-hidden')) {
                    this.closePopover();
                } else {
                    this.pinnedPopoverKey = entryKey;
                    this.openPopoverForKey(entryKey, /** @type {HTMLElement} */ (badgeEl));
                }
                return;
            }

            const actionEl = target.closest('[data-kr-action]');
            if (!actionEl) return;
            const action = actionEl.getAttribute('data-kr-action');

            switch (action) {
                case 'open-boost-modal':
                    this.openManualBoostModal();
                    break;
                case 'cycle-filter':
                    this._cycleFilterMode();
                    break;
                case 'clear-mutes':
                    this.state.clearAllMutes(true);
                    break;
                case 'refresh-radar':
                    await this.onRequestRescan(true);
                    break;
                case 'toggle-collapse':
                    this.state.isCollapsed = !this.state.isCollapsed;
                    this.render(this.lastScanResult);
                    break;
            }
        });

        this.barContainer.addEventListener('contextmenu', (e) => {
            const target = /** @type {HTMLElement} */ (e.target);
            const badgeEl = target.closest('.kr-badge');
            if (!badgeEl) return;
            e.preventDefault();
            e.stopPropagation();
            const entryKey = badgeEl.getAttribute('data-entry-key');
            if (entryKey) this.openContextMenuForKey(entryKey, e.clientX, e.clientY);
        });

        this.barContainer.addEventListener('mouseover', (e) => {
            const target = /** @type {HTMLElement} */ (e.target);
            const badgeEl = target.closest('.kr-badge');
            if (!badgeEl) return;

            const entryKey = badgeEl.getAttribute('data-entry-key');
            if (!entryKey) return;

            this.highlighter.setHoveredEntryKey(entryKey);

            const settings = getSettings();
            if (settings.hoverPreview && !this.pinnedPopoverKey) {
                if (this.hoverCloseTimer) {
                    clearTimeout(this.hoverCloseTimer);
                    this.hoverCloseTimer = null;
                }
                this.openPopoverForKey(entryKey, /** @type {HTMLElement} */ (badgeEl));
            }
        });

        this.barContainer.addEventListener('mouseout', (e) => {
            const target = /** @type {HTMLElement} */ (e.target);
            const related = /** @type {HTMLElement|null} */ (e.relatedTarget);
            const badgeEl = target.closest('.kr-badge');
            if (!badgeEl) return;
            if (related && badgeEl.contains(related)) return;

            this.highlighter.setHoveredEntryKey(null);
            if (!this.pinnedPopoverKey) this.scheduleClosePopover(220);
        });
    }

    _handleToggleMuteByKey(entryKey) {
        const item = this.lastScanResult?.resultsMap?.get(entryKey);
        if (item) {
            this.state.toggleOneTurnMute({
                entryKey,
                world: item.entry.world,
                uid: item.entry.uid,
                comment: item.entry.comment,
                content: item.entry.content,
                key: item.entry.key,
            });
            return;
        }
        if (this.state.isMuted(entryKey)) {
            this.state.removeMute(entryKey);
        }
    }

    /**
     * Unmutes the blocking parent entry(ies) of a `MUTED_RECURSIVE` child entry.
     * @param {string} childEntryKey
     */
    _handleUnmuteParentsByChildKey(childEntryKey) {
        const item = this.lastScanResult?.resultsMap?.get(childEntryKey);
        if (!item || !Array.isArray(item.triggeredByParents)) return;
        for (const parent of item.triggeredByParents) {
            if (parent.entryKey && this.state.isMuted(parent.entryKey)) {
                this.state.removeMute(parent.entryKey);
            }
        }
    }

    _cycleFilterMode() {
        const settings = getSettings();
        const current = this.state.filterModeOverride || settings.defaultFilterMode || 'new-only';
        const order = ['new-only', 'new-and-history', 'all-active'];
        this.state.filterModeOverride = order[(order.indexOf(current) + 1) % order.length];
        this.render(this.lastScanResult);
    }

    getActiveFilterMode() {
        const settings = getSettings();
        return this.state.filterModeOverride || settings.defaultFilterMode || 'new-only';
    }

    render(scanResult) {
        this.lastScanResult = scanResult;
        this.mount();
        if (!this.barContainer) return;

        const settings = getSettings();
        if (!settings.enabled) {
            this.barContainer.classList.add('kr-hidden');
            return;
        }

        const items = scanResult?.items || [];
        const summary = scanResult?.summary || {
            newDraftTokens: 0,
            newDirectCount: 0,
            newRecursiveCount: 0,
            newTotalCount: 0,
            mutedCount: 0,
            mutedSavedTokens: 0,
            boostedCount: 0,
            boostedTokens: 0,
            alreadyActiveCount: 0,
            alreadyActiveTokens: 0,
            totalActiveTokens: 0,
        };

        const filterMode = this.getActiveFilterMode();

        const visibleItems = items.filter((item) => {
            if (item.status === TRIGGER_STATUS.MUTED || item.status === TRIGGER_STATUS.MUTED_RECURSIVE) {
                return Boolean(settings.showMutedBadges);
            }
            if (
                item.status === TRIGGER_STATUS.NEW_DIRECT ||
                item.status === TRIGGER_STATUS.NEW_RECURSIVE ||
                item.status === TRIGGER_STATUS.BOOSTED
            ) {
                return true;
            }
            if (filterMode === 'new-only') return false;
            if (filterMode === 'new-and-history') {
                return (
                    item.status === TRIGGER_STATUS.ACTIVE_HISTORY ||
                    item.status === TRIGGER_STATUS.ACTIVE_HISTORY_RECURSIVE ||
                    item.alsoMatchedInDraft
                );
            }
            return true;
        });

        const orphanMutes = [];
        if (settings.showMutedBadges) {
            for (const [muteKey, muteObj] of this.state.mutes.entries()) {
                if (!scanResult?.resultsMap?.has(muteKey)) {
                    orphanMutes.push(muteObj);
                }
            }
        }

        const totalVisibleBadges = visibleItems.length + orphanMutes.length;

        if (settings.autoHideWhenEmpty && totalVisibleBadges === 0 && this.state.boosts.size === 0) {
            this.barContainer.classList.add('kr-hidden');
            return;
        }
        this.barContainer.classList.remove('kr-hidden');

        const isCompactMode = settings.uiMode === 'compact-icon' || this.state.isCollapsed;
        const isHighTokenWarning = settings.tokenWarnThreshold > 0 && summary.newDraftTokens >= settings.tokenWarnThreshold;

        const filterLabelMap = {
            'new-only': 'Draft Triggers',
            'new-and-history': 'Draft + Chat',
            'all-active': 'All Active',
        };

        if (isCompactMode) {
            this.barContainer.innerHTML = `
                <div class="kr-compact-strip ${isHighTokenWarning ? 'kr-warn-pulse' : ''}">
                    <button type="button" class="kr-compact-pill" data-kr-action="toggle-collapse" title="Click to expand Keyword Radar">
                        <i class="fa-solid fa-satellite-dish kr-radar-icon ${summary.newTotalCount > 0 ? 'kr-icon-active' : ''}"></i>
                        <span class="kr-compact-title">Radar</span>
                        <span class="kr-summary-chip kr-chip-new">+${summary.newTotalCount} new</span>
                        <span class="kr-summary-chip ${isHighTokenWarning ? 'kr-chip-warn' : 'kr-chip-tokens'}">+${formatTokens(summary.newDraftTokens)} tok</span>
                        ${summary.mutedCount + orphanMutes.length > 0 ? `
                            <span class="kr-summary-chip kr-chip-muted">
                                <i class="fa-solid fa-volume-xmark"></i> ${summary.mutedCount + orphanMutes.length}
                            </span>
                        ` : ''}
                        <i class="fa-solid fa-chevron-up kr-expand-caret"></i>
                    </button>
                    <button type="button" class="kr-icon-btn" data-kr-action="open-boost-modal" title="Force-Trigger (Boost) a Lorebook entry for 1 turn">
                        <i class="fa-solid fa-bolt"></i>
                    </button>
                </div>
            `;
            return;
        }

        const badgesHtml = visibleItems.map((item) => this._renderBadgeHtml(item)).join('');
        const orphanMutesHtml = orphanMutes.map((mute) => this._renderOrphanMuteBadgeHtml(mute)).join('');

        const emptyStateHtml = totalVisibleBadges === 0
            ? `<div class="kr-empty-hint">
                   <span>No ${filterMode === 'new-only' ? 'new draft' : 'matching'} Lorebook triggers detected.</span>
                   ${summary.alreadyActiveCount > 0 && filterMode === 'new-only'
                       ? `<button type="button" class="kr-inline-link" data-kr-action="cycle-filter">
                              Show ${summary.alreadyActiveCount} already-active (${formatTokens(summary.alreadyActiveTokens)} tok)
                          </button>`
                       : ''}
               </div>`
            : '';

        this.barContainer.innerHTML = `
            <div class="kr-bar-header">
                <div class="kr-bar-left">
                    <button type="button" class="kr-brand-btn" data-kr-action="toggle-collapse" title="Collapse Keyword Radar">
                        <i class="fa-solid fa-satellite-dish kr-radar-icon ${summary.newTotalCount > 0 ? 'kr-icon-active' : ''}"></i>
                        <span class="kr-brand-name">Radar</span>
                    </button>

                    <div class="kr-metrics-group">
                        <span class="kr-summary-chip ${summary.newTotalCount > 0 ? 'kr-chip-new' : 'kr-chip-idle'}">
                            <i class="fa-solid fa-bolt-lightning"></i>
                            +${summary.newTotalCount} new
                            ${summary.newRecursiveCount > 0 ? `<small>(+${summary.newRecursiveCount} rec)</small>` : ''}
                        </span>

                        <span class="kr-summary-chip ${isHighTokenWarning ? 'kr-chip-warn' : 'kr-chip-tokens'}">
                            ${isHighTokenWarning ? '<i class="fa-solid fa-triangle-exclamation"></i>' : '<i class="fa-solid fa-coins"></i>'}
                            +${formatTokens(summary.newDraftTokens)} tok
                        </span>

                        ${summary.mutedSavedTokens > 0 ? `
                            <span class="kr-summary-chip kr-chip-saved">
                                <i class="fa-solid fa-shield-halved"></i>
                                &minus;${formatTokens(summary.mutedSavedTokens)} tok muted
                            </span>
                        ` : ''}

                        ${summary.alreadyActiveCount > 0 ? `
                            <span class="kr-summary-chip kr-chip-history">
                                <i class="fa-solid fa-clock-rotate-left"></i>
                                ${summary.alreadyActiveCount} active (${formatTokens(summary.alreadyActiveTokens)} tok)
                            </span>
                        ` : ''}
                    </div>
                </div>

                <div class="kr-bar-actions">
                    <button type="button" class="kr-action-pill" data-kr-action="open-boost-modal"
                            title="Force-Trigger (Pin) any Lorebook entry for the next turn">
                        <i class="fa-solid fa-thumbtack"></i>
                        <span>Boost</span>
                    </button>

                    <button type="button" class="kr-action-pill kr-filter-btn" data-kr-action="cycle-filter"
                            title="Cycle radar filter view (Draft Only / Draft + History / All Active)">
                        <i class="fa-solid fa-filter"></i>
                        <span>${escapeHtml(filterLabelMap[filterMode])}</span>
                    </button>

                    ${this.state.mutes.size > 0 ? `
                        <button type="button" class="kr-icon-btn kr-btn-danger-subtle" data-kr-action="clear-mutes"
                                title="Unmute all ${this.state.mutes.size} muted entries">
                            <i class="fa-solid fa-volume-high"></i>
                        </button>
                    ` : ''}

                    <button type="button" class="kr-icon-btn" data-kr-action="refresh-radar"
                            title="Reload Lorebooks & rescan draft">
                        <i class="fa-solid fa-rotate"></i>
                    </button>
                </div>
            </div>

            <div class="kr-badges-row">
                ${badgesHtml}
                ${orphanMutesHtml}
                ${emptyStateHtml}
            </div>
        `;

        if (this.pinnedPopoverKey && !this.popoverEl?.classList.contains('kr-hidden')) {
            const anchor = this.barContainer.querySelector(`.kr-badge[data-entry-key="${CSS.escape(this.pinnedPopoverKey)}"]`);
            if (anchor) {
                this.openPopoverForKey(this.pinnedPopoverKey, /** @type {HTMLElement} */ (anchor));
            } else {
                this.closePopover();
            }
        }
    }

    _renderBadgeHtml(item) {
        const { entry, entryKey, status, tokens, recursionStep, triggeredChildren, triggeredByParents } = item;
        const scopeMeta = LORE_SCOPE_META[entry.scope] || LORE_SCOPE_META.global;
        const muteInfo = this.state.getMuteInfo(entryKey);

        let statusClass = 'kr-badge--history';
        let statusIcon = 'fa-solid fa-clock-rotate-left';
        let statusTag = '';

        switch (status) {
            case TRIGGER_STATUS.NEW_DIRECT:
                statusClass = 'kr-badge--new-direct';
                statusIcon = 'fa-solid fa-sparkles';
                break;
            case TRIGGER_STATUS.NEW_RECURSIVE:
                statusClass = 'kr-badge--new-recursive';
                statusIcon = 'fa-solid fa-diagram-project';
                statusTag = `<span class="kr-badge-subtag">R${recursionStep}</span>`;
                break;
            case TRIGGER_STATUS.BOOSTED:
                statusClass = 'kr-badge--boosted';
                statusIcon = 'fa-solid fa-thumbtack';
                statusTag = `<span class="kr-badge-subtag">PIN</span>`;
                break;
            case TRIGGER_STATUS.MUTED:
                statusClass = 'kr-badge--muted';
                statusIcon = 'fa-solid fa-volume-xmark';
                statusTag = `<span class="kr-badge-subtag">${muteInfo?.mode === 'session' ? 'chat' : `${muteInfo?.turnsRemaining || 1}t`}</span>`;
                break;
            case TRIGGER_STATUS.MUTED_RECURSIVE:
                statusClass = 'kr-badge--muted-recursive';
                statusIcon = 'fa-solid fa-ban';
                statusTag = `<span class="kr-badge-subtag">parent muted</span>`;
                break;
            case TRIGGER_STATUS.ACTIVE_STICKY:
                statusClass = 'kr-badge--sticky';
                statusIcon = 'fa-solid fa-magnet';
                statusTag = `<span class="kr-badge-subtag">${item.stickyTurnsRemaining || ''}t</span>`;
                break;
            case TRIGGER_STATUS.ACTIVE_CONSTANT:
                statusClass = 'kr-badge--constant';
                statusIcon = 'fa-solid fa-infinity';
                break;
            case TRIGGER_STATUS.ACTIVE_HISTORY_RECURSIVE:
                statusClass = 'kr-badge--history-recursive';
                statusIcon = 'fa-solid fa-diagram-project';
                statusTag = `<span class="kr-badge-subtag">R${recursionStep}</span>`;
                break;
        }

        const matchedKeyPreview = item.draftMatchedPrimaryKeys?.[0] || item.matchedPrimaryKeys?.[0] || '';
        const childCount = Array.isArray(triggeredChildren) ? triggeredChildren.length : 0;
        const isMuted = status === TRIGGER_STATUS.MUTED;
        const isRecursiveMuted = status === TRIGGER_STATUS.MUTED_RECURSIVE;
        const isBoosted = status === TRIGGER_STATUS.BOOSTED;
        const parentNames = Array.isArray(triggeredByParents)
            ? triggeredByParents.map((p) => p.comment).join(', ')
            : 'parent entry';

        let actionBtnHtml = '';
        if (isBoosted) {
            actionBtnHtml = `
                <button type="button" class="kr-badge-mute-btn kr-unboost-btn"
                        data-kr-action="remove-boost"
                        title="Remove 1-turn force-trigger boost">
                    <i class="fa-solid fa-xmark"></i>
                </button>
            `;
        } else if (isRecursiveMuted) {
            actionBtnHtml = `
                <button type="button" class="kr-badge-mute-btn kr-is-muted"
                        data-kr-action="unmute-parents"
                        title="Blocked because ${escapeAttr(parentNames)} is muted. Click to unmute ${escapeAttr(parentNames)}.">
                    <i class="fa-solid fa-volume-high"></i>
                </button>
            `;
        } else {
            actionBtnHtml = `
                <button type="button" class="kr-badge-mute-btn ${isMuted ? 'kr-is-muted' : ''}"
                        data-kr-action="toggle-mute"
                        title="${isMuted ? 'Unmute this entry' : 'Mute this entry for the next turn (1 click)'}">
                    <i class="fa-solid ${isMuted ? 'fa-volume-high' : 'fa-volume-xmark'}"></i>
                </button>
            `;
        }

        return `
            <div class="kr-badge ${statusClass}"
                 data-entry-key="${escapeAttr(entryKey)}"
                 title="Click to inspect &bull; Right-click for multi-turn/session mute options">
                <span class="kr-badge-status-icon"><i class="${statusIcon}"></i></span>
                <span class="kr-badge-title">${escapeHtml(entry.comment)}</span>
                ${matchedKeyPreview ? `
                    <span class="kr-badge-key-hint">&ldquo;${escapeHtml(matchedKeyPreview.length > 14 ? `${matchedKeyPreview.slice(0, 12)}…` : matchedKeyPreview)}&rdquo;</span>
                ` : ''}
                ${childCount > 0 ? `
                    <span class="kr-badge-chain-indicator"><i class="fa-solid fa-sitemap"></i> +${childCount}</span>
                ` : ''}
                ${statusTag}
                <span class="kr-badge-scope">
                    <i class="${scopeMeta.icon}"></i>
                    ${escapeHtml(entry.world.length > 12 ? `${entry.world.slice(0, 10)}…` : entry.world)}
                </span>
                <span class="kr-badge-tokens">${formatTokens(tokens)}t</span>
                ${actionBtnHtml}
            </div>
        `;
    }

    _renderOrphanMuteBadgeHtml(mute) {
        const modeLabel = mute.mode === 'session' ? 'chat' : `${mute.turnsRemaining}t`;
        return `
            <div class="kr-badge kr-badge--muted kr-badge--orphan"
                 data-entry-key="${escapeAttr(mute.entryKey)}"
                 title="Currently muted (${escapeAttr(modeLabel)}). Click speaker icon to restore.">
                <span class="kr-badge-status-icon"><i class="fa-solid fa-volume-xmark"></i></span>
                <span class="kr-badge-title">${escapeHtml(mute.comment || `Entry #${mute.uid}`)}</span>
                <span class="kr-badge-subtag">${escapeHtml(modeLabel)}</span>
                <span class="kr-badge-scope">${escapeHtml(mute.world)}</span>
                <button type="button" class="kr-badge-mute-btn kr-is-muted"
                        data-kr-action="toggle-mute"
                        title="Unmute this entry">
                    <i class="fa-solid fa-volume-high"></i>
                </button>
            </div>
        `;
    }

    openPopoverForKey(entryKey, anchorEl) {
        if (!this.popoverEl) return;
        const item = this.lastScanResult?.resultsMap?.get(entryKey);
        if (!item) return;

        const { entry, status, tokens, matchedPrimaryKeys, matchedSecondaryKeys, draftMatchedPrimaryKeys, triggeredByParents, triggeredChildren } = item;
        const scopeMeta = LORE_SCOPE_META[entry.scope] || LORE_SCOPE_META.global;
        const positionLabel = WI_POSITION_LABELS[entry.position] || `Position ${entry.position}`;
        const muteInfo = this.state.getMuteInfo(entryKey);
        const isMuted = Boolean(muteInfo);
        const isRecursiveMuted = status === TRIGGER_STATUS.MUTED_RECURSIVE;

        let whyReasonHtml = '';
        if (status === TRIGGER_STATUS.NEW_DIRECT) {
            whyReasonHtml = `
                <div class="kr-pop-reason kr-reason--new">
                    <i class="fa-solid fa-sparkles"></i>
                    <div>
                        <strong>Newly Triggered by Your Draft</strong>
                        <div>Matched keyword(s) in draft: <code>${escapeHtml((draftMatchedPrimaryKeys.length ? draftMatchedPrimaryKeys : matchedPrimaryKeys).join(', '))}</code></div>
                    </div>
                </div>
            `;
        } else if (status === TRIGGER_STATUS.NEW_RECURSIVE || status === TRIGGER_STATUS.ACTIVE_HISTORY_RECURSIVE) {
            const parentLinks = triggeredByParents
                .map((p) => `<span class="kr-chain-tag">${escapeHtml(p.comment)} <em>(${escapeHtml(p.matchedKeys.join(', '))})</em></span>`)
                .join(' &rarr; ');
            whyReasonHtml = `
                <div class="kr-pop-reason kr-reason--recursive">
                    <i class="fa-solid fa-diagram-project"></i>
                    <div>
                        <strong>Recursive Trigger (Step ${item.recursionStep})</strong>
                        <div>Woken up by parent entry: ${parentLinks}</div>
                    </div>
                </div>
            `;
        } else if (status === TRIGGER_STATUS.BOOSTED) {
            whyReasonHtml = `
                <div class="kr-pop-reason kr-reason--boosted">
                    <i class="fa-solid fa-thumbtack"></i>
                    <div><strong>Manually Force-Triggered (Boosted)</strong> for the upcoming turn.</div>
                </div>
            `;
        } else if (isMuted || isRecursiveMuted) {
            whyReasonHtml = `
                <div class="kr-pop-reason kr-reason--muted">
                    <i class="fa-solid fa-volume-xmark"></i>
                    <div>
                        <strong>Suppressed (${isRecursiveMuted ? 'Parent Entry Muted' : (muteInfo?.mode === 'session' ? 'Whole Chat Session' : `${muteInfo?.turnsRemaining || 1} Turn(s)`)})</strong>
                        <div>Saves <strong>${formatTokens(tokens)} tokens</strong> on the upcoming generation.</div>
                    </div>
                </div>
            `;
        } else if (status === TRIGGER_STATUS.ACTIVE_STICKY) {
            whyReasonHtml = `
                <div class="kr-pop-reason kr-reason--history">
                    <i class="fa-solid fa-magnet"></i>
                    <div><strong>Already Active via Sticky Timer</strong> (${item.stickyTurnsRemaining || 1} turn(s) remaining).</div>
                </div>
            `;
        } else if (status === TRIGGER_STATUS.ACTIVE_CONSTANT) {
            whyReasonHtml = `
                <div class="kr-pop-reason kr-reason--history">
                    <i class="fa-solid fa-infinity"></i>
                    <div><strong>Constant Entry</strong> (Always active in context unless muted).</div>
                </div>
            `;
        } else {
            whyReasonHtml = `
                <div class="kr-pop-reason kr-reason--history">
                    <i class="fa-solid fa-clock-rotate-left"></i>
                    <div>
                        <strong>Already Active from Recent Chat History</strong> (Scan Depth: ${entry.scanDepth ?? 'Global'})
                        ${item.alsoMatchedInDraft ? '<div><em>Note: Your draft also contains its keyword.</em></div>' : ''}
                    </div>
                </div>
            `;
        }

        const primarySet = new Set(matchedPrimaryKeys);
        const draftPrimarySet = new Set(draftMatchedPrimaryKeys);
        const primaryChipsHtml = entry.key.length > 0
            ? entry.key.map((k) => {
                const cls = draftPrimarySet.has(k)
                    ? 'kr-key-chip kr-key-chip--draft-match'
                    : (primarySet.has(k) ? 'kr-key-chip kr-key-chip--history-match' : 'kr-key-chip');
                return `<span class="${cls}">${escapeHtml(k)}</span>`;
            }).join('')
            : '<span class="kr-muted-text">None</span>';

        const secondarySet = new Set(matchedSecondaryKeys);
        const secondaryChipsHtml = entry.selective && entry.keysecondary.length > 0
            ? `
                <div class="kr-pop-section">
                    <div class="kr-pop-label">Optional Filter (${escapeHtml(SELECTIVE_LOGIC_SHORT[entry.selectiveLogic] || 'AND ANY')})</div>
                    <div class="kr-key-chips-wrap">
                        ${entry.keysecondary.map((k) => `<span class="kr-key-chip ${secondarySet.has(k) ? 'kr-key-chip--draft-match' : ''}">${escapeHtml(k)}</span>`).join('')}
                    </div>
                </div>
            `
            : '';

        const childrenHtml = Array.isArray(triggeredChildren) && triggeredChildren.length > 0
            ? `
                <div class="kr-pop-section">
                    <div class="kr-pop-label"><i class="fa-solid fa-sitemap"></i> Triggers Recursive Children (${triggeredChildren.length})</div>
                    <div class="kr-children-list">
                        ${triggeredChildren.map((c) => `
                            <span class="kr-child-pill">
                                <strong>${escapeHtml(c.comment)}</strong>
                                <small>(${formatTokens(c.tokens)} tok via &ldquo;${escapeHtml(c.matchedKeys.join(', '))}&rdquo;)</small>
                            </span>
                        `).join('')}
                    </div>
                </div>
            `
            : '';

        this.popoverEl.innerHTML = `
            <div class="kr-pop-header">
                <div class="kr-pop-title-block">
                    <span class="kr-pop-title">${escapeHtml(entry.comment)}</span>
                    <span class="kr-pop-subtitle">
                        <i class="${scopeMeta.icon}"></i> ${escapeHtml(entry.world)} (${escapeHtml(scopeMeta.label)})
                        &bull; UID #${escapeHtml(entry.uid)} &bull; ${escapeHtml(positionLabel)} &bull; Order ${entry.order}
                    </span>
                </div>
                <div class="kr-pop-header-right">
                    <span class="kr-pop-token-badge">${formatTokens(tokens)} tokens</span>
                    <button type="button" class="kr-icon-btn" data-kr-pop-action="close"><i class="fa-solid fa-xmark"></i></button>
                </div>
            </div>

            ${whyReasonHtml}

            <div class="kr-pop-section">
                <div class="kr-pop-label">Primary Trigger Keywords</div>
                <div class="kr-key-chips-wrap">${primaryChipsHtml}</div>
            </div>

            ${secondaryChipsHtml}
            ${childrenHtml}

            <div class="kr-pop-section">
                <div class="kr-pop-label">Entry Content Preview</div>
                <div class="kr-pop-content-box">${escapeHtml(entry.content || '(Empty content)')}</div>
            </div>

            <div class="kr-pop-footer">
                <div class="kr-pop-footer-left">
                    ${isRecursiveMuted ? `
                        <button type="button" class="kr-btn kr-btn-success" data-kr-pop-action="unmute-parents">
                            <i class="fa-solid fa-volume-high"></i>
                            <span>Unmute Parent Entry</span>
                        </button>
                    ` : `
                        <button type="button" class="kr-btn ${isMuted ? 'kr-btn-success' : 'kr-btn-warning'}" data-kr-pop-action="toggle-mute">
                            <i class="fa-solid ${isMuted ? 'fa-volume-high' : 'fa-volume-xmark'}"></i>
                            <span>${isMuted ? 'Unmute Entry' : 'Mute 1 Turn'}</span>
                        </button>
                    `}
                    <button type="button" class="kr-btn kr-btn-secondary" data-kr-pop-action="mute-session">
                        <i class="fa-solid fa-ban"></i>
                        <span>Mute for Chat</span>
                    </button>
                </div>
                <div class="kr-pop-footer-right">
                    <button type="button" class="kr-btn kr-btn-secondary" data-kr-pop-action="quick-edit">
                        <i class="fa-solid fa-pen-to-square"></i>
                        <span>Quick Edit</span>
                    </button>
                    <button type="button" class="kr-btn kr-btn-secondary" data-kr-pop-action="open-wi-editor">
                        <i class="fa-solid fa-arrow-up-right-from-square"></i>
                        <span>World Info</span>
                    </button>
                </div>
            </div>
        `;

        this.popoverEl.classList.remove('kr-hidden');
        this._positionFloatingElement(this.popoverEl, anchorEl);

        this.popoverEl.onclick = async (ev) => {
            const btn = /** @type {HTMLElement} */ (ev.target).closest('[data-kr-pop-action]');
            if (!btn) return;
            const act = btn.getAttribute('data-kr-pop-action');
            if (act === 'close') {
                this.closePopover();
            } else if (act === 'toggle-mute') {
                this._handleToggleMuteByKey(entryKey);
            } else if (act === 'unmute-parents') {
                this._handleUnmuteParentsByChildKey(entryKey);
            } else if (act === 'mute-session') {
                this.state.setMute(
                    {
                        entryKey,
                        world: entry.world,
                        uid: entry.uid,
                        comment: entry.comment,
                        content: entry.content,
                        key: entry.key,
                    },
                    'session',
                );
            } else if (act === 'quick-edit') {
                this.closePopover();
                this.openQuickEditModal(entry);
            } else if (act === 'open-wi-editor') {
                this.closePopover();
                await openWorldInfoEntryInEditor(entry.world, entry.uid);
            }
        };
    }

    _positionFloatingElement(floatEl, anchorEl) {
        const anchorRect = anchorEl.getBoundingClientRect();
        const floatRect = floatEl.getBoundingClientRect();
        const margin = 8;

        let top = anchorRect.top - floatRect.height - margin;
        if (top < margin) {
            top = Math.min(window.innerHeight - floatRect.height - margin, anchorRect.bottom + margin);
        }

        let left = anchorRect.left;
        if (left + floatRect.width > window.innerWidth - margin) {
            left = Math.max(margin, window.innerWidth - floatRect.width - margin);
        }

        floatEl.style.top = `${Math.max(margin, Math.round(top))}px`;
        floatEl.style.left = `${Math.max(margin, Math.round(left))}px`;
    }

    scheduleClosePopover(delayMs = 200) {
        if (this.hoverCloseTimer) clearTimeout(this.hoverCloseTimer);
        this.hoverCloseTimer = setTimeout(() => {
            this.hoverCloseTimer = null;
            if (!this.pinnedPopoverKey) this.closePopover();
        }, delayMs);
    }

    closePopover() {
        this.pinnedPopoverKey = null;
        if (this.hoverCloseTimer) {
            clearTimeout(this.hoverCloseTimer);
            this.hoverCloseTimer = null;
        }
        if (this.popoverEl) this.popoverEl.classList.add('kr-hidden');
    }

    openContextMenuForKey(entryKey, clientX, clientY) {
        if (!this.contextMenuEl) return;
        const item = this.lastScanResult?.resultsMap?.get(entryKey);
        const muteInfo = this.state.getMuteInfo(entryKey);
        const entry = item?.entry || {
            world: muteInfo?.world || entryKey.split(':::')[0],
            uid: muteInfo?.uid ?? entryKey.split(':::')[1],
            comment: muteInfo?.comment || `Entry #${entryKey.split(':::')[1]}`,
            content: muteInfo?.content || '',
            key: muteInfo?.key || [],
        };

        const isMuted = Boolean(muteInfo);
        const isRecursiveMuted = item?.status === TRIGGER_STATUS.MUTED_RECURSIVE;

        this.contextMenuEl.innerHTML = `
            <div class="kr-ctx-header">${escapeHtml(entry.comment)}</div>
            ${isMuted ? `
                <button type="button" class="kr-ctx-item" data-kr-ctx="unmute">
                    <i class="fa-solid fa-volume-high"></i> Unmute Entry
                </button>
            ` : ''}
            ${isRecursiveMuted ? `
                <button type="button" class="kr-ctx-item" data-kr-ctx="unmute-parents">
                    <i class="fa-solid fa-volume-high"></i> Unmute Blocking Parent Entry
                </button>
            ` : ''}
            <button type="button" class="kr-ctx-item" data-kr-ctx="mute-1">
                <i class="fa-solid fa-volume-xmark"></i> Mute for 1 Turn (Next Generation)
            </button>
            <button type="button" class="kr-ctx-item" data-kr-ctx="mute-3">
                <i class="fa-solid fa-hourglass-start"></i> Mute for 3 Turns
            </button>
            <button type="button" class="kr-ctx-item" data-kr-ctx="mute-5">
                <i class="fa-solid fa-hourglass-half"></i> Mute for 5 Turns
            </button>
            <button type="button" class="kr-ctx-item" data-kr-ctx="mute-10">
                <i class="fa-solid fa-hourglass-end"></i> Mute for 10 Turns
            </button>
            <button type="button" class="kr-ctx-item" data-kr-ctx="mute-session">
                <i class="fa-solid fa-ban"></i> Mute for Remainder of Chat
            </button>
            <div class="kr-ctx-divider"></div>
            ${item?.entry ? `
                <button type="button" class="kr-ctx-item" data-kr-ctx="quick-edit">
                    <i class="fa-solid fa-pen-to-square"></i> Quick-Edit Keywords &amp; Content
                </button>
            ` : ''}
            <button type="button" class="kr-ctx-item" data-kr-ctx="open-wi">
                <i class="fa-solid fa-arrow-up-right-from-square"></i> Open in World Info Editor
            </button>
        `;

        this.contextMenuEl.classList.remove('kr-hidden');

        const rect = this.contextMenuEl.getBoundingClientRect();
        const left = Math.min(clientX, window.innerWidth - rect.width - 10);
        const top = Math.min(clientY, window.innerHeight - rect.height - 10);
        this.contextMenuEl.style.left = `${Math.max(8, left)}px`;
        this.contextMenuEl.style.top = `${Math.max(8, top)}px`;

        this.contextMenuEl.onclick = async (ev) => {
            const btn = /** @type {HTMLElement} */ (ev.target).closest('[data-kr-ctx]');
            if (!btn) return;
            const act = btn.getAttribute('data-kr-ctx');
            this.closeContextMenu();

            const targetRef = {
                entryKey,
                world: entry.world,
                uid: entry.uid,
                comment: entry.comment,
                content: entry.content,
                key: entry.key,
            };
            switch (act) {
                case 'unmute':
                    this.state.removeMute(entryKey);
                    break;
                case 'unmute-parents':
                    this._handleUnmuteParentsByChildKey(entryKey);
                    break;
                case 'mute-1':
                    this.state.setMute(targetRef, 'one-turn', 1);
                    break;
                case 'mute-3':
                    this.state.setMute(targetRef, 'multi-turn', 3);
                    break;
                case 'mute-5':
                    this.state.setMute(targetRef, 'multi-turn', 5);
                    break;
                case 'mute-10':
                    this.state.setMute(targetRef, 'multi-turn', 10);
                    break;
                case 'mute-session':
                    this.state.setMute(targetRef, 'session');
                    break;
                case 'quick-edit':
                    if (item?.entry) this.openQuickEditModal(item.entry);
                    break;
                case 'open-wi':
                    await openWorldInfoEntryInEditor(entry.world, entry.uid);
                    break;
            }
        };
    }

    closeContextMenu() {
        if (this.contextMenuEl) this.contextMenuEl.classList.add('kr-hidden');
    }

    openManualBoostModal() {
        if (!this.modalBackdropEl) return;
        const allEntries = this.getAllLoadedEntries();

        this.modalBackdropEl.innerHTML = `
            <div class="kr-modal" role="dialog" aria-label="One-Turn Manual Lorebook Boost">
                <div class="kr-modal-header">
                    <div>
                        <h3 class="kr-modal-title"><i class="fa-solid fa-thumbtack"></i> Force-Trigger (Boost) Lorebook Entry</h3>
                        <p class="kr-modal-subtitle">Pin any entry from your active Lorebooks to force-inject it into the next turn—even without typing its keyword.</p>
                    </div>
                    <button type="button" class="kr-icon-btn" data-kr-modal-close="true"><i class="fa-solid fa-xmark"></i></button>
                </div>

                <div class="kr-modal-search-bar">
                    <i class="fa-solid fa-magnifying-glass"></i>
                    <input type="text" id="kr-boost-search-input" class="kr-input"
                           placeholder="Search by entry title, keyword, lorebook name, or content..." autocomplete="off" />
                </div>

                <div id="kr-boost-list" class="kr-boost-list"></div>

                <div class="kr-modal-footer">
                    <span class="kr-muted-text">${allEntries.length} entries across active Lorebooks</span>
                    <button type="button" class="kr-btn kr-btn-secondary" data-kr-modal-close="true">Done</button>
                </div>
            </div>
        `;

        this.modalBackdropEl.classList.remove('kr-hidden');

        const searchInput = /** @type {HTMLInputElement|null} */ (this.modalBackdropEl.querySelector('#kr-boost-search-input'));
        const listContainer = /** @type {HTMLElement|null} */ (this.modalBackdropEl.querySelector('#kr-boost-list'));

        const renderList = (query = '') => {
            if (!listContainer) return;
            const q = query.trim().toLowerCase();
            const filtered = allEntries.filter((e) => {
                if (!q) return true;
                return (
                    e.comment.toLowerCase().includes(q) ||
                    e.world.toLowerCase().includes(q) ||
                    e.key.some((k) => k.toLowerCase().includes(q)) ||
                    e.content.toLowerCase().includes(q)
                );
            });

            if (filtered.length === 0) {
                listContainer.innerHTML = `<div class="kr-boost-empty">No matching Lorebook entries found.</div>`;
                return;
            }

            listContainer.innerHTML = filtered.slice(0, 120).map((entry) => {
                const isBoosted = this.state.isBoosted(entry.entryKey);
                const tokens = this.getTokenCountForEntry(entry);
                const scopeMeta = LORE_SCOPE_META[entry.scope] || LORE_SCOPE_META.global;
                const keysPreview = entry.key.slice(0, 5).join(', ');

                return `
                    <div class="kr-boost-row ${isBoosted ? 'kr-boost-row--active' : ''}" data-entry-key="${escapeAttr(entry.entryKey)}">
                        <div class="kr-boost-row-main">
                            <div class="kr-boost-row-title">
                                <strong>${escapeHtml(entry.comment)}</strong>
                                <span class="kr-badge-scope"><i class="${scopeMeta.icon}"></i> ${escapeHtml(entry.world)}</span>
                                <span class="kr-badge-tokens">${formatTokens(tokens)} tok</span>
                            </div>
                            <div class="kr-boost-row-keys"><span>Keys:</span> ${escapeHtml(keysPreview || '(none)')}</div>
                            <div class="kr-boost-row-snippet">${escapeHtml(entry.content.slice(0, 150))}${entry.content.length > 150 ? '…' : ''}</div>
                        </div>
                        <div class="kr-boost-row-action">
                            <button type="button" class="kr-btn ${isBoosted ? 'kr-btn-success' : 'kr-btn-primary'}"
                                    data-kr-boost-toggle="${escapeAttr(entry.entryKey)}">
                                <i class="fa-solid fa-thumbtack"></i>
                                <span>${isBoosted ? 'Boosted (1 Turn)' : 'Boost 1 Turn'}</span>
                            </button>
                        </div>
                    </div>
                `;
            }).join('');
        };

        renderList('');
        setTimeout(() => searchInput?.focus(), 40);
        searchInput?.addEventListener('input', () => renderList(searchInput.value));

        this.modalBackdropEl.onclick = (ev) => {
            const target = /** @type {HTMLElement} */ (ev.target);
            if (target === this.modalBackdropEl || target.closest('[data-kr-modal-close]')) {
                this.closeModal();
                return;
            }
            const toggleBtn = target.closest('[data-kr-boost-toggle]');
            if (toggleBtn) {
                const entryKey = toggleBtn.getAttribute('data-kr-boost-toggle');
                const found = allEntries.find((e) => e.entryKey === entryKey);
                if (found) {
                    this.state.toggleBoost(found, 1);
                    renderList(searchInput?.value || '');
                }
            }
        };
    }

    openQuickEditModal(entry) {
        if (!this.modalBackdropEl) return;

        const logicOptionsHtml = Object.entries(SELECTIVE_LOGIC_LABELS)
            .map(([val, label]) => `<option value="${val}" ${Number(entry.selectiveLogic) === Number(val) ? 'selected' : ''}>${escapeHtml(label)}</option>`)
            .join('');

        this.modalBackdropEl.innerHTML = `
            <div class="kr-modal" role="dialog" aria-label="Quick Edit Lorebook Entry">
                <div class="kr-modal-header">
                    <div>
                        <h3 class="kr-modal-title"><i class="fa-solid fa-pen-to-square"></i> Quick-Edit Lorebook Entry</h3>
                        <p class="kr-modal-subtitle">Lorebook: <strong>${escapeHtml(entry.world)}</strong> &bull; UID #${escapeHtml(entry.uid)}</p>
                    </div>
                    <button type="button" class="kr-icon-btn" data-kr-modal-close="true"><i class="fa-solid fa-xmark"></i></button>
                </div>

                <div class="kr-modal-body">
                    <label class="kr-field-label">
                        <span>Entry Title / Comment</span>
                        <input type="text" id="kr-qe-comment" class="kr-input" value="${escapeAttr(entry.rawComment || entry.comment)}" />
                    </label>

                    <label class="kr-field-label">
                        <span>Primary Keywords (comma-separated, supports <code>/regex/i</code>)</span>
                        <input type="text" id="kr-qe-keys" class="kr-input" value="${escapeAttr(entry.key.join(', '))}" />
                    </label>

                    <div class="kr-field-row">
                        <label class="kr-field-label kr-flex-2">
                            <span>Secondary / Optional Filter Keys (comma-separated)</span>
                            <input type="text" id="kr-qe-secondary" class="kr-input" value="${escapeAttr(entry.keysecondary.join(', '))}" />
                        </label>
                        <label class="kr-field-label kr-flex-1">
                            <span>Selective Logic</span>
                            <select id="kr-qe-logic" class="kr-input">${logicOptionsHtml}</select>
                        </label>
                    </div>

                    <div class="kr-field-row kr-checkbox-row">
                        <label class="kr-checkbox-label">
                            <input type="checkbox" id="kr-qe-whole-words" ${entry.matchWholeWords === true ? 'checked' : ''} />
                            <span>Force Match Whole Words</span>
                        </label>
                        <label class="kr-checkbox-label">
                            <input type="checkbox" id="kr-qe-case-sensitive" ${entry.caseSensitive === true ? 'checked' : ''} />
                            <span>Force Case Sensitive</span>
                        </label>
                        <label class="kr-checkbox-label">
                            <input type="checkbox" id="kr-qe-disable" ${entry.disable ? 'checked' : ''} />
                            <span>Disable Entry Permanently</span>
                        </label>
                    </div>

                    <label class="kr-field-label">
                        <span>Entry Content</span>
                        <textarea id="kr-qe-content" class="kr-textarea" rows="7">${escapeHtml(entry.content)}</textarea>
                    </label>
                </div>

                <div class="kr-modal-footer">
                    <button type="button" class="kr-btn kr-btn-secondary" data-kr-qe-open-wi="true">
                        <i class="fa-solid fa-arrow-up-right-from-square"></i> Open Full World Info Editor
                    </button>
                    <div class="kr-modal-footer-right">
                        <button type="button" class="kr-btn kr-btn-secondary" data-kr-modal-close="true">Cancel</button>
                        <button type="button" class="kr-btn kr-btn-primary" id="kr-qe-save-btn">
                            <i class="fa-solid fa-floppy-disk"></i> Save Changes
                        </button>
                    </div>
                </div>
            </div>
        `;

        this.modalBackdropEl.classList.remove('kr-hidden');

        this.modalBackdropEl.onclick = async (ev) => {
            const target = /** @type {HTMLElement} */ (ev.target);
            if (target === this.modalBackdropEl || target.closest('[data-kr-modal-close]')) {
                this.closeModal();
                return;
            }
            if (target.closest('[data-kr-qe-open-wi]')) {
                this.closeModal();
                await openWorldInfoEntryInEditor(entry.world, entry.uid);
                return;
            }
            if (target.closest('#kr-qe-save-btn')) {
                const saveBtn = /** @type {HTMLButtonElement} */ (this.modalBackdropEl.querySelector('#kr-qe-save-btn'));
                if (saveBtn) saveBtn.disabled = true;

                try {
                    const commentVal = /** @type {HTMLInputElement} */ (this.modalBackdropEl.querySelector('#kr-qe-comment'))?.value?.trim() || '';
                    const keysRaw = /** @type {HTMLInputElement} */ (this.modalBackdropEl.querySelector('#kr-qe-keys'))?.value || '';
                    const secRaw = /** @type {HTMLInputElement} */ (this.modalBackdropEl.querySelector('#kr-qe-secondary'))?.value || '';
                    const logicVal = Number(/** @type {HTMLSelectElement} */ (this.modalBackdropEl.querySelector('#kr-qe-logic'))?.value || 0);
                    const wholeWordsChecked = /** @type {HTMLInputElement} */ (this.modalBackdropEl.querySelector('#kr-qe-whole-words'))?.checked;
                    const caseChecked = /** @type {HTMLInputElement} */ (this.modalBackdropEl.querySelector('#kr-qe-case-sensitive'))?.checked;
                    const disableChecked = /** @type {HTMLInputElement} */ (this.modalBackdropEl.querySelector('#kr-qe-disable'))?.checked;
                    const contentVal = /** @type {HTMLTextAreaElement} */ (this.modalBackdropEl.querySelector('#kr-qe-content'))?.value ?? '';

                    const parseCommaKeys = (str) => str.split(',').map((s) => s.trim()).filter(Boolean);

                    await saveLorebookEntryFields(entry.world, entry.uid, {
                        comment: commentVal,
                        key: parseCommaKeys(keysRaw),
                        keysecondary: parseCommaKeys(secRaw),
                        selectiveLogic: logicVal,
                        matchWholeWords: wholeWordsChecked ? true : entry.matchWholeWords,
                        caseSensitive: caseChecked ? true : entry.caseSensitive,
                        disable: Boolean(disableChecked),
                        content: contentVal,
                    });

                    if (typeof toastr !== 'undefined') {
                        toastr.success(`Saved changes to "${commentVal || entry.comment}"`, 'Keyword Radar');
                    }
                    this.closeModal();
                    await this.onRequestRescan(true);
                } catch (err) {
                    console.error('[Keyword Radar] Quick-Edit save error:', err);
                    if (typeof toastr !== 'undefined') {
                        toastr.error(`Failed to save entry: ${err.message || err}`, 'Keyword Radar');
                    }
                    if (saveBtn) saveBtn.disabled = false;
                }
            }
        };
    }

    generateDiagnosticReportJson() {
        const snapshotCtx = this.getDiagnosticSnapshotContext();
        const report = this.state.buildDiagnosticReport(snapshotCtx);
        return JSON.stringify(report, null, 2);
    }

    async copyDiagnosticsToClipboard(statusEl = null) {
        const jsonStr = this.generateDiagnosticReportJson();
        let copied = false;

        try {
            if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
                await navigator.clipboard.writeText(jsonStr);
                copied = true;
            }
        } catch {
            copied = false;
        }

        if (!copied) {
            try {
                const ta = document.createElement('textarea');
                ta.value = jsonStr;
                ta.style.position = 'fixed';
                ta.style.opacity = '0';
                document.body.appendChild(ta);
                ta.select();
                copied = document.execCommand('copy');
                document.body.removeChild(ta);
            } catch {
                copied = false;
            }
        }

        const eventCount = this.state.diagnosticLogs.length;
        if (copied) {
            if (statusEl) {
                statusEl.textContent = `✅ Copied diagnostic report (${eventCount} recorded events) to clipboard at ${new Date().toLocaleTimeString()}! Paste it directly in chat.`;
                statusEl.classList.add('kr-diag-status--ok');
            }
            if (typeof toastr !== 'undefined') {
                toastr.success(`Copied ${eventCount} diagnostic log events to clipboard!`, 'Keyword Radar');
            }
        } else {
            this.openDiagnosticsModal();
        }
    }

    openDiagnosticsModal() {
        this._ensureOverlays();
        if (!this.modalBackdropEl) return;

        const jsonStr = this.generateDiagnosticReportJson();
        const eventCount = this.state.diagnosticLogs.length;

        this.modalBackdropEl.innerHTML = `
            <div class="kr-modal" role="dialog" aria-label="Keyword Radar Diagnostic Logs">
                <div class="kr-modal-header">
                    <div>
                        <h3 class="kr-modal-title"><i class="fa-solid fa-bug"></i> Keyword Radar Diagnostic Logs</h3>
                        <p class="kr-modal-subtitle">${eventCount} lifecycle events captured &bull; Includes World Info hook traces &amp; prompt verification.</p>
                    </div>
                    <button type="button" class="kr-icon-btn" data-kr-modal-close="true"><i class="fa-solid fa-xmark"></i></button>
                </div>

                <div class="kr-modal-body">
                    <textarea id="kr-diag-textarea" class="kr-textarea kr-diag-log-viewer" rows="16" readonly>${escapeHtml(jsonStr)}</textarea>
                </div>

                <div class="kr-modal-footer">
                    <button type="button" class="kr-btn kr-btn-warning" id="kr-diag-modal-clear">
                        <i class="fa-solid fa-trash-can"></i> Clear Logs
                    </button>
                    <div class="kr-modal-footer-right">
                        <button type="button" class="kr-btn kr-btn-secondary" id="kr-diag-modal-download">
                            <i class="fa-solid fa-download"></i> Download .json
                        </button>
                        <button type="button" class="kr-btn kr-btn-primary" id="kr-diag-modal-copy">
                            <i class="fa-solid fa-copy"></i> Copy to Clipboard
                        </button>
                    </div>
                </div>
            </div>
        `;

        this.modalBackdropEl.classList.remove('kr-hidden');

        this.modalBackdropEl.onclick = async (ev) => {
            const target = /** @type {HTMLElement} */ (ev.target);
            if (target === this.modalBackdropEl || target.closest('[data-kr-modal-close]')) {
                this.closeModal();
                return;
            }
            if (target.closest('#kr-diag-modal-copy')) {
                await this.copyDiagnosticsToClipboard();
                const ta = /** @type {HTMLTextAreaElement|null} */ (this.modalBackdropEl.querySelector('#kr-diag-textarea'));
                if (ta) ta.select();
                return;
            }
            if (target.closest('#kr-diag-modal-download')) {
                const blob = new Blob([this.generateDiagnosticReportJson()], { type: 'application/json' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `keyword-radar-diagnostics-${Date.now()}.json`;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                URL.revokeObjectURL(url);
                return;
            }
            if (target.closest('#kr-diag-modal-clear')) {
                this.state.clearDiagnosticLogs();
                this.openDiagnosticsModal();
            }
        };
    }

    closeModal() {
        if (this.modalBackdropEl) {
            this.modalBackdropEl.classList.add('kr-hidden');
            this.modalBackdropEl.innerHTML = '';
        }
    }

    bindSettingsPanel(settingsRoot, onSettingsChanged) {
        const settings = getSettings();

        const bindCheckbox = (selector, key) => {
            const el = /** @type {HTMLInputElement|null} */ (settingsRoot.querySelector(selector));
            if (!el) return;
            el.checked = Boolean(settings[key]);
            el.addEventListener('change', () => {
                settings[key] = Boolean(el.checked);
                saveSettings();
                onSettingsChanged();
            });
        };

        const bindSelect = (selector, key) => {
            const el = /** @type {HTMLSelectElement|null} */ (settingsRoot.querySelector(selector));
            if (!el) return;
            el.value = String(settings[key]);
            el.addEventListener('change', () => {
                settings[key] = el.value;
                if (key === 'defaultFilterMode') this.state.filterModeOverride = null;
                saveSettings();
                onSettingsChanged();
            });
        };

        const bindNumber = (selector, valDisplaySelector, key, min, max) => {
            const el = /** @type {HTMLInputElement|null} */ (settingsRoot.querySelector(selector));
            const valEl = valDisplaySelector ? settingsRoot.querySelector(valDisplaySelector) : null;
            if (!el) return;
            el.value = String(settings[key]);
            if (valEl) valEl.textContent = String(settings[key]);

            const update = () => {
                const parsed = Number(el.value);
                const clamped = Math.max(min, Math.min(max, Number.isFinite(parsed) ? parsed : settings[key]));
                settings[key] = clamped;
                if (valEl) valEl.textContent = String(clamped);
                saveSettings();
                onSettingsChanged();
            };

            el.addEventListener('input', update);
            el.addEventListener('change', update);
        };

        bindCheckbox('#kr_setting_enabled', 'enabled');
        bindNumber('#kr_setting_scan_delay', '#kr_setting_scan_delay_val', 'scanDelayMs', 30, 1500);
        bindSelect('#kr_setting_filter_mode', 'defaultFilterMode');
        bindSelect('#kr_setting_ui_mode', 'uiMode');
        bindCheckbox('#kr_setting_auto_hide', 'autoHideWhenEmpty');
        bindCheckbox('#kr_setting_highlight_input', 'highlightInInput');
        bindCheckbox('#kr_setting_hover_preview', 'hoverPreview');
        bindCheckbox('#kr_setting_mute_recursion', 'muteBlocksRecursion');
        bindCheckbox('#kr_setting_persist_swipes', 'persistMuteAcrossSwipes');
        bindCheckbox('#kr_setting_show_muted', 'showMutedBadges');
        bindCheckbox('#kr_setting_simulate_recursion', 'simulateRecursionAlways');
        bindNumber('#kr_setting_token_warn', '#kr_setting_token_warn_val', 'tokenWarnThreshold', 0, 10000);
        bindNumber('#kr_setting_max_recursion', '#kr_setting_max_recursion_val', 'maxRecursionDepth', 1, 15);

        const statusEl = /** @type {HTMLElement|null} */ (settingsRoot.querySelector('#kr_diag_status'));
        const copyDiagBtn = settingsRoot.querySelector('#kr_btn_copy_diagnostics');
        const viewDiagBtn = settingsRoot.querySelector('#kr_btn_view_diagnostics');
        const clearDiagBtn = settingsRoot.querySelector('#kr_btn_clear_diagnostics');

        copyDiagBtn?.addEventListener('click', async () => {
            await this.copyDiagnosticsToClipboard(statusEl);
        });

        viewDiagBtn?.addEventListener('click', () => {
            this.openDiagnosticsModal();
        });

        clearDiagBtn?.addEventListener('click', () => {
            this.state.clearDiagnosticLogs();
            if (statusEl) {
                statusEl.textContent = `Cleared diagnostic flight recorder at ${new Date().toLocaleTimeString()}.`;
                statusEl.classList.remove('kr-diag-status--ok');
            }
            if (typeof toastr !== 'undefined') {
                toastr.info('Cleared Keyword Radar diagnostic logs.', 'Keyword Radar');
            }
        });
    }
}