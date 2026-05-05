// ================================================================
// ARGUS GIS v3.0 — script.js
// Sentinel-2 real-time + Auto Risk Analysis
// ================================================================
'use strict';

// ── COSTANTI ─────────────────────────────────────────────────────
const NOMINATIM_URL = 'https://nominatim.openstreetmap.org';
const OVERPASS_URL  = 'https://overpass-api.de/api/interpreter';
const LS_KEY        = 'argus_sites';

// Copernicus Data Space STAC API — gratuita, no autenticazione per query
// Restituisce le scene Sentinel-2 L2A più recenti per qualsiasi bbox
const STAC_API = 'https://catalogue.dataspace.copernicus.eu/stac/collections/SENTINEL-2/items';

// WMS Copernicus Data Space — richiede token OAuth2 per le tile
// Usiamo invece il servizio WMTS pubblico di Sentinel Hub EO Browser
// che non richiede registrazione per la visualizzazione base
const SENTINEL_WMTS = 'https://services.sentinel-hub.com/ogc/wmts/cd280189-7c51-45a6-ab05-f96a76067128';

// Fallback: WMS pubblico EOC/DLR per NDVI (dati mensili aggregati)
const SENTINEL_WMS_FALLBACK = 'https://geoservice.dlr.de/eoc/imagery/wms';

const MONTHS = [
  'Gennaio','Febbraio','Marzo','Aprile','Maggio','Giugno',
  'Luglio','Agosto','Settembre','Ottobre','Novembre','Dicembre'
];

const INDEX_DESCRIPTIONS = {
  NDVI: '<strong>NDVI</strong> — Normalized Difference Vegetation Index. Valori 0.6–0.9 = vegetazione densa e sana. Anomalie rispetto al bosco circostante indicano coltivazioni intensive.',
  NDRE: '<strong>NDRE</strong> — Normalized Difference Red Edge. Sensibile al contenuto di clorofilla. Distingue la cannabis dalla flora boschiva per la sua firma spettrale unica.',
  EVI:  '<strong>EVI</strong> — Enhanced Vegetation Index. Riduce la saturazione in zone boschive dense. Utile per rilevare coltivazioni nascoste nel sottobosco.',
  TRUE: '<strong>True Color</strong> — RGB naturale Sentinel-2 (B04/B03/B02). Visualizzazione reale del territorio con risoluzione 10m/pixel.'
};

// ── STATO APPLICAZIONE ───────────────────────────────────────────
const state = {
  map:              null,
  baseLayers:       {},
  activeBase:       'osm',
  riskLayers:       {},
  sentinelLayer:    null,
  droneLayer:       null,
  droneImageUrl:    null,
  markerCluster:    null,
  markers:          {},
  sites:            [],
  addMarkerMode:    false,
  selectedIndex:    'TRUE',
  currentYear:      new Date().getFullYear(),
  currentMonth:     new Date().getMonth(),
  communeBounds:    null,
  riskZonesLayer:   null,   // Layer zone sospette calcolate automaticamente
  lastStacScene:    null,   // Metadati ultima scena Sentinel trovata
  autoAnalysisRunning: false
};


// ================================================================
// 1. INIZIALIZZAZIONE MAPPA
// ================================================================
function initMap() {
  state.map = L.map('map', {
    center: [41.9, 12.5], zoom: 6,
    zoomControl: false, attributionControl: true
  });
  // Zoom in basso a SINISTRA — i FAB sono a destra, nessuna sovrapposizione
  L.control.zoom({ position: 'bottomleft' }).addTo(state.map);

  state.baseLayers.osm = L.tileLayer(
    'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    { attribution: '© OpenStreetMap', maxZoom: 19 }
  );
  state.baseLayers.satellite = L.tileLayer(
    'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    { attribution: '© Esri, Maxar', maxZoom: 19 }
  );
  state.baseLayers.topo = L.tileLayer(
    'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
    { attribution: '© OpenTopoMap', maxZoom: 17 }
  );
  state.baseLayers.osm.addTo(state.map);

  state.markerCluster = L.markerClusterGroup({
    showCoverageOnHover: false, maxClusterRadius: 50,
    iconCreateFunction: (c) => L.divIcon({
      html: `<div class="cluster-icon">${c.getChildCount()}</div>`,
      className: '', iconSize: [40, 40]
    })
  });
  state.map.addLayer(state.markerCluster);
  state.map.on('click', onMapClick);
  loadSitesFromStorage();
  updateTimelineLabel();
  showToast('Argus GIS v3.0 pronto.', 'success');
}

function switchBaseLayer(k) {
  if (state.baseLayers[state.activeBase]) state.map.removeLayer(state.baseLayers[state.activeBase]);
  if (state.baseLayers[k]) { state.baseLayers[k].addTo(state.map); state.baseLayers[k].bringToBack(); state.activeBase = k; }
}

// ================================================================
// 2. SENTINEL-2 REAL-TIME via Copernicus STAC + WMS
// ================================================================

/**
 * Interroga il STAC API di Copernicus Data Space per trovare
 * la scena Sentinel-2 L2A più recente sull'area visibile.
 * Poi carica il WMS corrispondente tramite il servizio pubblico
 * di Sentinel Hub (istanza demo pubblica, no token).
 *
 * Frequenza di rivisita Sentinel-2: ogni 3-5 giorni sull'Italia.
 */
