"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.FormatterWrapper = void 0;
exports.getFormat = getFormat;
const formatterWrapper_1 = require("./formatterWrapper");
Object.defineProperty(exports, "FormatterWrapper", { enumerable: true, get: function () { return formatterWrapper_1.FormatterWrapper; } });
const utils_1 = require("../utils");
function createDeprecationError(packageName, format, installCode) {
    const installCmd = (0, utils_1.makeInstall)(packageName);
    return `
Format \`${format}\` is no longer included in \`@lingui/cli\` by default.
You need to install it using ${installCmd} command and add to your \`lingui.config.{js,ts}\`:
        
import { formatter } from "${packageName}"

export default {
  [...]
  format: ${installCode}
}
`.trim();
}
// Introduced in v4. Remove this deprecation in v5
const formats = {
    lingui: async () => {
        throw new Error(createDeprecationError("@lingui/format-json", "lingui", 'formatter({style: "lingui"})'));
    },
    minimal: async () => {
        throw new Error(createDeprecationError("@lingui/format-json", "minimal", 'formatter({style: "minimal"})'));
    },
    po: async () => (await import("@lingui/format-po")).formatter,
    csv: async () => {
        throw new Error(createDeprecationError("@lingui/format-csv", "csv", "formatter()"));
    },
    "po-gettext": async () => {
        throw new Error(createDeprecationError("@lingui/format-po-gettext", "po-gettext", "formatter()"));
    },
};
async function getFormat(_format, options, sourceLocale) {
    if (typeof _format !== "string") {
        return new formatterWrapper_1.FormatterWrapper(_format, sourceLocale);
    }
    const format = formats[_format];
    if (!format) {
        throw new Error(`Unknown format "${_format}". Use one of following: ${Object.keys(formats).join(", ")}`);
    }
    return new formatterWrapper_1.FormatterWrapper((await format())(options), sourceLocale);
}
