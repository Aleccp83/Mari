// ================================================================
// ECOMONITOR PRO — script.js
// Core Logic: Leaflet, Turf.js, Nominatim, WMS, localStorage
// ================================================================

'use strict';

// ── COSTANTI ─────────────────────────────────────────────────────
const NOMINATIM_URL  = 'https://nominatim.openstreetmap.org';
const OVERPASS_URL   = 'https://overpass-api.de/api/interpreter';
const LS_KEY         = 'ecomonitor_sites';

// Mesi per la timeline Sentinel-2
const MONTHS = [
  'Gennaio','Febbraio','Marzo','Aprile','Maggio','Giugno',
  'Luglio','Agosto','Settembre','Ottobre','Novembre','Dicembre'
];

// Descrizioni degli indici spettrali
const INDEX_DESCRIPTIONS = {
  NDVI: '<strong>NDVI</strong> — Normalized Difference Vegetation Index. Misura il vigore vegetativo. Valori alti (0.6–0.9) indicano vegetazione densa e sana, tipica della cannabis in fase di crescita.',
  NDRE: '<strong>NDRE</strong> — Normalized Difference Red Edge. Sensibile al contenuto di clorofilla. Distingue la cannabis dalla flora boschiva standard grazie alla sua firma spettrale unica nel red-edge.',
  EVI:  '<strong>EVI</strong> — Enhanced Vegetation Index. Riduce la saturazione in aree ad alta densità vegetativa. Utile per rilevare coltivazioni in zone boschive dense.'
};

// ── STATO APPLICAZIONE ───────────────────────────────────────────
const state = {
  map:            null,   // Istanza Leaflet
  baseLayers:     {},     // Layer base (osm, satellite, topo)
  activeBase:     'osm',  // Layer base attivo
  riskLayers:     {},     // Layer di rischio attivi
  sentinelLayer:  null,   // Layer WMS Sentinel-2 corrente
  droneLayer:     null,   // Overlay immagine drone
  droneImageUrl:  null,   // URL blob immagine drone
  markerCluster:  null,   // Gruppo cluster marker
  markers:        {},     // Mappa id -> marker Leaflet
  sites:          [],     // Array siti salvati
  addMarkerMode:  false,  // Modalità aggiunta marker
  selectedIndex:  'NDVI', // Indice spettrale selezionato
  currentYear:    2024,   // Anno timeline
  currentMonth:   5,      // Mese timeline (0-based)
  communeBounds:  null,   // Layer confini comune
};


// ================================================================
// 1. INIZIALIZZAZIONE MAPPA
// ================================================================

/**
 * Inizializza la mappa Leaflet con layer base, controlli e cluster.
 * Chiamata al DOMContentLoaded.
 */
function initMap() {
  // Crea istanza mappa centrata sull'Italia
  state.map = L.map('map', {
    center: [41.9, 12.5],
    zoom: 6,
    zoomControl: false,
    attributionControl: true
  });

  // Sposta i controlli zoom in basso a destra
  L.control.zoom({ position: 'bottomright' }).addTo(state.map);

  // ── LAYER BASE ──────────────────────────────────────────────
  state.baseLayers.osm = L.tileLayer(
    'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    {
      attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      maxZoom: 19
    }
  );

  state.baseLayers.satellite = L.tileLayer(
    'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    {
      attribution: '© <a href="https://www.esri.com">Esri</a> World Imagery',
      maxZoom: 19
    }
  );

  state.baseLayers.topo = L.tileLayer(
    'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
    {
      attribution: '© <a href="https://opentopomap.org">OpenTopoMap</a>',
      maxZoom: 17
    }
  );

  // Attiva il layer OSM di default
  state.baseLayers.osm.addTo(state.map);

  // ── MARKER CLUSTER ──────────────────────────────────────────
  state.markerCluster = L.markerClusterGroup({
    showCoverageOnHover: false,
    maxClusterRadius: 50,
    iconCreateFunction: (cluster) => {
      const count = cluster.getChildCount();
      return L.divIcon({
        html: `<div class="cluster-icon">${count}</div>`,
        className: '',
        iconSize: [40, 40]
      });
    }
  });
  state.map.addLayer(state.markerCluster);

  // ── EVENTI MAPPA ────────────────────────────────────────────
  state.map.on('click', onMapClick);

  // Aggiorna cursore in base alla modalità
  state.map.getContainer().style.cursor = '';

  // Carica siti salvati dal localStorage
  loadSitesFromStorage();

  // Aggiorna label timeline
  updateTimeline(5);

  showToast('EcoMonitor Pro pronto. Benvenuto.', 'success');
}