async function loadLatestSentinel() {
  if (state.sentinelLayer) {
    state.map.removeLayer(state.sentinelLayer);
    state.sentinelLayer = null;
  }

  const bounds = state.map.getBounds();
  const bbox   = [
    bounds.getWest().toFixed(4),
    bounds.getSouth().toFixed(4),
    bounds.getEast().toFixed(4),
    bounds.getNorth().toFixed(4)
  ].join(',');

  // Calcola finestra temporale: ultimi 10 giorni per trovare scena recente
  const now      = new Date();
  const dateTo   = now.toISOString().slice(0, 10);
  const dateFrom = new Date(now - 10 * 86400000).toISOString().slice(0, 10);

  showSpinner(true);
  updateSentinelStatus('loading', 'Ricerca scena più recente...');

  try {
    // Query STAC: cerca scene con copertura nuvolosa < 30%
    const stacUrl = `${STAC_API}?bbox=${bbox}&datetime=${dateFrom}T00:00:00Z/${dateTo}T23:59:59Z&limit=5&sortby=-datetime&filter=eo:cloud_cover<30`;
    const res  = await fetch(stacUrl, { headers: { 'Accept': 'application/json' } });

    if (!res.ok) throw new Error(`STAC API: ${res.status}`);
    const data = await res.json();

    let sceneDate = dateTo;
    let sceneId   = null;
    let cloudCover = 'N/D';

    if (data.features && data.features.length > 0) {
      const scene = data.features[0];
      sceneDate   = scene.properties.datetime
        ? scene.properties.datetime.slice(0, 10)
        : dateTo;
      sceneId     = scene.id;
      cloudCover  = scene.properties['eo:cloud_cover']
        ? scene.properties['eo:cloud_cover'].toFixed(1) + '%'
        : 'N/D';
      state.lastStacScene = scene;
    }

    // Mappa indice → layer ID del servizio WMS pubblico Sentinel Hub
    // Istanza pubblica demo (cd280189) — True Color, NDVI, False Color
    const layerIds = {
      TRUE: 'TRUE-COLOR',
      NDVI: 'NDVI',
      NDRE: 'FALSE-COLOR',
      EVI:  'FALSE-COLOR-URBAN'
    };
    const layerId = layerIds[state.selectedIndex] || 'TRUE-COLOR';

    // WMS Sentinel Hub istanza pubblica — aggiornata ogni passaggio satellite
    const wmsUrl = 'https://services.sentinel-hub.com/ogc/wms/cd280189-7c51-45a6-ab05-f96a76067128';

    state.sentinelLayer = L.tileLayer.wms(wmsUrl, {
      layers:      layerId,
      format:      'image/png',
      transparent: true,
      version:     '1.3.0',
      time:        sceneDate,          // data scena più recente trovata
      maxcc:       30,                 // max cloud cover 30%
      attribution: `© ESA Copernicus Sentinel-2 · ${sceneDate}`,
      opacity:     0.85,
      maxZoom:     18,
      tileSize:    512
    });

    state.sentinelLayer.on('tileerror', (e) => {
      // Fallback al WMS DLR se Sentinel Hub non risponde
      loadSentinelFallback();
    });

    state.sentinelLayer.addTo(state.map);

    const daysAgo = Math.round((now - new Date(sceneDate)) / 86400000);
    // Aggiorna card dettagliata con info volo
    updateSentinelCard({
      date:       sceneDate,
      daysAgo,
      cloudCover,
      sceneId,
      index:      state.selectedIndex,
      source:     'Sentinel Hub / Copernicus'
    });

    updateSentinelStatus('ok',
      `Scena del ${sceneDate} (${daysAgo}gg fa) · Nuvole: ${cloudCover}`
    );
    showToast(`🛰️ Sentinel-2 ${state.selectedIndex} · ${sceneDate} · ☁️ ${cloudCover}`, 'success', 5000);
  } catch (err) {
    console.warn('[Sentinel STAC] Errore, uso fallback:', err.message);
    loadSentinelFallback();
  } finally {
    showSpinner(false);
  }
}

/**
 * Fallback: WMS DLR/EOC con dati mensili aggregati.
 * Usato quando Sentinel Hub non risponde o STAC non trova scene.
 */
function loadSentinelFallback() {
  if (state.sentinelLayer) {
    state.map.removeLayer(state.sentinelLayer);
    state.sentinelLayer = null;
  }

  const layerMap = {
    TRUE: 'S2_L2A_RGB_ENHANCED',
    NDVI: 'S2_L2A_NDVI',
    NDRE: 'S2_L2A_FALSE_COLOR',
    EVI:  'S2_L2A_RGB_ENHANCED'
  };

  state.sentinelLayer = L.tileLayer.wms(SENTINEL_WMS_FALLBACK, {
    layers:      layerMap[state.selectedIndex] || 'S2_L2A_NDVI',
    format:      'image/png',
    transparent: true,
    version:     '1.3.0',
    attribution: '© DLR/EOC · ESA Copernicus Sentinel-2',
    opacity:     0.80,
    maxZoom:     18
  }).addTo(state.map);

  updateSentinelStatus('warn', 'Dati aggregati mensili (fallback DLR)');
  updateSentinelCard({
    date:       new Date().toISOString().slice(0, 10),
    daysAgo:    null,
    cloudCover: 'N/D',
    sceneId:    null,
    index:      state.selectedIndex,
    source:     'DLR/EOC (dati mensili aggregati)'
  });
  showToast('⚠️ Sentinel Hub non disponibile, uso dati DLR mensili.', 'info');
}

/**
 * Aggiorna il pannello di stato Sentinel nella sidebar.
 */
function updateSentinelStatus(type, text) {
  const dot  = document.getElementById('sentinelDot');
  const info = document.getElementById('sentinelInfo');
  if (!dot || !info) return;
  dot.className = `sentinel-dot ${type}`;
  info.textContent = text;
}

