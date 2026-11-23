/**
 * Keyword Radar — Pure World Info Keyword, Secondary Filter & Regex Matching Engine
 *
 * Performance Optimizations:
 *  - Bounded compiled RegExp cache (eliminates per-keystroke RegExp recompilation)
 *  - Fast macro guard (skips `substituteParams()` unless keyword actually contains `{{`)
 *  - Pre-lowercased haystack fast path
 */

import { WI_LOGIC } from './constants.js';
import { escapeRegex, parseRegexFromString } from './utils.js';

const MAX_REGEX_CACHE = 600;
const parsedRegexCache = new Map();
const boundaryRegexCache = new Map();

function getCachedParsedRegex(str) {
    if (parsedRegexCache.has(str)) {
        return parsedRegexCache.get(str);
    }
    const compiled = str.startsWith('/') ? parseRegexFromString(str) : null;
    if (parsedRegexCache.size >= MAX_REGEX_CACHE) {
        parsedRegexCache.clear();
    }
    parsedRegexCache.set(str, compiled);
    return compiled;
}

function getCachedBoundaryRegex(normNeedle) {
    if (boundaryRegexCache.has(normNeedle)) {
        return boundaryRegexCache.get(normNeedle);
    }
    const regex = new RegExp(`(?:^|\\W)(${escapeRegex(normNeedle)})(?:$|\\W)`);
    if (boundaryRegexCache.size >= MAX_REGEX_CACHE) {
        boundaryRegexCache.clear();
    }
    boundaryRegexCache.set(normNeedle, regex);
    return regex;
}

function fastSubstitute(rawKey, substituteFn) {
    if (typeof rawKey !== 'string') return '';
    // Avoid calling SillyTavern's macro engine when there are no macros in the keyword
    if (rawKey.indexOf('{{') === -1) return rawKey.trim();
    return String(substituteFn(rawKey) ?? '').trim();
}

export function transformText(str, entry, globalCaseSensitive) {
    const caseSensitive = entry?.caseSensitive ?? globalCaseSensitive;
    return caseSensitive ? String(str ?? '') : String(str ?? '').toLowerCase();
}

/**
 * Test whether a single keyword (plaintext or `/regex/flags`) matches `haystack`.
 */
export function matchKeyword(haystack, needle, entry, globalConfig = {}, lowerHaystack = null) {
    if (!haystack || !needle) return false;
    const trimmed = String(needle).trim();
    if (!trimmed) return false;

    const keyRegex = getCachedParsedRegex(trimmed);
    if (keyRegex) {
        if (keyRegex.global || keyRegex.sticky) keyRegex.lastIndex = 0;
        return keyRegex.test(haystack);
    }

    const caseSensitive = entry?.caseSensitive ?? Boolean(globalConfig.caseSensitive);
    const matchWholeWords = entry?.matchWholeWords ?? Boolean(globalConfig.matchWholeWords);

    const normHaystack = caseSensitive ? haystack : (lowerHaystack ?? haystack.toLowerCase());
    const normNeedle = caseSensitive ? trimmed : trimmed.toLowerCase();

    if (matchWholeWords) {
        if (normNeedle.indexOf(' ') !== -1 || /\s/.test(normNeedle)) {
            return normHaystack.includes(normNeedle);
        }
        return getCachedBoundaryRegex(normNeedle).test(normHaystack);
    }

    return normHaystack.includes(normNeedle);
}

/**
 * Find all exact character spans `{ start, end, text }` where `needle` matches inside `text`.
 */