// ================================================================
// 2. GESTIONE LAYER BASE
// ================================================================

/**
 * Cambia il layer base della mappa.
 * @param {string} layerKey - 'osm' | 'satellite' | 'topo'
 */
function switchBaseLayer(layerKey) {
  // Rimuovi il layer attivo corrente
  if (state.baseLayers[state.activeBase]) {
    state.map.removeLayer(state.baseLayers[state.activeBase]);
  }
  // Aggiungi il nuovo layer
  if (state.baseLayers[layerKey]) {
    state.baseLayers[layerKey].addTo(state.map);
    // Porta il layer in fondo allo stack (sotto i layer di rischio)
    state.baseLayers[layerKey].bringToBack();
    state.activeBase = layerKey;
  }
}


// ================================================================
// 3. RICERCA COMUNE (NOMINATIM)
// ================================================================

/**
 * Cerca un comune tramite Nominatim e centra la mappa sui suoi confini.
 * Usa il parametro polygon_geojson=1 per ottenere il poligono del comune.
 */
async function searchComune() {
  const query = document.getElementById('searchInput').value.trim();
  if (!query) {
    showToast('Inserisci il nome di un comune.', 'error');
    return;
  }

  showSpinner(true);

  try {
    const url = `${NOMINATIM_URL}/search?q=${encodeURIComponent(query)}&format=json&limit=1&polygon_geojson=1&addressdetails=1&countrycodes=it`;
    const res  = await fetch(url, { headers: { 'Accept-Language': 'it' } });
    const data = await res.json();

    if (!data.length) {
      showToast(`Comune "${query}" non trovato.`, 'error');
      return;
    }

    const place = data[0];

    // Rimuovi confini precedenti
    if (state.communeBounds) {
      state.map.removeLayer(state.communeBounds);
    }

    // Disegna il poligono del comune
    if (place.geojson) {
      state.communeBounds = L.geoJSON(place.geojson, {
        style: {
          color:       '#00c896',
          weight:      2.5,
          opacity:     0.9,
          fillColor:   '#00c896',
          fillOpacity: 0.08,
          dashArray:   '6 4'
        }
      }).addTo(state.map);

      // Centra la mappa sui confini del comune
      state.map.fitBounds(state.communeBounds.getBounds(), { padding: [40, 40] });
    } else {
      // Fallback: centra sulle coordinate
      state.map.setView([parseFloat(place.lat), parseFloat(place.lon)], 13);
    }

    const name = place.display_name.split(',')[0];
    showToast(`📍 ${name} trovato.`, 'success');

  } catch (err) {
    console.error('[Nominatim] Errore:', err);
    showToast('Errore di rete. Controlla la connessione.', 'error');
  } finally {
    showSpinner(false);
  }
}

// ================================================================
// 4. LAYER DI RISCHIO PREDITTIVO (Turf.js + OSM Overpass)
// ================================================================

/**
 * Attiva/disattiva un layer di rischio predittivo.
 * @param {string}  layerType - 'water' | 'roads' | 'paths' | 'catasto'
 * @param {boolean} enabled
 */
async function toggleRiskLayer(layerType, enabled) {
  if (!enabled) {
    // Rimuovi il layer se esiste
    if (state.riskLayers[layerType]) {
      state.map.removeLayer(state.riskLayers[layerType]);
      delete state.riskLayers[layerType];
    }
    return;
  }

  // Ottieni il bounding box della vista corrente
  const bounds = state.map.getBounds();
  const bbox   = `${bounds.getSouth()},${bounds.getWest()},${bounds.getNorth()},${bounds.getEast()}`;

  showSpinner(true);

  try {
    switch (layerType) {
      case 'water':
        await loadWaterBuffer(bbox);
        break;
      case 'roads':
        await loadRoadsIsolation(bbox);
        break;
      case 'paths':
        await loadPaths(bbox);
        break;
      case 'catasto':
        loadCatastoWMS();
        break;
    }
  } catch (err) {
    console.error(`[RiskLayer:${layerType}] Errore:`, err);
    showToast(`Errore nel caricamento layer ${layerType}.`, 'error');
    // Deseleziona il checkbox in caso di errore
    const cb = document.getElementById(`filter${layerType.charAt(0).toUpperCase() + layerType.slice(1)}`);
    if (cb) cb.checked = false;
  } finally {
    showSpinner(false);
  }
}

/**
 * Carica i corsi d'acqua da Overpass API e crea buffer da 300m con Turf.js.
 * Evidenzia le zone ad alto rischio idrico.
 */
