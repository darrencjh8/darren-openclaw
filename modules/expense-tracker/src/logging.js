/**
 * Auto-inject timestamps into JSON log lines.
 * Patches console.log / console.error to add `timestamp` field to every JSON object log.
 */

/**
 * Creates a wrapper that injects `timestamp` into JSON-stringified log lines.
 * Non-JSON arguments pass through unchanged.
 */
export function createTimestampedLogger(originalFn) {
    return (...args) => {
        if (
            args.length === 1 &&
            typeof args[0] === "string" &&
            args[0].startsWith("{")
        ) {
            try {
                const obj = JSON.parse(args[0]);
                if (!obj.timestamp) {
                    obj.timestamp = new Date().toISOString();
                }
                return originalFn(JSON.stringify(obj));
            } catch {
                // Not valid JSON — pass through unchanged
            }
        }
        return originalFn(...args);
    };
}

/**
 * Patch console.log and console.error to auto-inject timestamps.
 * Call once at startup.
 */
export function installTimestampedLogging() {
    const _log = console.log.bind(console);
    const _error = console.error.bind(console);
    console.log = createTimestampedLogger(_log);
    console.error = createTimestampedLogger(_error);
}
