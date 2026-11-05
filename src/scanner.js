/**
 * Keyword Radar — Real-Time Pre-Flight Lorebook Scanner Engine
 * https://github.com/serioos/Keyword-Radar
 *
 * Implements SillyTavern-authentic World Info matching:
 * - Primary keys (`key`) + Optional Filter / Secondary keys (`keysecondary`)
 * - Selective logic: AND ANY (0), NOT ALL (1), NOT ANY (2), AND ALL (3)
 * - Per-entry & global `caseSensitive` and `matchWholeWords`
 * - Native `/regex/flags` key syntax
 * - Per-entry `scanDepth`, `constant`, `disable`, `delay`, `cooldown`, `sticky`
 * - Character filter (`characterFilter` include/exclude by name or tag)
 * - Extra match targets (Persona, Character Description, Personality, Scenario, etc.)
 * - Differential analysis: Newly triggered by Draft vs. Already Active from History / Constant / Sticky
 * - Multi-step Recursive Trigger Graph with parent-to-child provenance & mute propagation
 */

import { SELECTIVE_LOGIC, TRIGGER_STATUS } from './constants.js';
import { escapeRegExp } from './utils.js';

/**
 * Parses a SillyTavern regex key literal if formatted as `/pattern/flags`.
 * @param {string} rawKey
 * @returns {{ pattern: string, flags: string } | null}
 */
export function parseRegexKey(rawKey) {
    if (typeof rawKey !== 'string') return null;
    const trimmed = rawKey.trim();
    if (!trimmed.startsWith('/')) return null;
    const match = /^\/([\s\S]+)\/([gimsuy]*)$/.exec(trimmed);
    if (!match) return null;
    return {
        pattern: match[1],
        flags: match[2] || '',
    };
}

/**
 * Matches a single keyword or `/regex/flags` against a text haystack,
 * returning both boolean match status and character index spans when `collectSpans` is true.
 *
 * Mirrors SillyTavern's `WorldInfoBuffer.matchKeys` behavior:
 * - Regex keys `/.../flags` use native RegExp execution.
 * - Plain keys with `matchWholeWords: true` use non-word boundary assertions `(?:^|\W)(key)(?:$|\W)`
 *   when the key consists of a single word, or substring match when the key spans multiple words/punctuation.
 *
 * @param {string} haystack
 * @param {string} rawKey
 * @param {{
 *   caseSensitive: boolean,
 *   matchWholeWords: boolean,
 *   substituteFn?: (s: string) => string,
 *   collectSpans?: boolean
 * }} options
 * @returns {{ matched: boolean, key: string, matchedText: string, spans: Array<{ start: number, end: number, text: string, key: string }> }}
 */
export function matchSingleKeyInText(haystack, rawKey, options) {
    const emptyResult = { matched: false, key: rawKey, matchedText: '', spans: [] };
    if (!haystack || !rawKey) return emptyResult;

    const substitutedKey = typeof options.substituteFn === 'function'
        ? options.substituteFn(rawKey).trim()
        : String(rawKey).trim();
    if (!substitutedKey) return emptyResult;

    const regexDescriptor = parseRegexKey(substitutedKey);

    try {
        if (regexDescriptor) {
            let flags = regexDescriptor.flags;
            if (!options.caseSensitive && !flags.includes('i')) {
                flags += 'i';
            }
            const globalFlags = flags.includes('g') ? flags : `${flags}g`;
            const rx = new RegExp(regexDescriptor.pattern, globalFlags);
            const spans = [];
            let firstText = '';
            let m;
            let safety = 0;

            while ((m = rx.exec(haystack)) !== null && safety++ < 250) {
                if (m[0].length === 0) {
                    rx.lastIndex++;
                    continue;
                }
                if (!firstText) firstText = m[0];
                if (options.collectSpans) {
                    spans.push({
                        start: m.index,
                        end: m.index + m[0].length,
                        text: m[0],
                        key: rawKey,
                    });
                } else {
                    return { matched: true, key: rawKey, matchedText: m[0], spans: [] };
                }
            }

            return {
                matched: spans.length > 0 || Boolean(firstText),
                key: rawKey,
                matchedText: firstText,
                spans,
            };
        }

        // Plain-text keyword matching
        const escaped = escapeRegExp(substitutedKey);
        const flags = options.caseSensitive ? 'g' : 'gi';
        // SillyTavern applies whole-word boundary checks when matchWholeWords is enabled and key has no whitespace
        const useWordBoundaries = Boolean(options.matchWholeWords) && !/\W/.test(substitutedKey);

        if (useWordBoundaries) {
            const rx = new RegExp(`(?:^|\\W)(${escaped})(?:$|\\W)`, flags);
            const spans = [];
            let firstText = '';
            let m;
            let safety = 0;

            while ((m = rx.exec(haystack)) !== null && safety++ < 250) {
                const wordMatch = m[1];
                const leadOffset = m[0].indexOf(wordMatch);
                const actualStart = m.index + (leadOffset >= 0 ? leadOffset : 0);
                const actualEnd = actualStart + wordMatch.length;

                if (!firstText) firstText = wordMatch;
                if (options.collectSpans) {
                    spans.push({
                        start: actualStart,
                        end: actualEnd,
                        text: wordMatch,
                        key: rawKey,
                    });
                } else {
                    return { matched: true, key: rawKey, matchedText: wordMatch, spans: [] };
                }
                // Rewind lastIndex by 1 if trailing non-word char could be the leading boundary of the next match
                if (rx.lastIndex > actualEnd) {
                    rx.lastIndex = actualEnd;
                }
            }

            return {
                matched: spans.length > 0 || Boolean(firstText),
                key: rawKey,
                matchedText: firstText,
                spans,
            };
        } else {
            const rx = new RegExp(escaped, flags);
            const spans = [];
            let firstText = '';
            let m;
            let safety = 0;

            while ((m = rx.exec(haystack)) !== null && safety++ < 250) {
                if (m[0].length === 0) {
                    rx.lastIndex++;
                    continue;
                }
                if (!firstText) firstText = m[0];
                if (options.collectSpans) {
                    spans.push({
                        start: m.index,
                        end: m.index + m[0].length,
                        text: m[0],
                        key: rawKey,
                    });
                } else {
                    return { matched: true, key: rawKey, matchedText: m[0], spans: [] };
                }
            }

            return {
                matched: spans.length > 0 || Boolean(firstText),
                key: rawKey,
                matchedText: firstText,
                spans,
            };
        }
    } catch {
        return emptyResult;
    }
}

