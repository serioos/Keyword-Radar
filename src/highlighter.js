/**
 * Keyword Radar — Non-Intrusive Textarea Backdrop Highlighter
 * https://github.com/serioos/Keyword-Radar
 *
 * Renders subtle underline/glow highlights directly behind matched keywords in `#send_textarea`
 * without altering the user's cursor, selection, undo history, or input events.
 * Also supports spotlighting specific words when the user hovers over an entry badge in the Radar bar.
 */

import { escapeHtml } from './utils.js';

export class DraftInputHighlighter {
    constructor() {
        /** @type {HTMLTextAreaElement|null} */
        this.textarea = null;
        /** @type {HTMLElement|null} */
        this.backdrop = null;
        /** @type {HTMLElement|null} */
        this.mirrorContent = null;
        /** @type {ResizeObserver|null} */
        this.resizeObserver = null;
        /** @type {boolean} */
        this.enabled = true;
        /** @type {string|null} */
        this.hoveredEntryKey = null;
        /** @type {string} */
        this.lastText = '';
        /** @type {Array<any>} */
        this.lastSpans = [];

        this._boundSyncScroll = () => this.syncScroll();
        this._boundSyncMetrics = () => this.syncTypographyAndGeometry();
    }

    /**
     * Attaches the backdrop mirror to `#send_textarea`.
     * @param {HTMLTextAreaElement|null} textarea
     */
    attach(textarea) {
        if (!textarea || this.textarea === textarea) return;
        this.detach();

        this.textarea = textarea;
        const parent = textarea.parentElement;
        if (!parent) return;

        // Ensure parent positioning context
        const parentPos = window.getComputedStyle(parent).position;
        if (parentPos === 'static') {
            parent.style.position = 'relative';
        }

        const backdrop = document.createElement('div');
        backdrop.id = 'kr-textarea-backdrop';
        backdrop.className = 'kr-textarea-backdrop';
        backdrop.setAttribute('aria-hidden', 'true');

        const mirror = document.createElement('div');
        mirror.className = 'kr-textarea-mirror';
        backdrop.appendChild(mirror);

        parent.insertBefore(backdrop, textarea);

        this.backdrop = backdrop;
        this.mirrorContent = mirror;

        textarea.addEventListener('scroll', this._boundSyncScroll, { passive: true });
        window.addEventListener('resize', this._boundSyncMetrics, { passive: true });

        if (typeof ResizeObserver !== 'undefined') {
            this.resizeObserver = new ResizeObserver(() => {
                this.syncTypographyAndGeometry();
            });
            this.resizeObserver.observe(textarea);
        }

        this.syncTypographyAndGeometry();
    }

    /**
     * Detaches the backdrop mirror and cleans up listeners.
     */
    detach() {
        if (this.textarea) {
            this.textarea.removeEventListener('scroll', this._boundSyncScroll);
        }
        window.removeEventListener('resize', this._boundSyncMetrics);
        if (this.resizeObserver) {
            this.resizeObserver.disconnect();
            this.resizeObserver = null;
        }
        if (this.backdrop && this.backdrop.parentElement) {
            this.backdrop.parentElement.removeChild(this.backdrop);
        }
        this.textarea = null;
        this.backdrop = null;
        this.mirrorContent = null;
    }

    /**
     * Enables or disables the input highlight mirror.
     * @param {boolean} enabled
     */
    setEnabled(enabled) {
        this.enabled = Boolean(enabled);
        if (this.backdrop) {
            this.backdrop.style.display = this.enabled ? 'block' : 'none';
        }
        if (this.enabled) {
            this.render(this.lastText, this.lastSpans);
        }
    }

