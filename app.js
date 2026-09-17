import * as GeoTIFF from 'https://cdn.jsdelivr.net/npm/geotiff@2.1.3/+esm';
import proj4 from 'https://cdn.jsdelivr.net/npm/proj4@2.11.0/+esm';
import { NetCDFReader } from 'https://cdn.jsdelivr.net/npm/netcdfjs@4.0.0/+esm';

const L = window.L;

const DISPLAY_BOUNDS = { west: -94.2, south: 28.75, east: -87.75, north: 35.15 };
const TARGET_WIDTH = 340;
const TARGET_HEIGHT = 338;
const NCLIMGRID_LAST_DATE = '2004-12-31';
const STAGE3_FIRST_DATE = '2005-01-01';
const STAGE3_LAST_PREFERRED_DATE = '2016-06-27';
const STAGE4_FIRST_DATE = '2016-06-28';
const NOAA_ROOTS = ['https://api.water.noaa.gov', 'https://water.noaa.gov'];
const HRAP_PROJ = '+proj=stere +lat_0=90 +lat_ts=60 +lon_0=-105 +x_0=0 +y_0=0 +a=6371200 +b=6371200 +units=m +no_defs';
const WGS84 = 'EPSG:4326';
const MS_PER_DAY = 86400000;
const STAGE4_WINDOWS = [365, 180, 120, 90, 60, 30, 14, 10, 7, 6, 5, 4, 3, 2, 1];

const COLOR_BINS = [
  { min: 0.01, color: [198, 226, 255], label: '0.01–0.10' },
  { min: 0.10, color: [116, 196, 232], label: '0.10–0.25' },
  { min: 0.25, color: [65, 171, 93], label: '0.25–0.50' },
  { min: 0.50, color: [0, 109, 44], label: '0.50–1.00' },
  { min: 1.00, color: [255, 239, 0], label: '1.00–2.00' },
  { min: 2.00, color: [255, 165, 0], label: '2.00–3.00' },
  { min: 3.00, color: [239, 59, 44], label: '3.00–5.00' },
  { min: 5.00, color: [177, 0, 38], label: '5.00–8.00' },
  { min: 8.00, color: [220, 0, 220], label: '8.00–10.0' },
  { min: 10.0, color: [132, 0, 168], label: '10.0–15.0' },
  { min: 15.0, color: [73, 0, 106], label: '15.0–20.0' },
  { min: 20.0, color: [30, 30, 30], label: '20.0+' },
];

const els = {
  form: document.querySelector('#controls'),
  start: document.querySelector('#start-date'),
  end: document.querySelector('#end-date'),
  days: document.querySelector('#days'),
  generate: document.querySelector('#generate'),
  download: document.querySelector('#download'),
  period: document.querySelector('#period-label'),
  source: document.querySelector('#source-label'),
  max: document.querySelector('#max-label'),
  loading: document.querySelector('#loading'),
  loadingTitle: document.querySelector('#loading-title'),
  loadingDetail: document.querySelector('#loading-detail'),
  probe: document.querySelector('#probe'),
  probeValue: document.querySelector('#probe-value'),
  probeCoords: document.querySelector('#probe-coords'),
  legend: document.querySelector('#legend'),
  error: document.querySelector('#error'),
};

let stateGeoJson = null;
let countyGeoJson = null;
let stateLayer = null;
let countyLayer = null;
let rainfallLayer = null;
let latestGrid = null;
let latestRasterCanvas = null;
let latestMeta = null;
let requestSerial = 0;

const map = L.map('map', {
  center: [32.0, -90.9],
  zoom: 6,
  minZoom: 5,
  maxZoom: 11,
  zoomControl: true,
  preferCanvas: true,
});

L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
  subdomains: 'abcd',
  maxZoom: 20,
  attribution: '&copy; OpenStreetMap &copy; CARTO',
}).addTo(map);

map.fitBounds([[DISPLAY_BOUNDS.south, DISPLAY_BOUNDS.west], [DISPLAY_BOUNDS.north, DISPLAY_BOUNDS.east]], { padding: [12, 12] });
renderLegend();
initializeDates();
const boundariesReady = loadBoundaries();

els.start.addEventListener('change', () => syncEndFromDays());
els.days.addEventListener('change', () => syncEndFromDays());
els.end.addEventListener('change', () => syncDaysFromDates());
els.form.addEventListener('submit', onGenerate);
els.download.addEventListener('click', downloadPng);
map.on('mousemove', updateProbe);
map.on('mouseout', () => els.probe.classList.add('hidden'));