/**
 * Checks whether an entry passes its optional `characterFilter` against the active character.
 * @param {any} entry
 * @param {{ characterAvatar?: string, characterFullAvatar?: string, name2?: string, characterTags?: string[] }} scanContext
 * @returns {boolean}
 */
export function passesCharacterFilter(entry, scanContext) {
    const cf = entry.characterFilter;
    if (!cf) return true;

    const hasNames = Array.isArray(cf.names) && cf.names.length > 0;
    const hasTags = Array.isArray(cf.tags) && cf.tags.length > 0;
    if (!hasNames && !hasTags) return true;

    const avatarClean = String(scanContext.characterAvatar || '').toLowerCase();
    const avatarFull = String(scanContext.characterFullAvatar || '').toLowerCase();
    const charName = String(scanContext.name2 || '').toLowerCase();
    const activeTags = new Set((scanContext.characterTags || []).map((t) => String(t).toLowerCase()));

    const nameMatched = hasNames && cf.names.some((n) => {
        const lower = String(n).replace(/\.png$/i, '').toLowerCase();
        return lower === avatarClean || lower === avatarFull || lower === charName;
    });

    const tagMatched = hasTags && cf.tags.some((t) => activeTags.has(String(t).toLowerCase()));
    const anyMatch = nameMatched || tagMatched;

    return cf.isExclude ? !anyMatch : anyMatch;
}

/**
 * Evaluates whether an entry's Primary + Secondary keys trigger against a given text buffer.
 * Also evaluates against the draft text specifically so we can highlight exact draft words.
 *
 * @param {any} entry
 * @param {string} fullScanBuffer The complete text buffer for this entry's scan depth + auxiliary fields
 * @param {string} draftText Raw draft text from `#send_textarea` (for span extraction)
 * @param {{
 *   caseSensitive: boolean,
 *   matchWholeWords: boolean,
 *   substituteFn?: (s: string) => string
 * }} globalMatchOpts
 * @returns {{
 *   triggered: boolean,
 *   matchedPrimaryKeys: string[],
 *   matchedSecondaryKeys: string[],
 *   draftMatchedPrimaryKeys: string[],
 *   draftMatchedSecondaryKeys: string[],
 *   draftSpans: Array<{ start: number, end: number, text: string, key: string, isSecondary: boolean }>
 * }}
 */
