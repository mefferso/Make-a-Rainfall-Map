import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('production HTML loads the map runtime wrapper', async () => {
  const html = await read('index.html');
  assert.match(html, /src=["']map-runtime\.js(?:\?[^"']+)?["']/);
  assert.doesNotMatch(html, /src=["']app\.js["']/);
});

test('production HTML cache-busts the runtime with its content hash', async () => {
  const [html, runtime] = await Promise.all([read('index.html'), read('map-runtime.js')]);
  const hash = createHash('sha256').update(runtime).digest('hex').slice(0, 8);
  assert.match(html, new RegExp(`src=["']map-runtime\\.js\\?v=${hash}["']`));
});

test('map runtime cache-busts app.js with its content hash', async () => {
  const [runtime, app] = await Promise.all([read('map-runtime.js'), read('app.js')]);
  const hash = createHash('sha256').update(app).digest('hex').slice(0, 8);
  assert.match(runtime, new RegExp(`import\\(["']\\./app\\.js\\?v=${hash}["']\\)`));
});

test('map runtime swaps to a keyless OSM basemap and stabilizes first fit', async () => {
  const runtime = await read('map-runtime.js');
  assert.match(runtime, /tile\.openstreetmap\.org/);
  assert.match(runtime, /invalidateSize/);
  assert.match(runtime, /maxBounds/);
});

test('runtime replacement keeps Leaflet tile subdomains valid', async () => {
  const runtime = (await read('map-runtime.js')).replace(
    /await import\(["']\.\/app\.js(?:\?v=[^"']+)?["']\);/,
    ''
  );
  const originalWindow = globalThis.window;
  const calls = [];

  globalThis.window = {
    L: {
      tileLayer(url, options) {
        // Leaflet 1.9.4 reads this value for every tile URL, even without {s}.
        const subdomainCount = options.subdomains.length;
        calls.push({ url, options, subdomainCount });
        return { addTo() {} };
      },
      map() {},
    },
  };

  try {
    await import(`data:text/javascript,${encodeURIComponent(runtime)}#runtime-test`);
    globalThis.window.L.tileLayer(
      'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
      { subdomains: 'abcd', maxZoom: 20 }
    );

    assert.equal(calls[0].url, 'https://tile.openstreetmap.org/{z}/{x}/{y}.png');
    assert.ok(calls[0].subdomainCount > 0);
  } finally {
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  }
});

test('production HTML no longer connects directly to CARTO', async () => {
  const html = await read('index.html');
  assert.doesNotMatch(html, /cartocdn/i);
});

test('basemap tiles are visually subdued behind rainfall', async () => {
  const css = await read('styles.css');
  assert.match(css, /\.leaflet-tile-pane\s*\{[^}]*filter:/s);
});

test('rainfall rendering does not intersect the two state masks', async () => {
  const app = await read('app.js');
  const start = app.indexOf('function renderRainfallCanvas');
  const end = app.indexOf('function updateRainfallLayer');
  assert.ok(start >= 0 && end > start);

  const renderer = app.slice(start, end);
  assert.doesNotMatch(renderer, /destination-in/);
});

test('Leaflet CSS uses the official 1.9.4 SRI hash', async () => {
  const html = await read('index.html');
  assert.match(
    html,
    /leaflet@1\.9\.4\/dist\/leaflet\.css[^>]+integrity=["']sha256-p4NxAoJBhIIN\+hmNHrzRCf9tD\/miZyoHS5obTRR9BMY=["']/
  );
});
