# data/dailyLog.xlsx

Normally you'd edit this through the GUI's **Daily Entries** tab, not
directly -- but it's a plain spreadsheet underneath, and you can open it
in Excel too if you prefer.

Each row is one daily-log entry (one visit) that DailyBot will submit. Columns:

| Column   | Meaning                                          | Maps to site field                | Example              |
|----------|---------------------------------------------------|-------------------------------------|-----------------------|
| Date     | Optional. Which day to log this entry under.       | The date picker after "Log My Day"  | 2026-07-24            |
| Partner  | Must match a partner name in the combobox          | Partner dropdown                     | VMware                |
| Calls    | Number of calls that day                           | "Calls Made"                         | 11                     |
| Meetings | Number of meetings that day                        | "Meetings Held"                      | 3                       |
| Blockers | Anything blocking progress that day                | "Blockers"                           | nil                     |
| Priority | Top priorities for tomorrow                        | "Top 3 Priorities for Tomorrow"      | Follow up with client   |
| Notes    | Free text meeting notes                            | "Meeting Notes"                      | Awaiting customer       |

**Date column:**
- Leave it blank and the row is logged under today.
- Fill in a date (`YYYY-MM-DD` is safest) to backfill a day you missed --
  DailyBot will open the date picker for that specific day instead of
  today. Note: the site itself refuses entries older than a couple of
  days (`MAX_EDIT_AGE_DAYS` in `.env`), so backfilling only works for
  very recent misses.
- Rows can be in any order; DailyBot groups them by date and processes
  each date once.

**Multiple entries in one day:**
Just add more than one row with the same Date. DailyBot opens that day
once and submits every row for it in sequence.

If you edit this file directly while the GUI server is running, refresh
the Daily Entries tab to see your changes.
