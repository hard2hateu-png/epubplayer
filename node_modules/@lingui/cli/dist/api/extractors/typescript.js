"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const extractor = {
    match(filename) {
        throw new Error("Typescript extractor was removed. " +
            "Lingui CLI can parse typescript out of the box. " +
            "Please remove it from your lingui.config.js");
    },
    extract() { },
};
exports.default = extractor;
