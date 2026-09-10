import { ExtractedCatalogType } from "../api";
import { LinguiConfigNormalized } from "@lingui/conf";
import { FormatterWrapper } from "../api/formats";
type ExtractTemplateParams = {
    format: FormatterWrapper;
    clean: boolean;
    entryPoint: string;
    outputPattern: string;
    linguiConfig: LinguiConfigNormalized;
    messages: ExtractedCatalogType;
};
type ExtractParams = ExtractTemplateParams & {
    locales: string[];
    overwrite: boolean;
};
type ExtractStats = {
    statMessage: string;
};
export declare function writeCatalogs(params: ExtractParams): Promise<ExtractStats>;
export declare function writeTemplate(params: ExtractTemplateParams): Promise<ExtractStats>;
export {};
