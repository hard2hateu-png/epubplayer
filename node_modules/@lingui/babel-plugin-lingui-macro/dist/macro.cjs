'use strict';

const babelPluginMacros = require('babel-plugin-macros');
const index = require('./index.cjs');
const ast = require('./shared/babel-plugin-lingui-macro.b7bd8916.cjs');
require('@babel/types');
require('@lingui/conf');
require('@lingui/message-utils/generateMessageId');

function macro({ state, babel, config }) {
  if (!state.get("linguiProcessed")) {
    state.opts = config;
    const plugin = index(babel);
    const { enter, exit } = plugin.visitor.Program;
    enter(state.file.path, state);
    state.file.path.traverse(plugin.visitor, state);
    exit(state.file.path, state);
    state.set("linguiProcessed", true);
  }
  return { keepImports: true };
}
[
  ast.JsMacroName.defineMessage,
  ast.JsMacroName.msg,
  ast.JsMacroName.t,
  ast.JsMacroName.useLingui,
  ast.JsMacroName.plural,
  ast.JsMacroName.select,
  ast.JsMacroName.selectOrdinal,
  ast.JsxMacroName.Trans,
  ast.JsxMacroName.Plural,
  ast.JsxMacroName.Select,
  ast.JsxMacroName.SelectOrdinal
].forEach((name) => {
  Object.defineProperty(module.exports, name, {
    get() {
      throw new Error(
        `The macro you imported from "@lingui/core/macro" or "@lingui/react/macro" is being executed outside the context of compilation with babel-plugin-macros. This indicates that you don't have the babel plugin "babel-plugin-macros" configured correctly. Please see the documentation for how to configure babel-plugin-macros properly: https://github.com/kentcdodds/babel-plugin-macros/blob/main/other/docs/user.md`
      );
    }
  });
});
const macro$1 = babelPluginMacros.createMacro(macro, {
  configName: "lingui"
});

module.exports = macro$1;
