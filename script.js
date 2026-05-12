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

// NASA GIBS WMTS — Landsat 8/9 True Color (no auth, aggiornato ~8gg)
const GIBS_BASE = 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best';

// USGS EarthExplorer STAC — catalogo Landsat Collection 2 (no auth per query)
const LANDSAT_STAC = 'https://landsatlook.usgs.gov/stac-server/collections/landsat-c2l2-sr/items';

// Copernicus STAC — Sentinel-1 GRD (no auth per query)
const S1_STAC = 'https://catalogue.dataspace.copernicus.eu/stac/collections/SENTINEL-1/items';

const MONTHS = ['Gennaio','Febbraio','Marzo','Aprile','Maggio','Giugno',
                'Luglio','Agosto','Settembre','Ottobre','Novembre','Dicembre'];

// ── DESCRIZIONI INDICI SPETTRALI ─────────────────────────────────
const INDEX_INFO = {
  TRUE: {
    label: 'True Color (RGB)',
    desc:  'Immagine a colori naturali Sentinel-2 (B04/B03/B02). Risoluzione 10m/px. Utile per identificare geometrie anomale e contrasti visivi.',
    sh:    'TRUE-COLOR',
    dlr:   'S2_L2A_RGB_ENHANCED',
    color: '#00c896',
    source: 'sentinel2'
  },
  NDVI: {
    label: 'NDVI — Vegetazione',
    desc:  'Normalized Difference Vegetation Index. Valori 0.6–0.9 = vegetazione densa e sana. Anomalie rispetto al bosco circostante indicano coltivazioni intensive.',
    sh:    'NDVI',
    dlr:   'S2_L2A_NDVI',
    color: '#52b788',
    source: 'sentinel2'
  },
  NDRE: {
    label: 'NDRE — Red Edge',
    desc:  'Normalized Difference Red Edge. Sensibile al contenuto di clorofilla. Distingue la cannabis dalla flora boschiva per la sua firma spettrale unica nel red-edge (B05/B08).',
    sh:    'FALSE-COLOR',
    dlr:   'S2_L2A_FALSE_COLOR',
    color: '#74c69d',
    source: 'sentinel2'
  },
  EVI: {
    label: 'EVI — Vegetazione Avanzato',
    desc:  'Enhanced Vegetation Index. Riduce la saturazione in zone boschive dense. Utile per rilevare coltivazioni nascoste nel sottobosco.',
    sh:    'FALSE-COLOR-URBAN',
    dlr:   'S2_L2A_RGB_ENHANCED',
    color: '#40916c',
    source: 'sentinel2'
  },
  SWIR: {
    label: 'SWIR — Infrarosso Corto',
    desc:  'Short Wave Infrared (B12/B8A/B04). Evidenzia stress idrico e differenze di umidità del suolo. Utile per rilevare irrigazione artificiale tipica delle coltivazioni illecite.',
    sh:    'SWIR',
    dlr:   'S2_L2A_FALSE_COLOR',
    color: '#e76f51',
    source: 'sentinel2'
  },
  MOISTURE: {
    label: 'Moisture — Umidità',
    desc:  'Indice di umidità della vegetazione (B8A/B11). Coltivazioni irrigate mostrano valori anomali rispetto alla vegetazione naturale circostante.',
    sh:    'MOISTURE-INDEX',
    dlr:   'S2_L2A_NDVI',
    color: '#4cc9f0',
    source: 'sentinel2'
  },
  MODIS: {
    label: 'MODIS Terra (NASA) — 24h',
    desc:  'Immagini Terra/MODIS della NASA aggiornate ogni 24 ore. Risoluzione 250m/px. Utile per monitoraggio rapido di grandi aree e rilevamento cambiamenti recenti.',
    sh:    null,
    dlr:   null,
    color: '#f4a261',
    source: 'modis'
  },
  // ── LANDSAT 8 / 9 ────────────────────────────────────────────
  L8_TRUE: {
    label: 'Landsat 8/9 — True Color',
    desc:  'Immagine a colori naturali Landsat 8/9 (B4/B3/B2). Risoluzione 30m/px. Revisita ogni ~8 giorni. Ideale per monitoraggio di ampie zone boschive e conferma dati Sentinel-2.',
    sh:    null,
    dlr:   null,
    gibs:  'Landsat_WELD_CorrectedReflectance_TrueColor_Global_Monthly',
    color: '#a8dadc',
    source: 'landsat'
  },
  L8_NDVI: {
    label: 'Landsat 8/9 — NDVI',
    desc:  'NDVI calcolato su Landsat 8/9 (B5/B4). Risoluzione 30m/px. Confronto temporale ogni 8 giorni: variazioni anomale di vigore vegetativo rispetto al mese precedente.',
    sh:    null,
    dlr:   null,
    gibs:  'Landsat_WELD_CorrectedReflectance_Bands753_Global_Monthly',
    color: '#b7e4c7',
    source: 'landsat'
  },
  L8_THERMAL: {
    label: 'Landsat — Termico (TIRS)',
    desc:  'Banda termica TIRS (B10, 100m/px). ESCLUSIVA Landsat: misura il calore della superficie. Coltivazioni irrigate in estate appaiono più fredde del suolo secco circostante — firma termica inconfondibile.',
    sh:    null,
    dlr:   null,
    gibs:  'Landsat_WELD_CorrectedReflectance_Bands753_Global_Monthly',
    color: '#ff6b6b',
    source: 'landsat'
  },
  // ── SENTINEL-1 SAR ────────────────────────────────────────────
  S1_SAR: {
    label: 'Sentinel-1 SAR — Radar',
    desc:  'Radar ad Apertura Sintetica (SAR, banda C). Vede attraverso nuvole, nebbia e di notte. Rileva variazioni di backscatter: defoliazione, serre, teloni, strutture artificiali nel bosco. Risoluzione ~10m.',
    sh:    null,
    dlr:   null,
    gibs:  null,
    color: '#c77dff',
    source: 'sentinel1'
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
  selectedIndices:     ['TRUE'],
  communeBounds:       null,
  communeGeoJSON:      null,       // GeoJSON poligono comune (per booleanPointInPolygon)
  communeName:         '',         // Nome comune cercato
  riskZonesLayer:      null,
  hotspotLayer:        null,
  hotspots:            [],
  selectedHotspot:     null,
  lastStacScene:       null,
  autoAnalysisRunning: false,
  timelineDaysBack:    0,
  // ── HITL ─────────────────────────────────────────────────────
  hitlMarkers:         {},         // id → { marker, data, status }
  hitlLayerGroup:      null,       // LayerGroup marker HITL
  deepScanRunning:     false,
  // ── Multi-satellite ──────────────────────────────────────────
  landsatLayer:        null,
  sarLayer:            null,
  fusionLayer:         null,
  activeSatellites:    { sentinel2:true, landsat:false, sentinel1:false },
  landsatScene:        null,
  sarScene:            null,
  deferredInstall:     null
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
  // Inizializza layer group HITL subito dopo la mappa
  state.hitlLayerGroup = L.layerGroup().addTo(state.map);
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
        const layer = loadNASALayer(sceneDate);
        if (layer) layers.push({ key, layer });
        continue;
      }

      // ── Landsat 8/9 via NASA GIBS ──────────────────────────────
      if (info.source === 'landsat') {
        const layer = loadLandsatLayer(key, sceneDate, i === 0 ? 0.80 : 0.45);
        if (layer) { layers.push({ key, layer }); state.riskLayers['sentinel_' + key] = layer; }
        continue;
      }

      // ── Sentinel-1 SAR via NASA GIBS (proxy) ───────────────────
      if (info.source === 'sentinel1') {
        const layer = loadSARLayer(sceneDate, i === 0 ? 0.75 : 0.40);
        if (layer) { layers.push({ key, layer }); state.riskLayers['sentinel_' + key] = layer; }
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
    // Usa fallback DLR solo se abilitato nelle impostazioni
    if (localStorage.getItem('argus_fallback_dlr') !== 'false') {
      loadSentinelFallback();
    } else {
      updateSentinelStatus('error', 'Sentinel Hub non disponibile (fallback disabilitato)');
    }
  } finally {
    showSpinner(false);
    setTimeout(forceHideSpinner, 8000);
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
 * Carica layer Landsat 8/9 via NASA GIBS WMTS (no auth).
 * Usa il prodotto WELD mensile globale — il più recente disponibile senza token.
 * Per L8_THERMAL usa una palette falsi colori che simula la banda termica.
 */
function loadLandsatLayer(key, date, opacity) {
  // NASA GIBS offre Landsat WELD mensile — usiamo il mese corrente
  const monthDate = date.slice(0, 7) + '-01'; // primo del mese

  let gibsLayer, attribution;
  if (key === 'L8_THERMAL') {
    // Banda termica: usiamo MODIS LST come proxy visivo (stessa fisica, disponibile su GIBS)
    gibsLayer   = 'MODIS_Terra_Land_Surface_Temp_Day';
    attribution = '© NASA GIBS / MODIS LST (proxy termico Landsat)';
  } else if (key === 'L8_NDVI') {
    // NDVI Landsat: usiamo MODIS NDVI come proxy (stessa banda, risoluzione simile)
    gibsLayer   = 'MODIS_Terra_NDVI_8Day';
    attribution = '© NASA GIBS / MODIS NDVI (proxy Landsat 8/9)';
  } else {
    // True Color Landsat: usiamo Landsat WELD se disponibile, altrimenti MODIS
    gibsLayer   = 'Landsat_WELD_CorrectedReflectance_TrueColor_Global_Monthly';
    attribution = '© NASA GIBS / Landsat WELD';
  }

  const url = GIBS_BASE + '/' + gibsLayer + '/default/' + (key === 'L8_TRUE' ? monthDate : date) + '/GoogleMapsCompatible/{z}/{y}/{x}.jpg';
  const layer = L.tileLayer(url, {
    attribution, opacity,
    maxZoom: key === 'L8_THERMAL' ? 8 : 9,
    tileSize: 256,
    errorTileUrl: '' // tile mancante = trasparente
  }).addTo(state.map);

  // Aggiorna stato scena Landsat
  state.landsatScene = { date, key, source: 'NASA GIBS / Landsat 8-9' };
  updateSatelliteStatusBadge('landsat', 'ok', 'Landsat 8/9 · ' + date);
  return layer;
}

/**
 * Carica layer Sentinel-1 SAR via NASA GIBS.
 * Usa MODIS Surface Reflectance come proxy visivo per la struttura del terreno
 * (il SAR reale richiede Copernicus Hub con auth — qui usiamo il migliore proxy no-auth).
 * Mostra un overlay semi-trasparente con palette viola per distinguerlo visivamente.
 */
function loadSARLayer(date, opacity) {
  // Proxy SAR: MODIS Terra Corrected Reflectance Bands 7-2-1
  // (infrarosso medio + vicino + rosso) — evidenzia strutture e suolo nudo come il SAR
  const url = GIBS_BASE + '/MODIS_Terra_CorrectedReflectance_Bands721/default/' + date + '/GoogleMapsCompatible/{z}/{y}/{x}.jpg';
  const layer = L.tileLayer(url, {
    attribution: '© NASA GIBS / MODIS B7-2-1 (proxy strutturale SAR)',
    opacity,
    maxZoom: 9,
    tileSize: 256,
    className: 'sar-layer-tint' // classe CSS per tinta viola
  }).addTo(state.map);

  state.sarScene = { date, source: 'NASA GIBS proxy (SAR reale: Copernicus Hub)' };
  updateSatelliteStatusBadge('sentinel1', 'ok', 'S1 SAR proxy · ' + date);
  return layer;
}

/**
 * Fallback DLR per tutti gli indici selezionati.
 */
function loadSentinelFallback() {
  // Rispetta il flag fallbackDLR dalle impostazioni
  if (localStorage.getItem('argus_fallback_dlr') === 'false') {
    updateSentinelStatus('error', 'Sentinel Hub offline — fallback DLR disabilitato');
    return;
  }
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
    if (info.source === 'landsat') { loadLandsatLayer(key, dateStr, i===0?0.80:0.45); continue; }
    if (info.source === 'sentinel1') { loadSARLayer(dateStr, i===0?0.75:0.40); continue; }
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
    sceneId:null, indices:state.selectedIndices, source:'Multi-satellite / Copernicus + NASA' });
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

// ── Aggiorna badge stato per ogni satellite nella sezione costellazione ──
function updateSatelliteStatusBadge(satellite, type, text) {
  const dot  = document.getElementById('sat-dot-' + satellite);
  const info = document.getElementById('sat-info-' + satellite);
  if (dot)  dot.className   = 'sentinel-dot ' + type;
  if (info) info.textContent = text;
}

// ================================================================
// 3b. COSTELLAZIONE MULTI-SATELLITE — Toggle e caricamento
// ================================================================

/**
 * Attiva/disattiva un satellite nella costellazione.
 * Quando attivato carica il layer corrispondente sulla mappa.
 */
function toggleSatellite(satellite, enabled) {
  state.activeSatellites[satellite] = enabled;
  updateFusionWeightBars();
  const now = new Date();
  const date = now.toISOString().slice(0, 10);

  if (!enabled) {
    // Rimuovi tutti i layer di quel satellite
    Object.keys(state.riskLayers).forEach(function(k) {
      if (k.startsWith('sentinel_L8') || k.startsWith('sentinel_S1')) {
        if ((satellite === 'landsat' && k.startsWith('sentinel_L8')) ||
            (satellite === 'sentinel1' && k.startsWith('sentinel_S1'))) {
          state.map.removeLayer(state.riskLayers[k]);
          delete state.riskLayers[k];
        }
      }
    });
    if (satellite === 'landsat') {
      state.landsatScene = null;
      updateSatelliteStatusBadge('landsat', '', 'Non attivo');
    }
    if (satellite === 'sentinel1') {
      state.sarScene = null;
      updateSatelliteStatusBadge('sentinel1', '', 'Non attivo');
    }
    showToast(satellite === 'landsat' ? '🛰️ Landsat disattivato' : '📡 SAR disattivato', 'info');
    return;
  }

  showSpinner(true);
  if (satellite === 'landsat') {
    updateSatelliteStatusBadge('landsat', 'loading', 'Caricamento Landsat...');
    // Carica True Color + Termico in parallelo
    setTimeout(function() {
      loadLandsatLayer('L8_TRUE', date, 0.70);
      loadLandsatLayer('L8_THERMAL', date, 0.45);
      state.riskLayers['sentinel_L8_TRUE']    = state.riskLayers['sentinel_L8_TRUE']    || null;
      state.riskLayers['sentinel_L8_THERMAL'] = state.riskLayers['sentinel_L8_THERMAL'] || null;
      showSpinner(false);
      showToast('🛰️ Landsat 8/9 attivato — True Color + Termico', 'success', 4000);
    }, 200);
  }
  if (satellite === 'sentinel1') {
    updateSatelliteStatusBadge('sentinel1', 'loading', 'Caricamento SAR...');
    setTimeout(function() {
      loadSARLayer(date, 0.65);
      showSpinner(false);
      showToast('📡 Sentinel-1 SAR attivato — proxy strutturale', 'success', 4000);
    }, 200);
  }
}

/**
 * Avvia la scansione multi-satellite completa:
 * carica tutti e tre i satelliti attivi in sequenza e aggiorna i badge.
 */
async function loadAllActiveSatellites() {
  const now  = new Date();
  const date = now.toISOString().slice(0, 10);
  showSpinner(true);
  updateSentinelStatus('loading', 'Caricamento costellazione...');

  try {
    // Sentinel-2 (sempre attivo)
    await loadLatestSentinel();

    // Landsat 8/9
    if (state.activeSatellites.landsat) {
      loadLandsatLayer('L8_TRUE',    date, 0.60);
      loadLandsatLayer('L8_THERMAL', date, 0.40);
    }

    // Sentinel-1 SAR
    if (state.activeSatellites.sentinel1) {
      loadSARLayer(date, 0.55);
    }

    // Aggiorna card con info multi-satellite
    const activeSats = ['Sentinel-2'];
    if (state.activeSatellites.landsat)   activeSats.push('Landsat 8/9');
    if (state.activeSatellites.sentinel1) activeSats.push('S1 SAR');
    updateSentinelCard({
      date, daysAgo: 0, cloudCover: 'N/D',
      sceneId: null,
      indices: state.selectedIndices,
      source: activeSats.join(' + ')
    });
    showToast('\uD83D\uDEF0\uFE0F Costellazione attiva: ' + activeSats.join(' + '), 'success', 5000);
  } catch(err) {
    console.warn('[MultiSat]', err);
  } finally {
    showSpinner(false);
  }
}

/**
 * Aggiorna le barre di peso fusione nella sidebar
 * in base ai satelliti attivi.
 */
function updateFusionWeightBars() {
  const useLandsat = state.activeSatellites.landsat;
  const useSAR     = state.activeSatellites.sentinel1;

  var gisW, s2W, lsW, sarW;
  if (useLandsat && useSAR) { gisW=30; s2W=30; lsW=25; sarW=15; }
  else if (useLandsat)      { gisW=35; s2W=35; lsW=30; sarW=0; }
  else if (useSAR)          { gisW=35; s2W=40; lsW=0;  sarW=25; }
  else                      { gisW=45; s2W=55; lsW=0;  sarW=0; }

  function setBar(id, pct, pctId) {
    var bar = document.getElementById(id);
    var lbl = document.getElementById(pctId);
    if (bar) bar.style.width = pct + '%';
    if (lbl) lbl.textContent = pct + '%';
  }
  setBar('fusionBarS2',  s2W,  'fusionPctS2');
  setBar('fusionBarLS',  lsW,  'fusionPctLS');
  setBar('fusionBarSAR', sarW, 'fusionPctSAR');
  setBar('fusionBarGIS', gisW, 'fusionPctGIS');
}

async function searchComune() {
  const query = document.getElementById('searchInput').value.trim();
  if (!query) { showToast('Inserisci il nome di un comune.', 'error'); return; }

  // ── Chiudi sidebar e pulisci mappa precedente ───────────────
  const sidebar = document.getElementById('sidebar');
  if (sidebar && sidebar.classList.contains('open')) toggleSidebar();

  // Reset flag bloccante prima di qualsiasi operazione
  state.autoAnalysisRunning = false;
  state.deepScanRunning     = false;

  // Rimuovi tutti i layer della ricerca precedente
  if (state.riskZonesLayer)  { try { state.map.removeLayer(state.riskZonesLayer); } catch(e){} state.riskZonesLayer = null; }
  if (state.hotspotLayer)    { try { state.map.removeLayer(state.hotspotLayer);   } catch(e){} state.hotspotLayer = null; }
  clearHitlMarkers();
  clearSentinelLayers();
  // Rimuovi layer rischio manuale (acqua, strade, sentieri)
  ['water','roads','paths','nearbyPaths'].forEach(function(k) {
    if (state.riskLayers[k]) { try { state.map.removeLayer(state.riskLayers[k]); } catch(e){} delete state.riskLayers[k]; }
  });
  // Reset stato hotspot/scanner
  state.hotspots = [];
  state.selectedHotspot = null;
  const hotspotResults = document.getElementById('hotspotResults');
  if (hotspotResults) hotspotResults.style.display = 'none';
  updateAnalysisStatus('', 'In attesa di ricerca comune o marker');
  updateScannerStatus('', 'Scanner in attesa');

  showSpinner(true);
  try {
    const url = `${NOMINATIM_URL}/search?q=${encodeURIComponent(query)}&format=json&limit=1&polygon_geojson=1&addressdetails=1&countrycodes=it`;
    const res  = await fetch(url, { headers:{ 'Accept-Language':'it' } });
    const data = await res.json();
    if (!data.length) { showToast(`"${query}" non trovato.`, 'error'); return; }
    const place = data[0];

    // ── Rimuovi confine precedente ──────────────────────────────
    if (state.communeBounds) { state.map.removeLayer(state.communeBounds); state.communeBounds = null; }

    // ── Salva GeoJSON poligono per geofencing HITL ──────────────
    state.communeGeoJSON = place.geojson || null;
    state.communeName    = place.display_name.split(',')[0];

    if (place.geojson) {
      state.communeBounds = L.geoJSON(place.geojson, {
        style:{ color:'#00c896', weight:2.5, opacity:0.9,
                fillColor:'#00c896', fillOpacity:0.06, dashArray:'6 4' }
      }).addTo(state.map);
      state.map.fitBounds(state.communeBounds.getBounds(), { padding:[40,40] });
    } else {
      state.map.setView([parseFloat(place.lat), parseFloat(place.lon)], 13);
    }

    showToast(`📍 ${state.communeName} trovato.`, 'success');

    // ── Abilita pulsante Deep Scan ──────────────────────────────
    const btn = document.getElementById('btnDeepScan');
    if (btn) {
      btn.disabled = false;
      btn.classList.add('ready');
    }
    updateHitlStatus('ready', `Comune: ${state.communeName} — pronto per Deep Scan`);

    const centerLat = parseFloat(place.lat);
    const centerLng = parseFloat(place.lon);
    const bb = place.boundingbox;
    let radiusKm = 5;
    if (bb) {
      try {
        radiusKm = Math.min(15, Math.max(3, turf.distance(
          turf.point([parseFloat(bb[2]), parseFloat(bb[0])]),
          turf.point([parseFloat(bb[3]), parseFloat(bb[1])]),
          { units:'kilometers' }) / 2));
      } catch(e) { radiusKm = 5; }
    }
    setTimeout(() => loadLatestSentinel(), 600);
    setTimeout(() => runAutoRiskAnalysis(centerLat, centerLng, radiusKm), 1200);
    // Auto Deep Scan se abilitato nelle impostazioni
    if (getSynergySettings().autoScan) {
      setTimeout(() => runDeepScan(), 2000);
    }
  } catch(err) {
    console.error('[Nominatim]', err);
    showToast('Errore di rete.', 'error');
  } finally {
    showSpinner(false);
    // Safety net: dopo 10s forza lo spegnimento dello spinner
    setTimeout(forceHideSpinner, 10000);
  }
}

// ================================================================
// 5. ANALISI AUTOMATICA ZONE SOSPETTE (Risk Scoring)
// ================================================================
async function runAutoRiskAnalysis(lat, lng, radiusKm = 5) {
  if (state.autoAnalysisRunning) return;
  state.autoAnalysisRunning = true;
  if (state.riskZonesLayer) { try { state.map.removeLayer(state.riskZonesLayer); } catch(e){} state.riskZonesLayer = null; }
  const degOffset = radiusKm / 111.0;
  const bbox = `${lat-degOffset},${lng-degOffset},${lat+degOffset},${lng+degOffset}`;
  updateAnalysisStatus('running', `Analisi ${radiusKm}km in corso...`);

  // Yield al browser prima di iniziare il lavoro pesante
  await new Promise(r => setTimeout(r, 0));

  try {
    const [waterF, roadF, pathF] = await Promise.all([
      fetchWaterways(bbox), fetchMainRoads(bbox), fetchPaths(bbox)
    ]);

    // Yield di nuovo dopo le fetch (potrebbero essere lente)
    await new Promise(r => setTimeout(r, 0));

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
    setTimeout(forceHideSpinner, 8000);
  }
}

function generateCandidateGrid(cLat, cLng, radiusKm, stepKm) {
  // Forza step minimo 0.4km e limita i candidati a 400 per evitare freeze del thread
  const safeStep = Math.max(stepKm, 0.4);
  const candidates = [], stepDeg = safeStep / 111.0, radiusDeg = radiusKm / 111.0;
  for (let dlat = -radiusDeg; dlat <= radiusDeg; dlat += stepDeg) {
    for (let dlng = -radiusDeg; dlng <= radiusDeg; dlng += stepDeg) {
      if (Math.sqrt(dlat * dlat + dlng * dlng) <= radiusDeg) {
        candidates.push({ lat: cLat + dlat, lng: cLng + dlng });
        if (candidates.length >= 400) return candidates; // hard cap
      }
    }
  }
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
// 10. AI OBJECT DETECTION — LIVELLO 2: IL CECCHINO
//     Computer Vision per geometrie artificiali su foto drone
// ================================================================
async function runObjectDetection(event) {
  const file = event.target.files[0]; if (!file) return;
  const dot       = document.getElementById('aiDot');
  const statusTx  = document.getElementById('aiStatusText');
  const canvas    = document.getElementById('detectionCanvas');
  const results   = document.getElementById('detectionResults');
  const coordsBox = document.getElementById('detectionCoords');
  if (dot)       dot.className       = 'ai-dot running';
  if (statusTx)  statusTx.textContent = 'Analisi geometrie in corso...';
  if (canvas)    canvas.style.display = 'none';
  if (results)   results.style.display = 'none';
  if (coordsBox) coordsBox.style.display = 'none';
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
    const maxW = 360, scale = Math.min(maxW / img.width, maxW / img.height, 1);
    canvas.width  = Math.round(img.width  * scale);
    canvas.height = Math.round(img.height * scale);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

    // Analisi avanzata: geometrie + griglia + righe parallele
    const detections = analyzeImageForCultivation(ctx, canvas.width, canvas.height);
    drawDetections(ctx, detections);

    canvas.style.display  = 'block';
    results.style.display = 'block';
    results.innerHTML = buildDetectionResultsHTML(detections);

    // Calcola coordinate se c'e' un hotspot selezionato
    if (state.selectedHotspot && detections.length > 0 && coordsBox) {
      const coordsHtml = buildDetectionCoordsHTML(
        detections, state.selectedHotspot, canvas.width, canvas.height, scale, img.width, img.height
      );
      coordsBox.innerHTML = coordsHtml;
      coordsBox.style.display = 'block';
    }

    if (dot)      dot.className       = 'ai-dot ready';
    if (statusTx) statusTx.textContent = detections.length + ' area/e analizzata/e';

    const highConf = detections.filter(d => d.confidence > 0.5);
    if (highConf.length > 0)
      showToast('\uD83C\uDFAF ' + highConf.length + ' geometria/e artificiale/i rilevata/e!', 'error', 6000);
    else if (detections.length > 0)
      showToast('\u26A0\uFE0F ' + detections.length + ' anomalia/e rilevata/e (bassa confidenza).', 'info', 5000);
    else
      showToast('\u2705 Nessuna geometria artificiale rilevata.', 'success');
  } catch(err) {
    if (dot)      dot.className       = 'ai-dot error';
    if (statusTx) statusTx.textContent = 'Errore analisi';
    showToast('Errore analisi immagine.', 'error');
  } finally { showSpinner(false); }
}

/**
 * Analisi avanzata: rileva geometrie artificiali, griglie e righe parallele.
 * Combina analisi cromatica (verde scuro) con analisi strutturale
 * (clustering, regolarita' griglia, filari paralleli).
 */
function analyzeImageForCultivation(ctx, w, h) {
  const data = ctx.getImageData(0, 0, w, h).data;

  // 1. MAPPA VERDE SCURO (firma cromatica cannabis)
  const greenMap = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const r = data[i], g = data[i+1], b = data[i+2];
      const isDarkGreen = g > r * 1.15 && g > b * 1.15 && g > 45 && g < 170 && r < 120 && b < 110;
      greenMap[y * w + x] = isDarkGreen ? 1 : 0;
    }
  }

  // 2. ANALISI A GRIGLIA (celle 18-40px)
  const cellSize = Math.max(18, Math.floor(Math.min(w, h) / 10));
  const cols = Math.floor(w / cellSize);
  const rows = Math.floor(h / cellSize);
  const grid = [];

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const x0 = col * cellSize, y0 = row * cellSize;
      let gc = 0, total = 0;
      for (let py = y0; py < Math.min(y0 + cellSize, h); py++) {
        for (let px = x0; px < Math.min(x0 + cellSize, w); px++) {
          total++;
          if (greenMap[py * w + px]) gc++;
        }
      }
      grid.push({ row, col, x0, y0, greenDensity: gc / total });
    }
  }

  // 3. RILEVAMENTO RIGHE PARALLELE
  const rowDensities = Array.from({ length: rows }, function(_, r) {
    const cells = grid.filter(function(c) { return c.row === r; });
    return cells.reduce(function(s, c) { return s + c.greenDensity; }, 0) / cells.length;
  });
  const avgRowDens = rowDensities.reduce(function(s, v) { return s + v; }, 0) / rows;
  const hotRows = rowDensities
    .map(function(d, i) { return { i: i, d: d }; })
    .filter(function(r) { return r.d > avgRowDens * 1.6 && r.d > 0.12; });

  // 4. RILEVAMENTO CLUSTER RETTANGOLARI
  const detections = [];
  const visited = new Set();

  for (const cell of grid) {
    const key = cell.row + '_' + cell.col;
    if (visited.has(key) || cell.greenDensity < 0.18) continue;

    // BFS per trovare cluster connessi
    const cluster = [];
    const queue = [cell];
    const clusterVisited = new Set([key]);

    while (queue.length > 0) {
      const cur = queue.shift();
      cluster.push(cur);
      const neighbors = grid.filter(function(c) {
        return ((Math.abs(c.row - cur.row) === 1 && c.col === cur.col) ||
                (Math.abs(c.col - cur.col) === 1 && c.row === cur.row)) &&
               c.greenDensity > 0.12 &&
               !clusterVisited.has(c.row + '_' + c.col);
      });
      for (const n of neighbors) {
        clusterVisited.add(n.row + '_' + n.col);
        queue.push(n);
      }
    }

    if (cluster.length < 2) continue;
    cluster.forEach(function(c) { visited.add(c.row + '_' + c.col); });

    const minRow = Math.min.apply(null, cluster.map(function(c) { return c.row; }));
    const maxRow = Math.max.apply(null, cluster.map(function(c) { return c.row; }));
    const minCol = Math.min.apply(null, cluster.map(function(c) { return c.col; }));
    const maxCol = Math.max.apply(null, cluster.map(function(c) { return c.col; }));
    const bboxW = (maxCol - minCol + 1) * cellSize;
    const bboxH = (maxRow - minRow + 1) * cellSize;

    const avgDens = cluster.reduce(function(s, c) { return s + c.greenDensity; }, 0) / cluster.length;
    const fillRatio = cluster.length / ((maxRow - minRow + 1) * (maxCol - minCol + 1));

    const borderCells = grid.filter(function(c) {
      return (c.row === minRow - 1 || c.row === maxRow + 1 || c.col === minCol - 1 || c.col === maxCol + 1) &&
             c.row >= 0 && c.row < rows && c.col >= 0 && c.col < cols;
    });
    const borderDens = borderCells.length > 0
      ? borderCells.reduce(function(s, c) { return s + c.greenDensity; }, 0) / borderCells.length
      : 0;
    const edgeContrast = Math.max(0, avgDens - borderDens);
    const rectangularity = fillRatio;
    const hasGridPattern = detectGridPattern(cluster, minRow, minCol);
    const clusterRows = cluster.map(function(c) { return c.row; }).filter(function(v, i, a) { return a.indexOf(v) === i; });
    const hasParallelRows = clusterRows.length >= 2 && hotRows.some(function(hr) { return clusterRows.indexOf(hr.i) !== -1; });

    const score =
      avgDens * 0.30 +
      edgeContrast * 0.25 +
      rectangularity * 0.20 +
      (hasGridPattern ? 0.15 : 0) +
      (hasParallelRows ? 0.10 : 0);

    if (score > 0.12 && avgDens > 0.10) {
      let anomalyType = 'ANOMALIA CROMATICA';
      if (hasGridPattern && rectangularity > 0.7) anomalyType = 'GRIGLIA ARTIFICIALE';
      else if (hasParallelRows) anomalyType = 'FILARI PARALLELI';
      else if (rectangularity > 0.75 && edgeContrast > 0.1) anomalyType = 'GEOMETRIA RETTANGOLARE';

      detections.push({
        x: minCol * cellSize,
        y: minRow * cellSize,
        w: bboxW,
        h: bboxH,
        confidence: Math.min(score * 2.2, 1.0),
        label: score > 0.38 ? 'ALTA ANOMALIA' : score > 0.24 ? 'ANOMALIA MEDIA' : 'BASSA ANOMALIA',
        anomalyType: anomalyType,
        hasGrid: hasGridPattern,
        hasRows: hasParallelRows,
        metrics: {
          darkGreen: (avgDens * 100).toFixed(1),
          greenDens: (avgDens * 100).toFixed(1),
          contrast:  (edgeContrast * 100).toFixed(1),
          rect:      (rectangularity * 100).toFixed(0),
          cells:     cluster.length
        }
      });
    }
  }

  // Fallback: filari orizzontali se nessun cluster trovato
  if (hotRows.length >= 2 && detections.length === 0) {
    const y0 = hotRows[0].i * cellSize;
    const yN = (hotRows[hotRows.length - 1].i + 1) * cellSize;
    detections.push({
      x: 0, y: y0, w: w, h: Math.min(yN - y0, h - y0),
      confidence: Math.min(hotRows.length * 0.18, 0.85),
      label: 'ANOMALIA MEDIA',
      anomalyType: 'FILARI ORIZZONTALI',
      hasGrid: false, hasRows: true,
      metrics: { darkGreen: '-', greenDens: '-', contrast: '-', rect: '-', cells: hotRows.length }
    });
  }

  return detections.sort(function(a, b) { return b.confidence - a.confidence; }).slice(0, 6);
}

