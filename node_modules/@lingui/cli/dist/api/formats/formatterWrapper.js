"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.FormatterWrapper = void 0;
const utils_1 = require("../utils");
const rethrownError_1 = require("../rethrownError");
class FormatterWrapper {
    constructor(f, sourceLocale) {
        this.f = f;
        this.sourceLocale = sourceLocale;
    }
    getCatalogExtension() {
        return this.f.catalogExtension;
    }
    getTemplateExtension() {
        return this.f.templateExtension || this.f.catalogExtension;
    }
    async write(filename, catalog, locale) {
        const content = await this.f.serialize(catalog, {
            locale,
            sourceLocale: this.sourceLocale,
            existing: await (0, utils_1.readFile)(filename),
            filename,
        });
        await (0, utils_1.writeFileIfChanged)(filename, content);
    }
    async read(filename, locale) {
        const content = await (0, utils_1.readFile)(filename);
        if (!content) {
            return null;
        }
        try {
            return this.f.parse(content, {
                locale,
                sourceLocale: this.sourceLocale,
                filename,
            });
        }
        catch (e) {
            throw new rethrownError_1.RethrownError(`Cannot read ${filename}`, e);
        }
    }
}
exports.FormatterWrapper = FormatterWrapper;