async function loadWaterBuffer(bbox) {
  const query = `
    [out:json][timeout:25];
    (
      way["waterway"~"river|stream|canal|drain"](${bbox});
      node["natural"="spring"](${bbox});
    );
    out geom;
  `;

  const res  = await fetch(OVERPASS_URL, {
    method: 'POST',
    body:   `data=${encodeURIComponent(query)}`
  });
  const data = await res.json();

  if (!data.elements.length) {
    showToast('Nessun corso d\'acqua trovato nella vista corrente.', 'info');
    return;
  }

  // Converti elementi Overpass in GeoJSON
  const features = [];
  data.elements.forEach((el) => {
    if (el.type === 'way' && el.geometry) {
      const coords = el.geometry.map((p) => [p.lon, p.lat]);
      if (coords.length >= 2) {
        features.push(turf.lineString(coords, { type: 'waterway' }));
      }
    } else if (el.type === 'node') {
      features.push(turf.point([el.lon, el.lat], { type: 'spring' }));
    }
  });

  if (!features.length) return;

  // Crea buffer da 300m attorno ai corsi d'acqua con Turf.js
  const buffered = features.map((f) =>
    turf.buffer(f, 0.3, { units: 'kilometers' })
  );

  // Unisci tutti i buffer in un unico layer
  const layer = L.geoJSON(
    { type: 'FeatureCollection', features: buffered },
    {
      style: {
        color:       '#00e5ff',
        weight:      1,
        opacity:     0.7,
        fillColor:   '#00e5ff',
        fillOpacity: 0.18
      }
    }
  ).addTo(state.map);

  state.riskLayers.water = layer;
  showToast(`💧 Buffer 300m: ${features.length} corsi d'acqua trovati.`, 'success');
}

/**
 * Carica le strade principali e crea una zona di isolamento (>500m).
 * Le aree lontane dalle strade sono evidenziate come zone ad alto rischio.
 */
async function loadRoadsIsolation(bbox) {
  const query = `
    [out:json][timeout:25];
    way["highway"~"primary|secondary|tertiary|trunk|motorway"](${bbox});
    out geom;
  `;

  const res  = await fetch(OVERPASS_URL, {
    method: 'POST',
    body:   `data=${encodeURIComponent(query)}`
  });
  const data = await res.json();

  if (!data.elements.length) {
    showToast('Nessuna strada principale trovata nella vista corrente.', 'info');
    return;
  }

  const features = [];
  data.elements.forEach((el) => {
    if (el.geometry && el.geometry.length >= 2) {
      const coords = el.geometry.map((p) => [p.lon, p.lat]);
      features.push(turf.lineString(coords));
    }
  });

  // Buffer da 500m attorno alle strade (zona di esclusione)
  const buffered = features.map((f) =>
    turf.buffer(f, 0.5, { units: 'kilometers' })
  );

  const layer = L.geoJSON(
    { type: 'FeatureCollection', features: buffered },
    {
      style: {
        color:       '#ffa502',
        weight:      1,
        opacity:     0.6,
        fillColor:   '#ffa502',
        fillOpacity: 0.12
      }
    }
  ).addTo(state.map);

  state.riskLayers.roads = layer;
  showToast(`🚗 Buffer 500m strade: ${features.length} segmenti trovati.`, 'success');
}

/**
 * Carica sentieri, mulattiere e piste ciclabili da Overpass API.
 */
async function loadPaths(bbox) {
  const query = `
    [out:json][timeout:25];
    way["highway"~"track|path|footway|bridleway"](${bbox});
    out geom;
  `;

  const res  = await fetch(OVERPASS_URL, {
    method: 'POST',
    body:   `data=${encodeURIComponent(query)}`
  });
  const data = await res.json();

  if (!data.elements.length) {
    showToast('Nessun sentiero trovato nella vista corrente.', 'info');
    return;
  }

  const geojsonFeatures = data.elements
    .filter((el) => el.geometry && el.geometry.length >= 2)
    .map((el) => ({
      type: 'Feature',
      geometry: {
        type: 'LineString',
        coordinates: el.geometry.map((p) => [p.lon, p.lat])
      },
      properties: { highway: el.tags?.highway || 'path' }
    }));

  const layer = L.geoJSON(
    { type: 'FeatureCollection', features: geojsonFeatures },
    {
      style: {
        color:   '#ff6b35',
        weight:  2,
        opacity: 0.8,
        dashArray: '4 3'
      }
    }
  ).addTo(state.map);

  state.riskLayers.paths = layer;
  showToast(`🥾 ${geojsonFeatures.length} sentieri/mulattiere caricati.`, 'success');
}

/**
 * Carica il layer WMS del Catasto dell'Agenzia delle Entrate.
 */