export function evaluateEntryKeysAgainstBuffer(entry, fullScanBuffer, draftText, globalMatchOpts) {
    const empty = {
        triggered: false,
        matchedPrimaryKeys: [],
        matchedSecondaryKeys: [],
        draftMatchedPrimaryKeys: [],
        draftMatchedSecondaryKeys: [],
        draftSpans: [],
    };

    const primaryKeys = Array.isArray(entry.key) ? entry.key.filter(Boolean) : [];
    if (primaryKeys.length === 0) {
        return empty;
    }

    const caseSensitive = entry.caseSensitive !== null && entry.caseSensitive !== undefined
        ? Boolean(entry.caseSensitive)
        : Boolean(globalMatchOpts.caseSensitive);

    const matchWholeWords = entry.matchWholeWords !== null && entry.matchWholeWords !== undefined
        ? Boolean(entry.matchWholeWords)
        : Boolean(globalMatchOpts.matchWholeWords);

    const matchOpts = {
        caseSensitive,
        matchWholeWords,
        substituteFn: globalMatchOpts.substituteFn,
        collectSpans: false,
    };

    const draftSpanOpts = {
        ...matchOpts,
        collectSpans: true,
    };

    // 1. Evaluate Primary Keys (OR logic: at least 1 primary key must match)
    const matchedPrimaryKeys = [];
    const draftMatchedPrimaryKeys = [];
    const draftSpans = [];

    for (const pk of primaryKeys) {
        const res = matchSingleKeyInText(fullScanBuffer, pk, matchOpts);
        if (res.matched) {
            matchedPrimaryKeys.push(pk);
            if (draftText) {
                const draftRes = matchSingleKeyInText(draftText, pk, draftSpanOpts);
                if (draftRes.matched) {
                    draftMatchedPrimaryKeys.push(pk);
                    for (const sp of draftRes.spans) {
                        draftSpans.push({ ...sp, isSecondary: false });
                    }
                }
            }
        }
    }

    if (matchedPrimaryKeys.length === 0) {
        return empty;
    }

    // 2. Evaluate Secondary / Optional Filter Keys if `selective` is enabled and secondary keys exist
    const secondaryKeys = Array.isArray(entry.keysecondary) ? entry.keysecondary.filter(Boolean) : [];
    const matchedSecondaryKeys = [];
    const draftMatchedSecondaryKeys = [];

    if (entry.selective && secondaryKeys.length > 0) {
        for (const sk of secondaryKeys) {
            const res = matchSingleKeyInText(fullScanBuffer, sk, matchOpts);
            if (res.matched) {
                matchedSecondaryKeys.push(sk);
                if (draftText) {
                    const draftRes = matchSingleKeyInText(draftText, sk, draftSpanOpts);
                    if (draftRes.matched) {
                        draftMatchedSecondaryKeys.push(sk);
                        for (const sp of draftRes.spans) {
                            draftSpans.push({ ...sp, isSecondary: true });
                        }
                    }
                }
            }
        }

        const totalSec = secondaryKeys.length;
        const matchedSecCount = matchedSecondaryKeys.length;
        const logic = Number(entry.selectiveLogic ?? SELECTIVE_LOGIC.AND_ANY);

        let selectivePassed = true;
        switch (logic) {
            case SELECTIVE_LOGIC.AND_ANY:
                selectivePassed = matchedSecCount >= 1;
                break;
            case SELECTIVE_LOGIC.NOT_ALL:
                selectivePassed = matchedSecCount < totalSec;
                break;
            case SELECTIVE_LOGIC.NOT_ANY:
                selectivePassed = matchedSecCount === 0;
                break;
            case SELECTIVE_LOGIC.AND_ALL:
                selectivePassed = matchedSecCount === totalSec;
                break;
            default:
                selectivePassed = matchedSecCount >= 1;
                break;
        }

        if (!selectivePassed) {
            return empty;
        }
    }

    return {
        triggered: true,
        matchedPrimaryKeys,
        matchedSecondaryKeys,
        draftMatchedPrimaryKeys,
        draftMatchedSecondaryKeys,
        draftSpans,
    };
}

/**
 * Builds the text scan buffer for a given scanDepth from recent chat messages + optional draft message.
 * Mirrors SillyTavern's `WorldInfoBuffer` depth slicing.
 *
 * @param {Array<{ name: string, mes: string, is_user: boolean }>} chatMessages
 * @param {string|null} draftText If non-null, appended as the upcoming user message at depth 0
 * @param {number} depth Number of messages from the end of chat to scan
 * @param {boolean} includeNames Whether to prefix messages with `Name: `
 * @param {string} userName
 * @returns {string}
 */
export function buildDepthBuffer(chatMessages, draftText, depth, includeNames, userName = 'User') {
    const effectiveDepth = Math.max(0, Number(depth) || 0);
    if (effectiveDepth === 0) return '';

    const messages = Array.isArray(chatMessages) ? chatMessages.slice() : [];
    const hasDraft = typeof draftText === 'string' && draftText.length > 0;

    if (hasDraft) {
        messages.push({
            name: userName,
            mes: draftText,
            is_user: true,
        });
    }

    const sliceStart = Math.max(0, messages.length - effectiveDepth);
    const recent = messages.slice(sliceStart);

    const chunks = [];
    for (let i = recent.length - 1; i >= 0; i--) {
        const msg = recent[i];
        if (!msg || typeof msg.mes !== 'string') continue;
        if (includeNames && msg.name) {
            chunks.push(`${msg.name}: ${msg.mes}`);
        } else {
            chunks.push(msg.mes);
        }
    }

    return chunks.join('\n');
}

