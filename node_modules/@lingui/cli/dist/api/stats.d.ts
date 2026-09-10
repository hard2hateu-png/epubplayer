import { LinguiConfigNormalized } from "@lingui/conf";
import { AllCatalogsType, CatalogType } from "./types";
type CatalogStats = [number, number];
export declare function getStats(catalog: CatalogType): CatalogStats;
export declare function printStats(config: LinguiConfigNormalized, catalogs: AllCatalogsType): any;
export {};
