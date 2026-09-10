"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveCatalogPath = resolveCatalogPath;
exports.getEntryName = getEntryName;
const path_1 = __importDefault(require("path"));
const utils_1 = require("../api/utils");
function resolveCatalogPath(configOutput, entryPath, rootDir, locale, extension) {
    const entryName = getEntryName(entryPath);
    const entryDir = path_1.default.relative(rootDir, path_1.default.dirname(entryPath));
    return path_1.default.normalize((0, utils_1.replacePlaceholders)(configOutput, {
        entryName,
        entryDir,
        locale,
    }) + extension);
}
function getEntryName(entryPath) {
    const parsedPath = path_1.default.parse(entryPath);
    return parsedPath.name.replace(parsedPath.ext, "");
}
