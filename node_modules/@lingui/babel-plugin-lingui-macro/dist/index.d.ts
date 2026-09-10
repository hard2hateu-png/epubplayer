import { PluginObj } from '@babel/core';
import * as babelTypes from '@babel/types';
import { LinguiConfigNormalized } from '@lingui/conf';

type LinguiPluginOpts = {
    extract?: boolean;
    /**
     * Setting `stripMessageField` to `true` will strip messages and comments from both development and production bundles.
     * Alternatively, set it to `false` to keep the original messages in both environments.
     *
     * If not set value would be determined based on `process.env.NODE_ENV === "production"`
     */
    stripMessageField?: boolean;
    /**
     * Resolved and normalized Lingui Configuration
     */
    linguiConfig?: LinguiConfigNormalized;
};
declare function export_default({ types: t, }: {
    types: typeof babelTypes;
}): PluginObj;

export { type LinguiPluginOpts, export_default as default };