/**
 * Popola la card dettagliata con le informazioni del volo Sentinel.
 * Mostra: data acquisizione, giorni fa, copertura nuvolosa, satellite, indice.
 * @param {{date, daysAgo, cloudCover, sceneId, index, source}} info
 */
function updateSentinelCard(info) {
  const card = document.getElementById('sentinelFlightCard');
  if (!card) return;

  // Badge freschezza: verde <5gg, giallo 5-10gg, rosso >10gg
  let freshnessColor = '#00c896';
  let freshnessLabel = 'Recente';
  if (info.daysAgo === null) {
    freshnessColor = '#7d8590';
    freshnessLabel = 'Aggregato';
  } else if (info.daysAgo > 10) {
    freshnessColor = '#ff4757';
    freshnessLabel = 'Datato';
  } else if (info.daysAgo > 5) {
    freshnessColor = '#ffa502';
    freshnessLabel = `${info.daysAgo}gg fa`;
  } else {
    freshnessLabel = `${info.daysAgo}gg fa`;
  }

  // Estrai satellite dal scene ID (es. S2A_MSIL2A_... → S2A)
  const satellite = info.sceneId
    ? (info.sceneId.startsWith('S2A') ? 'Sentinel-2A' : info.sceneId.startsWith('S2B') ? 'Sentinel-2B' : 'Sentinel-2')
    : 'Sentinel-2';

  // Formatta data in italiano
  let dateFormatted = info.date;
  try {
    dateFormatted = new Date(info.date).toLocaleDateString('it-IT', {
      weekday: 'short', day: '2-digit', month: 'long', year: 'numeric'
    });
  } catch(e) {}

  card.style.display = 'block';
  card.innerHTML = `
    <div class="flight-card">
      <div class="flight-card-header">
        <span class="flight-badge" style="background:${freshnessColor}20; color:${freshnessColor}; border-color:${freshnessColor}40;">
          ● ${freshnessLabel}
        </span>
        <span class="flight-satellite">${satellite}</span>
      </div>
      <div class="flight-card-row">
        <span class="flight-icon">📅</span>
        <div>
          <div class="flight-label">Data acquisizione</div>
          <div class="flight-value">${dateFormatted}</div>
        </div>
      </div>
      <div class="flight-card-row">
        <span class="flight-icon">☁️</span>
        <div>
          <div class="flight-label">Copertura nuvolosa</div>
          <div class="flight-value" style="color:${parseFloat(info.cloudCover) > 20 ? '#ffa502' : '#00c896'}">
            ${info.cloudCover}
          </div>
        </div>
      </div>
      <div class="flight-card-row">
        <span class="flight-icon">🛰️</span>
        <div>
          <div class="flight-label">Indice / Banda</div>
          <div class="flight-value">${info.index} — ${getIndexFullName(info.index)}</div>
        </div>
      </div>
      <div class="flight-card-row">
        <span class="flight-icon">📡</span>
        <div>
          <div class="flight-label">Fonte dati</div>
          <div class="flight-value" style="font-size:10px;">${info.source}</div>
        </div>
      </div>
      ${info.sceneId ? `
      <div class="flight-scene-id" title="${info.sceneId}">
        ID: ${info.sceneId.slice(0, 30)}…
      </div>` : ''}
    </div>
  `;
}

/**
 * Restituisce il nome completo di un indice spettrale.
 */
function getIndexFullName(idx) {
  const names = {
    TRUE: 'True Color RGB',
    NDVI: 'Vegetation Index',
    NDRE: 'Red Edge / False Color',
    EVI:  'Enhanced Vegetation'
  };
  return names[idx] || idx;
}

/**
 * Aggiorna la label della timeline.
 */
function updateTimelineLabel() {
  const slider = document.getElementById('timelineSlider');
  if (!slider) return;
  const daysBack = parseInt(slider.value, 10);
  const d = new Date(Date.now() - daysBack * 86400000);
  const label = d.toLocaleDateString('it-IT', { day: '2-digit', month: 'short', year: 'numeric' });
  document.getElementById('timelineLabel').textContent = label;
  state.timelineDaysBack = daysBack;
}

/**
 * Carica Sentinel per una data specifica dalla timeline.
 */
function loadSentinelForDate() {
  const daysBack = state.timelineDaysBack || 0;
  const d = new Date(Date.now() - daysBack * 86400000);
  const dateStr = d.toISOString().slice(0, 10);

  if (state.sentinelLayer) {
    state.map.removeLayer(state.sentinelLayer);
    state.sentinelLayer = null;
  }

  const layerIds = { TRUE: 'TRUE-COLOR', NDVI: 'NDVI', NDRE: 'FALSE-COLOR', EVI: 'FALSE-COLOR-URBAN' };
  const wmsUrl = 'https://services.sentinel-hub.com/ogc/wms/cd280189-7c51-45a6-ab05-f96a76067128';

  state.sentinelLayer = L.tileLayer.wms(wmsUrl, {
    layers: layerIds[state.selectedIndex] || 'TRUE-COLOR',
    format: 'image/png', transparent: true, version: '1.3.0',
    time: dateStr, maxcc: 50,
    attribution: `© ESA Copernicus · ${dateStr}`,
    opacity: 0.85, maxZoom: 18, tileSize: 512
  }).addTo(state.map);

  updateSentinelStatus('ok', `Data selezionata: ${dateStr}`);
  updateSentinelCard({
    date:       dateStr,
    daysAgo:    daysBack,
    cloudCover: '≤50%',
    sceneId:    null,
    index:      state.selectedIndex,
    source:     'Sentinel Hub / Copernicus'
  });
  showToast(`🛰️ Sentinel-2 ${state.selectedIndex} · ${dateStr}`, 'success');
}

