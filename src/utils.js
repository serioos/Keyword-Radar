/**
 * Keyword Radar — Shared Utilities & Token Estimation Cache
 * https://github.com/serioos/Keyword-Radar
 */

/**
 * Escapes HTML special characters for safe innerHTML rendering.
 * @param {unknown} str
 * @returns {string}
 */
export function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/**
 * Escapes string for safe HTML attribute usage.
 * @param {unknown} str
 * @returns {string}
 */
export function escapeAttr(str) {
    return escapeHtml(str);
}

/**
 * Escapes special characters in a plain string for use inside a RegExp.
 * @param {string} str
 * @returns {string}
 */
export function escapeRegExp(str) {
    return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Standard debounce wrapper with `.cancel()` and `.flush()` support.
 * @template {(...args: any[]) => any} T
 * @param {T} fn
 * @param {number} waitMs
 */
export function debounce(fn, waitMs = 160) {
    let timer = null;
    let lastArgs = null;

    const debounced = function (...args) {
        lastArgs = args;
        if (timer !== null) {
            clearTimeout(timer);
        }
        timer = setTimeout(() => {
            timer = null;
            const invokeArgs = lastArgs;
            lastArgs = null;
            fn(...invokeArgs);
        }, Math.max(0, Number(waitMs) || 0));
    };

    debounced.cancel = () => {
        if (timer !== null) {
            clearTimeout(timer);
            timer = null;
            lastArgs = null;
        }
    };

    debounced.flush = (...overrideArgs) => {
        if (timer !== null) {
            clearTimeout(timer);
            timer = null;
        }
        const argsToUse = overrideArgs.length > 0 ? overrideArgs : (lastArgs || []);
        lastArgs = null;
        return fn(...argsToUse);
    };

    return debounced;
}

/**
 * Fast 32-bit FNV-1a string hash.
 * @param {string} str
 * @returns {string}
 */
export function simpleHash(str) {
    const s = String(str ?? '');
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(36);
}

/**
 * Creates a canonical composite key for a Lorebook entry.
 * @param {string} world
 * @param {string|number} uid
 * @returns {string}
 */
export function makeEntryKey(world, uid) {
    return `${String(world ?? '').trim()}:::${String(uid ?? '').trim()}`;
}

/**
 * Splits a canonical composite entry key into `{ world, uid }`.
 * @param {string} entryKey
 * @returns {{ world: string, uid: string, numericUid: number }}
 */
export function parseEntryKey(entryKey) {
    const raw = String(entryKey ?? '');
    const idx = raw.lastIndexOf(':::');
    if (idx === -1) {
        return { world: '', uid: raw, numericUid: Number(raw) };
    }
    const world = raw.slice(0, idx);
    const uid = raw.slice(idx + 3);
    return {
        world,
        uid,
        numericUid: Number.isNaN(Number(uid)) ? uid : Number(uid),
    };
}

const utf8Encoder = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;

/**
 * Fast synchronous token estimator aligned with SillyTavern 1.17+ UTF-8 byte-length estimation.
 * @param {string} text
 * @returns {number}
 */
export function estimateTokensSync(text) {
    if (!text || typeof text !== 'string') return 0;
    const trimmed = text.trim();
    if (!trimmed) return 0;
    if (utf8Encoder) {
        const byteLength = utf8Encoder.encode(trimmed).byteLength;
        return Math.max(1, Math.ceil(byteLength / 3.65));
    }
    return Math.max(1, Math.ceil(trimmed.length / 3.5));
}

/**
 * Formats a token count with compact notation when needed.
 * @param {number} tokens
 * @returns {string}
 */
export function formatTokens(tokens) {
    const n = Math.max(0, Math.round(Number(tokens) || 0));
    if (n >= 10000) {
        return `${(n / 1000).toFixed(1)}k`;
    }
    return n.toLocaleString();
}

/**
 * Hybrid synchronous + asynchronous token cache.
 * Returns an immediate estimate synchronously and refines via SillyTavern's tokenizer asynchronously.
 */
export class TokenCache {
    /**
     * @param {(text: string) => Promise<number>} [asyncTokenizer]
     */
    constructor(asyncTokenizer = null) {
        this.asyncTokenizer = asyncTokenizer;
        /** @type {Map<string, { tokens: number, exact: boolean }>} */
        this.cache = new Map();
        /** @type {Set<string>} */
        this.inFlight = new Set();
    }

    /**
     * Sets the async tokenizer callback.
     * @param {(text: string) => Promise<number>} fn
     */
    setAsyncTokenizer(fn) {
        this.asyncTokenizer = fn;
    }

    /**
     * Gets token count synchronously (exact if cached, byte-heuristic otherwise)
     * and schedules an async refinement if not yet exact.
     *
     * @param {string} world
     * @param {string|number} uid
     * @param {string} content
     * @param {() => void} [onExactReady]
     * @returns {number}
     */
    getEntryTokens(world, uid, content, onExactReady = null) {
        const text = String(content ?? '');
        if (!text.trim()) return 0;

        const cacheKey = `${makeEntryKey(world, uid)}:::${simpleHash(text)}`;
        const existing = this.cache.get(cacheKey);
        if (existing) {
            return existing.tokens;
        }

        const heuristic = estimateTokensSync(text);
        this.cache.set(cacheKey, { tokens: heuristic, exact: false });

        if (typeof this.asyncTokenizer === 'function' && !this.inFlight.has(cacheKey)) {
            this.inFlight.add(cacheKey);
            Promise.resolve()
                .then(() => this.asyncTokenizer(text))
                .then((exactCount) => {
                    this.inFlight.delete(cacheKey);
                    if (typeof exactCount === 'number' && Number.isFinite(exactCount) && exactCount >= 0) {
                        const prev = this.cache.get(cacheKey);
                        this.cache.set(cacheKey, { tokens: Math.round(exactCount), exact: true });
                        if (prev && prev.tokens !== Math.round(exactCount) && typeof onExactReady === 'function') {
                            onExactReady();
                        }
                    }
                })
                .catch(() => {
                    this.inFlight.delete(cacheKey);
                });
        }

        return heuristic;
    }

    clear() {
        this.cache.clear();
        this.inFlight.clear();
    }
}