// ================================================================
// ARGUS — script.js  v1.0 beta
// GIS Investigativo per coltivazioni illecite
// Stack: Leaflet · Turf.js · Nominatim · Overpass · Sentinel-2
// ================================================================
'use strict';

// ── COSTANTI ─────────────────────────────────────────────────────
const NOMINATIM_URL = 'https://nominatim.openstreetmap.org';
const OVERPASS_URL  = 'https://overpass-api.de/api/interpreter';
const LS_KEY        = 'argus_sites_v1';

// Copernicus STAC API — catalogo scene Sentinel-2 (no auth per query)
const STAC_API = 'https://catalogue.dataspace.copernicus.eu/stac/collections/SENTINEL-2/items';

// Sentinel Hub WMS istanza pubblica demo (no token richiesto)
const SH_WMS = 'https://services.sentinel-hub.com/ogc/wms/cd280189-7c51-45a6-ab05-f96a76067128';

// Fallback WMS DLR/EOC — dati mensili aggregati, sempre disponibile
const DLR_WMS = 'https://geoservice.dlr.de/eoc/imagery/wms';

// NASA GIBS WMTS — immagini Terra/MODIS aggiornate ogni 24h (no auth)
const NASA_WMTS = 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/{layer}/default/{date}/GoogleMapsCompatible/{z}/{y}/{x}.jpg';

const MONTHS = ['Gennaio','Febbraio','Marzo','Aprile','Maggio','Giugno',
                'Luglio','Agosto','Settembre','Ottobre','Novembre','Dicembre'];

// ── DESCRIZIONI INDICI SPETTRALI ─────────────────────────────────
const INDEX_INFO = {
  TRUE: {
    label: 'True Color (RGB)',
    desc:  'Immagine a colori naturali Sentinel-2 (B04/B03/B02). Risoluzione 10m/px. Utile per identificare geometrie anomale e contrasti visivi.',
    sh:    'TRUE-COLOR',
    dlr:   'S2_L2A_RGB_ENHANCED',
    color: '#00c896'
  },
  NDVI: {
    label: 'NDVI — Vegetazione',
    desc:  'Normalized Difference Vegetation Index. Valori 0.6–0.9 = vegetazione densa e sana. Anomalie rispetto al bosco circostante indicano coltivazioni intensive.',
    sh:    'NDVI',
    dlr:   'S2_L2A_NDVI',
    color: '#52b788'
  },
  NDRE: {
    label: 'NDRE — Red Edge',
    desc:  'Normalized Difference Red Edge. Sensibile al contenuto di clorofilla. Distingue la cannabis dalla flora boschiva per la sua firma spettrale unica nel red-edge (B05/B08).',
    sh:    'FALSE-COLOR',
    dlr:   'S2_L2A_FALSE_COLOR',
    color: '#74c69d'
  },
  EVI: {
    label: 'EVI — Vegetazione Avanzato',
    desc:  'Enhanced Vegetation Index. Riduce la saturazione in zone boschive dense. Utile per rilevare coltivazioni nascoste nel sottobosco.',
    sh:    'FALSE-COLOR-URBAN',
    dlr:   'S2_L2A_RGB_ENHANCED',
    color: '#40916c'
  },
  SWIR: {
    label: 'SWIR — Infrarosso Corto',
    desc:  'Short Wave Infrared (B12/B8A/B04). Evidenzia stress idrico e differenze di umidità del suolo. Utile per rilevare irrigazione artificiale tipica delle coltivazioni illecite.',
    sh:    'SWIR',
    dlr:   'S2_L2A_FALSE_COLOR',
    color: '#e76f51'
  },
  MOISTURE: {
    label: 'Moisture — Umidità',
    desc:  'Indice di umidità della vegetazione (B8A/B11). Coltivazioni irrigate mostrano valori anomali rispetto alla vegetazione naturale circostante.',
    sh:    'MOISTURE-INDEX',
    dlr:   'S2_L2A_NDVI',
    color: '#4cc9f0'
  },
  MODIS: {
    label: 'MODIS Terra (NASA) — 24h',
    desc:  'Immagini Terra/MODIS della NASA aggiornate ogni 24 ore. Risoluzione 250m/px. Utile per monitoraggio rapido di grandi aree e rilevamento cambiamenti recenti.',
    sh:    null,
    dlr:   null,
    color: '#f4a261'
  }
};

// ── STATO APPLICAZIONE ───────────────────────────────────────────
const state = {
  map:                 null,
  baseLayers:          {},
  activeBase:          'osm',
  riskLayers:          {},
  sentinelLayer:       null,
  droneLayer:          null,
  droneImageUrl:       null,
  markerCluster:       null,
  markers:             {},
  sites:               [],
  addMarkerMode:       false,
  selectedIndices:     ['TRUE'],   // Array: supporta selezione multipla
  communeBounds:       null,
  riskZonesLayer:      null,
  lastStacScene:       null,
  autoAnalysisRunning: false,
  timelineDaysBack:    0,
  deferredInstall:     null        // PWA install prompt
};


// ================================================================
// 1. INIZIALIZZAZIONE MAPPA
// ================================================================
function initMap() {
  state.map = L.map('map', { center:[41.9,12.5], zoom:6, zoomControl:false, attributionControl:true });
  // Zoom in basso a SINISTRA — FAB sono a destra, nessuna sovrapposizione
  L.control.zoom({ position:'bottomleft' }).addTo(state.map);

  state.baseLayers.osm = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    { attribution:'© OpenStreetMap', maxZoom:19 });
  state.baseLayers.satellite = L.tileLayer(
    'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    { attribution:'© Esri, Maxar', maxZoom:19 });
  state.baseLayers.topo = L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
    { attribution:'© OpenTopoMap', maxZoom:17 });
  state.baseLayers.osm.addTo(state.map);

  state.markerCluster = L.markerClusterGroup({
    showCoverageOnHover:false, maxClusterRadius:50,
    iconCreateFunction: c => L.divIcon({
      html:`<div class="cluster-icon">${c.getChildCount()}</div>`,
      className:'', iconSize:[40,40]
    })
  });
  state.map.addLayer(state.markerCluster);
  state.map.on('click', onMapClick);
  loadSitesFromStorage();
  updateTimelineLabel();
  renderIndexButtons();
  showToast('Argus v1.0 beta pronto.', 'success');
}

function switchBaseLayer(k) {
  if (state.baseLayers[state.activeBase]) state.map.removeLayer(state.baseLayers[state.activeBase]);
  if (state.baseLayers[k]) {
    state.baseLayers[k].addTo(state.map);
    state.baseLayers[k].bringToBack();
    state.activeBase = k;
  }
}

// ================================================================
// 2. INDICI SPETTRALI — SELEZIONE MULTIPLA
// ================================================================