    /**
     * Copies exact computed font, padding, line-height, and bounding box from `#send_textarea`.
     */
    syncTypographyAndGeometry() {
        if (!this.textarea || !this.backdrop || !this.mirrorContent) return;

        const cs = window.getComputedStyle(this.textarea);
        const top = this.textarea.offsetTop;
        const left = this.textarea.offsetLeft;
        const width = this.textarea.offsetWidth;
        const height = this.textarea.offsetHeight;

        this.backdrop.style.top = `${top}px`;
        this.backdrop.style.left = `${left}px`;
        this.backdrop.style.width = `${width}px`;
        this.backdrop.style.height = `${height}px`;
        this.backdrop.style.borderRadius = cs.borderRadius;

        const copiedProps = [
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
        ];

        for (const prop of copiedProps) {
            this.mirrorContent.style[prop] = cs[prop];
        }

        this.syncScroll();
    }

    /**
     * Synchronizes scroll offset between `#send_textarea` and the backdrop mirror.
     */
    syncScroll() {
        if (!this.textarea || !this.backdrop) return;
        this.backdrop.scrollTop = this.textarea.scrollTop;
        this.backdrop.scrollLeft = this.textarea.scrollLeft;
    }

    /**
     * Renders matched keyword spans inside the mirror layer.
     * @param {string} draftText
     * @param {Array<{ start: number, end: number, entryKeys: string[], keys: string[], hasNew: boolean, allMuted: boolean }>} spans
     */
    render(draftText, spans) {
        this.lastText = String(draftText ?? '');
        this.lastSpans = Array.isArray(spans) ? spans : [];

        if (!this.backdrop || !this.mirrorContent) return;
        if (!this.enabled || !this.lastText || this.lastSpans.length === 0) {
            this.mirrorContent.innerHTML = '';
            return;
        }

        this.syncTypographyAndGeometry();

        const text = this.lastText;
        let cursor = 0;
        const htmlParts = [];

        for (const span of this.lastSpans) {
            const start = Math.max(cursor, Math.min(text.length, span.start));
            const end = Math.max(start, Math.min(text.length, span.end));
            if (end <= start) continue;

            if (start > cursor) {
                htmlParts.push(escapeHtml(text.slice(cursor, start)));
            }

            const matchedWord = escapeHtml(text.slice(start, end));
            const entryKeysAttr = escapeHtml(span.entryKeys.join('|'));
            const isSpotlight = this.hoveredEntryKey && span.entryKeys.includes(this.hoveredEntryKey);

            const classes = ['kr-input-mark'];
            if (span.allMuted) {
                classes.push('kr-input-mark--muted');
            } else if (span.hasNew) {
                classes.push('kr-input-mark--new');
            } else {
                classes.push('kr-input-mark--history');
            }
            if (isSpotlight) {
                classes.push('kr-input-mark--spotlight');
            }

            htmlParts.push(
                `<mark class="${classes.join(' ')}" data-entry-keys="${entryKeysAttr}">${matchedWord}</mark>`,
            );
            cursor = end;
        }

        if (cursor < text.length) {
            htmlParts.push(escapeHtml(text.slice(cursor)));
        }

        // Trailing newline ensures mirror height matches textarea when text ends with '\n'
        if (text.endsWith('\n')) {
            htmlParts.push('\n');
        }

        this.mirrorContent.innerHTML = htmlParts.join('');
        this.syncScroll();
    }

    /**
     * Spotlights only the keywords belonging to a hovered badge's `entryKey`.
     * @param {string|null} entryKey
     */
    setHoveredEntryKey(entryKey) {
        if (this.hoveredEntryKey === entryKey) return;
        this.hoveredEntryKey = entryKey || null;
        if (!this.mirrorContent) return;

        const marks = this.mirrorContent.querySelectorAll('.kr-input-mark');
        marks.forEach((markEl) => {
            const raw = markEl.getAttribute('data-entry-keys') || '';
            const keys = raw.split('|').filter(Boolean);
            if (this.hoveredEntryKey && keys.includes(this.hoveredEntryKey)) {
                markEl.classList.add('kr-input-mark--spotlight');
            } else {
                markEl.classList.remove('kr-input-mark--spotlight');
            }
        });
    }
}