async function onGenerate(event) {
  event.preventDefault();
  hideError();
  const start = parseDate(els.start.value);
  const end = parseDate(els.end.value);

  if (!start || !end || end < start) {
    showError('Choose a valid start and end date.');
    return;
  }

  const days = dayCount(start, end);
  if (days > 366) {
    showError('Maximum range is 366 days per map.');
    return;
  }
  if (start < parseDate('1951-01-01')) {
    showError('Gridded coverage begins January 1, 1951.');
    return;
  }

  const serial = ++requestSerial;
  setBusy(true, 'Loading rainfall data…', `${days} day${days === 1 ? '' : 's'}`);
  els.download.disabled = true;

  try {
    const grid = new Float32Array(TARGET_WIDTH * TARGET_HEIGHT);
    const chunks = splitBySource(start, end);
    let workDone = 0;
    const workTotal = chunks.reduce((sum, chunk) => sum + dayCount(chunk.start, chunk.end), 0);

    for (const chunk of chunks) {
      if (serial !== requestSerial) return;
      const label = sourceDisplayName(chunk.source);
      setBusy(true, `Loading ${label}…`, formatRange(chunk.start, chunk.end));

      const reportProgress = (increment, detail) => {
        workDone += increment;
        const pct = Math.min(100, Math.round((workDone / workTotal) * 100));
        els.loadingDetail.textContent = `${detail} · ${pct}%`;
      };

      if (chunk.source === 'nclimgrid') {
        await accumulateNclimGrid(chunk.start, chunk.end, grid, reportProgress);
      } else if (chunk.source === 'stage3') {
        await accumulateStage3(chunk.start, chunk.end, grid, reportProgress);
      } else {
        await accumulateStage4(chunk.start, chunk.end, grid, reportProgress);
      }
    }

    if (serial !== requestSerial) return;
    await boundariesReady;
    maskGridToStates(grid);
    const max = finiteMax(grid);
    const rasterCanvas = renderRainfallCanvas(grid);
    updateRainfallLayer(rasterCanvas);

    latestGrid = grid;
    latestRasterCanvas = rasterCanvas;
    latestMeta = { start, end, days, chunks, max };
    els.download.disabled = false;

    els.period.textContent = `${formatDate(start)} – ${formatDate(end)} · ${days} day${days === 1 ? '' : 's'}`;
    const sourceNames = chunks.map(c => sourceDisplayName(c.source)).filter((v, i, a) => a.indexOf(v) === i);
    const hasQpe = chunks.some(c => c.source === 'stage3' || c.source === 'stage4');
    els.source.textContent = `${sourceNames.join(' + ')}${hasQpe ? ' · QPE periods end 12Z' : ''}`;
    els.max.textContent = Number.isFinite(max) ? `Max ${max.toFixed(2)} in` : 'No valid data';
  } catch (error) {
    console.error(error);
    showError(cleanErrorMessage(error));
  } finally {
    if (serial === requestSerial) setBusy(false);
  }
}

function splitBySource(start, end) {
  const cut1 = parseDate(NCLIMGRID_LAST_DATE);
  const cut2 = parseDate(STAGE3_LAST_PREFERRED_DATE);
  const chunks = [];

  if (start <= cut1) {
    chunks.push({ source: 'nclimgrid', start, end: minDate(end, cut1) });
  }
  if (end >= parseDate(STAGE3_FIRST_DATE) && start <= cut2) {
    chunks.push({ source: 'stage3', start: maxDate(start, parseDate(STAGE3_FIRST_DATE)), end: minDate(end, cut2) });
  }
  if (end >= parseDate(STAGE4_FIRST_DATE)) {
    chunks.push({ source: 'stage4', start: maxDate(start, parseDate(STAGE4_FIRST_DATE)), end });
  }
  return chunks.filter(c => c.start <= c.end);
}

async function accumulateStage4(start, end, output, reportProgress) {
  const segments = buildStage4Segments(start, end);
  for (const seg of segments) {
    await accumulateStage4Segment(seg.start, seg.end, output, reportProgress);
  }
}

