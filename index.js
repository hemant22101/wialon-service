require('dotenv').config();
const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json({ limit: '10mb' }));

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

function parseMetric(val) {
  if (!val) return 0;
  const raw = typeof val === 'object' ? val.t : val;
  const cleaned = String(raw).replace(/[^\d.-]/g, '');
  return parseFloat(cleaned) || 0;
}

function parseDurationToHours(timeStr) {
  const raw = typeof timeStr === 'object' ? timeStr.t : timeStr;
  if (!raw || !String(raw).includes(':')) return 0;
  const parts = String(raw).split(':').map(Number);
  const hours = parts[0] || 0;
  const minutes = parts[1] || 0;
  const seconds = parts[2] || 0;
  return +(hours + minutes / 60 + seconds / 3600).toFixed(2);
}

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'running', message: 'Wialon Proxy Service is Online' });
});

// 1. Live Vehicles
app.get('/api/vehicles', async (req, res) => {
  const providedKey = req.headers['x-api-key'] || req.query.apiKey;
  if (providedKey !== CLIENT_API_KEY) {
    return res.status(401).json({ status: 'error', message: 'Unauthorized: Invalid API key' });
  }

  try {
    let eid = await getSession();

    const searchParams = {
      spec: { itemsType: 'avl_unit', propName: 'sys_name', propValueMask: '*', sortType: 'sys_name' },
      force: 1,
      flags: 1025,
      from: 0,
      to: 0
    };

    let result = await axios.get(WIALON_URL, {
      params: { svc: 'core/search_items', params: JSON.stringify(searchParams), sid: eid }
    });

    if (result.data.error === 1) {
      sessionId = null;
      eid = await getSession();
      result = await axios.get(WIALON_URL, {
        params: { svc: 'core/search_items', params: JSON.stringify(searchParams), sid: eid }
      });
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

    res.json({ status: 'success', count: vehicles.length, data: vehicles });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// 2. Automated Clean Report Generator
app.get('/api/reports/summary', async (req, res) => {
  const providedKey = req.headers['x-api-key'] || req.query.apiKey;
  if (providedKey !== CLIENT_API_KEY) {
    return res.status(401).json({ status: 'error', message: 'Unauthorized: Invalid API key' });
  }

  // Use your discovered defaults if not passed in query
  const resourceId = parseInt(req.query.resourceId) || 30326456;
  const templateId = parseInt(req.query.templateId) || 2;
  const objectId = parseInt(req.query.objectId) || 30185490;

  // Default to today's timestamps if not provided
  const from = parseInt(req.query.from) || 1788719400;
  const to = parseInt(req.query.to) || 1788805799;

  try {
    let eid = await getSession();

    // 1. Run the report on Wialon
    const execParams = {
      reportResourceId: resourceId,
      reportTemplateId: templateId,
      reportObjectId: objectId,
      reportObjectSecId: 0,
      interval: {
        from: from,
        to: to,
        flags: 16777216
      }
    };

    let execRes = await axios.get(WIALON_URL, {
      params: { svc: 'report/exec_report', params: JSON.stringify(execParams), sid: eid }
    });

    if (execRes.data.error === 1) {
      sessionId = null;
      eid = await getSession();
      execRes = await axios.get(WIALON_URL, {
        params: { svc: 'report/exec_report', params: JSON.stringify(execParams), sid: eid }
      });
    }

    if (execRes.data.error) {
      return res.status(400).json({ error: `Wialon exec_report error: ${execRes.data.error}` });
    }

    // 2. Extract rows from table index 0
    const rowParams = {
      tableIndex: 0,
      config: {
        type: 'range',
        data: { from: 0, to: 500, level: 0 }
      }
    };

    const rowsRes = await axios.get(WIALON_URL, {
      params: { svc: 'report/select_result_rows', params: JSON.stringify(rowParams), sid: eid }
    });

    // 3. Clear report cache from Wialon server
    await axios.get(WIALON_URL, {
      params: { svc: 'report/cleanup_result', params: '{}', sid: eid }
    });

    const rawRows = rowsRes.data || [];

    // 4. Sanitize columns into clean numbers
    const cleanReport = rawRows.map((row, idx) => {
      const cols = row.c || [];
      return {
        index: idx + 1,
        rowLabel: typeof cols[0] === 'object' ? cols[0].t : cols[0],
        distanceKm: parseMetric(cols[1]),
        engineHoursFormatted: typeof cols[2] === 'object' ? cols[2].t : (cols[2] || '0:00:00'),
        engineHoursDecimal: parseDurationToHours(cols[2]),
        fuelConsumedLiters: parseMetric(cols[3]),
        fuelOpeningLiters: parseMetric(cols[4]),
        fuelClosingLiters: parseMetric(cols[5]),
        rawColumns: cols.map(c => (typeof c === 'object' ? c.t : c))
      };
    });

    res.json({
      status: 'success',
      period: {
        fromTimestamp: from,
        toTimestamp: to,
        fromDate: new Date(from * 1000).toISOString(),
        toDate: new Date(to * 1000).toISOString()
      },
      totalRows: cleanReport.length,
      report: cleanReport
    });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});
