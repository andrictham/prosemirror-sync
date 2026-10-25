const DEFAULT_INITIAL_MS = 1_000;
const DEFAULT_MAX_MS = 30_000;
/**
 * One retry timer with exponential backoff. Each failure schedules `run`
 * after the next delay unless a retry is already waiting. Success resets the
 * backoff and cancels the waiting retry.
 */
export function createRetryTimer(options, run) {
    const initialMs = (options === true ? undefined : options.initialMs) ?? DEFAULT_INITIAL_MS;
    const maxMs = (options === true ? undefined : options.maxMs) ?? DEFAULT_MAX_MS;
    let failures = 0;
    let timer;
    function cancel() {
        if (timer !== undefined) {
            clearTimeout(timer);
            timer = undefined;
        }
    }
    return {
        failed() {
            if (timer !== undefined)
                return;
            const delay = Math.min(initialMs * 2 ** failures, maxMs);
            failures++;
            timer = setTimeout(() => {
                timer = undefined;
                run();
            }, delay);
        },
        succeeded() {
            failures = 0;
            cancel();
        },
        cancel,
    };
}
//# sourceMappingURL=retry.js.map