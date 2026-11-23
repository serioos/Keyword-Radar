/**
 * Keyword Radar — Real-Time Draft Lorebook Scanner & Recursive Chain Analyzer
 *
 * Pure scanning engine that compares:
 *   1) Baseline chat activation (recent chat history + constants + active sticky timers + recursion)
 *   2) Draft-augmented activation (chat history + current user draft + boosts + recursion)
 *
 * Also computes:
 *   - World Info token budget & overflow warnings
 *   - Probability (<100%) & Inclusion Group (`group`, including comma-separated multi-groups) conflict metadata
 *   - Recursive cascade previews for manual boosting
 */

import { ACTIVATION_SOURCE } from './constants.js';
import { evaluateEntryKeywords, findKeywordSpans } from './matcher.js';
import { estimateTokensFast, getEntryKey, getEntryTitle, splitCsvList } from './utils.js';

const JOINER = '\n';

/**
 * Format chat messages into a scan buffer string for a given scanDepth.
 */
export function buildScanBuffer(messages, depth, includeNames = true) {
    if (!Array.isArray(messages) || messages.length === 0 || depth <= 0) {
        return '';
    }
    const visible = messages.filter((m) => m && !m.is_system && typeof m.mes === 'string');
    const slice = visible.slice(-depth).reverse();
    return slice
        .map((m) => (includeNames && m.name ? `${m.name}: ${m.mes}` : m.mes))
        .join(JOINER);
}

/**
 * Determine which entries have active sticky / cooldown / delay timed effects
 * for a given chat length (without mutating `chat_metadata.timedWorldInfo`).
 */
export function evaluateTimedEffectsReadOnly(entries, chatLength, timedWorldInfo) {
    const stickyKeys = new Set();
    const cooldownKeys = new Set();
    const delayKeys = new Set();

    const byHash = new Map();
    for (const entry of entries) {
        if (entry.hash !== undefined && entry.hash !== null) {
            byHash.set(String(entry.hash), entry);
        }
    }

    const stickyMap = timedWorldInfo?.sticky || {};
    for (const [key, effect] of Object.entries(stickyMap)) {
        if (!effect || typeof effect !== 'object') continue;
        const entry = byHash.get(String(effect.hash));
        const entryKey = entry ? getEntryKey(entry) : key;
        if (chatLength <= Number(effect.start) && !effect.protected) continue;
        if (chatLength >= Number(effect.end)) continue;
        if (entry && !entry.sticky) continue;
        stickyKeys.add(entryKey);
    }

    const cooldownMap = timedWorldInfo?.cooldown || {};
    for (const [key, effect] of Object.entries(cooldownMap)) {
        if (!effect || typeof effect !== 'object') continue;
        const entry = byHash.get(String(effect.hash));
        const entryKey = entry ? getEntryKey(entry) : key;
        if (chatLength <= Number(effect.start) && !effect.protected) continue;
        if (chatLength >= Number(effect.end)) continue;
        if (entry && !entry.cooldown) continue;
        cooldownKeys.add(entryKey);
    }

    for (const entry of entries) {
        if (entry.delay && chatLength < Number(entry.delay)) {
            delayKeys.add(getEntryKey(entry));
        }
    }

    return { stickyKeys, cooldownKeys, delayKeys };
}

function isEntryEligible(entry, { characterFilename, characterTags, cooldownKeys, delayKeys, stickyKeys, generationType = 'normal' }) {
    if (!entry || entry.disable === true) return false;

    // Respect SillyTavern generation type triggers (e.g. impersonate-only or quiet-only entries)
    if (Array.isArray(entry.triggers) && entry.triggers.length > 0) {
        if (!entry.triggers.includes(generationType)) {
            return false;
        }
    }

    const key = getEntryKey(entry);
    const isSticky = stickyKeys.has(key);

    if (delayKeys.has(key)) return false;
    if (cooldownKeys.has(key) && !isSticky) return false;

    if (Array.isArray(entry.decorators) && entry.decorators.includes('@@dont_activate')) {
        return false;
    }

    if (entry.characterFilter?.names?.length > 0 && characterFilename) {
        const included = entry.characterFilter.names.includes(characterFilename);
        const filtered = entry.characterFilter.isExclude ? included : !included;
        if (filtered) return false;
    }

    // Match SillyTavern's world-info.js: only apply tag filter when a tagMap array exists for the active entity
    if (entry.characterFilter?.tags?.length > 0 && Array.isArray(characterTags)) {
        const includesTag = characterTags.some((t) => entry.characterFilter.tags.includes(t));
        const filtered = entry.characterFilter.isExclude ? includesTag : !includesTag;
        if (filtered) return false;
    }

    return true;
}