function loadCatastoWMS() {
  const wmsUrl = 'https://wms.cartografia.agenziaentrate.gov.it/inspire/wms/ows01.php';

  const layer = L.tileLayer.wms(wmsUrl, {
    layers:      'CP.CadastralParcel',
    format:      'image/png',
    transparent: true,
    version:     '1.3.0',
    attribution: '© Agenzia delle Entrate — Catasto',
    opacity:     0.7
  }).addTo(state.map);

  state.riskLayers.catasto = layer;
  showToast('🏛️ Layer Catasto AdE caricato.', 'success');
}


// ================================================================
// 5. TIMELINE SENTINEL-2
// ================================================================

/**
 * Aggiorna la label della timeline in base al valore dello slider.
 * @param {number|string} value - indice 0-11 (mesi)
 */
function updateTimeline(value) {
  const idx   = parseInt(value, 10);
  const month = MONTHS[idx];
  state.currentMonth = idx;
  // Calcola anno: slider 0-5 = anno corrente, 6-11 = anno precedente
  state.currentYear  = idx <= 5 ? 2024 : 2023;
  document.getElementById('timelineLabel').textContent = `${month} ${state.currentYear}`;
}

/**
 * Carica il layer WMS di Sentinel-2 tramite Sentinel Hub (servizio gratuito
 * con registrazione) oppure il servizio WMS pubblico di Copernicus.
 * Usa il servizio EO Browser WMS pubblico come fallback gratuito.
 */
function loadSentinelLayer() {
  // Rimuovi layer Sentinel precedente
  if (state.sentinelLayer) {
    state.map.removeLayer(state.sentinelLayer);
    state.sentinelLayer = null;
  }

  const month = String(state.currentMonth + 1).padStart(2, '0');
  const year  = state.currentYear;

  // Costruisci il time range per il mese selezionato
  const timeFrom = `${year}-${month}-01`;
  const timeTo   = `${year}-${month}-28`;

  // Selezione del layer in base all'indice spettrale scelto
  const layerMap = {
    NDVI: 'NDVI',
    NDRE: 'NDRE',
    EVI:  'EVI'
  };
  const layerName = layerMap[state.selectedIndex] || 'NDVI';

  // WMS pubblico Sentinel-2 L2A via Copernicus Data Space Ecosystem
  const wmsUrl = 'https://sh.dataspace.copernicus.eu/ogc/wms/0635c213-8d7a-4a5c-b054-b5b9a1e5e5e5';

  state.sentinelLayer = L.tileLayer.wms(wmsUrl, {
    layers:      layerName,
    format:      'image/png',
    transparent: true,
    version:     '1.3.0',
    time:        `${timeFrom}/${timeTo}`,
    attribution: '© Copernicus/ESA — Sentinel-2',
    opacity:     0.75,
    maxZoom:     18
  }).addTo(state.map);

  showToast(`🛰️ Sentinel-2 ${layerName} — ${MONTHS[state.currentMonth]} ${year} caricato.`, 'success');
}

/**
 * Seleziona l'indice spettrale attivo (NDVI, NDRE, EVI).
 * @param {string} indexName
 */
function selectIndex(indexName) {
  state.selectedIndex = indexName;

  // Aggiorna stile pulsanti
  document.querySelectorAll('.index-btn').forEach((btn) => {
    btn.classList.remove('active');
    btn.setAttribute('aria-pressed', 'false');
  });
  const activeBtn = document.getElementById(`btn${indexName}`);
  if (activeBtn) {
    activeBtn.classList.add('active');
    activeBtn.setAttribute('aria-pressed', 'true');
  }

  // Aggiorna descrizione
  document.getElementById('indexDesc').innerHTML = INDEX_DESCRIPTIONS[indexName] || '';
}

// ================================================================
// 6. IMPORTA ORTOFOTO DRONE
// ================================================================

/**
 * Gestisce il caricamento di un'immagine drone.
 * Mostra il form per inserire le coordinate di bounding box.
 * @param {Event} event
 */
function loadDroneImage(event) {
  const file = event.target.files[0];
  if (!file) return;

  // Revoca URL precedente per liberare memoria
  if (state.droneImageUrl) {
    URL.revokeObjectURL(state.droneImageUrl);
  }

  state.droneImageUrl = URL.createObjectURL(file);

  // Mostra il form per le coordinate
  document.getElementById('droneCoords').style.display = 'block';
  showToast(`📷 Immagine "${file.name}" caricata. Inserisci le coordinate.`, 'info');
}

/**
 * Sovrappone l'immagine drone alla mappa usando le coordinate inserite.
 * Usa L.imageOverlay di Leaflet con il bounding box specificato.
 */
