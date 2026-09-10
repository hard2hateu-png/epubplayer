import * as t from '@babel/types';
import { isJSXEmptyExpression } from '@babel/types';
import { generateMessageId } from '@lingui/message-utils/generateMessageId';

const makeCounter = (index = 0) => () => index++;

const EXTRACT_MARK = "i18n";
var MsgDescriptorPropKey = /* @__PURE__ */ ((MsgDescriptorPropKey2) => {
  MsgDescriptorPropKey2["id"] = "id";
  MsgDescriptorPropKey2["message"] = "message";
  MsgDescriptorPropKey2["comment"] = "comment";
  MsgDescriptorPropKey2["values"] = "values";
  MsgDescriptorPropKey2["components"] = "components";
  MsgDescriptorPropKey2["context"] = "context";
  return MsgDescriptorPropKey2;
})(MsgDescriptorPropKey || {});
var JsMacroName = /* @__PURE__ */ ((JsMacroName2) => {
  JsMacroName2["t"] = "t";
  JsMacroName2["plural"] = "plural";
  JsMacroName2["select"] = "select";
  JsMacroName2["selectOrdinal"] = "selectOrdinal";
  JsMacroName2["msg"] = "msg";
  JsMacroName2["defineMessage"] = "defineMessage";
  JsMacroName2["arg"] = "arg";
  JsMacroName2["useLingui"] = "useLingui";
  JsMacroName2["ph"] = "ph";
  return JsMacroName2;
})(JsMacroName || {});
var JsxMacroName = /* @__PURE__ */ ((JsxMacroName2) => {
  JsxMacroName2["Trans"] = "Trans";
  JsxMacroName2["Plural"] = "Plural";
  JsxMacroName2["Select"] = "Select";
  JsxMacroName2["SelectOrdinal"] = "SelectOrdinal";
  return JsxMacroName2;
})(JsxMacroName || {});

const metaOptions = ["id", "comment", "props"];
const escapedMetaOptionsRe = new RegExp(`^_(${metaOptions.join("|")})$`);
class ICUMessageFormat {
  fromTokens(tokens) {
    return (Array.isArray(tokens) ? tokens : [tokens]).map((token) => this.processToken(token)).filter(Boolean).reduce(
      (props, message) => ({
        ...message,
        message: props.message + message.message,
        values: { ...props.values, ...message.values },
        elements: { ...props.elements, ...message.elements }
      }),
      {
        message: "",
        values: {},
        elements: {}
      }
    );
  }
  processToken(token) {
    const jsxElements = {};
    if (token.type === "text") {
      return {
        message: token.value
      };
    } else if (token.type === "arg") {
      if (token.value !== void 0 && isJSXEmptyExpression(token.value)) {
        return null;
      }
      const values = token.value !== void 0 ? { [token.name]: token.value } : {};
      switch (token.format) {
        case "plural":
        case "select":
        case "selectordinal": {
          const formatOptions = Object.keys(token.options).filter((key) => token.options[key] != null).map((key) => {
            let value = token.options[key];
            key = key.replace(escapedMetaOptionsRe, "$1");
            if (key === "offset") {
              return `offset:${value}`;
            }
            if (typeof value !== "string") {
              const {
                message,
                values: childValues,
                elements: childJsxElements
              } = this.fromTokens(value);
              Object.assign(values, childValues);
              Object.assign(jsxElements, childJsxElements);
              value = message;
            }
            return `${key} {${value}}`;
          }).join(" ");
          return {
            message: `{${token.name}, ${token.format}, ${formatOptions}}`,
            values,
            elements: jsxElements
          };
        }
        default:
          return {
            message: token.raw ? `${token.name}` : `{${token.name}}`,
            values
          };
      }
    } else if (token.type === "element") {
      let message = "";
      const elementValues = {};
      Object.assign(jsxElements, { [token.name]: token.value });
      token.children.forEach((child) => {
        const {
          message: childMessage,
          values: childValues,
          elements: childJsxElements
        } = this.fromTokens(child);
        message += childMessage;
        Object.assign(elementValues, childValues);
        Object.assign(jsxElements, childJsxElements);
      });
      return {
        message: token.children.length ? `<${token.name}>${message}</${token.name}>` : `<${token.name}/>`,
        values: elementValues,
        elements: jsxElements
      };
    }
    throw new Error(`Unknown token type ${token.type}`);
  }
}

