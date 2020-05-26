import { UserConfig, AbbreviationContext, CSSAbbreviationScope } from 'emmet';
import { getCSSContext, getHTMLContext, CSSContext, HTMLContext } from '@emmetio/action-utils';
import { attributes } from '@emmetio/html-matcher';
import { TokenType } from '@emmetio/css-matcher';
import AbbreviationTracker, { handleChange, stopTracking, startTracking } from './AbbreviationTracker';
import { isSupported, isJSX, isCSS, isHTML, docSyntax, isXML } from '../lib/syntax';
import { getCaret, substr, getContent, attributeValue } from '../lib/utils';
import { JSX_PREFIX, extract } from '../lib/emmet';
import getOutputOptions from '../lib/output';

export { getTracker } from './AbbreviationTracker';
export { AbbreviationTracker };

const tabStop = String.fromCodePoint(0xFFFC);
const reJSXAbbrStart = /^[a-zA-Z.#\[\(]$/;
const reWordBound = /^[\s>;"\']?[a-zA-Z.#!@\[\(]$/;
const reStylesheetWordBound = /^[\s;]?[a-zA-Z!@]$/;
const pairs = {
    '{': '}',
    '[': ']',
    '(': ')'
};

const pairsEnd: string[] = [];
for (const key of Object.keys(pairs)) {
    pairsEnd.push(pairs[key]);
}

nova.commands.register('emmet.clear-marker', stopTracking);

export default function initAbbreviationTracker(editor: TextEditor) {
    let lastPos: number | null = null;
    const disposable = new CompositeDisposable();
    disposable.add(editor.onDidChange(ed => {
        const pos = getCaret(ed);
        let tracker = handleChange(ed);

        if (!tracker && lastPos !== null && lastPos === pos - 1 && allowTracking(ed, pos)) {
            tracker = startAbbreviationTracking(ed, pos);
        }

        if (tracker && shouldStopTracking(tracker, pos)) {
            stopTracking(ed);
        }

        lastPos = pos;
    }));

    disposable.add(editor.onDidChangeSelection(ed => {
        if (isEnabled()) {
            lastPos = getCaret(ed);
        }
    }));

    disposable.add(editor.onDidDestroy(stopTracking));

    return disposable;
}

/**
 * Check if abbreviation tracking is allowed in editor at given location
 */
function allowTracking(editor: TextEditor, pos: number): boolean {
    if (isEnabled()) {
        const syntax = docSyntax(editor);
        return isSupported(syntax) || isJSX(syntax);
    }

    return false;
}

/**
 * Check if Emmet abbreviation tracking is enabled
 */
export function isEnabled(): boolean {
    return nova.config.get('emmet.enable-completions', 'boolean')!;
}

/**
 * If allowed, tries to extract abbreviation from given completion context
 */
export function extractTracker(editor: TextEditor, ctx: CompletionContext): AbbreviationTracker | undefined {
    const { syntax } = editor.document;
    const prefix = isJSX(syntax) ? JSX_PREFIX : ''
    const abbr = extract(getContent(editor), ctx.position, syntax, { prefix });
    if (abbr) {
        return startTracking(editor, abbr.start, abbr.end, {
            offset: prefix.length,
            options: getActivationContext(editor, abbr.start + 1)
        });
    }
}

/**
 * Check if we can start abbreviation tracking at given location in editor
 */
function startAbbreviationTracking(editor: TextEditor, pos: number): AbbreviationTracker | undefined {
    // Start tracking only if user starts abbreviation typing: entered first
    // character at the word bound
    // NB: get last 2 characters: first should be a word bound(or empty),
    // second must be abbreviation start
    const prefix = substr(editor, [Math.max(0, pos - 2), pos]);
    const syntax = docSyntax(editor);
    let start = -1
    let end = pos;
    let offset = 0;

    if (isJSX(syntax)) {
        // In JSX, abbreviations should be prefixed
        if (prefix.length === 2 && prefix[0] === JSX_PREFIX && reJSXAbbrStart.test(prefix[1])) {
            start = pos - 2;
            offset = JSX_PREFIX.length;
        }
    } else if (reWordBound.test(prefix)) {
        start = pos - 1;
    }

    if (start >= 0) {
        // Check if there’s paired character
        const lastCh = prefix[prefix.length - 1];
        if (lastCh in pairs && substr(editor, [pos, pos + 1]) === pairs[lastCh]) {
            end++;
        }

        const options = getActivationContext(editor, pos);
        if (options) {
            if (options.type === 'stylesheet' && !reStylesheetWordBound.test(prefix)) {
                // Additional check for stylesheet abbreviation start: it’s slightly
                // differs from markup prefix, but we need activation context
                // to ensure that context under caret is CSS
                return;
            }

            return startTracking(editor, start, end, { offset, options });
        }
    }
}

/**
 * Check if we should stop tracking abbreviation in given editor
 */
function shouldStopTracking(tracker: AbbreviationTracker, pos: number): boolean {
    if (tracker.forced) {
        // Never reset forced abbreviation: it’s up to user how to handle it
        return false;
    }

    if (!tracker.abbreviation) {
        return true;
    }

    const { abbr } = tracker.abbreviation;

    if (/[\r\n]/.test(abbr) || abbr.includes(tabStop)) {
        // — Never allow new lines in auto-tracked abbreviation
        // – Stop if abbreviation contains tab-stop (expanded abbreviation)
        return true;
    }

    // Reset if user entered invalid character at the end of abbreviation
    // or at the edge of auto-inserted paired character like`)` or`]`
    if (tracker.abbreviation.type === 'error') {
        if (tracker.range[1] === pos) {
            // Last entered character is invalid
            return true;
        }

        if (tracker.abbreviation.error.pos === 0) {
            // Most likely it’s an expanded abbreviation
            return true;
        }

        const start = tracker.range[0];
        let targetPos = tracker.range[1];
        while (targetPos > start) {
            if (pairsEnd.includes(abbr[targetPos - start - 1])) {
                targetPos--;
            } else {
                break;
            }
        }

        return targetPos === pos;
    }

    return false;
}

/**
 * Detects and returns valid abbreviation activation context for given location
 * in editor which can be used for abbreviation expanding.
 * For example, in given HTML code:
 * `<div title="Sample" style="">Hello world</div>`
 * it’s not allowed to expand abbreviations inside `<div ...>` or `</div>`,
 * yet it’s allowed inside `style` attribute and between tags.
 *
 * This method ensures that given `pos` is inside location allowed for expanding
 * abbreviations and returns context data about it
 */
function getActivationContext(editor: TextEditor, pos: number): UserConfig | undefined {
    const syntax = docSyntax(editor);

    if (isCSS(syntax)) {
        return getCSSActivationContext(editor, pos, syntax, getCSSContext(getContent(editor), pos));
    }

    if (isHTML(syntax)) {
        const content = getContent(editor);
        const ctx = getHTMLContext(content, pos, { xml: isXML(syntax) });
        if (ctx.css) {
            return getCSSActivationContext(editor, pos, getEmbeddedStyleSyntax(content, ctx) || syntax, ctx.css);
        }

        if (!ctx.current) {
            return {
                syntax,
                type: 'markup',
                context: getMarkupAbbreviationContext(content, ctx),
                options: getOutputOptions(editor, pos)
            };
        }
    }
}

function getCSSActivationContext(editor: TextEditor, pos: number, syntax: string, ctx: CSSContext): UserConfig | undefined {
    // CSS abbreviations can be activated only when a character is entered, e.g.
    // it should be either property name or value.
    // In come cases, a first character of selector should also be considered
    // as activation context
    if (!ctx.current) {
        return void 0;
    }

    const allowedContext = ctx.current.type === TokenType.PropertyName
        || ctx.current.type === TokenType.PropertyValue
        || isTypingBeforeSelector(editor, pos, ctx);

    if (allowedContext) {
        return {
            syntax,
            type: 'stylesheet',
            context: {
                name: getCSSAbbreviationContext(ctx)
            },
            options: getOutputOptions(editor, pos, ctx.inline)
        };
    }
}

function getCSSAbbreviationContext(ctx: CSSContext): string {
    const parent = last(ctx.ancestors);
    if (ctx.current) {
        if (ctx.current.type === TokenType.PropertyValue && parent) {
            return parent.name;
        }

        if (ctx.current.type === TokenType.Selector && !parent) {
            return CSSAbbreviationScope.Section;
        }
    }

    return CSSAbbreviationScope.Global;
}

/**
 * Handle edge case: start typing abbreviation before selector. In this case,
 * entered character becomes part of selector
 * Activate only if it’s a nested section and it’s a first character of selector
 */
function isTypingBeforeSelector(editor: TextEditor, pos: number, { current }: CSSContext): boolean {
    if (current && current.type === TokenType.Selector && current.range[0] === pos - 1) {
        // Typing abbreviation before selector is tricky one:
        // ensure it’s on its own line
        const line = substr(editor, current.range).split(/[\n\r]/)[0];
        return line.trim().length === 1;
    }

    return false;
}

function getMarkupAbbreviationContext(code: string, ctx: HTMLContext): AbbreviationContext | undefined {
    const parent = last(ctx.ancestors);
    if (parent) {
        const attrs: { [name: string]: string } = {};
        for (const attr of attributes(code.slice(parent.range[0], parent.range[1]), parent.name)) {
            attrs[attr.name] = attributeValue(attr) || '';
        }

        return {
            name: parent.name,
            attributes: attrs
        };
    }
}

/**
 * Returns embedded style syntax, if any
 */
function getEmbeddedStyleSyntax(code: string, ctx: HTMLContext): string | undefined {
    const parent = last(ctx.ancestors);
    if (parent && parent.name === 'style') {
        for (const attr of attributes(code.slice(parent.range[0], parent.range[1]), parent.name)) {
            if (attr.name === 'type') {
                return attributeValue(attr);
            }
        }
    }
}

function last<T>(arr: T[]): T | undefined {
    return arr.length > 0 ? arr[arr.length - 1] : undefined;
}
