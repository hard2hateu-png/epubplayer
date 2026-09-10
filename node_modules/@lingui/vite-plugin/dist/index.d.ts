import { Plugin } from 'vite';

type LinguiPluginOpts = {
    cwd?: string;
    configPath?: string;
    skipValidation?: boolean;
    /**
     * If true would fail compilation on missing translations
     **/
    failOnMissing?: boolean;
    /**
     * If true would fail compilation on message compilation errors
     **/
    failOnCompileError?: boolean;
};
declare function lingui({ failOnMissing, failOnCompileError, ...linguiConfig }?: LinguiPluginOpts): Plugin[];

export { type LinguiPluginOpts, lingui as default, lingui };
