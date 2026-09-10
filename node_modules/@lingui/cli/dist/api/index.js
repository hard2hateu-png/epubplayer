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
var __exportStar = (this && this.__exportStar) || function(m, exports) {
    for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports, p)) __createBinding(exports, m, p);
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createCompilationErrorMessage = exports.createMissingErrorMessage = exports.getCatalogDependentFiles = exports.extractFromFileWithBabel = exports.extractor = exports.createCompiledCatalog = exports.getCatalogs = exports.getCatalogForFile = exports.getFormat = void 0;
var formats_1 = require("./formats");
Object.defineProperty(exports, "getFormat", { enumerable: true, get: function () { return formats_1.getFormat; } });
var getCatalogs_1 = require("./catalog/getCatalogs");
Object.defineProperty(exports, "getCatalogForFile", { enumerable: true, get: function () { return getCatalogs_1.getCatalogForFile; } });
Object.defineProperty(exports, "getCatalogs", { enumerable: true, get: function () { return getCatalogs_1.getCatalogs; } });
var compile_1 = require("./compile");
Object.defineProperty(exports, "createCompiledCatalog", { enumerable: true, get: function () { return compile_1.createCompiledCatalog; } });
var babel_1 = require("./extractors/babel");
Object.defineProperty(exports, "extractor", { enumerable: true, get: function () { return __importDefault(babel_1).default; } });
Object.defineProperty(exports, "extractFromFileWithBabel", { enumerable: true, get: function () { return babel_1.extractFromFileWithBabel; } });
var getCatalogDependentFiles_1 = require("./catalog/getCatalogDependentFiles");
Object.defineProperty(exports, "getCatalogDependentFiles", { enumerable: true, get: function () { return getCatalogDependentFiles_1.getCatalogDependentFiles; } });
var messages_1 = require("./messages");
Object.defineProperty(exports, "createMissingErrorMessage", { enumerable: true, get: function () { return messages_1.createMissingErrorMessage; } });
Object.defineProperty(exports, "createCompilationErrorMessage", { enumerable: true, get: function () { return messages_1.createCompilationErrorMessage; } });
__exportStar(require("./types"), exports);
