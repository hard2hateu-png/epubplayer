"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveTemplatePath = resolveTemplatePath;
const resolveCatalogPath_1 = require("./resolveCatalogPath");
const constants_1 = require("./constants");
function resolveTemplatePath(entryPoint, output, rootDir, catalogExtension) {
    let templateName;
    if (output.includes(constants_1.ENTRY_NAME_PH)) {
        templateName = constants_1.DEFAULT_TEMPLATE_NAME;
    }
    else {
        templateName = (0, resolveCatalogPath_1.getEntryName)(entryPoint);
    }
    return (0, resolveCatalogPath_1.resolveCatalogPath)(output, entryPoint, rootDir, templateName, catalogExtension);
}