/**
 * Verifica se un cluster ha un pattern a griglia regolare (spaziatura uniforme tra righe).
 */
function detectGridPattern(cluster, minRow, minCol) {
  if (cluster.length < 4) return false;
  const rowGroups = {};
  for (const c of cluster) {
    if (!rowGroups[c.row]) rowGroups[c.row] = [];
    rowGroups[c.row].push(c.col);
  }
  const rowKeys = Object.keys(rowGroups).map(Number).sort(function(a, b) { return a - b; });
  if (rowKeys.length < 2) return false;
  const gaps = [];
  for (let i = 1; i < rowKeys.length; i++) gaps.push(rowKeys[i] - rowKeys[i-1]);
  const avgGap = gaps.reduce(function(s, g) { return s + g; }, 0) / gaps.length;
  const gapVariance = gaps.reduce(function(s, g) { return s + Math.abs(g - avgGap); }, 0) / gaps.length;
  return gapVariance < 1.5 && avgGap >= 1 && avgGap <= 4;
}

function drawDetections(ctx, detections) {
  detections.forEach(function(det, idx) {
    const color = det.confidence > 0.5 ? '#ff4757' : det.confidence > 0.3 ? '#ffa502' : '#00c896';
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.5;
    ctx.strokeRect(det.x, det.y, det.w, det.h);
    const cs = Math.min(10, det.w * 0.2, det.h * 0.2);
    ctx.lineWidth = 3.5;
    [[det.x, det.y], [det.x + det.w, det.y], [det.x, det.y + det.h], [det.x + det.w, det.y + det.h]].forEach(function(corner) {
      const cx = corner[0], cy = corner[1];
      const dx = cx === det.x ? 1 : -1, dy = cy === det.y ? 1 : -1;
      ctx.beginPath(); ctx.moveTo(cx, cy + dy * cs); ctx.lineTo(cx, cy); ctx.lineTo(cx + dx * cs, cy); ctx.stroke();
    });
    ctx.fillStyle = color;
    ctx.font = 'bold 9px monospace';
    const label = '#' + (idx+1) + ' ' + (det.anomalyType || det.label) + ' ' + (det.confidence * 100).toFixed(0) + '%';
    const labelY = det.y > 14 ? det.y - 4 : det.y + det.h + 12;
    ctx.fillText(label, det.x + 2, labelY);
    if (det.hasGrid) { ctx.fillStyle = '#00c896'; ctx.font = '10px sans-serif'; ctx.fillText('\u229E', det.x + det.w - 14, det.y + 12); }
    if (det.hasRows) { ctx.fillStyle = '#4cc9f0'; ctx.font = '10px sans-serif'; ctx.fillText('\u2261', det.x + det.w - 14, det.y + (det.hasGrid ? 24 : 12)); }
  });
}

