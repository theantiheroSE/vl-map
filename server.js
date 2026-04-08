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

      // Only check required columns, color columns are optional
      if (idxRouteId < 0 || idxRouteId >= cols.length ||
          idxShortName < 0 || idxShortName >= cols.length) {
        continue;
      }

      routes[cols[idxRouteId]] = {
        line: cols[idxShortName] || '?',
        color: (idxColor >= 0 && cols[idxColor]) ? '#' + cols[idxColor] : '#333333',
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
        color: routeMeta.color || '#333333',
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
