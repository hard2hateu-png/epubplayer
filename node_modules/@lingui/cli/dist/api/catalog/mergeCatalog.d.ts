import type { MergeOptions } from "../catalog";
import { CatalogType, ExtractedCatalogType } from "../types";
export declare function mergeCatalog(prevCatalog: CatalogType, nextCatalog: ExtractedCatalogType, forSourceLocale: boolean, options: MergeOptions): CatalogType;
