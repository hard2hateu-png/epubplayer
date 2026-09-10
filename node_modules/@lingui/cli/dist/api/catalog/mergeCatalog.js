"use strict";
var __rest = (this && this.__rest) || function (s, e) {
    var t = {};
    for (var p in s) if (Object.prototype.hasOwnProperty.call(s, p) && e.indexOf(p) < 0)
        t[p] = s[p];
    if (s != null && typeof Object.getOwnPropertySymbols === "function")
        for (var i = 0, p = Object.getOwnPropertySymbols(s); i < p.length; i++) {
            if (e.indexOf(p[i]) < 0 && Object.prototype.propertyIsEnumerable.call(s, p[i]))
                t[p[i]] = s[p[i]];
        }
    return t;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.mergeCatalog = mergeCatalog;
function mergeCatalog(prevCatalog, nextCatalog, forSourceLocale, options) {
    const nextKeys = Object.keys(nextCatalog);
    const prevKeys = Object.keys(prevCatalog || {});
    const newKeys = nextKeys.filter((key) => !prevKeys.includes(key));
    const mergeKeys = nextKeys.filter((key) => prevKeys.includes(key));
    const obsoleteKeys = prevKeys.filter((key) => !nextKeys.includes(key));
    // Initialize new catalog with new keys
    const newMessages = Object.fromEntries(newKeys.map((key) => [
        key,
        Object.assign({ translation: forSourceLocale ? nextCatalog[key].message || key : "" }, nextCatalog[key]),
    ]));
    // Merge translations from previous catalog
    const mergedMessages = Object.fromEntries(mergeKeys.map((key) => {
        const updateFromDefaults = forSourceLocale &&
            (prevCatalog[key].translation === prevCatalog[key].message ||
                options.overwrite);
        const translation = updateFromDefaults
            ? nextCatalog[key].message || key
            : prevCatalog[key].translation;
        const _a = nextCatalog[key], { obsolete } = _a, rest = __rest(_a, ["obsolete"]);
        return [key, Object.assign(Object.assign({}, rest), { translation })];
    }));
    // Mark all remaining translations as obsolete
    // Only if *options.files* is not provided
    const obsoleteMessages = Object.fromEntries(obsoleteKeys.map((key) => [
        key,
        Object.assign(Object.assign({}, prevCatalog[key]), (options.files ? {} : { obsolete: true })),
    ]));
    return Object.assign(Object.assign(Object.assign({}, newMessages), mergedMessages), obsoleteMessages);
}