function runSimulationPass({
    entries,
    messages,
    scanConfig,
    timedEffects,
    substituteParams,
    characterFilename,
    characterTags,
    boostedKeys = new Set(),
}) {
    const activated = new Map();
    const globalDepth = Math.max(0, Number(scanConfig.scanDepth ?? 2));
    const includeNames = Boolean(scanConfig.includeNames ?? true);
    const allowRecursion = Boolean(scanConfig.recursive);
    const maxRecursionSteps = Number(scanConfig.maxRecursionSteps ?? 0);

    const depthBufferCache = new Map();
    const getBufferForDepth = (depth) => {
        const d = Math.max(0, Number(depth));
        if (!depthBufferCache.has(d)) {
            const raw = buildScanBuffer(messages, d, includeNames);
            depthBufferCache.set(d, { raw, lower: raw.toLowerCase() });
        }
        return depthBufferCache.get(d);
    };

    const availableDelayLevels = [...new Set(
        entries
            .filter((e) => e.delayUntilRecursion)
            .map((e) => (e.delayUntilRecursion === true ? 1 : Number(e.delayUntilRecursion))),
    )].sort((a, b) => a - b);

    let newlyActivatedThisStep = [];

    for (const entry of entries) {
        const key = getEntryKey(entry);
        if (boostedKeys.has(key)) {
            const rec = {
                entry,
                key,
                reason: 'boosted',
                evalResult: null,
                recursionDepth: 0,
                triggeredBy: [],
            };
            activated.set(key, rec);
            if (!entry.preventRecursion) {
                newlyActivatedThisStep.push({ key, title: getEntryTitle(entry), content: entry.content || '' });
            }
            continue;
        }

        if (!isEntryEligible(entry, { characterFilename, characterTags, ...timedEffects })) {
            continue;
        }

        const isSticky = timedEffects.stickyKeys.has(key);
        if (entry.delayUntilRecursion && !isSticky) {
            continue;
        }

        if (Array.isArray(entry.decorators) && entry.decorators.includes('@@activate')) {
            const rec = { entry, key, reason: 'constant', evalResult: null, recursionDepth: 0, triggeredBy: [] };
            activated.set(key, rec);
            if (!entry.preventRecursion) {
                newlyActivatedThisStep.push({ key, title: getEntryTitle(entry), content: entry.content || '' });
            }
            continue;
        }

        if (entry.constant) {
            const rec = { entry, key, reason: 'constant', evalResult: null, recursionDepth: 0, triggeredBy: [] };
            activated.set(key, rec);
            if (!entry.preventRecursion) {
                newlyActivatedThisStep.push({ key, title: getEntryTitle(entry), content: entry.content || '' });
            }
            continue;
        }

        if (isSticky) {
            const rec = { entry, key, reason: 'sticky', evalResult: null, recursionDepth: 0, triggeredBy: [] };
            activated.set(key, rec);
            if (!entry.preventRecursion) {
                newlyActivatedThisStep.push({ key, title: getEntryTitle(entry), content: entry.content || '' });
            }
            continue;
        }

        const entryDepth = (entry.scanDepth !== null && entry.scanDepth !== undefined)
            ? Number(entry.scanDepth)
            : globalDepth;
        const buf = getBufferForDepth(entryDepth);
        const evalResult = evaluateEntryKeywords(entry, buf.raw, scanConfig, substituteParams, buf.lower);

        if (evalResult.matched) {
            const rec = {
                entry,
                key,
                reason: 'keyword',
                evalResult,
                recursionDepth: 0,
                triggeredBy: [],
            };
            activated.set(key, rec);
            if (!entry.preventRecursion) {
                newlyActivatedThisStep.push({ key, title: getEntryTitle(entry), content: entry.content || '' });
            }
        }
    }

    if (allowRecursion) {
        const recurseSources = [...newlyActivatedThisStep];
        let step = 0;
        const maxSteps = maxRecursionSteps > 0 ? maxRecursionSteps : 10;
        let delayLevelIdx = 0;

        while (step < maxSteps) {
            step++;
            const currentDelayLevel = availableDelayLevels[delayLevelIdx] ?? 0;
            const recurseText = recurseSources.map((s) => s.content).filter(Boolean).join(JOINER);
            if (!recurseText && currentDelayLevel === 0) break;

            let addedInStep = 0;
            const nextStepSources = [];

            for (const entry of entries) {
                const key = getEntryKey(entry);
                if (activated.has(key)) continue;
                if (!isEntryEligible(entry, { characterFilename, characterTags, ...timedEffects })) continue;
                if (entry.excludeRecursion) continue;

                if (entry.delayUntilRecursion) {
                    const entryDelayLevel = entry.delayUntilRecursion === true ? 1 : Number(entry.delayUntilRecursion);
                    if (entryDelayLevel > currentDelayLevel) continue;
                }

                const entryDepth = (entry.scanDepth !== null && entry.scanDepth !== undefined)
                    ? Number(entry.scanDepth)
                    : globalDepth;
                const baseBuf = getBufferForDepth(entryDepth);
                const combinedText = recurseText ? `${baseBuf.raw}${JOINER}${recurseText}` : baseBuf.raw;
                const evalResult = evaluateEntryKeywords(entry, combinedText, scanConfig, substituteParams);

                if (evalResult.matched) {
                    const triggeredBy = [];
                    for (const src of recurseSources) {
                        if (!src.content) continue;
                        const parentEval = evaluateEntryKeywords(entry, src.content, scanConfig, substituteParams);
                        if (parentEval.matched || parentEval.primaryMatches.length > 0) {
                            triggeredBy.push({
                                key: src.key,
                                title: src.title,
                                matchedKeyword: parentEval.primaryMatches[0]?.substituted || evalResult.primaryMatches[0]?.substituted || '',
                            });
                        }
                    }
                    if (triggeredBy.length === 0 && recurseSources.length > 0) {
                        for (const src of recurseSources) {
                            const pm = evalResult.primaryMatches.find((m) =>
                                evaluateEntryKeywords({ ...entry, key: [m.raw], selective: false }, src.content, scanConfig, substituteParams).matched,
                            );
                            if (pm) {
                                triggeredBy.push({ key: src.key, title: src.title, matchedKeyword: pm.substituted });
                            }
                        }
                    }

                    const rec = {
                        entry,
                        key,
                        reason: 'recursive',
                        evalResult,
                        recursionDepth: step,
                        triggeredBy,
                    };
                    activated.set(key, rec);
                    addedInStep++;

                    if (!entry.preventRecursion) {
                        nextStepSources.push({ key, title: getEntryTitle(entry), content: entry.content || '' });
                    }
                }
            }

            if (addedInStep > 0) {
                recurseSources.push(...nextStepSources);
            } else if (delayLevelIdx + 1 < availableDelayLevels.length) {
                delayLevelIdx++;
            } else {
                break;
            }
        }
    }

    return activated;
}