/**
 * Renderizza i pulsanti degli indici nella sidebar.
 * Supporta selezione multipla: ogni indice attivo viene caricato
 * come layer separato con opacità ridotta per sovrapposizione.
 */
function renderIndexButtons() {
  const container = document.getElementById('indexBtnContainer');
  if (!container) return;
  container.innerHTML = Object.entries(INDEX_INFO).map(([key, info]) => `
    <button
      class="index-btn ${state.selectedIndices.includes(key) ? 'active' : ''}"
      id="btn${key}"
      onclick="toggleIndex('${key}')"
      aria-pressed="${state.selectedIndices.includes(key)}"
      style="--index-color:${info.color}"
      title="${info.label}"
    >${key}</button>
  `).join('');
  updateIndexDesc();
}

/**
 * Attiva/disattiva un indice spettrale.
 * Se è l'unico attivo non può essere disattivato.
 */
function toggleIndex(key) {
  const idx = state.selectedIndices.indexOf(key);
  if (idx === -1) {
    state.selectedIndices.push(key);
  } else {
    if (state.selectedIndices.length === 1) {
      showToast('Almeno un indice deve essere attivo.', 'info');
      return;
    }
    state.selectedIndices.splice(idx, 1);
  }
  renderIndexButtons();
}

function updateIndexDesc() {
  const el = document.getElementById('indexDesc');
  if (!el) return;
  const descs = state.selectedIndices.map(k => {
    const info = INDEX_INFO[k];
    return `<div style="margin-bottom:8px;padding-bottom:8px;border-bottom:1px solid rgba(255,255,255,0.06);">
      <strong style="color:${info.color}">${info.label}</strong><br/>
      <span style="font-size:11px;">${info.desc}</span>
    </div>`;
  });
  el.innerHTML = descs.join('');
}

// ================================================================
// 3. SENTINEL-2 REAL-TIME — MULTI-INDICE SINCRONIZZATO
// ================================================================

/**
 * Carica TUTTI gli indici selezionati in parallelo.
 * Ogni indice viene caricato come layer WMS separato.
 * Il primo indice ha opacità 0.85, gli altri 0.45 (overlay).
 */
async function loadLatestSentinel() {
  // Rimuovi tutti i layer Sentinel precedenti
  clearSentinelLayers();

  const bounds = state.map.getBounds();
  const bbox   = [bounds.getWest().toFixed(4), bounds.getSouth().toFixed(4),
                  bounds.getEast().toFixed(4), bounds.getNorth().toFixed(4)].join(',');

  const now      = new Date();
  const dateTo   = now.toISOString().slice(0,10);
  const dateFrom = new Date(now - 10*86400000).toISOString().slice(0,10);

  showSpinner(true);
  updateSentinelStatus('loading', 'Ricerca scena più recente...');

  try {
    // Query STAC per trovare la scena più recente
    const stacUrl = `${STAC_API}?bbox=${bbox}&datetime=${dateFrom}T00:00:00Z/${dateTo}T23:59:59Z&limit=5&sortby=-datetime`;
    const res  = await fetch(stacUrl, { headers:{ Accept:'application/json' } });
    let sceneDate = dateTo, sceneId = null, cloudCover = 'N/D';

    if (res.ok) {
      const data = await res.json();
      if (data.features && data.features.length > 0) {
        const scene = data.features[0];
        sceneDate   = (scene.properties.datetime || dateTo).slice(0,10);
        sceneId     = scene.id;
        cloudCover  = scene.properties['eo:cloud_cover'] != null
          ? scene.properties['eo:cloud_cover'].toFixed(1) + '%' : 'N/D';
        state.lastStacScene = scene;
      }
    }

    // Carica ogni indice selezionato come layer separato
    const layers = [];
    for (let i = 0; i < state.selectedIndices.length; i++) {
      const key  = state.selectedIndices[i];
      const info = INDEX_INFO[key];

      if (key === 'MODIS') {
        // NASA GIBS WMTS — aggiornato ogni 24h
        const layer = loadNASALayer(sceneDate);
        if (layer) layers.push({ key, layer });
        continue;
      }

      const opacity = i === 0 ? 0.85 : 0.45;
      const layer = L.tileLayer.wms(SH_WMS, {
        layers:      info.sh,
        format:      'image/png',
        transparent: true,
        version:     '1.3.0',
        time:        sceneDate,
        maxcc:       30,
        attribution: `© ESA Copernicus · ${sceneDate}`,
        opacity,
        maxZoom:     18,
        tileSize:    512
      });

      // Fallback al DLR se Sentinel Hub non risponde
      layer.on('tileerror', () => {
        if (!layer._dlrFallback) {
          layer._dlrFallback = true;
          state.map.removeLayer(layer);
          const fallback = L.tileLayer.wms(DLR_WMS, {
            layers: info.dlr, format:'image/png', transparent:true,
            version:'1.3.0', attribution:'© DLR/EOC', opacity, maxZoom:18
          }).addTo(state.map);
          state.riskLayers[`sentinel_${key}`] = fallback;
          updateSentinelStatus('warn', 'Dati DLR mensili (fallback)');
        }
      });

      layer.addTo(state.map);
      state.riskLayers[`sentinel_${key}`] = layer;
      layers.push({ key, layer });
    }

    const daysAgo = Math.round((now - new Date(sceneDate)) / 86400000);
    updateSentinelStatus('ok', `${sceneDate} · ${daysAgo}gg fa · ☁️ ${cloudCover}`);
    updateSentinelCard({ date:sceneDate, daysAgo, cloudCover, sceneId,
      indices: state.selectedIndices, source:'Sentinel Hub / Copernicus' });

    const indicesLabel = state.selectedIndices.join(' + ');
    showToast(`🛰️ ${indicesLabel} · ${sceneDate} · ☁️ ${cloudCover}`, 'success', 5000);

  } catch (err) {
    console.warn('[Sentinel]', err.message);
    loadSentinelFallback();
  } finally {
    showSpinner(false);
  }
}

/**
 * Carica il layer NASA GIBS MODIS Terra (aggiornato ogni 24h, no auth).
 */
function loadNASALayer(date) {
  const layer = L.tileLayer(
    `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/MODIS_Terra_CorrectedReflectance_TrueColor/default/${date}/GoogleMapsCompatible/{z}/{y}/{x}.jpg`,
    { attribution:'© NASA GIBS / MODIS Terra', opacity:0.75, maxZoom:9, tileSize:256 }
  ).addTo(state.map);
  state.riskLayers['sentinel_MODIS'] = layer;
  return layer;
}

/**
 * Fallback DLR per tutti gli indici selezionati.
 */
