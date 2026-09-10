import type { CatalogFormat, CatalogFormatter } from "@lingui/conf";
import { CatalogFormatOptions } from "@lingui/conf";
import { FormatterWrapper } from "./formatterWrapper";
export { FormatterWrapper };
export declare function getFormat(_format: CatalogFormat | CatalogFormatter, options: CatalogFormatOptions, sourceLocale: string): Promise<FormatterWrapper>;
