# dashboard.nowme.cloud

Tasha's work dashboard for Dragon Auto, served by GitHub Pages.

- `index.html`, `style.css`, `app.js` are the dashboard. After editing `style.css` or `app.js`, change its `?v=` value in `index.html` so browsers fetch the new copy instead of a cached one.
- `worklog.json` is the data, rebuilt at the end of each work session. Growth Path, Noah's Log, and the audit key travel only inside `privateVault`, encrypted; everything else in the file is public.