function loadSentinelFallback() {
  clearSentinelLayers();
  for (let i = 0; i < state.selectedIndices.length; i++) {
    const key  = state.selectedIndices[i];
    const info = INDEX_INFO[key];
    if (!info.dlr) continue;
    const layer = L.tileLayer.wms(DLR_WMS, {
      layers: info.dlr, format:'image/png', transparent:true,
      version:'1.3.0', attribution:'© DLR/EOC', opacity: i===0 ? 0.80 : 0.40, maxZoom:18
    }).addTo(state.map);
    state.riskLayers[`sentinel_${key}`] = layer;
  }
  updateSentinelStatus('warn', 'Dati aggregati mensili (DLR fallback)');
  updateSentinelCard({ date:new Date().toISOString().slice(0,10), daysAgo:null,
    cloudCover:'N/D', sceneId:null, indices:state.selectedIndices, source:'DLR/EOC mensile' });
  showToast('⚠️ Sentinel Hub non disponibile, uso dati DLR.', 'info');
}

/**
 * Rimuove tutti i layer Sentinel attivi dalla mappa.
 */
function clearSentinelLayers() {
  Object.keys(state.riskLayers).forEach(k => {
    if (k.startsWith('sentinel_')) {
      state.map.removeLayer(state.riskLayers[k]);
      delete state.riskLayers[k];
    }
  });
  if (state.sentinelLayer) {
    state.map.removeLayer(state.sentinelLayer);
    state.sentinelLayer = null;
  }
}

/**
 * Carica Sentinel per una data specifica dalla timeline.
 */
function loadSentinelForDate() {
  const daysBack = state.timelineDaysBack || 0;
  const d = new Date(Date.now() - daysBack * 86400000);
  const dateStr = d.toISOString().slice(0,10);
  clearSentinelLayers();

  for (let i = 0; i < state.selectedIndices.length; i++) {
    const key  = state.selectedIndices[i];
    const info = INDEX_INFO[key];
    if (key === 'MODIS') { loadNASALayer(dateStr); continue; }
    if (!info.sh) continue;
    const layer = L.tileLayer.wms(SH_WMS, {
      layers: info.sh, format:'image/png', transparent:true, version:'1.3.0',
      time: dateStr, maxcc:50, attribution:`© ESA Copernicus · ${dateStr}`,
      opacity: i===0 ? 0.85 : 0.45, maxZoom:18, tileSize:512
    }).addTo(state.map);
    state.riskLayers[`sentinel_${key}`] = layer;
  }

  updateSentinelStatus('ok', `Data: ${dateStr}`);
  updateSentinelCard({ date:dateStr, daysAgo:daysBack, cloudCover:'≤50%',
    sceneId:null, indices:state.selectedIndices, source:'Sentinel Hub / Copernicus' });
  showToast(`🛰️ ${state.selectedIndices.join('+')} · ${dateStr}`, 'success');
}

function updateTimelineLabel() {
  const slider = document.getElementById('timelineSlider');
  if (!slider) return;
  const daysBack = parseInt(slider.value, 10);
  state.timelineDaysBack = daysBack;
  const d = new Date(Date.now() - daysBack * 86400000);
  const label = daysBack === 0 ? 'Oggi' : d.toLocaleDateString('it-IT', { day:'2-digit', month:'short', year:'numeric' });
  const el = document.getElementById('timelineLabel');
  if (el) el.textContent = label;
}

// ── STATUS & CARD ─────────────────────────────────────────────────
function updateSentinelStatus(type, text) {
  const dot  = document.getElementById('sentinelDot');
  const info = document.getElementById('sentinelInfo');
  if (dot)  dot.className  = `sentinel-dot ${type}`;
  if (info) info.textContent = text;
}

function updateSentinelCard(info) {
  const card = document.getElementById('sentinelFlightCard');
  if (!card) return;

  let freshnessColor = '#00c896', freshnessLabel = 'Recente';
  if (info.daysAgo === null)    { freshnessColor='#7d8590'; freshnessLabel='Aggregato'; }
  else if (info.daysAgo > 10)   { freshnessColor='#ff4757'; freshnessLabel=`${info.daysAgo}gg fa`; }
  else if (info.daysAgo > 5)    { freshnessColor='#ffa502'; freshnessLabel=`${info.daysAgo}gg fa`; }
  else                          { freshnessLabel=`${info.daysAgo}gg fa`; }

  const satellite = info.sceneId
    ? (info.sceneId.startsWith('S2A') ? 'Sentinel-2A' : info.sceneId.startsWith('S2B') ? 'Sentinel-2B' : 'Sentinel-2')
    : 'Sentinel-2';

  let dateFormatted = info.date;
  try { dateFormatted = new Date(info.date).toLocaleDateString('it-IT',
    { weekday:'short', day:'2-digit', month:'long', year:'numeric' }); } catch(e){}

  const indicesHtml = (info.indices || []).map(k => {
    const inf = INDEX_INFO[k];
    return `<span style="background:${inf.color}20;color:${inf.color};border:1px solid ${inf.color}40;
      padding:2px 6px;border-radius:4px;font-size:10px;font-weight:700;">${k}</span>`;
  }).join(' ');

  card.style.display = 'block';
  card.innerHTML = `
    <div class="flight-card">
      <div class="flight-card-header">
        <span class="flight-badge" style="background:${freshnessColor}20;color:${freshnessColor};border-color:${freshnessColor}40;">
          ● ${freshnessLabel}
        </span>
        <span class="flight-satellite">${satellite}</span>
      </div>
      <div class="flight-card-row">
        <span class="flight-icon">📅</span>
        <div><div class="flight-label">Data acquisizione</div>
        <div class="flight-value">${dateFormatted}</div></div>
      </div>
      <div class="flight-card-row">
        <span class="flight-icon">☁️</span>
        <div><div class="flight-label">Copertura nuvolosa</div>
        <div class="flight-value" style="color:${parseFloat(info.cloudCover)>20?'#ffa502':'#00c896'}">${info.cloudCover}</div></div>
      </div>
      <div class="flight-card-row">
        <span class="flight-icon">🛰️</span>
        <div><div class="flight-label">Indici attivi</div>
        <div style="margin-top:4px;display:flex;flex-wrap:wrap;gap:4px;">${indicesHtml}</div></div>
      </div>
      <div class="flight-card-row">
        <span class="flight-icon">📡</span>
        <div><div class="flight-label">Fonte dati</div>
        <div class="flight-value" style="font-size:10px;">${info.source}</div></div>
      </div>
      ${info.sceneId ? `<div class="flight-scene-id" title="${info.sceneId}">ID: ${info.sceneId.slice(0,35)}…</div>` : ''}
    </div>`;
}


