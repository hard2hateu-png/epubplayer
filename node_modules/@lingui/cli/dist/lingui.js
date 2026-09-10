#!/usr/bin/env node
"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const commander_1 = require("commander");
const node_fs_1 = require("node:fs");
const node_path_1 = __importDefault(require("node:path"));
const packageJson = JSON.parse((0, node_fs_1.readFileSync)(node_path_1.default.resolve(__dirname, "../package.json"), "utf8"));
commander_1.program
    .version(packageJson.version)
    .command("extract [files...]", "Extracts messages from source files")
    .command("extract-experimental", "Extracts messages from source files traversing dependency tree")
    .command("extract-template", "Extracts messages from source files to a .pot template")
    .command("compile", "Compile message catalogs")
    .parse(process.argv);
