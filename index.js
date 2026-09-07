require('dotenv').config();
const express = require('express');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 10000;
const WIALON_URL = 'https://hst-api.wialon.com/wialon/ajax.html';
const TOKEN = process.env.WIALON_TOKEN;
const CLIENT_API_KEY = process.env.CLIENT_API_KEY || 'my_secret_client_key_123';

let sessionId = null;

async function getSession() {
  if (sessionId) return sessionId;

  const response = await axios.get(WIALON_URL, {
    params: {
      svc: 'token/login',
      params: JSON.stringify({ token: TOKEN })
    }
  });

  if (response.data.error) {
    throw new Error(`Wialon login failed. Error code: ${response.data.error}`);
  }

  sessionId = response.data.eid;
  return sessionId;
}

app.get('/', (req, res) => {
  res.json({ status: 'running', message: 'Wialon Proxy Service is Online' });
});

app.get('/api/vehicles', async (req, res) => {
  // 1. Validate API Key
  const providedKey = req.headers['x-api-key'] || req.query.apiKey;
  if (providedKey !== CLIENT_API_KEY) {
    return res.status(401).json({ status: 'error', message: 'Unauthorized: Invalid API key' });
  }

  // 2. Extract Query Parameters (Pagination & Search)
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 0; // 0 returns all units
  const searchMask = req.query.search ? `*${req.query.search}*` : '*';

  // Calculate range indices for Wialon
  const from = limit > 0 ? (page - 1) * limit : 0;
  const to = limit > 0 ? from + limit - 1 : 0;

  try {
    let eid = await getSession();

    const searchParams = {
      spec: {
        itemsType: 'avl_unit',
        propName: 'sys_name',
        propValueMask: searchMask,
        sortType: 'sys_name'
      },
      force: 1,
      flags: 1025, // 1: base unit info, 1024: last known position
      from: from,
      to: to
    };

    let result = await axios.get(WIALON_URL, {
      params: {
        svc: 'core/search_items',
        params: JSON.stringify(searchParams),
        sid: eid
      }
    });

    // Refresh session if expired (Error code 1)
    if (result.data.error === 1) {
      sessionId = null;
      eid = await getSession();
      result = await axios.get(WIALON_URL, {
        params: {
          svc: 'core/search_items',
          params: JSON.stringify(searchParams),
          sid: eid
        }
      });
    }

    if (result.data.error) {
      return res.status(400).json({ error: `Wialon error code: ${result.data.error}` });
    }

    // Map clean vehicle attributes
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
      totalMatches: result.data.totalItemsCount || vehicles.length,
      returnedCount: vehicles.length,
      page: limit > 0 ? page : 1,
      data: vehicles
    });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});