export function findKeywordSpans(text, needle, entry, globalConfig = {}) {
    const spans = [];
    if (!text || !needle) return spans;
    const trimmed = String(needle).trim();
    if (!trimmed) return spans;

    const parsedRegex = getCachedParsedRegex(trimmed);
    if (parsedRegex) {
        // Strip sticky (`y`) so global span scanning finds all occurrences across the draft
        const baseFlags = parsedRegex.flags.replace(/y/g, '');
        const flags = baseFlags.includes('g') ? baseFlags : `${baseFlags}g`;
        let globalRegex;
        try {
            globalRegex = new RegExp(parsedRegex.source, flags);
        } catch {
            return spans;
        }
        let m;
        let safety = 0;
        while ((m = globalRegex.exec(text)) !== null && safety < 200) {
            safety++;
            if (m[0].length === 0) {
                globalRegex.lastIndex++;
                continue;
            }
            spans.push({
                start: m.index,
                end: m.index + m[0].length,
                text: m[0],
            });
        }
        return spans;
    }

    const caseSensitive = entry?.caseSensitive ?? Boolean(globalConfig.caseSensitive);
    const matchWholeWords = entry?.matchWholeWords ?? Boolean(globalConfig.matchWholeWords);
    const flags = caseSensitive ? 'g' : 'gi';
    const escaped = escapeRegex(trimmed);
    const hasWhitespace = /\s/.test(trimmed);

    if (matchWholeWords && !hasWhitespace) {
        const regex = new RegExp(`(?:^|\\W)(${escaped})(?=$|\\W)`, flags);
        let m;
        let safety = 0;
        while ((m = regex.exec(text)) !== null && safety < 200) {
            safety++;
            const fullMatch = m[0];
            const inner = m[1];
            const innerOffset = fullMatch.length - inner.length;
            const start = m.index + innerOffset;
            spans.push({
                start,
                end: start + inner.length,
                text: text.slice(start, start + inner.length),
            });
            if (regex.lastIndex === m.index) {
                regex.lastIndex++;
            }
        }
        return spans;
    }

    const regex = new RegExp(escaped, flags);
    let m;
    let safety = 0;
    while ((m = regex.exec(text)) !== null && safety < 200) {
        safety++;
        spans.push({
            start: m.index,
            end: m.index + m[0].length,
            text: m[0],
        });
    }
    return spans;
}

/**
 * Evaluate an entry's primary and secondary (selective) keywords against a text buffer.
 */
export function evaluateEntryKeywords(entry, textToScan, globalConfig = {}, substituteFn = (s) => s, lowerTextToScan = null) {
    const primaryKeys = Array.isArray(entry?.key) ? entry.key : [];
    const primaryMatches = [];
    const lowerText = lowerTextToScan ?? (typeof textToScan === 'string' ? textToScan.toLowerCase() : '');

    for (let i = 0; i < primaryKeys.length; i++) {
        const rawKey = primaryKeys[i];
        const substituted = fastSubstitute(rawKey, substituteFn);
        if (!substituted) continue;
        if (matchKeyword(textToScan, substituted, entry, globalConfig, lowerText)) {
            primaryMatches.push({
                raw: rawKey,
                substituted,
                isRegex: Boolean(getCachedParsedRegex(substituted)),
            });
        }
    }

    if (primaryMatches.length === 0) {
        return {
            matched: false,
            primaryMatches: [],
            secondaryMatches: [],
            selectiveLogic: entry?.selectiveLogic ?? WI_LOGIC.AND_ANY,
            hasSecondary: false,
        };
    }

    const secondaryKeys = Array.isArray(entry?.keysecondary)
        ? entry.keysecondary.filter((k) => typeof k === 'string' && k.trim().length > 0)
        : [];
    const hasSecondary = Boolean(entry?.selective) && secondaryKeys.length > 0;
    const selectiveLogic = Number(entry?.selectiveLogic ?? WI_LOGIC.AND_ANY);

    if (!hasSecondary) {
        return {
            matched: true,
            primaryMatches,
            secondaryMatches: [],
            selectiveLogic,
            hasSecondary: false,
        };
    }

    const secondaryMatches = [];
    let hasAnyMatch = false;
    let hasAllMatch = true;

    for (let i = 0; i < secondaryKeys.length; i++) {
        const rawSec = secondaryKeys[i];
        const substituted = fastSubstitute(rawSec, substituteFn);
        if (!substituted) {
            hasAllMatch = false;
            continue;
        }
        const isHit = matchKeyword(textToScan, substituted, entry, globalConfig, lowerText);
        if (isHit) {
            hasAnyMatch = true;
            secondaryMatches.push({
                raw: rawSec,
                substituted,
                isRegex: Boolean(getCachedParsedRegex(substituted)),
            });
        } else {
            hasAllMatch = false;
        }
    }

    let secondaryPassed = false;
    switch (selectiveLogic) {
        case WI_LOGIC.AND_ANY:
            secondaryPassed = hasAnyMatch;
            break;
        case WI_LOGIC.NOT_ALL:
            secondaryPassed = !hasAllMatch;
            break;
        case WI_LOGIC.NOT_ANY:
            secondaryPassed = !hasAnyMatch;
            break;
        case WI_LOGIC.AND_ALL:
            secondaryPassed = hasAllMatch;
            break;
        default:
            secondaryPassed = hasAnyMatch;
            break;
    }

    return {
        matched: secondaryPassed,
        primaryMatches,
        secondaryMatches,
        selectiveLogic,
        hasSecondary: true,
    };
}