/**
 * Appends any entry-configured auxiliary fields (persona, char description, scenario, etc.) to a scan buffer.
 * @param {any} entry
 * @param {string} baseBuffer
 * @param {any} extraScanFields
 * @returns {string}
 */
function appendExtraMatchFields(entry, baseBuffer, extraScanFields) {
    if (!extraScanFields) return baseBuffer;
    const extras = [];
    if (entry.matchPersonaDescription && extraScanFields.personaDescription) {
        extras.push(extraScanFields.personaDescription);
    }
    if (entry.matchCharacterDescription && extraScanFields.characterDescription) {
        extras.push(extraScanFields.characterDescription);
    }
    if (entry.matchCharacterPersonality && extraScanFields.characterPersonality) {
        extras.push(extraScanFields.characterPersonality);
    }
    if (entry.matchCharacterDepthPrompt && extraScanFields.characterDepthPrompt) {
        extras.push(extraScanFields.characterDepthPrompt);
    }
    if (entry.matchScenario && extraScanFields.scenario) {
        extras.push(extraScanFields.scenario);
    }
    if (entry.matchCreatorNotes && extraScanFields.creatorNotes) {
        extras.push(extraScanFields.creatorNotes);
    }
    if (extras.length === 0) return baseBuffer;
    return `${baseBuffer}\n${extras.join('\n')}`;
}

/**
 * Runs a complete pre-send radar scan comparing:
 * 1. Baseline state (what is *already* active from chat history, constants, and sticky timers without the draft)
 * 2. Draft state (what becomes active when the user's draft is included, plus recursive cascades and manual boosts)
 *
 * @param {{
 *   draftText: string,
 *   entries: Array<any>,
 *   globalSettings: {
 *     scanDepth: number,
 *     recursive: boolean,
 *     maxRecursionSteps: number,
 *     caseSensitive: boolean,
 *     matchWholeWords: boolean,
 *     includeNames: boolean
 *   },
 *   scanContext: {
 *     name1: string,
 *     name2: string,
 *     characterAvatar?: string,
 *     characterFullAvatar?: string,
 *     characterTags?: string[],
 *     chatMessages: Array<{ name: string, mes: string, is_user: boolean }>,
 *     totalChatLength?: number,
 *     timedEffects?: { sticky: Set<string>, cooldown: Set<string>, stickyTurnsLeft: Map<string, number> },
 *     extraScanFields?: any
 *   },
 *   mutedKeys: Set<string>,
 *   boostedEntriesMap: Map<string, any>,
 *   muteBlocksRecursion: boolean,
 *   simulateRecursionAlways: boolean,
 *   maxRecursionDepth: number,
 *   substituteFn?: (s: string) => string,
 *   tokenCounterFn?: (entry: any) => number
 * }} params
 */
