/**
 * Keyword Radar — SillyTavern Generation & World Info Interceptor
 *
 * Cleanly enforces:
 *   1. One-Turn / N-Turn / Session Mutes (non-destructively via WORLDINFO_ENTRIES_LOADED)
 *   2. Swipe-friendly lifecycle (via manifest.json `generate_interceptor`)
 *   3. One-Turn Manual Boosts (via WORLDINFO_ENTRIES_LOADED temporary enable + native WORLDINFO_FORCE_ACTIVATE,
 *      so even entries currently disabled in the Lorebook can be force-triggered for 1 turn safely!)
 *   4. Optional recursive child preservation when `muteBlocksRecursiveChildren` is disabled
 */

import { LOG_PREFIX } from './constants.js';
import { getEntryKey } from './utils.js';

export function createInterceptor(state, { fetchAllEntries, emitForceActivate, onAfterStateChange } = {}) {
    let internalFetchDepth = 0;

    async function runAsInternalScan(fn) {
        internalFetchDepth++;
        try {
            return await fn();
        } finally {
            internalFetchDepth = Math.max(0, internalFetchDepth - 1);
        }
    }

    async function handleGenerateInterceptor(chat, _contextSize, _abort, type) {
        const settings = state.getSettings();
        if (!settings.enabled) {
            state.setActiveGenerationContext(null);
            return;
        }

        const lifecycle = state.onGenerationStart({ type, chat });
        if (lifecycle.ignored) {
            state.setActiveGenerationContext(null);
            return;
        }

        const lastScan = state.getLastScanResult();
        const preservedChildren = (!settings.muteBlocksRecursiveChildren && lastScan?.preservedRecursiveChildren?.length)
            ? lastScan.preservedRecursiveChildren
            : [];

        const boostedKeys = new Set(lifecycle.boostedRecords.map((r) => r.key));
        const preservedKeys = new Set(preservedChildren.map((c) => getEntryKey(c.entry)));

        state.setActiveGenerationContext({
            turnKey: lifecycle.turnKey,
            mutedKeys: lifecycle.mutedKeys,
            boostedKeys,
            preservedKeys,
            boostedRecords: lifecycle.boostedRecords,
            preservedChildren,
            createdAt: Date.now(),
        });

        const toForceActivate = [];

        if (lifecycle.boostedRecords.length > 0 && typeof fetchAllEntries === 'function') {
            const allEntries = await runAsInternalScan(() => fetchAllEntries());
            const entryByKey = new Map(allEntries.map((e) => [getEntryKey(e), e]));

            for (const boostRec of lifecycle.boostedRecords) {
                const fullEntry = entryByKey.get(boostRec.key);
                if (fullEntry) {
                    toForceActivate.push({ ...fullEntry, disable: false });
                }
            }
        }

        for (const child of preservedChildren) {
            if (child?.entry && !lifecycle.mutedKeys.has(getEntryKey(child.entry))) {
                toForceActivate.push({ ...child.entry, disable: false });
            }
        }

        if (toForceActivate.length > 0 && typeof emitForceActivate === 'function') {
            try {
                await emitForceActivate(toForceActivate);
                console.debug(`${LOG_PREFIX} Force-activated ${toForceActivate.length} entry(ies) for ${lifecycle.turnKey}`);
            } catch (err) {
                console.error(`${LOG_PREFIX} Failed to emit WORLDINFO_FORCE_ACTIVATE:`, err);
            }
        }

        if (typeof onAfterStateChange === 'function') {
            onAfterStateChange();
        }
    }

    /**
     * Handler for SillyTavern's `event_types.WORLDINFO_ENTRIES_LOADED`.
     * Runs inside `getSortedEntries()` on shallow-cloned entries before `checkWorldInfo()`.
     *  - Sets `entry.disable = true` on muted entries.
     *  - Temporarily sets `entry.disable = false` on boosted (and preserved recursive) entries
     *    so SillyTavern's `if (entry.disable == true) continue;` check does not skip them
     *    before reaching `buffer.getExternallyActivated(entry)`.
     */
    function handleWorldInfoEntriesLoaded(payload) {
        if (internalFetchDepth > 0) return;

        const settings = state.getSettings();
        if (!settings.enabled) return;

        const genCtx = state.getActiveGenerationContext();
        if (!genCtx) return;

        if (Date.now() - genCtx.createdAt > 120000) {
            state.setActiveGenerationContext(null);
            return;
        }

        const hasMutes = genCtx.mutedKeys && genCtx.mutedKeys.size > 0;
        const hasBoosts = genCtx.boostedKeys && genCtx.boostedKeys.size > 0;
        const hasPreserved = genCtx.preservedKeys && genCtx.preservedKeys.size > 0;
        if (!hasMutes && !hasBoosts && !hasPreserved) return;

        const buckets = [
            payload?.globalLore,
            payload?.characterLore,
            payload?.chatLore,
            payload?.personaLore,
        ];

        let suppressedCount = 0;
        let enabledForBoostCount = 0;

        for (const list of buckets) {
            if (!Array.isArray(list)) continue;
            for (const entry of list) {
                const key = getEntryKey(entry);
                if (hasMutes && genCtx.mutedKeys.has(key)) {
                    entry.disable = true;
                    suppressedCount++;
                } else if ((hasBoosts && genCtx.boostedKeys.has(key)) || (hasPreserved && genCtx.preservedKeys.has(key))) {
                    if (entry.disable) {
                        entry.disable = false;
                        enabledForBoostCount++;
                    }
                }
            }
        }

        if (suppressedCount > 0) {
            console.debug(`${LOG_PREFIX} Suppressed ${suppressedCount} muted entry(ies) for ${genCtx.turnKey}`);
        }
        if (enabledForBoostCount > 0) {
            console.debug(`${LOG_PREFIX} Temporarily enabled ${enabledForBoostCount} disabled boosted entry(ies) for ${genCtx.turnKey}`);
        }
    }

    return {
        runAsInternalScan,
        handleGenerateInterceptor,
        handleWorldInfoEntriesLoaded,
    };
}
