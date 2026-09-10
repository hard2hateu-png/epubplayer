import * as babelTypes from '@babel/types';
import { Expression, SourceLocation, ObjectProperty, ObjectExpression, Identifier, Node, CallExpression } from '@babel/types';

type ParsedResult = {
    message: string;
    values?: Record<string, Expression>;
    elements?: Record<string, any>;
};
type TextToken = {
    type: "text";
    value: string;
};
type ArgToken = {
    type: "arg";
    value: Expression;
    name?: string;
    raw?: boolean;
    /**
     * plural
     * select
     * selectordinal
     */
    format?: string;
    options?: {
        offset: string;
        [icuChoice: string]: string | Tokens;
    };
};
type ElementToken = {
    type: "element";
    value: any;
    name?: string | number;
    children?: Token[];
};
type Tokens = Token | Token[];
type Token = TextToken | ArgToken | ElementToken;
declare class ICUMessageFormat {
    fromTokens(tokens: Tokens): ParsedResult;
    processToken(token: Token): ParsedResult;
}

type TextWithLoc = {
    text: string;
    loc?: SourceLocation;
};
declare function createMessageDescriptorFromTokens(tokens: Tokens, oldLoc: SourceLocation, stripNonEssentialProps: boolean, stripMessageProp: boolean, defaults?: {
    id?: TextWithLoc | ObjectProperty;
    context?: TextWithLoc | ObjectProperty;
    comment?: TextWithLoc | ObjectProperty;
}): ObjectExpression;
declare function createMessageDescriptor(result: Partial<ParsedResult>, oldLoc: SourceLocation, stripNonEssentialProps: boolean, stripMessageProp: boolean, defaults?: {
    id?: TextWithLoc | ObjectProperty;
    context?: TextWithLoc | ObjectProperty;
    comment?: TextWithLoc | ObjectProperty;
}): ObjectExpression;
declare function createStringObjectProperty(key: string, value: string, oldLoc?: SourceLocation): ObjectProperty;

declare enum JsMacroName {
    t = "t",
    plural = "plural",
    select = "select",
    selectOrdinal = "selectOrdinal",
    msg = "msg",
    defineMessage = "defineMessage",
    arg = "arg",
    useLingui = "useLingui",
    ph = "ph"
}

type MacroJsContext = {
    getExpressionIndex: () => number;
    stripNonEssentialProps: boolean;
    stripMessageProp: boolean;
    isLinguiIdentifier: (node: Identifier, macro: JsMacroName) => boolean;
};
declare function createMacroJsContext(isLinguiIdentifier: MacroJsContext["isLinguiIdentifier"], stripNonEssentialProps: boolean, stripMessageProp: boolean): MacroJsContext;
/**
 * `processDescriptor` expand macros inside message descriptor.
 * Message descriptor is used in `defineMessage`.
 *
 * {
 *   comment: "Description",
 *   message: plural("value", { one: "book", other: "books" })
 * }
 *
 * ↓ ↓ ↓ ↓ ↓ ↓
 *
 * {
 *   comment: "Description",
 *   id: <hash>
 *   message: "{value, plural, one {book} other {books}}"
 * }
 *
 */
declare function processDescriptor(descriptor: ObjectExpression, ctx: MacroJsContext): babelTypes.ObjectExpression;
declare function tokenizeNode(node: Node, ignoreExpression: boolean, ctx: MacroJsContext): Token[];
/**
 * `node` is a TemplateLiteral. node.quasi contains
 * text chunks and node.expressions contains expressions.
 * Both arrays must be zipped together to get the final list of tokens.
 */
declare function tokenizeTemplateLiteral(node: Expression, ctx: MacroJsContext): Token[];
declare function tokenizeChoiceComponent(node: CallExpression, componentName: string, ctx: MacroJsContext): ArgToken;
declare function tokenizeExpression(node: Node | Expression, ctx: MacroJsContext): ArgToken;
declare function tokenizeArg(node: CallExpression, ctx: MacroJsContext): ArgToken;
declare function isArgDecorator(node: Node, ctx: MacroJsContext): boolean;
declare function isDefineMessage(node: Node, ctx: MacroJsContext): boolean;
declare function isI18nMethod(node: Node, ctx: MacroJsContext): boolean;
declare function isLinguiIdentifier(node: Node, name: JsMacroName, ctx: MacroJsContext): boolean;
declare function isChoiceMethod(node: Node, ctx: MacroJsContext): JsMacroName.plural | JsMacroName.select | JsMacroName.selectOrdinal;

export { type ArgToken, type ElementToken, ICUMessageFormat, JsMacroName, type MacroJsContext, type ParsedResult, type TextToken, type Token, type Tokens, createMacroJsContext, createMessageDescriptor, createMessageDescriptorFromTokens, createStringObjectProperty, isArgDecorator, isChoiceMethod, isDefineMessage, isI18nMethod, isLinguiIdentifier, processDescriptor, tokenizeArg, tokenizeChoiceComponent, tokenizeExpression, tokenizeNode, tokenizeTemplateLiteral };
