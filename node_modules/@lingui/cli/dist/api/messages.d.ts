import { TranslationMissingEvent } from "./catalog/getTranslationsForCatalog";
import { MessageCompilationError } from "./compile";
export declare function createMissingErrorMessage(locale: string, missingMessages: TranslationMissingEvent[], configurationMsg: string): string;
export declare function createCompilationErrorMessage(locale: string, errors: MessageCompilationError[]): string;
