@'
require('dotenv').config();
const express = require('express');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;
const WIALON_URL = process.env.WIALON_HOST || 'https://hst-api.wialon.com/wialon/ajax.html';
const TOKEN = process.env.WIALON_TOKEN;
const CLIENT_API_KEY = process.env.CLIENT_API_KEY || 'my_secret_client_key_123';

let sessionId = null;

async function getSession() {
  if (sessionId) return sessionId;

  const loginParams = JSON.stringify({ token: TOKEN });
  const url = `${WIALON_URL}?svc=token/login&params=${encodeURIComponent(loginParams)}`;

  const response = await axios.get(url);
  if (response.data.error) {
    throw new Error(`Wialon login failed. Error code: ${response.data.error}`);
  }

  sessionId = response.data.eid;
  return sessionId;
}

// Endpoint with API key validation
app.get('/api/vehicles', async (req, res) => {
  // Check authorization header or query param
  const providedKey = req.headers['x-api-key'] || req.query.apiKey;
  if (providedKey !== CLIENT_API_KEY) {
    return res.status(401).json({ status: 'error', message: 'Unauthorized: Invalid API key' });
  }

  try {
    let eid = await getSession();

    const searchParams = JSON.stringify({
      spec: {
        itemsType: 'avl_unit',
        propName: 'sys_name',
        propValueMask: '*',
        sortType: 'sys_name'
      },
      force: 1,
      flags: 1025,
      from: 0,
      to: 0
    });

    let queryUrl = `${WIALON_URL}?svc=core/search_items&params=${encodeURIComponent(searchParams)}&sid=${eid}`;
    let result = await axios.get(queryUrl);

    if (result.data.error === 1) {
      sessionId = null;
      eid = await getSession();
      queryUrl = `${WIALON_URL}?svc=core/search_items&params=${encodeURIComponent(searchParams)}&sid=${eid}`;
      result = await axios.get(queryUrl);
    }

    if (result.data.error) {
      return res.status(400).json({ error: `Wialon error code: ${result.data.error}` });
    }

    const vehicles = (result.data.items || []).map((unit) => ({
      unitId: unit.id,
      unitName: unit.nm,
      latitude: unit.pos ? unit.pos.y : null,
      longitude: unit.pos ? unit.pos.x : null,
      speedKmh: unit.pos ? unit.pos.s : 0,
      heading: unit.pos ? unit.pos.c : 0,
      lastSeen: unit.pos ? new Date(unit.pos.t * 1000).toISOString() : null
    }));

    res.json({
      status: 'success',
      count: vehicles.length,
      data: vehicles
    });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
'@ | Out-File -FilePath index.js -Encoding utf8