function overlayDroneImage() {
  if (!state.droneImageUrl) {
    showToast('Nessuna immagine caricata.', 'error');
    return;
  }

  const south = parseFloat(document.getElementById('droneSouth').value);
  const north = parseFloat(document.getElementById('droneNorth').value);
  const west  = parseFloat(document.getElementById('droneWest').value);
  const east  = parseFloat(document.getElementById('droneEast').value);

  if ([south, north, west, east].some(isNaN)) {
    showToast('Inserisci tutte e 4 le coordinate del bounding box.', 'error');
    return;
  }

  if (south >= north || west >= east) {
    showToast('Coordinate non valide: controlla i valori di bounding box.', 'error');
    return;
  }

  // Rimuovi overlay precedente
  if (state.droneLayer) {
    state.map.removeLayer(state.droneLayer);
  }

  const bounds = [[south, west], [north, east]];

  state.droneLayer = L.imageOverlay(state.droneImageUrl, bounds, {
    opacity:     0.85,
    interactive: false,
    attribution: 'Ortofoto Drone'
  }).addTo(state.map);

  // Centra la mappa sull'overlay
  state.map.fitBounds(bounds, { padding: [20, 20] });
  showToast('📌 Ortofoto drone sovrapposta alla mappa.', 'success');
}


// ================================================================
// 7. GESTIONE MARKER E DATABASE SITI (localStorage)
// ================================================================

/**
 * Attiva/disattiva la modalità aggiunta marker.
 * Quando attiva, il click sulla mappa aggiunge un sito sospetto.
 */
function toggleAddMarkerMode() {
  state.addMarkerMode = !state.addMarkerMode;
  const btn = document.getElementById('addMarkerBtn');
  const map = state.map.getContainer();

  if (state.addMarkerMode) {
    btn.classList.add('active');
    map.style.cursor = 'crosshair';
    showToast('🎯 Modalità marker attiva. Clicca sulla mappa.', 'info');
  } else {
    btn.classList.remove('active');
    map.style.cursor = '';
    showToast('Modalità marker disattivata.', 'info');
  }
}

/**
 * Handler del click sulla mappa.
 * Se la modalità marker è attiva, aggiunge un sito sospetto.
 * @param {L.LeafletMouseEvent} e
 */
async function onMapClick(e) {
  if (!state.addMarkerMode) return;

  const { lat, lng } = e.latlng;
  showSpinner(true);

  try {
    // Reverse geocoding tramite Nominatim
    const res  = await fetch(
      `${NOMINATIM_URL}/reverse?lat=${lat}&lon=${lng}&format=json&zoom=14`,
      { headers: { 'Accept-Language': 'it' } }
    );
    const geo  = await res.json();
    const addr = geo.address || {};
    const name = addr.village || addr.town || addr.city || addr.county || addr.state || 'Posizione sconosciuta';
    const comune = addr.municipality || addr.city || addr.town || name;

    // Crea il sito
    const site = {
      id:        `site_${Date.now()}`,
      lat:       parseFloat(lat.toFixed(6)),
      lng:       parseFloat(lng.toFixed(6)),
      name:      `Sito ${state.sites.length + 1}`,
      comune,
      address:   geo.display_name || '',
      timestamp: new Date().toLocaleString('it-IT'),
      note:      ''
    };

    addSiteToMap(site);
    state.sites.push(site);
    saveSitesToStorage();
    renderSitesList();

    showToast(`📍 Sito aggiunto: ${comune}`, 'success');

  } catch (err) {
    console.error('[onMapClick] Errore reverse geocoding:', err);
    // Aggiungi comunque il marker senza indirizzo
    const site = {
      id:        `site_${Date.now()}`,
      lat:       parseFloat(lat.toFixed(6)),
      lng:       parseFloat(lng.toFixed(6)),
      name:      `Sito ${state.sites.length + 1}`,
      comune:    'N/D',
      address:   '',
      timestamp: new Date().toLocaleString('it-IT'),
      note:      ''
    };
    addSiteToMap(site);
    state.sites.push(site);
    saveSitesToStorage();
    renderSitesList();
    showToast('📍 Sito aggiunto (geocoding non disponibile).', 'info');
  } finally {
    showSpinner(false);
  }
}

/**
 * Aggiunge un marker Leaflet alla mappa per un sito.
 * @param {Object} site
 */
