"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getEntryPoints = getEntryPoints;
const glob_1 = require("glob");
function getEntryPoints(entries) {
    return (0, glob_1.globSync)(entries, { mark: true });
}