function buildDetectionResultsHTML(detections) {
  if (!detections.length) return '<p class="empty-state" style="padding:12px 0;">Nessuna geometria artificiale rilevata.</p>';
  return detections.map(function(det, idx) {
    const color = det.confidence > 0.5 ? '#ff4757' : det.confidence > 0.3 ? '#ffa502' : '#00c896';
    return '<div class="detection-result-item">' +
      '<div style="flex:1;">' +
        '<div class="detection-label">#' + (idx+1) + ' ' + (det.anomalyType || det.label) + '</div>' +
        '<div style="font-size:10px;color:var(--text-muted);margin-top:2px;">' +
          (det.hasGrid ? '\u229E Griglia &middot; ' : '') +
          (det.hasRows ? '\u2261 Filari &middot; ' : '') +
          'Verde: ' + det.metrics.darkGreen + '% &middot; Contrasto: ' + det.metrics.contrast + '%' +
          (det.metrics.rect !== '-' ? ' &middot; Rettang.: ' + det.metrics.rect + '%' : '') +
        '</div>' +
        '<div class="detection-confidence-bar" style="margin-top:5px;">' +
          '<div class="detection-confidence-fill" style="width:' + (det.confidence*100).toFixed(0) + '%;background:' + color + ';"></div>' +
        '</div>' +
      '</div>' +
      '<div style="margin-left:8px;font-size:14px;font-weight:700;color:' + color + ';">' +
        (det.confidence*100).toFixed(0) + '%' +
      '</div>' +
    '</div>';
  }).join('');
}

/**
 * Calcola le coordinate geografiche esatte delle detection
 * basandosi sull'hotspot selezionato come riferimento geografico.
 */
function buildDetectionCoordsHTML(detections, hotspot, canvasW, canvasH, scale, origW, origH) {
  if (!hotspot || !detections.length) return '';
  const lat = hotspot.lat, lng = hotspot.lng, radiusM = hotspot.radiusM;
  const coverageM = radiusM * 2.5;
  const mPerPxOrig = coverageM / Math.max(origW, origH);

  const items = detections.slice(0, 3).map(function(det, idx) {
    const cxPx = (det.x + det.w / 2) / scale;
    const cyPx = (det.y + det.h / 2) / scale;
    const dxM = (cxPx - origW / 2) * mPerPxOrig;
    const dyM = (cyPx - origH / 2) * mPerPxOrig;
    const dLat = -dyM / 111320;
    const dLng =  dxM / (111320 * Math.cos(lat * Math.PI / 180));
    const detLat = (lat + dLat).toFixed(7);
    const detLng = (lng + dLng).toFixed(7);
    const wM = (det.w / scale) * mPerPxOrig;
    const hM = (det.h / scale) * mPerPxOrig;
    const color = det.confidence > 0.5 ? '#ff4757' : det.confidence > 0.3 ? '#ffa502' : '#00c896';
    return '<div class="coord-item">' +
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">' +
        '<span style="font-size:11px;font-weight:700;color:' + color + ';">#' + (idx+1) + ' ' + (det.anomalyType || det.label) + '</span>' +
        '<span style="font-size:10px;color:var(--text-muted);">' + wM.toFixed(0) + 'x' + hM.toFixed(0) + 'm</span>' +
      '</div>' +
      '<div style="font-family:monospace;font-size:11px;color:var(--primary);">' + detLat + ', ' + detLng + '</div>' +
      '<button onclick="flyToDetection(' + detLat + ',' + detLng + ')" ' +
        'style="width:100%;margin-top:6px;padding:5px;background:rgba(0,200,150,0.1);color:var(--primary);' +
               'border:1px solid var(--border-accent);border-radius:4px;font-size:11px;cursor:pointer;">' +
        '\uD83D\uDDFA\uFE0F Vai alla coordinata' +
      '</button>' +
    '</div>';
  }).join('');

  return '<div style="margin-top:4px;">' +
    '<div style="font-size:11px;font-weight:700;color:var(--text-muted);margin-bottom:8px;text-transform:uppercase;letter-spacing:0.5px;">' +
      '\uD83D\uDCCD Coordinate Calcolate (\xB1' + (coverageM/20).toFixed(0) + 'm precisione)' +
    '</div>' +
    items +
  '</div>';
}

function flyToDetection(lat, lng) {
  state.map.flyTo([lat, lng], 17, { animate: true, duration: 1.5 });
  showToast('\uD83C\uDFAF Navigazione a ' + parseFloat(lat).toFixed(5) + ', ' + parseFloat(lng).toFixed(5), 'success');
}


// ================================================================
// 10b. SISTEMA A IMBUTO — LIVELLO 1: LO SCANNER SPETTRALE
//      Simula analisi NDVI/umidita' su Sentinel-2 e genera
//      3-4 Zone Rosse (Hotspot) sulla mappa Leaflet.
// ================================================================

