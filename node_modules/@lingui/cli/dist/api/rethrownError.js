"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RethrownError = void 0;
class RethrownError extends Error {
    constructor(message, originalError) {
        super();
        this.message = message + " " + originalError.message;
        this.stack = `Error: ${message} \nOriginal: ` + originalError.stack;
    }
}
exports.RethrownError = RethrownError;