// ================================================================
// 4. RICERCA COMUNE + ANALISI AUTOMATICA
// ================================================================
async function searchComune() {
  const query = document.getElementById('searchInput').value.trim();
  if (!query) { showToast('Inserisci il nome di un comune.', 'error'); return; }
  showSpinner(true);
  try {
    const url = `${NOMINATIM_URL}/search?q=${encodeURIComponent(query)}&format=json&limit=1&polygon_geojson=1&addressdetails=1&countrycodes=it`;
    const res  = await fetch(url, { headers:{ 'Accept-Language':'it' } });
    const data = await res.json();
    if (!data.length) { showToast(`"${query}" non trovato.`, 'error'); return; }
    const place = data[0];
    if (state.communeBounds) state.map.removeLayer(state.communeBounds);
    if (place.geojson) {
      state.communeBounds = L.geoJSON(place.geojson, {
        style:{ color:'#00c896', weight:2.5, opacity:0.9, fillColor:'#00c896', fillOpacity:0.06, dashArray:'6 4' }
      }).addTo(state.map);
      state.map.fitBounds(state.communeBounds.getBounds(), { padding:[40,40] });
    } else {
      state.map.setView([parseFloat(place.lat), parseFloat(place.lon)], 13);
    }
    showToast(`�� ${place.display_name.split(',')[0]} trovato.`, 'success');
    const centerLat = parseFloat(place.lat);
    const centerLng = parseFloat(place.lon);
    const bb = place.boundingbox;
    const radiusKm = bb
      ? Math.min(15, Math.max(3, turf.distance(
          turf.point([parseFloat(bb[2]), parseFloat(bb[0])]),
          turf.point([parseFloat(bb[3]), parseFloat(bb[1])]),
          { units:'kilometers' }) / 2))
      : 5;
    setTimeout(() => loadLatestSentinel(), 600);
    setTimeout(() => runAutoRiskAnalysis(centerLat, centerLng, radiusKm), 1200);
  } catch(err) {
    console.error('[Nominatim]', err);
    showToast('Errore di rete.', 'error');
  } finally {
    showSpinner(false);
  }
}

// ================================================================
// 5. ANALISI AUTOMATICA ZONE SOSPETTE (Risk Scoring)
// ================================================================
async function runAutoRiskAnalysis(lat, lng, radiusKm = 5) {
  if (state.autoAnalysisRunning) return;
  state.autoAnalysisRunning = true;
  if (state.riskZonesLayer) { state.map.removeLayer(state.riskZonesLayer); state.riskZonesLayer = null; }
  const degOffset = radiusKm / 111.0;
  const bbox = `${lat-degOffset},${lng-degOffset},${lat+degOffset},${lng+degOffset}`;
  updateAnalysisStatus('running', `Analisi ${radiusKm}km in corso...`);
  showToast('�� Analisi zone sospette avviata...', 'info', 3000);
  try {
    const [waterF, roadF, pathF] = await Promise.all([
      fetchWaterways(bbox), fetchMainRoads(bbox), fetchPaths(bbox)
    ]);
    const candidates = generateCandidateGrid(lat, lng, radiusKm, 0.15);
    const riskZones = candidates
      .map(pt => ({ point:pt, score:computeRiskScore(pt, waterF, roadF, pathF) }))
      .filter(z => z.score.total >= 60);

    if (!riskZones.length) {
      updateAnalysisStatus('ok', 'Nessuna zona ad alto rischio rilevata');
      showToast('✅ Nessuna zona sospetta nell\'area.', 'success');
      return;
    }
    const features = riskZones
      .sort((a,b) => b.score.total - a.score.total)
      .slice(0, 20)
      .map(z => {
        const c = turf.circle([z.point.lng, z.point.lat], 0.12, { steps:16, units:'kilometers' });
        c.properties = { score:z.score.total, water:z.score.water, isolation:z.score.isolation, paths:z.score.paths,
          label: z.score.total >= 85 ? 'ALTO RISCHIO' : 'RISCHIO MEDIO' };
        return c;
      });

    state.riskZonesLayer = L.geoJSON({ type:'FeatureCollection', features }, {
      style: f => ({
        color:       f.properties.score >= 85 ? '#ff4757' : '#ffa502',
        weight:      2, opacity:0.9,
        fillColor:   f.properties.score >= 85 ? '#ff4757' : '#ffa502',
        fillOpacity: f.properties.score >= 85 ? 0.35 : 0.20,
        dashArray:   f.properties.score >= 85 ? null : '4 3'
      }),
      onEachFeature: (f, layer) => {
        layer.bindPopup(buildRiskZonePopup(f.properties, lat, lng));
        layer.on('mouseover', function() { this.setStyle({ fillOpacity:0.55 }); });
        layer.on('mouseout',  function() { this.setStyle({ fillOpacity: f.properties.score>=85?0.35:0.20 }); });
      }
    }).addTo(state.map);

    const high = riskZones.filter(z => z.score.total >= 85).length;
    const med  = riskZones.length - high;
    updateAnalysisStatus('alert', `${high} ALTO · ${med} MEDIO rischio`);
    showToast(`⚠️ ${riskZones.length} zone sospette (${high} alto rischio)`, high>0?'error':'info', 6000);
  } catch(err) {
    console.error('[AutoRisk]', err);
    updateAnalysisStatus('error', 'Errore analisi');
    showToast('Errore durante l\'analisi.', 'error');
  } finally {
    state.autoAnalysisRunning = false;
  }
}

function generateCandidateGrid(cLat, cLng, radiusKm, stepKm) {
  const candidates = [], stepDeg = stepKm/111.0, radiusDeg = radiusKm/111.0;
  for (let dlat = -radiusDeg; dlat <= radiusDeg; dlat += stepDeg)
    for (let dlng = -radiusDeg; dlng <= radiusDeg; dlng += stepDeg)
      if (Math.sqrt(dlat*dlat+dlng*dlng) <= radiusDeg)
        candidates.push({ lat:cLat+dlat, lng:cLng+dlng });
  return candidates;
}

function computeRiskScore(pt, waterF, roadF, pathF) {
  const p = turf.point([pt.lng, pt.lat]);
  let waterScore=0, isolationScore=0, pathScore=0;
  let minW=Infinity, minR=Infinity, minP=Infinity;
  for (const f of waterF) { try { const d=turf.distance(p,turf.nearestPointOnLine(f,p),{units:'meters'}); if(d<minW)minW=d; } catch(e){} }
  for (const f of roadF)  { try { const d=turf.distance(p,turf.nearestPointOnLine(f,p),{units:'meters'}); if(d<minR)minR=d; } catch(e){} }
  for (const f of pathF)  { try { const d=turf.distance(p,turf.nearestPointOnLine(f,p),{units:'meters'}); if(d<minP)minP=d; } catch(e){} }
  if (minW <= 300) waterScore = Math.round(40*(1-minW/300));
  if (minR === Infinity) isolationScore = 35;
  else if (minR >= 500)  isolationScore = Math.min(35, Math.round(35*(minR-500)/500));
  if (minP <= 800) pathScore = Math.round(25*(1-minP/800));
  return { total:waterScore+isolationScore+pathScore, water:waterScore, isolation:isolationScore, paths:pathScore };
}