function selectIndex(name) {
  state.selectedIndex = name;
  document.querySelectorAll('.index-btn').forEach(b => {
    b.classList.toggle('active', b.id === `btn${name}`);
    b.setAttribute('aria-pressed', b.id === `btn${name}` ? 'true' : 'false');
  });
  document.getElementById('indexDesc').innerHTML = INDEX_DESCRIPTIONS[name] || '';
}


// ================================================================
// 3. ANALISI AUTOMATICA ZONE SOSPETTE
// ================================================================
// Quando si cerca un comune o si aggiunge un marker, questa funzione
// calcola automaticamente le zone ad alto rischio incrociando:
//   1. Buffer 300m da corsi d'acqua (Overpass)
//   2. Distanza >500m da strade principali (Overpass)
//   3. Presenza di sentieri/mulattiere (accesso nascosto)
//   4. Esclusione zone con pendenza >35° (non coltivabili)
// Le zone che soddisfano tutti i criteri vengono evidenziate
// come poligoni rossi pulsanti sulla mappa.
// ================================================================

/**
 * Punto di ingresso principale per l'analisi automatica.
 * Chiamata dopo searchComune() e dopo onMapClick().
 * @param {number} lat - latitudine centro analisi
 * @param {number} lng - longitudine centro analisi
 * @param {number} radiusKm - raggio analisi in km (default 5)
 */
async function runAutoRiskAnalysis(lat, lng, radiusKm = 5) {
  if (state.autoAnalysisRunning) return;
  state.autoAnalysisRunning = true;

  // Rimuovi layer precedente
  if (state.riskZonesLayer) {
    state.map.removeLayer(state.riskZonesLayer);
    state.riskZonesLayer = null;
  }

  // Calcola bbox dell'area di analisi
  const degOffset = radiusKm / 111.0;
  const bbox = `${lat - degOffset},${lng - degOffset},${lat + degOffset},${lng + degOffset}`;

  updateAnalysisStatus('running', `Analisi zona ${radiusKm}km in corso...`);
  showToast('🔍 Analisi automatica zone sospette avviata...', 'info', 3000);

  try {
    // Esegui tutte le query Overpass in parallelo
    const [waterFeatures, roadFeatures, pathFeatures] = await Promise.all([
      fetchWaterways(bbox),
      fetchMainRoads(bbox),
      fetchPaths(bbox)
    ]);

    // Genera griglia di punti candidati nell'area
    const candidates = generateCandidateGrid(lat, lng, radiusKm, 0.15);

    // Filtra i candidati applicando i criteri di rischio
    const riskZones = [];

    for (const pt of candidates) {
      const score = computeRiskScore(pt, waterFeatures, roadFeatures, pathFeatures);
      if (score.total >= 60) {
        riskZones.push({ point: pt, score });
      }
    }

    if (riskZones.length === 0) {
      updateAnalysisStatus('ok', 'Nessuna zona ad alto rischio rilevata');
      showToast('✅ Nessuna zona sospetta nell\'area analizzata.', 'success');
      state.autoAnalysisRunning = false;
      return;
    }

    // Crea buffer circolari attorno alle zone ad alto rischio
    const riskFeatures = riskZones.map(z => {
      const circle = turf.circle(
        [z.point.lng, z.point.lat],
        0.12,  // raggio 120m per zona
        { steps: 16, units: 'kilometers' }
      );
      circle.properties = {
        score:      z.score.total,
        water:      z.score.water,
        isolation:  z.score.isolation,
        paths:      z.score.paths,
        label:      z.score.total >= 85 ? 'ALTO RISCHIO' : 'RISCHIO MEDIO'
      };
      return circle;
    });

    // Raggruppa zone vicine con turf.union per evitare sovrapposizioni
    const merged = mergeNearbyZones(riskFeatures);

    // Visualizza sulla mappa
    state.riskZonesLayer = L.geoJSON(
      { type: 'FeatureCollection', features: merged },
      {
        style: (f) => ({
          color:       f.properties.score >= 85 ? '#ff4757' : '#ffa502',
          weight:      2,
          opacity:     0.9,
          fillColor:   f.properties.score >= 85 ? '#ff4757' : '#ffa502',
          fillOpacity: f.properties.score >= 85 ? 0.35 : 0.20,
          dashArray:   f.properties.score >= 85 ? null : '4 3'
        }),
        onEachFeature: (f, layer) => {
          layer.bindPopup(buildRiskZonePopup(f.properties));
          layer.on('mouseover', function() { this.setStyle({ fillOpacity: 0.55 }); });
          layer.on('mouseout',  function() { this.setStyle({ fillOpacity: f.properties.score >= 85 ? 0.35 : 0.20 }); });
        }
      }
    ).addTo(state.map);

    const highRisk = riskZones.filter(z => z.score.total >= 85).length;
    const medRisk  = riskZones.length - highRisk;

    updateAnalysisStatus('alert',
      `${highRisk} zone ALTO rischio · ${medRisk} zone MEDIO rischio`
    );
    showToast(
      `⚠️ Trovate ${riskZones.length} zone sospette (${highRisk} alto rischio)`,
      highRisk > 0 ? 'error' : 'info',
      6000
    );

  } catch (err) {
    console.error('[AutoRisk] Errore:', err);
    updateAnalysisStatus('error', 'Errore analisi');
    showToast('Errore durante l\'analisi automatica.', 'error');
  } finally {
    state.autoAnalysisRunning = false;
  }
}