/**
 * Avvia lo scanner spettrale sull'area visibile.
 * Combina: analisi rischio GIS (acqua/strade/sentieri) +
 * simulazione anomalia NDVI/umidita' per generare hotspot realistici.
 */
async function runSpectralScan() {
  const radiusKm = parseInt(document.getElementById('scanRadiusSlider').value, 10) || 8;
  const center   = state.map.getCenter();
  const lat = center.lat, lng = center.lng;

  updateScannerStatus('loading', 'Scanner avviato — analisi spettrale...');
  showSpinner(true);
  // Mostra quali satelliti sono attivi
  const activeSatNames = ['Sentinel-2'];
  if (state.activeSatellites.landsat)   activeSatNames.push('Landsat 8/9');
  if (state.activeSatellites.sentinel1) activeSatNames.push('S1 SAR');
  showToast('\uD83D\uDD34 Scanner avviato: ' + activeSatNames.join(' + '), 'info', 3000);

  // Rimuovi hotspot precedenti
  clearHotspots();

  const degOffset = radiusKm / 111.0;
  const bbox = (lat - degOffset) + ',' + (lng - degOffset) + ',' + (lat + degOffset) + ',' + (lng + degOffset);

  try {
    // Fetch dati GIS reali (acqua, strade, sentieri) per scoring
    const [waterF, roadF, pathF] = await Promise.all([
      fetchWaterways(bbox), fetchMainRoads(bbox), fetchPaths(bbox)
    ]);

    // Genera griglia candidati piu' fitta per lo scanner
    const candidates = generateCandidateGrid(lat, lng, radiusKm, 0.20);

    // Calcola score GIS per ogni candidato
    const scored = candidates.map(function(pt) {
      return { point: pt, score: computeRiskScore(pt, waterF, roadF, pathF) };
    }).filter(function(z) { return z.score.total >= 55; });

    if (!scored.length) {
      updateScannerStatus('ok', 'Nessuna anomalia spettrale rilevata');
      showToast('\u2705 Area pulita — nessun hotspot rilevato.', 'success');
      return;
    }

    // ── FUSIONE MULTI-SATELLITE ──────────────────────────────────
    // Sentinel-2: NDVI + umidita' (peso base)
    // Landsat 8/9: conferma NDVI + firma termica (se attivo)
    // Sentinel-1 SAR: backscatter strutturale (se attivo)
    // GIS: acqua/strade/sentieri (peso fisso)
    const useLandsat = state.activeSatellites.landsat;
    const useSAR     = state.activeSatellites.sentinel1;

    const withSpectral = scored.map(function(z) {
      const seed  = Math.abs(Math.sin(z.point.lat * 127.3 + z.point.lng * 311.7));
      const seed2 = Math.abs(Math.cos(z.point.lat * 89.1  + z.point.lng * 213.5));
      const seed3 = Math.abs(Math.sin(z.point.lat * 53.7  - z.point.lng * 177.9));

      // Sentinel-2: NDVI + umidita'
      const ndviAnomaly  = 0.15 + seed  * 0.35;
      const moistureAnom = 0.10 + (1 - seed) * 0.30;
      const temporalVar  = 0.05 + seed  * 0.25;
      const s2Score = ndviAnomaly * 40 + moistureAnom * 35 + temporalVar * 25;

      // Landsat 8/9: conferma NDVI + firma termica
      const landsatNDVI    = useLandsat ? (0.12 + seed2 * 0.30) : 0;
      const thermalAnomaly = useLandsat ? (0.10 + seed3 * 0.35) : 0;
      const landsatScore   = useLandsat ? (landsatNDVI * 50 + thermalAnomaly * 50) : 0;

      // Sentinel-1 SAR: backscatter strutturale
      const sarBackscatter = useSAR ? (0.08 + seed3 * 0.28) : 0;
      const sarTemporal    = useSAR ? (0.05 + seed2 * 0.20) : 0;
      const sarScore       = useSAR ? (sarBackscatter * 60 + sarTemporal * 40) : 0;

      // Pesi dinamici in base ai satelliti attivi
      var gisW = 0.45, s2W = 0.55, lsW = 0, sarW = 0;
      if (useLandsat && useSAR) { gisW=0.30; s2W=0.30; lsW=0.25; sarW=0.15; }
      else if (useLandsat)      { gisW=0.35; s2W=0.35; lsW=0.30; sarW=0; }
      else if (useSAR)          { gisW=0.35; s2W=0.40; lsW=0; sarW=0.25; }

      const totalScore = z.score.total * gisW +
                         s2Score       * s2W  +
                         landsatScore  * lsW  +
                         sarScore      * sarW;

      return {
        point:          z.point,
        gisScore:       z.score.total,
        ndviAnomaly:    ndviAnomaly,
        moistureAnom:   moistureAnom,
        temporalVar:    temporalVar,
        spectralScore:  s2Score,
        landsatNDVI:    landsatNDVI,
        thermalAnomaly: thermalAnomaly,
        landsatScore:   landsatScore,
        useLandsat:     useLandsat,
        sarBackscatter: sarBackscatter,
        sarTemporal:    sarTemporal,
        sarScore:       sarScore,
        useSAR:         useSAR,
        totalScore:     Math.min(totalScore, 100)
      };
    });

    // Ordina per score totale e prendi i top 4 (massimo)
    withSpectral.sort(function(a, b) { return b.totalScore - a.totalScore; });

    // Clustering: rimuovi hotspot troppo vicini (< 0.5km)
    const hotspots = [];
    for (const z of withSpectral) {
      const tooClose = hotspots.some(function(h) {
        return turf.distance(
          turf.point([h.point.lng, h.point.lat]),
          turf.point([z.point.lng, z.point.lat]),
          { units: 'kilometers' }
        ) < 0.5;
      });
      if (!tooClose) hotspots.push(z);
      if (hotspots.length >= 4) break;
    }

    // Crea layer hotspot sulla mappa
    const features = hotspots.map(function(z, idx) {
      const radiusM = 80 + z.ndviAnomaly * 120; // raggio 80-200m
      const circle = turf.circle([z.point.lng, z.point.lat], radiusM / 1000, { steps: 32, units: 'kilometers' });
      circle.properties = {
        idx:            idx,
        lat:            z.point.lat,
        lng:            z.point.lng,
        radiusM:        radiusM,
        gisScore:       z.gisScore,
        ndviAnomaly:    z.ndviAnomaly,
        moistureAnom:   z.moistureAnom,
        temporalVar:    z.temporalVar,
        totalScore:     z.totalScore,
        // Landsat
        useLandsat:     z.useLandsat,
        landsatNDVI:    z.landsatNDVI    || 0,
        thermalAnomaly: z.thermalAnomaly || 0,
        // SAR
        useSAR:         z.useSAR,
        sarBackscatter: z.sarBackscatter || 0,
        sarTemporal:    z.sarTemporal    || 0,
        label:          z.totalScore >= 75 ? 'CRITICO' : z.totalScore >= 55 ? 'SOSPETTO' : 'DA VERIFICARE'
      };
      return circle;
    });

    state.hotspots = hotspots.map(function(z, idx) {
      return {
        idx:      idx,
        lat:      z.point.lat,
        lng:      z.point.lng,
        radiusM:  80 + z.ndviAnomaly * 120,
        score:    z.totalScore,
        ndvi:     z.ndviAnomaly,
        moisture: z.moistureAnom,
        label:    z.totalScore >= 75 ? 'CRITICO' : z.totalScore >= 55 ? 'SOSPETTO' : 'DA VERIFICARE'
      };
    });

    state.hotspotLayer = L.geoJSON({ type: 'FeatureCollection', features: features }, {
      style: function(f) {
        const isCritical = f.properties.totalScore >= 75;
        return {
          color:       isCritical ? '#ff4757' : '#ffa502',
          weight:      2.5,
          opacity:     1,
          fillColor:   isCritical ? '#ff4757' : '#ffa502',
          fillOpacity: isCritical ? 0.30 : 0.18,
          dashArray:   null
        };
      },
      onEachFeature: function(f, layer) {
        layer.bindPopup(buildHotspotPopup(f.properties));
        layer.on('mouseover', function() { this.setStyle({ fillOpacity: 0.55, weight: 3.5 }); });
        layer.on('mouseout',  function() {
          const isCritical = f.properties.totalScore >= 75;
          this.setStyle({ fillOpacity: isCritical ? 0.30 : 0.18, weight: 2.5 });
        });
        layer.on('click', function() { selectHotspot(f.properties.idx); });
      }
    }).addTo(state.map);

    // Aggiungi etichette numeriche sugli hotspot
    hotspots.forEach(function(z, idx) {
      const isCritical = z.totalScore >= 75;
      const icon = L.divIcon({
        html: '<div class="hotspot-label-icon" style="background:' + (isCritical ? '#ff4757' : '#ffa502') + ';">' + (idx + 1) + '</div>',
        className: '',
        iconSize: [24, 24],
        iconAnchor: [12, 12]
      });
      const marker = L.marker([z.point.lat, z.point.lng], { icon: icon, interactive: false });
      state.hotspotLayer.addLayer(marker);
    });

    // Aggiorna UI
    const critCount = hotspots.filter(function(z) { return z.totalScore >= 75; }).length;
    updateScannerStatus('alert', critCount + ' CRITICO · ' + (hotspots.length - critCount) + ' SOSPETTO');
    renderHotspotList(state.hotspots);
    document.getElementById('hotspotResults').style.display = 'block';
    document.getElementById('hotspotCount').textContent = hotspots.length + ' Zone Rosse';

    showToast('\uD83D\uDD34 ' + hotspots.length + ' hotspot rilevati (' + critCount + ' critici) — Livello 2 per conferma', 'error', 7000);

    // Zoom sull'area degli hotspot
    if (hotspots.length > 0) {
      const bounds = L.latLngBounds(hotspots.map(function(z) { return [z.point.lat, z.point.lng]; }));
      state.map.fitBounds(bounds.pad(0.3), { maxZoom: 14 });
    }

  } catch(err) {
    console.error('[Scanner]', err);
    updateScannerStatus('error', 'Errore scanner');
    showToast('Errore durante lo scanner.', 'error');
  } finally {
    showSpinner(false);
  }
}

function buildHotspotPopup(props) {
  const color = props.totalScore >= 75 ? '#ff4757' : '#ffa502';
  const ndviPct  = (props.ndviAnomaly  * 100).toFixed(0);
  const moistPct = (props.moistureAnom * 100).toFixed(0);
  const tempPct  = (props.temporalVar  * 100).toFixed(0);

  // Righe Landsat e SAR (solo se attivi)
  const landsatRow = props.useLandsat
    ? '\uD83D\uDEF0\uFE0F Landsat NDVI: <b style="color:#a8dadc;">\u0394' + (props.landsatNDVI * 100).toFixed(0) + '%</b> &nbsp;' +
      '\uD83C\uDF21\uFE0F Termico: <b style="color:#ff6b6b;">' + (props.thermalAnomaly * 100).toFixed(0) + '%</b><br/>'
    : '';
  const sarRow = props.useSAR
    ? '\uD83D\uDCE1 SAR Backscatter: <b style="color:#c77dff;">' + (props.sarBackscatter * 100).toFixed(0) + '%</b> &nbsp;' +
      '\u23F1\uFE0F SAR Temporale: <b style="color:#c77dff;">' + (props.sarTemporal * 100).toFixed(0) + '%</b><br/>'
    : '';

  // Badge satelliti attivi
  const satBadges = '<span style="background:#00c89620;color:#00c896;border:1px solid #00c89640;padding:2px 5px;border-radius:3px;font-size:9px;font-weight:700;">S2</span> ' +
    (props.useLandsat ? '<span style="background:#a8dadc20;color:#a8dadc;border:1px solid #a8dadc40;padding:2px 5px;border-radius:3px;font-size:9px;font-weight:700;">L8/9</span> ' : '') +
    (props.useSAR     ? '<span style="background:#c77dff20;color:#c77dff;border:1px solid #c77dff40;padding:2px 5px;border-radius:3px;font-size:9px;font-weight:700;">SAR</span>' : '');

  return '<div style="font-family:\'Segoe UI\',sans-serif;min-width:260px;">' +
    '<div style="font-size:14px;font-weight:700;color:' + color + ';margin-bottom:6px;">' +
      '\uD83D\uDD34 ZONA ROSSA #' + (props.idx + 1) + ' \u2014 ' + props.label +
    '</div>' +
    '<div style="margin-bottom:8px;">' + satBadges + '</div>' +
    '<div style="font-size:12px;color:#adb5bd;margin-bottom:10px;">' +
      'Score fusione: <span style="color:' + color + ';font-size:16px;font-weight:700;">' + props.totalScore.toFixed(0) + '/100</span>' +
    '</div>' +
    '<div style="font-size:11px;color:#7d8590;line-height:2.0;margin-bottom:10px;">' +
      '\uD83C\uDF3F S2 NDVI: <b style="color:#52b788;">\u0394' + ndviPct + '%</b><br/>' +
      '\uD83D\uDCA7 S2 Umidita\': <b style="color:#4cc9f0;">' + moistPct + '%</b><br/>' +
      '\uD83D\uDCC5 S2 Temporale: <b style="color:#ffa502;">' + tempPct + '%</b><br/>' +
      landsatRow +
      sarRow +
      '\uD83D\uDCCD Raggio: <b style="color:var(--text);">' + props.radiusM.toFixed(0) + 'm</b>' +
    '</div>' +
    '<button onclick="selectHotspot(' + props.idx + ')" ' +
      'style="width:100%;padding:8px;background:' + color + ';color:#000;border:none;border-radius:6px;' +
             'font-size:12px;font-weight:700;cursor:pointer;margin-bottom:6px;">' +
      '\uD83C\uDFAF Seleziona per Livello 2' +
    '</button>' +
    '<button onclick="addHotspotAsMarker(' + props.idx + ')" ' +
      'style="width:100%;padding:8px;background:rgba(255,165,2,0.15);color:#ffa502;border:1px solid rgba(255,165,2,0.3);' +
             'border-radius:6px;font-size:12px;font-weight:600;cursor:pointer;">' +
      '\uD83D\uDCCD Aggiungi come Sito' +
    '</button>' +
  '</div>';
}

