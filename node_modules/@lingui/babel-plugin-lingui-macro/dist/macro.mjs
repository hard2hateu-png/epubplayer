import { createMacro } from 'babel-plugin-macros';
import linguiPlugin from './index.mjs';
import { J as JsMacroName, a as JsxMacroName } from './shared/babel-plugin-lingui-macro.048e39ee.mjs';
import '@babel/types';
import '@lingui/conf';
import '@lingui/message-utils/generateMessageId';

function macro({ state, babel, config }) {
  if (!state.get("linguiProcessed")) {
    state.opts = config;
    const plugin = linguiPlugin(babel);
    const { enter, exit } = plugin.visitor.Program;
    enter(state.file.path, state);
    state.file.path.traverse(plugin.visitor, state);
    exit(state.file.path, state);
    state.set("linguiProcessed", true);
  }
  return { keepImports: true };
}
[
  JsMacroName.defineMessage,
  JsMacroName.msg,
  JsMacroName.t,
  JsMacroName.useLingui,
  JsMacroName.plural,
  JsMacroName.select,
  JsMacroName.selectOrdinal,
  JsxMacroName.Trans,
  JsxMacroName.Plural,
  JsxMacroName.Select,
  JsxMacroName.SelectOrdinal
].forEach((name) => {
  Object.defineProperty(module.exports, name, {
    get() {
      throw new Error(
        `The macro you imported from "@lingui/core/macro" or "@lingui/react/macro" is being executed outside the context of compilation with babel-plugin-macros. This indicates that you don't have the babel plugin "babel-plugin-macros" configured correctly. Please see the documentation for how to configure babel-plugin-macros properly: https://github.com/kentcdodds/babel-plugin-macros/blob/main/other/docs/user.md`
      );
    }
  });
});
const macro$1 = createMacro(macro, {
  configName: "lingui"
});

export { macro$1 as default };
