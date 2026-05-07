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
  let analyticsTrails = [];
  let currentTab = 'daily';

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
      showPanel();
      loadDailyData();
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

  function logout() {
    clearKey();
    hidePanel();
    clearTrails();
  }

  // ==========================================
  // TABS
  // ==========================================
  function switchTab(tab) {
    currentTab = tab;
    document.querySelectorAll('.analytics-tab').forEach(t => t.classList.remove('active'));
    document.querySelector(`[data-analytics-tab="${tab}"]`).classList.add('active');

    document.getElementById('analyticsDaily').style.display = tab === 'daily' ? 'block' : 'none';
    document.getElementById('analyticsPeriod').style.display = tab === 'period' ? 'block' : 'none';

    if (tab === 'daily') loadDailyData();
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

  async function loadDailyData() {
    const content = document.getElementById('analyticsDaily');
    content.innerHTML = '<div class="analytics-loading">Carregando...</div>';

    const data = await fetchApi('/daily');
    if (!data) return;

    renderDaily(data);
  }

  async function loadPeriodData() {
    const fromInput = document.getElementById('analyticsPeriodFrom');
    const toInput = document.getElementById('analyticsPeriodTo');
    const from = fromInput.value;
    const to = toInput.value;

    if (!from || !to) return;

    const content = document.getElementById('analyticsPeriodContent');
    content.innerHTML = '<div class="analytics-loading">Carregando...</div>';

    const fromUtc = new Date(from + 'T00:00:00Z').toISOString();
    const toUtc = new Date(to + 'T23:59:59Z').toISOString();

    const [periodData, flightsData] = await Promise.all([
      fetchApi(`/period?from=${fromUtc}&to=${toUtc}`),
      fetchApi(`/flights?from=${fromUtc}&to=${toUtc}&pageSize=100`),
    ]);

    renderPeriod(periodData, flightsData, content);
  }

  async function loadFlightsForDay() {
    const today = new Date().toISOString().slice(0, 10);
    const fromUtc = `${today}T00:00:00Z`;
    const toUtc = `${today}T23:59:59Z`;

    const data = await fetchApi(`/flights?from=${fromUtc}&to=${toUtc}&pageSize=100`);
    return data;
  }

  async function plotFlight(icao, from, to) {
    const data = await fetchApi(`/flights/${icao}/trail?from=${from}&to=${to}`);
    if (!data || !data.trail || data.trail.length < 2) return;

    const points = data.trail.map(p => [p.lat, p.lon]);
    const polyline = L.polyline(points, {
      color: '#ffd700',
      weight: 3,
      opacity: 0.8,
      dashArray: '8, 4',
    }).addTo(map);

    // Start/end markers
    const startMarker = L.circleMarker(points[0], {
      radius: 5, color: '#00ff41', fillColor: '#00ff41', fillOpacity: 1,
    }).addTo(map).bindTooltip(`${data.callsign || icao} — INÍCIO`, { permanent: false });

    const endMarker = L.circleMarker(points[points.length - 1], {
      radius: 5, color: '#ff3333', fillColor: '#ff3333', fillOpacity: 1,
    }).addTo(map).bindTooltip(`${data.callsign || icao} — FIM`, { permanent: false });

    analyticsTrails.push(polyline, startMarker, endMarker);

    // Fit map to trail
    map.fitBounds(polyline.getBounds().pad(0.1));

    // Show clear button
    document.getElementById('analyticsClearBtn').classList.add('visible');
  }

  function clearTrails() {
    analyticsTrails.forEach(layer => map.removeLayer(layer));
    analyticsTrails = [];
    document.getElementById('analyticsClearBtn').classList.remove('visible');
  }

  // ==========================================
  // RENDER
  // ==========================================
  function renderDaily(data) {
    const container = document.getElementById('analyticsDaily');
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

    // Flights
    html += `<div class="analytics-flights"><div class="analytics-flights-title">Voos do Dia</div><div id="dailyFlightsList"></div></div>`;
    html += `<button class="analytics-clear-btn" id="analyticsClearBtn" onclick="window._analyticsModule.clearTrails()">Limpar trails do mapa</button>`;
    html += `<div class="analytics-logout"><button onclick="window._analyticsModule.logout()">Sair</button></div>`;

    container.innerHTML = html;

    // Load flights
    loadFlightsForDay().then(flightsData => {
      const list = document.getElementById('dailyFlightsList');
      if (!flightsData || !flightsData.flights || flightsData.flights.length === 0) {
        list.innerHTML = '<div class="analytics-loading">Nenhum voo detectado</div>';
        return;
      }
      list.innerHTML = renderFlightList(flightsData.flights);
    });

    // Re-show clear btn if trails exist
    if (analyticsTrails.length > 0) {
      setTimeout(() => {
        const btn = document.getElementById('analyticsClearBtn');
        if (btn) btn.classList.add('visible');
      }, 0);
    }
  }

  function renderPeriod(periodData, flightsData, container) {
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

    // Flights
    if (flightsData && flightsData.flights && flightsData.flights.length > 0) {
      html += `<div class="analytics-flights"><div class="analytics-flights-title">Voos (${flightsData.totalFlights})</div>`;
      html += renderFlightList(flightsData.flights);
      html += `</div>`;
    }

    html += `<button class="analytics-clear-btn ${analyticsTrails.length > 0 ? 'visible' : ''}" id="analyticsClearBtn" onclick="window._analyticsModule.clearTrails()">Limpar trails do mapa</button>`;

    container.innerHTML = html;
  }

  function renderFlightList(flights) {
    return flights.map(f => {
      const start = new Date(f.startTime).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
      const end = new Date(f.endTime).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
      const label = f.callsign || f.icaoHex;
      return `
        <div class="flight-item">
          <div class="flight-info">
            <span class="flight-callsign">${label} <span style="opacity:0.5;font-size:10px">(${f.icaoHex})</span></span>
            <span class="flight-meta">${start}–${end} · ${f.durationMinutes}min · ${f.positionCount} pts · FL${f.maxAltitude ? Math.round(f.maxAltitude / 100) : '?'}</span>
          </div>
          <button class="flight-plot-btn" onclick="window._analyticsModule.plotFlight('${f.icaoHex}','${f.startTime}','${f.endTime}')">Ver</button>
        </div>`;
    }).join('');
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

    // Tabs
    document.querySelectorAll('.analytics-tab').forEach(tab => {
      tab.addEventListener('click', () => switchTab(tab.dataset.analyticsTab));
    });

    // Period search
    const periodBtn = document.getElementById('analyticsPeriodBtn');
    if (periodBtn) periodBtn.addEventListener('click', loadPeriodData);

    // Auto-show if key exists
    if (getKey()) {
      showPanel();
      loadDailyData();
    }
  }

  // Expose needed functions globally for onclick handlers
  window._analyticsModule = { plotFlight, clearTrails, logout };

  // Wait for DOM and map
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