/**
 * Predict which additional recursive child entries would wake up if `targetEntry` were manually boosted.
 * Used by the Boost Picker modal to show a live recursive cascade preview before pinning.
 *
 * @param {object} targetEntry
 * @param {Array<object>} allEntries
 * @param {Set<string>} alreadyActiveKeys
 * @param {object} [scanConfig]
 * @param {(s: string) => string} [substituteParams]
 * @returns {{ children: Array<{ key: string, title: string, tokens: number }>, totalTokens: number }}
 */
export function previewRecursiveCascade(
    targetEntry,
    allEntries = [],
    alreadyActiveKeys = new Set(),
    scanConfig = {},
    substituteParams = (s) => s,
) {
    if (!targetEntry || !scanConfig?.recursive || targetEntry.preventRecursion) {
        return { children: [], totalTokens: 0 };
    }
    const content = String(targetEntry.content || '').trim();
    if (!content) return { children: [], totalTokens: 0 };

    const targetKey = getEntryKey(targetEntry);
    const visited = new Set([targetKey, ...alreadyActiveKeys]);
    const children = [];
    const maxSteps = Number(scanConfig.maxRecursionSteps) > 0 ? Number(scanConfig.maxRecursionSteps) : 5;

    let frontierText = content;
    for (let step = 0; step < maxSteps; step++) {
        const nextTexts = [];
        const lowerFrontier = frontierText.toLowerCase();
        for (const entry of allEntries) {
            if (!entry || entry.disable || entry.excludeRecursion) continue;
            if (Array.isArray(entry.triggers) && entry.triggers.length > 0 && !entry.triggers.includes('normal')) continue;
            const key = getEntryKey(entry);
            if (visited.has(key)) continue;

            const evalRes = evaluateEntryKeywords(entry, frontierText, scanConfig, substituteParams, lowerFrontier);
            if (evalRes.matched) {
                visited.add(key);
                const tokens = estimateTokensFast(entry.content || '');
                children.push({ key, title: getEntryTitle(entry), tokens });
                if (!entry.preventRecursion && entry.content) {
                    nextTexts.push(entry.content);
                }
            }
        }
        if (nextTexts.length === 0) break;
        frontierText = `${frontierText}${JOINER}${nextTexts.join(JOINER)}`;
    }

    const totalTokens = children.reduce((sum, c) => sum + c.tokens, 0);
    return { children, totalTokens };
}