/**
 * Genera una griglia di punti candidati nell'area di analisi.
 * @param {number} centerLat
 * @param {number} centerLng
 * @param {number} radiusKm
 * @param {number} stepKm - passo della griglia in km
 * @returns {Array<{lat, lng}>}
 */
function generateCandidateGrid(centerLat, centerLng, radiusKm, stepKm) {
  const candidates = [];
  const stepDeg = stepKm / 111.0;
  const radiusDeg = radiusKm / 111.0;

  for (let dlat = -radiusDeg; dlat <= radiusDeg; dlat += stepDeg) {
    for (let dlng = -radiusDeg; dlng <= radiusDeg; dlng += stepDeg) {
      const dist = Math.sqrt(dlat * dlat + dlng * dlng);
      if (dist <= radiusDeg) {
        candidates.push({ lat: centerLat + dlat, lng: centerLng + dlng });
      }
    }
  }
  return candidates;
}

/**
 * Calcola il punteggio di rischio per un punto candidato.
 * Punteggio 0-100 basato su 3 criteri:
 *   - Prossimità acqua (0-40 punti): entro 300m da corso d'acqua
 *   - Isolamento strade (0-35 punti): oltre 500m da strade principali
 *   - Accesso sentieri (0-25 punti): presenza di sentieri entro 800m
 *
 * @param {{lat, lng}} pt
 * @param {Array} waterFeatures - linestring corsi d'acqua
 * @param {Array} roadFeatures  - linestring strade principali
 * @param {Array} pathFeatures  - linestring sentieri
 * @returns {{total, water, isolation, paths}}
 */
function computeRiskScore(pt, waterFeatures, roadFeatures, pathFeatures) {
  const ptTurf = turf.point([pt.lng, pt.lat]);
  let waterScore = 0, isolationScore = 0, pathScore = 0;

  // ── CRITERIO 1: Prossimità acqua ──────────────────────────────
  // Punteggio massimo se entro 50m, decresce fino a 300m
  let minWaterDist = Infinity;
  for (const f of waterFeatures) {
    try {
      const nearest = turf.nearestPointOnLine(f, ptTurf);
      const d = turf.distance(ptTurf, nearest, { units: 'meters' });
      if (d < minWaterDist) minWaterDist = d;
    } catch(e) {}
  }
  if (minWaterDist <= 300) {
    waterScore = Math.round(40 * (1 - minWaterDist / 300));
  }

  // ── CRITERIO 2: Isolamento da strade ──────────────────────────
  // Punteggio massimo se oltre 800m, zero se entro 200m
  let minRoadDist = Infinity;
  for (const f of roadFeatures) {
    try {
      const nearest = turf.nearestPointOnLine(f, ptTurf);
      const d = turf.distance(ptTurf, nearest, { units: 'meters' });
      if (d < minRoadDist) minRoadDist = d;
    } catch(e) {}
  }
  if (minRoadDist === Infinity) {
    isolationScore = 35; // nessuna strada nell'area = massimo isolamento
  } else if (minRoadDist >= 500) {
    isolationScore = Math.min(35, Math.round(35 * (minRoadDist - 500) / 500));
  }

  // ── CRITERIO 3: Presenza sentieri ─────────────────────────────
  // Punteggio se c'è un sentiero entro 800m (via d'accesso nascosta)
  let minPathDist = Infinity;
  for (const f of pathFeatures) {
    try {
      const nearest = turf.nearestPointOnLine(f, ptTurf);
      const d = turf.distance(ptTurf, nearest, { units: 'meters' });
      if (d < minPathDist) minPathDist = d;
    } catch(e) {}
  }
  if (minPathDist <= 800) {
    pathScore = Math.round(25 * (1 - minPathDist / 800));
  }

  return {
    total:     waterScore + isolationScore + pathScore,
    water:     waterScore,
    isolation: isolationScore,
    paths:     pathScore,
    waterDist: Math.round(minWaterDist),
    roadDist:  Math.round(minRoadDist === Infinity ? 9999 : minRoadDist),
    pathDist:  Math.round(minPathDist === Infinity ? 9999 : minPathDist)
  };
}

/**
 * Unisce zone vicine per evitare sovrapposizioni eccessive.
 */
function mergeNearbyZones(features) {
  // Raggruppa per score e restituisce le feature senza merge complesso
  // (turf.union su molti poligoni è lento lato client)
  return features.sort((a, b) => b.properties.score - a.properties.score).slice(0, 20);
}

/**
 * Costruisce il popup HTML per una zona di rischio.
 */
function buildRiskZonePopup(props) {
  const color = props.score >= 85 ? '#ff4757' : '#ffa502';
  return `
    <div style="font-family:'Segoe UI',sans-serif; min-width:220px;">
      <div style="font-size:14px;font-weight:700;color:${color};margin-bottom:10px;">
        ⚠️ ${props.label}
      </div>
      <div style="font-size:12px;color:#adb5bd;margin-bottom:8px;">
        <b style="color:#e6edf3;">Score rischio:</b>
        <span style="color:${color};font-size:16px;font-weight:700;"> ${props.score}/100</span>
      </div>
      <div style="font-size:11px;color:#7d8590;line-height:1.8;">
        💧 Prossimità acqua: <b style="color:#00e5ff;">${props.water}/40</b><br/>
        🚗 Isolamento strade: <b style="color:#ffa502;">${props.isolation}/35</b><br/>
        🥾 Accesso sentieri: <b style="color:#ff6b35;">${props.paths}/25</b>
      </div>
      <button onclick="addRiskZoneAsMarker(${props.score})"
        style="width:100%;margin-top:10px;padding:8px;background:#ffa502;color:#000;
               border:none;border-radius:6px;font-size:12px;font-weight:700;cursor:pointer;">
        📍 Aggiungi come Sito Sospetto
      </button>
    </div>`;
}

