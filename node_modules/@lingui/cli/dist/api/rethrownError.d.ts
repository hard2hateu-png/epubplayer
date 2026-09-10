export declare class RethrownError extends Error {
    message: string;
    constructor(message: string, originalError: Error);
}
