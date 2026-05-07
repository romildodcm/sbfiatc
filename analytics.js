// ==========================================
// ANALYTICS DASHBOARD — Hidden Panel
// ==========================================
(function () {
  'use strict';

  const ANALYTICS_API = 'https://adsb.io.tec.br/api/analytics';
  const STORAGE_KEY = 'adsb_dashboard_key';
  const TRIGGER_CLICKS = 5;
  const TRIGGER_TIMEOUT_MS = 3000;

  let triggerClicks = 0;
  let triggerTimer = null;
  let analyticsTrails = {}; // { icaoKey: { layers: [], data: {} } }
  let currentFlights = []; // cached flight list for current view
  let filterText = '';
  let activePreset = 0; // 0=today

  // ==========================================
  // AUTH
  // ==========================================
  function getKey() {
    return localStorage.getItem(STORAGE_KEY);
  }

  function setKey(key) {
    localStorage.setItem(STORAGE_KEY, key);
  }

  function clearKey() {
    localStorage.removeItem(STORAGE_KEY);
  }

  function authHeaders() {
    return { 'X-Dashboard-Key': getKey() };
  }

  async function validateKey(key) {
    try {
      const res = await fetch(`${ANALYTICS_API}/daily`, {
        headers: { 'X-Dashboard-Key': key },
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  // ==========================================
  // SECRET TRIGGER
  // ==========================================
  function setupTrigger() {
    const trigger = document.getElementById('analyticsTrigger');
    if (!trigger) return;

    trigger.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      triggerClicks++;

      if (triggerClicks === 1) {
        triggerTimer = setTimeout(() => { triggerClicks = 0; }, TRIGGER_TIMEOUT_MS);
      }

      if (triggerClicks >= TRIGGER_CLICKS) {
        triggerClicks = 0;
        clearTimeout(triggerTimer);
        showLogin();
      }
    });
  }

  // ==========================================
  // LOGIN
  // ==========================================
  function showLogin() {
    const login = document.getElementById('analyticsLogin');
    const input = document.getElementById('analyticsKeyInput');
    const error = login.querySelector('.login-error');
    error.classList.remove('visible');
    login.classList.add('visible');
    setTimeout(() => input.focus(), 100);
  }

  function hideLogin() {
    const login = document.getElementById('analyticsLogin');
    login.classList.remove('visible');
    document.getElementById('analyticsKeyInput').value = '';
  }

  async function handleLogin() {
    const input = document.getElementById('analyticsKeyInput');
    const error = document.querySelector('.analytics-login .login-error');
    const key = input.value.trim();

    if (!key) return;

    const valid = await validateKey(key);
    if (valid) {
      setKey(key);
      hideLogin();
      showToggleBtn();
      showPanel();
      setPreset(0);
    } else {
      error.classList.add('visible');
      setTimeout(() => error.classList.remove('visible'), 2500);
    }
  }

  // ==========================================
  // PANEL VISIBILITY
  // ==========================================
  function showPanel() {
    const panel = document.getElementById('analyticsPanel');
    panel.classList.add('visible');
  }

  function hidePanel() {
    const panel = document.getElementById('analyticsPanel');
    panel.classList.remove('visible');
  }

  function showToggleBtn() {
    const btn = document.getElementById('analyticsToggleBtn');
    if (btn) btn.style.display = '';
  }

  function hideToggleBtn() {
    const btn = document.getElementById('analyticsToggleBtn');
    if (btn) btn.style.display = 'none';
  }

  let dataLoaded = false;

  function togglePanel() {
    const panel = document.getElementById('analyticsPanel');
    if (panel.classList.contains('visible')) {
      hidePanel();
    } else {
      showPanel();
    }
  }

  function logout() {
    clearKey();
    hidePanel();
    hideToggleBtn();
    clearAllTrails();
    dataLoaded = false;
  }

  // ==========================================
  // PERIOD PRESETS
  // ==========================================
  function getPresetRange(days) {
    const to = new Date();
    const from = new Date();
    from.setDate(from.getDate() - days);
    return {
      from: from.toISOString().slice(0, 10),
      to: to.toISOString().slice(0, 10),
    };
  }

  function setPreset(days) {
    activePreset = days;
    const range = getPresetRange(days);
    document.getElementById('analyticsPeriodFrom').value = range.from;
    document.getElementById('analyticsPeriodTo').value = range.to;
    // Highlight active preset
    document.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('active'));
    const btn = document.querySelector(`[data-preset="${days}"]`);
    if (btn) btn.classList.add('active');
    loadData();
  }

  // ==========================================
  // FETCH DATA
  // ==========================================
  async function fetchApi(path) {
    const res = await fetch(`${ANALYTICS_API}${path}`, { headers: authHeaders() });
    if (res.status === 401) {
      clearKey();
      hidePanel();
      return null;
    }
    if (!res.ok) return null;
    return res.json();
  }

  function isToday() {
    const from = document.getElementById('analyticsPeriodFrom').value;
    const to = document.getElementById('analyticsPeriodTo').value;
    const today = new Date().toISOString().slice(0, 10);
    return from === today && to === today;
  }

  function loadData() {
    clearAllTrails();
    if (isToday()) {
      loadDailyData();
    } else {
      loadPeriodData();
    }
  }

  async function loadDailyData() {
    const content = document.getElementById('analyticsContent');
    content.innerHTML = '<div class="analytics-loading">Carregando...</div>';

    const today = new Date().toISOString().slice(0, 10);
    const fromUtc = `${today}T00:00:00Z`;
    const toUtc = `${today}T23:59:59Z`;

    const [data, flightsData] = await Promise.all([
      fetchApi('/daily'),
      fetchApi(`/flights?from=${fromUtc}&to=${toUtc}&pageSize=200`),
    ]);
    if (!data) return;

    currentFlights = flightsData?.flights || [];
    renderDaily(data);
  }

  async function loadPeriodData() {
    const fromInput = document.getElementById('analyticsPeriodFrom');
    const toInput = document.getElementById('analyticsPeriodTo');
    const from = fromInput.value;
    const to = toInput.value;

    if (!from || !to) return;

    const content = document.getElementById('analyticsContent');
    content.innerHTML = '<div class="analytics-loading">Carregando...</div>';

    const fromUtc = new Date(from + 'T00:00:00Z').toISOString();
    const toUtc = new Date(to + 'T23:59:59Z').toISOString();

    const [periodData, flightsData] = await Promise.all([
      fetchApi(`/period?from=${fromUtc}&to=${toUtc}`),
      fetchApi(`/flights?from=${fromUtc}&to=${toUtc}&pageSize=200`),
    ]);

    currentFlights = flightsData?.flights || [];
    renderPeriod(periodData, content);
  }

  // ==========================================
  // TRAIL PLOTTING (matches live trail style)
  // ==========================================
  function getAltColor(altFt) {
    // Mirror the live altitudeToColor function
    const isRed = document.documentElement.getAttribute('data-theme') === 'red';
    const a = Math.max(0, Math.min(45000, altFt || 0));
    const t = a / 45000;

    if (isRed) {
      const r = Math.round(80 + t * 175);
      const g = Math.round(0 + t * 30);
      const b = Math.round(0 + t * 20);
      return `rgb(${r},${g},${b})`;
    }

    const r = Math.round(0 + t * 30);
    const g = Math.round(80 + t * 175);
    const b = Math.round(0 + t * 20);
    return `rgb(${r},${g},${b})`;
  }

  function flightKey(flight) {
    return `${flight.icaoHex}_${flight.startTime}`;
  }

  function isPlotted(flight) {
    return !!analyticsTrails[flightKey(flight)];
  }

  async function toggleFlight(flight) {
    const key = flightKey(flight);
    if (analyticsTrails[key]) {
      removePlot(key);
    } else {
      await plotFlight(flight);
    }
    renderFlightList();
  }

  async function plotFlight(flight, skipFit = false) {
    const data = await fetchApi(`/flights/${flight.icaoHex}/trail?from=${flight.startTime}&to=${flight.endTime}`);
    if (!data || !data.trail || data.trail.length < 2) return;

    const key = flightKey(flight);
    const layers = [];
    const trail = data.trail;

    // Draw segments colored by altitude (same as live)
    for (let i = 0; i < trail.length - 1; i++) {
      const p1 = trail[i];
      const p2 = trail[i + 1];
      const avgAlt = ((p1.alt || 0) + (p2.alt || 0)) / 2;
      const color = getAltColor(avgAlt);

      const line = L.polyline(
        [[p1.lat, p1.lon], [p2.lat, p2.lon]],
        {
          color: color,
          weight: 2.5,
          opacity: 0.4 + (i / trail.length) * 0.6,
          interactive: false,
        }
      ).addTo(map);
      layers.push(line);
    }

    // Vertex dots
    trail.forEach((p, i) => {
      const opacity = 0.3 + (i / trail.length) * 0.7;
      const circle = L.circleMarker([p.lat, p.lon], {
        radius: 2,
        color: getAltColor(p.alt || 0),
        fillColor: getAltColor(p.alt || 0),
        fillOpacity: opacity,
        weight: 0,
        interactive: false,
      }).addTo(map);
      layers.push(circle);
    });

    // Aircraft icon at the end of trail (last position)
    const lastPt = trail[trail.length - 1];
    const prevPt = trail[trail.length - 2];
    const bearing = calcBearing(prevPt.lat, prevPt.lon, lastPt.lat, lastPt.lon);
    const acColor = getAltColor(lastPt.alt || 0);
    const svg = `<svg width="20" height="20" viewBox="0 0 20 20" xmlns="http://www.w3.org/2000/svg" style="transform:rotate(${bearing}deg)">
      <polygon points="10,1 4,18 10,14 16,18" fill="${acColor}" fill-opacity="0.9" stroke="${acColor}" stroke-width="0.5"/>
    </svg>`;
    const label = flight.callsign || flight.icaoHex;
    const endMarker = L.marker([lastPt.lat, lastPt.lon], {
      icon: L.divIcon({
        className: 'analytics-trail-end-icon',
        html: `<div style="display:flex;align-items:center;gap:4px;">${svg}<span style="color:${acColor};font-size:9px;font-family:'Roboto Mono',monospace;white-space:nowrap;text-shadow:0 0 4px rgba(0,0,0,0.8);">${label}</span></div>`,
        iconSize: [0, 0],
        iconAnchor: [10, 10],
      }),
      interactive: false,
    }).addTo(map);
    layers.push(endMarker);

    analyticsTrails[key] = { layers, data: flight };

    // Fit map (skip when plotting in batch)
    if (!skipFit) {
      const bounds = L.latLngBounds(trail.map(p => [p.lat, p.lon]));
      map.fitBounds(bounds.pad(0.1));
    }

    updateClearBtn();
  }

  function removePlot(key) {
    if (!analyticsTrails[key]) return;
    analyticsTrails[key].layers.forEach(l => map.removeLayer(l));
    delete analyticsTrails[key];
    updateClearBtn();
  }

  async function plotAllFlights() {
    const filtered = getFilteredFlights();
    for (const f of filtered) {
      if (!isPlotted(f)) {
        await plotFlight(f, true);
      }
    }
    // Fit bounds to all plotted trails at once
    const allPoints = [];
    Object.values(analyticsTrails).forEach(t => {
      t.layers.forEach(l => {
        if (l.getLatLng) allPoints.push(l.getLatLng());
        else if (l.getLatLngs) l.getLatLngs().forEach(p => allPoints.push(p));
      });
    });
    if (allPoints.length > 0) {
      map.fitBounds(L.latLngBounds(allPoints).pad(0.1));
    }
    renderFlightList();
  }

  function clearAllTrails() {
    Object.keys(analyticsTrails).forEach(key => {
      analyticsTrails[key].layers.forEach(l => map.removeLayer(l));
    });
    analyticsTrails = {};
    updateClearBtn();
    renderFlightList();
  }

  function updateClearBtn() {
    const btn = document.getElementById('analyticsClearBtn');
    if (btn) {
      const hasTrails = Object.keys(analyticsTrails).length > 0;
      btn.classList.toggle('visible', hasTrails);
    }
  }

  function calcBearing(lat1, lon1, lat2, lon2) {
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const y = Math.sin(dLon) * Math.cos(lat2 * Math.PI / 180);
    const x = Math.cos(lat1 * Math.PI / 180) * Math.sin(lat2 * Math.PI / 180) -
              Math.sin(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.cos(dLon);
    return ((Math.atan2(y, x) * 180 / Math.PI) + 360) % 360;
  }

  // ==========================================
  // FILTER
  // ==========================================
  function getFilteredFlights() {
    if (!filterText) return currentFlights;
    const q = filterText.toLowerCase();
    return currentFlights.filter(f =>
      (f.callsign && f.callsign.toLowerCase().includes(q)) ||
      f.icaoHex.toLowerCase().includes(q)
    );
  }

  function onFilterInput(e) {
    filterText = e.target.value.trim();
    renderFlightList();
  }

  // ==========================================
  // AIRCRAFT SEARCH (uses /api/analytics/aircraft endpoint)
  // ==========================================
  let searchDebounceTimer = null;

  function onAircraftSearchInput(e) {
    const q = e.target.value.trim();
    clearTimeout(searchDebounceTimer);

    if (q.length < 2) {
      hideSearchResults();
      return;
    }

    searchDebounceTimer = setTimeout(() => searchAircraft(q), 400);
  }

  async function searchAircraft(q) {
    const resultsEl = document.getElementById('analyticsSearchResults');
    if (!resultsEl) return;

    resultsEl.innerHTML = '<div class="analytics-search-item" style="color:var(--radar-text-dim)">Buscando...</div>';
    resultsEl.classList.add('visible');

    let url = `/aircraft?q=${encodeURIComponent(q)}`;
    const from = document.getElementById('analyticsPeriodFrom').value;
    const to = document.getElementById('analyticsPeriodTo').value;
    if (from && to) {
      url += `&from=${new Date(from + 'T00:00:00Z').toISOString()}&to=${new Date(to + 'T23:59:59Z').toISOString()}`;
    }

    const data = await fetchApi(url);
    if (!data || !data.results || data.results.length === 0) {
      resultsEl.innerHTML = '<div class="analytics-search-item" style="color:var(--radar-text-dim)">Nenhum resultado</div>';
      return;
    }

    resultsEl.innerHTML = data.results.map(r => {
      const label = r.callsign || r.icaoHex;
      const firstSeen = new Date(r.firstSeen).toLocaleDateString('pt-BR');
      const lastSeen = new Date(r.lastSeen).toLocaleDateString('pt-BR');
      return `
        <div class="analytics-search-item" data-icao="${r.icaoHex}">
          <div class="search-callsign">${label} <span style="opacity:0.5;font-weight:400">(${r.icaoHex})</span></div>
          <div class="search-meta">${r.flightCount} voos · ${formatNum(r.totalPositions)} pts · ${firstSeen}–${lastSeen}</div>
        </div>`;
    }).join('');

    // Attach click listeners
    resultsEl.querySelectorAll('.analytics-search-item[data-icao]').forEach(el => {
      el.addEventListener('click', () => selectAircraftResult(el.dataset.icao));
    });
  }

  function selectAircraftResult(icao) {
    hideSearchResults();
    document.getElementById('analyticsAircraftSearch').value = '';

    // Get current period dates
    const from = document.getElementById('analyticsPeriodFrom').value;
    const to = document.getElementById('analyticsPeriodTo').value;

    let fromUtc, toUtc;
    if (from && to) {
      fromUtc = new Date(from + 'T00:00:00Z').toISOString();
      toUtc = new Date(to + 'T23:59:59Z').toISOString();
    } else {
      // Default to last 7 days
      const now = new Date();
      const weekAgo = new Date(now.getTime() - 7 * 86400000);
      fromUtc = weekAgo.toISOString();
      toUtc = now.toISOString();
    }

    // Load flights filtered by this ICAO
    loadFlightsForAircraft(icao, fromUtc, toUtc);
  }

  async function loadFlightsForAircraft(icao, fromUtc, toUtc) {
    clearAllTrails();
    const content = document.getElementById('analyticsContent');
    content.innerHTML = '<div class="analytics-loading">Carregando voos...</div>';

    const flightsData = await fetchApi(`/flights?from=${fromUtc}&to=${toUtc}&icao=${icao}&pageSize=200`);
    currentFlights = flightsData?.flights || [];
    filterText = '';

    let html = `
      <div class="analytics-stats">
        <div class="stat-card"><div class="stat-num">${currentFlights.length}</div><div class="stat-label">Voos</div></div>
        <div class="stat-card"><div class="stat-num">${icao}</div><div class="stat-label">ICAO</div></div>
      </div>
    `;
    html += renderFlightSection();
    content.innerHTML = html;
    attachFlightListeners();
  }

  function hideSearchResults() {
    const resultsEl = document.getElementById('analyticsSearchResults');
    if (resultsEl) {
      resultsEl.classList.remove('visible');
      resultsEl.innerHTML = '';
    }
  }

  // ==========================================
  // RENDER
  // ==========================================
  function renderDaily(data) {
    const container = document.getElementById('analyticsContent');
    const firstTime = data.firstActivity ? new Date(data.firstActivity).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : '--';
    const lastTime = data.lastActivity ? new Date(data.lastActivity).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : '--';

    let html = `
      <div class="analytics-stats">
        <div class="stat-card"><div class="stat-num">${data.uniqueAircraft}</div><div class="stat-label">Aeronaves</div></div>
        <div class="stat-card"><div class="stat-num">${formatNum(data.totalPositions)}</div><div class="stat-label">Posições</div></div>
        <div class="stat-card"><div class="stat-num">${firstTime}–${lastTime}</div><div class="stat-label">Atividade</div></div>
      </div>
    `;

    // Hourly chart
    if (data.hourlyBreakdown && data.hourlyBreakdown.length > 0) {
      const maxPos = Math.max(...data.hourlyBreakdown.map(h => h.positions));
      html += `<div class="analytics-chart"><div class="analytics-chart-title">Posições por Hora</div><div class="hourly-bars">`;
      for (let h = 0; h < 24; h++) {
        const entry = data.hourlyBreakdown.find(e => e.hour === h);
        const count = entry ? entry.positions : 0;
        const pct = maxPos > 0 ? (count / maxPos) * 100 : 0;
        html += `<div class="hourly-bar" style="height:${Math.max(pct, 2)}%" title="${h}h: ${count} pos, ${entry ? entry.aircraft : 0} acft">`;
        if (h % 4 === 0) html += `<span class="hourly-bar-label">${h}</span>`;
        html += `</div>`;
      }
      html += `</div></div>`;
    }

    // Flight section with filter
    html += renderFlightSection();

    container.innerHTML = html;
    attachFlightListeners();
  }

  function renderPeriod(periodData, container) {
    if (!periodData) {
      container.innerHTML = '<div class="analytics-loading">Erro ao carregar dados</div>';
      return;
    }

    let html = `
      <div class="analytics-stats">
        <div class="stat-card"><div class="stat-num">${periodData.uniqueAircraft}</div><div class="stat-label">Aeronaves</div></div>
        <div class="stat-card"><div class="stat-num">${formatNum(periodData.totalPositions)}</div><div class="stat-label">Posições</div></div>
        <div class="stat-card"><div class="stat-num">${periodData.avgAircraftPerDay}</div><div class="stat-label">Média/dia</div></div>
      </div>
    `;

    // Daily breakdown chart
    if (periodData.dailyBreakdown && periodData.dailyBreakdown.length > 0) {
      const maxAcft = Math.max(...periodData.dailyBreakdown.map(d => d.aircraft));
      html += `<div class="analytics-chart"><div class="analytics-chart-title">Aeronaves por Dia</div><div class="hourly-bars">`;
      periodData.dailyBreakdown.forEach(d => {
        const pct = maxAcft > 0 ? (d.aircraft / maxAcft) * 100 : 0;
        const day = d.date.slice(8, 10);
        html += `<div class="hourly-bar" style="height:${Math.max(pct, 2)}%" title="${d.date}: ${d.aircraft} acft, ${d.positions} pos"><span class="hourly-bar-label">${day}</span></div>`;
      });
      html += `</div></div>`;
    }

    // Flight section with filter
    html += renderFlightSection();

    container.innerHTML = html;
    attachFlightListeners();
  }

  function renderFlightSection() {
    const filtered = getFilteredFlights();
    const plotCount = Object.keys(analyticsTrails).length;

    let html = `
      <div class="analytics-flights">
        <div class="analytics-flights-header">
          <div class="analytics-flights-title">Voos (${currentFlights.length})</div>
          <div class="analytics-flights-actions">
            <button class="flight-plot-btn" id="analyticsPlotAll" title="Plotar todos">Plotar todos</button>
            <button class="analytics-clear-btn ${plotCount > 0 ? 'visible' : ''}" id="analyticsClearBtn">Limpar (${plotCount})</button>
          </div>
        </div>
        <input type="text" class="analytics-filter-input" id="analyticsFilter" placeholder="Filtrar voo (callsign/ICAO)..." value="${filterText}">
        <div id="analyticsFlightList">
    `;

    html += buildFlightListHtml(filtered);
    html += `</div></div>`;

    // Logout
    html += `<div class="analytics-logout"><button id="analyticsLogoutBtn">Sair</button></div>`;

    return html;
  }

  function buildFlightListHtml(flights) {
    if (flights.length === 0) {
      return '<div class="analytics-loading">Nenhum voo encontrado</div>';
    }
    return flights.map(f => {
      const start = new Date(f.startTime).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
      const end = new Date(f.endTime).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
      const label = f.callsign || f.icaoHex;
      const plotted = isPlotted(f);
      const plottedClass = plotted ? 'flight-item-plotted' : '';
      return `
        <div class="flight-item ${plottedClass}" data-flight-key="${flightKey(f)}" data-flight-idx="${currentFlights.indexOf(f)}">
          <div class="flight-info">
            <span class="flight-callsign">${label} <span style="opacity:0.5;font-size:10px">(${f.icaoHex})</span></span>
            <span class="flight-meta">${start}–${end} · ${f.durationMinutes}min · ${f.positionCount} pts · FL${f.maxAltitude ? Math.round(f.maxAltitude / 100) : '?'}</span>
          </div>
          <span class="flight-plot-indicator">${plotted ? '●' : '○'}</span>
        </div>`;
    }).join('');
  }

  function renderFlightList() {
    const listEl = document.getElementById('analyticsFlightList');
    if (!listEl) return;
    const filtered = getFilteredFlights();
    listEl.innerHTML = buildFlightListHtml(filtered);
    attachFlightItemListeners();
    updateClearBtn();

    // Update plotAll and clear button text
    const clearBtn = document.getElementById('analyticsClearBtn');
    if (clearBtn) {
      const count = Object.keys(analyticsTrails).length;
      clearBtn.textContent = `Limpar (${count})`;
      clearBtn.classList.toggle('visible', count > 0);
    }
  }

  function attachFlightListeners() {
    // Filter
    const filterInput = document.getElementById('analyticsFilter');
    if (filterInput) filterInput.addEventListener('input', onFilterInput);

    // Plot all
    const plotAllBtn = document.getElementById('analyticsPlotAll');
    if (plotAllBtn) plotAllBtn.addEventListener('click', plotAllFlights);

    // Clear
    const clearBtn = document.getElementById('analyticsClearBtn');
    if (clearBtn) clearBtn.addEventListener('click', clearAllTrails);

    // Logout
    const logoutBtn = document.getElementById('analyticsLogoutBtn');
    if (logoutBtn) logoutBtn.addEventListener('click', logout);

    attachFlightItemListeners();
  }

  function attachFlightItemListeners() {
    document.querySelectorAll('#analyticsFlightList .flight-item').forEach(el => {
      el.addEventListener('click', () => {
        const idx = parseInt(el.dataset.flightIdx);
        if (currentFlights[idx]) {
          toggleFlight(currentFlights[idx]);
        }
      });
    });
  }

  function formatNum(n) {
    if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
    return n.toString();
  }

  // ==========================================
  // INIT
  // ==========================================
  function init() {
    setupTrigger();

    // Login form
    const loginBtn = document.getElementById('analyticsLoginBtn');
    const loginInput = document.getElementById('analyticsKeyInput');
    if (loginBtn) loginBtn.addEventListener('click', handleLogin);
    if (loginInput) loginInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') handleLogin();
    });

    // Close button (hides panel, does not logout)
    const closeBtn = document.getElementById('analyticsCloseBtn');
    if (closeBtn) closeBtn.addEventListener('click', hidePanel);

    // Toggle button
    const toggleBtn = document.getElementById('analyticsToggleBtn');
    if (toggleBtn) toggleBtn.addEventListener('click', togglePanel);

    // Period presets
    document.querySelectorAll('.preset-btn').forEach(btn => {
      btn.addEventListener('click', () => setPreset(parseInt(btn.dataset.preset)));
    });

    // Period manual search
    const periodBtn = document.getElementById('analyticsPeriodBtn');
    if (periodBtn) periodBtn.addEventListener('click', loadPeriodData);

    // Aircraft search
    const searchInput = document.getElementById('analyticsAircraftSearch');
    if (searchInput) {
      searchInput.addEventListener('input', onAircraftSearchInput);
      // Hide results on click outside
      document.addEventListener('click', (e) => {
        if (!e.target.closest('.analytics-search-section')) hideSearchResults();
      });
    }

    // Show toggle button if key exists (panel stays closed)
    if (getKey()) {
      showToggleBtn();
    }
  }

  // Expose needed functions globally for onclick handlers
  window._analyticsModule = { logout, clearAllTrails };

  // Wait for DOM and map
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