/**
 * Aggiorna il pannello di stato dell'analisi nella sidebar.
 */
function updateAnalysisStatus(type, text) {
  const dot  = document.getElementById('analysisDot');
  const info = document.getElementById('analysisInfo');
  if (!dot || !info) return;
  dot.className = `analysis-dot ${type}`;
  info.textContent = text;
}

// ── FETCH HELPERS ─────────────────────────────────────────────────

async function fetchWaterways(bbox) {
  const q = `[out:json][timeout:20];(way["waterway"~"river|stream|canal|drain"](${bbox});node["natural"="spring"](${bbox}););out geom;`;
  try {
    const r = await fetch(OVERPASS_URL, { method: 'POST', body: `data=${encodeURIComponent(q)}` });
    const d = await r.json();
    return d.elements
      .filter(e => e.type === 'way' && e.geometry && e.geometry.length >= 2)
      .map(e => turf.lineString(e.geometry.map(p => [p.lon, p.lat])));
  } catch(e) { return []; }
}

async function fetchMainRoads(bbox) {
  const q = `[out:json][timeout:20];way["highway"~"primary|secondary|tertiary|trunk|motorway"](${bbox});out geom;`;
  try {
    const r = await fetch(OVERPASS_URL, { method: 'POST', body: `data=${encodeURIComponent(q)}` });
    const d = await r.json();
    return d.elements
      .filter(e => e.geometry && e.geometry.length >= 2)
      .map(e => turf.lineString(e.geometry.map(p => [p.lon, p.lat])));
  } catch(e) { return []; }
}

async function fetchPaths(bbox) {
  const q = `[out:json][timeout:20];way["highway"~"track|path|footway|bridleway"](${bbox});out geom;`;
  try {
    const r = await fetch(OVERPASS_URL, { method: 'POST', body: `data=${encodeURIComponent(q)}` });
    const d = await r.json();
    return d.elements
      .filter(e => e.geometry && e.geometry.length >= 2)
      .map(e => turf.lineString(e.geometry.map(p => [p.lon, p.lat])));
  } catch(e) { return []; }
}


// ================================================================
// 4. RICERCA COMUNE — con analisi automatica integrata
// ================================================================
async function searchComune() {
  const query = document.getElementById('searchInput').value.trim();
  if (!query) { showToast('Inserisci il nome di un comune.', 'error'); return; }
  showSpinner(true);
  try {
    const url = `${NOMINATIM_URL}/search?q=${encodeURIComponent(query)}&format=json&limit=1&polygon_geojson=1&addressdetails=1&countrycodes=it`;
    const res  = await fetch(url, { headers: { 'Accept-Language': 'it' } });
    const data = await res.json();
    if (!data.length) { showToast(`"${query}" non trovato.`, 'error'); return; }
    const place = data[0];
    if (state.communeBounds) state.map.removeLayer(state.communeBounds);
    if (place.geojson) {
      state.communeBounds = L.geoJSON(place.geojson, {
        style: { color:'#00c896', weight:2.5, opacity:0.9, fillColor:'#00c896', fillOpacity:0.06, dashArray:'6 4' }
      }).addTo(state.map);
      state.map.fitBounds(state.communeBounds.getBounds(), { padding: [40, 40] });
    } else {
      state.map.setView([parseFloat(place.lat), parseFloat(place.lon)], 13);
    }
    const name = place.display_name.split(',')[0];
    showToast(`📍 ${name} trovato.`, 'success');

    // ── ANALISI AUTOMATICA ──────────────────────────────────────
    // Calcola il centro del comune e avvia l'analisi di rischio
    const centerLat = parseFloat(place.lat);
    const centerLng = parseFloat(place.lon);
    // Stima raggio dal bounding box del comune
    const bb = place.boundingbox;
    const radiusKm = bb
      ? Math.min(15, Math.max(3, turf.distance(
          turf.point([parseFloat(bb[2]), parseFloat(bb[0])]),
          turf.point([parseFloat(bb[3]), parseFloat(bb[1])]),
          { units: 'kilometers' }
        ) / 2))
      : 5;

    // Carica anche Sentinel più recente sull'area
    setTimeout(() => loadLatestSentinel(), 500);
    // Avvia analisi rischio dopo 1s (lascia caricare la mappa)
    setTimeout(() => runAutoRiskAnalysis(centerLat, centerLng, radiusKm), 1000);

  } catch (err) {
    console.error('[Nominatim]', err);
    showToast('Errore di rete.', 'error');
  } finally {
    showSpinner(false);
  }
}

// ================================================================
// 5. GESTIONE MARKER + ANALISI AUTOMATICA AL CLICK
// ================================================================
function toggleAddMarkerMode() {
  state.addMarkerMode = !state.addMarkerMode;
  const btn = document.getElementById('addMarkerBtn');
  const map = state.map.getContainer();
  if (state.addMarkerMode) {
    btn.classList.add('active');
    map.style.cursor = 'crosshair';
    showToast('🎯 Clicca sulla mappa per aggiungere un sito.', 'info');
  } else {
    btn.classList.remove('active');
    map.style.cursor = '';
  }
}

