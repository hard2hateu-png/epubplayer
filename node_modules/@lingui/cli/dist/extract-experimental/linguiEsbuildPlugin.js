"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.pluginLinguiMacro = void 0;
const core_1 = require("@babel/core");
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const babel_1 = require("../api/extractors/babel");
const babel_plugin_lingui_macro_1 = __importDefault(require("@lingui/babel-plugin-lingui-macro"));
const pluginLinguiMacro = (options) => ({
    name: "linguiMacro",
    setup(build) {
        build.onLoad({ filter: babel_1.babelRe, namespace: "" }, async (args) => {
            const filename = path_1.default.relative(process.cwd(), args.path);
            const contents = await fs_1.default.promises.readFile(args.path, "utf8");
            const hasMacroRe = /from ["']@lingui(\/.+)?\/macro["']/g;
            if (!hasMacroRe.test(contents)) {
                // let esbuild process file as usual
                return undefined;
            }
            const result = await (0, core_1.transformAsync)(contents, {
                babelrc: false,
                configFile: false,
                filename: filename,
                sourceMaps: "inline",
                parserOpts: {
                    plugins: (0, babel_1.getBabelParserOptions)(filename, options.linguiConfig.extractorParserOptions),
                },
                plugins: [
                    [
                        babel_plugin_lingui_macro_1.default,
                        {
                            extract: true,
                            linguiConfig: options.linguiConfig,
                        },
                    ],
                ],
            });
            return { contents: result.code, loader: "tsx" };
        });
    },
});
exports.pluginLinguiMacro = pluginLinguiMacro;
