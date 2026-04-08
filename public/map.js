// ── VL Live Map ──────────────────────────────────────────────────────────────

const POLL_INTERVAL = 15000; // ms
const VL_CENTER = [59.6099, 16.5448]; // Västerås
const VL_ZOOM = 11;

// Marker colors by route type
const COLOR_BUS   = '#2563eb';
const COLOR_TRAIN = '#16a34a';
const COLOR_OTHER = '#9333ea';

let map, markerLayer;
let markers = {};
let vehicleData = {};
let selectedId = null;

// ── Init map ────────────────────────────────────────────────────────────────
function initMap() {
  map = L.map('map', {
    center: VL_CENTER,
    zoom: VL_ZOOM,
    zoomControl: false,
  });

  L.control.zoom({ position: 'bottomright' }).addTo(map);

  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/">CARTO</a> | Data: <a href="https://trafiklab.se">Trafiklab</a> / VL',
    subdomains: 'abcd',
    maxZoom: 19,
  }).addTo(map);

  markerLayer = L.layerGroup().addTo(map);
}

// ── Vehicle icon ────────────────────────────────────────────────────────────
function makeIcon(vehicle, selected) {
  const color = vehicle.color || '#333333';
  const bearing = vehicle.bearing || 0;
  const size = selected ? 36 : 28;
  const lineText = vehicle.line || '?';

  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 36 36">
      <circle cx="18" cy="18" r="17" fill="${color}" fill-opacity="${selected ? 1 : 0.85}" stroke="white" stroke-width="${selected ? 3 : 1.5}"/>
      <polygon points="18,4 22,16 18,13 14,16" fill="white" opacity="0.9"
        transform="rotate(${bearing}, 18, 18)"/>
      <text x="18" y="22" text-anchor="middle" fill="white" font-size="9" font-family="monospace" font-weight="bold">${lineText}</text>
    </svg>`;

  return L.divIcon({
    html: svg,
    className: '',
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
}

// ── Fetch & update ──────────────────────────────────────────────────────────
async function fetchVehicles() {
  try {
    const res = await fetch('/api/vehicles');
    const data = await res.json();

    updateStatus(data);
    updateMarkers(data.vehicles);
  } catch (err) {
    console.error('Poll error:', err);
    setStatusError('Kunde inte hämta fordonsdata');
  }
}

function updateMarkers(vehicles) {
  const seen = new Set();

  for (const v of vehicles) {
    seen.add(v.id);
    vehicleData[v.id] = v;

    if (markers[v.id]) {
      // Smooth move existing marker
      markers[v.id].setLatLng([v.lat, v.lng]);
      markers[v.id].setIcon(makeIcon(v, selectedId === v.id));
    } else {
      // Create new marker
      const m = L.marker([v.lat, v.lng], { icon: makeIcon(v, false) });
      m.on('click', () => selectVehicle(v.id));
      m.addTo(markerLayer);
      markers[v.id] = m;
    }
  }

  // Remove stale markers
  for (const id of Object.keys(markers)) {
    if (!seen.has(id)) {
      markerLayer.removeLayer(markers[id]);
      delete markers[id];
      delete vehicleData[id];
    }
  }

  // Update count
  document.getElementById('vehicle-count').textContent = vehicles.length;
}

// ── Vehicle selection / sidebar ────────────────────────────────���────────────
function selectVehicle(id) {
  if (selectedId && markers[selectedId]) {
    markers[selectedId].setIcon(makeIcon(vehicleData[selectedId], false));
  }

  selectedId = id;
  const v = vehicleData[id];
  if (!v) return;

  markers[id].setIcon(makeIcon(v, true));
  map.panTo([v.lat, v.lng]);
  showSidebar(v);
}

function showSidebar(v) {
  const panel = document.getElementById('info-panel');
  panel.classList.add('visible');

  const statusLabels = {
    0: 'Inkommande till hållplats',
    1: 'Stannar vid hållplats',
    2: 'På väg',
  };

  document.getElementById('info-route').textContent   = v.line || '?';
  document.getElementById('info-label').textContent   = v.label || v.id;
  document.getElementById('info-speed').textContent   = v.speed != null ? `${v.speed} km/h` : '—';
  document.getElementById('info-bearing').textContent = v.bearing != null ? `${Math.round(v.bearing)}°` : '—';
  document.getElementById('info-status').textContent  = statusLabels[v.currentStatus] ?? '—';
  document.getElementById('info-lat').textContent     = v.lat.toFixed(5);
  document.getElementById('info-lng').textContent     = v.lng.toFixed(5);

  const age = v.timestamp ? Math.round((Date.now() / 1000) - v.timestamp) : null;
  document.getElementById('info-age').textContent = age != null ? `${age}s sedan` : '—';
}

function closeSidebar() {
  if (selectedId && markers[selectedId]) {
    markers[selectedId].setIcon(makeIcon(vehicleData[selectedId], false));
  }
  selectedId = null;
  document.getElementById('info-panel').classList.remove('visible');
}

// ── Status bar ───────────────────────────────────────────────────────────────
function updateStatus(data) {
  const el = document.getElementById('status-text');
  if (data.error) {
    el.textContent = `Fel: ${data.error}`;
    el.style.color = '#f87171';
  } else {
    const t = data.lastFetched ? new Date(data.lastFetched).toLocaleTimeString('sv-SE') : '—';
    el.textContent = `Uppdaterad ${t}`;
    el.style.color = '#86efac';
  }
}

function setStatusError(msg) {
  const el = document.getElementById('status-text');
  el.textContent = msg;
  el.style.color = '#f87171';
}

// ── Filters ─────────────────────────────────────────────────────────────────
let showBuses = true, showTrains = true;

function toggleFilter(type) {
  if (type === 'bus')   showBuses  = !showBuses;
  if (type === 'train') showTrains = !showTrains;

  for (const [id, v] of Object.entries(vehicleData)) {
    // Determine visibility based on route type or color
    const visible = showBuses || showTrains;
    if (visible) {
      if (!markerLayer.hasLayer(markers[id])) markers[id].addTo(markerLayer);
    } else {
      markerLayer.removeLayer(markers[id]);
    }
  }

  document.getElementById('btn-bus').classList.toggle('inactive', !showBuses);
  document.getElementById('btn-train').classList.toggle('inactive', !showTrains);
}

// ── Boot ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  initMap();
  fetchVehicles();
  setInterval(fetchVehicles, POLL_INTERVAL);

  document.getElementById('close-panel').addEventListener('click', closeSidebar);
  document.getElementById('btn-bus').addEventListener('click', () => toggleFilter('bus'));
  document.getElementById('btn-train').addEventListener('click', () => toggleFilter('train'));
});