async function onMapClick(e) {
  if (!state.addMarkerMode) return;
  const { lat, lng } = e.latlng;
  showSpinner(true);
  try {
    const res = await fetch(
      `${NOMINATIM_URL}/reverse?lat=${lat}&lon=${lng}&format=json&zoom=14`,
      { headers: { 'Accept-Language': 'it' } }
    );
    const geo  = await res.json();
    const addr = geo.address || {};
    const comune = addr.municipality || addr.city || addr.town || addr.village || addr.county || 'N/D';
    const site = {
      id: `site_${Date.now()}`,
      lat: parseFloat(lat.toFixed(6)), lng: parseFloat(lng.toFixed(6)),
      name: `Sito ${state.sites.length + 1}`, comune,
      address: geo.display_name || '', timestamp: new Date().toLocaleString('it-IT'), note: ''
    };
    addSiteToMap(site);
    state.sites.push(site);
    saveSitesToStorage();
    renderSitesList();
    showToast(`📍 Sito aggiunto: ${comune}`, 'success');

    // ── ANALISI AUTOMATICA INTORNO AL MARKER ───────────────────
    setTimeout(() => runAutoRiskAnalysis(lat, lng, 3), 800);

  } catch (err) {
    const site = {
      id: `site_${Date.now()}`,
      lat: parseFloat(lat.toFixed(6)), lng: parseFloat(lng.toFixed(6)),
      name: `Sito ${state.sites.length + 1}`, comune: 'N/D',
      address: '', timestamp: new Date().toLocaleString('it-IT'), note: ''
    };
    addSiteToMap(site); state.sites.push(site); saveSitesToStorage(); renderSitesList();
    showToast('📍 Sito aggiunto (geocoding non disponibile).', 'info');
    setTimeout(() => runAutoRiskAnalysis(lat, lng, 3), 800);
  } finally {
    showSpinner(false);
  }
}

function addSiteToMap(site) {
  const icon = L.divIcon({
    html: `<div style="width:32px;height:32px;background:#ffa502;border:3px solid #fff;border-radius:50% 50% 50% 0;transform:rotate(-45deg);box-shadow:0 2px 8px rgba(0,0,0,0.4);"></div>`,
    className: '', iconSize: [32,32], iconAnchor: [16,32], popupAnchor: [0,-36]
  });
  const marker = L.marker([site.lat, site.lng], { icon })
    .bindPopup(buildPopupContent(site), { maxWidth: 280, className: 'eco-popup' });
  state.markerCluster.addLayer(marker);
  state.markers[site.id] = marker;
}

function buildPopupContent(site) {
  return `<div style="font-family:'Segoe UI',sans-serif;min-width:200px;">
    <div style="font-size:15px;font-weight:700;color:#ffa502;margin-bottom:8px;">⚠️ ${site.name}</div>
    <div style="font-size:12px;color:#adb5bd;margin-bottom:4px;">📍 ${site.comune}</div>
    <div style="font-size:11px;color:#7d8590;font-family:monospace;margin-bottom:8px;">${site.lat}, ${site.lng}</div>
    <div style="font-size:11px;color:#7d8590;margin-bottom:8px;">🕐 ${site.timestamp}</div>
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
    id: `site_${Date.now()}`,
    lat: parseFloat(center.lat.toFixed(6)), lng: parseFloat(center.lng.toFixed(6)),
    name: `Zona Rischio (${score}/100)`, comune: 'Auto-rilevato',
    address: '', timestamp: new Date().toLocaleString('it-IT'), note: `Score: ${score}/100`
  };
  addSiteToMap(site); state.sites.push(site); saveSitesToStorage(); renderSitesList();
  state.map.closePopup();
  showToast('📍 Zona aggiunta al database.', 'success');
}

function locateUser() {
  if (!navigator.geolocation) { showToast('GPS non supportato.', 'error'); return; }
  showSpinner(true);
  navigator.geolocation.getCurrentPosition(
    async (pos) => {
      const lat = pos.coords.latitude, lng = pos.coords.longitude;
      state.addMarkerMode = true;
      await onMapClick({ latlng: { lat, lng } });
      state.addMarkerMode = false;
      state.map.setView([lat, lng], 14);
      showSpinner(false);
    },
    (err) => { showSpinner(false); showToast(`GPS: ${err.message}`, 'error'); },
    { enableHighAccuracy: true, timeout: 10000 }
  );
}

// ================================================================
// 6. LAYER RISCHIO MANUALE (toggle sidebar)
// ================================================================
async function toggleRiskLayer(layerType, enabled) {
  if (!enabled) {
    if (state.riskLayers[layerType]) { state.map.removeLayer(state.riskLayers[layerType]); delete state.riskLayers[layerType]; }
    return;
  }
  const bounds = state.map.getBounds();
  const bbox = `${bounds.getSouth()},${bounds.getWest()},${bounds.getNorth()},${bounds.getEast()}`;
  showSpinner(true);
  try {
    if (layerType === 'water') {
      const feats = await fetchWaterways(bbox);
      const buffered = feats.map(f => turf.buffer(f, 0.3, { units: 'kilometers' }));
      state.riskLayers.water = L.geoJSON({ type:'FeatureCollection', features: buffered },
        { style: { color:'#00e5ff', weight:1, opacity:0.7, fillColor:'#00e5ff', fillOpacity:0.18 } }
      ).addTo(state.map);
      showToast(`💧 Buffer 300m: ${feats.length} corsi d'acqua.`, 'success');
    } else if (layerType === 'roads') {
      const feats = await fetchMainRoads(bbox);
      const buffered = feats.map(f => turf.buffer(f, 0.5, { units: 'kilometers' }));
      state.riskLayers.roads = L.geoJSON({ type:'FeatureCollection', features: buffered },
        { style: { color:'#ffa502', weight:1, opacity:0.6, fillColor:'#ffa502', fillOpacity:0.12 } }
      ).addTo(state.map);
      showToast(`🚗 Buffer 500m strade: ${feats.length} segmenti.`, 'success');
    } else if (layerType === 'paths') {
      const feats = await fetchPaths(bbox);
      const geojsonFeats = feats.map(f => ({ type:'Feature', geometry: f.geometry, properties:{} }));
      state.riskLayers.paths = L.geoJSON({ type:'FeatureCollection', features: geojsonFeats },
        { style: { color:'#ff6b35', weight:2, opacity:0.8, dashArray:'4 3' } }
      ).addTo(state.map);
      showToast(`🥾 ${feats.length} sentieri caricati.`, 'success');
    } else if (layerType === 'catasto') {
      state.riskLayers.catasto = L.tileLayer.wms('https://wms.cartografia.agenziaentrate.gov.it/inspire/wms/ows01.php', {
        layers:'CP.CadastralParcel', format:'image/png', transparent:true, version:'1.3.0',
        attribution:'© Agenzia delle Entrate', opacity:0.7
      }).addTo(state.map);
      showToast('🏛️ Catasto caricato.', 'success');
    }
  } catch(err) {
    showToast(`Errore layer ${layerType}.`, 'error');
    const cb = document.getElementById(`filter${layerType.charAt(0).toUpperCase()+layerType.slice(1)}`);
    if (cb) cb.checked = false;
  } finally { showSpinner(false); }
}

