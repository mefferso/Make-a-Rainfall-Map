# LA–MS Cumulative Rainfall Map

Fast cumulative-rainfall mapping for Louisiana and Mississippi using NOAA gridded precipitation analyses.

## Data selection

| Selected date | Dataset |
|---|---|
| 1951-01-01 through 2004-12-31 | NOAA/NCEI nClimGrid-Daily precipitation |
| 2005-01-01 through 2016-06-27 | NCEP Stage III QPE |
| 2016-06-28 to present | NCEP Stage IV QPE |

Stage III/IV precipitation is the NWS quality-controlled multi-sensor radar + gauge analysis. The daily Stage III/IV products are 24-hour accumulations ending at 12Z and are stored in inches. nClimGrid-Daily is a ~5-km station-based gridded analysis and is converted from millimeters to inches in the app.

For Stage IV, the app uses NOAA's archived multi-day accumulation files (2/3/4/5/6/7/10/14/30/60/90/120/180/365 day) whenever they match part of the requested interval, falling back to smaller windows as needed.

## Use

Open the site, select a start date and end date (or set start + number of days), and click **Generate map**.

- Hover for grid-cell rainfall.
- **Download PNG** creates a clean map with state/county boundaries and legend.
- The map is clipped to Louisiana and Mississippi.

## First-time GitHub Pages setup

For a new repository, enable Pages once at **Settings → Pages → Build and deployment → Source → GitHub Actions**. The included workflow deploys the site automatically after that setting is enabled.

## Sources

- NWS National Water Prediction Service precipitation archive: https://water.noaa.gov/about/precipitation-data-access
- NOAA/NCEI nClimGrid-Daily: https://www.ncei.noaa.gov/products/land-based-station/nclimgrid-daily
- U.S. Census Bureau TIGERweb state/county boundaries.

## Local test

Serve the repository over HTTP (ES modules will not run correctly from a `file://` URL):

```bash
python -m http.server 8000
```

Then open `http://localhost:8000`.