/**
 * Scan active Lorebook entries against current chat history + the user's live draft message.
 */
export function scanDraftAgainstLorebooks({
    entries = [],
    chatMessages = [],
    draftText = '',
    userName = 'User',
    timedWorldInfo = null,
    scanConfig = {},
    substituteParams = (s) => s,
    characterFilename = '',
    characterTags = null,
    effectiveMutes = new Map(),
    effectiveBoosts = new Map(),
    muteBlocksRecursiveChildren = true,
    tokenCache = null,
    cachedBaseline = null,
}) {
    const trimmedDraft = String(draftText ?? '').trim();
    const hasDraft = trimmedDraft.length > 0;
    const boostedKeys = new Set(effectiveBoosts.keys());

    // 1. Baseline pass: chat history ONLY (reuses cachedBaseline when chat history hasn't changed)
    let baselineActivated = cachedBaseline;
    if (!baselineActivated) {
        const baselineTimed = evaluateTimedEffectsReadOnly(entries, chatMessages.length, timedWorldInfo);
        baselineActivated = runSimulationPass({
            entries,
            messages: chatMessages,
            scanConfig,
            timedEffects: baselineTimed,
            substituteParams,
            characterFilename,
            characterTags,
            boostedKeys: new Set(),
        });
    }

    // 2. Draft-augmented pass: chat history + user's draft message + manual boosts
    const augmentedMessages = hasDraft
        ? [...chatMessages, { name: userName, mes: draftText, is_user: true, is_system: false }]
        : chatMessages;
    const draftTimed = evaluateTimedEffectsReadOnly(entries, augmentedMessages.length, timedWorldInfo);
    const draftActivated = runSimulationPass({
        entries,
        messages: augmentedMessages,
        scanConfig,
        timedEffects: draftTimed,
        substituteParams,
        characterFilename,
        characterTags,
        boostedKeys,
    });

    // 3. Parent mute -> recursive child impact
    const directlyMutedKeys = new Set(effectiveMutes.keys());
    const suppressedByParentMuteKeys = new Set();
    const preservedRecursiveChildren = [];

    if (directlyMutedKeys.size > 0) {
        const unmutedEntries = entries.filter((e) => !directlyMutedKeys.has(getEntryKey(e)));
        const afterMuteActivated = runSimulationPass({
            entries: unmutedEntries,
            messages: augmentedMessages,
            scanConfig,
            timedEffects: draftTimed,
            substituteParams,
            characterFilename,
            characterTags,
            boostedKeys,
        });

        for (const [key, rec] of draftActivated.entries()) {
            if (directlyMutedKeys.has(key)) continue;
            if (!afterMuteActivated.has(key) && rec.reason === 'recursive') {
                if (muteBlocksRecursiveChildren) {
                    suppressedByParentMuteKeys.add(key);
                } else {
                    preservedRecursiveChildren.push({
                        world: rec.entry.world,
                        uid: rec.entry.uid,
                        entry: rec.entry,
                    });
                }
            }
        }
    }

    // 4. Build unified RadarMatch list and draft highlight spans
    const matches = [];
    const spanAccumulator = [];

    for (const [key, rec] of draftActivated.entries()) {
        const entry = rec.entry;
        const wasInBaseline = baselineActivated.has(key);
        const isBoosted = boostedKeys.has(key);
        const isDirectlyMuted = directlyMutedKeys.has(key);
        const isSuppressedByParent = suppressedByParentMuteKeys.has(key);
        const isMuted = isDirectlyMuted || isSuppressedByParent;

        let source;
        if (isBoosted) {
            source = ACTIVATION_SOURCE.BOOSTED;
        } else if (rec.reason === 'constant') {
            source = ACTIVATION_SOURCE.CONSTANT;
        } else if (rec.reason === 'sticky') {
            source = ACTIVATION_SOURCE.STICKY;
        } else if (rec.reason === 'recursive') {
            source = wasInBaseline ? ACTIVATION_SOURCE.RECURSIVE_HISTORY : ACTIVATION_SOURCE.RECURSIVE_DRAFT;
        } else {
            source = wasInBaseline ? ACTIVATION_SOURCE.HISTORY : ACTIVATION_SOURCE.DRAFT;
        }

        const isNew = (
            source === ACTIVATION_SOURCE.DRAFT ||
            source === ACTIVATION_SOURCE.RECURSIVE_DRAFT ||
            source === ACTIVATION_SOURCE.BOOSTED
        );

        const matchedKeywords = [];
        if (rec.evalResult) {
            for (const pm of rec.evalResult.primaryMatches) {
                const spans = hasDraft ? findKeywordSpans(draftText, pm.substituted, entry, scanConfig) : [];
                matchedKeywords.push({ ...pm, isSecondary: false, inDraft: spans.length > 0, spans });
                for (const sp of spans) {
                    spanAccumulator.push({ ...sp, entryKey: key, isMuted, isNew });
                }
            }
            for (const sm of rec.evalResult.secondaryMatches) {
                const spans = hasDraft ? findKeywordSpans(draftText, sm.substituted, entry, scanConfig) : [];
                matchedKeywords.push({ ...sm, isSecondary: true, inDraft: spans.length > 0, spans });
                for (const sp of spans) {
                    spanAccumulator.push({ ...sp, entryKey: key, isMuted, isNew });
                }
            }
        }

        const tokens = (tokenCache && tokenCache.has(key))
            ? tokenCache.get(key)
            : estimateTokensFast(entry.content || '');

        // Probability metadata (<100%)
        const hasProbability = Boolean(entry.useProbability) && Number(entry.probability ?? 100) < 100;
        const probability = hasProbability ? Math.max(0, Math.min(100, Number(entry.probability))) : 100;

        // Inclusion group metadata (supports comma-separated multi-group names per SillyTavern's splitCsv)
        const inclusionGroups = splitCsvList(entry.group);
        const inclusionGroup = inclusionGroups.join(', ');

        matches.push({
            key,
            uid: entry.uid,
            world: entry.world || 'Unknown Lorebook',
            title: getEntryTitle(entry),
            content: entry.content || '',
            entry,
            source,
            isNew,
            isRecursive: rec.reason === 'recursive',
            recursionDepth: rec.recursionDepth,
            triggeredBy: rec.triggeredBy || [],
            matchedKeywords,
            selectiveLogic: rec.evalResult?.selectiveLogic ?? entry.selectiveLogic ?? 0,
            hasSecondary: Boolean(rec.evalResult?.hasSecondary),
            tokens,
            isMuted,
            isDirectlyMuted,
            suppressedByParentMute: isSuppressedByParent,
            muteInfo: effectiveMutes.get(key) || null,
            isBoosted,
            hasProbability,
            probability,
            inclusionGroup,
            inclusionGroups,
            groupCompetitors: [],
            budgetOverflow: false,
        });
    }

    // 5. Detect competing Inclusion Groups among active unmuted matches (supporting CSV multi-groups)
    const groupMembers = new Map();
    for (const m of matches) {
        if (!m.isMuted && m.inclusionGroups.length > 0) {
            for (const grp of m.inclusionGroups) {
                if (!groupMembers.has(grp)) groupMembers.set(grp, []);
                groupMembers.get(grp).push(m);
            }
        }
    }
    for (const [, members] of groupMembers.entries()) {
        if (members.length > 1) {
            for (const m of members) {
                const existing = new Set(m.groupCompetitors);
                for (const other of members) {
                    if (other.key !== m.key) existing.add(other.title);
                }
                m.groupCompetitors = Array.from(existing);
            }
        }
    }

    // 6. Simulate World Info Token Budget & Overflow (respecting order & ignoreBudget)
    const budgetTokens = Math.max(0, Number(scanConfig.budgetTokens ?? 0));
    let budgetUsedTokens = 0;
    let overflowCount = 0;

    if (budgetTokens > 0) {
        const activeOrdered = matches
            .filter((m) => !m.isMuted)
            .sort((a, b) => Number(b.entry?.order ?? 100) - Number(a.entry?.order ?? 100));

        for (const m of activeOrdered) {
            if (m.entry?.ignoreBudget) {
                budgetUsedTokens += m.tokens;
                continue;
            }
            if (budgetUsedTokens + m.tokens <= budgetTokens) {
                budgetUsedTokens += m.tokens;
            } else {
                m.budgetOverflow = true;
                overflowCount++;
            }
        }
    } else {
        budgetUsedTokens = matches.filter((m) => !m.isMuted).reduce((sum, m) => sum + m.tokens, 0);
    }

    // 7. Sort matches cleanly for display
    const sourceRank = {
        [ACTIVATION_SOURCE.BOOSTED]: 0,
        [ACTIVATION_SOURCE.DRAFT]: 1,
        [ACTIVATION_SOURCE.RECURSIVE_DRAFT]: 2,
        [ACTIVATION_SOURCE.STICKY]: 3,
        [ACTIVATION_SOURCE.HISTORY]: 4,
        [ACTIVATION_SOURCE.RECURSIVE_HISTORY]: 5,
        [ACTIVATION_SOURCE.CONSTANT]: 6,
    };

    matches.sort((a, b) => {
        const diff = (sourceRank[a.source] ?? 99) - (sourceRank[b.source] ?? 99);
        if (diff !== 0) return diff;
        if (a.recursionDepth !== b.recursionDepth) return a.recursionDepth - b.recursionDepth;
        return b.tokens - a.tokens;
    });

    // 8. Build summary metrics
    const summary = {
        newCount: 0,
        activeNewCount: 0,
        activeNewTokens: 0,
        mutedCount: 0,
        mutedTokens: 0,
        alreadyActiveCount: 0,
        alreadyActiveTokens: 0,
        boostedCount: 0,
        boostedTokens: 0,
        totalActiveTokens: 0,
        budgetTokens,
        budgetUsedTokens,
        budgetExceeded: budgetTokens > 0 && overflowCount > 0,
        overflowCount,
    };

    for (const m of matches) {
        if (m.isMuted) {
            summary.mutedCount++;
            summary.mutedTokens += m.tokens;
        } else {
            summary.totalActiveTokens += m.tokens;
        }

        if (m.isBoosted) {
            summary.boostedCount++;
            summary.boostedTokens += m.tokens;
        }

        if (m.isNew) {
            summary.newCount++;
            if (!m.isMuted) {
                summary.activeNewCount++;
                summary.activeNewTokens += m.tokens;
            }
        } else {
            summary.alreadyActiveCount++;
            if (!m.isMuted) {
                summary.alreadyActiveTokens += m.tokens;
            }
        }
    }

    return {
        draftText,
        matches,
        draftSpans: spanAccumulator,
        summary,
        preservedRecursiveChildren,
        baselineActivated,
        timestamp: Date.now(),
    };
}

/**
 * Find all matched Lorebook entries whose triggering keyword span in the draft
 * covers the current caret position (or overlaps the current text selection).
 *
 * @param {object|null} scanResult
 * @param {number} selectionStart
 * @param {number} [selectionEnd]
 * @returns {Array<object>} Unique RadarMatch objects under the caret/selection
 */
export function findMatchesAtCaret(scanResult, selectionStart, selectionEnd = selectionStart) {
    if (!scanResult || !Array.isArray(scanResult.draftSpans) || !Array.isArray(scanResult.matches)) {
        return [];
    }
    const start = Math.max(0, Number(selectionStart) || 0);
    const end = Math.max(start, Number(selectionEnd) || start);

    const hitKeys = new Set();
    for (const sp of scanResult.draftSpans) {
        if (!sp) continue;
        const overlaps = start === end
            ? (start >= sp.start && start <= sp.end)
            : (start <= sp.end && end >= sp.start);
        if (overlaps && sp.entryKey) {
            hitKeys.add(sp.entryKey);
        }
    }

    if (hitKeys.size === 0) return [];
    return scanResult.matches.filter((m) => hitKeys.has(m.key));
}
