// core/scheduler.js
//
// Runs core/index.js's run() automatically on a schedule, inside the
// same long-running process as the GUI server -- no separate process or
// Windows Task Scheduler entry needed. The computer still needs to be
// on (not asleep) and DailyBot GUI still needs to be running at the
// scheduled time, same limitation as any other scheduler; if a login
// code is needed that day, someone still needs to be there to type it.

const cron = require("node-cron");
const logger = require("./utils/logger");

let task = null;
let currentCronExpression = null;
let currentTimezone = null;

/**
 * Build a cron expression from the friendly picker's shape (a time of
 * day + which weekdays). Falls back to "every day" if no weekdays given.
 *
 * @param {string} time - "HH:MM", 24-hour.
 * @param {Array<number>} weekdays - 0 (Sunday) through 6 (Saturday).
 * @returns {string}
 */
function buildCronExpression(time, weekdays) {
  const match = /^(\d{1,2}):(\d{1,2})$/.exec(String(time || "").trim());
  if (!match) {
    throw new Error(`Invalid time "${time}" -- expected "HH:MM".`);
  }
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    throw new Error(`Invalid time "${time}" -- hour must be 0-23 and minute 0-59.`);
  }

  const days = Array.isArray(weekdays) && weekdays.length > 0 ? [...weekdays].sort((a, b) => a - b).join(",") : "*";
  return `${minute} ${hour} * * ${days}`;
}

/**
 * The inverse of buildCronExpression(): recognize the common shapes a
 * cron string can take for "daily at HH:MM on these weekdays" and pull
 * the time/weekdays back out, so the friendly picker can show whatever
 * is currently configured. Returns null for anything more exotic (step
 * values, multiple day-of-month rules, etc.) -- those are only editable
 * via the raw cron field, not the picker.
 *
 * @param {string} cronExpression
 * @returns {{time: string, weekdays: Array<number>} | null}
 */
function parseSimpleCronExpression(cronExpression) {
  const parts = String(cronExpression || "").trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;

  if (dayOfMonth !== "*" || month !== "*") return null;
  if (!/^\d{1,2}$/.test(minute) || !/^\d{1,2}$/.test(hour)) return null;

  let weekdays;
  if (dayOfWeek === "*") {
    weekdays = [0, 1, 2, 3, 4, 5, 6];
  } else {
    const rangeMatch = /^(\d)-(\d)$/.exec(dayOfWeek);
    if (rangeMatch) {
      const start = Number(rangeMatch[1]);
      const end = Number(rangeMatch[2]);
      if (start > end || end > 6) return null;
      weekdays = [];
      for (let d = start; d <= end; d++) weekdays.push(d);
    } else if (/^[0-6](,[0-6])*$/.test(dayOfWeek)) {
      weekdays = dayOfWeek.split(",").map(Number);
    } else {
      return null;
    }
  }

  const pad = (n) => String(n).padStart(2, "0");
  return { time: `${pad(Number(hour))}:${pad(Number(minute))}`, weekdays };
}

/**
 * Start (or restart with new settings) the scheduler.
 *
 * @param {string} cronExpression
 * @param {string} timezone
 * @param {() => void} onFire - called every time the schedule fires.
 */
function start(cronExpression, timezone, onFire) {
  if (!cron.validate(cronExpression)) {
    throw new Error(`Invalid cron expression: "${cronExpression}"`);
  }

  stop();

  task = cron.schedule(cronExpression, onFire, {
    timezone: timezone || undefined,
    name: "dailybot-scheduled-run",
  });
  currentCronExpression = cronExpression;
  currentTimezone = timezone;
  logger.info(`Scheduler started: "${cronExpression}" (${timezone || "system timezone"})`);
}

/** Stop and fully remove the current scheduled task, if any. */
function stop() {
  if (task) {
    task.destroy();
    task = null;
    currentCronExpression = null;
    currentTimezone = null;
    logger.info("Scheduler stopped.");
  }
}

/**
 * @returns {{active: boolean, cronExpression: string|null, timezone: string|null, nextRun: string|null}}
 */
function getStatus() {
  let nextRun = null;
  if (task) {
    try {
      const next = task.getNextRun();
      nextRun = next ? next.toISOString() : null;
    } catch {
      nextRun = null;
    }
  }
  return {
    active: task !== null,
    cronExpression: currentCronExpression,
    timezone: currentTimezone,
    nextRun,
  };
}

module.exports = { start, stop, getStatus, buildCronExpression, parseSimpleCronExpression };