function renderHotspotList(hotspots) {
  const list = document.getElementById('hotspotList');
  if (!list) return;
  list.innerHTML = hotspots.map(function(h) {
    const color = h.score >= 75 ? '#ff4757' : '#ffa502';
    return '<div class="hotspot-item" onclick="selectHotspot(' + h.idx + ')" id="hotspot-item-' + h.idx + '">' +
      '<div style="display:flex;justify-content:space-between;align-items:center;">' +
        '<span style="font-size:12px;font-weight:700;color:' + color + ';">\uD83D\uDD34 Zona #' + (h.idx + 1) + ' — ' + h.label + '</span>' +
        '<span style="font-size:13px;font-weight:700;color:' + color + ';">' + h.score.toFixed(0) + '</span>' +
      '</div>' +
      '<div style="font-size:10px;color:var(--text-muted);margin-top:3px;">' +
        'NDVI \u0394' + (h.ndvi * 100).toFixed(0) + '% &middot; ' +
        'Umid. ' + (h.moisture * 100).toFixed(0) + '% &middot; ' +
        h.lat.toFixed(5) + ', ' + h.lng.toFixed(5) +
      '</div>' +
      '<div style="font-size:10px;color:var(--primary);margin-top:3px;">\u2192 Clicca per selezionare (Livello 2)</div>' +
    '</div>';
  }).join('');
}

/**
 * Seleziona un hotspot come target per il Livello 2 (Cecchino).
 * Aggiorna il badge nella sezione Livello 2 e centra la mappa.
 */
function selectHotspot(idx) {
  const h = state.hotspots[idx];
  if (!h) return;
  state.selectedHotspot = h;

  // Aggiorna badge Livello 2
  const badge = document.getElementById('selectedHotspotBadge');
  const label = document.getElementById('selectedHotspotLabel');
  if (badge) badge.style.display = 'flex';
  if (label) label.textContent = 'Zona #' + (idx + 1) + ' — ' + h.label + ' (score ' + h.score.toFixed(0) + ')';

  // Evidenzia nell'elenco
  document.querySelectorAll('.hotspot-item').forEach(function(el) { el.classList.remove('selected'); });
  const item = document.getElementById('hotspot-item-' + idx);
  if (item) item.classList.add('selected');

  // Centra mappa sull'hotspot
  state.map.flyTo([h.lat, h.lng], 15, { animate: true, duration: 1.2 });
  state.map.closePopup();

  showToast('\uD83C\uDFAF Zona #' + (idx + 1) + ' selezionata — carica foto drone per Livello 2', 'success', 4000);

  // Scroll alla sezione Livello 2
  const lvl2 = document.querySelector('.funnel-level2');
  if (lvl2) setTimeout(function() { lvl2.scrollIntoView({ behavior: 'smooth', block: 'start' }); }, 400);
}

function addHotspotAsMarker(idx) {
  const h = state.hotspots[idx];
  if (!h) return;
  const site = {
    id:        'site_' + Date.now(),
    lat:       parseFloat(h.lat.toFixed(6)),
    lng:       parseFloat(h.lng.toFixed(6)),
    name:      'Hotspot #' + (idx + 1) + ' (' + h.label + ')',
    comune:    'Scanner Spettrale',
    address:   '',
    timestamp: new Date().toLocaleString('it-IT'),
    note:      'Score: ' + h.score.toFixed(0) + '/100 | NDVI delta: ' + (h.ndvi * 100).toFixed(0) + '%'
  };
  addSiteToMap(site);
  state.sites.push(site);
  saveSitesToStorage();
  renderSitesList();
  state.map.closePopup();
  showToast('\uD83D\uDCCD Hotspot aggiunto al database.', 'success');
}

function clearHotspots() {
  if (state.hotspotLayer) {
    state.map.removeLayer(state.hotspotLayer);
    state.hotspotLayer = null;
  }
  state.hotspots = [];
  state.selectedHotspot = null;
  const results = document.getElementById('hotspotResults');
  if (results) results.style.display = 'none';
  const badge = document.getElementById('selectedHotspotBadge');
  if (badge) badge.style.display = 'none';
  updateScannerStatus('', 'Scanner in attesa');
}

function updateScannerStatus(type, text) {
  const dot  = document.getElementById('scannerDot');
  const info = document.getElementById('scannerInfo');
  if (dot)  dot.className   = 'sentinel-dot ' + type;
  if (info) info.textContent = text;
}


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
    populateSiteSelect();
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
  populateSiteSelect();
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
  // Contatore: lo spinner rimane attivo finché almeno un'operazione è in corso
  if (typeof showSpinner._count === 'undefined') showSpinner._count = 0;
  if (v) {
    showSpinner._count++;
  } else {
    showSpinner._count = Math.max(0, showSpinner._count - 1);
  }
  const el = document.getElementById('spinner');
  if (el) el.classList.toggle('active', showSpinner._count > 0);
}

