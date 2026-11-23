/**
 * Keyword Radar — Non-Intrusive Draft Input Keyword Highlighter
 *
 * Performance Optimizations:
 *  - Syncs textarea typography via getComputedStyle only on mount, focus, ResizeObserver, and window resize
 *  - Cheaply syncs offsetTop/offsetLeft on render so overlay stays pixel-aligned when the Radar Bar toggles height
 *  - Skips redundant DOM writes when rendered HTML hasn't changed
 */

import { escapeHtml } from '../utils.js';

export function createDraftHighlighter() {
    let textarea = null;
    let overlay = null;
    let contentEl = null;
    let resizeObserver = null;
    let lastDraftText = '';
    let lastSpans = [];
    let lastFocusedKey = null;
    let lastRenderedHtml = '';
    let lastOffsetTop = -1;
    let lastOffsetLeft = -1;
    let enabled = true;
    let geometryDirty = true;

    function syncPositionOnly() {
        if (!textarea || !overlay) return;
        const top = textarea.offsetTop;
        const left = textarea.offsetLeft;
        if (top !== lastOffsetTop) {
            overlay.style.top = `${top}px`;
            lastOffsetTop = top;
        }
        if (left !== lastOffsetLeft) {
            overlay.style.left = `${left}px`;
            lastOffsetLeft = left;
        }
    }

    function syncGeometry() {
        if (!textarea || !overlay) return;
        const style = window.getComputedStyle(textarea);
        const parent = textarea.offsetParent || textarea.parentElement;
        if (!parent) return;

        lastOffsetTop = textarea.offsetTop;
        lastOffsetLeft = textarea.offsetLeft;
        overlay.style.top = `${lastOffsetTop}px`;
        overlay.style.left = `${lastOffsetLeft}px`;
        overlay.style.width = `${textarea.offsetWidth}px`;
        overlay.style.height = `${textarea.offsetHeight}px`;

        const props = [
            'fontFamily',
            'fontSize',
            'fontWeight',
            'fontStyle',
            'letterSpacing',
            'lineHeight',
            'textTransform',
            'wordSpacing',
            'textIndent',
            'paddingTop',
            'paddingRight',
            'paddingBottom',
            'paddingLeft',
            'borderTopWidth',
            'borderRightWidth',
            'borderBottomWidth',
            'borderLeftWidth',
            'boxSizing',
            'tabSize',
        ];
        for (const prop of props) {
            overlay.style[prop] = style[prop];
        }
        overlay.scrollTop = textarea.scrollTop;
        overlay.scrollLeft = textarea.scrollLeft;
        geometryDirty = false;
    }

    function onScroll() {
        if (!textarea || !overlay) return;
        overlay.scrollTop = textarea.scrollTop;
        overlay.scrollLeft = textarea.scrollLeft;
    }

    function onWindowResize() {
        geometryDirty = true;
        if (enabled && overlay && lastRenderedHtml) {
            syncGeometry();
        }
    }

    function mount(textareaEl) {
        if (!textareaEl) return;
        if (textarea === textareaEl && overlay && overlay.isConnected) {
            if (geometryDirty) syncGeometry();
            return;
        }
        unmount();

        textarea = textareaEl;
        const parent = textarea.offsetParent || textarea.parentElement;
        if (!parent) return;

        if (window.getComputedStyle(parent).position === 'static') {
            parent.style.position = 'relative';
        }

        overlay = document.createElement('div');
        overlay.id = 'kr-draft-highlight-overlay';
        overlay.className = 'kr-draft-highlight-overlay';
        overlay.setAttribute('aria-hidden', 'true');

        contentEl = document.createElement('div');
        contentEl.className = 'kr-draft-highlight-content';
        overlay.appendChild(contentEl);

        parent.appendChild(overlay);
        textarea.addEventListener('scroll', onScroll, { passive: true });
        window.addEventListener('resize', onWindowResize, { passive: true });

        if (typeof ResizeObserver !== 'undefined') {
            resizeObserver = new ResizeObserver(() => {
                geometryDirty = true;
                syncGeometry();
            });
            resizeObserver.observe(textarea);
        }

        syncGeometry();
    }

    function unmount() {
        if (textarea) {
            textarea.removeEventListener('scroll', onScroll);
        }
        window.removeEventListener('resize', onWindowResize);
        if (resizeObserver) {
            resizeObserver.disconnect();
            resizeObserver = null;
        }
        if (overlay && overlay.parentElement) {
            overlay.parentElement.removeChild(overlay);
        }
        textarea = null;
        overlay = null;
        contentEl = null;
        lastRenderedHtml = '';
        lastOffsetTop = -1;
        lastOffsetLeft = -1;
        geometryDirty = true;
    }

    function setEnabled(val) {
        const next = Boolean(val);
        if (next === enabled) return;
        enabled = next;
        if (!enabled && contentEl) {
            if (lastRenderedHtml !== '') {
                contentEl.innerHTML = '';
                lastRenderedHtml = '';
            }
        } else if (enabled) {
            render(lastDraftText, lastSpans, lastFocusedKey);
        }
    }

    function buildNonOverlappingSegments(text, spans) {
        if (!text || !Array.isArray(spans) || spans.length === 0) return [];

        const points = new Set();
        for (const sp of spans) {
            const s = Math.max(0, Math.min(text.length, sp.start));
            const e = Math.max(0, Math.min(text.length, sp.end));
            if (e > s) {
                points.add(s);
                points.add(e);
            }
        }
        const sortedPoints = Array.from(points).sort((a, b) => a - b);
        const segments = [];

        for (let i = 0; i < sortedPoints.length - 1; i++) {
            const start = sortedPoints[i];
            const end = sortedPoints[i + 1];
            const covering = spans.filter((sp) => sp.start <= start && sp.end >= end);
            if (covering.length === 0) continue;

            segments.push({
                start,
                end,
                entryKeys: [...new Set(covering.map((c) => c.entryKey))],
                allMuted: covering.every((c) => c.isMuted),
                hasNew: covering.some((c) => c.isNew && !c.isMuted),
            });
        }

        return segments;
    }

    function render(draftText, spans = [], focusedEntryKey = null) {
        lastDraftText = String(draftText ?? '');
        lastSpans = Array.isArray(spans) ? spans : [];
        lastFocusedKey = focusedEntryKey;

        if (!overlay || !contentEl) return;
        if (!enabled || !lastDraftText || lastSpans.length === 0) {
            if (lastRenderedHtml !== '') {
                contentEl.innerHTML = '';
                lastRenderedHtml = '';
            }
            return;
        }

        if (geometryDirty) {
            syncGeometry();
        } else {
            syncPositionOnly();
        }

        const segments = buildNonOverlappingSegments(lastDraftText, lastSpans);
        if (segments.length === 0) {
            if (lastRenderedHtml !== '') {
                contentEl.innerHTML = '';
                lastRenderedHtml = '';
            }
            return;
        }

        let html = '';
        let cursor = 0;

        for (const seg of segments) {
            if (seg.start > cursor) {
                html += escapeHtml(lastDraftText.slice(cursor, seg.start));
            }
            const classes = ['kr-hl-mark'];
            if (seg.allMuted) {
                classes.push('kr-hl-muted');
            } else if (seg.hasNew) {
                classes.push('kr-hl-new');
            } else {
                classes.push('kr-hl-active');
            }

            if (focusedEntryKey) {
                if (seg.entryKeys.includes(focusedEntryKey)) {
                    classes.push('kr-hl-focus');
                } else {
                    classes.push('kr-hl-dim');
                }
            }

            html += `<mark class="${classes.join(' ')}">${escapeHtml(lastDraftText.slice(seg.start, seg.end))}</mark>`;
            cursor = seg.end;
        }

        if (cursor < lastDraftText.length) {
            html += escapeHtml(lastDraftText.slice(cursor));
        }

        if (lastDraftText.endsWith('\n')) {
            html += ' ';
        }

        if (html !== lastRenderedHtml) {
            contentEl.innerHTML = html;
            lastRenderedHtml = html;
        }
        onScroll();
    }

    function setFocusedEntry(entryKey) {
        if (entryKey === lastFocusedKey) return;
        render(lastDraftText, lastSpans, entryKey);
    }

    return {
        mount,
        unmount,
        setEnabled,
        render,
        setFocusedEntry,
        syncGeometry,
    };
}