function addSiteToMap(site) {
  // Icona personalizzata SVG
  const icon = L.divIcon({
    html: `
      <div style="
        width:32px; height:32px;
        background:#ffa502;
        border:3px solid #fff;
        border-radius:50% 50% 50% 0;
        transform:rotate(-45deg);
        box-shadow:0 2px 8px rgba(0,0,0,0.4);
      "></div>
    `,
    className: '',
    iconSize:  [32, 32],
    iconAnchor:[16, 32],
    popupAnchor:[0, -36]
  });

  const marker = L.marker([site.lat, site.lng], { icon })
    .bindPopup(buildPopupContent(site), {
      maxWidth: 280,
      className: 'eco-popup'
    });

  state.markerCluster.addLayer(marker);
  state.markers[site.id] = marker;
}

/**
 * Costruisce il contenuto HTML del popup per un sito.
 * @param {Object} site
 * @returns {string}
 */
function buildPopupContent(site) {
  return `
    <div style="font-family:'Segoe UI',sans-serif; min-width:200px;">
      <div style="font-size:15px; font-weight:700; color:#ffa502; margin-bottom:8px;">
        ⚠️ ${site.name}
      </div>
      <div style="font-size:12px; color:#adb5bd; margin-bottom:4px;">
        📍 ${site.comune}
      </div>
      <div style="font-size:11px; color:#7d8590; font-family:monospace; margin-bottom:8px;">
        ${site.lat}, ${site.lng}
      </div>
      <div style="font-size:11px; color:#7d8590; margin-bottom:8px;">
        🕐 ${site.timestamp}
      </div>
      <button onclick="highlightNearbyPaths('${site.id}')"
        style="width:100%; padding:8px; background:#00c896; color:#000;
               border:none; border-radius:6px; font-size:12px; font-weight:600;
               cursor:pointer; margin-bottom:6px;">
        🥾 Evidenzia Sentieri Vicini
      </button>
      <button onclick="deleteSite('${site.id}')"
        style="width:100%; padding:8px; background:rgba(255,71,87,0.15); color:#ff4757;
               border:1px solid rgba(255,71,87,0.3); border-radius:6px;
               font-size:12px; font-weight:600; cursor:pointer;">
        🗑️ Elimina Sito
      </button>
    </div>
  `;
}

/**
 * Usa la posizione GPS del dispositivo per aggiungere un marker.
 */
function locateUser() {
  if (!navigator.geolocation) {
    showToast('Geolocalizzazione non supportata dal browser.', 'error');
    return;
  }

  showSpinner(true);
  navigator.geolocation.getCurrentPosition(
    async (pos) => {
      const lat = pos.coords.latitude;
      const lng = pos.coords.longitude;

      // Simula un click sulla mappa nella posizione GPS
      state.addMarkerMode = true;
      await onMapClick({ latlng: { lat, lng } });
      state.addMarkerMode = false;

      // Centra la mappa sulla posizione
      state.map.setView([lat, lng], 15);
      showSpinner(false);
    },
    (err) => {
      showSpinner(false);
      showToast(`GPS non disponibile: ${err.message}`, 'error');
    },
    { enableHighAccuracy: true, timeout: 10000 }
  );
}

// ================================================================
// 8. EVIDENZIAZIONE SENTIERI VICINI (Analisi Tattica)
// ================================================================

/**
 * Evidenzia in rosso brillante i sentieri entro 1km dal sito selezionato.
 * Usa Turf.js per calcolare le distanze.
 * @param {string} siteId
 */
async function highlightNearbyPaths(siteId) {
  const site = state.sites.find((s) => s.id === siteId);
  if (!site) return;

  // Rimuovi layer sentieri vicini precedente
  if (state.riskLayers.nearbyPaths) {
    state.map.removeLayer(state.riskLayers.nearbyPaths);
  }

  const lat  = site.lat;
  const lng  = site.lng;
  const dist = 0.01; // ~1km in gradi

  const bbox = `${lat - dist},${lng - dist},${lat + dist},${lng + dist}`;
  const query = `
    [out:json][timeout:15];
    way["highway"~"track|path|footway|bridleway"](${bbox});
    out geom;
  `;

  showSpinner(true);
  try {
    const res  = await fetch(OVERPASS_URL, {
      method: 'POST',
      body:   `data=${encodeURIComponent(query)}`
    });
    const data = await res.json();

    if (!data.elements.length) {
      showToast('Nessun sentiero trovato nel raggio di 1km.', 'info');
      return;
    }

    const sitePoint = turf.point([lng, lat]);

    // Filtra solo i sentieri entro 1km usando Turf.js
    const nearbyFeatures = data.elements
      .filter((el) => el.geometry && el.geometry.length >= 2)
      .filter((el) => {
        // Calcola distanza dal punto più vicino del sentiero al sito
        const line = turf.lineString(el.geometry.map((p) => [p.lon, p.lat]));
        const nearest = turf.nearestPointOnLine(line, sitePoint);
        const dist = turf.distance(sitePoint, nearest, { units: 'kilometers' });
        return dist <= 1.0;
      })
      .map((el) => ({
        type: 'Feature',
        geometry: {
          type: 'LineString',
          coordinates: el.geometry.map((p) => [p.lon, p.lat])
        },
        properties: {}
      }));

    if (!nearbyFeatures.length) {
      showToast('Nessun sentiero entro 1km dal sito.', 'info');
      return;
    }

    // Evidenzia in rosso brillante
    state.riskLayers.nearbyPaths = L.geoJSON(
      { type: 'FeatureCollection', features: nearbyFeatures },
      {
        style: {
          color:   '#ff4757',
          weight:  4,
          opacity: 1,
          dashArray: null
        }
      }
    ).addTo(state.map);

    showToast(`🔴 ${nearbyFeatures.length} sentieri evidenziati (raggio 1km).`, 'success');

  } catch (err) {
    console.error('[highlightNearbyPaths] Errore:', err);
    showToast('Errore nel caricamento sentieri vicini.', 'error');
  } finally {
    showSpinner(false);
  }
}