export function runPreSendRadarScan(params) {
    const {
        draftText = '',
        entries = [],
        globalSettings,
        scanContext,
        mutedKeys = new Set(),
        boostedEntriesMap = new Map(),
        muteBlocksRecursion = true,
        simulateRecursionAlways = false,
        maxRecursionDepth = 6,
        substituteFn = (s) => s,
        tokenCounterFn = () => 0,
    } = params;

    const cleanDraft = String(draftText ?? '');
    const chatMessages = scanContext?.chatMessages || [];
    const totalChatLength = scanContext?.totalChatLength ?? chatMessages.length;
    const stickySet = scanContext?.timedEffects?.sticky || new Set();
    const cooldownSet = scanContext?.timedEffects?.cooldown || new Set();
    const stickyTurnsLeft = scanContext?.timedEffects?.stickyTurnsLeft || new Map();

    // Cache depth buffers by depth number to avoid rebuilding identical strings
    const historyDepthCache = new Map();
    const withDraftDepthCache = new Map();
    const draftOnlyBuffer = globalSettings.includeNames && scanContext?.name1
        ? `${scanContext.name1}: ${cleanDraft}`
        : cleanDraft;

    const getHistoryBuffer = (depth) => {
        if (!historyDepthCache.has(depth)) {
            historyDepthCache.set(
                depth,
                buildDepthBuffer(chatMessages, null, depth, globalSettings.includeNames, scanContext?.name1),
            );
        }
        return historyDepthCache.get(depth);
    };

    const getWithDraftBuffer = (depth) => {
        if (!withDraftDepthCache.has(depth)) {
            withDraftDepthCache.set(
                depth,
                buildDepthBuffer(chatMessages, cleanDraft, depth, globalSettings.includeNames, scanContext?.name1),
            );
        }
        return withDraftDepthCache.get(depth);
    };

    const globalMatchOpts = {
        caseSensitive: Boolean(globalSettings.caseSensitive),
        matchWholeWords: Boolean(globalSettings.matchWholeWords),
        substituteFn,
    };

    // Filter eligible (enabled, non-cooldown, delay-satisfied, character-filter-passing) entries
    const eligibleEntries = [];
    for (const entry of entries) {
        if (entry.disable) continue;
        if (cooldownSet.has(entry.entryKey)) continue;
        // Delay check: entry cannot activate until at least `entry.delay` messages exist in chat
        if (entry.delay > 0 && totalChatLength + 1 < entry.delay) continue;
        if (!passesCharacterFilter(entry, scanContext || {})) continue;
        eligibleEntries.push(entry);
    }

    /**
     * Step 1: Direct Activation Pass (Step 0 before recursion)
     * Determine for each eligible entry:
     * - Is it active in Baseline (Constant, Sticky, or History match)?
     * - Is it active with Draft (Constant, Sticky, History+Draft match, or Draft-only match)?
     * - Is it Newly Triggered specifically because of the Draft?
     */
    /** @type {Map<string, any>} */
    const resultsMap = new Map();

    /** @type {Set<string>} Entries active in baseline (without draft) */
    const baselineActiveKeys = new Set();

    /** @type {Set<string>} Entries directly active when draft is present */
    const directWithDraftKeys = new Set();

    for (const entry of eligibleEntries) {
        const effectiveDepth = (entry.scanDepth !== null && entry.scanDepth !== undefined)
            ? Number(entry.scanDepth)
            : Number(globalSettings.scanDepth ?? 2);

        const isSticky = stickySet.has(entry.entryKey);
        const isConstant = Boolean(entry.constant);
        const isBoosted = boostedEntriesMap.has(entry.entryKey);
        const isDirectlyMuted = mutedKeys.has(entry.entryKey);

        // If entry has delayUntilRecursion > 0, it cannot trigger in the direct (non-recursive) pass
        // unless it's constant, sticky, or manually boosted
        const delayedForRecursionOnly = entry.delayUntilRecursion > 0 && !isConstant && !isSticky && !isBoosted;

        let baselineEval = null;
        let withDraftEval = null;
        let draftOnlyEval = null;

        if (!delayedForRecursionOnly && effectiveDepth > 0) {
            const histBuf = appendExtraMatchFields(entry, getHistoryBuffer(effectiveDepth), scanContext?.extraScanFields);
            baselineEval = evaluateEntryKeysAgainstBuffer(entry, histBuf, '', globalMatchOpts);

            if (cleanDraft.trim().length > 0) {
                const draftBuf = appendExtraMatchFields(entry, getWithDraftBuffer(effectiveDepth), scanContext?.extraScanFields);
                withDraftEval = evaluateEntryKeysAgainstBuffer(entry, draftBuf, cleanDraft, globalMatchOpts);
                draftOnlyEval = evaluateEntryKeysAgainstBuffer(entry, draftOnlyBuffer, cleanDraft, globalMatchOpts);
            } else {
                withDraftEval = baselineEval;
            }
        }

        const activeInHistory = Boolean(baselineEval?.triggered);
        const activeWithDraftKeywords = Boolean(withDraftEval?.triggered);
        const matchedInDraftTextItself = Boolean(
            draftOnlyEval?.triggered ||
            (withDraftEval?.triggered &&
                ((withDraftEval.draftMatchedPrimaryKeys?.length || 0) > 0 ||
                    (withDraftEval.draftMatchedSecondaryKeys?.length || 0) > 0)),
        );

        if (isConstant || isSticky || activeInHistory) {
            baselineActiveKeys.add(entry.entryKey);
        }

        const wouldActivateDirectly = isConstant || isSticky || isBoosted || activeWithDraftKeywords;
        if (wouldActivateDirectly) {
            directWithDraftKeys.add(entry.entryKey);
        }

        // Determine if this entry is NEWLY triggered by the user's draft
        // Case A: It was NOT active in baseline (not constant, not sticky, not in history), and now activates with draft.
        // Case B: Even if it wasn't in history at depth N-1, or if a message scrolled out of depth window,
        // if it wasn't in baselineActiveKeys and is in directWithDraftKeys, it's newly triggered by the draft.
        const isNewlyTriggeredDirect = !baselineActiveKeys.has(entry.entryKey) && activeWithDraftKeywords;

        if (wouldActivateDirectly) {
            const tokens = tokenCounterFn(entry);
            let status = TRIGGER_STATUS.ACTIVE_HISTORY;
            if (isDirectlyMuted) {
                status = TRIGGER_STATUS.MUTED;
            } else if (isBoosted && !isNewlyTriggeredDirect && !baselineActiveKeys.has(entry.entryKey)) {
                status = TRIGGER_STATUS.BOOSTED;
            } else if (isNewlyTriggeredDirect) {
                status = TRIGGER_STATUS.NEW_DIRECT;
            } else if (isSticky) {
                status = TRIGGER_STATUS.ACTIVE_STICKY;
            } else if (isConstant) {
                status = TRIGGER_STATUS.ACTIVE_CONSTANT;
            } else if (activeInHistory) {
                status = TRIGGER_STATUS.ACTIVE_HISTORY;
            }

            resultsMap.set(entry.entryKey, {
                entry,
                entryKey: entry.entryKey,
                status,
                isNewFromDraft: isNewlyTriggeredDirect,
                alsoMatchedInDraft: matchedInDraftTextItself,
                isRecursive: false,
                recursionStep: 0,
                triggeredByParents: [],
                triggeredChildren: [],
                matchedPrimaryKeys: withDraftEval?.matchedPrimaryKeys || [],
                matchedSecondaryKeys: withDraftEval?.matchedSecondaryKeys || [],
                draftMatchedPrimaryKeys: withDraftEval?.draftMatchedPrimaryKeys || [],
                draftMatchedSecondaryKeys: withDraftEval?.draftMatchedSecondaryKeys || [],
                draftSpans: withDraftEval?.draftSpans || [],
                stickyTurnsRemaining: stickyTurnsLeft.get(entry.entryKey) || 0,
                tokens,
                isMuted: isDirectlyMuted,
                isBoosted,
            });
        }
    }

    // Also include manually boosted entries that weren't in eligibleEntries (e.g., from another book or disabled)
    for (const [boostKey, boostObj] of boostedEntriesMap.entries()) {
        if (!resultsMap.has(boostKey) && boostObj?.entrySnapshot) {
            const snap = boostObj.entrySnapshot;
            const isDirectlyMuted = mutedKeys.has(boostKey);
            resultsMap.set(boostKey, {
                entry: snap,
                entryKey: boostKey,
                status: isDirectlyMuted ? TRIGGER_STATUS.MUTED : TRIGGER_STATUS.BOOSTED,
                isNewFromDraft: true,
                alsoMatchedInDraft: false,
                isRecursive: false,
                recursionStep: 0,
                triggeredByParents: [],
                triggeredChildren: [],
                matchedPrimaryKeys: [],
                matchedSecondaryKeys: [],
                draftMatchedPrimaryKeys: [],
                draftMatchedSecondaryKeys: [],
                draftSpans: [],
                stickyTurnsRemaining: 0,
                tokens: tokenCounterFn(snap),
                isMuted: isDirectlyMuted,
                isBoosted: true,
            });
        }
    }

    /**
     * Step 2: Baseline Recursion Pass (without draft)
     * So we accurately know which recursive entries were *already* active from history before typing.
     */
    const shouldRunRecursion = Boolean(globalSettings.recursive || simulateRecursionAlways);
    const configuredMaxSteps = globalSettings.maxRecursionSteps > 0
        ? Math.min(globalSettings.maxRecursionSteps, maxRecursionDepth)
        : maxRecursionDepth;

    if (shouldRunRecursion && configuredMaxSteps > 0) {
        let currentWaveEntries = eligibleEntries.filter(
            (e) => baselineActiveKeys.has(e.entryKey) && !e.preventRecursion && e.content,
        );
        let step = 1;

        while (currentWaveEntries.length > 0 && step <= configuredMaxSteps) {
            const nextWave = [];
            const combinedParentText = currentWaveEntries.map((p) => substituteFn(p.content)).join('\n');

            for (const candidate of eligibleEntries) {
                if (baselineActiveKeys.has(candidate.entryKey)) continue;
                if (candidate.excludeRecursion) continue;
                if (candidate.delayUntilRecursion > 0 && step < candidate.delayUntilRecursion) continue;

                const evalRes = evaluateEntryKeysAgainstBuffer(candidate, combinedParentText, '', globalMatchOpts);
                if (evalRes.triggered) {
                    baselineActiveKeys.add(candidate.entryKey);
                    if (!candidate.preventRecursion && candidate.content) {
                        nextWave.push(candidate);
                    }
                }
            }
            currentWaveEntries = nextWave;
            step++;
        }
    }

    /**
     * Step 3: Draft + History Recursion Graph Pass
     * Tracks exact parent -> child trigger links and propagates parent mutes when `muteBlocksRecursion` is enabled.
     */
    /** @type {Set<string>} */
    const recursiveMutedKeys = new Set();

    if (shouldRunRecursion && configuredMaxSteps > 0) {
        let currentWaveNodes = Array.from(resultsMap.values()).filter(
            (node) => !node.entry.preventRecursion && Boolean(node.entry.content),
        );
        let step = 1;

        while (currentWaveNodes.length > 0 && step <= configuredMaxSteps) {
            const nextWaveNodes = [];

            for (const candidate of eligibleEntries) {
                if (resultsMap.has(candidate.entryKey)) continue;
                if (candidate.excludeRecursion) continue;
                if (candidate.delayUntilRecursion > 0 && step < candidate.delayUntilRecursion) continue;

                const triggeringParents = [];
                const matchedPrimarySet = new Set();
                const matchedSecondarySet = new Set();

                // Test each parent in the current wave individually so we know exact parent->child provenance
                for (const parentNode of currentWaveNodes) {
                    const parentContent = substituteFn(parentNode.entry.content || '');
                    if (!parentContent) continue;

                    const evalRes = evaluateEntryKeysAgainstBuffer(candidate, parentContent, '', globalMatchOpts);
                    if (evalRes.triggered) {
                        triggeringParents.push({
                            entryKey: parentNode.entryKey,
                            world: parentNode.entry.world,
                            uid: parentNode.entry.uid,
                            comment: parentNode.entry.comment,
                            isNewFromDraft: parentNode.isNewFromDraft || parentNode.status === TRIGGER_STATUS.BOOSTED,
                            isMuted: parentNode.isMuted || parentNode.status === TRIGGER_STATUS.MUTED_RECURSIVE,
                            matchedKeys: evalRes.matchedPrimaryKeys,
                        });
                        evalRes.matchedPrimaryKeys.forEach((k) => matchedPrimarySet.add(k));
                        evalRes.matchedSecondaryKeys.forEach((k) => matchedSecondarySet.add(k));
                    }
                }

                if (triggeringParents.length > 0) {
                    const isDirectlyMuted = mutedKeys.has(candidate.entryKey);
                    const allParentsMuted = triggeringParents.every((p) => p.isMuted);
                    const isRecursiveBlockedByMute = !isDirectlyMuted && muteBlocksRecursion && allParentsMuted;

                    if (isRecursiveBlockedByMute) {
                        recursiveMutedKeys.add(candidate.entryKey);
                    }

                    const anyParentNew = triggeringParents.some((p) => p.isNewFromDraft);
                    const wasInBaseline = baselineActiveKeys.has(candidate.entryKey);
                    const isNewRecursive = !wasInBaseline || anyParentNew;

                    let status = TRIGGER_STATUS.ACTIVE_HISTORY_RECURSIVE;
                    if (isDirectlyMuted) {
                        status = TRIGGER_STATUS.MUTED;
                    } else if (isRecursiveBlockedByMute) {
                        status = TRIGGER_STATUS.MUTED_RECURSIVE;
                    } else if (isNewRecursive) {
                        status = TRIGGER_STATUS.NEW_RECURSIVE;
                    }

                    const childNode = {
                        entry: candidate,
                        entryKey: candidate.entryKey,
                        status,
                        isNewFromDraft: isNewRecursive,
                        alsoMatchedInDraft: false,
                        isRecursive: true,
                        recursionStep: step,
                        triggeredByParents: triggeringParents,
                        triggeredChildren: [],
                        matchedPrimaryKeys: Array.from(matchedPrimarySet),
                        matchedSecondaryKeys: Array.from(matchedSecondarySet),
                        draftMatchedPrimaryKeys: [],
                        draftMatchedSecondaryKeys: [],
                        draftSpans: [],
                        stickyTurnsRemaining: 0,
                        tokens: tokenCounterFn(candidate),
                        isMuted: isDirectlyMuted || isRecursiveBlockedByMute,
                        isBoosted: false,
                    };

                    resultsMap.set(candidate.entryKey, childNode);

                    // Link child to its triggering parents
                    for (const pInfo of triggeringParents) {
                        const parentNode = resultsMap.get(pInfo.entryKey);
                        if (parentNode) {
                            parentNode.triggeredChildren.push({
                                entryKey: candidate.entryKey,
                                world: candidate.world,
                                uid: candidate.uid,
                                comment: candidate.comment,
                                tokens: childNode.tokens,
                                matchedKeys: pInfo.matchedKeys,
                            });
                        }
                    }

                    if (!candidate.preventRecursion && candidate.content) {
                        nextWaveNodes.push(childNode);
                    }
                }
            }

            currentWaveNodes = nextWaveNodes;
            step++;
        }
    }

    // Collect all Draft Text Spans for input highlighting
    const allDraftSpans = [];
    for (const item of resultsMap.values()) {
        if (Array.isArray(item.draftSpans) && item.draftSpans.length > 0) {
            for (const sp of item.draftSpans) {
                allDraftSpans.push({
                    start: sp.start,
                    end: sp.end,
                    text: sp.text,
                    key: sp.key,
                    entryKey: item.entryKey,
                    entryComment: item.entry.comment,
                    status: item.status,
                    isNewFromDraft: item.isNewFromDraft,
                    isMuted: item.isMuted,
                });
            }
        }
    }

    // Sort results: Newly triggered direct -> Newly triggered recursive -> Boosted -> Muted -> History/Sticky/Constant
    const statusPriority = {
        [TRIGGER_STATUS.NEW_DIRECT]: 1,
        [TRIGGER_STATUS.NEW_RECURSIVE]: 2,
        [TRIGGER_STATUS.BOOSTED]: 3,
        [TRIGGER_STATUS.MUTED]: 4,
        [TRIGGER_STATUS.MUTED_RECURSIVE]: 5,
        [TRIGGER_STATUS.ACTIVE_HISTORY]: 6,
        [TRIGGER_STATUS.ACTIVE_HISTORY_RECURSIVE]: 7,
        [TRIGGER_STATUS.ACTIVE_STICKY]: 8,
        [TRIGGER_STATUS.ACTIVE_CONSTANT]: 9,
    };

    const allDetected = Array.from(resultsMap.values()).sort((a, b) => {
        const pa = statusPriority[a.status] ?? 99;
        const pb = statusPriority[b.status] ?? 99;
        if (pa !== pb) return pa - pb;
        return (b.tokens || 0) - (a.tokens || 0);
    });

    // Compute token impact summaries
    let newDraftTokens = 0;
    let newDirectCount = 0;
    let newRecursiveCount = 0;
    let mutedSavedTokens = 0;
    let mutedCount = 0;
    let boostedTokens = 0;
    let boostedCount = 0;
    let alreadyActiveTokens = 0;
    let alreadyActiveCount = 0;

    for (const item of allDetected) {
        if (item.status === TRIGGER_STATUS.MUTED || item.status === TRIGGER_STATUS.MUTED_RECURSIVE) {
            mutedCount++;
            mutedSavedTokens += item.tokens;
        } else if (item.status === TRIGGER_STATUS.BOOSTED) {
            boostedCount++;
            boostedTokens += item.tokens;
            newDraftTokens += item.tokens;
        } else if (item.status === TRIGGER_STATUS.NEW_DIRECT) {
            newDirectCount++;
            newDraftTokens += item.tokens;
        } else if (item.status === TRIGGER_STATUS.NEW_RECURSIVE) {
            newRecursiveCount++;
            newDraftTokens += item.tokens;
        } else {
            alreadyActiveCount++;
            alreadyActiveTokens += item.tokens;
        }
    }

    return {
        items: allDetected,
        resultsMap,
        recursiveMutedKeys,
        draftSpans: mergeAndOrderDraftSpans(allDraftSpans),
        summary: {
            newDraftTokens,
            newDirectCount,
            newRecursiveCount,
            newTotalCount: newDirectCount + newRecursiveCount + boostedCount,
            mutedCount,
            mutedSavedTokens,
            boostedCount,
            boostedTokens,
            alreadyActiveCount,
            alreadyActiveTokens,
            totalActiveTokens: newDraftTokens + alreadyActiveTokens,
        },
    };
}

