# Weigh-in

A tiny offline PWA for a daily weigh-in, with each week's average and the weekly trend.

- **Log weight:** pick a date and enter a weight. If that day already has a weight, it asks before replacing it.
- **Weekly average:** a [uPlot](https://github.com/leeoniya/uPlot) chart of the weekly averages only. The current week is drawn dashed because its average keeps moving until the week ends.
- **Weeks:** newest week first. Each week shows its average, how many days were logged (n/7), the change from the previous logged week, and an "in progress" badge until its last day has passed. Each day's weight is listed under its week, with × to delete it.
- **Settings:** units (kg/lb) and whether weeks start on Monday or Sunday. Weights are stored in kg, so you can switch units at any time.
- **Data:** export all days to CSV (`date,weight_kg` or `date,weight_lb`, in your current units) and import it back. Import replaces the days in the file and leaves the others alone.

Data is stored in IndexedDB on the device, one row per date. There's no build step: uPlot is vendored in `vendor/` so the chart also works offline. Serve the folder over HTTPS (for example GitHub Pages) and use "Add to Home Screen".

To run it locally: `python3 -m http.server`, then open http://localhost:8000.