// ================================================================
// 9. PERSISTENZA DATI (localStorage)
// ================================================================

/**
 * Salva l'array dei siti nel localStorage.
 */
function saveSitesToStorage() {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(state.sites));
  } catch (err) {
    console.warn('[Storage] Impossibile salvare:', err);
    showToast('Attenzione: storage pieno o non disponibile.', 'error');
  }
}

/**
 * Carica i siti salvati dal localStorage e li aggiunge alla mappa.
 */
function loadSitesFromStorage() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return;

    const saved = JSON.parse(raw);
    if (!Array.isArray(saved)) return;

    state.sites = saved;
    saved.forEach((site) => addSiteToMap(site));
    renderSitesList();

    if (saved.length > 0) {
      showToast(`📂 ${saved.length} siti caricati dal database locale.`, 'info');
    }
  } catch (err) {
    console.warn('[Storage] Errore lettura:', err);
  }
}

/**
 * Elimina un singolo sito dal database e dalla mappa.
 * @param {string} siteId
 */
function deleteSite(siteId) {
  // Rimuovi marker dalla mappa
  if (state.markers[siteId]) {
    state.markerCluster.removeLayer(state.markers[siteId]);
    delete state.markers[siteId];
  }

  // Rimuovi dal database
  state.sites = state.sites.filter((s) => s.id !== siteId);
  saveSitesToStorage();
  renderSitesList();

  // Chiudi popup se aperto
  state.map.closePopup();
  showToast('Sito eliminato.', 'info');
}

/**
 * Cancella tutti i siti dal database e dalla mappa.
 */
function clearAllMarkers() {
  if (!state.sites.length) {
    showToast('Nessun sito da cancellare.', 'info');
    return;
  }

  if (!confirm(`Eliminare tutti i ${state.sites.length} siti salvati? Questa azione non è reversibile.`)) {
    return;
  }

  state.markerCluster.clearLayers();
  state.markers = {};
  state.sites   = [];
  localStorage.removeItem(LS_KEY);
  renderSitesList();
  showToast('🗑️ Tutti i siti eliminati.', 'info');
}

/**
 * Renderizza la lista dei siti nella sidebar.
 */
function renderSitesList() {
  const container = document.getElementById('sitesList');
  const countEl   = document.getElementById('siteCount');

  countEl.textContent = state.sites.length;

  if (!state.sites.length) {
    container.innerHTML = '<p class="empty-state">Nessun sito registrato.<br/>Attiva la modalità marker e clicca sulla mappa.</p>';
    return;
  }

  container.innerHTML = state.sites.map((site) => `
    <div class="site-item" role="listitem">
      <div class="site-item-name">⚠️ ${site.name}</div>
      <div class="site-item-coords">📍 ${site.comune}</div>
      <div class="site-item-coords">${site.lat}, ${site.lng}</div>
      <div class="site-item-coords" style="font-family:inherit; font-size:10px; margin-top:2px;">🕐 ${site.timestamp}</div>
      <div class="site-item-actions">
        <button class="site-btn goto" onclick="flyToSite('${site.id}')">🗺️ Vai a</button>
        <button class="site-btn goto" onclick="highlightNearbyPaths('${site.id}'); flyToSite('${site.id}')">🥾 Sentieri</button>
        <button class="site-btn del" onclick="deleteSite('${site.id}')">🗑️</button>
      </div>
    </div>
  `).join('');
}

/**
 * Anima la mappa verso un sito specifico (flyTo).
 * @param {string} siteId
 */
