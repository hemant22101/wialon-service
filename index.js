require('dotenv').config();
const express = require('express');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 10000;
const WIALON_URL = 'https://hst-api.wialon.com/wialon/ajax.html';
const TOKEN = process.env.WIALON_TOKEN || '0f2f81f1b6be4d0fecfad332f8b1e70aD8816EA7AFCB7791C22A44BFA7F56AB50DA0634F';
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
  const providedKey = req.headers['x-api-key'] || req.query.apiKey;
  if (providedKey !== CLIENT_API_KEY) {
    return res.status(401).json({ status: 'error', message: 'Unauthorized: Invalid API key' });
  }

  try {
    let eid = await getSession();

    const searchParams = {
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
    };

    let result = await axios.get(WIALON_URL, {
      params: {
        svc: 'core/search_items',
        params: JSON.stringify(searchParams),
        sid: eid
      }
    });

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
  console.log(`Server running on port ${PORT}`);
});