async function accumulateStage4Segment(start, end, output, reportProgress) {
  const len = dayCount(start, end);
  if (STAGE4_WINDOWS.includes(len)) {
    try {
      const token = len === 1 ? '1day' : `last${len}days`;
      const ymd = compactDate(end);
      const path = `/resources/downloads/precip/stageIV/${year(end)}/${month(end)}/${day(end)}/nws_precip_${token}_${ymd}_conus.tif`;
      const sampled = await fetchGeoTiffToTarget(path);
      addGrid(output, sampled);
      reportProgress(len, `${len}-day QPE ending ${shortDate(end)}`);
      return;
    } catch (error) {
      if (len === 1) throw error;
      console.warn(`Stage IV ${len}-day accumulation unavailable; splitting`, error);
    }
  }

  const half = Math.floor(len / 2);
  const leftEnd = addDays(start, half - 1);
  const rightStart = addDays(leftEnd, 1);
  await accumulateStage4Segment(start, leftEnd, output, reportProgress);
  await accumulateStage4Segment(rightStart, end, output, reportProgress);
}

function buildStage4Segments(start, end) {
  const segments = [];
  let cursor = new Date(end);
  let remaining = dayCount(start, end);
  while (remaining > 0) {
    const len = STAGE4_WINDOWS.find(v => v <= remaining) || 1;
    const segStart = addDays(cursor, -(len - 1));
    segments.unshift({ start: segStart, end: new Date(cursor) });
    cursor = addDays(segStart, -1);
    remaining -= len;
  }
  return segments;
}

async function accumulateStage3(start, end, output, reportProgress) {
  const dates = dateSequence(start, end);
  const batchSize = 4;
  for (let i = 0; i < dates.length; i += batchSize) {
    const batch = dates.slice(i, i + batchSize);
    const grids = await Promise.all(batch.map(async date => {
      const ymd = compactDate(date);
      const path = `/resources/downloads/precip/stageIII/${year(date)}/${month(date)}/${day(date)}/nws_precip_1day_${ymd}.tif`;
      return fetchGeoTiffToTarget(path);
    }));
    grids.forEach(grid => addGrid(output, grid));
    reportProgress(batch.length, `Stage III through ${shortDate(batch.at(-1))}`);
  }
}

async function fetchGeoTiffToTarget(relativePath) {
  const buffer = await fetchNoaaArrayBuffer(relativePath);
  const tiff = await GeoTIFF.fromArrayBuffer(buffer);
  const image = await tiff.getImage();
  const width = image.getWidth();
  const height = image.getHeight();
  const bbox = image.getBoundingBox();
  const raster = await image.readRasters({ samples: [0], interleave: true });
  const noData = Number(image.getGDALNoData());
  const directLonLat = looksLikeDegrees(bbox);
  const output = new Float32Array(TARGET_WIDTH * TARGET_HEIGHT);

  for (let y = 0; y < TARGET_HEIGHT; y++) {
    const lat = DISPLAY_BOUNDS.north - ((y + 0.5) / TARGET_HEIGHT) * (DISPLAY_BOUNDS.north - DISPLAY_BOUNDS.south);
    for (let x = 0; x < TARGET_WIDTH; x++) {
      const lon = DISPLAY_BOUNDS.west + ((x + 0.5) / TARGET_WIDTH) * (DISPLAY_BOUNDS.east - DISPLAY_BOUNDS.west);
      let sxCoord = lon;
      let syCoord = lat;
      if (!directLonLat) {
        [sxCoord, syCoord] = proj4(WGS84, HRAP_PROJ, [lon, lat]);
      }

      const sx = Math.floor(((sxCoord - bbox[0]) / (bbox[2] - bbox[0])) * width);
      const sy = Math.floor(((bbox[3] - syCoord) / (bbox[3] - bbox[1])) * height);
      if (sx < 0 || sy < 0 || sx >= width || sy >= height) continue;

      const value = Number(raster[sy * width + sx]);
      if (!Number.isFinite(value) || value < 0 || value === noData || value <= -9999) continue;
      output[y * TARGET_WIDTH + x] = value;
    }
  }
  return output;
}