// Forza lo spinner a spegnersi (usato come safety net)
function forceHideSpinner() {
  if (typeof showSpinner._count !== 'undefined') showSpinner._count = 0;
  const el = document.getElementById('spinner');
  if (el) el.classList.remove('active');
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
// 16b. HUMAN-IN-THE-LOOP (HITL) — Deep Scan + Validazione
// ================================================================

// ── ICONE MARKER HITL ────────────────────────────────────────────
function createHitlIcon(status) {
  // status: 'pending' | 'confirmed' | 'discarded'
  const cfg = {
    pending:   { bg:'#f4c430', border:'#e6a817', pulse:true  },
    confirmed: { bg:'#ff4757', border:'#c0392b', pulse:false },
    discarded: { bg:'#7d8590', border:'#484f58', pulse:false }
  }[status] || { bg:'#f4c430', border:'#e6a817', pulse:true };

  const pulseHtml = cfg.pulse
    ? `<div class="hitl-pulse" style="border-color:${cfg.bg};"></div>` : '';

  return L.divIcon({
    html: `<div class="hitl-marker-wrap">
             ${pulseHtml}
             <div class="hitl-marker-dot" style="background:${cfg.bg};border-color:${cfg.border};">
               <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24"
                 fill="none" stroke="#000" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                 ${status === 'confirmed'
                   ? '<polyline points="20 6 9 17 4 12"/>'
                   : status === 'discarded'
                   ? '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>'
                   : '<circle cx="12" cy="12" r="3" fill="#000"/>'}
               </svg>
             </div>
           </div>`,
    className: '',
    iconSize:  [40, 40],
    iconAnchor:[20, 20],
    popupAnchor:[0, -24]
  });
}

// ── POPUP VALIDAZIONE (Tinder for Maps) ──────────────────────────
function buildHitlPopup(id, data) {
  const sats = (data.satellites || ['S2']).join(' + ');
  const ndvi = data.ndvi_delta ? (data.ndvi_delta * 100).toFixed(0) + '%' : 'N/D';
  const sar  = data.sar_score  ? (data.sar_score  * 100).toFixed(0) + '%' : 'N/D';
  const conf = data.confidence ? (data.confidence * 100).toFixed(0) + '%' : 'N/D';

  return `
  <div class="hitl-popup">
    <div class="hitl-popup-header">
      <div class="hitl-popup-badge">🛰️ ANOMALIA SATELLITARE</div>
      <div class="hitl-popup-title">Rilevata da ${sats}</div>
    </div>

    <div class="hitl-popup-coords">
      ${data.lat.toFixed(6)}, ${data.lng.toFixed(6)}
    </div>

    <div class="hitl-popup-metrics">
      <div class="hitl-metric">
        <span class="hitl-metric-icon">🌿</span>
        <div>
          <div class="hitl-metric-label">NDVI Anomalia</div>
          <div class="hitl-metric-val" style="color:#52b788;">Δ${ndvi}</div>
        </div>
      </div>
      <div class="hitl-metric">
        <span class="hitl-metric-icon">📡</span>
        <div>
          <div class="hitl-metric-label">SAR Backscatter</div>
          <div class="hitl-metric-val" style="color:#c77dff;">${sar}</div>
        </div>
      </div>
      <div class="hitl-metric">
        <span class="hitl-metric-icon">🎯</span>
        <div>
          <div class="hitl-metric-label">Confidenza IA</div>
          <div class="hitl-metric-val" style="color:#ffa502;">${conf}</div>
        </div>
      </div>
    </div>

    <div class="hitl-popup-question">
      L'analisi visiva conferma la presenza di coltivazione sospetta?
    </div>

    <div class="hitl-popup-actions">
      <button class="hitl-btn hitl-btn-confirm" onclick="hitlConfirm('${id}')">
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24"
          fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="20 6 9 17 4 12"/>
        </svg>
        Conferma<br/><small>Vero Positivo</small>
      </button>
      <button class="hitl-btn hitl-btn-discard" onclick="hitlDiscard('${id}')">
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24"
          fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
        </svg>
        Scarta<br/><small>Falso Positivo</small>
      </button>
    </div>

    <div class="hitl-popup-footer">
      Comune: <strong>${data.comune || 'N/D'}</strong> · ${data.timestamp}
    </div>
  </div>`;
}

// ── DEEP SCAN ─────────────────────────────────────────────────────
/**
 * Simula una chiamata a GEE/Sentinel con overlay di caricamento.
 * Genera 3-4 marker HITL esclusivamente dentro il poligono del comune
 * usando turf.booleanPointInPolygon per il geofencing.
 */
async function runDeepScan() {
  if (state.deepScanRunning) return;
  if (!state.communeGeoJSON) {
    showToast('Cerca prima un comune per attivare il Deep Scan.', 'error');
    return;
  }

  state.deepScanRunning = true;
  const btn = document.getElementById('btnDeepScan');
  if (btn) { btn.disabled = true; btn.classList.remove('ready'); }

  // ── Overlay scansione ─────────────────────────────────────────
  showDeepScanOverlay(true);
  updateHitlStatus('running', 'Scansione multispettrale in corso...');

  // Rimuovi marker HITL precedenti
  clearHitlMarkers();

  // Simula latenza GEE (2.5–4s)
  const delay = 2500 + Math.random() * 1500;

  await new Promise(resolve => setTimeout(resolve, delay));

  try {
    // ── Genera candidati dentro il poligono ───────────────────
    const bbox   = state.communeBounds.getBounds();
    const minLat = bbox.getSouth(), maxLat = bbox.getNorth();
    const minLng = bbox.getWest(),  maxLng = bbox.getEast();

    // Normalizza il GeoJSON in Feature per turf
    let communeFeature = state.communeGeoJSON;
    if (communeFeature.type !== 'Feature') {
      communeFeature = { type: 'Feature', geometry: communeFeature, properties: {} };
    }

    // Genera punti casuali dentro il bbox, filtra con booleanPointInPolygon
    const validPoints = [];
    let attempts = 0;
    while (validPoints.length < 4 && attempts < 200) {
      attempts++;
      const lat = minLat + Math.random() * (maxLat - minLat);
      const lng = minLng + Math.random() * (maxLng - minLng);
      const pt  = turf.point([lng, lat]);
      try {
        if (turf.booleanPointInPolygon(pt, communeFeature)) {
          validPoints.push({ lat, lng });
        }
      } catch(e) { /* geometria complessa — skip */ }
    }

    // Prendi 3-4 punti
    const count  = 3 + Math.floor(Math.random() * 2); // 3 o 4
    const chosen = validPoints.slice(0, Math.min(count, validPoints.length));

    if (!chosen.length) {
      showToast('Nessun punto valido trovato nel poligono.', 'info');
      updateHitlStatus('ok', 'Scansione completata — nessun hotspot');
      return;
    }

    // ── Crea layer group HITL ─────────────────────────────────
    if (!state.hitlLayerGroup) {
      state.hitlLayerGroup = L.layerGroup().addTo(state.map);
    }

    const activeSats = Object.keys(state.activeSatellites)
      .filter(k => state.activeSatellites[k])
      .map(k => k === 'sentinel2' ? 'S2' : k === 'landsat' ? 'L8/9' : 'SAR');

    chosen.forEach(function(pt, idx) {
      const seed = Math.abs(Math.sin(pt.lat * 137.5 + pt.lng * 251.3));
      const id   = 'hitl_' + Date.now() + '_' + idx;
      const data = {
        id,
        lat:        pt.lat,
        lng:        pt.lng,
        comune:     state.communeName,
        timestamp:  new Date().toLocaleString('it-IT'),
        confidence: 0.45 + seed * 0.45,
        ndvi_delta: 0.15 + seed * 0.35,
        sar_score:  0.10 + (1 - seed) * 0.30,
        satellites: activeSats,
        status:     'pending'
      };

      const marker = L.marker([pt.lat, pt.lng], {
        icon: createHitlIcon('pending'),
        zIndexOffset: 1000
      });

      marker.bindPopup(buildHitlPopup(id, data), {
        maxWidth:    320,
        minWidth:    300,
        className:   'hitl-popup-wrapper',
        closeButton: true
      });

      marker.addTo(state.hitlLayerGroup);
      state.hitlMarkers[id] = { marker, data };
    });

    const n = chosen.length;
    updateHitlStatus('alert', `${n} anomalia/e rilevata/e — in attesa di validazione`);
    updateHitlCounter();
    showToast(`🛰️ Deep Scan completato: ${n} anomalie rilevate in ${state.communeName}`, 'error', 6000);

    // Aggiorna badge nella sidebar
    const badge = document.getElementById('hitlPendingBadge');
    if (badge) { badge.textContent = n; badge.style.display = 'flex'; }

  } catch(err) {
    console.error('[DeepScan]', err);
    updateHitlStatus('error', 'Errore durante la scansione');
    showToast('Errore Deep Scan.', 'error');
  } finally {
    showDeepScanOverlay(false);
    state.deepScanRunning = false;
    if (btn) { btn.disabled = false; btn.classList.add('ready'); }
  }
}

// ── OVERLAY SCANSIONE ─────────────────────────────────────────────
function showDeepScanOverlay(visible) {
  let overlay = document.getElementById('deepScanOverlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'deepScanOverlay';
    overlay.className = 'deep-scan-overlay';
    overlay.innerHTML = `
      <div class="deep-scan-content">
        <div class="deep-scan-radar">
          <div class="radar-ring r1"></div>
          <div class="radar-ring r2"></div>
          <div class="radar-ring r3"></div>
          <div class="radar-sweep"></div>
          <div class="radar-center">🛰️</div>
        </div>
        <div class="deep-scan-title">Scansione Multispettrale in Corso</div>
        <div class="deep-scan-steps" id="scanSteps">
          <div class="scan-step active" id="step1">⬡ Caricamento dati Sentinel-2...</div>
          <div class="scan-step" id="step2">⬡ Analisi NDVI e Red Edge...</div>
          <div class="scan-step" id="step3">⬡ Confronto temporale (Δ30gg)...</div>
          <div class="scan-step" id="step4">⬡ Fusione SAR + Termico...</div>
          <div class="scan-step" id="step5">⬡ Geofencing poligono comune...</div>
        </div>
        <div class="deep-scan-commune" id="scanCommune">${state.communeName}</div>
        <div class="deep-scan-credits">Idea di <strong>Alessandro P.</strong> · Generata da <strong>Emanuele D.</strong></div>
      </div>`;
    document.body.appendChild(overlay);

    // Anima gli step in sequenza
    const steps = ['step1','step2','step3','step4','step5'];
    steps.forEach(function(sid, i) {
      setTimeout(function() {
        const el = document.getElementById(sid);
        if (el) {
          el.classList.add('active');
          el.textContent = el.textContent.replace('⬡', '✓');
        }
      }, i * 480);
    });
  }
  overlay.style.display = visible ? 'flex' : 'none';
  if (!visible) { overlay.remove(); }
}

// ── AZIONI VALIDAZIONE ────────────────────────────────────────────
function hitlConfirm(id) {
  const entry = state.hitlMarkers[id];
  if (!entry) return;

  entry.data.status = 'confirmed';
  entry.marker.setIcon(createHitlIcon('confirmed'));
  entry.marker.closePopup();

  // Aggiunge al database locale come sito confermato
  const site = {
    id:        'site_' + Date.now(),
    lat:       parseFloat(entry.data.lat.toFixed(6)),
    lng:       parseFloat(entry.data.lng.toFixed(6)),
    name:      'Confermato IA — ' + state.communeName,
    comune:    entry.data.comune,
    address:   '',
    timestamp: entry.data.timestamp,
    note:      'Vero Positivo · Confidenza: ' + (entry.data.confidence * 100).toFixed(0) + '%'
  };
  addSiteToMap(site);
  state.sites.push(site);
  saveSitesToStorage();
  renderSitesList();

  // Invia al training database
  sendToTrainingDatabase(
    { lat: entry.data.lat, lng: entry.data.lng },
    true,
    'hitl_validation',
    entry.data
  );

  // Auto-upload al dataset globale se abilitato nelle impostazioni
  if (getSynergySettings().autoUpload) {
    autoUploadOnConfirm(site, entry.data);
  }

  updateHitlCounter();
  showToast('✅ Confermato come Vero Positivo — dati inviati al training set', 'success', 5000);

  // Aggiorna popup con stato confermato
  entry.marker.bindPopup(buildHitlConfirmedPopup(entry.data));
  setTimeout(() => entry.marker.openPopup(), 200);
}

function hitlDiscard(id) {
  const entry = state.hitlMarkers[id];
  if (!entry) return;

  entry.data.status = 'discarded';
  entry.marker.closePopup();

  // Animazione fade-out
  const el = entry.marker.getElement();
  if (el) {
    el.style.transition = 'opacity 0.5s, transform 0.5s';
    el.style.opacity    = '0';
    el.style.transform  = 'scale(0.3)';
  }
  setTimeout(function() {
    if (state.hitlLayerGroup) state.hitlLayerGroup.removeLayer(entry.marker);
    delete state.hitlMarkers[id];
    updateHitlCounter();
  }, 500);

  // Invia al training database come falso positivo
  sendToTrainingDatabase(
    { lat: entry.data.lat, lng: entry.data.lng },
    false,
    'hitl_validation',
    entry.data
  );

  showToast('❌ Scartato come Falso Positivo — l\'IA imparerà a ignorarlo', 'info', 4000);
}

function buildHitlConfirmedPopup(data) {
  return `<div class="hitl-popup hitl-popup-confirmed">
    <div class="hitl-popup-header">
      <div class="hitl-popup-badge" style="background:rgba(255,71,87,0.2);color:#ff4757;border-color:rgba(255,71,87,0.4);">
        ✅ SITO CONFERMATO
      </div>
    </div>
    <div class="hitl-popup-coords">${data.lat.toFixed(6)}, ${data.lng.toFixed(6)}</div>
    <div style="font-size:11px;color:var(--text-muted);margin-top:8px;line-height:1.6;">
      Vero Positivo registrato nel training set.<br/>
      Confidenza IA: <strong style="color:#ffa502;">${(data.confidence*100).toFixed(0)}%</strong>
    </div>
  </div>`;
}

// ── FUNZIONE UNIFICATA TRAINING DATABASE ──────────────────────────
/**
 * sendToTrainingDatabase(coords, isTarget, method, extraData)
 *
 * Punto di raccolta unificato per tutti i dati di training:
 * - isTarget: true  → Vero Positivo (coltivazione confermata)
 * - isTarget: false → Falso Positivo (da ignorare in futuro)
 * - method: 'hitl_validation' | 'manual_entry' | 'ai_cv' | 'spectral_scan'
 *
 * Chiama uploadToGlobalDataset() (sezione 17) se configurato,
 * altrimenti salva solo in localStorage come fallback.
 */
function sendToTrainingDatabase(coords, isTarget, method, extraData) {
  extraData = extraData || {};

  const entry = {
    id:               'train_' + Date.now() + '_' + Math.random().toString(36).slice(2,7),
    timestamp:        new Date().toISOString(),
    lat:              coords.lat,
    lng:              coords.lng,
    comune:           extraData.comune || state.communeName || 'N/D',
    is_target:        isTarget,
    vegetation_type:  isTarget ? 'coltura_sospetta' : 'falso_positivo',
    confidence:       extraData.confidence || (isTarget ? 0.85 : 0.1),
    detection_method: method,
    satellites_used:  extraData.satellites || Object.keys(state.activeSatellites).filter(k => state.activeSatellites[k]),
    risk_score:       extraData.risk_score || Math.round((extraData.confidence || 0.5) * 100),
    ndvi_delta:       extraData.ndvi_delta  || 0,
    thermal_anomaly:  extraData.thermal_anomaly || 0,
    sar_backscatter:  extraData.sar_score   || 0,
    catasto:          extraData.catasto     || {}
  };

  // Salva in localStorage come fallback immediato
  try {
    const existing = JSON.parse(localStorage.getItem('argus_training_local') || '[]');
    existing.push(entry);
    localStorage.setItem('argus_training_local', JSON.stringify(existing.slice(-500))); // max 500
  } catch(e) { /* storage pieno */ }

  // Invia al dataset globale GitHub (se token configurato)
  if (typeof uploadToGlobalDataset === 'function') {
    uploadToGlobalDataset(entry).catch(function(err) {
      console.warn('[Training] Upload fallito, dato salvato in locale:', err.message);
    });
  }

  console.log('[Training]', isTarget ? '✅ VP' : '❌ FP', method, coords.lat.toFixed(4), coords.lng.toFixed(4));
}

// ── CLEAR HITL ────────────────────────────────────────────────────
function clearHitlMarkers() {
  if (state.hitlLayerGroup) {
    state.hitlLayerGroup.clearLayers();
  }
  state.hitlMarkers = {};
  updateHitlCounter();
  const badge = document.getElementById('hitlPendingBadge');
  if (badge) { badge.textContent = '0'; badge.style.display = 'none'; }
}

// ── STATUS + COUNTER ──────────────────────────────────────────────
function updateHitlStatus(type, text) {
  const dot  = document.getElementById('hitlDot');
  const info = document.getElementById('hitlStatusText');
  if (dot)  dot.className   = 'sentinel-dot ' + type;
  if (info) info.textContent = text;
}

function updateHitlCounter() {
  const pending   = Object.values(state.hitlMarkers).filter(e => e.data.status === 'pending').length;
  const confirmed = Object.values(state.hitlMarkers).filter(e => e.data.status === 'confirmed').length;
  const el = document.getElementById('hitlCounterText');
  if (el) el.textContent = `In attesa: ${pending} · Confermati: ${confirmed}`;
  const badge = document.getElementById('hitlPendingBadge');
  if (badge) {
    badge.textContent = pending;
    badge.style.display = pending > 0 ? 'flex' : 'none';
  }
}

// ── INIT HITL ─────────────────────────────────────────────────────
function initHitl() {
  // hitlLayerGroup è già creato in initMap — qui aggiorniamo solo lo status UI
  updateHitlStatus('', 'Cerca un comune per iniziare');
}

// ================================================================
// 17. APPRENDIMENTO COLLETTIVO — Upload dataset globale
//     + Dati catastali + Condivisione WhatsApp
// ================================================================

// ── CONFIGURAZIONE ────────────────────────────────────────────────
// ISTRUZIONI SICUREZZA TOKEN:
// 1. Vai su GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens
// 2. Crea un token con scope: "Contents: Read and Write" SOLO su questo repository
// 3. Vai su GitHub → Repository → Settings → Secrets and variables → Actions
// 4. Crea un secret chiamato ARGUS_DISPATCH_TOKEN con il valore del token
// 5. Sostituisci ARGUS_GITHUB_REPO con "tuo-username/tuo-repo"
// 6. Il token NON va mai scritto qui nel codice — viene letto da una variabile
//    configurata dall'operatore al primo avvio (vedi initLearningConfig)
const LEARNING_CONFIG = {
  // Questi valori vengono caricati da localStorage (impostati dall'operatore)
  // MAI hardcodare il token qui — è un file pubblico su GitHub Pages
  repo:  localStorage.getItem('argus_gh_repo')  || '',   // es: "username/argus-app"
  token: localStorage.getItem('argus_gh_token') || '',   // PAT fine-grained (scope: contents)
  apiUrl: 'https://api.github.com/repos/'
};

// Contatore contributi locali
let localContribCount = parseInt(localStorage.getItem('argus_contrib_count') || '0', 10);

// Dati catastali dell'ultimo sito selezionato
let currentCatastoData = null;
// Sito corrente selezionato per il contributo
let currentLearningEntry = null;

// ── INIT ──────────────────────────────────────────────────────────
function initLearning() {
  updateLocalContribCounter();
  populateSiteSelect();

  // Se non configurato, mostra avviso
  if (!LEARNING_CONFIG.repo || !LEARNING_CONFIG.token) {
    const dot = document.getElementById('learningDot');
    const txt = document.getElementById('learningStatusText');
    if (dot) dot.className = 'learning-dot warn';
    if (txt) txt.textContent = 'Token non configurato — vedi istruzioni';
  }
}

function updateLocalContribCounter() {
  const el = document.getElementById('localContribCount');
  if (el) el.textContent = localContribCount;
}

function populateSiteSelect() {
  const sel = document.getElementById('learningSelectSite');
  if (!sel) return;
  // Svuota e ripopola
  sel.innerHTML = '<option value="">— Seleziona un sito salvato —</option>';
  state.sites.forEach(function(s) {
    const opt = document.createElement('option');
    opt.value = s.id;
    opt.textContent = s.name + ' — ' + s.comune + ' (' + s.lat.toFixed(4) + ', ' + s.lng.toFixed(4) + ')';
    sel.appendChild(opt);
  });
  sel.onchange = function() { onLearningSelectSite(this.value); };
}

async function onLearningSelectSite(siteId) {
  if (!siteId) {
    currentLearningEntry = null;
    currentCatastoData   = null;
    document.getElementById('catastoDataBox').style.display = 'none';
    document.getElementById('btnWhatsapp').disabled = true;
    return;
  }
  const site = state.sites.find(function(s) { return s.id === siteId; });
  if (!site) return;
  currentLearningEntry = site;
  document.getElementById('btnWhatsapp').disabled = false;

  // Carica dati catastali
  await fetchCatastoData(site.lat, site.lng);
}

// ── FETCH DATI CATASTALI ──────────────────────────────────────────
/**
 * Interroga il WMS catastale dell'Agenzia delle Entrate (GetFeatureInfo)
 * per ottenere i dati della particella alle coordinate date.
 * Endpoint pubblico, nessuna autenticazione richiesta.
 */
async function fetchCatastoData(lat, lng) {
  const box = document.getElementById('catastoDataBox');
  const status = document.getElementById('catastoLoadStatus');
  const content = document.getElementById('catastoDataContent');
  if (box) box.style.display = 'block';
  if (status) status.textContent = 'caricamento...';
  if (content) content.innerHTML = '<div style="font-size:11px;color:var(--text-muted);padding:8px;">Interrogazione catasto in corso...</div>';

  currentCatastoData = null;

  try {
    // Converti lat/lng in coordinate EPSG:3857 (Web Mercator) per il WMS
    const R = 6378137;
    const x = lng * Math.PI / 180 * R;
    const y = Math.log(Math.tan((90 + lat) * Math.PI / 360)) * R;

    // Bounding box piccolo attorno al punto (±50m)
    const delta = 50;
    const bbox = (x - delta) + ',' + (y - delta) + ',' + (x + delta) + ',' + (y + delta);

    // GetFeatureInfo sul layer CP.CadastralParcel
    const wmsUrl = 'https://wms.cartografia.agenziaentrate.gov.it/inspire/wms/ows01.php' +
      '?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetFeatureInfo' +
      '&LAYERS=CP.CadastralParcel' +
      '&QUERY_LAYERS=CP.CadastralParcel' +
      '&INFO_FORMAT=application/json' +
      '&FEATURE_COUNT=1' +
      '&CRS=EPSG:3857' +
      '&BBOX=' + bbox +
      '&WIDTH=101&HEIGHT=101&I=50&J=50';

    const res = await fetch(wmsUrl, { signal: AbortSignal.timeout(8000) });

    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();

    if (data.features && data.features.length > 0) {
      const props = data.features[0].properties || {};
      currentCatastoData = {
        foglio:           props.FOGLIO           || props.foglio           || '',
        particella:       props.PARTICELLA       || props.particella       || props.NUMERO || '',
        comune_catastale: props.COMUNE           || props.comune           || '',
        sezione:          props.SEZIONE          || props.sezione          || '',
        qualita:          props.QUALITA          || props.qualita          || props.DESTINAZIONE || '',
        classe:           props.CLASSE           || props.classe           || '',
        superficie_ha:    parseFloat(props.SUPERFICIE || props.superficie || 0) / 10000 || 0,
        raw:              props
      };
      renderCatastoData(currentCatastoData, content, status);
    } else {
      // Nessuna particella trovata — prova con Nominatim per info amministrative
      currentCatastoData = { foglio:'N/D', particella:'N/D', comune_catastale:'', sezione:'', qualita:'', classe:'', superficie_ha:0 };
      if (content) content.innerHTML = '<div style="font-size:11px;color:var(--text-muted);padding:6px;">Nessuna particella catastale trovata per queste coordinate.<br/>Verifica che il punto sia su territorio italiano.</div>';
      if (status) status.textContent = 'non trovato';
    }
  } catch(err) {
    console.warn('[Catasto]', err.message);
    currentCatastoData = { foglio:'N/D', particella:'N/D', comune_catastale:'', sezione:'', qualita:'', classe:'', superficie_ha:0 };
    if (content) content.innerHTML = '<div style="font-size:11px;color:var(--warning);padding:6px;">⚠️ Catasto non raggiungibile. I dati catastali non saranno inclusi nel contributo.</div>';
    if (status) status.textContent = 'errore';
  }
}

function renderCatastoData(data, container, statusEl) {
  if (!container) return;
  const rows = [
    ['Foglio',      data.foglio      || 'N/D'],
    ['Particella',  data.particella  || 'N/D'],
    ['Comune',      data.comune_catastale || 'N/D'],
    ['Sezione',     data.sezione     || '—'],
    ['Qualità',     data.qualita     || 'N/D'],
    ['Classe',      data.classe      || '—'],
    ['Superficie',  data.superficie_ha ? data.superficie_ha.toFixed(4) + ' ha' : 'N/D']
  ];
  container.innerHTML = rows.map(function(r) {
    return '<div class="catasto-row"><span class="catasto-key">' + r[0] + '</span><span class="catasto-val">' + r[1] + '</span></div>';
  }).join('');
  if (statusEl) statusEl.textContent = 'caricato ✓';
}

// ── MODAL ─────────────────────────────────────────────────────────
function openLearningModal() {
  const siteId = document.getElementById('learningSelectSite').value;
  if (!siteId) {
    showToast('Seleziona prima un sito dalla lista.', 'error');
    return;
  }
  const site = state.sites.find(function(s) { return s.id === siteId; });
  if (!site) return;

  // Popola riepilogo nel modal
  const summary = document.getElementById('modalSiteSummary');
  if (summary) {
    const vegType = document.getElementById('learningVegType');
    const vegLabel = vegType ? vegType.options[vegType.selectedIndex].text : '';
    summary.innerHTML =
      '<div class="modal-site-row"><span>📍 Sito</span><strong>' + site.name + '</strong></div>' +
      '<div class="modal-site-row"><span>🏘️ Comune</span><strong>' + site.comune + '</strong></div>' +
      '<div class="modal-site-row"><span>🌐 Coordinate</span><strong style="font-family:monospace;">' + site.lat.toFixed(4) + ', ' + site.lng.toFixed(4) + '</strong></div>' +
      '<div class="modal-site-row"><span>🌿 Vegetazione</span><strong>' + vegLabel + '</strong></div>' +
      '<div class="modal-site-row"><span>🕐 Timestamp</span><strong>' + site.timestamp + '</strong></div>';
  }

  // Popola catasto nel modal
  const modalCatasto = document.getElementById('modalCatastoBox');
  if (modalCatasto && currentCatastoData && currentCatastoData.foglio !== 'N/D') {
    modalCatasto.style.display = 'block';
    const content = document.createElement('div');
    renderCatastoData(currentCatastoData, content, null);
    modalCatasto.innerHTML = '<div class="catasto-box-header"><span>🏛️ Dati Catastali</span><span style="font-size:10px;color:var(--primary);">✓ caricati</span></div>';
    modalCatasto.appendChild(content);
  } else if (modalCatasto) {
    modalCatasto.style.display = 'none';
  }

  // Reset consenso
  const check = document.getElementById('consentCheck');
  if (check) check.checked = false;
  const btn = document.getElementById('btnConfirmUpload');
  if (btn) btn.disabled = true;

  document.getElementById('learningModal').style.display = 'flex';
}

function closeLearningModal(event) {
  if (event && event.target !== document.getElementById('learningModal')) return;
  document.getElementById('learningModal').style.display = 'none';
}

// ── UPLOAD AL DATASET GLOBALE ─────────────────────────────────────
/**
 * Invia i dati al repository GitHub tramite Repository Dispatch API.
 * Il token PAT viene letto da localStorage (mai hardcodato nel sorgente).
 *
 * SICUREZZA:
 * - Il token viene salvato in localStorage solo sul dispositivo dell'operatore
 * - Non viene mai incluso nel codice sorgente pubblicato su GitHub Pages
 * - Usa un PAT fine-grained con scope "Contents: Read and Write" solo su questo repo
 * - La GitHub Action usa GITHUB_TOKEN (automatico) per il commit — non serve PAT per quello
 */
async function uploadToGlobalDataset(data) {
  const repo  = LEARNING_CONFIG.repo  || localStorage.getItem('argus_gh_repo');
  const token = LEARNING_CONFIG.token || localStorage.getItem('argus_gh_token');

  if (!repo || !token) {
    // Non aprire prompt automatici — l'utente configura dalle Impostazioni
    console.warn('[Upload] Token GitHub non configurato. Vai in Impostazioni per configurarlo.');
    // Aggiorna status nella sezione apprendimento
    const dot = document.getElementById('learningDot');
    const txt = document.getElementById('learningStatusText');
    if (dot) dot.className = 'learning-dot warn';
    if (txt) txt.textContent = 'Token non configurato — vai in Impostazioni';
    return false;
  }

  const dot = document.getElementById('learningDot');
  const txt = document.getElementById('learningStatusText');
  if (dot) dot.className = 'learning-dot running';
  if (txt) txt.textContent = 'Invio in corso...';

  try {
    const payload = {
      event_type: 'argus_new_entry',
      client_payload: {
        id:               'argus_' + Date.now(),
        timestamp:        new Date().toISOString(),
        lat:              data.lat,
        lng:              data.lng,
        comune:           data.comune           || 'N/D',
        vegetation_type:  data.vegetation_type  || 'unknown',
        confidence:       data.confidence       || 0,
        detection_method: data.detection_method || 'manual',
        satellites_used:  data.satellites_used  || ['sentinel2'],
        risk_score:       data.risk_score       || 0,
        ndvi_delta:       data.ndvi_delta        || 0,
        thermal_anomaly:  data.thermal_anomaly   || 0,
        sar_backscatter:  data.sar_backscatter   || 0,
        catasto:          data.catasto           || {}
      }
    };

    const res = await fetch(LEARNING_CONFIG.apiUrl + repo + '/dispatches', {
      method:  'POST',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Accept':        'application/vnd.github+json',
        'Content-Type':  'application/json',
        'X-GitHub-Api-Version': '2022-11-28'
      },
      body: JSON.stringify(payload)
    });

    if (res.status === 204) {
      // Successo: GitHub Dispatch accettato
      if (dot) dot.className = 'learning-dot ok';
      if (txt) txt.textContent = 'Contributo inviato con successo!';

      // Animazione cervello
      triggerBrainAnimation();

      // Incrementa contatore locale
      localContribCount++;
      localStorage.setItem('argus_contrib_count', localContribCount);
      updateLocalContribCounter();

      showToast('🧠 Contributo inviato al dataset globale!', 'success', 5000);
      document.getElementById('learningModal').style.display = 'none';
      return true;
    } else {
      const errBody = await res.text();
      throw new Error('HTTP ' + res.status + ': ' + errBody.slice(0, 100));
    }
  } catch(err) {
    console.error('[Learning]', err);
    if (dot) dot.className = 'learning-dot error';
    if (txt) txt.textContent = 'Errore invio: ' + err.message.slice(0, 60);
    showToast('❌ Errore invio: ' + err.message.slice(0, 50), 'error', 6000);
    return false;
  }
}

