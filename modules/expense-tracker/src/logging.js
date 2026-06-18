/**
 * Structured JSON logger using pino.
 * Replaces all console.log/error/warn JSON calls with pino methods.
 */
import pino from "pino";

const logger = pino({
    level: process.env.LOG_LEVEL || "info",
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
        level(label) {
            return { level: label };
        },
    },
});

/**
 * Returns a child logger with a `logger` binding for module-level identification.
 */
export function getLogger(name) {
    return logger.child({ logger: name });
}

/**
 * Update log level at runtime.
 */
export function setLogLevel(level) {
    logger.level = level;
}

export { logger };
