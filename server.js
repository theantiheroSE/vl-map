require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const GtfsRealtimeBindings = require('gtfs-realtime-bindings');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.TRAFIKLAB_API_KEY;

if (!API_KEY) {
  console.error('ERROR: TRAFIKLAB_API_KEY is not set in .env');
  process.exit(1);
}

// Color palette for different line numbers
const LINE_COLORS = {
  1: '#ef4444', 2: '#f97316', 3: '#eab308', 4: '#22c55e', 5: '#06b6d4',
  6: '#0ea5e9', 7: '#3b82f6', 8: '#8b5cf6', 9: '#d946ef', 10: '#ec4899',
  11: '#f43f5e', 12: '#d97706', 13: '#84cc16', 14: '#10b981', 15: '#14b8a6',
  16: '#06b6d4', 17: '#0284c7', 18: '#7c3aed', 19: '#db2777', 20: '#ea580c',
  25: '#3b82f6', 30: '#06b6d4', 40: '#10b981', 50: '#8b5cf6',
};

function getLineColor(lineNumber) {
  if (!lineNumber || lineNumber === '?') return '#64748b';
  
  // Check if exact line number exists in palette
  if (LINE_COLORS[parseInt(lineNumber)]) {
    return LINE_COLORS[parseInt(lineNumber)];
  }
  
  // Generate color based on line number hash
  const num = parseInt(lineNumber) || 0;
  const colors = Object.values(LINE_COLORS);
  return colors[num % colors.length];
}

function loadRoutes() {
  try {
    const file = fs.readFileSync(
      path.join(__dirname, 'gtfs-vl/routes.txt'),
      'utf8'
    );

    const lines = file.split('\n');
    const header = lines.shift().split(',');

    const idxRouteId = header.indexOf('route_id');
    const idxShortName = header.indexOf('route_short_name');
    const idxColor = header.indexOf('route_color');
    const idxTextColor = header.indexOf('route_text_color');

    const routes = {};

    for (const line of lines) {
      if (!line) continue;

      const cols = line.split(',');

      if (idxRouteId < 0 || idxRouteId >= cols.length ||
          idxShortName < 0 || idxShortName >= cols.length) {
        continue;
      }

      const lineNumber = cols[idxShortName];
      const hasCustomColor = idxColor >= 0 && cols[idxColor];
      const color = hasCustomColor ? '#' + cols[idxColor] : getLineColor(lineNumber);

      routes[cols[idxRouteId]] = {
        line: lineNumber || '?',
        color: color,
        textColor: (idxTextColor >= 0 && cols[idxTextColor]) ? '#' + cols[idxTextColor] : '#FFFFFF',
      };
    }

    console.log(`Loaded ${Object.keys(routes).length} routes`);
    return routes;

  } catch (err) {
    console.error('Failed to load routes.txt:', err.message);
    return {};
  }
}

function loadTrips() {
  try {
    const file = fs.readFileSync(
      path.join(__dirname, 'gtfs-vl/trips.txt'),
      'utf8'
    );

    const lines = file.split('\n');
    const header = lines.shift().split(',');

    const idxTripId = header.indexOf('trip_id');
    const idxRouteId = header.indexOf('route_id');

    const trips = {};

    for (const line of lines) {
      if (!line) continue;

      const cols = line.split(',');

      if (idxTripId < 0 || idxTripId >= cols.length ||
          idxRouteId < 0 || idxRouteId >= cols.length) {
        continue;
      }

      trips[cols[idxTripId]] = {
        routeId: cols[idxRouteId],
      };
    }

    console.log(`Loaded ${Object.keys(trips).length} trips`);
    return trips;

  } catch (err) {
    console.error('Failed to load trips.txt:', err.message);
    return {};
  }
}

const ROUTES = loadRoutes();
const TRIPS = loadTrips();

let vehicleCache = [];
let lastFetched = null;
let fetchError = null;

const FEED_URL = `https://opendata.samtrafiken.se/gtfs-rt/vastmanland/VehiclePositions.pb?key=${API_KEY}`;

const ROUTE_TYPE_LABELS = {
  0: 'Spårvagn',
  1: 'Tunnelbana',
  2: 'Tåg',
  3: 'Buss',
  4: 'Färja',
  100: 'Tåg',
  200: 'Buss',
  700: 'Buss',
  900: 'Spårvagn',
};

async function fetchVehiclePositions() {
  try {
    const response = await fetch(FEED_URL, {
      headers: { 'Accept-Encoding': 'gzip' },
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const buffer = await response.buffer();
    const feed = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(
      new Uint8Array(buffer)
    );

    const vehicles = [];

    for (const entity of feed.entity) {
      if (!entity.vehicle) continue;

      const v = entity.vehicle;
      const pos = v.position;
      const trip = v.trip;
      const vehicleDesc = v.vehicle;

      if (!pos || !pos.latitude || !pos.longitude) continue;

      let routeId =
        trip && trip.routeId
          ? trip.routeId
          : trip && trip.route_id
          ? trip.route_id
          : null;

      if (!routeId && trip && trip.tripId && TRIPS[trip.tripId]) {
        routeId = TRIPS[trip.tripId].routeId;
      }

      const cleanRouteId =
        routeId
          ? routeId.split('_')[0]
          : null;

      const routeMeta = ROUTES[cleanRouteId] || {};

      vehicles.push({
        id: entity.id,
        lat: pos.latitude,
        lng: pos.longitude,
        bearing: pos.bearing || 0,
        speed: pos.speed ? Math.round(pos.speed * 3.6) : null,
        routeId,
        line: routeMeta.line || '?',
        color: routeMeta.color || '#64748b',
        textColor: routeMeta.textColor || '#FFFFFF',
        tripId: trip ? trip.tripId : null,
        label: vehicleDesc ? vehicleDesc.label : null,
        licensePlate: vehicleDesc ? vehicleDesc.licensePlate : null,
        timestamp: v.timestamp ? Number(v.timestamp) : null,
        currentStatus: v.currentStatus,
        stopId: v.stopId || null,
      });
    }

    vehicleCache = vehicles;
    lastFetched = new Date().toISOString();
    fetchError = null;

    console.log(`[${lastFetched}] Fetched ${vehicles.length} vehicles`);
  } catch (err) {
    fetchError = err.message;
    console.error('Failed to fetch GTFS-RT:', err.message);
  }
}

fetchVehiclePositions();
setInterval(fetchVehiclePositions, 15000);

app.use(express.static('public'));

app.get('/api/vehicles', (req, res) => {
  res.json({
    vehicles: vehicleCache,
    count: vehicleCache.length,
    lastFetched,
    error: fetchError,
  });
});

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    lastFetched,
    vehicleCount: vehicleCache.length,
    error: fetchError,
  });
});

app.listen(PORT, () => {
  console.log(`VL Map running at http://localhost:${PORT}`);
});
