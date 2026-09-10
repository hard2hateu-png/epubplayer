"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getCatalogDependentFiles = getCatalogDependentFiles;
const getFallbackListForLocale_1 = require("./getFallbackListForLocale");
const promises_1 = __importDefault(require("node:fs/promises"));
const node_path_1 = __importDefault(require("node:path"));
const process = __importStar(require("process"));
const fileExists = async (path) => !!(await promises_1.default.stat(path).catch(() => false));
/**
 * Return all files catalog implicitly depends on.
 */
async function getCatalogDependentFiles(catalog, locale) {
    const files = new Set([catalog.templateFile]);
    (0, getFallbackListForLocale_1.getFallbackListForLocale)(catalog.config.fallbackLocales, locale).forEach((locale) => {
        files.add(catalog.getFilename(locale));
    });
    if (catalog.config.sourceLocale && locale !== catalog.config.sourceLocale) {
        files.add(catalog.getFilename(catalog.config.sourceLocale));
    }
    const out = [];
    for (let file of files) {
        file = node_path_1.default.isAbsolute(file) ? file : node_path_1.default.join(process.cwd(), file);
        if (await fileExists(file)) {
            out.push(file);
        }
    }
    return out;
}
