import { ParserOptions } from "@babel/core";
import { ExtractorType, LinguiConfig, ExtractedMessage, ExtractorCtx } from "@lingui/conf";
export declare const babelRe: RegExp;
/**
 * @public
 *
 * Low level function used in default Lingui extractor.
 * This function setup source maps and lingui plugins needed for
 * extraction process but leaving `parserOptions` up to userland implementation.
 *
 *
 * @example
 * ```ts
 * const extractor: ExtractorType = {
 *   ...
 *   async extract(filename, code, onMessageExtracted, ctx) {
 *     return extractFromFileWithBabel(filename, code, onMessageExtracted, ctx, {
 *       // https://babeljs.io/docs/babel-parser#plugins
 *       plugins: [
 *         "decorators-legacy",
 *         "typescript",
 *         "jsx",
 *       ],
 *     })
 *   },
 * }
 * ```
 */
export declare function extractFromFileWithBabel(filename: string, code: string, onMessageExtracted: (msg: ExtractedMessage) => void, ctx: ExtractorCtx, parserOpts: ParserOptions, skipMacroPlugin?: boolean): Promise<void>;
export declare function getBabelParserOptions(filename: string, parserOptions: LinguiConfig["extractorParserOptions"]): (import("@babel/parser").ParserPluginWithOptions | ("decimal" | "placeholders" | "asyncDoExpressions" | "asyncGenerators" | "bigInt" | "classPrivateMethods" | "classPrivateProperties" | "classProperties" | "classStaticBlock" | "decorators-legacy" | "deferredImportEvaluation" | "decoratorAutoAccessors" | "destructuringPrivate" | "doExpressions" | "dynamicImport" | "explicitResourceManagement" | "exportDefaultFrom" | "exportNamespaceFrom" | "flow" | "flowComments" | "functionBind" | "functionSent" | "importMeta" | "jsx" | "logicalAssignment" | "importAssertions" | "importReflection" | "moduleBlocks" | "moduleStringNames" | "nullishCoalescingOperator" | "numericSeparator" | "objectRestSpread" | "optionalCatchBinding" | "optionalChaining" | "partialApplication" | "privateIn" | "regexpUnicodeSets" | "sourcePhaseImports" | "throwExpressions" | "topLevelAwait" | "v8intrinsic" | "decorators" | "estree" | "importAttributes" | "moduleAttributes" | "optionalChainingAssign" | "pipelineOperator" | "recordAndTuple" | "typescript"))[];
declare const extractor: ExtractorType;
export default extractor;
