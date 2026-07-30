// core/utils/logger.js
//
// Every module needs logging. Without this, login.js, dashboard.js, and
// forms.js would each roll their own console.log() calls -- some plain
// text, some with timestamps, some without. Multiply that by every module
// and you get an inconsistent, unsearchable mess.
//
// Instead, everyone calls:
//   logger.info("message")
//   logger.warning("message")
//   logger.error("message", err)
//
// and THIS file is the only place that decides where logs go and how
// they're formatted.

const path = require("path");
const winston = require("winston");
const config = require("../config");
const { ensureDir } = require("./helpers");

ensureDir(config.paths.logs);

const consoleFormat = winston.format.combine(
  winston.format.timestamp({ format: "HH:mm:ss" }),
  winston.format.printf(({ timestamp, level, message }) => {
    const icon = { info: "ℹ️ ", warn: "⚠️ ", error: "❌" }[level] || "  ";
    return `[${timestamp}] ${icon} ${message}`;
  })
);

const fileFormat = winston.format.combine(
  winston.format.timestamp(),
  winston.format.json()
);

const transports = [];

if (config.logging.toConsole) {
  transports.push(
    new winston.transports.Console({
      format: consoleFormat,
    })
  );
}

if (config.logging.toFile) {
  transports.push(
    new winston.transports.File({
      filename: path.join(config.paths.logs, "combined.log"),
      format: fileFormat,
    })
  );
  transports.push(
    new winston.transports.File({
      filename: path.join(config.paths.logs, "errors.log"),
      level: "error",
      format: fileFormat,
    })
  );
}

const winstonLogger = winston.createLogger({
  level: config.logging.level,
  transports,
});

// Thin wrapper so the rest of the codebase calls logger.warning() instead
// of needing to remember that winston itself calls it "warn".
const logger = {
  info: (message, meta) => winstonLogger.info(message, meta),
  warning: (message, meta) => winstonLogger.warn(message, meta),
  warn: (message, meta) => winstonLogger.warn(message, meta),
  error: (message, err) => {
    if (err instanceof Error) {
      winstonLogger.error(`${message}: ${err.message}`, { stack: err.stack });
    } else {
      winstonLogger.error(message, err);
    }
  },
};

module.exports = logger;