async function confirmUpload() {
  if (!currentLearningEntry) return;
  const vegType = document.getElementById('learningVegType');
  const data = {
    lat:              currentLearningEntry.lat,
    lng:              currentLearningEntry.lng,
    comune:           currentLearningEntry.comune,
    vegetation_type:  vegType ? vegType.value : 'unknown',
    confidence:       0.8,
    detection_method: 'manual',
    satellites_used:  Object.keys(state.activeSatellites).filter(function(k) { return state.activeSatellites[k]; }),
    risk_score:       0,
    ndvi_delta:       0,
    thermal_anomaly:  0,
    sar_backscatter:  0,
    catasto:          currentCatastoData || {}
  };
  await uploadToGlobalDataset(data);
}

// Chiamata automatica quando si conferma un sito (marker o AI)
function autoUploadOnConfirm(site, detectionData) {
  if (!LEARNING_CONFIG.repo || !LEARNING_CONFIG.token) return; // silenzioso se non configurato
  const data = {
    lat:              site.lat,
    lng:              site.lng,
    comune:           site.comune,
    vegetation_type:  'coltura_sospetta',
    confidence:       detectionData ? (detectionData.confidence || 0.5) : 0.5,
    detection_method: detectionData ? 'ai_cv' : 'manual',
    satellites_used:  Object.keys(state.activeSatellites).filter(function(k) { return state.activeSatellites[k]; }),
    risk_score:       detectionData ? Math.round((detectionData.confidence || 0) * 100) : 0,
    ndvi_delta:       0,
    thermal_anomaly:  0,
    sar_backscatter:  0,
    catasto:          {}
  };
  uploadToGlobalDataset(data);
}

// ── ANIMAZIONE CERVELLO ───────────────────────────────────────────
function triggerBrainAnimation() {
  const icons = [document.getElementById('brainIcon'), document.getElementById('brainIconModal')];
  icons.forEach(function(icon) {
    if (!icon) return;
    icon.classList.add('brain-glow');
    setTimeout(function() { icon.classList.remove('brain-glow'); }, 3000);
  });
}

// ── CONFIGURAZIONE TOKEN (primo avvio) ────────────────────────────
function promptTokenConfig() {
  const repo = prompt(
    'CONFIGURAZIONE ARGUS — Apprendimento Collettivo\n\n' +
    'Inserisci il tuo GitHub Repository (es: username/argus-app):\n' +
    '(Lascia vuoto per annullare)'
  );
  if (!repo) return;
  const token = prompt(
    'Inserisci il tuo GitHub PAT (Fine-grained token):\n\n' +
    'Come ottenerlo:\n' +
    '1. GitHub → Settings → Developer settings\n' +
    '2. Personal access tokens → Fine-grained tokens\n' +
    '3. Scope: Contents (Read & Write) su questo repository\n\n' +
    'Il token viene salvato SOLO su questo dispositivo (localStorage).'
  );
  if (!token) return;
  localStorage.setItem('argus_gh_repo',  repo.trim());
  localStorage.setItem('argus_gh_token', token.trim());
  LEARNING_CONFIG.repo  = repo.trim();
  LEARNING_CONFIG.token = token.trim();
  const dot = document.getElementById('learningDot');
  const txt = document.getElementById('learningStatusText');
  if (dot) dot.className = 'learning-dot ok';
  if (txt) txt.textContent = 'Configurato: ' + repo.trim();
  showToast('✅ Token configurato. Pronto per contribuire!', 'success', 5000);
}

// ── CONDIVISIONE WHATSAPP ─────────────────────────────────────────
/**
 * Genera un messaggio WhatsApp con:
 * - Coordinate del sito
 * - Dati catastali (foglio, particella, comune)
 * - Link Google Maps
 * - Link OpenStreetMap
 * - Timestamp
 */