function buildICUFromTokens(tokens) {
  const messageFormat = new ICUMessageFormat();
  return messageFormat.fromTokens(tokens);
}
function isObjectProperty(node) {
  return "type" in node;
}
function createMessageDescriptorFromTokens(tokens, oldLoc, stripNonEssentialProps, stripMessageProp, defaults = {}) {
  return createMessageDescriptor(
    buildICUFromTokens(tokens),
    oldLoc,
    stripNonEssentialProps,
    stripMessageProp,
    defaults
  );
}
function createMessageDescriptor(result, oldLoc, stripNonEssentialProps, stripMessageProp, defaults = {}) {
  const { message, values, elements } = result;
  const properties = [];
  properties.push(
    defaults.id ? isObjectProperty(defaults.id) ? defaults.id : createStringObjectProperty(
      MsgDescriptorPropKey.id,
      defaults.id.text,
      defaults.id.loc
    ) : createIdProperty(
      message,
      defaults.context ? isObjectProperty(defaults.context) ? getTextFromExpression(defaults.context.value) : defaults.context.text : null
    )
  );
  if (!stripMessageProp) {
    if (message) {
      properties.push(
        createStringObjectProperty(MsgDescriptorPropKey.message, message)
      );
    }
  }
  if (!stripNonEssentialProps) {
    if (defaults.comment) {
      properties.push(
        isObjectProperty(defaults.comment) ? defaults.comment : createStringObjectProperty(
          MsgDescriptorPropKey.comment,
          defaults.comment.text,
          defaults.comment.loc
        )
      );
    }
    if (defaults.context) {
      properties.push(
        isObjectProperty(defaults.context) ? defaults.context : createStringObjectProperty(
          MsgDescriptorPropKey.context,
          defaults.context.text,
          defaults.context.loc
        )
      );
    }
  }
  if (values) {
    properties.push(createValuesProperty(MsgDescriptorPropKey.values, values));
  }
  if (elements) {
    properties.push(
      createValuesProperty(MsgDescriptorPropKey.components, elements)
    );
  }
  return createMessageDescriptorObjectExpression(
    properties,
    // preserve line numbers for extractor
    oldLoc
  );
}
function createIdProperty(message, context) {
  return createStringObjectProperty(
    MsgDescriptorPropKey.id,
    generateMessageId(message, context)
  );
}
function createValuesProperty(key, values) {
  const valuesObject = Object.keys(values).map(
    (key2) => t.objectProperty(t.identifier(key2), values[key2])
  );
  if (!valuesObject.length)
    return;
  return t.objectProperty(
    t.identifier(key),
    t.objectExpression(valuesObject)
  );
}
function createStringObjectProperty(key, value, oldLoc) {
  const property = t.objectProperty(
    t.identifier(key),
    t.stringLiteral(value)
  );
  if (oldLoc) {
    property.loc = oldLoc;
  }
  return property;
}
function getTextFromExpression(exp) {
  if (t.isStringLiteral(exp)) {
    return exp.value;
  }
  if (t.isTemplateLiteral(exp)) {
    if (exp?.quasis.length === 1) {
      return exp.quasis[0]?.value?.cooked;
    }
  }
}
function createMessageDescriptorObjectExpression(properties, oldLoc) {
  const newDescriptor = t.objectExpression(properties.filter(Boolean));
  t.addComment(newDescriptor, "leading", EXTRACT_MARK);
  if (oldLoc) {
    newDescriptor.loc = oldLoc;
  }
  return newDescriptor;
}

