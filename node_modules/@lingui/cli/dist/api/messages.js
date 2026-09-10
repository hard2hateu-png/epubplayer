"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createMissingErrorMessage = createMissingErrorMessage;
exports.createCompilationErrorMessage = createCompilationErrorMessage;
const picocolors_1 = __importDefault(require("picocolors"));
function createMissingErrorMessage(locale, missingMessages, configurationMsg) {
    let message = `Failed to compile catalog for locale ${picocolors_1.default.bold(locale)}!

Missing ${missingMessages.length} translation(s):
\n`;
    missingMessages.forEach((missing) => {
        const source = missing.source || missing.source === missing.id
            ? `: ${missing.source}`
            : "";
        message += `${missing.id}${source}\n`;
    });
    return message;
}
function createCompilationErrorMessage(locale, errors) {
    let message = `Failed to compile catalog for locale ${picocolors_1.default.bold(locale)}!

Compilation error for ${errors.length} translation(s):
\n`;
    errors.forEach((error) => {
        const source = error.source || error.source === error.id ? `: ${error.source}` : "";
        message += `${error.id}${source}\nReason: ${error.error.message}\n\n`;
    });
    return message;
}