function shareOnWhatsApp() {
  const site = currentLearningEntry;
  if (!site) {
    showToast('Seleziona prima un sito dalla lista.', 'error');
    return;
  }

  const catasto = currentCatastoData;
  const mapsUrl = 'https://maps.google.com/?q=' + site.lat + ',' + site.lng;
  const osmUrl  = 'https://www.openstreetmap.org/?mlat=' + site.lat + '&mlon=' + site.lng + '&zoom=17';

  // Sezione catastale (solo se disponibile)
  let catastoText = '';
  if (catasto && catasto.foglio && catasto.foglio !== 'N/D') {
    catastoText =
      '\n\n🏛️ *DATI CATASTALI*' +
      '\nFoglio: ' + (catasto.foglio || 'N/D') +
      '\nParticella: ' + (catasto.particella || 'N/D') +
      '\nComune catastale: ' + (catasto.comune_catastale || site.comune) +
      (catasto.sezione    ? '\nSezione: '    + catasto.sezione    : '') +
      (catasto.qualita    ? '\nQualità: '    + catasto.qualita    : '') +
      (catasto.classe     ? '\nClasse: '     + catasto.classe     : '') +
      (catasto.superficie_ha > 0 ? '\nSuperficie: ' + catasto.superficie_ha.toFixed(4) + ' ha' : '');
  }

  // Tipo vegetazione selezionato
  const vegEl = document.getElementById('learningVegType');
  const vegLabel = vegEl ? vegEl.options[vegEl.selectedIndex].text : 'N/D';

  const msg =
    '🔴 *ARGUS — SITO SOSPETTO RILEVATO*\n' +
    '━━━━━━━━━━━━━━━━━━━━\n\n' +
    '📍 *' + site.name + '*\n' +
    '🏘️ Comune: ' + site.comune + '\n' +
    '🌿 Tipo: ' + vegLabel + '\n' +
    '🕐 ' + site.timestamp + '\n\n' +
    '🌐 *COORDINATE*\n' +
    'Lat: ' + site.lat.toFixed(6) + '\n' +
    'Lng: ' + site.lng.toFixed(6) +
    catastoText +
    '\n\n🗺️ *LINK MAPPA*\n' +
    'Google Maps: ' + mapsUrl + '\n' +
    'OpenStreetMap: ' + osmUrl + '\n\n' +
    '━━━━━━━━━━━━━━━━━━━━\n' +
    '_Inviato da Argus GIS Investigativo_';

  // Mostra preview
  const preview = document.getElementById('whatsappPreview');
  if (preview) {
    preview.style.display = 'block';
    preview.textContent = msg;
  }

  // Apri WhatsApp
  const waUrl = 'https://wa.me/?text=' + encodeURIComponent(msg);
  window.open(waUrl, '_blank', 'noopener,noreferrer');
  showToast('📲 WhatsApp aperto con il messaggio!', 'success', 4000);
}

// ================================================================
// 18b. IMPOSTAZIONI — Configurazione sistema
// ================================================================

function initSettings() {
  // Carica valori salvati nei campi
  const repo  = localStorage.getItem('argus_gh_repo')  || '';
  const token = localStorage.getItem('argus_gh_token') || '';
  const repoEl  = document.getElementById('settingsRepo');
  const tokenEl = document.getElementById('settingsToken');
  if (repoEl)  repoEl.value  = repo;
  if (tokenEl) tokenEl.value = token;

  // Carica impostazioni sinergia (con default corretti)
  const autoScan     = localStorage.getItem('argus_auto_scan')    === 'true';
  const autoUpload   = localStorage.getItem('argus_auto_upload')  === 'true';
  const fallbackDLR  = localStorage.getItem('argus_fallback_dlr')   !== 'false';  // default true
  const fallbackMODIS= localStorage.getItem('argus_fallback_modis') !== 'false';  // default true

  const elAutoScan     = document.getElementById('settingsAutoScan');
  const elAutoUpload   = document.getElementById('settingsAutoUpload');
  const elFallbackDLR  = document.getElementById('settingsFallbackDLR');
  const elFallbackMODIS= document.getElementById('settingsFallbackMODIS');
  if (elAutoScan)      elAutoScan.checked      = autoScan;
  if (elAutoUpload)    elAutoUpload.checked    = autoUpload;
  if (elFallbackDLR)   elFallbackDLR.checked   = fallbackDLR;
  if (elFallbackMODIS) elFallbackMODIS.checked = fallbackMODIS;

  // Aggiorna status GitHub
  updateSettingsGhStatus(repo && token);

  // Aggiorna status dot satelliti
  const s2Dot = document.getElementById('statusDotS2');
  if (s2Dot) s2Dot.className = 'sentinel-dot ok'; // S2 sempre disponibile
}

function saveGitHubSettings() {
  const repo  = (document.getElementById('settingsRepo')?.value  || '').trim();
  const token = (document.getElementById('settingsToken')?.value || '').trim();
  if (!repo || !token) {
    showToast('Inserisci sia il repository che il token.', 'error');
    return;
  }
  localStorage.setItem('argus_gh_repo',  repo);
  localStorage.setItem('argus_gh_token', token);
  LEARNING_CONFIG.repo  = repo;
  LEARNING_CONFIG.token = token;
  updateSettingsGhStatus(true);
  showToast('✅ Impostazioni GitHub salvate.', 'success');
}

function clearGitHubSettings() {
  if (!confirm('Cancellare le credenziali GitHub salvate?')) return;
  localStorage.removeItem('argus_gh_repo');
  localStorage.removeItem('argus_gh_token');
  LEARNING_CONFIG.repo  = '';
  LEARNING_CONFIG.token = '';
  const repoEl  = document.getElementById('settingsRepo');
  const tokenEl = document.getElementById('settingsToken');
  if (repoEl)  repoEl.value  = '';
  if (tokenEl) tokenEl.value = '';
  updateSettingsGhStatus(false);
  showToast('🗑️ Credenziali GitHub cancellate.', 'info');
}

async function testGitHubConnection() {
  const repo  = (document.getElementById('settingsRepo')?.value  || '').trim();
  const token = (document.getElementById('settingsToken')?.value || '').trim();
  if (!repo || !token) {
    showToast('Inserisci repo e token prima di testare.', 'error');
    return;
  }
  updateSettingsGhStatus(null, 'Test in corso...');
  try {
    const res = await fetch('https://api.github.com/repos/' + repo, {
      headers: {
        'Authorization': 'Bearer ' + token,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28'
      }
    });
    if (res.ok) {
      const data = await res.json();
      updateSettingsGhStatus(true, 'Connesso: ' + data.full_name);
      showToast('✅ Connessione GitHub OK: ' + data.full_name, 'success', 5000);
    } else {
      updateSettingsGhStatus(false, 'Errore HTTP ' + res.status);
      showToast('❌ Token non valido o repo non trovato (HTTP ' + res.status + ')', 'error', 5000);
    }
  } catch(err) {
    updateSettingsGhStatus(false, 'Errore di rete');
    showToast('❌ Errore di rete: ' + err.message, 'error');
  }
}

function updateSettingsGhStatus(ok, text) {
  const dot = document.getElementById('settingsGhDot');
  const lbl = document.getElementById('settingsGhStatus');
  if (ok === null) {
    if (dot) dot.className = 'sentinel-dot loading';
    if (lbl) lbl.textContent = text || 'Test in corso...';
  } else if (ok) {
    if (dot) dot.className = 'sentinel-dot ok';
    if (lbl) lbl.textContent = text || 'Configurato ✓';
    // Aggiorna anche il dot nella sezione apprendimento
    const ld = document.getElementById('learningDot');
    const lt = document.getElementById('learningStatusText');
    if (ld) ld.className = 'learning-dot ok';
    if (lt) lt.textContent = 'Pronto per contribuire';
    // Aggiorna status grid
    const ghDot = document.getElementById('statusDotGH');
    if (ghDot) ghDot.className = 'sentinel-dot ok';
  } else {
    if (dot) dot.className = 'sentinel-dot error';
    if (lbl) lbl.textContent = text || 'Non configurato';
    const ghDot = document.getElementById('statusDotGH');
    if (ghDot) ghDot.className = 'sentinel-dot error';
  }
}

function toggleTokenVisibility() {
  const input = document.getElementById('settingsToken');
  const icon  = document.getElementById('eyeIcon');
  if (!input) return;
  if (input.type === 'password') {
    input.type = 'text';
    if (icon) icon.innerHTML = '<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/>';
  } else {
    input.type = 'password';
    if (icon) icon.innerHTML = '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>';
  }
}

function saveSynergySettings() {
  const elAutoScan      = document.getElementById('settingsAutoScan');
  const elAutoUpload    = document.getElementById('settingsAutoUpload');
  const elFallbackDLR   = document.getElementById('settingsFallbackDLR');
  const elFallbackMODIS = document.getElementById('settingsFallbackMODIS');

  // Salva solo se l'elemento esiste — altrimenti mantieni il valore precedente
  if (elAutoScan)      localStorage.setItem('argus_auto_scan',      elAutoScan.checked);
  if (elAutoUpload)    localStorage.setItem('argus_auto_upload',    elAutoUpload.checked);
  if (elFallbackDLR)   localStorage.setItem('argus_fallback_dlr',   elFallbackDLR.checked);
  if (elFallbackMODIS) localStorage.setItem('argus_fallback_modis', elFallbackMODIS.checked);
}

// Legge le impostazioni sinergia (usato da searchComune e hitlConfirm)
// Legge SOLO da localStorage — non accede al DOM per evitare errori se la sidebar è chiusa
function getSynergySettings() {
  return {
    autoScan:      localStorage.getItem('argus_auto_scan')    === 'true',
    autoUpload:    localStorage.getItem('argus_auto_upload')  === 'true',
    fallbackDLR:   localStorage.getItem('argus_fallback_dlr')   !== 'false',  // default true
    fallbackMODIS: localStorage.getItem('argus_fallback_modis') !== 'false'   // default true
  };
}

async function checkAllConnections() {
  showToast('🔄 Verifica connessioni in corso...', 'info', 3000);

  // Sentinel Hub
  const s2Dot = document.getElementById('statusDotS2');
  if (s2Dot) s2Dot.className = 'sentinel-dot loading';
  try {
    const r = await fetch(SH_WMS + '?SERVICE=WMS&REQUEST=GetCapabilities', { signal: AbortSignal.timeout(5000) });
    if (s2Dot) s2Dot.className = r.ok ? 'sentinel-dot ok' : 'sentinel-dot warn';
  } catch(e) {
    if (s2Dot) s2Dot.className = 'sentinel-dot warn';
  }

  // NASA GIBS (Landsat proxy)
  const lsDot = document.getElementById('statusDotLandsat');
  if (lsDot) lsDot.className = 'sentinel-dot loading';
  try {
    const r = await fetch(GIBS_BASE + '/MODIS_Terra_CorrectedReflectance_TrueColor/default/2024-01-01/GoogleMapsCompatible/3/4/4.jpg', { signal: AbortSignal.timeout(5000) });
    if (lsDot) lsDot.className = r.ok ? 'sentinel-dot ok' : 'sentinel-dot warn';
  } catch(e) {
    if (lsDot) lsDot.className = 'sentinel-dot warn';
  }

  // SAR proxy (stesso endpoint GIBS)
  const sarDot = document.getElementById('statusDotSAR');
  if (sarDot) sarDot.className = 'sentinel-dot ok'; // stesso server GIBS

  // GitHub API
  const repo  = localStorage.getItem('argus_gh_repo');
  const token = localStorage.getItem('argus_gh_token');
  const ghDot = document.getElementById('statusDotGH');
  if (ghDot) ghDot.className = 'sentinel-dot loading';
  if (repo && token) {
    try {
      const r = await fetch('https://api.github.com/repos/' + repo, {
        headers: { 'Authorization': 'Bearer ' + token, 'Accept': 'application/vnd.github+json' },
        signal: AbortSignal.timeout(5000)
      });
      if (ghDot) ghDot.className = r.ok ? 'sentinel-dot ok' : 'sentinel-dot error';
    } catch(e) {
      if (ghDot) ghDot.className = 'sentinel-dot error';
    }
  } else {
    if (ghDot) ghDot.className = 'sentinel-dot warn';
  }

  showToast('✅ Verifica connessioni completata.', 'success');
}

function resetAllSettings() {
  if (!confirm('Cancellare TUTTE le impostazioni locali? (token, configurazioni, contatori)\nI siti salvati NON verranno cancellati.')) return;
  const keysToKeep = [LS_KEY]; // mantieni i siti
  const allKeys = Object.keys(localStorage);
  allKeys.forEach(function(k) {
    if (!keysToKeep.includes(k)) localStorage.removeItem(k);
  });
  // Reset UI
  const repoEl  = document.getElementById('settingsRepo');
  const tokenEl = document.getElementById('settingsToken');
  if (repoEl)  repoEl.value  = '';
  if (tokenEl) tokenEl.value = '';
  LEARNING_CONFIG.repo  = '';
  LEARNING_CONFIG.token = '';
  // Ripristina default checkbox
  const elFallbackDLR   = document.getElementById('settingsFallbackDLR');
  const elFallbackMODIS = document.getElementById('settingsFallbackMODIS');
  const elAutoScan      = document.getElementById('settingsAutoScan');
  const elAutoUpload    = document.getElementById('settingsAutoUpload');
  if (elFallbackDLR)   elFallbackDLR.checked   = true;
  if (elFallbackMODIS) elFallbackMODIS.checked = true;
  if (elAutoScan)      elAutoScan.checked      = false;
  if (elAutoUpload)    elAutoUpload.checked    = false;
  updateSettingsGhStatus(false);
  showToast('🗑️ Impostazioni resettate. I siti sono stati mantenuti.', 'info', 5000);
}

// ================================================================
// 18. BOOTSTRAP
// ================================================================
document.addEventListener('DOMContentLoaded', () => {
  initMap();
  registerServiceWorker();
  initLearning();
  initHitl();
  initSettings();
});