async function fetchNoaaArrayBuffer(relativePath) {
  let lastError = null;
  for (const root of NOAA_ROOTS) {
    try {
      const response = await fetch(`${root}${relativePath}`, { mode: 'cors', cache: 'force-cache' });
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      return await response.arrayBuffer();
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`NOAA QPE file unavailable: ${relativePath.split('/').at(-1)}${lastError ? ` (${lastError.message})` : ''}`);
}

async function accumulateNclimGrid(start, end, output, reportProgress) {
  const monthChunks = splitByMonth(start, end);
  for (const chunk of monthChunks) {
    const y = year(chunk.start);
    const ym = `${y}${month(chunk.start)}`;
    const base = `https://www.ncei.noaa.gov/thredds/ncss/grid/nclimgrid-daily/${y}/prcp-${ym}-grd-scaled.nc`;
    const params = new URLSearchParams({
      var: 'prcp',
      north: String(DISPLAY_BOUNDS.north),
      west: String(DISPLAY_BOUNDS.west),
      east: String(DISPLAY_BOUNDS.east),
      south: String(DISPLAY_BOUNDS.south),
      horizStride: '1',
      time_start: `${isoDate(chunk.start)}T00:00:00Z`,
      time_end: `${isoDate(chunk.end)}T00:00:00Z`,
      timeStride: '1',
      accept: 'netcdf3',
    });

    const response = await fetch(`${base}?${params.toString()}`, { mode: 'cors', cache: 'force-cache' });
    if (!response.ok) throw new Error(`nClimGrid request failed: ${response.status} ${response.statusText}`);
    const buffer = await response.arrayBuffer();
    const reader = new NetCDFReader(buffer);
    const lat = numeric1D(reader.getDataVariable('lat'));
    const lon = numeric1D(reader.getDataVariable('lon'));
    const time = numeric1D(reader.getDataVariable('time'));
    const raw = flattenNumeric(reader.getDataVariable('prcp'));
    const plane = lat.length * lon.length;
    if (!lat.length || !lon.length || !time.length || raw.length < plane) {
      throw new Error(`Unexpected nClimGrid response for ${ym}.`);
    }

    const monthlySumIn = new Float32Array(plane);
    const nt = Math.min(time.length, Math.floor(raw.length / plane));
    for (let t = 0; t < nt; t++) {
      const offset = t * plane;
      for (let i = 0; i < plane; i++) {
        const mm = raw[offset + i];
        if (Number.isFinite(mm) && mm >= 0 && mm < 5000) monthlySumIn[i] += mm / 25.4;
      }
    }

    resampleRegularLatLonInto(monthlySumIn, lat, lon, output);
    reportProgress(dayCount(chunk.start, chunk.end), `nClimGrid through ${shortDate(chunk.end)}`);
  }
}

function resampleRegularLatLonInto(source, lat, lon, output) {
  const lat0 = lat[0];
  const lat1 = lat[lat.length - 1];
  const lon0 = lon[0];
  const lon1 = lon[lon.length - 1];

  for (let y = 0; y < TARGET_HEIGHT; y++) {
    const targetLat = DISPLAY_BOUNDS.north - ((y + 0.5) / TARGET_HEIGHT) * (DISPLAY_BOUNDS.north - DISPLAY_BOUNDS.south);
    const sy = clamp(Math.round(((targetLat - lat0) / (lat1 - lat0)) * (lat.length - 1)), 0, lat.length - 1);
    for (let x = 0; x < TARGET_WIDTH; x++) {
      const targetLon = DISPLAY_BOUNDS.west + ((x + 0.5) / TARGET_WIDTH) * (DISPLAY_BOUNDS.east - DISPLAY_BOUNDS.west);
      const sx = clamp(Math.round(((targetLon - lon0) / (lon1 - lon0)) * (lon.length - 1)), 0, lon.length - 1);
      output[y * TARGET_WIDTH + x] += source[sy * lon.length + sx] || 0;
    }
  }
}

function maskGridToStates(grid) {
  if (!stateGeoJson) return;
  const mask = document.createElement('canvas');
  mask.width = TARGET_WIDTH;
  mask.height = TARGET_HEIGHT;
  const ctx = mask.getContext('2d', { alpha: true });
  ctx.fillStyle = '#fff';
  drawGeoJson(ctx, stateGeoJson, coord => [
    ((coord[0] - DISPLAY_BOUNDS.west) / (DISPLAY_BOUNDS.east - DISPLAY_BOUNDS.west)) * TARGET_WIDTH,
    ((DISPLAY_BOUNDS.north - coord[1]) / (DISPLAY_BOUNDS.north - DISPLAY_BOUNDS.south)) * TARGET_HEIGHT,
  ], true);
  const pixels = ctx.getImageData(0, 0, TARGET_WIDTH, TARGET_HEIGHT).data;
  for (let i = 0; i < grid.length; i++) {
    if (pixels[i * 4 + 3] < 128) grid[i] = Number.NaN;
  }
}

function renderRainfallCanvas(grid) {
  const canvas = document.createElement('canvas');
  canvas.width = TARGET_WIDTH;
  canvas.height = TARGET_HEIGHT;
  const ctx = canvas.getContext('2d', { alpha: true });
  const image = ctx.createImageData(TARGET_WIDTH, TARGET_HEIGHT);

  for (let i = 0; i < grid.length; i++) {
    const v = grid[i];
    if (!Number.isFinite(v) || v < 0.01) continue;
    const [r, g, b] = colorForValue(v);
    const p = i * 4;
    image.data[p] = r;
    image.data[p + 1] = g;
    image.data[p + 2] = b;
    image.data[p + 3] = 220;
  }
  ctx.putImageData(image, 0, 0);
  return canvas;
}

function updateRainfallLayer(canvas) {
  const url = canvas.toDataURL('image/png');
  const bounds = [[DISPLAY_BOUNDS.south, DISPLAY_BOUNDS.west], [DISPLAY_BOUNDS.north, DISPLAY_BOUNDS.east]];
  if (rainfallLayer) map.removeLayer(rainfallLayer);
  rainfallLayer = L.imageOverlay(url, bounds, { opacity: 0.83, interactive: false, zIndex: 300 }).addTo(map);
  if (countyLayer) countyLayer.bringToFront();
  if (stateLayer) stateLayer.bringToFront();
  map.fitBounds(bounds, { padding: [10, 10] });
}

async function loadBoundaries() {
  try {
    const stateUrl = tigerQueryUrl(0, "STATE IN ('22','28')", 'STATE,NAME');
    const countyUrl = tigerQueryUrl(1, "STATE IN ('22','28')", 'STATE,COUNTY,NAME');
    [stateGeoJson, countyGeoJson] = await Promise.all([
      fetch(stateUrl).then(r => { if (!r.ok) throw new Error('states'); return r.json(); }),
      fetch(countyUrl).then(r => { if (!r.ok) throw new Error('counties'); return r.json(); }),
    ]);

    countyLayer = L.geoJSON(countyGeoJson, {
      style: { color: '#475569', weight: 0.55, opacity: 0.62, fillOpacity: 0 },
      interactive: false,
      pane: 'overlayPane',
    }).addTo(map);

    stateLayer = L.geoJSON(stateGeoJson, {
      style: { color: '#0f172a', weight: 1.5, opacity: 0.95, fillOpacity: 0 },
      interactive: false,
      pane: 'overlayPane',
    }).addTo(map);
  } catch (error) {
    console.warn('Boundary layer unavailable', error);
  }
}

function tigerQueryUrl(layerId, where, outFields) {
  const url = new URL(`https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/State_County/MapServer/${layerId}/query`);
  url.search = new URLSearchParams({
    where,
    outFields,
    returnGeometry: 'true',
    outSR: '4326',
    f: 'geojson',
  }).toString();
  return url.toString();
}

function downloadPng() {
  if (!latestRasterCanvas || !latestMeta) return;

  const canvas = document.createElement('canvas');
  canvas.width = 1600;
  canvas.height = 1300;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const plot = { x: 120, y: 132, w: 1300, h: 1060 };
  ctx.fillStyle = '#eef2f5';
  ctx.fillRect(plot.x, plot.y, plot.w, plot.h);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(latestRasterCanvas, plot.x, plot.y, plot.w, plot.h);

  const transform = coord => [
    plot.x + ((coord[0] - DISPLAY_BOUNDS.west) / (DISPLAY_BOUNDS.east - DISPLAY_BOUNDS.west)) * plot.w,
    plot.y + ((DISPLAY_BOUNDS.north - coord[1]) / (DISPLAY_BOUNDS.north - DISPLAY_BOUNDS.south)) * plot.h,
  ];

  if (countyGeoJson) {
    ctx.strokeStyle = 'rgba(51,65,85,.55)';
    ctx.lineWidth = 0.8;
    drawGeoJson(ctx, countyGeoJson, transform, false, true);
  }
  if (stateGeoJson) {
    ctx.strokeStyle = '#0f172a';
    ctx.lineWidth = 2.1;
    drawGeoJson(ctx, stateGeoJson, transform, false, true);
  }

  ctx.fillStyle = '#0f172a';
  ctx.font = '700 38px system-ui, sans-serif';
  ctx.fillText('Louisiana & Mississippi Cumulative Rainfall', 120, 60);
  ctx.fillStyle = '#475569';
  ctx.font = '500 22px system-ui, sans-serif';
  ctx.fillText(`${formatDate(latestMeta.start)} – ${formatDate(latestMeta.end)}  •  ${latestMeta.days} day${latestMeta.days === 1 ? '' : 's'}`, 120, 96);

  ctx.fillStyle = '#0f172a';
  ctx.font = '700 20px system-ui, sans-serif';
  ctx.fillText(`Max: ${latestMeta.max.toFixed(2)} in`, 1240, 62);
  ctx.fillStyle = '#64748b';
  ctx.font = '500 15px system-ui, sans-serif';
  const sourceText = latestMeta.chunks.map(c => sourceDisplayName(c.source)).filter((v, i, a) => a.indexOf(v) === i).join(' + ');
  ctx.fillText(sourceText, 120, 1235);
  ctx.fillText('NOAA/NWS & NOAA/NCEI gridded precipitation analyses', 120, 1263);

  drawExportLegend(ctx, 1450, 170);

  const link = document.createElement('a');
  link.download = `rainfall_${compactDate(latestMeta.start)}_${compactDate(latestMeta.end)}.png`;
  link.href = canvas.toDataURL('image/png');
  link.click();
}

function drawExportLegend(ctx, x, y) {
  ctx.save();
  ctx.font = '600 14px system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.fillStyle = '#0f172a';
  ctx.fillText('INCHES', x, y - 12);
  COLOR_BINS.forEach((bin, i) => {
    ctx.fillStyle = `rgb(${bin.color.join(',')})`;
    ctx.fillRect(x, y + i * 27, 30, 18);
    ctx.strokeStyle = 'rgba(15,23,42,.2)';
    ctx.strokeRect(x, y + i * 27, 30, 18);
    ctx.fillStyle = '#334155';
    ctx.font = '500 13px system-ui, sans-serif';
    ctx.fillText(bin.label, x + 38, y + 14 + i * 27);
  });
  ctx.restore();
}

function updateProbe(event) {
  if (!latestGrid) return;
  const { lat, lng: lon } = event.latlng;
  if (lat < DISPLAY_BOUNDS.south || lat > DISPLAY_BOUNDS.north || lon < DISPLAY_BOUNDS.west || lon > DISPLAY_BOUNDS.east) {
    els.probe.classList.add('hidden');
    return;
  }
  const x = clamp(Math.floor(((lon - DISPLAY_BOUNDS.west) / (DISPLAY_BOUNDS.east - DISPLAY_BOUNDS.west)) * TARGET_WIDTH), 0, TARGET_WIDTH - 1);
  const y = clamp(Math.floor(((DISPLAY_BOUNDS.north - lat) / (DISPLAY_BOUNDS.north - DISPLAY_BOUNDS.south)) * TARGET_HEIGHT), 0, TARGET_HEIGHT - 1);
  const value = latestGrid[y * TARGET_WIDTH + x];
  if (!Number.isFinite(value)) {
    els.probe.classList.add('hidden');
    return;
  }
  els.probeValue.textContent = `${value.toFixed(2)} in`;
  els.probeCoords.textContent = `${lat.toFixed(3)}, ${lon.toFixed(3)}`;
  els.probe.classList.remove('hidden');
}

function renderLegend() {
  const items = COLOR_BINS.map(bin => `<span class="legend-swatch" style="background:rgb(${bin.color.join(',')})"></span><span>${bin.label}</span>`).join('');
  els.legend.innerHTML = `<div class="legend-title"><span>Rainfall</span><span>in</span></div><div class="legend-grid">${items}</div>`;
}

function colorForValue(value) {
  let selected = COLOR_BINS[0].color;
  for (const bin of COLOR_BINS) {
    if (value >= bin.min) selected = bin.color;
    else break;
  }
  return selected;
}

function drawGeoJson(ctx, geojson, transform, fill = false, stroke = false) {
  const features = geojson?.features || [];
  for (const feature of features) {
    const geometry = feature.geometry;
    if (!geometry) continue;
    const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.type === 'MultiPolygon' ? geometry.coordinates : [];
    for (const polygon of polygons) {
      ctx.beginPath();
      for (const ring of polygon) {
        ring.forEach((coord, idx) => {
          const [x, y] = transform(coord);
          if (idx === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        });
        ctx.closePath();
      }
      if (fill) ctx.fill('evenodd');
      if (stroke) ctx.stroke();
    }
  }
}

function initializeDates() {
  const today = new Date();
  const end = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  end.setUTCDate(end.getUTCDate() - 9);
  const start = addDays(end, -9);
  els.start.value = isoDate(start);
  els.end.value = isoDate(end);
  els.days.value = '10';
}

function syncEndFromDays() {
  const start = parseDate(els.start.value);
  const days = clamp(Number.parseInt(els.days.value, 10) || 1, 1, 366);
  if (!start) return;
  els.days.value = String(days);
  els.end.value = isoDate(addDays(start, days - 1));
}

function syncDaysFromDates() {
  const start = parseDate(els.start.value);
  const end = parseDate(els.end.value);
  if (!start || !end || end < start) return;
  els.days.value = String(dayCount(start, end));
}

function setBusy(busy, title = '', detail = '') {
  els.loading.classList.toggle('hidden', !busy);
  els.generate.disabled = busy;
  if (busy) {
    els.loadingTitle.textContent = title;
    els.loadingDetail.textContent = detail;
  }
}

function showError(message) {
  els.error.textContent = message;
  els.error.classList.remove('hidden');
}
function hideError() { els.error.classList.add('hidden'); }

function cleanErrorMessage(error) {
  const msg = String(error?.message || error || 'Unable to generate the rainfall map.');
  if (/Failed to fetch|NetworkError|CORS/i.test(msg)) return 'Data request was blocked or unavailable. Try the range again; NOAA/NCEI services may be temporarily unavailable.';
  return msg;
}

function sourceDisplayName(source) {
  if (source === 'nclimgrid') return 'nClimGrid-Daily';
  if (source === 'stage3') return 'NCEP Stage III QPE';
  return 'NCEP Stage IV QPE';
}

function addGrid(target, addend) {
  for (let i = 0; i < target.length; i++) target[i] += addend[i] || 0;
}

function numeric1D(value) {
  return Array.from(flattenNumeric(value));
}

function flattenNumeric(value) {
  const out = [];
  const visit = item => {
    if (ArrayBuffer.isView(item) || Array.isArray(item)) {
      for (const v of item) visit(v);
    } else if (item !== null && item !== undefined) {
      const n = Number(item);
      if (Number.isFinite(n) || Number.isNaN(n)) out.push(n);
    }
  };
  visit(value);
  return out;
}

function finiteMax(grid) {
  let max = -Infinity;
  for (const value of grid) if (Number.isFinite(value) && value > max) max = value;
  return max;
}

function looksLikeDegrees(bbox) {
  return bbox.every((v, i) => Number.isFinite(v) && (i % 2 === 0 ? Math.abs(v) <= 180 : Math.abs(v) <= 90));
}

function splitByMonth(start, end) {
  const chunks = [];
  let cursor = new Date(start);
  while (cursor <= end) {
    const monthEnd = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 0));
    const chunkEnd = minDate(end, monthEnd);
    chunks.push({ start: new Date(cursor), end: chunkEnd });
    cursor = addDays(chunkEnd, 1);
  }
  return chunks;
}

function dateSequence(start, end) {
  const out = [];
  for (let d = new Date(start); d <= end; d = addDays(d, 1)) out.push(new Date(d));
  return out;
}

function parseDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return null;
  const d = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}
function addDays(date, days) { return new Date(date.getTime() + days * MS_PER_DAY); }
function dayCount(start, end) { return Math.round((end - start) / MS_PER_DAY) + 1; }
function minDate(a, b) { return a < b ? new Date(a) : new Date(b); }
function maxDate(a, b) { return a > b ? new Date(a) : new Date(b); }
function clamp(v, min, max) { return Math.min(max, Math.max(min, v)); }
function isoDate(d) { return d.toISOString().slice(0, 10); }
function compactDate(d) { return isoDate(d).replaceAll('-', ''); }
function year(d) { return String(d.getUTCFullYear()); }
function month(d) { return String(d.getUTCMonth() + 1).padStart(2, '0'); }
function day(d) { return String(d.getUTCDate()).padStart(2, '0'); }
function shortDate(d) { return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }); }
function formatDate(d) { return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }); }
function formatRange(start, end) { return `${formatDate(start)} – ${formatDate(end)}`; }
