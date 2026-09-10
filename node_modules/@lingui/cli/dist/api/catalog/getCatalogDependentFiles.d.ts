import { Catalog } from "../catalog";
/**
 * Return all files catalog implicitly depends on.
 */
export declare function getCatalogDependentFiles(catalog: Catalog, locale: string): Promise<string[]>;