/**
 * Merges overlapping character spans in the draft text while retaining all associated `entryKeys`
 * so hovering an entry badge can spotlight its exact word(s) in `#send_textarea`.
 *
 * @param {Array<{ start: number, end: number, text: string, key: string, entryKey: string, entryComment: string, status: string, isNewFromDraft: boolean, isMuted: boolean }>} rawSpans
 */
export function mergeAndOrderDraftSpans(rawSpans) {
    if (!Array.isArray(rawSpans) || rawSpans.length === 0) return [];

    const sorted = rawSpans
        .filter((s) => s.end > s.start)
        .sort((a, b) => (a.start !== b.start ? a.start - b.start : b.end - a.end));

    const merged = [];
    for (const span of sorted) {
        const last = merged[merged.length - 1];
        if (!last || span.start >= last.end) {
            merged.push({
                start: span.start,
                end: span.end,
                entryKeys: [span.entryKey],
                keys: [span.key],
                hasNew: Boolean(span.isNewFromDraft),
                allMuted: Boolean(span.isMuted),
            });
        } else {
            // Overlapping span: extend end if needed and merge metadata
            last.end = Math.max(last.end, span.end);
            if (!last.entryKeys.includes(span.entryKey)) {
                last.entryKeys.push(span.entryKey);
            }
            if (!last.keys.includes(span.key)) {
                last.keys.push(span.key);
            }
            last.hasNew = last.hasNew || Boolean(span.isNewFromDraft);
            last.allMuted = last.allMuted && Boolean(span.isMuted);
        }
    }

    return merged;
}