function flyToSite(siteId) {
  const site = state.sites.find((s) => s.id === siteId);
  if (!site) return;

  state.map.flyTo([site.lat, site.lng], 16, {
    animate:  true,
    duration: 1.5
  });

  // Apri il popup del marker dopo l'animazione
  setTimeout(() => {
    const marker = state.markers[siteId];
    if (marker) {
      state.markerCluster.zoomToShowLayer(marker, () => {
        marker.openPopup();
      });
    }
  }, 1600);
}

// ================================================================
// 10. ESPORTA GEOJSON
// ================================================================

/**
 * Esporta tutti i siti salvati come file GeoJSON scaricabile.
 */
function exportGeoJSON() {
  if (!state.sites.length) {
    showToast('Nessun sito da esportare.', 'error');
    return;
  }

  const geojson = {
    type: 'FeatureCollection',
    name: 'EcoMonitor_Pro_Siti',
    crs: {
      type: 'name',
      properties: { name: 'urn:ogc:def:crs:OGC:1.3:CRS84' }
    },
    features: state.sites.map((site) => ({
      type: 'Feature',
      geometry: {
        type:        'Point',
        coordinates: [site.lng, site.lat]
      },
      properties: {
        id:        site.id,
        name:      site.name,
        comune:    site.comune,
        address:   site.address,
        timestamp: site.timestamp,
        note:      site.note
      }
    }))
  };

  const blob     = new Blob([JSON.stringify(geojson, null, 2)], { type: 'application/geo+json' });
  const url      = URL.createObjectURL(blob);
  const a        = document.createElement('a');
  a.href         = url;
  a.download     = `ecomonitor_siti_${new Date().toISOString().slice(0,10)}.geojson`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);

  showToast(`📥 GeoJSON esportato (${state.sites.length} siti).`, 'success');
}

// ================================================================
// 11. UI HELPERS
// ================================================================

/**
 * Apre/chiude la sidebar off-canvas.
 */
function toggleSidebar() {
  const sidebar  = document.getElementById('sidebar');
  const overlay  = document.getElementById('sidebarOverlay');
  const isOpen   = sidebar.classList.contains('open');

  sidebar.classList.toggle('open', !isOpen);
  overlay.classList.toggle('active', !isOpen);
}

/**
 * Mostra/nasconde lo spinner di caricamento.
 * @param {boolean} show
 */
function showSpinner(show) {
  document.getElementById('spinner').classList.toggle('active', show);
}

/**
 * Mostra una notifica toast temporanea.
 * @param {string}  message
 * @param {string}  type - 'success' | 'error' | 'info'
 * @param {number}  duration - ms (default 3000)
 */
function showToast(message, type = 'info', duration = 3000) {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.className   = `toast ${type} show`;

  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => {
    toast.classList.remove('show');
  }, duration);
}

// ================================================================
// 12. REGISTRAZIONE SERVICE WORKER (PWA)
// ================================================================

/**
 * Registra il Service Worker per abilitare le funzionalità PWA.
 * Gestisce gli aggiornamenti disponibili notificando l'utente.
 */
async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) {
    console.warn('[PWA] Service Worker non supportato.');
    return;
  }

  try {
    const reg = await navigator.serviceWorker.register('./sw.js', { scope: './' });
    console.log('[PWA] Service Worker registrato:', reg.scope);

    // Notifica aggiornamento disponibile
    reg.addEventListener('updatefound', () => {
      const newWorker = reg.installing;
      newWorker.addEventListener('statechange', () => {
        if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
          showToast('🔄 Aggiornamento disponibile. Ricarica la pagina.', 'info', 6000);
        }
      });
    });

  } catch (err) {
    console.error('[PWA] Registrazione SW fallita:', err);
  }
}

// ================================================================
// 13. KEYBOARD SHORTCUTS
// ================================================================

document.addEventListener('keydown', (e) => {
  // ESC: disattiva modalità marker / chiudi sidebar
  if (e.key === 'Escape') {
    if (state.addMarkerMode) {
      state.addMarkerMode = false;
      document.getElementById('addMarkerBtn').classList.remove('active');
      state.map.getContainer().style.cursor = '';
    }
    const sidebar = document.getElementById('sidebar');
    if (sidebar.classList.contains('open')) toggleSidebar();
  }

  // Enter nella barra di ricerca
  if (e.key === 'Enter' && document.activeElement.id === 'searchInput') {
    searchComune();
  }
});

// ================================================================
// 14. BOOTSTRAP — AVVIO APPLICAZIONE
// ================================================================

document.addEventListener('DOMContentLoaded', () => {
  initMap();
  registerServiceWorker();
});

