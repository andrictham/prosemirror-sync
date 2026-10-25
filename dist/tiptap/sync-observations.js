/** Isolate optional observers from the content synchronization protocol. */
export function createSyncObserver(onObservation, log) {
    return (event) => {
        try {
            onObservation?.(event);
        }
        catch (error) {
            log("Ignoring sync observer failure", error);
        }
    };
}
//# sourceMappingURL=sync-observations.js.map