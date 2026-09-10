import { CatalogFormatter, CatalogType } from "@lingui/conf";
export declare class FormatterWrapper {
    private f;
    private sourceLocale;
    constructor(f: CatalogFormatter, sourceLocale: string);
    getCatalogExtension(): string;
    getTemplateExtension(): string;
    write(filename: string, catalog: CatalogType, locale: string): Promise<void>;
    read(filename: string, locale: string): Promise<CatalogType | null>;
}