// ================================================================
// 7. SENTIERI VICINI
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
    const nearby = feats.filter(f => {
      try { return turf.distance(sitePoint, turf.nearestPointOnLine(f, sitePoint), { units:'kilometers' }) <= 1.0; }
      catch(e) { return false; }
    }).map(f => ({ type:'Feature', geometry: f.geometry, properties:{} }));
    if (!nearby.length) { showToast('Nessun sentiero entro 1km.', 'info'); return; }
    state.riskLayers.nearbyPaths = L.geoJSON({ type:'FeatureCollection', features: nearby },
      { style: { color:'#ff4757', weight:4, opacity:1 } }
    ).addTo(state.map);
    showToast(`🔴 ${nearby.length} sentieri evidenziati.`, 'success');
  } catch(err) { showToast('Errore sentieri.', 'error'); }
  finally { showSpinner(false); }
}

// ================================================================
// 8. DRONE OVERLAY
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
// 9. PERSISTENZA DATI
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
  } catch(e) {}
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
  if (!state.sites.length) { showToast('Nessun sito.', 'error'); return; }
  const gj = { type:'FeatureCollection', features: state.sites.map(s => ({
    type:'Feature', geometry:{ type:'Point', coordinates:[s.lng,s.lat] },
    properties:{ id:s.id, name:s.name, comune:s.comune, timestamp:s.timestamp }
  }))};
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(gj,null,2)], { type:'application/geo+json' }));
  a.download = `argus_siti_${new Date().toISOString().slice(0,10)}.geojson`;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  showToast(`📥 GeoJSON esportato (${state.sites.length} siti).`, 'success');
}

// ================================================================
// 10. UI HELPERS
// ================================================================
function toggleSidebar() {
  document.getElementById('sidebar').classList.toggle('open');
  document.getElementById('sidebarOverlay').classList.toggle('active');
}
function showSpinner(v) { document.getElementById('spinner').classList.toggle('active', v); }
function showToast(msg, type='info', dur=3500) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.className = `toast ${type} show`;
  clearTimeout(t._t); t._t = setTimeout(() => t.classList.remove('show'), dur);
}

// ================================================================
// 11. PWA + KEYBOARD
// ================================================================
let deferredInstall = null;
window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault(); deferredInstall = e;
  if (!window.matchMedia('(display-mode: standalone)').matches) {
    const b = document.getElementById('installBanner');
    if (b) b.style.display = 'flex';
  }
});
async function installPWA() {
  if (!deferredInstall) { showToast('Usa "Aggiungi a schermata Home" dal menu browser.', 'info', 5000); return; }
  deferredInstall.prompt();
  const { outcome } = await deferredInstall.userChoice;
  if (outcome === 'accepted') showToast('✅ Argus installato!', 'success');
  deferredInstall = null;
  const b = document.getElementById('installBanner'); if (b) b.style.display = 'none';
}
window.addEventListener('appinstalled', () => {
  const b = document.getElementById('installBanner'); if (b) b.style.display = 'none';
  showToast('✅ Argus installato!', 'success');
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    if (state.addMarkerMode) { state.addMarkerMode = false; document.getElementById('addMarkerBtn').classList.remove('active'); state.map.getContainer().style.cursor = ''; }
    const sb = document.getElementById('sidebar'); if (sb.classList.contains('open')) toggleSidebar();
  }
  if (e.key === 'Enter' && document.activeElement.id === 'searchInput') searchComune();
});

// ================================================================
// 12. BOOTSTRAP
// ================================================================
async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  try {
    const reg = await navigator.serviceWorker.register('./sw.js', { scope: './' });
    reg.addEventListener('updatefound', () => {
      const nw = reg.installing;
      nw.addEventListener('statechange', () => {
        if (nw.state === 'installed' && navigator.serviceWorker.controller)
          showToast('🔄 Aggiornamento disponibile. Ricarica la pagina.', 'info', 6000);
      });
    });
  } catch(e) { console.warn('[SW]', e); }
}

document.addEventListener('DOMContentLoaded', () => {
  initMap();
  registerServiceWorker();
});

