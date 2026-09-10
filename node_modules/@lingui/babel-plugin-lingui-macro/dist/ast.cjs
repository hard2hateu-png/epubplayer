'use strict';

const ast = require('./shared/babel-plugin-lingui-macro.b7bd8916.cjs');
require('@babel/types');
require('@lingui/message-utils/generateMessageId');



exports.ICUMessageFormat = ast.ICUMessageFormat;
exports.JsMacroName = ast.JsMacroName;
exports.createMacroJsContext = ast.createMacroJsContext;
exports.createMessageDescriptor = ast.createMessageDescriptor;
exports.createMessageDescriptorFromTokens = ast.createMessageDescriptorFromTokens;
exports.createStringObjectProperty = ast.createStringObjectProperty;
exports.isArgDecorator = ast.isArgDecorator;
exports.isChoiceMethod = ast.isChoiceMethod;
exports.isDefineMessage = ast.isDefineMessage;
exports.isI18nMethod = ast.isI18nMethod;
exports.isLinguiIdentifier = ast.isLinguiIdentifier;
exports.processDescriptor = ast.processDescriptor;
exports.tokenizeArg = ast.tokenizeArg;
exports.tokenizeChoiceComponent = ast.tokenizeChoiceComponent;
exports.tokenizeExpression = ast.tokenizeExpression;
exports.tokenizeNode = ast.tokenizeNode;
exports.tokenizeTemplateLiteral = ast.tokenizeTemplateLiteral;
