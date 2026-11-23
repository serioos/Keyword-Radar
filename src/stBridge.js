/**
 * Keyword Radar — SillyTavern Runtime Bridge
 *
 * Centralizes all access to SillyTavern's `getContext()` and dynamic module imports
 * so the extension works cleanly regardless of install path (third-party, built-in,
 * or reverse-proxy subpath) and remains easily mockable in unit tests.
 */

import { LOG_PREFIX } from './constants.js';

let worldInfoModulePromise = null;
let tokenizersModulePromise = null;
let powerUserModulePromise = null;

/**
 * Resolve a URL to a file inside SillyTavern's `/scripts/` directory based on `import.meta.url`.
 * @param {string} scriptRelativePath e.g. 'world-info.js'
 * @returns {string}
 */
export function resolveStScriptUrl(scriptRelativePath) {
    const url = new URL(import.meta.url);
    const marker = '/scripts/extensions/';
    const idx = url.pathname.indexOf(marker);
    if (idx !== -1) {
        const basePath = url.pathname.slice(0, idx);
        return `${url.origin}${basePath}/scripts/${scriptRelativePath}`;
    }
    return new URL(`../../../../scripts/${scriptRelativePath}`, import.meta.url).href;
}

/**
 * Get the current SillyTavern context object safely.
 * @returns {object|null}
 */
export function getStContext() {
    try {
        if (typeof globalThis.SillyTavern?.getContext === 'function') {
            return globalThis.SillyTavern.getContext();
        }
    } catch (err) {
        console.warn(`${LOG_PREFIX} Failed to read SillyTavern.getContext():`, err);
    }
    return null;
}

/**
 * Lazily load SillyTavern's `world-info.js` module.
 * @returns {Promise<object|null>}
 */
export async function getWorldInfoModule() {
    if (!worldInfoModulePromise) {
        const url = resolveStScriptUrl('world-info.js');
        worldInfoModulePromise = import(url).catch((err) => {
            console.error(`${LOG_PREFIX} Could not load SillyTavern world-info.js from ${url}:`, err);
            return null;
        });
    }
    return worldInfoModulePromise;
}

/**
 * Lazily load SillyTavern's `tokenizers.js` module.
 * @returns {Promise<object|null>}
 */
export async function getTokenizersModule() {
    if (!tokenizersModulePromise) {
        const url = resolveStScriptUrl('tokenizers.js');
        tokenizersModulePromise = import(url).catch(() => null);
    }
    return tokenizersModulePromise;
}

/**
 * Lazily load SillyTavern's `power-user.js` module.
 * @returns {Promise<object|null>}
 */
export async function getPowerUserModule() {
    if (!powerUserModulePromise) {
        const url = resolveStScriptUrl('power-user.js');
        powerUserModulePromise = import(url).catch(() => null);
    }
    return powerUserModulePromise;
}

/**
 * Read current SillyTavern World Info global scanning & budget settings.
 * @returns {Promise<object>}
 */
export async function getWorldInfoScanConfig() {
    const wi = await getWorldInfoModule();
    const ctx = getStContext();
    const maxContext = Number(ctx?.maxContext ?? 0);
    const budgetPercent = Number(wi?.world_info_budget ?? 25);
    const budgetCap = Number(wi?.world_info_budget_cap ?? 0);

    let budgetTokens = 0;
    if (maxContext > 0 && budgetPercent > 0) {
        budgetTokens = Math.round((budgetPercent * maxContext) / 100);
        if (budgetCap > 0 && budgetTokens > budgetCap) {
            budgetTokens = budgetCap;
        }
    } else if (budgetCap > 0) {
        budgetTokens = budgetCap;
    }

    return {
        scanDepth: Number(wi?.world_info_depth ?? 2),
        caseSensitive: Boolean(wi?.world_info_case_sensitive ?? false),
        matchWholeWords: Boolean(wi?.world_info_match_whole_words ?? false),
        recursive: Boolean(wi?.world_info_recursive ?? false),
        maxRecursionSteps: Number(wi?.world_info_max_recursion_steps ?? 0),
        includeNames: Boolean(wi?.world_info_include_names ?? true),
        budgetPercent,
        budgetCap,
        budgetTokens,
    };
}

/**
 * Count tokens using SillyTavern's active tokenizer (with graceful fallback).
 * @param {string} text
 * @returns {Promise<number|null>}
 */
export async function countTokensAccurate(text) {
    if (!text) return 0;
    const ctx = getStContext();
    if (typeof ctx?.getTokenCountAsync === 'function') {
        try {
            return await ctx.getTokenCountAsync(text);
        } catch {
            // fall through
        }
    }
    const tok = await getTokenizersModule();
    if (typeof tok?.getTokenCountAsync === 'function') {
        try {
            return await tok.getTokenCountAsync(text);
        } catch {
            // fall through
        }
    }
    return null;
}

/**
 * Escape a string for safe use inside a CSS attribute selector.
 * @param {string} val
 * @returns {string}
 */
function cssEscapeSafe(val) {
    const str = String(val ?? '');
    if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
        return CSS.escape(str);
    }
    return str.replace(/["\\]/g, '\\$&');
}

/**
 * Open SillyTavern's World Info editor directly to a specific lorebook and entry UID.
 * Scrolls to and flash-highlights the entry, and optionally expands its drawer depending on `expand`.
 *
 * @param {string} worldName
 * @param {string|number} uid
 * @param {{ expand?: boolean }} [options]
 */
export async function openEntryInWorldInfoEditor(worldName, uid, { expand = true } = {}) {
    const wi = await getWorldInfoModule();
    if (!wi || typeof wi.openWorldInfoEditor !== 'function') {
        console.warn(`${LOG_PREFIX} openWorldInfoEditor is not available in this SillyTavern version.`);
        return false;
    }

    try {
        wi.openWorldInfoEditor(worldName);

        const targetUid = String(uid);
        const escapedUid = cssEscapeSafe(targetUid);
        const maxAttempts = 25;
        let attempts = 0;

        const tryRevealEntry = () => {
            attempts++;
            const entryEl = document.querySelector(`#world_popup_entries_list .world_entry[uid="${escapedUid}"]`);
            if (entryEl) {
                entryEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
                if (expand) {
                    const drawerContent = entryEl.querySelector('.inline-drawer-content');
                    const drawerIcon = entryEl.querySelector('.inline-drawer-icon');
                    if (drawerContent && drawerIcon && window.getComputedStyle(drawerContent).display === 'none') {
                        drawerIcon.click();
                    }
                }
                entryEl.classList.remove('kr-editor-flash');
                void entryEl.offsetWidth;
                entryEl.classList.add('kr-editor-flash');
                setTimeout(() => entryEl.classList.remove('kr-editor-flash'), 2200);
                return;
            }

            if (attempts < maxAttempts) {
                setTimeout(tryRevealEntry, 120);
            }
        };

        setTimeout(tryRevealEntry, 120);
        return true;
    } catch (err) {
        console.error(`${LOG_PREFIX} Failed to open World Info editor for ${worldName}#${uid}:`, err);
        return false;
    }
}
