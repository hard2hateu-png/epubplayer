"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getExperimentalCatalogs = getExperimentalCatalogs;
const getEntryPoints_1 = require("./getEntryPoints");
const resolveCatalogPath_1 = require("./resolveCatalogPath");
const catalog_1 = require("../api/catalog");
const resolveTemplatePath_1 = require("./resolveTemplatePath");
const formats_1 = require("../api/formats");
async function getExperimentalCatalogs(linguiConfig) {
    const config = linguiConfig.experimental.extractor;
    const entryPoints = (0, getEntryPoints_1.getEntryPoints)(config.entries);
    const format = await (0, formats_1.getFormat)(linguiConfig.format, linguiConfig.formatOptions, linguiConfig.sourceLocale);
    return entryPoints.map((entryPoint) => {
        const catalogPath = (0, resolveCatalogPath_1.resolveCatalogPath)(config.output, entryPoint, linguiConfig.rootDir, undefined, "");
        const templatePath = (0, resolveTemplatePath_1.resolveTemplatePath)(entryPoint, config.output, linguiConfig.rootDir, format.getTemplateExtension());
        return new catalog_1.Catalog({
            name: undefined,
            path: catalogPath,
            templatePath,
            include: [],
            exclude: [],
            format,
        }, linguiConfig);
    });
}
