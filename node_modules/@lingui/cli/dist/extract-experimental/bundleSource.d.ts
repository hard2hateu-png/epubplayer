import { LinguiConfigNormalized } from "@lingui/conf";
export declare function bundleSource(linguiConfig: LinguiConfigNormalized, entryPoints: string[], outDir: string, rootDir: string): Promise<import("esbuild").BuildResult<any>>;