function buildRiskZonePopup(props, lat, lng) {
  const color = props.score >= 85 ? '#ff4757' : '#ffa502';
  return `<div style="font-family:'Segoe UI',sans-serif;min-width:220px;">
    <div style="font-size:14px;font-weight:700;color:${color};margin-bottom:10px;">⚠️ ${props.label}</div>
    <div style="font-size:12px;color:#adb5bd;margin-bottom:8px;">
      Score: <span style="color:${color};font-size:16px;font-weight:700;">${props.score}/100</span>
    </div>
    <div style="font-size:11px;color:#7d8590;line-height:1.8;">
      �� Acqua: <b style="color:#00e5ff;">${props.water}/40</b><br/>
      🚗 Isolamento: <b style="color:#ffa502;">${props.isolation}/35</b><br/>
      🥾 Sentieri: <b style="color:#ff6b35;">${props.paths}/25</b>
    </div>
    <button onclick="addRiskZoneAsMarker(${props.score})"
      style="width:100%;margin-top:10px;padding:8px;background:#ffa502;color:#000;
             border:none;border-radius:6px;font-size:12px;font-weight:700;cursor:pointer;">
      📍 Aggiungi come Sito Sospetto
    </button>
  </div>`;
}

function updateAnalysisStatus(type, text) {
  const dot  = document.getElementById('analysisDot');
  const info = document.getElementById('analysisInfo');
  if (dot)  dot.className   = `analysis-dot ${type}`;
  if (info) info.textContent = text;
}

// ── FETCH HELPERS ─────────────────────────────────────────────────
async function fetchWaterways(bbox) {
  const q=`[out:json][timeout:20];(way["waterway"~"river|stream|canal|drain"](${bbox});node["natural"="spring"](${bbox}););out geom;`;
  try { const r=await fetch(OVERPASS_URL,{method:'POST',body:`data=${encodeURIComponent(q)}`}); const d=await r.json();
    return d.elements.filter(e=>e.type==='way'&&e.geometry&&e.geometry.length>=2).map(e=>turf.lineString(e.geometry.map(p=>[p.lon,p.lat]))); }
  catch(e){return[];}
}
async function fetchMainRoads(bbox) {
  const q=`[out:json][timeout:20];way["highway"~"primary|secondary|tertiary|trunk|motorway"](${bbox});out geom;`;
  try { const r=await fetch(OVERPASS_URL,{method:'POST',body:`data=${encodeURIComponent(q)}`}); const d=await r.json();
    return d.elements.filter(e=>e.geometry&&e.geometry.length>=2).map(e=>turf.lineString(e.geometry.map(p=>[p.lon,p.lat]))); }
  catch(e){return[];}
}
async function fetchPaths(bbox) {
  const q=`[out:json][timeout:20];way["highway"~"track|path|footway|bridleway"](${bbox});out geom;`;
  try { const r=await fetch(OVERPASS_URL,{method:'POST',body:`data=${encodeURIComponent(q)}`}); const d=await r.json();
    return d.elements.filter(e=>e.geometry&&e.geometry.length>=2).map(e=>turf.lineString(e.geometry.map(p=>[p.lon,p.lat]))); }
  catch(e){return[];}
}


// ================================================================
// 6. GESTIONE MARKER + GPS
// ================================================================
function toggleAddMarkerMode() {
  state.addMarkerMode = !state.addMarkerMode;
  const btn = document.getElementById('addMarkerBtn');
  const map = state.map.getContainer();
  if (state.addMarkerMode) {
    btn.classList.add('active'); map.style.cursor = 'crosshair';
    showToast('🎯 Clicca sulla mappa per aggiungere un sito.', 'info');
  } else {
    btn.classList.remove('active'); map.style.cursor = '';
  }
}

async function onMapClick(e) {
  if (!state.addMarkerMode) return;
  const { lat, lng } = e.latlng;
  showSpinner(true);
  let comune = 'N/D', address = '';
  try {
    const res = await fetch(
      `${NOMINATIM_URL}/reverse?lat=${lat}&lon=${lng}&format=json&zoom=14`,
      { headers:{ 'Accept-Language':'it' } }
    );
    const geo = await res.json();
    const addr = geo.address || {};
    comune  = addr.municipality || addr.city || addr.town || addr.village || addr.county || 'N/D';
    address = geo.display_name || '';
  } catch(e) { /* geocoding fallback silenzioso */ }

  const site = {
    id:        `site_${Date.now()}`,
    lat:       parseFloat(lat.toFixed(6)),
    lng:       parseFloat(lng.toFixed(6)),
    name:      `Sito ${state.sites.length + 1}`,
    comune, address,
    timestamp: new Date().toLocaleString('it-IT'),
    note:      ''
  };
  addSiteToMap(site);
  state.sites.push(site);
  saveSitesToStorage();
  renderSitesList();
  showToast(`📍 Sito aggiunto: ${comune}`, 'success');
  showSpinner(false);
  setTimeout(() => runAutoRiskAnalysis(lat, lng, 3), 800);
}

function addSiteToMap(site) {
  const icon = L.divIcon({
    html:`<div style="width:32px;height:32px;background:#ffa502;border:3px solid #fff;border-radius:50% 50% 50% 0;transform:rotate(-45deg);box-shadow:0 2px 8px rgba(0,0,0,0.4);"></div>`,
    className:'', iconSize:[32,32], iconAnchor:[16,32], popupAnchor:[0,-36]
  });
  const marker = L.marker([site.lat, site.lng], { icon })
    .bindPopup(buildPopupContent(site), { maxWidth:280, className:'eco-popup' });
  state.markerCluster.addLayer(marker);
  state.markers[site.id] = marker;
}

function buildPopupContent(site) {
  return `<div style="font-family:'Segoe UI',sans-serif;min-width:200px;">
    <div style="font-size:15px;font-weight:700;color:#ffa502;margin-bottom:8px;">⚠️ ${site.name}</div>
    <div style="font-size:12px;color:#adb5bd;margin-bottom:4px;">📍 ${site.comune}</div>
    <div style="font-size:11px;color:#7d8590;font-family:monospace;margin-bottom:8px;">${site.lat}, ${site.lng}</div>
    <div style="font-size:11px;color:#7d8590;margin-bottom:10px;">🕐 ${site.timestamp}</div>
    <button onclick="runAutoRiskAnalysis(${site.lat},${site.lng},3)"
      style="width:100%;padding:8px;background:#00c896;color:#000;border:none;border-radius:6px;font-size:12px;font-weight:600;cursor:pointer;margin-bottom:6px;">
      🔍 Analizza Zone Vicine
    </button>
    <button onclick="highlightNearbyPaths('${site.id}')"
      style="width:100%;padding:8px;background:rgba(255,107,53,0.15);color:#ff6b35;border:1px solid rgba(255,107,53,0.3);border-radius:6px;font-size:12px;font-weight:600;cursor:pointer;margin-bottom:6px;">
      🥾 Sentieri Vicini
    </button>
    <button onclick="deleteSite('${site.id}')"
      style="width:100%;padding:8px;background:rgba(255,71,87,0.15);color:#ff4757;border:1px solid rgba(255,71,87,0.3);border-radius:6px;font-size:12px;font-weight:600;cursor:pointer;">
      🗑️ Elimina
    </button>
  </div>`;
}

