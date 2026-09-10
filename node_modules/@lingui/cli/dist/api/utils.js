"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.PATHSEP = void 0;
exports.prettyOrigin = prettyOrigin;
exports.replacePlaceholders = replacePlaceholders;
exports.readFile = readFile;
exports.isDirectory = isDirectory;
exports.writeFile = writeFile;
exports.writeFileIfChanged = writeFileIfChanged;
exports.hasYarn = hasYarn;
exports.makeInstall = makeInstall;
exports.normalizeRelativePath = normalizeRelativePath;
exports.makePathRegexSafe = makePathRegexSafe;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const normalize_path_1 = __importDefault(require("normalize-path"));
exports.PATHSEP = "/"; // force posix everywhere
function prettyOrigin(origins) {
    try {
        return origins.map((origin) => origin.join(":")).join(", ");
    }
    catch (e) {
        return "";
    }
}
function replacePlaceholders(input, values) {
    return input.replace(/\{([^}]+)}/g, (m, placeholder) => {
        var _a;
        return (_a = values[placeholder]) !== null && _a !== void 0 ? _a : m;
    });
}
async function readFile(fileName) {
    try {
        return (await fs_1.default.promises.readFile(fileName, "utf-8")).toString();
    }
    catch (err) {
        if (err.code != "ENOENT") {
            throw err;
        }
    }
}
async function mkdirp(dir) {
    try {
        await fs_1.default.promises.mkdir(dir, {
            recursive: true,
        });
    }
    catch (err) {
        if (err.code != "EEXIST") {
            throw err;
        }
    }
}
function isDirectory(filePath) {
    try {
        return fs_1.default.lstatSync(filePath).isDirectory();
    }
    catch (err) {
        if (err.code != "ENOENT") {
            throw err;
        }
    }
}
async function writeFile(fileName, content) {
    await mkdirp(path_1.default.dirname(fileName));
    await fs_1.default.promises.writeFile(fileName, content, "utf-8");
}
async function writeFileIfChanged(filename, newContent) {
    const raw = await readFile(filename);
    if (raw) {
        if (newContent !== raw) {
            await writeFile(filename, newContent);
        }
    }
    else {
        await writeFile(filename, newContent);
    }
}
function hasYarn() {
    return fs_1.default.existsSync(path_1.default.resolve("yarn.lock"));
}
function makeInstall(packageName, dev = false) {
    const withYarn = hasYarn();
    return withYarn
        ? `yarn add ${dev ? "--dev " : ""}${packageName}`
        : `npm install ${dev ? "--save-dev" : "--save"} ${packageName}`;
}
/**
 * Remove ./ at the beginning: ./relative  => relative
 *                             relative    => relative
 * Preserve directories:       ./relative/ => relative/
 * Preserve absolute paths:    /absolute/path => /absolute/path
 */
function normalizeRelativePath(sourcePath) {
    if (path_1.default.isAbsolute(sourcePath)) {
        // absolute path
        return (0, normalize_path_1.default)(sourcePath, false);
    }
    // https://github.com/lingui/js-lingui/issues/809
    const isDir = isDirectory(sourcePath);
    return ((0, normalize_path_1.default)(path_1.default.relative(process.cwd(), sourcePath), false) +
        (isDir ? "/" : ""));
}
/**
 * Escape special regex characters used in file-based routing systems
 */
function makePathRegexSafe(path) {
    return path.replace(/[(){}[\]^$+]/g, "\\$&");
}
