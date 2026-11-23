/**
 * Keyword Radar — Pure Utility Helpers & Fuzzy Search Scorer
 */

/**
 * Build a stable unique key for a World Info entry.
 * @param {string|{world: string, uid: string|number}} worldOrEntry
 * @param {string|number} [uid]
 * @returns {string}
 */
export function getEntryKey(worldOrEntry, uid) {
    if (worldOrEntry && typeof worldOrEntry === 'object') {
        return `${worldOrEntry.world ?? ''}.${worldOrEntry.uid ?? ''}`;
    }
    return `${worldOrEntry ?? ''}.${uid ?? ''}`;
}

/**
 * Get a human-readable title for a World Info entry.
 * @param {object} entry
 * @returns {string}
 */
export function getEntryTitle(entry) {
    if (!entry) return 'Untitled Entry';
    const comment = typeof entry.comment === 'string' ? entry.comment.trim() : '';
    if (comment) return comment;
    if (Array.isArray(entry.key) && entry.key.length > 0) {
        const firstKey = String(entry.key[0] ?? '').trim();
        if (firstKey) return firstKey;
    }
    return `Entry #${entry.uid ?? '?'}`;
}

/**
 * Escape HTML special characters for safe rendering.
 */
export function escapeHtml(str) {
    return String(str ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/**
 * Escape special regex characters in a literal string.
 */
export function escapeRegex(str) {
    return String(str ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Parse a JavaScript regex literal string like `/pattern/gi`.
 * Matches SillyTavern's `parseRegexFromString()` rules, including rejecting
 * unescaped `/` delimiters inside the pattern so plaintext paths aren't misparsed.
 */
export function parseRegexFromString(input) {
    if (typeof input !== 'string') return null;
    const match = input.match(/^\/([\w\W]+?)\/([gimsuy]*)$/);
    if (!match) return null;
    let [, pattern, flags] = match;
    if (/(^|[^\\])\//.test(pattern)) return null;
    pattern = pattern.replace(/\\\//g, '/');
    try {
        return new RegExp(pattern, flags);
    } catch {
        return null;
    }
}

/**
 * Split a comma-separated string (such as SillyTavern's `entry.group`) into trimmed non-empty tokens.
 * @param {string} str
 * @returns {string[]}
 */
export function splitCsvList(str) {
    if (typeof str !== 'string' || !str.trim()) return [];
    return str.split(',').map((s) => s.trim()).filter(Boolean);
}

/**
 * Fast fallback token estimator.
 */
export function estimateTokensFast(text) {
    if (!text || typeof text !== 'string') return 0;
    const trimmed = text.trim();
    if (!trimmed) return 0;
    const charEst = Math.ceil(trimmed.length / 3.75);
    const wordEst = Math.ceil(trimmed.split(/\s+/).length * 1.3);
    return Math.max(1, Math.round((charEst + wordEst) / 2));
}

/**
 * Format token counts compactly.
 */
export function formatTokenCount(count) {
    const n = Math.max(0, Math.round(Number(count) || 0));
    if (n >= 10000) return `${(n / 1000).toFixed(1)}k`;
    return String(n);
}

/**
 * Score how well `query` matches `text` (higher is better, 0 = no match).
 * Supports exact, prefix, word-boundary, substring, and fuzzy subsequence matching.
 *
 * @param {string} text
 * @param {string} query
 * @param {{ allowSubsequence?: boolean }} [opts]
 * @returns {number}
 */
export function fuzzyMatchScore(text, query, { allowSubsequence = true } = {}) {
    const hay = String(text ?? '').toLowerCase();
    const needle = String(query ?? '').trim().toLowerCase();
    if (!hay || !needle) return 0;

    if (hay === needle) return 1000;
    if (hay.startsWith(needle)) return 860 - Math.min(80, hay.length - needle.length);

    const subIdx = hay.indexOf(needle);
    if (subIdx !== -1) {
        const atWordBoundary = subIdx === 0 || /[\s\-_(/'".,]/.test(hay[subIdx - 1]);
        const base = atWordBoundary ? 720 : 560;
        return base - Math.min(120, subIdx);
    }

    // Multi-token all-words match (e.g. "grim village" -> "Grimbarrow (Village)")
    const tokens = needle.split(/\s+/).filter(Boolean);
    if (tokens.length > 1) {
        let tokenScore = 0;
        let allMatched = true;
        for (const tok of tokens) {
            const idx = hay.indexOf(tok);
            if (idx === -1) {
                allMatched = false;
                break;
            }
            const atBoundary = idx === 0 || /[\s\-_(/'".,]/.test(hay[idx - 1]);
            tokenScore += atBoundary ? 140 : 95;
        }
        if (allMatched) {
            return Math.min(680, 320 + tokenScore);
        }
    }

    if (!allowSubsequence || needle.length < 2) return 0;

    // Fuzzy subsequence matching (rewards consecutive characters & word-start hits)
    let qi = 0;
    let consecutive = 0;
    let score = 0;
    let firstMatchIdx = -1;
    let lastMatchIdx = -1;

    for (let hi = 0; hi < hay.length && qi < needle.length; hi++) {
        if (hay[hi] === needle[qi]) {
            if (firstMatchIdx === -1) firstMatchIdx = hi;
            consecutive = (lastMatchIdx === hi - 1) ? consecutive + 1 : 1;
            const atBoundary = hi === 0 || /[\s\-_(/'".,]/.test(hay[hi - 1]);
            score += 14 + (consecutive * 8) + (atBoundary ? 18 : 0);
            lastMatchIdx = hi;
            qi++;
        }
    }

    if (qi < needle.length) return 0;

    // Penalize wide character spread so tight fuzzy matches rank much higher
    const span = (lastMatchIdx - firstMatchIdx + 1) - needle.length;
    const densityBonus = Math.max(0, 120 - span * 4);
    return Math.max(10, Math.min(480, score + densityBonus));
}

/**
 * Rank a Lorebook entry for Boost Picker search.
 * Strongly prioritizes entry title (name) first, then keywords, then lorebook name, then content.
 *
 * @param {object} entry
 * @param {string} query
 * @returns {number} 0 if no match; higher = stronger match
 */
export function scoreBoostEntry(entry, query) {
    const q = String(query ?? '').trim();
    if (!q) return 1;

    const title = getEntryTitle(entry);
    const titleScore = fuzzyMatchScore(title, q, { allowSubsequence: true });
    if (titleScore > 0) {
        // Title tier: 10000..11000 so ANY title match always ranks above content-only matches
        return 10000 + titleScore;
    }

    // Keywords tier: 5000..6000
    const keys = Array.isArray(entry?.key) ? entry.key : [];
    let bestKeyScore = 0;
    for (const k of keys) {
        const s = fuzzyMatchScore(String(k ?? ''), q, { allowSubsequence: true });
        if (s > bestKeyScore) bestKeyScore = s;
    }
    if (bestKeyScore > 0) {
        return 5000 + bestKeyScore;
    }

    // Lorebook name tier: 3000..4000
    const worldScore = fuzzyMatchScore(entry?.world || '', q, { allowSubsequence: true });
    if (worldScore > 0) {
        return 3000 + worldScore;
    }

    // Content tier: 1..1000 (disable subsequence on long prose to avoid noisy random letter hits)
    const contentScore = fuzzyMatchScore(entry?.content || '', q, { allowSubsequence: false });
    if (contentScore > 0) {
        return contentScore;
    }

    return 0;
}

/**
 * Classic debounce helper with `.cancel()` and `.flush()`.
 */
export function createDebouncer(fn, waitOrGetter) {
    let timer = null;
    let lastArgs = null;

    const debounced = function (...args) {
        lastArgs = args;
        if (timer !== null) {
            clearTimeout(timer);
        }
        const wait = typeof waitOrGetter === 'function' ? waitOrGetter() : waitOrGetter;
        timer = setTimeout(() => {
            timer = null;
            const callArgs = lastArgs;
            lastArgs = null;
            fn(...callArgs);
        }, Math.max(0, Number(wait) || 0));
    };

    debounced.cancel = () => {
        if (timer !== null) {
            clearTimeout(timer);
            timer = null;
        }
        lastArgs = null;
    };

    debounced.flush = () => {
        if (timer !== null && lastArgs !== null) {
            clearTimeout(timer);
            timer = null;
            const callArgs = lastArgs;
            lastArgs = null;
            fn(...callArgs);
        }
    };

    return debounced;
}