function addRiskZoneAsMarker(score) {
  const center = state.map.getCenter();
  const site = {
    id:        `site_${Date.now()}`,
    lat:       parseFloat(center.lat.toFixed(6)),
    lng:       parseFloat(center.lng.toFixed(6)),
    name:      `Zona Rischio (${score}/100)`,
    comune:    'Auto-rilevato',
    address:   '',
    timestamp: new Date().toLocaleString('it-IT'),
    note:      `Score rischio: ${score}/100`
  };
  addSiteToMap(site);
  state.sites.push(site);
  saveSitesToStorage();
  renderSitesList();
  state.map.closePopup();
  showToast('📍 Zona aggiunta al database.', 'success');
}

function locateUser() {
  if (!navigator.geolocation) { showToast('GPS non supportato.', 'error'); return; }
  showSpinner(true);
  navigator.geolocation.getCurrentPosition(
    async pos => {
      const lat = pos.coords.latitude, lng = pos.coords.longitude;
      state.addMarkerMode = true;
      await onMapClick({ latlng:{ lat, lng } });
      state.addMarkerMode = false;
      state.map.setView([lat, lng], 14);
      showSpinner(false);
    },
    err => { showSpinner(false); showToast(`GPS: ${err.message}`, 'error'); },
    { enableHighAccuracy:true, timeout:10000 }
  );
}

// ================================================================
// 7. LAYER RISCHIO MANUALE (toggle sidebar)
// ================================================================
async function toggleRiskLayer(layerType, enabled) {
  if (!enabled) {
    if (state.riskLayers[layerType]) { state.map.removeLayer(state.riskLayers[layerType]); delete state.riskLayers[layerType]; }
    return;
  }
  const b = state.map.getBounds();
  const bbox = `${b.getSouth()},${b.getWest()},${b.getNorth()},${b.getEast()}`;
  showSpinner(true);
  try {
    if (layerType === 'water') {
      const feats = await fetchWaterways(bbox);
      if (!feats.length) { showToast('Nessun corso d\'acqua trovato.', 'info'); return; }
      const buffered = feats.map(f => turf.buffer(f, 0.3, { units:'kilometers' }));
      state.riskLayers.water = L.geoJSON({ type:'FeatureCollection', features:buffered },
        { style:{ color:'#00e5ff', weight:1, opacity:0.7, fillColor:'#00e5ff', fillOpacity:0.18 } }
      ).addTo(state.map);
      showToast(`💧 Buffer 300m: ${feats.length} corsi d'acqua.`, 'success');
    } else if (layerType === 'roads') {
      const feats = await fetchMainRoads(bbox);
      if (!feats.length) { showToast('Nessuna strada trovata.', 'info'); return; }
      const buffered = feats.map(f => turf.buffer(f, 0.5, { units:'kilometers' }));
      state.riskLayers.roads = L.geoJSON({ type:'FeatureCollection', features:buffered },
        { style:{ color:'#ffa502', weight:1, opacity:0.6, fillColor:'#ffa502', fillOpacity:0.12 } }
      ).addTo(state.map);
      showToast(`🚗 Buffer 500m: ${feats.length} strade.`, 'success');
    } else if (layerType === 'paths') {
      const feats = await fetchPaths(bbox);
      if (!feats.length) { showToast('Nessun sentiero trovato.', 'info'); return; }
      state.riskLayers.paths = L.geoJSON(
        { type:'FeatureCollection', features: feats.map(f=>({ type:'Feature', geometry:f.geometry, properties:{} })) },
        { style:{ color:'#ff6b35', weight:2, opacity:0.8, dashArray:'4 3' } }
      ).addTo(state.map);
      showToast(`🥾 ${feats.length} sentieri caricati.`, 'success');
    } else if (layerType === 'catasto') {
      state.riskLayers.catasto = L.tileLayer.wms(
        'https://wms.cartografia.agenziaentrate.gov.it/inspire/wms/ows01.php',
        { layers:'CP.CadastralParcel', format:'image/png', transparent:true, version:'1.3.0', attribution:'© AdE', opacity:0.7 }
      ).addTo(state.map);
      showToast('🏛️ Catasto caricato.', 'success');
    }
  } catch(err) {
    showToast(`Errore layer ${layerType}.`, 'error');
    const cb = document.getElementById(`filter${layerType.charAt(0).toUpperCase()+layerType.slice(1)}`);
    if (cb) cb.checked = false;
  } finally { showSpinner(false); }
}

// ================================================================
// 8. SENTIERI VICINI
// ================================================================
async function highlightNearbyPaths(siteId) {
  const site = state.sites.find(s => s.id === siteId);
  if (!site) return;
  if (state.riskLayers.nearbyPaths) state.map.removeLayer(state.riskLayers.nearbyPaths);
  const d = 0.01;
  const bbox = `${site.lat-d},${site.lng-d},${site.lat+d},${site.lng+d}`;
  showSpinner(true);
  try {
    const feats = await fetchPaths(bbox);
    if (!feats.length) { showToast('Nessun sentiero entro 1km.', 'info'); return; }
    const sitePoint = turf.point([site.lng, site.lat]);
    const nearby = feats
      .filter(f => { try { return turf.distance(sitePoint, turf.nearestPointOnLine(f, sitePoint), { units:'kilometers' }) <= 1.0; } catch(e){ return false; } })
      .map(f => ({ type:'Feature', geometry:f.geometry, properties:{} }));
    if (!nearby.length) { showToast('Nessun sentiero entro 1km.', 'info'); return; }
    state.riskLayers.nearbyPaths = L.geoJSON({ type:'FeatureCollection', features:nearby },
      { style:{ color:'#ff4757', weight:4, opacity:1 } }
    ).addTo(state.map);
    showToast(`🔴 ${nearby.length} sentieri evidenziati.`, 'success');
  } catch(err) { showToast('Errore sentieri.', 'error'); }
  finally { showSpinner(false); }
}

