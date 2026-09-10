import { Plugin } from "esbuild";
import { LinguiConfigNormalized } from "@lingui/conf";
export declare const pluginLinguiMacro: (options: {
    linguiConfig: LinguiConfigNormalized;
}) => Plugin;