function createMacroJsContext(isLinguiIdentifier2, stripNonEssentialProps, stripMessageProp) {
  return {
    getExpressionIndex: makeCounter(),
    isLinguiIdentifier: isLinguiIdentifier2,
    stripNonEssentialProps,
    stripMessageProp
  };
}
function processDescriptor(descriptor, ctx) {
  const messageProperty = getObjectPropertyByKey(
    descriptor,
    MsgDescriptorPropKey.message
  );
  const idProperty = getObjectPropertyByKey(descriptor, MsgDescriptorPropKey.id);
  const contextProperty = getObjectPropertyByKey(
    descriptor,
    MsgDescriptorPropKey.context
  );
  const commentProperty = getObjectPropertyByKey(
    descriptor,
    MsgDescriptorPropKey.comment
  );
  let tokens = [];
  if (messageProperty) {
    const messageValue = messageProperty.value;
    tokens = t.isTemplateLiteral(messageValue) ? tokenizeTemplateLiteral(messageValue, ctx) : tokenizeNode(messageValue, true, ctx);
  }
  return createMessageDescriptorFromTokens(
    tokens,
    descriptor.loc,
    ctx.stripNonEssentialProps,
    ctx.stripMessageProp,
    {
      id: idProperty,
      context: contextProperty,
      comment: commentProperty
    }
  );
}
function tokenizeNode(node, ignoreExpression = false, ctx) {
  if (isI18nMethod(node, ctx)) {
    return tokenizeTemplateLiteral(node, ctx);
  }
  if (t.isCallExpression(node) && isArgDecorator(node, ctx)) {
    return [tokenizeArg(node, ctx)];
  }
  const choiceMethod = isChoiceMethod(node, ctx);
  if (choiceMethod) {
    return [tokenizeChoiceComponent(node, choiceMethod, ctx)];
  }
  if (t.isStringLiteral(node)) {
    return [
      {
        type: "text",
        value: node.value
      }
    ];
  }
  if (!ignoreExpression) {
    return [tokenizeExpression(node, ctx)];
  }
}
function tokenizeTemplateLiteral(node, ctx) {
  const tpl = t.isTaggedTemplateExpression(node) ? node.quasi : node;
  const expressions = tpl.expressions;
  return tpl.quasis.flatMap((text, i) => {
    const value = text.value.cooked;
    let argTokens = [];
    const currExp = expressions[i];
    if (currExp) {
      argTokens = t.isCallExpression(currExp) ? tokenizeNode(currExp, false, ctx) : [tokenizeExpression(currExp, ctx)];
    }
    const textToken = {
      type: "text",
      value
    };
    return [...value ? [textToken] : [], ...argTokens];
  });
}
function tokenizeChoiceComponent(node, componentName, ctx) {
  const format = componentName.toLowerCase();
  const token = {
    ...tokenizeExpression(node.arguments[0], ctx),
    format,
    options: {
      offset: void 0
    }
  };
  const props = node.arguments[1].properties;
  for (const attr of props) {
    if (!t.isObjectProperty(attr)) {
      throw new Error("Expected an ObjectProperty");
    }
    const key = attr.key;
    const attrValue = attr.value;
    const name = t.isNumericLiteral(key) ? `=${key.value}` : key.name || key.value;
    if (format !== "select" && name === "offset") {
      token.options.offset = attrValue.value;
    } else {
      let value;
      if (t.isTemplateLiteral(attrValue)) {
        value = tokenizeTemplateLiteral(attrValue, ctx);
      } else if (t.isCallExpression(attrValue)) {
        value = tokenizeNode(attrValue, false, ctx);
      } else if (t.isStringLiteral(attrValue)) {
        value = attrValue.value;
      } else if (t.isExpression(attrValue)) {
        value = tokenizeExpression(attrValue, ctx);
      } else {
        value = attrValue.value;
      }
      token.options[name] = value;
    }
  }
  return token;
}
function tokenizeLabeledExpression(node, ctx) {
  if (node.properties.length > 1) {
    throw new Error(
      "Incorrect usage, expected exactly one property as `{variableName: variableValue}`"
    );
  }
  const property = node.properties[0];
  if (t.isProperty(property) && t.isIdentifier(property.key)) {
    return {
      type: "arg",
      name: expressionToArgument(property.key, ctx),
      value: property.value
    };
  } else {
    throw new Error(
      "Incorrect usage of a labeled expression. Expected to have one object property with property key as identifier"
    );
  }
}
function tokenizeExpression(node, ctx) {
  if (t.isTSAsExpression(node)) {
    return tokenizeExpression(node.expression, ctx);
  }
  if (t.isObjectExpression(node)) {
    return tokenizeLabeledExpression(node, ctx);
  } else if (t.isCallExpression(node) && isLinguiIdentifier(node.callee, JsMacroName.ph, ctx) && node.arguments.length > 0) {
    if (!t.isObjectExpression(node.arguments[0])) {
      throw new Error(
        "Incorrect usage of `ph` macro. First argument should be an ObjectExpression"
      );
    }
    return tokenizeLabeledExpression(node.arguments[0], ctx);
  }
  return {
    type: "arg",
    name: expressionToArgument(node, ctx),
    value: node
  };
}
function tokenizeArg(node, ctx) {
  const arg = node.arguments[0];
  return {
    type: "arg",
    name: expressionToArgument(arg, ctx),
    raw: true,
    value: arg
  };
}
function expressionToArgument(exp, ctx) {
  if (t.isIdentifier(exp)) {
    return exp.name;
  }
  return String(ctx.getExpressionIndex());
}
function isArgDecorator(node, ctx) {
  return t.isCallExpression(node) && isLinguiIdentifier(node.callee, JsMacroName.arg, ctx);
}
function isDefineMessage(node, ctx) {
  return isLinguiIdentifier(node, JsMacroName.defineMessage, ctx) || isLinguiIdentifier(node, JsMacroName.msg, ctx);
}
function isI18nMethod(node, ctx) {
  if (!t.isTaggedTemplateExpression(node)) {
    return;
  }
  const tag = node.tag;
  return isLinguiIdentifier(tag, JsMacroName.t, ctx) || t.isCallExpression(tag) && isLinguiIdentifier(tag.callee, JsMacroName.t, ctx);
}
function isLinguiIdentifier(node, name, ctx) {
  if (!t.isIdentifier(node)) {
    return false;
  }
  return ctx.isLinguiIdentifier(node, name);
}
function isChoiceMethod(node, ctx) {
  if (!t.isCallExpression(node)) {
    return;
  }
  if (isLinguiIdentifier(node.callee, JsMacroName.plural, ctx)) {
    return JsMacroName.plural;
  }
  if (isLinguiIdentifier(node.callee, JsMacroName.select, ctx)) {
    return JsMacroName.select;
  }
  if (isLinguiIdentifier(node.callee, JsMacroName.selectOrdinal, ctx)) {
    return JsMacroName.selectOrdinal;
  }
}
function getObjectPropertyByKey(objectExp, key) {
  return objectExp.properties.find(
    (property) => t.isObjectProperty(property) && t.isIdentifier(property.key, {
      name: key
    })
  );
}

export { ICUMessageFormat as I, JsMacroName as J, MsgDescriptorPropKey as M, JsxMacroName as a, createMessageDescriptorFromTokens as b, createMacroJsContext as c, tokenizeTemplateLiteral as d, isLinguiIdentifier as e, tokenizeNode as f, isChoiceMethod as g, isI18nMethod as h, isDefineMessage as i, tokenizeChoiceComponent as j, tokenizeArg as k, isArgDecorator as l, makeCounter as m, createMessageDescriptor as n, createStringObjectProperty as o, processDescriptor as p, tokenizeExpression as t };
