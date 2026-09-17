const L = window.L;

if (!L) {
  throw new Error('Leaflet failed to load.');
}

const originalTileLayer = L.tileLayer.bind(L);
L.tileLayer = function patchedTileLayer(url, options = {}) {
  if (typeof url === 'string' && url.includes('basemaps.cartocdn.com')) {
    return originalTileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      ...options,
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap contributors',
    });
  }
  return originalTileLayer(url, options);
};

const originalMapFactory = L.map.bind(L);
L.map = function patchedMapFactory(id, options = {}) {
  const map = originalMapFactory(id, {
    ...options,
    maxBounds: [[27.6, -95.5], [36.2, -86.4]],
    maxBoundsViscosity: 0.85,
  });

  const originalFitBounds = map.fitBounds.bind(map);
  let firstFit = true;

  map.fitBounds = function stableFitBounds(bounds, fitOptions = {}) {
    if (!firstFit) return originalFitBounds(bounds, fitOptions);
    firstFit = false;

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        map.invalidateSize(false);
        originalFitBounds(bounds, {
          ...fitOptions,
          padding: [24, 24],
          animate: false,
        });
      });
    });

    return map;
  };

  return map;
};

await import('./app.js');
