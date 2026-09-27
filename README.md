# nowme.cloud work log

The page at [dashboard.nowme.cloud](https://dashboard.nowme.cloud): Tasha's record of what she shipped, fixed, and has in progress at Dragon Auto.

- `index.html` is the whole page. It loads `data/worklog.json` and draws everything in the browser.
- `data/worklog.json` is rebuilt at the end of each work session and holds session entries only: date, title, shipped, fixed, in progress, and notes.