// ================================================================
// 9. DRONE OVERLAY
// ================================================================
function loadDroneImage(event) {
  const file = event.target.files[0]; if (!file) return;
  if (state.droneImageUrl) URL.revokeObjectURL(state.droneImageUrl);
  state.droneImageUrl = URL.createObjectURL(file);
  document.getElementById('droneCoords').style.display = 'block';
  showToast(`📷 "${file.name}" caricata. Inserisci le coordinate.`, 'info');
}
function overlayDroneImage() {
  if (!state.droneImageUrl) { showToast('Nessuna immagine.', 'error'); return; }
  const s = parseFloat(document.getElementById('droneSouth').value);
  const n = parseFloat(document.getElementById('droneNorth').value);
  const w = parseFloat(document.getElementById('droneWest').value);
  const e = parseFloat(document.getElementById('droneEast').value);
  if ([s,n,w,e].some(isNaN) || s>=n || w>=e) { showToast('Coordinate non valide.', 'error'); return; }
  if (state.droneLayer) state.map.removeLayer(state.droneLayer);
  state.droneLayer = L.imageOverlay(state.droneImageUrl, [[s,w],[n,e]], { opacity:0.85, interactive:false }).addTo(state.map);
  state.map.fitBounds([[s,w],[n,e]], { padding:[20,20] });
  showToast('📌 Ortofoto sovrapposta.', 'success');
}

// ================================================================
// 10. AI OBJECT DETECTION (Canvas API)
// ================================================================
async function runObjectDetection(event) {
  const file = event.target.files[0]; if (!file) return;
  const dot      = document.getElementById('aiDot');
  const statusTx = document.getElementById('aiStatusText');
  const canvas   = document.getElementById('detectionCanvas');
  const results  = document.getElementById('detectionResults');
  if (dot)      dot.className      = 'ai-dot running';
  if (statusTx) statusTx.textContent = 'Analisi in corso...';
  if (canvas)   canvas.style.display = 'none';
  if (results)  results.style.display = 'none';
  showSpinner(true);
  try {
    const img = await new Promise((res, rej) => {
      const url = URL.createObjectURL(file);
      const i = new Image();
      i.onload  = () => { URL.revokeObjectURL(url); res(i); };
      i.onerror = () => { URL.revokeObjectURL(url); rej(new Error('Caricamento fallito')); };
      i.src = url;
    });
    const ctx = canvas.getContext('2d');
    const maxW = 320, scale = Math.min(maxW/img.width, maxW/img.height, 1);
    canvas.width  = Math.round(img.width  * scale);
    canvas.height = Math.round(img.height * scale);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const detections = analyzeImageForCultivation(ctx, canvas.width, canvas.height);
    drawDetections(ctx, detections);
    canvas.style.display  = 'block';
    results.style.display = 'block';
    results.innerHTML = buildDetectionResultsHTML(detections);
    if (dot)      dot.className      = 'ai-dot ready';
    if (statusTx) statusTx.textContent = `${detections.length} area/e analizzata/e`;
    if (detections.some(d => d.confidence > 0.5))
      showToast(`⚠️ ${detections.filter(d=>d.confidence>0.5).length} zona/e sospetta/e!`, 'error', 5000);
    else
      showToast('✅ Analisi completata.', 'success');
  } catch(err) {
    if (dot)      dot.className      = 'ai-dot error';
    if (statusTx) statusTx.textContent = 'Errore analisi';
    showToast('Errore analisi immagine.', 'error');
  } finally { showSpinner(false); }
}

function analyzeImageForCultivation(ctx, w, h) {
  const data = ctx.getImageData(0,0,w,h).data;
  const cellSize = Math.max(20, Math.floor(Math.min(w,h)/8));
  const cols = Math.floor(w/cellSize), rows = Math.floor(h/cellSize);
  const grid = [];
  for (let row=0; row<rows; row++) {
    for (let col=0; col<cols; col++) {
      const x0=col*cellSize, y0=row*cellSize;
      let gc=0, dgc=0, total=0;
      for (let py=y0; py<y0+cellSize&&py<h; py++) {
        for (let px=x0; px<x0+cellSize&&px<w; px++) {
          const i=(py*w+px)*4, r=data[i], g=data[i+1], b=data[i+2];
          total++;
          const isGreen = g>r*1.1 && g>b*1.1 && g>40;
          if (isGreen) gc++;
          if (isGreen && g>60 && g<160 && r<100 && b<100) dgc++;
        }
      }
      grid.push({ row, col, x0, y0, greenDensity:gc/total, darkGreenRatio:dgc/total });
    }
  }
  const detections = [];
  for (const cell of grid) {
    const neighbors = grid.filter(c => Math.abs(c.row-cell.row)<=1 && Math.abs(c.col-cell.col)<=1 && !(c.row===cell.row&&c.col===cell.col));
    const avgNG = neighbors.length ? neighbors.reduce((s,c)=>s+c.greenDensity,0)/neighbors.length : 0;
    const edgeContrast = Math.max(0, cell.greenDensity - avgNG);
    const score = cell.darkGreenRatio*0.50 + cell.greenDensity*0.30 + edgeContrast*0.20;
    if (score > 0.15 && cell.darkGreenRatio > 0.08) {
      detections.push({
        x:cell.x0, y:cell.y0, w:cellSize, h:cellSize,
        confidence: Math.min(score*2.5, 1.0),
        label: score>0.35?'ALTA ANOMALIA':score>0.22?'ANOMALIA MEDIA':'BASSA ANOMALIA',
        metrics:{ darkGreen:(cell.darkGreenRatio*100).toFixed(1), greenDens:(cell.greenDensity*100).toFixed(1), contrast:(edgeContrast*100).toFixed(1) }
      });
    }
  }
  return detections.sort((a,b)=>b.confidence-a.confidence).slice(0,5);
}

function drawDetections(ctx, detections) {
  detections.forEach((det, idx) => {
    const color = det.confidence>0.5?'#ff4757':det.confidence>0.3?'#ffa502':'#00c896';
    ctx.strokeStyle=color; ctx.lineWidth=2; ctx.strokeRect(det.x,det.y,det.w,det.h);
    const cs=6; ctx.lineWidth=3;
    [[det.x,det.y],[det.x+det.w,det.y],[det.x,det.y+det.h],[det.x+det.w,det.y+det.h]].forEach(([cx,cy])=>{
      const dx=cx===det.x?1:-1, dy=cy===det.y?1:-1;
      ctx.beginPath(); ctx.moveTo(cx,cy+dy*cs); ctx.lineTo(cx,cy); ctx.lineTo(cx+dx*cs,cy); ctx.stroke();
    });
    ctx.fillStyle=color; ctx.font='bold 9px monospace';
    ctx.fillText(`#${idx+1} ${(det.confidence*100).toFixed(0)}%`, det.x+2, det.y-3);
  });
}

function buildDetectionResultsHTML(detections) {
  if (!detections.length) return '<p class="empty-state" style="padding:12px 0;">Nessuna anomalia rilevata.</p>';
  return detections.map((det,idx) => `
    <div class="detection-result-item">
      <div style="flex:1;">
        <div class="detection-label">#${idx+1} ${det.label}</div>
        <div class="detection-confidence">Verde scuro: ${det.metrics.darkGreen}% | Densità: ${det.metrics.greenDens}% | Contrasto: ${det.metrics.contrast}%</div>
        <div class="detection-confidence-bar">
          <div class="detection-confidence-fill" style="width:${(det.confidence*100).toFixed(0)}%;background:${det.confidence>0.5?'#ff4757':det.confidence>0.3?'#ffa502':'#00c896'};"></div>
        </div>
      </div>
      <div style="margin-left:8px;font-size:14px;font-weight:700;color:${det.confidence>0.5?'#ff4757':det.confidence>0.3?'#ffa502':'#00c896'};">
        ${(det.confidence*100).toFixed(0)}%
      </div>
    </div>`).join('');
}


