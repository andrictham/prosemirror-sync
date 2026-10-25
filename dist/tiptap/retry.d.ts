/** Backoff for retrying sync after a failure. */
export type RetryOptions = {
    /** The delay before the first retry. @default 1000 */
    initialMs?: number;
    /** The longest delay, reached by doubling. @default 30000 */
    maxMs?: number;
};
/**
 * One retry timer with exponential backoff. Each failure schedules `run`
 * after the next delay unless a retry is already waiting. Success resets the
 * backoff and cancels the waiting retry.
 */
export declare function createRetryTimer(options: RetryOptions | true, run: () => void): {
    failed(): void;
    succeeded(): void;
    cancel: () => void;
};
//# sourceMappingURL=retry.d.ts.map