// ================================================================
// 11. PERSISTENZA DATI (localStorage)
// ================================================================
function saveSitesToStorage() {
  try { localStorage.setItem(LS_KEY, JSON.stringify(state.sites)); }
  catch(e) { showToast('Storage pieno.', 'error'); }
}
function loadSitesFromStorage() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw);
    if (!Array.isArray(saved)) return;
    state.sites = saved;
    saved.forEach(s => addSiteToMap(s));
    renderSitesList();
    if (saved.length > 0) showToast(`📂 ${saved.length} siti caricati.`, 'info');
  } catch(e) { console.warn('[Storage]', e); }
}
function deleteSite(id) {
  if (state.markers[id]) { state.markerCluster.removeLayer(state.markers[id]); delete state.markers[id]; }
  state.sites = state.sites.filter(s => s.id !== id);
  saveSitesToStorage(); renderSitesList(); state.map.closePopup();
  showToast('Sito eliminato.', 'info');
}
function clearAllMarkers() {
  if (!state.sites.length) { showToast('Nessun sito.', 'info'); return; }
  if (!confirm(`Eliminare tutti i ${state.sites.length} siti?`)) return;
  state.markerCluster.clearLayers(); state.markers = {}; state.sites = [];
  localStorage.removeItem(LS_KEY); renderSitesList();
  showToast('🗑️ Tutti i siti eliminati.', 'info');
}
function renderSitesList() {
  const container = document.getElementById('sitesList');
  const countEl   = document.getElementById('siteCount');
  if (!container || !countEl) return;
  countEl.textContent = state.sites.length;
  if (!state.sites.length) {
    container.innerHTML = '<p class="empty-state">Nessun sito registrato.<br/>Attiva la modalità marker e clicca sulla mappa.</p>';
    return;
  }
  container.innerHTML = state.sites.map(s => `
    <div class="site-item">
      <div class="site-item-name">⚠️ ${s.name}</div>
      <div class="site-item-coords">📍 ${s.comune}</div>
      <div class="site-item-coords">${s.lat}, ${s.lng}</div>
      <div class="site-item-coords" style="font-size:10px;margin-top:2px;">🕐 ${s.timestamp}</div>
      <div class="site-item-actions">
        <button class="site-btn goto" onclick="flyToSite('${s.id}')">🗺️ Vai</button>
        <button class="site-btn goto" onclick="runAutoRiskAnalysis(${s.lat},${s.lng},3)">🔍 Analizza</button>
        <button class="site-btn del" onclick="deleteSite('${s.id}')">🗑️</button>
      </div>
    </div>`).join('');
}
function flyToSite(id) {
  const s = state.sites.find(x => x.id === id); if (!s) return;
  state.map.flyTo([s.lat, s.lng], 15, { animate:true, duration:1.5 });
  setTimeout(() => {
    const m = state.markers[id];
    if (m) state.markerCluster.zoomToShowLayer(m, () => m.openPopup());
  }, 1600);
}
function exportGeoJSON() {
  if (!state.sites.length) { showToast('Nessun sito da esportare.', 'error'); return; }
  const gj = { type:'FeatureCollection', features: state.sites.map(s => ({
    type:'Feature', geometry:{ type:'Point', coordinates:[s.lng,s.lat] },
    properties:{ id:s.id, name:s.name, comune:s.comune, timestamp:s.timestamp, note:s.note }
  }))};
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(gj,null,2)], { type:'application/geo+json' }));
  a.download = `argus_siti_${new Date().toISOString().slice(0,10)}.geojson`;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  showToast(`📥 GeoJSON esportato (${state.sites.length} siti).`, 'success');
}

// ================================================================
// 12. UI HELPERS
// ================================================================
function toggleSidebar() {
  document.getElementById('sidebar').classList.toggle('open');
  document.getElementById('sidebarOverlay').classList.toggle('active');
}
function showSpinner(v) {
  const el = document.getElementById('spinner');
  if (el) el.classList.toggle('active', v);
}
function showToast(msg, type='info', dur=3500) {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.className   = `toast ${type} show`;
  clearTimeout(t._t);
  t._t = setTimeout(() => t.classList.remove('show'), dur);
}

// ================================================================
// 13. PWA INSTALL
// ================================================================
window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  state.deferredInstall = e;
  if (!window.matchMedia('(display-mode: standalone)').matches) {
    const b = document.getElementById('installBanner');
    if (b) b.style.display = 'flex';
  }
});
async function installPWA() {
  if (!state.deferredInstall) {
    showToast('Usa "Aggiungi a schermata Home" dal menu del browser.', 'info', 5000);
    return;
  }
  state.deferredInstall.prompt();
  const { outcome } = await state.deferredInstall.userChoice;
  if (outcome === 'accepted') showToast('✅ Argus installato!', 'success');
  state.deferredInstall = null;
  const b = document.getElementById('installBanner');
  if (b) b.style.display = 'none';
}
window.addEventListener('appinstalled', () => {
  const b = document.getElementById('installBanner');
  if (b) b.style.display = 'none';
  showToast('✅ Argus installato!', 'success');
});

// ================================================================
// 14. KEYBOARD SHORTCUTS
// ================================================================
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    if (state.addMarkerMode) {
      state.addMarkerMode = false;
      const btn = document.getElementById('addMarkerBtn');
      if (btn) btn.classList.remove('active');
      state.map.getContainer().style.cursor = '';
    }
    const sb = document.getElementById('sidebar');
    if (sb && sb.classList.contains('open')) toggleSidebar();
  }
  if (e.key === 'Enter' && document.activeElement.id === 'searchInput') searchComune();
});

// ================================================================
// 15. SERVICE WORKER (PWA)
// ================================================================
async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  try {
    const reg = await navigator.serviceWorker.register('./sw.js', { scope:'./' });
    reg.addEventListener('updatefound', () => {
      const nw = reg.installing;
      nw.addEventListener('statechange', () => {
        if (nw.state === 'installed' && navigator.serviceWorker.controller)
          showToast('🔄 Aggiornamento disponibile. Ricarica la pagina.', 'info', 6000);
      });
    });
  } catch(e) { console.warn('[SW]', e); }
}

// ================================================================
// 16. BOOTSTRAP
// ================================================================
document.addEventListener('DOMContentLoaded', () => {
  initMap();
  registerServiceWorker();
});

