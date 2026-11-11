/* ==========================================================================
   Visor de incendios forestales — Colombia
   Lógica de la aplicación: mapa, capas, año, búsqueda con debounce,
   GPS, NASA FIRMS, QR, toasts, checklist persistente y exportaciones
   independientes de mapa e informe (solo capas activas).
   ========================================================================== */
(function () {
  "use strict";

  /* ----------------------------- Utilidades ----------------------------- */
  // Los datos se cargan de forma síncrona desde "data.js" (window.DATOS),
  // conservando el comportamiento original del visor autocontenido.
  const D = window.DATOS || {};
  const META = D.meta || {};
  const RASTER = D.raster || {};
  // Documentos y planos servidos como archivos estáticos (rutas relativas,
  // compatibles con HTTPS de GitHub Pages).
  const ASSETS = {
    pdf: "ficha_tecnica.pdf",
    jpg: "vista_previa_nacional.jpg",
    igac: "mapa_igac_nacional.jpg",
  };

  // Leaflet intenta descargar sus PNG por defecto aunque todos los marcadores
  // usen divIcon. Se reemplaza el icono por defecto por un GIF transparente
  // para que nunca aparezca un pin negro sobre el mapa: el único pin visible
  // es el de la ubicación en tiempo real (geo-marker).
  if (window.L && L.Icon && L.Icon.Default) {
    const TRANSPARENT = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==";
    L.Icon.Default.mergeOptions({
      iconUrl: TRANSPARENT,
      iconRetinaUrl: TRANSPARENT,
      shadowUrl: TRANSPARENT,
      shadowSize: [1, 1],
      shadowAnchor: [0, 0],
    });
  }
  const ANIOS = Array.isArray(META.anios) && META.anios.length
    ? META.anios
    : [2012, 2026];
  const BOUNDS = Array.isArray(META.bounds)
    ? META.bounds
    : [[-4.5, -82], [13.6, -66.6]];

  const nf = new Intl.NumberFormat("es-CO");
  const fmt = (n) => nf.format(Number(n) || 0);

  function esc(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    }[c]));
  }

  function norm(value) {
    return String(value == null ? "" : value)
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  // Coincidencia por palabras: cada palabra de la consulta debe coincidir con
  // alguna palabra del registro. Se toleran plurales ("parques" ↔ "parque")
  // comparando prefijos, sin falsos positivos dentro de otras palabras.
  function tokenMatch(item, token) {
    if (!token) return true;
    if (/^\d+$/.test(token)) return item.search.indexOf(token) !== -1;
    const words = item.words || [];
    for (let i = 0; i < words.length; i++) {
      const word = words[i];
      if (word === token) return true;
      if (token.length >= 3 && word.indexOf(token) === 0) return true;
      if (word.length >= 4 && token.indexOf(word) === 0) return true;
    }
    return false;
  }

  const CAT_COLORS = {
    departamentos: "#e2e8f0",
    areas: "#a855f7",
    focos: "#ff3b30",
    quemadas: "#f97316",
  };
  const CAT_LABELS = {
    todas: "todas las categorías",
    departamentos: "departamentos",
    areas: "áreas protegidas",
    focos: "focos de calor",
    quemadas: "áreas quemadas",
  };
  const catColor = (cat) => CAT_COLORS[cat] || "#94a3b8";

  /* -------------------- Geolocalización, FIRMS e intensidad -------------- */
  const GEO_OPTS = {
    enableHighAccuracy: true,
    timeout: 15000,
    maximumAge: 4000,
  };
  const GEO_ERRORS = {
    1: "Permiso de ubicación denegado. Actívalo en el navegador para ver tu posición.",
    2: "Ubicación no disponible. Revisa el GPS o la conexión e inténtalo de nuevo.",
    3: "La búsqueda de ubicación tardó demasiado. Reintenta en unos segundos.",
  };
  const GEO_PIN_SVG =
    '<svg viewBox="0 0 34 46" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
      '<path fill="#111827" stroke="#e5e7eb" stroke-width="1.2" d="M17 1.4C8.8 1.4 2.2 8 2.2 16.2c0 10.9 14.8 28.4 14.8 28.4s14.8-17.5 14.8-28.4C31.8 8 25.2 1.4 17 1.4Z"/>' +
      '<circle cx="17" cy="16.2" r="6.1" fill="#ffffff"/>' +
      '<circle cx="17" cy="16.2" r="2.1" fill="#111827" opacity=".16"/>' +
    "</svg>";
  const FIRMS_API = "https://firms.modaps.eosdis.nasa.gov/api/area/csv/";
  const FIRMS_SOURCES = {
    VIIRS_SNPP_NRT: { label: "VIIRS SNPP" },
    VIIRS_NOAA20_NRT: { label: "VIIRS NOAA-20" },
    MODIS_NRT: { label: "MODIS" },
  };
  const GIBS_WMS_URL = "https://gibs.earthdata.nasa.gov/wms/epsg3857/best/wms.cgi";
  const GIBS_LAYER = "VIIRS_SNPP_Thermal_Anomalies_375m_All";
  const FIRMS_KEY_STORE = "visor_firms_key_v1";
  const FIRMS_URL_STORE = "visor_firms_url_v1";
  const QUEMADA_RADIO_KM = 2.5;
  const INTENSIDAD = [
    { key: "baja", label: "Baja", color: "#facc15", ring: "#fde68a", radius: 2.5 },
    { key: "media", label: "Media", color: "#f97316", ring: "#fdba74", radius: 3.2 },
    { key: "alta", label: "Alta", color: "#ef4444", ring: "#fca5a5", radius: 4 },
  ];
  const FIRMS_INTENSIDAD = [
    { key: "baja", label: "Baja · FRP < 10", color: "#facc15", ring: "#fde68a" },
    { key: "media", label: "Media · FRP 10–30", color: "#f97316", ring: "#fdba74" },
    { key: "alta", label: "Alta · FRP ≥ 30", color: "#ef4444", ring: "#fca5a5" },
  ];

  // Palabras vacías que no deben impedir una búsqueda ("La Guajira",
  // "Valle del Cauca", "Norte de Santander").
  const STOPWORDS = new Set([
    "la", "el", "los", "las", "de", "del", "y", "e", "en", "por", "para",
  ]);

  // FAO GAUL entrega los nombres sin tildes; se muestran con su grafía
  // oficial en español sin alterar los datos de búsqueda.
  const DEPTO_NAMES = {
    "Atlantico": "Atlántico",
    "Bolivar": "Bolívar",
    "Boyaca": "Boyacá",
    "Caqueta": "Caquetá",
    "Choco": "Chocó",
    "Cordoba": "Córdoba",
    "Guainia": "Guainía",
    "Guajira": "La Guajira",
    "Narino": "Nariño",
    "Norte De Santander": "Norte de Santander",
    "Quindio": "Quindío",
    "San Andres Y Providencia": "San Andrés y Providencia",
    "Valle Del Cauca": "Valle del Cauca",
    "Vaupes": "Vaupés",
  };
  const prettyDepto = (name) => DEPTO_NAMES[name] || name || "";

  // Abreviaturas cartográficas para las marcas de departamentos. Se dibujan
  // con divIcon (texto + CSS), sin imágenes externas que puedan romperse.
  const DEPTO_ABBR = {
    "Amazonas": "AMA", "Antioquia": "ANT", "Arauca": "ARA", "Atlantico": "ATL",
    "Bolivar": "BOL", "Boyaca": "BOY", "Caldas": "CAL", "Caqueta": "CAQ",
    "Casanare": "CAS", "Cauca": "CAU", "Cesar": "CES", "Choco": "CHO",
    "Cordoba": "COR", "Cundinamarca": "CUN", "Guainia": "GNA", "Guaviare": "GUV",
    "Huila": "HUI", "Guajira": "GJR", "Magdalena": "MAG", "Meta": "MET",
    "Narino": "NAR", "Norte De Santander": "NSA", "Putumayo": "PUT",
    "Quindio": "QUI", "Risaralda": "RIS", "San Andres Y Providencia": "SAP",
    "Santander": "SAN", "Sucre": "SUC", "Tolima": "TOL", "Valle Del Cauca": "VAC",
    "Vaupes": "VAU", "Vichada": "VIC", "Bogota D.C.": "BOG",
  };
  const deptoAbbr = (name) => DEPTO_ABBR[name] || String(name || "").slice(0, 3).toUpperCase();

  /* ------------------------------- Estado ------------------------------- */
  const yearDefault = META.anio_actual != null
    ? Number(META.anio_actual)
    : ANIOS[ANIOS.length - 1];

  const state = {
    year: yearDefault,
    category: "todas",
    query: "",
    bullets: false,
    modalTab: "pdf",
    studyTab: "integral",
    layers: {
      susceptibilidad: !!RASTER.susceptibilidad,
      focos: true,
      bosques: false,
      agua: false,
      areas: true,
      quemadas: true,
      deptos: true,
      ausencias: false,
    },
    geo: null,
    geoActive: false,
    firms: {
      active: false,
      wms: false,
      count: 0,
      label: "",
      niveles: [0, 0, 0],
      points: [],
    },
  };

  /* -------------------------------- DOM --------------------------------- */
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  const els = {
    sidebar: $("#sidebar"),
    sidebarBackdrop: $("#sidebarBackdrop"),
    statusTotal: $("#statusTotal"),
    yearRange: $("#yearRange"),
    yearValue: $("#yearValue"),
    yearPill: $("#yearPill"),
    yearScale: $("#yearScale"),
    yearChips: $("#yearChips"),
    yearPlay: $("#yearPlay"),
    statFocos: $("#statFocos"),
    statQuemadas: $("#statQuemadas"),
    statAreas: $("#statAreas"),
    mapTitleYear: $("#mapTitleYear"),
    yearBanner: $("#yearBanner"),
    layerList: $("#layerList"),
    layersAll: $("#layersAll"),
    layersNone: $("#layersNone"),
    searchBox: $("#searchBox"),
    searchInput: $("#searchInput"),
    searchClear: $("#searchClear"),
    categoryChips: $("#categoryChips"),
    resultCount: $("#resultCount"),
    searchMeta: $("#searchMeta"),
    results: $("#results"),

    reqList: $("#reqList"),
    reqProgress: $("#reqProgress"),
    reqBar: $("#reqBar"),
    reqReset: $("#reqReset"),
    openPdf: $("#openPdf"),
    openJpg: $("#openJpg"),
    map: $("#map"),
    btnMenu: $("#btnMenu"),
    btnBasemap: $("#btnBasemap"),
    btnReset: $("#btnReset"),
    btnFullscreen: $("#btnFullscreen"),
    btnGeo: $("#btnGeo"),
    geoPanel: $("#geoPanel"),
    geoState: $("#geoState"),
    geoClose: $("#geoClose"),
    geoCoords: $("#geoCoords"),
    geoAcc: $("#geoAcc"),
    geoTime: $("#geoTime"),
    geoNearestFoco: $("#geoNearestFoco"),
    geoNearestQuemada: $("#geoNearestQuemada"),
    geoFocoMeta: $("#geoFocoMeta"),
    geoQuemadaMeta: $("#geoQuemadaMeta"),
    geoFocoDist: $("#geoFocoDist"),
    geoQuemadaDist: $("#geoQuemadaDist"),
    geoCenter: $("#geoCenter"),
    geoStop: $("#geoStop"),
    firmsPill: $("#firmsPill"),
    firmsKey: $("#firmsKey"),
    firmsSource: $("#firmsSource"),
    firmsDays: $("#firmsDays"),
    firmsUrl: $("#firmsUrl"),
    firmsLoad: $("#firmsLoad"),
    firmsClear: $("#firmsClear"),
    firmsWms: $("#firmsWms"),
    firmsStatus: $("#firmsStatus"),
    btnQuickQr: $("#btnQuickQr"),
    quickQrCard: $("#quickQrCard"),
    quickQrClose: $("#quickQrClose"),
    quickQrCanvas: $("#quickQrCanvas"),
    quickQrCaption: $("#quickQrCaption"),
    quickQrCopy: $("#quickQrCopy"),
    quickQrDownload: $("#quickQrDownload"),
    legend: $("#legend"),
    legendBody: $("#legendBody"),
    legendClose: $("#legendClose"),
    mapEmpty: $("#mapEmpty"),
    btnActivate: $("#btnActivate"),
    btnDocsEmpty: $("#btnDocsEmpty"),
    clock: $("#clock"),
    modal: $("#modal"),
    modalBackdrop: $("#modalBackdrop"),
    modalClose: $("#modalClose"),
    modalClose2: $("#modalClose2"),
    modalTabs: $("#modalTabs"),
    modalTitle: $("#modalTitle"),
    modalSub: $("#modalSub"),
    pdfPane: $("#pdfPane"),
    jpgPane: $("#jpgPane"),
    pdfFrame: $("#pdfFrame"),
    jpgImg: $("#jpgImg"),
    downloadAsset: $("#downloadAsset"),
    toasts: $("#toasts"),
  };

  /* ---------------------------- Requisitos ------------------------------ */
  const REQ_KEY = "visor_incendios_req_v2";
  const REQ_ITEMS = [
    { id: "capas", title: "Activar y desactivar capas", desc: "Focos, bosques, agua, áreas, quemadas, departamentos y ausencias." },
    { id: "anio", title: "Filtrar por año (2012–2026)", desc: "Selector deslizante y atajos para focos y áreas quemadas." },
    { id: "categoria", title: "Buscar por categoría", desc: "Departamentos, áreas protegidas, focos y áreas quemadas." },
    { id: "vinetas", title: "Búsqueda con resultados", desc: "Lista numerada que centra el mapa en el elemento elegido, sin añadir pines." },
    { id: "docs", title: "Abrir la vista previa PDF/JPG", desc: "Modal con ficha técnica y mapa nacional descargables." },
    { id: "toasts", title: "Notificaciones de carga y éxito", desc: "Toasts flotantes para cada operación del visor." },
  ];

  let reqState = {};
  try {
    reqState = JSON.parse(localStorage.getItem(REQ_KEY) || "{}") || {};
  } catch (err) {
    reqState = {};
  }
  let reqCompleteShown = false;
  let muteReq = false;

  function saveReq() {
    try {
      localStorage.setItem(REQ_KEY, JSON.stringify(reqState));
    } catch (err) {
      /* almacenamiento no disponible: se conserva en memoria */
    }
  }

  function updateReqUI() {
    if (!els.reqList) return;
    const total = REQ_ITEMS.length;
    const done = REQ_ITEMS.filter((item) => reqState[item.id]).length;
    els.reqProgress.textContent = done + "/" + total;
    els.reqBar.style.width = (done / total) * 100 + "%";
    REQ_ITEMS.forEach((item) => {
      const li = els.reqList.querySelector('.req-item[data-id="' + item.id + '"]');
      if (!li) return;
      li.classList.toggle("done", !!reqState[item.id]);
      const cb = li.querySelector("input");
      if (cb) cb.checked = !!reqState[item.id];
    });
    updateIntegralChecklist();
  }

  function maybeComplete() {
    const total = REQ_ITEMS.length;
    const done = REQ_ITEMS.filter((item) => reqState[item.id]).length;
    if (done === total && !reqCompleteShown) {
      reqCompleteShown = true;
      Toast.success("¡Checklist completo!", "Todos los requisitos del visor están verificados.", "reqComplete");
    } else if (done < total) {
      reqCompleteShown = false;
    }
  }

  function checkReq(id) {
    if (reqState[id]) return;
    reqState[id] = true;
    saveReq();
    updateReqUI();
    maybeComplete();
  }

  function setReq(id, value, manual) {
    reqState[id] = !!value;
    saveReq();
    updateReqUI();
    if (manual) {
      const item = REQ_ITEMS.find((i) => i.id === id);
      muteReq = true;
      if (value) {
        Toast.success("Requisito completado", item ? item.title : "", "reqItem");
      } else {
        Toast.info("Requisito desmarcado", item ? item.title : "", "reqItem");
      }
      muteReq = false;
      queueSync("checklist", { id: id, done: !!value });
    }
    maybeComplete();
  }

  function buildReqList() {
    if (!els.reqList) return;
    els.reqList.innerHTML = REQ_ITEMS.map((item) => (
      '<li class="req-item" data-id="' + item.id + '">' +
        '<label class="req-check">' +
          '<input type="checkbox" data-req="' + item.id + '"' +
            (reqState[item.id] ? " checked" : "") + ">" +
          "<span>✓</span>" +
        "</label>" +
        '<span class="req-text"><strong>' + esc(item.title) + "</strong>" +
          "<small>" + esc(item.desc) + "</small></span>" +
      "</li>"
    )).join("");
    els.reqList.addEventListener("change", (event) => {
      const cb = event.target.closest("input[data-req]");
      if (!cb) return;
      setReq(cb.dataset.req, cb.checked, true);
    });
  }

  /* ------------------------------- Toasts ------------------------------- */
  const Toast = (function () {
    const root = els.toasts;
    const timers = new Map();
    const icons = {
      success: "✓",
      error: "!",
      warning: "!",
      info: "i",
      loading: '<span class="spinner"></span>',
    };

    function arm(el, duration) {
      const previous = timers.get(el);
      if (previous) clearTimeout(previous);
      timers.delete(el);
      const bar = el.querySelector(".toast-progress");
      if (bar) {
        bar.style.animation = "none";
        void bar.offsetWidth;
        bar.style.animation = "";
        bar.style.animationDuration = duration > 0 ? duration + "ms" : "0ms";
      }
      if (duration > 0) {
        const timer = setTimeout(() => dismiss(el), duration);
        timers.set(el, timer);
      }
    }

    function update(options) {
      const el = document.getElementById("toast-" + options.id);
      if (!el) return show(options);
      const type = options.type || "info";
      el.className = "toast toast-" + type;
      el.querySelector(".toast-icon").innerHTML = icons[type] || icons.info;
      el.querySelector(".toast-content").innerHTML =
        "<strong>" + esc(options.title || "") + "</strong>" +
        (options.message ? "<span>" + esc(options.message) + "</span>" : "");
      const close = el.querySelector(".toast-close");
      if (close) close.addEventListener("click", () => dismiss(el));
      el.classList.remove("hide");
      el.classList.add("show");
      arm(el, options.duration == null ? 4200 : options.duration);
      return el;
    }

    function dismiss(el, immediate) {
      if (!el || !el.isConnected) return;
      const timer = timers.get(el);
      if (timer) clearTimeout(timer);
      timers.delete(el);
      el.classList.remove("show");
      el.classList.add("hide");
      if (immediate) el.remove();
      else setTimeout(() => el.remove(), 300);
    }

    function show(options) {
      const opts = Object.assign(
        { type: "info", title: "", message: "", duration: 4200 },
        options || {}
      );
      if (opts.id) {
        const existing = document.getElementById("toast-" + opts.id);
        if (existing) return update(opts);
      }
      const el = document.createElement("div");
      el.className = "toast toast-" + opts.type;
      if (opts.id) el.id = "toast-" + opts.id;
      el.innerHTML =
        '<div class="toast-icon">' + (icons[opts.type] || icons.info) + "</div>" +
        '<div class="toast-content"><strong>' + esc(opts.title) + "</strong>" +
          (opts.message ? "<span>" + esc(opts.message) + "</span>" : "") +
        "</div>" +
        '<button type="button" class="toast-close" aria-label="Cerrar notificación">×</button>' +
        '<div class="toast-progress"></div>';
      el.querySelector(".toast-close").addEventListener("click", () => dismiss(el));
      root.appendChild(el);
      requestAnimationFrame(() => el.classList.add("show"));
      arm(el, opts.duration);
      while (root.children.length > 4) dismiss(root.firstElementChild, true);
      if (!muteReq) checkReq("toasts");
      return el;
    }

    return {
      show: show,
      update: function (id, options) {
        return update(Object.assign({ id: id }, options || {}));
      },
      loading: function (title, message, id) {
        return show({ type: "loading", title: title, message: message, duration: 0, id: id || "loading" });
      },
      success: function (title, message, id) {
        return show({ type: "success", title: title, message: message, duration: 3800, id: id });
      },
      info: function (title, message, id) {
        return show({ type: "info", title: title, message: message, duration: 3400, id: id });
      },
      warning: function (title, message, id) {
        return show({ type: "warning", title: title, message: message, duration: 4300, id: id });
      },
      error: function (title, message, id) {
        return show({ type: "error", title: title, message: message, duration: 5200, id: id });
      },
      dismiss: function (id) {
        const el = document.getElementById("toast-" + id);
        if (el) dismiss(el);
      },
    };
  })();

  /* --------------------------- Capas y mapa ----------------------------- */
  const LAYERS = [
    {
      id: "susceptibilidad",
      name: "Susceptibilidad",
      desc: "Riesgo por departamento · análisis de focos",
      color: "#ff5a3c",
      kind: "riesgo",
      available: true,
    },
    { id: "focos", name: "Focos de calor", desc: "MODIS + VIIRS · por año", color: "#ff3b30", kind: "focos", available: true },
    { id: "bosques", name: "Bosques", desc: "ESA WorldCover · referencia", color: "#2e9e4f", kind: "raster", available: !!RASTER.bosque },
    { id: "agua", name: "Fuentes hídricas", desc: "JRC Surface Water", color: "#3b82f6", kind: "raster", available: !!RASTER.agua },
    { id: "areas", name: "Áreas protegidas", desc: "WDPA · " + fmt((D.areas_puntos || []).length) + " áreas", color: "#a855f7", kind: "areas", available: true },
    { id: "quemadas", name: "Áreas quemadas", desc: "MCD64A1 · por año", color: "#f97316", kind: "quemadas", available: true },
    { id: "deptos", name: "Departamentos", desc: "FAO GAUL · " + fmt((D.departamentos_puntos || []).length), color: "#e2e8f0", kind: "deptos", available: true },
  ];

  let map = null;
  let sat = null;
  let osm = null;
  let basemap = "sat";
  let searchTimer = null;
  let yearTimer = null;
  let yearPlayTimer = null;
  let lastResults = [];

  const groups = {};
  const searchGroup = L.featureGroup();
  const highlightGroup = L.featureGroup();
  const geoGroup = L.featureGroup();
  const proximityGroup = L.featureGroup();
  let geoWatchId = null;
  let geoMarker = null;
  let geoAccuracy = null;
  let activePopup = null;
  let firmsAbort = null;

  function makeRaster(b64, opacity) {
    if (!b64) return null;
    return L.imageOverlay("data:image/png;base64," + b64, BOUNDS, {
      opacity: opacity,
      interactive: false,
      className: "raster-layer",
    });
  }

  function initMap() {
    map = L.map("map", {
      zoomControl: false,
      preferCanvas: true,
      minZoom: 3,
      maxZoom: 14,
      zoomSnap: 0.25,
      wheelPxPerZoomLevel: 90,
      attributionControl: true,
    });
    map.attributionControl.setPrefix("Leaflet");

    sat = L.tileLayer(
      "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
      {
        maxZoom: 17,
        attribution: "Imágenes © Esri, Maxar, Earthstar Geographics",
      }
    ).addTo(map);

    osm = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: "© OpenStreetMap",
    });

    L.control.zoom({ position: "bottomright" }).addTo(map);
    L.control.scale({ imperial: false, position: "bottomleft" }).addTo(map);
    map.fitBounds(BOUNDS, { padding: [26, 26], animate: false });

    groups.deptos = L.layerGroup();
    groups.areas = L.layerGroup();
    groups.focos = L.layerGroup();
    groups.quemadas = L.layerGroup();
    groups.bosques = makeRaster(RASTER.bosque, 0.62);
    groups.agua = makeRaster(RASTER.agua, 0.78);
    groups.susceptibilidad = L.layerGroup();
    groups.firms = L.layerGroup();
    groups.firmsWms = L.tileLayer.wms(GIBS_WMS_URL, {
      layers: GIBS_LAYER,
      format: "image/png",
      transparent: true,
      version: "1.3.0",
      opacity: 0.85,
      attribution: "NASA GIBS · VIIRS Thermal Anomalies",
      className: "firms-wms",
    });

    ["deptos", "areas", "focos", "quemadas"].forEach((id) => {
      if (groups[id]) groups[id].addTo(map);
    });
    searchGroup.addTo(map);
    highlightGroup.addTo(map);
    geoGroup.addTo(map);
    proximityGroup.addTo(map);

    map.on("popupclose", () => {
      activePopup = null;
    });

    LAYERS.forEach((layer) => {
      const group = groups[layer.id];
      if (!group) return;
      if (state.layers[layer.id]) {
        if (!map.hasLayer(group)) group.addTo(map);
      } else if (map.hasLayer(group)) {
        map.removeLayer(group);
      }
    });
  }

  function popupContent(content) {
    return typeof content === "function" ? content() : content;
  }

  function bindClickPopup(marker, latlng, content, meta) {
    marker.on("click", () => {
      activePopup = { latlng: latlng, content: content, meta: meta || null };
      L.popup({ className: "custom-popup", maxWidth: 330, offset: [0, -4] })
        .setLatLng(latlng)
        .setContent(popupContent(content))
        .openOn(map);
    });
  }

  /* ----------------------- Distancias en tiempo real -------------------- */
  const POLY_CACHE = new WeakMap();

  function haversineKm(lat1, lon1, lat2, lon2) {
    const R = 6371.0088;
    const toRad = Math.PI / 180;
    const dLat = (lat2 - lat1) * toRad;
    const dLon = (lon2 - lon1) * toRad;
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) *
        Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  function fmtDist(km) {
    if (!isFinite(km)) return "—";
    if (km < 1) return Math.round(km * 1000) + " m";
    return new Intl.NumberFormat("es-CO", {
      minimumFractionDigits: km < 10 ? 1 : 0,
      maximumFractionDigits: km < 10 ? 1 : 0,
    }).format(km) + " km";
  }

  function poligonoQuemada(q) {
    if (POLY_CACHE.has(q)) return POLY_CACHE.get(q);
    const dLat = QUEMADA_RADIO_KM / 110.57;
    const cos = Math.cos((Number(q.lat) * Math.PI) / 180) || 1;
    const dLon = QUEMADA_RADIO_KM / (111.32 * cos);
    const pts = [];
    for (let i = 0; i < 8; i++) {
      const a = (Math.PI / 4) * i + Math.PI / 8;
      pts.push([
        Number(q.lat) + dLat * Math.sin(a),
        Number(q.lon) + dLon * Math.cos(a),
      ]);
    }
    POLY_CACHE.set(q, pts);
    return pts;
  }

  function distSeg(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const den = dx * dx + dy * dy;
    const t = den
      ? Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / den))
      : 0;
    return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
  }

  // Distancia al borde del polígono; 0 si el usuario está dentro.
  function distanciaPuntoPoligonoKm(lat, lon, poly) {
    const kx = 111.32 * Math.cos((lat * Math.PI) / 180);
    const ky = 110.57;
    const pts = poly.map((p) => [(p[1] - lon) * kx, (p[0] - lat) * ky]);
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const xi = pts[i][0];
      const yi = pts[i][1];
      const xj = pts[j][0];
      const yj = pts[j][1];
      if ((yi > 0) !== (yj > 0) && 0 < ((xj - xi) * (0 - yi)) / (yj - yi) + xi) {
        inside = !inside;
      }
    }
    if (inside) return 0;
    let best = Infinity;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      best = Math.min(best, distSeg(0, 0, pts[j][0], pts[j][1], pts[i][0], pts[i][1]));
    }
    return best;
  }

  function distanciaFocoKm(p) {
    if (!state.geo) return null;
    return haversineKm(state.geo.lat, state.geo.lon, Number(p.lat), Number(p.lon));
  }

  function distanciaQuemadaKm(q) {
    if (!state.geo) return null;
    return distanciaPuntoPoligonoKm(state.geo.lat, state.geo.lon, poligonoQuemada(q));
  }

  function distanciaHTML(km, etiqueta) {
    if (km == null) {
      return '<span class="dist muted">Activa el GPS para ver la distancia</span>';
    }
    return '<span class="dist"><b>' + fmtDist(km) + "</b> " + esc(etiqueta) + "</span>";
  }

  function distanciaQuemadaHTML(km) {
    if (km == null) {
      return '<span class="dist muted">Activa el GPS para ver la distancia</span>';
    }
    if (km <= 0.001) {
      return '<span class="dist inside">Estás dentro de esta área quemada</span>';
    }
    return '<span class="dist"><b>' + fmtDist(km) + "</b> al borde del área quemada</span>";
  }

  function popupDepto(d) {
    return (
      '<div class="popup"><span class="tag">Departamento</span>' +
      "<strong>" + esc(prettyDepto(d.nombre)) + "</strong>" +
      "<span>Código " + esc(d.codigo || "—") + "</span>" +
      (d.lat != null
        ? '<span class="coords">' + Number(d.lat).toFixed(3) + ", " + Number(d.lon).toFixed(3) + "</span>"
        : "") +
      "</div>"
    );
  }

  function popupArea(a) {
    const meta = [a.designacion, a.iucn].filter(Boolean).join(" · ");
    return (
      '<div class="popup"><span class="tag">Área protegida</span>' +
      "<strong>" + esc(a.nombre) + "</strong>" +
      (meta ? "<span>" + esc(meta) + "</span>" : "") +
      "<span>" + esc(prettyDepto(a.depto) || "Sin departamento") + "</span>" +
      "<span>" + fmt(a.area_ha) + " ha" + (a.anio ? " · desde " + esc(a.anio) : "") + "</span>" +
      (a.lat != null
        ? '<span class="coords">' + Number(a.lat).toFixed(3) + ", " + Number(a.lon).toFixed(3) + "</span>"
        : "") +
      "</div>"
    );
  }

  // Enlace universal a Google Maps para trazar la ruta de conducción más rápida
  // desde la ubicación del usuario (si el GPS está activo) hasta el punto dado.
  function botonRutaGoogle(p) {
    const destino = Number(p.lat) + "," + Number(p.lon);
    if (state.geoActive && state.geo && state.geo.lat != null) {
      const origen = state.geo.lat + "," + state.geo.lon;
      return '<a class="popup-btn route" target="_blank" rel="noopener" ' +
        'href="https://www.google.com/maps/dir/?api=1&origin=' + encodeURIComponent(origen) +
        '&destination=' + encodeURIComponent(destino) + '&travelmode=driving">' +
        "🚗 Trazar ruta más rápida en Google Maps</a>";
    }
    return '<a class="popup-btn route" target="_blank" rel="noopener" ' +
      'href="https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(destino) + '">' +
      "📍 Ver en Google Maps</a>";
  }

  function popupFoco(p, nivel) {
    const lv = INTENSIDAD[nivel == null ? 1 : nivel] || INTENSIDAD[1];
    return function () {
      return (
        '<div class="popup"><span class="tag">Foco de calor</span>' +
        "<strong>" + esc(p.anio) + "</strong>" +
        "<span>" + esc(prettyDepto(p.depto) || "Sin departamento") + "</span>" +
        '<span style="color:' + lv.color + '">● Intensidad relativa ' + esc(lv.label) + "</span>" +
        distanciaHTML(distanciaFocoKm(p), "desde tu ubicación") +
        '<span class="coords">' + Number(p.lat).toFixed(3) + ", " + Number(p.lon).toFixed(3) + "</span>" +
        botonRutaGoogle(p) +
        "</div>"
      );
    };
  }

  function tooltipFoco(p, nivel) {
    const lv = INTENSIDAD[nivel == null ? 1 : nivel] || INTENSIDAD[1];
    return function () {
      const km = distanciaFocoKm(p);
      return "Foco " + esc(p.anio) + " · " + esc(lv.label) +
        (km == null ? "" : ' · <span class="tt-dist">' + fmtDist(km) + "</span>");
    };
  }

  function popupQuemada(q) {
    return function () {
      return (
        '<div class="popup"><span class="tag">Área quemada</span>' +
        "<strong>" + esc(q.anio) + "</strong>" +
        "<span>" + esc(prettyDepto(q.depto) || "Sin departamento") + "</span>" +
        "<span>Día juliano " + esc(q.doy || "—") + " · polígono ~" + QUEMADA_RADIO_KM + " km</span>" +
        distanciaQuemadaHTML(distanciaQuemadaKm(q)) +
        '<span class="coords">' + Number(q.lat).toFixed(3) + ", " + Number(q.lon).toFixed(3) + "</span>" +
        botonRutaGoogle(q) +
        "</div>"
      );
    };
  }

  function tooltipQuemada(q) {
    return function () {
      const km = distanciaQuemadaKm(q);
      return "Área quemada " + esc(q.anio) +
        (km == null ? "" : ' · <span class="tt-dist">' +
          (km <= 0.001 ? "estás dentro" : fmtDist(km)) + "</span>");
    };
  }

  function popupAusencia(a) {
    return (
      '<div class="popup"><span class="tag">Pseudo-ausencia</span>' +
      "<strong>Punto de entrenamiento</strong>" +
      "<span>" + esc(prettyDepto(a.depto) || "Sin departamento") + "</span>" +
      '<span class="coords">' + Number(a.lat).toFixed(3) + ", " + Number(a.lon).toFixed(3) + "</span>" +
      "</div>"
    );
  }

  // Los GeoJSON de GAUL/WDPA incluyen islotes y vértices sueltos como
  // geometrías Point dentro de GeometryCollection. Leaflet los convertiría en
  // marcadores con el icono por defecto (las viñetas negras). Se eliminan antes
  // de dibujar para que el mapa solo muestre polígonos y líneas.
  function sinPuntos(fc) {
    if (!fc || !Array.isArray(fc.features)) return fc;
    const limpiar = function (geom) {
      if (!geom) return null;
      if (geom.type === "Point" || geom.type === "MultiPoint") return null;
      if (geom.type === "GeometryCollection") {
        const partes = (geom.geometries || []).map(limpiar).filter(Boolean);
        return partes.length ? { type: "GeometryCollection", geometries: partes } : null;
      }
      return geom;
    };
    return {
      type: "FeatureCollection",
      features: fc.features
        .map(function (f) {
          const g = limpiar(f.geometry);
          return g ? { type: "Feature", properties: f.properties || {}, geometry: g } : null;
        })
        .filter(Boolean),
    };
  }

  // Nombres de departamentos que sí tienen polígono en el GeoJSON. Excluye
  // unidades sueltas de GAUL (por ejemplo, un Point aislado) para no rotular
  // como departamento lo que no se dibuja como territorio.
  function deptosConPoligono() {
    const set = new Set();
    ((D.departamentos && D.departamentos.features) || []).forEach(function (f) {
      if (f.geometry && f.geometry.type !== "Point") {
        set.add((f.properties || {}).nombre);
      }
    });
    return set;
  }

  function renderDeptos() {
    const group = groups.deptos;
    if (!group) return;
    group.clearLayers();
    if (D.departamentos) {
      L.geoJSON(sinPuntos(D.departamentos), {
        style: {
          color: "#dbe4f0",
          weight: 1,
          opacity: 0.55,
          fillColor: "#dbe4f0",
          fillOpacity: 0.02,
        },
        // Red de seguridad: si quedara algún Point, no se dibuja como pin.
        pointToLayer: function (latlng) {
          return L.circleMarker(latlng, { radius: 0, opacity: 0, fillOpacity: 0, interactive: false });
        },
        onEachFeature: function (feature, layer) {
          const p = feature.properties || {};
          layer.bindTooltip(prettyDepto(p.nombre) || "", { sticky: true, className: "map-tooltip" });
          layer.bindPopup(popupDepto(p), { className: "custom-popup", maxWidth: 300 });
        },
      }).addTo(group);
    }
    // Nombres de los departamentos visibles sobre el mapa: solo texto, sin
    // viñetas ni pines. Se ocultan al desactivar la capa de departamentos.
    const conPoligono = deptosConPoligono();
    (D.departamentos_puntos || []).forEach(function (d) {
      if (conPoligono.size && !conPoligono.has(d.nombre)) return;
      L.tooltip({
        permanent: true,
        direction: "center",
        className: "dept-label",
        interactive: false,
        opacity: 1,
      })
        .setLatLng([d.lat, d.lon])
        .setContent(esc(prettyDepto(d.nombre)))
        .addTo(group);
    });
    // Los departamentos se representan únicamente con sus límites
    // (polígonos) y nombres. No se dibujan viñetas ni pines sobre el mapa.
  }

  function renderAreas() {
    const group = groups.areas;
    if (!group) return;
    group.clearLayers();
    // Las áreas protegidas se representan únicamente con sus polígonos
    // morados. Los centroides de D.areas_puntos se conservan para búsqueda,
    // conteos y reportes, pero no se dibujan como viñetas en el mapa.
    if (D.areas_protegidas) {
      L.geoJSON(sinPuntos(D.areas_protegidas), {
        style: {
          color: "#7c3aed",
          weight: 1.6,
          opacity: 0.92,
          fillColor: "#a855f7",
          fillOpacity: 0.16,
        },
        // Red de seguridad: las áreas se dibujan solo como polígonos morados.
        pointToLayer: function (latlng) {
          return L.circleMarker(latlng, { radius: 0, opacity: 0, fillOpacity: 0, interactive: false });
        },
        onEachFeature: function (feature, layer) {
          const p = feature.properties || {};
          layer.bindTooltip(prettyDepto(p.nombre) || "", { sticky: true, className: "map-tooltip" });
          layer.bindPopup(popupArea(p), { className: "custom-popup", maxWidth: 320 });
        },
      }).addTo(group);
    }
  }

  /* --------------------- Intensidad relativa de focos ------------------- */
  const INTENSIDAD_CACHE = new Map();
  const DENSIDAD_CELDA = 0.25;
  const DENSIDAD_RADIO_KM = 25;

  // Terciles de concentración de focos en 25 km. No es FRP: los datos
  // históricos no traen brillo ni confianza, así que la intensidad es
  // relativa a la densidad del propio año.
  function nivelesDensidad(lista) {
    const n = lista.length;
    if (!n) return [];
    const grid = new Map();
    lista.forEach((p, i) => {
      const key =
        Math.round(p.lat / DENSIDAD_CELDA) + ":" +
        Math.round(p.lon / DENSIDAD_CELDA);
      if (!grid.has(key)) grid.set(key, []);
      grid.get(key).push(i);
    });
    const counts = new Array(n);
    for (let i = 0; i < n; i++) {
      const p = lista[i];
      const ky = Math.round(p.lat / DENSIDAD_CELDA);
      const kx = Math.round(p.lon / DENSIDAD_CELDA);
      let c = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const vecinos = grid.get(ky + dy + ":" + (kx + dx));
          if (!vecinos) continue;
          for (let k = 0; k < vecinos.length; k++) {
            const j = vecinos[k];
            if (j === i) continue;
            const q = lista[j];
            if (haversineKm(p.lat, p.lon, q.lat, q.lon) <= DENSIDAD_RADIO_KM) c++;
          }
        }
      }
      counts[i] = c;
    }
    const orden = counts.slice().sort((a, b) => a - b);
    const q1 = orden[Math.floor((n - 1) / 3)];
    const q2 = orden[Math.floor((2 * (n - 1)) / 3)];
    return counts.map((c) => (c >= q2 ? 2 : c >= q1 ? 1 : 0));
  }

  function intensidadFocos(anio) {
    const key = anio == null ? "todos" : String(anio);
    if (INTENSIDAD_CACHE.has(key)) return INTENSIDAD_CACHE.get(key);
    const focos = focosDeAnio(anio);
    const niveles = new Array(focos.length);
    if (anio == null) {
      const porAnio = new Map();
      focos.forEach((p, i) => {
        if (!porAnio.has(p.anio)) porAnio.set(p.anio, []);
        porAnio.get(p.anio).push(i);
      });
      porAnio.forEach((indices) => {
        const lista = indices.map((i) => focos[i]);
        const lv = nivelesDensidad(lista);
        indices.forEach((idx, k) => {
          niveles[idx] = lv[k];
        });
      });
    } else {
      const lv = nivelesDensidad(focos);
      lv.forEach((v, i) => {
        niveles[i] = v;
      });
    }
    INTENSIDAD_CACHE.set(key, niveles);
    return niveles;
  }

  function renderYearLayers() {
    const year = state.year;
    const focos = focosDeAnio(year);
    const quemadas = quemadasDeAnio(year);
    const niveles = intensidadFocos(year);

    const gf = groups.focos;
    const gq = groups.quemadas;
    if (gf) gf.clearLayers();
    if (gq) gq.clearLayers();

    if (gf) {
      focos.forEach((p, i) => {
        const lv = INTENSIDAD[niveles[i]] || INTENSIDAD[1];
        const marker = L.circleMarker([p.lat, p.lon], {
          radius: lv.radius,
          color: lv.ring,
          weight: 0.5,
          fillColor: lv.color,
          fillOpacity: 0.9,
          bubblingMouseEvents: false,
        });
        marker.bindTooltip(tooltipFoco(p, niveles[i]), {
          sticky: true,
          className: "map-tooltip",
          direction: "top",
          offset: [0, -2],
        });
        bindClickPopup(marker, [p.lat, p.lon], popupFoco(p, niveles[i]), {
          tipo: "foco",
          item: p,
        });
        marker.addTo(gf);
      });
    }
    if (gq) {
      quemadas.forEach((q) => {
        const shape = L.polygon(poligonoQuemada(q), {
          color: "#f97316",
          weight: 1.1,
          opacity: 0.9,
          fillColor: "#fb923c",
          fillOpacity: 0.16,
          smoothFactor: 1,
          bubblingMouseEvents: false,
        });
        shape.bindTooltip(tooltipQuemada(q), {
          sticky: true,
          className: "map-tooltip",
          direction: "top",
        });
        bindClickPopup(shape, [q.lat, q.lon], popupQuemada(q), {
          tipo: "quemada",
          item: q,
        });
        shape.addTo(gq);
      });
    }
    actualizarProximidad();
    return { focos: focos.length, quemadas: quemadas.length };
  }

  /* ------------------------ Geolocalización en vivo --------------------- */
  function ensureGeoMarker() {
    if (geoMarker) return;
    const icon = L.divIcon({
      className: "geo-marker",
      html:
        '<span class="geo-marker-inner"><span class="geo-halo"></span>' +
        GEO_PIN_SVG +
        "</span>",
      iconSize: [34, 46],
      iconAnchor: [17, 46],
    });
    geoMarker = L.marker([0, 0], {
      icon: icon,
      keyboard: false,
      zIndexOffset: 1200,
      riseOnHover: true,
    });
    geoMarker.bindTooltip("Tu ubicación", {
      direction: "top",
      offset: [0, -46],
      className: "map-tooltip",
    });
    geoMarker.addTo(geoGroup);
  }

  function horaCorta(ts) {
    try {
      return new Date(ts).toLocaleTimeString("es-CO", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
    } catch (err) {
      return "—";
    }
  }

  function nearestFoco() {
    if (!state.geo) return null;
    const focos = focosDeAnio(state.year);
    const niveles = intensidadFocos(state.year);
    let best = null;
    let bestD = Infinity;
    for (let i = 0; i < focos.length; i++) {
      const p = focos[i];
      const d = haversineKm(state.geo.lat, state.geo.lon, Number(p.lat), Number(p.lon));
      if (d < bestD) {
        bestD = d;
        best = { item: p, nivel: niveles[i], km: d };
      }
    }
    return best;
  }

  function nearestQuemada() {
    if (!state.geo) return null;
    const quemadas = quemadasDeAnio(state.year);
    let best = null;
    let bestD = Infinity;
    for (let i = 0; i < quemadas.length; i++) {
      const q = quemadas[i];
      const d = distanciaPuntoPoligonoKm(state.geo.lat, state.geo.lon, poligonoQuemada(q));
      if (d < bestD) {
        bestD = d;
        best = { item: q, km: d };
      }
    }
    return best;
  }

  function actualizarPopupAbierto() {
    if (!activePopup || !map || !map._popup) return;
    map._popup.setContent(popupContent(activePopup.content));
  }

  function actualizarLineasProximidad(nf, nq) {
    proximityGroup.clearLayers();
    if (!state.geo) return;
    const origen = [state.geo.lat, state.geo.lon];
    function linea(destino, color, etiqueta) {
      L.polyline([origen, destino], {
        color: color,
        weight: 1.4,
        opacity: 0.85,
        dashArray: "5 6",
        interactive: false,
      }).addTo(proximityGroup);
      const mid = [(origen[0] + destino[0]) / 2, (origen[1] + destino[1]) / 2];
      L.marker(mid, {
        icon: L.divIcon({
          className: "dist-label",
          html:
            '<span style="border-color:' + color + '66;color:' + color + '">' +
            esc(etiqueta) +
            "</span>",
          iconSize: [0, 0],
        }),
        interactive: false,
        keyboard: false,
      }).addTo(proximityGroup);
    }
    if (nf) {
      linea([nf.item.lat, nf.item.lon], "#f87171", fmtDist(nf.km) + " al foco");
    }
    if (nq) {
      linea(
        [nq.item.lat, nq.item.lon],
        "#fb923c",
        nq.km <= 0.001 ? "Dentro del área" : fmtDist(nq.km) + " al área"
      );
    }
  }

  function actualizarProximidad() {
    if (!els.geoCoords) return;
    if (!state.geo) {
      proximityGroup.clearLayers();
      els.geoCoords.textContent = "Buscando señal GPS…";
      els.geoAcc.textContent = "—";
      els.geoTime.textContent = "—";
      els.geoFocoMeta.textContent = "—";
      els.geoQuemadaMeta.textContent = "—";
      els.geoFocoDist.textContent = "—";
      els.geoQuemadaDist.textContent = "—";
      return;
    }
    const nf = nearestFoco();
    const nq = nearestQuemada();
    els.geoCoords.textContent =
      state.geo.lat.toFixed(5) + ", " + state.geo.lon.toFixed(5);
    els.geoAcc.textContent = state.geo.accuracy
      ? "±" + Math.round(state.geo.accuracy) + " m"
      : "—";
    els.geoTime.textContent = horaCorta(state.geo.ts);
    if (nf) {
      const lv = INTENSIDAD[nf.nivel] || INTENSIDAD[1];
      els.geoFocoMeta.textContent =
        (prettyDepto(nf.item.depto) || "Sin depto.") + " · " +
        nf.item.anio + " · " + lv.label;
      els.geoFocoDist.textContent = fmtDist(nf.km);
    } else {
      els.geoFocoMeta.textContent = "Sin focos este año";
      els.geoFocoDist.textContent = "—";
    }
    if (nq) {
      els.geoQuemadaMeta.textContent =
        (prettyDepto(nq.item.depto) || "Sin depto.") + " · " + nq.item.anio;
      els.geoQuemadaDist.textContent = nq.km <= 0.001 ? "Dentro" : fmtDist(nq.km);
    } else {
      els.geoQuemadaMeta.textContent = "Sin áreas este año";
      els.geoQuemadaDist.textContent = "—";
    }
    actualizarLineasProximidad(nf, nq);
    actualizarPopupAbierto();
  }

  function onGeoSuccess(pos) {
    const c = pos.coords;
    const first = !state.geo;
    state.geo = {
      lat: c.latitude,
      lon: c.longitude,
      accuracy: c.accuracy || 0,
      ts: Date.now(),
    };
    state.geoActive = true;
    ensureGeoMarker();
    geoMarker.setLatLng([state.geo.lat, state.geo.lon]);
    if (!geoAccuracy) {
      geoAccuracy = L.circle([state.geo.lat, state.geo.lon], {
        radius: Math.max(30, state.geo.accuracy),
        color: "#60a5fa",
        weight: 1,
        opacity: 0.7,
        fillColor: "#3b82f6",
        fillOpacity: 0.08,
        interactive: false,
        className: "geo-accuracy",
      }).addTo(geoGroup);
    } else {
      geoAccuracy
        .setLatLng([state.geo.lat, state.geo.lon])
        .setRadius(Math.max(30, state.geo.accuracy));
    }
    els.btnGeo.classList.add("active");
    els.geoPanel.classList.remove("hidden", "error");
    els.geoState.textContent = "Ubicación en vivo";
    actualizarProximidad();
    if (first) {
      map.setView([state.geo.lat, state.geo.lon], Math.max(map.getZoom(), 12), {
        animate: true,
        duration: 0.8,
      });
    }
    updateLegend();
  }

  function onGeoError(err) {
    const code = err && err.code;
    const msg = GEO_ERRORS[code] || "No se pudo obtener tu ubicación.";
    state.geoActive = false;
    if (geoWatchId != null && navigator.geolocation) {
      navigator.geolocation.clearWatch(geoWatchId);
      geoWatchId = null;
    }
    els.btnGeo.classList.remove("active");
    els.geoPanel.classList.remove("hidden");
    els.geoPanel.classList.add("error");
    els.geoState.textContent = "Sin ubicación";
    els.geoCoords.textContent = msg;
    els.geoAcc.textContent = "—";
    els.geoTime.textContent = "—";
    Toast.error("Geolocalización", msg, "geoError");
  }

  function startGeo() {
    if (!navigator.geolocation) {
      onGeoError({ code: 2 });
      return;
    }
    if (state.geoActive && geoWatchId != null) {
      els.geoPanel.classList.remove("hidden");
      centrarEnGeo();
      return;
    }
    state.geoActive = true;
    els.btnGeo.classList.add("active");
    els.geoPanel.classList.remove("hidden", "error");
    els.geoState.textContent = "Localizando…";
    els.geoCoords.textContent = "Buscando señal GPS…";
    try {
      geoWatchId = navigator.geolocation.watchPosition(onGeoSuccess, onGeoError, GEO_OPTS);
      Toast.info(
        "GPS activado",
        "Siguiendo tu ubicación y calculando distancias en tiempo real.",
        "geo"
      );
    } catch (err) {
      onGeoError({ code: 2 });
    }
  }

  function stopGeo(silent) {
    if (geoWatchId != null && navigator.geolocation) {
      navigator.geolocation.clearWatch(geoWatchId);
      geoWatchId = null;
    }
    state.geoActive = false;
    state.geo = null;
    if (geoMarker) {
      geoGroup.removeLayer(geoMarker);
      geoMarker = null;
    }
    if (geoAccuracy) {
      geoGroup.removeLayer(geoAccuracy);
      geoAccuracy = null;
    }
    proximityGroup.clearLayers();
    els.btnGeo.classList.remove("active");
    els.geoPanel.classList.add("hidden");
    els.geoPanel.classList.remove("error");
    els.geoState.textContent = "Mi ubicación";
    actualizarProximidad();
    updateLegend();
    if (!silent) {
      Toast.info("GPS desactivado", "La ubicación dejó de seguirse.", "geoOff");
    }
  }

  function centrarEnGeo() {
    if (!state.geo) return;
    map.setView([state.geo.lat, state.geo.lon], Math.max(map.getZoom(), 13), {
      animate: true,
      duration: 0.8,
    });
  }

  function initGeo() {
    if (!els.btnGeo) return;
    els.btnGeo.addEventListener("click", () => {
      if (state.geoActive) stopGeo(false);
      else startGeo();
    });
    els.geoClose.addEventListener("click", () => {
      els.geoPanel.classList.add("hidden");
    });
    els.geoCenter.addEventListener("click", centrarEnGeo);
    els.geoStop.addEventListener("click", () => stopGeo(false));
    els.geoNearestFoco.addEventListener("click", () => {
      const nf = nearestFoco();
      if (!nf) return;
      map.setView([nf.item.lat, nf.item.lon], Math.max(map.getZoom(), 11), {
        animate: true,
        duration: 0.8,
      });
      Toast.info("Foco más cercano", fmtDist(nf.km) + " desde tu ubicación", "geoFoco");
    });
    els.geoNearestQuemada.addEventListener("click", () => {
      const nq = nearestQuemada();
      if (!nq) return;
      map.setView([nq.item.lat, nq.item.lon], Math.max(map.getZoom(), 11), {
        animate: true,
        duration: 0.8,
      });
      Toast.info(
        "Área quemada más cercana",
        nq.km <= 0.001 ? "Estás dentro del área" : fmtDist(nq.km) + " al borde",
        "geoQuemada"
      );
    });
  }

  /* --------------------------- NASA FIRMS en vivo ----------------------- */
  function setFirmsStatus(texto, clase) {
    if (!els.firmsStatus) return;
    els.firmsStatus.textContent = texto;
    els.firmsStatus.className = "firms-status" + (clase ? " " + clase : "");
  }

  function firmsNivel(p) {
    if (p.frp != null && isFinite(p.frp)) {
      return p.frp >= 30 ? 2 : p.frp >= 10 ? 1 : 0;
    }
    if (p.confianzaNum != null && isFinite(p.confianzaNum)) {
      return p.confianzaNum >= 80 ? 2 : p.confianzaNum >= 50 ? 1 : 0;
    }
    const c = String(p.confianza || "").toLowerCase();
    if (c === "high" || c === "h" || c === "2") return 2;
    if (c === "nominal" || c === "n" || c === "1") return 1;
    return 0;
  }

  function parseCsvLine(linea) {
    const salida = [];
    let actual = "";
    let comillas = false;
    for (let i = 0; i < linea.length; i++) {
      const ch = linea[i];
      if (comillas) {
        if (ch === '"') {
          if (linea[i + 1] === '"') {
            actual += '"';
            i++;
          } else {
            comillas = false;
          }
        } else {
          actual += ch;
        }
      } else if (ch === '"') {
        comillas = true;
      } else if (ch === ",") {
        salida.push(actual);
        actual = "";
      } else {
        actual += ch;
      }
    }
    salida.push(actual);
    return salida;
  }

  function parseFirmsCsv(texto) {
    const lineas = String(texto || "").replace(/\r/g, "").split("\n").filter(function (l) {
      return l.trim();
    });
    if (!lineas.length) return [];
    const cabecera = parseCsvLine(lineas[0]).map(function (h) {
      return h.trim().toLowerCase();
    });
    function idx(nombre) {
      return cabecera.indexOf(nombre);
    }
    const iLat = idx("latitude");
    const iLon = idx("longitude");
    if (iLat < 0 || iLon < 0) return [];
    const iFrp = idx("frp");
    const iConf = idx("confidence");
    const iFecha = idx("acq_date");
    const iHora = idx("acq_time");
    const iSat = idx("satellite");
    const iInst = idx("instrument");
    const iBrillo = idx("bright_ti4") >= 0 ? idx("bright_ti4") : idx("brightness");
    const iDia = idx("daynight");
    const puntos = [];
    for (let i = 1; i < lineas.length; i++) {
      const cols = parseCsvLine(lineas[i]);
      const lat = Number(cols[iLat]);
      const lon = Number(cols[iLon]);
      if (!isFinite(lat) || !isFinite(lon)) continue;
      const frp = iFrp >= 0 ? Number(cols[iFrp]) : NaN;
      const confianza = iConf >= 0 ? String(cols[iConf] || "").trim() : "";
      const confianzaNum = Number(confianza);
      puntos.push({
        lat: lat,
        lon: lon,
        frp: isFinite(frp) ? frp : null,
        confianza: confianza,
        confianzaNum: isFinite(confianzaNum) ? confianzaNum : null,
        fecha: (iFecha >= 0 ? cols[iFecha] : "") + (iHora >= 0 && cols[iHora] ? " " + cols[iHora] : ""),
        satelite: iSat >= 0 ? cols[iSat] : "",
        instrumento: iInst >= 0 ? cols[iInst] : "",
        brillo: iBrillo >= 0 ? Number(cols[iBrillo]) : null,
        daynight: iDia >= 0 ? cols[iDia] : "",
      });
    }
    return puntos;
  }

  function parseFirmsGeoJSON(obj) {
    const feats = obj && Array.isArray(obj.features)
      ? obj.features
      : (Array.isArray(obj) ? obj : []);
    const puntos = [];
    feats.forEach(function (f) {
      const g = (f && f.geometry) || f || {};
      const coords = g.coordinates;
      if (!coords) return;
      let lista = [];
      if (g.type === "Point") lista = [coords];
      else if (g.type === "MultiPoint") lista = coords;
      else return;
      const p = (f && f.properties) || {};
      lista.forEach(function (c) {
        const lon = Number(c[0]);
        const lat = Number(c[1]);
        if (!isFinite(lat) || !isFinite(lon)) return;
        const frp = Number(p.frp != null ? p.frp : p.FRP);
        const conf = p.confidence != null ? p.confidence : p.confianza;
        puntos.push({
          lat: lat,
          lon: lon,
          frp: isFinite(frp) ? frp : null,
          confianza: conf == null ? "" : String(conf),
          confianzaNum: isFinite(Number(conf)) ? Number(conf) : null,
          fecha: p.acq_date || p.fecha || "",
          satelite: p.satellite || p.satelite || "",
          instrumento: p.instrument || p.instrumento || "",
          brillo: isFinite(Number(p.bright_ti4 || p.brightness)) ? Number(p.bright_ti4 || p.brightness) : null,
          daynight: p.daynight || "",
        });
      });
    });
    return puntos;
  }

  function popupFirms(p) {
    const lv = INTENSIDAD[firmsNivel(p)];
    return function () {
      return (
        '<div class="popup"><span class="tag">NASA FIRMS</span>' +
        "<strong>" + (p.frp != null ? "FRP " + fmt(p.frp) + " MW" : "Foco satelital") + "</strong>" +
        '<span style="color:' + lv.color + '">● Intensidad ' + esc(lv.label) + "</span>" +
        (p.fecha ? "<span>" + esc(p.fecha) + "</span>" : "") +
        (p.satelite ? "<span>" + esc(p.satelite) + (p.instrumento ? " · " + esc(p.instrumento) : "") + "</span>" : "") +
        (p.confianza ? "<span>Confianza " + esc(p.confianza) + "</span>" : "") +
        distanciaHTML(distanciaFocoKm(p), "desde tu ubicación") +
        '<span class="coords">' + Number(p.lat).toFixed(3) + ", " + Number(p.lon).toFixed(3) + "</span>" +
        "</div>"
      );
    };
  }

  function renderFirmsPoints(puntos, etiqueta) {
    const group = groups.firms;
    if (!group) return;
    group.clearLayers();
    const niveles = [0, 0, 0];
    puntos.forEach(function (p) {
      const n = firmsNivel(p);
      niveles[n] += 1;
      const lv = INTENSIDAD[n];
      const marker = L.circleMarker([p.lat, p.lon], {
        radius: lv.radius + 0.4,
        color: lv.ring,
        weight: 0.6,
        fillColor: lv.color,
        fillOpacity: 0.92,
        bubblingMouseEvents: false,
      });
      marker.bindTooltip(
        function () {
          const d = distanciaFocoKm(p);
          return "FIRMS · " + lv.label +
            (p.frp != null ? " · FRP " + fmt(p.frp) : "") +
            (d == null ? "" : ' · <span class="tt-dist">' + fmtDist(d) + "</span>");
        },
        { sticky: true, className: "map-tooltip", direction: "top" }
      );
      bindClickPopup(marker, [p.lat, p.lon], popupFirms(p), { tipo: "firms", item: p });
      marker.addTo(group);
    });
    state.firms = {
      active: true,
      wms: state.firms.wms,
      count: puntos.length,
      label: etiqueta,
      niveles: niveles,
      points: puntos,
    };
    if (!map.hasLayer(group)) group.addTo(map);
    els.firmsPill.textContent = fmt(puntos.length) + " focos";
    setFirmsStatus(
      fmt(puntos.length) + " focos en vivo · " + etiqueta +
      " · " + niveles[2] + " alta, " + niveles[1] + " media, " + niveles[0] + " baja (FRP)",
      "ok"
    );
    updateLegend();
    updateMapEmpty();
    scheduleStudyRefresh();
    refreshQuickQr();
  }

  function clearFirms(silent) {
    if (firmsAbort) {
      firmsAbort.abort();
      firmsAbort = null;
    }
    if (groups.firms) groups.firms.clearLayers();
    if (map && map.hasLayer(groups.firms)) map.removeLayer(groups.firms);
    state.firms = {
      active: false,
      wms: state.firms.wms,
      count: 0,
      label: "",
      niveles: [0, 0, 0],
      points: [],
    };
    els.firmsPill.textContent = "Sin datos";
    setFirmsStatus("Sin datos en vivo. Se usan los focos históricos del año.", "");
    updateLegend();
    updateMapEmpty();
    refreshQuickQr();
    if (!silent) {
      Toast.info("Capa FIRMS retirada", "Vuelven a verse los focos históricos del año.", "firms");
    }
  }

  function toggleFirmsWms() {
    const wms = groups.firmsWms;
    if (!wms) return;
    if (state.firms.wms) {
      map.removeLayer(wms);
      state.firms.wms = false;
      els.firmsWms.classList.remove("active");
      Toast.info("WMS NASA GIBS desactivado", "Se retiró la capa raster de anomalías térmicas.", "firmsWms");
    } else {
      wms.addTo(map);
      state.firms.wms = true;
      els.firmsWms.classList.add("active");
      Toast.info("WMS NASA GIBS activado", "Anomalías térmicas VIIRS 375 m (referencia raster).", "firmsWms");
    }
    updateLegend();
    updateMapEmpty();
    refreshQuickQr();
  }

  async function cargarFirms() {
    const key = (els.firmsKey.value || "").trim();
    const url = (els.firmsUrl.value || "").trim();
    const source = els.firmsSource.value;
    const days = els.firmsDays.value;
    try {
      localStorage.setItem(FIRMS_KEY_STORE, key);
      localStorage.setItem(FIRMS_URL_STORE, url);
    } catch (err) {
      /* almacenamiento no disponible */
    }
    if (firmsAbort) firmsAbort.abort();
    firmsAbort = new AbortController();
    const ctrl = firmsAbort;
    els.firmsPill.textContent = "Cargando…";
    setFirmsStatus("Consultando NASA FIRMS…", "loading");
    try {
      let puntos = [];
      let etiqueta = "";
      if (url) {
        const resp = await fetch(url, { signal: ctrl.signal, cache: "no-store" });
        if (!resp.ok) throw new Error("HTTP " + resp.status);
        const geojson = await resp.json();
        puntos = parseFirmsGeoJSON(geojson);
        etiqueta = "GeoJSON";
      } else if (key) {
        const oeste = BOUNDS[0][1];
        const sur = BOUNDS[0][0];
        const este = BOUNDS[1][1];
        const norte = BOUNDS[1][0];
        const area = [oeste, sur, este, norte].join(",");
        const api = FIRMS_API + encodeURIComponent(key) + "/" + source + "/" + area + "/" + days;
        const resp = await fetch(api, { signal: ctrl.signal, cache: "no-store" });
        if (!resp.ok) throw new Error("HTTP " + resp.status);
        const texto = await resp.text();
        if (!/latitude/i.test(texto.slice(0, 200)) && /invalid|error|not found/i.test(texto.slice(0, 200))) {
          throw new Error(texto.slice(0, 140));
        }
        puntos = parseFirmsCsv(texto);
        etiqueta = (FIRMS_SOURCES[source] || {}).label || source;
      } else {
        els.firmsPill.textContent = "Sin clave";
        setFirmsStatus(
          "Falta la MAP_KEY o una URL GeoJSON. Obtén una clave gratuita en el enlace inferior.",
          "error"
        );
        Toast.warning("NASA FIRMS", "Agrega tu MAP_KEY o una URL GeoJSON para cargar focos en vivo.", "firmsKey");
        return;
      }
      if (!puntos.length) {
        els.firmsPill.textContent = "0 focos";
        setFirmsStatus(
          "La consulta no devolvió focos para el área y periodo. Prueba más días o revisa la fuente.",
          "error"
        );
        Toast.info("Sin focos FIRMS", "No hay anomalías térmicas en el periodo consultado.", "firmsEmpty");
        return;
      }
      renderFirmsPoints(puntos, etiqueta);
      Toast.success("FIRMS cargado", fmt(puntos.length) + " focos en vivo · " + etiqueta, "firmsOk");
    } catch (err) {
      if (err && err.name === "AbortError") return;
      console.error(err);
      els.firmsPill.textContent = "Error";
      setFirmsStatus(
        "No se pudo consultar FIRMS. La API puede bloquear CORS desde el navegador; usa una URL GeoJSON o publica un proxy. Detalle: " +
        (err.message || err),
        "error"
      );
      Toast.error("NASA FIRMS", "Consulta fallida. Revisa la clave, la URL o la consola.", "firmsErr");
    } finally {
      if (firmsAbort === ctrl) firmsAbort = null;
    }
  }

  function initFirms() {
    if (!els.firmsLoad) return;
    try {
      els.firmsKey.value = localStorage.getItem(FIRMS_KEY_STORE) || "";
      els.firmsUrl.value = localStorage.getItem(FIRMS_URL_STORE) || "";
    } catch (err) {
      /* almacenamiento no disponible */
    }
    if (els.firmsKey.value) {
      els.firmsPill.textContent = "Clave lista";
      setFirmsStatus("MAP_KEY guardada. Pulsa “Cargar focos” para consultar NASA FIRMS.", "");
    }
    els.firmsLoad.addEventListener("click", cargarFirms);
    els.firmsClear.addEventListener("click", function () { clearFirms(false); });
    els.firmsWms.addEventListener("click", toggleFirmsWms);
    els.firmsKey.addEventListener("change", function () {
      try { localStorage.setItem(FIRMS_KEY_STORE, els.firmsKey.value.trim()); } catch (err) {}
    });
    els.firmsUrl.addEventListener("change", function () {
      try { localStorage.setItem(FIRMS_URL_STORE, els.firmsUrl.value.trim()); } catch (err) {}
    });
    [els.firmsKey, els.firmsUrl].forEach(function (input) {
      input.addEventListener("keydown", function (event) {
        if (event.key === "Enter") {
          event.preventDefault();
          cargarFirms();
        }
      });
    });
  }

  /* --------------------------- Capas: controles ------------------------- */
  function buildLayerList() {
    if (!els.layerList) return;
    els.layerList.innerHTML = LAYERS.map((layer) => {
      const checked = !!state.layers[layer.id] && layer.available;
      const isPoint = ["focos", "quemadas"].indexOf(layer.kind) >= 0;
      return (
        '<label class="layer-row' + (layer.available ? "" : " disabled") + '"' +
          (layer.available ? "" : ' title="La capa se habilitará cuando el modelo termine de procesarse."') + ">" +
          '<span class="layer-swatch' + (isPoint ? " ring" : "") + '" style="--c:' + layer.color + '"></span>' +
          '<span class="layer-text"><strong>' + esc(layer.name) + "</strong>" +
            "<small>" + esc(layer.desc) + "</small></span>" +
          '<span class="switch"><input type="checkbox" data-layer="' + layer.id + '"' +
            (checked ? " checked" : "") + (layer.available ? "" : " disabled") + ">" +
            '<span class="slider"></span></span>' +
        "</label>"
      );
    }).join("");
  }

  function setLayer(id, on, options) {
    const opts = options || {};
    const layer = LAYERS.find((l) => l.id === id);
    if (!layer || !layer.available) return;
    state.layers[id] = !!on;
    if (id === "susceptibilidad") renderCloropleta();
    const group = groups[id];
    if (group) {
      if (on) {
        if (!map.hasLayer(group)) group.addTo(map);
      } else if (map.hasLayer(group)) {
        map.removeLayer(group);
      }
    }
    updateLegend();
    updateMapEmpty();
    refreshQuickQr();
    if (!opts.silent) {
      Toast.info(on ? "Capa activada" : "Capa desactivada", layer.name, "layer");
      checkReq("capas");
    }
    scheduleStudyRefresh();
  }

  function applyAllLayers(on) {
    LAYERS.forEach((layer) => {
      if (!layer.available) return;
      state.layers[layer.id] = !!on;
      setLayer(layer.id, on, { silent: true });
    });
    $$("#layerList input[data-layer]").forEach((cb) => {
      cb.checked = !!state.layers[cb.dataset.layer];
    });
    updateLegend();
    updateMapEmpty();
    refreshQuickQr();
    Toast.success(
      on ? "Todas las capas activadas" : "Capas desactivadas",
      LAYERS.filter((l) => l.available).length + " capas disponibles",
      "layers"
    );
    checkReq("capas");
  }

  function updateMapEmpty() {
    const anyLayer = LAYERS.some((l) => l.available && state.layers[l.id]);
    const anyFirms = !!(state.firms && (state.firms.active || state.firms.wms));
    const anyGeo = !!state.geoActive;
    if (els.mapEmpty) els.mapEmpty.classList.toggle("hidden", anyLayer || anyFirms || anyGeo);
  }

  function updateLegend() {
    if (!els.legendBody) return;
    const active = capasActivas();
    let html = "";

    function fila(nombre, color, ring) {
      return '<div class="legend-row"><span class="legend-swatch' + (ring ? " ring" : "") +
        '" style="--c:' + color + '"></span><span>' + esc(nombre) + "</span></div>";
    }

    active.forEach((layer) => {
      if (layer.id === "susceptibilidad") {
        html +=
          '<div class="legend-row"><span class="legend-swatch" style="--c:#ff5a3c"></span>' +
          "<span>" + esc(layer.name) + "</span></div>" +
          '<div class="legend-gradient"></div>' +
          '<div class="legend-scale"><span>Baja</span><span>Alta</span></div>';
      } else if (layer.id === "focos") {
        html += fila(layer.name, layer.color, true);
        html += '<div class="legend-sub">' + INTENSIDAD.slice().reverse().map(function (lv) {
          return '<span><i style="background:' + lv.color + '"></i>' + esc(lv.label) + "</span>";
        }).join("") + "</div>";
      } else if (layer.id === "areas") {
        html +=
          '<div class="legend-row"><span class="legend-swatch" style="--c:#a855f7"></span>' +
          "<span>Áreas protegidas <small>(polígonos)</small></span></div>";
      } else if (layer.id === "quemadas") {
        html +=
          '<div class="legend-row"><span class="legend-swatch" style="--c:#f97316;box-shadow:0 0 0 1.5px #fb923c inset"></span>' +
          "<span>Áreas quemadas <small>(polígonos)</small></span></div>";
      } else {
        const ring = ["focos"].indexOf(layer.kind) >= 0;
        html += fila(layer.name, layer.color, ring);
      }
    });

    if (state.firms && state.firms.active) {
      html += fila("NASA FIRMS en vivo", "#ef4444", true);
      html += '<div class="legend-sub">' + FIRMS_INTENSIDAD.slice().reverse().map(function (lv) {
        return '<span><i style="background:' + lv.color + '"></i>' + esc(lv.label) + "</span>";
      }).join("") + "</div>";
    } else if (state.firms && state.firms.wms) {
      html += fila("NASA GIBS · WMS", "#f97316", false);
    }

    if (state.geoActive && state.geo) {
      html +=
        '<div class="legend-row"><span class="legend-swatch" style="--c:#111827;box-shadow:0 0 0 1.5px #fff inset"></span>' +
        "<span>Tu ubicación</span></div>";
    }

    if (!html) {
      els.legendBody.innerHTML = '<div class="legend-row" style="color:var(--muted-2)">Sin capas activas</div>';
      return;
    }

    const piezas = [];
    if (capaActiva("focos")) piezas.push(fmt(focosVisibles(state.year).length) + " focos");
    if (capaActiva("quemadas")) piezas.push(fmt(quemadasVisibles(state.year).length) + " quemadas");
    if (capaActiva("areas")) piezas.push(fmt((D.areas_puntos || []).length) + " áreas");
    if (state.firms && state.firms.active) piezas.push(fmt(state.firms.count) + " FIRMS");
    html +=
      '<div class="legend-scale" style="margin-top:8px;padding-top:7px;border-top:1px solid var(--border)">' +
      "<span>" + (state.year == null ? "Todos los años" : "Año " + state.year) + "</span>" +
      "<span>" + (piezas.length ? piezas.join(" · ") : "sin datos") + "</span></div>";
    els.legendBody.innerHTML = html;
  }

  /* ------------------------------- Año ---------------------------------- */
  function updateSliderFill() {
    const min = Number(els.yearRange.min);
    const max = Number(els.yearRange.max);
    const value = Number(els.yearRange.value);
    const pct = max === min ? 100 : ((value - min) / (max - min)) * 100;
    els.yearRange.style.setProperty("--fill", pct + "%");
  }

  function buildYearScale() {
    const first = ANIOS[0];
    const last = ANIOS[ANIOS.length - 1];
    const values = [
      first,
      Math.round(first + (last - first) * 0.25),
      Math.round(first + (last - first) * 0.5),
      Math.round(first + (last - first) * 0.75),
      last,
    ];
    els.yearScale.innerHTML = values.map((v) => "<span>" + v + "</span>").join("");
  }

  function updateYearStats(stats) {
    els.statFocos.textContent = fmt(stats.focos);
    els.statQuemadas.textContent = fmt(stats.quemadas);
    els.statAreas.textContent = fmt((D.areas_puntos || []).length);
    els.mapTitleYear.textContent = state.year == null ? "· todos los años" : "· " + state.year;
    const empty = stats.focos === 0 && stats.quemadas === 0 && state.year != null;
    els.yearBanner.classList.toggle("show", empty);
    els.yearBanner.innerHTML = "<span>⚠</span> Sin focos ni áreas quemadas registradas en " + state.year;
    const kF = document.getElementById("kpiFocos");
    const kQ = document.getElementById("kpiQuemadas");
    const kD = document.getElementById("kpiDeptos");
    if (kF) kF.textContent = fmt(stats.focos);
    if (kQ) kQ.textContent = fmt(stats.quemadas);
    if (kD) {
      const seen = new Set();
      focosDeAnio(state.year).forEach((p) => seen.add(p.depto));
      quemadasDeAnio(state.year).forEach((p) => seen.add(p.depto));
      kD.textContent = fmt(seen.size);
    }
    scheduleStudyRefresh();
  }

  // Reproducción animada de focos por año (Time Slider).
  function toggleYearPlay() {
    if (yearPlayTimer) {
      clearInterval(yearPlayTimer);
      yearPlayTimer = null;
      if (els.yearPlay) els.yearPlay.textContent = "▶ Reproducir animación";
      return;
    }
    const anios = ANIOS.slice();
    let i = 0;
    setYear(anios[0], { silent: true, toastIt: false });
    if (els.yearPlay) els.yearPlay.textContent = "⏸ Detener animación";
    yearPlayTimer = setInterval(function () {
      i += 1;
      if (i >= anios.length) {
        clearInterval(yearPlayTimer);
        yearPlayTimer = null;
        if (els.yearPlay) els.yearPlay.textContent = "▶ Reproducir animación";
        return;
      }
      setYear(anios[i], { silent: true, toastIt: false });
    }, 900);
  }

  function setYear(year, options) {
    const opts = options || {};
    state.year = year;
    els.yearRange.value = String(year == null ? ANIOS[ANIOS.length - 1] : year);
    els.yearValue.textContent = year == null ? "Todos" : String(year);
    els.yearPill.textContent = year == null ? "Todos" : String(year);
    updateSliderFill();
    $$("#yearChips .chip").forEach((chip) => {
      const value = chip.dataset.year;
      chip.classList.toggle(
        "active",
        (value === "todos" && year == null) ||
          (value !== "todos" && Number(value) === year)
      );
    });
    const stats = renderYearLayers();
    updateYearStats(stats);
    if (state.query || state.category !== "todas") runSearch({ silent: true });
    updateLegend();
    refreshQuickQr();
    if (capaActiva("susceptibilidad")) renderCloropleta();
    if (deptoSeleccionado) actualizarInfoDepto();
    if (opts.mark) checkReq("anio");
    if (opts.toastIt) {
      Toast.success(
        year == null ? "Todos los años" : "Año " + year,
        fmt(stats.focos) + " focos · " + fmt(stats.quemadas) + " áreas quemadas",
        "year"
      );
    }
  }

  /* ----------------------------- Búsqueda ------------------------------- */
  function buildIndex() {
    const index = [];
    (D.departamentos_puntos || []).forEach((d) => {
      index.push({
        cat: "departamentos",
        tipo: "Departamento",
        titulo: prettyDepto(d.nombre),
        meta: "Código " + (d.codigo || "—"),
        lat: d.lat,
        lon: d.lon,
        search: norm(d.nombre + " " + d.codigo + " departamento"),
      });
    });
    (D.areas_puntos || []).forEach((a) => {
      index.push({
        cat: "areas",
        tipo: "Área protegida",
        titulo: a.nombre,
        meta: [a.designacion, prettyDepto(a.depto), a.area_ha ? fmt(a.area_ha) + " ha" : ""]
          .filter(Boolean)
          .join(" · "),
        lat: a.lat,
        lon: a.lon,
        search: norm(
          a.nombre + " " + a.designacion + " " + a.iucn + " " + a.depto +
          " area protegida"
        ),
      });
    });
    (D.focos || []).forEach((f) => {
      index.push({
        cat: "focos",
        tipo: "Foco",
        titulo: "Foco " + f.anio,
        meta: (prettyDepto(f.depto) || "Sin departamento") + " · " +
          Number(f.lat).toFixed(2) + ", " + Number(f.lon).toFixed(2),
        lat: f.lat,
        lon: f.lon,
        anio: f.anio,
        search: norm(f.depto + " foco calor incendio " + f.anio),
      });
    });
    (D.quemadas || []).forEach((q) => {
      index.push({
        cat: "quemadas",
        tipo: "Quemada",
        titulo: "Área quemada " + q.anio,
        meta: (prettyDepto(q.depto) || "Sin departamento") + " · día " + (q.doy || "—"),
        lat: q.lat,
        lon: q.lon,
        anio: q.anio,
        search: norm(q.depto + " area quemada incendio " + q.anio),
      });
    });
    index.forEach((item) => {
      item.words = Array.from(new Set(item.search.split(" ").filter(Boolean)));
    });
    return index;
  }

  const INDEX = buildIndex();

  function popupResult(item) {
    return (
      '<div class="popup"><span class="tag">' + esc(item.tipo) + "</span>" +
      "<strong>" + esc(item.titulo) + "</strong>" +
      "<span>" + esc(item.meta) + "</span>" +
      '<span class="coords">' + Number(item.lat).toFixed(4) + ", " + Number(item.lon).toFixed(4) + "</span>" +
      "</div>"
    );
  }

  function updateCategoryChips() {
    $$("#categoryChips .chip").forEach((chip) => {
      chip.classList.toggle("active", chip.dataset.cat === state.category);
    });
  }

  function renderInitialEmpty() {
    els.results.innerHTML =
      '<li class="empty">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">' +
          '<circle cx="11" cy="11" r="7"></circle><path d="m20 20-3.5-3.5"></path></svg>' +
        "<strong>Explora el visor</strong>" +
        "<p>Busca por departamento, área protegida, foco o área quemada. También puedes elegir una categoría.</p>" +
        '<div class="suggestions">' +
          '<button type="button" data-suggest="Cundinamarca">Cundinamarca</button>' +
          '<button type="button" data-suggest="Parques Nacionales">Parques Nacionales</button>' +
          '<button type="button" data-suggest="Focos 2024">Focos 2024</button>' +
          '<button type="button" data-suggest="Áreas quemadas 2020">Quemadas 2020</button>' +
        "</div>" +
      "</li>";
    $$("[data-suggest]", els.results).forEach((btn) => {
      btn.addEventListener("click", () => applySuggestion(btn.dataset.suggest));
    });
  }

  function renderEmptyResults() {
    const query = state.query.trim();
    const extra = [
      state.category !== "todas" ? CAT_LABELS[state.category] : "",
      state.year != null ? "año " + state.year : "",
    ].filter(Boolean).join(" · ");
    const yearMatch = query.match(/\b(20\d{2})\b/);
    const otherYear = yearMatch && ANIOS.indexOf(Number(yearMatch[1])) !== -1 &&
      Number(yearMatch[1]) !== state.year
      ? Number(yearMatch[1])
      : null;
    els.results.innerHTML =
      '<li class="empty">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">' +
          '<circle cx="11" cy="11" r="7"></circle><path d="m20 20-3.5-3.5"></path>' +
          '<path d="M8 8l6 6M14 8l-6 6"></path></svg>' +
        "<strong>Sin coincidencias</strong>" +
        "<p>No encontramos resultados" +
          (query ? " para “" + esc(query) + "”" : "") +
          (extra ? " en " + esc(extra) : "") +
          ". Prueba con otro término, año o categoría.</p>" +
        (otherYear
          ? '<button type="button" class="btn small primary" id="emptyYear">Ver ' + otherYear + "</button>"
          : "") +
        '<button type="button" class="btn small ghost" id="emptyClear">Limpiar filtros</button>' +
      "</li>";
    const clear = document.getElementById("emptyClear");
    if (clear) clear.addEventListener("click", clearFilters);
    const yearBtn = document.getElementById("emptyYear");
    if (yearBtn) {
      yearBtn.addEventListener("click", () => {
        state.category = "todas";
        updateCategoryChips();
        setYear(otherYear, { silent: false, toastIt: true, mark: true });
      });
    }
  }

  function renderResults(items) {
    els.results.innerHTML = "";
    if (!items.length) {
      renderEmptyResults();
      return;
    }
    const frag = document.createDocumentFragment();
    items.forEach((item, index) => {
      const li = document.createElement("li");
      li.className = "result-item";
      li.tabIndex = 0;
      li.innerHTML =
        '<span class="result-bullet" style="--c:' + catColor(item.cat) + '">' + (index + 1) + "</span>" +
        '<span class="result-body"><span class="result-title">' + esc(item.titulo) + "</span>" +
          '<span class="result-meta">' + esc(item.meta) + "</span></span>" +
        '<span class="result-tag">' + esc(item.tipo) + "</span>";
      const activate = () => focusResult(item);
      li.addEventListener("click", activate);
      li.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          activate();
        }
      });
      frag.appendChild(li);
    });
    els.results.appendChild(frag);
    if (els.results.animate) {
      els.results.animate([{ opacity: 0.35 }, { opacity: 1 }], {
        duration: 180,
        easing: "ease-out",
      });
    }
  }

  // Los resultados de búsqueda no crean viñetas ni pines sobre el mapa: la
  // lista del panel centra la vista y abre un popup informativo anclado a la
  // coordenada, sin ningún icono visible.
  function clearSearchMarkers() {
    searchGroup.clearLayers();
    highlightGroup.clearLayers();
  }

  function fitSearchMarkers() {
    const items = (lastResults || []).filter(function (item) {
      return isFinite(item.lat) && isFinite(item.lon);
    });
    if (!items.length) {
      Toast.info("Sin resultados", "Realiza una búsqueda para encuadrar los resultados.", "fit");
      return;
    }
    const bounds = L.latLngBounds(items.map(function (item) {
      return [item.lat, item.lon];
    }));
    if (bounds.isValid()) {
      map.fitBounds(bounds.pad(0.3), { animate: true, duration: 0.9, maxZoom: 9 });
    }
  }

  function focusResult(item) {
    map.flyTo([item.lat, item.lon], Math.max(map.getZoom(), 10), { duration: 1.05 });
    highlightGroup.clearLayers();
    setTimeout(function () {
      L.popup({ className: "custom-popup", maxWidth: 300 })
        .setLatLng([item.lat, item.lon])
        .setContent(popupResult(item))
        .openOn(map);
    }, 950);
    Toast.success("Ubicación encontrada", item.titulo, "focus");
    checkReq("vinetas");
    if (window.innerWidth <= 980) closeSidebar();
  }

  function runSearch(options) {
    const opts = options || {};
    const query = norm(state.query);
    const category = state.category;
    const criteria = query.length > 0 || category !== "todas";
    if (!criteria) {
      lastResults = [];
      clearSearchMarkers();
      renderInitialEmpty();
      els.resultCount.textContent = "0";
      els.searchMeta.textContent = "Escribe o elige una categoría";
      refreshQuickQr();
      return { total: 0, limited: 0 };
    }

    let items = INDEX;
    if (category !== "todas") {
      items = items.filter((item) => item.cat === category);
    }
    if (query) {
      const rawTokens = query.split(" ").filter(Boolean);
      const tokens = rawTokens.filter((t) => !STOPWORDS.has(t));
      const activeTokens = tokens.length ? tokens : rawTokens;
      items = items.filter((item) => activeTokens.every((t) => tokenMatch(item, t)));
    }
    if (state.year != null) {
      items = items.filter((item) =>
        (item.cat !== "focos" && item.cat !== "quemadas") || item.anio === state.year
      );
    }

    const total = items.length;
    const limited = items.slice(0, 250);
    lastResults = limited;
    renderResults(limited);
    clearSearchMarkers();
    checkReq("vinetas");
    els.resultCount.textContent = fmt(total);
    if (total > limited.length) {
      els.searchMeta.innerHTML =
        "Mostrando " + fmt(limited.length) + " de " + fmt(total) +
        ' · <button type="button" id="fitResultsBtn">Encuadrar</button>';
      const fit = document.getElementById("fitResultsBtn");
      if (fit) fit.addEventListener("click", fitSearchMarkers);
    } else {
      els.searchMeta.textContent = fmt(total) + " coincidencia" + (total === 1 ? "" : "s");
    }
    if (category !== "todas") checkReq("categoria");
    if (opts.fit) fitSearchMarkers();
    scheduleStudyRefresh();
    refreshQuickQr();
    return { total: total, limited: limited.length };
  }

  function explicitSearch() {
    const query = state.query.trim();
    if (!query && state.category === "todas") {
      Toast.info("Escribe un término", "Prueba con un departamento, un área protegida o un año.", "searchEmpty");
      return;
    }
    Toast.loading("Buscando…", "Filtrando registros del visor", "search");
    setTimeout(() => {
      const result = runSearch({ silent: true });
      if (result.total > 0) {
        Toast.update("search", {
          type: "success",
          title: fmt(result.total) + " coincidencia" + (result.total === 1 ? "" : "s"),
          message: result.total > result.limited
            ? "Mostrando las primeras " + fmt(result.limited) + "."
            : "Resultados marcados en el mapa.",
          duration: 3800,
        });
      } else {
        Toast.update("search", {
          type: "warning",
          title: "Sin coincidencias",
          message: "Prueba con otro término, año o categoría.",
          duration: 4300,
        });
      }
    }, 260);
  }

  function applySuggestion(text) {
    state.category = "todas";
    updateCategoryChips();
    const yearMatch = text.match(/\b(20\d{2})\b/);
    if (yearMatch) {
      const year = Number(yearMatch[1]);
      if (ANIOS.indexOf(year) !== -1 && year !== state.year) {
        setYear(year, { silent: true, toastIt: false, mark: true });
      }
    }
    state.query = text;
    els.searchInput.value = text;
    els.searchClear.classList.add("visible");
    runSearch({ silent: true });
    Toast.success("Sugerencia aplicada", "Buscando “" + text + "”", "suggest");
  }

  function clearFilters() {
    state.query = "";
    state.category = "todas";
    els.searchInput.value = "";
    els.searchClear.classList.remove("visible");
    updateCategoryChips();
    runSearch({ silent: true });
    Toast.info("Filtros limpiados", "Puedes empezar una nueva búsqueda.", "clear");
  }

  /* ------------------------------- Modal -------------------------------- */
  function loadPdf() {
    if (!ASSETS.pdf) {
      if (!els.pdfPane.querySelector(".fallback")) {
        els.pdfPane.innerHTML =
          '<div class="fallback"><strong>PDF no disponible</strong>' +
          "<p>El documento se generará al construir el visor.</p></div>";
      }
      return;
    }
    if (els.pdfFrame.getAttribute("src") !== ASSETS.pdf) {
      els.pdfFrame.setAttribute("src", ASSETS.pdf);
    }
  }

  function loadJpg() {
    if (!ASSETS.jpg) {
      if (!els.jpgPane.querySelector(".fallback")) {
        els.jpgPane.innerHTML =
          '<div class="fallback"><strong>JPG no disponible</strong>' +
          "<p>La vista previa se generará al construir el visor.</p></div>";
      }
      return;
    }
    if (!els.jpgImg.getAttribute("src")) {
      els.jpgImg.setAttribute("src", ASSETS.jpg);
    }
  }

  function updateDownload(tab) {
    if (tab === "pdf" && ASSETS.pdf) {
      els.downloadAsset.href = ASSETS.pdf;
      els.downloadAsset.setAttribute("download", "ficha_tecnica.pdf");
      els.downloadAsset.textContent = "Descargar PDF";
    } else if (tab === "jpg" && ASSETS.jpg) {
      els.downloadAsset.href = ASSETS.jpg;
      els.downloadAsset.setAttribute("download", "vista_previa_nacional.jpg");
      els.downloadAsset.textContent = "Descargar JPG";
    } else {
      els.downloadAsset.href = "#";
      els.downloadAsset.removeAttribute("download");
      els.downloadAsset.textContent = "Descargar";
    }
  }

  function switchTab(tab) {
    state.modalTab = tab;
    $$("#modalTabs button").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.tab === tab);
    });
    els.pdfPane.classList.toggle("active", tab === "pdf");
    els.jpgPane.classList.toggle("active", tab === "jpg");
    if (tab === "pdf") loadPdf();
    else loadJpg();
    updateDownload(tab);
  }

  function openModal(tab) {
    els.modal.classList.add("open");
    els.modal.setAttribute("aria-hidden", "false");
    switchTab(tab || "pdf");
    checkReq("docs");
    setTimeout(() => els.modalClose.focus(), 140);
    Toast.success(
      "Vista previa",
      tab === "jpg" ? "Mapa en JPG abierto." : "Ficha técnica abierta.",
      "docsToast"
    );
  }

  function closeModal() {
    els.modal.classList.remove("open");
    els.modal.setAttribute("aria-hidden", "true");
  }

  /* ------------------------------ Sidebar ------------------------------- */
  function openSidebar() {
    els.sidebar.classList.add("open");
    els.sidebarBackdrop.classList.add("show");
  }

  function closeSidebar() {
    els.sidebar.classList.remove("open");
    els.sidebarBackdrop.classList.remove("show");
  }

  /* ------------------------------- UI ----------------------------------- */
  function updateClock() {
    if (!els.clock) return;
    els.clock.textContent = new Date().toLocaleTimeString("es-CO", {
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  function initUI() {
    els.yearRange.min = String(ANIOS[0]);
    els.yearRange.max = String(ANIOS[ANIOS.length - 1]);
    els.yearRange.step = "1";
    buildYearScale();
    buildLayerList();
    buildReqList();
    updateCategoryChips();
    updateSliderFill();
    updateReqUI();

    els.yearRange.addEventListener("input", () => {
      const year = Number(els.yearRange.value);
      els.yearValue.textContent = String(year);
      els.yearPill.textContent = String(year);
      updateSliderFill();
      clearTimeout(yearTimer);
      yearTimer = setTimeout(() => setYear(year, { silent: true, toastIt: false, mark: true }), 90);
    });
    els.yearRange.addEventListener("change", () => {
      setYear(Number(els.yearRange.value), { silent: false, toastIt: true, mark: true });
    });

    els.yearChips.addEventListener("click", (event) => {
      const chip = event.target.closest("[data-year]");
      if (!chip) return;
      const value = chip.dataset.year === "todos" ? null : Number(chip.dataset.year);
      setYear(value, { silent: false, toastIt: true, mark: true });
    });

    els.yearPlay.addEventListener("click", toggleYearPlay);

    els.layersAll.addEventListener("click", () => applyAllLayers(true));
    els.layersNone.addEventListener("click", () => applyAllLayers(false));
    els.layerList.addEventListener("change", (event) => {
      const cb = event.target.closest("input[data-layer]");
      if (!cb) return;
      setLayer(cb.dataset.layer, cb.checked);
    });

    els.searchInput.addEventListener("input", () => {
      state.query = els.searchInput.value;
      els.searchClear.classList.toggle("visible", state.query.length > 0);
      els.searchBox.classList.add("searching");
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        els.searchBox.classList.remove("searching");
        runSearch({ silent: true });
      }, 280);
    });
    els.searchInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        clearTimeout(searchTimer);
        els.searchBox.classList.remove("searching");
        explicitSearch();
      }
    });
    els.searchClear.addEventListener("click", () => {
      els.searchInput.value = "";
      state.query = "";
      els.searchClear.classList.remove("visible");
      runSearch({ silent: true });
      els.searchInput.focus();
    });

    els.categoryChips.addEventListener("click", (event) => {
      const chip = event.target.closest("[data-cat]");
      if (!chip) return;
      state.category = chip.dataset.cat;
      updateCategoryChips();
      if (state.category !== "todas") checkReq("categoria");
      runSearch({ silent: true });
      Toast.info("Categoría", chip.textContent.trim(), "cat");
    });

    if (els.reqReset) {
      els.reqReset.addEventListener("click", () => {
        reqState = {};
        reqCompleteShown = false;
        saveReq();
        updateReqUI();
        muteReq = true;
        Toast.info("Checklist restablecido", "Puedes volver a verificar los requisitos.", "reqReset");
        muteReq = false;
      });
    }

    els.openPdf.addEventListener("click", () => openModal("pdf"));
    els.openJpg.addEventListener("click", () => openModal("jpg"));
    els.modalClose.addEventListener("click", closeModal);
    els.modalClose2.addEventListener("click", closeModal);
    els.modalBackdrop.addEventListener("click", closeModal);
    els.modalTabs.addEventListener("click", (event) => {
      const btn = event.target.closest("button[data-tab]");
      if (btn) switchTab(btn.dataset.tab);
    });

    els.btnMenu.addEventListener("click", openSidebar);
    els.sidebarBackdrop.addEventListener("click", closeSidebar);

    els.btnBasemap.addEventListener("click", () => {
      if (basemap === "sat") {
        map.removeLayer(sat);
        osm.addTo(map);
        basemap = "osm";
        Toast.info("Mapa base", "OpenStreetMap", "base");
      } else {
        map.removeLayer(osm);
        sat.addTo(map);
        basemap = "sat";
        Toast.info("Mapa base", "Imagen satelital", "base");
      }
    });

    els.legendClose.addEventListener("click", () => els.legend.classList.add("hidden"));

    els.btnReset.addEventListener("click", () => {
      map.fitBounds(BOUNDS, { padding: [26, 26], animate: true, duration: 0.9 });
      Toast.info("Vista restablecida", "Colombia completa", "reset");
    });

    els.btnFullscreen.addEventListener("click", () => {
      if (!document.fullscreenElement) {
        if (document.documentElement.requestFullscreen) {
          document.documentElement.requestFullscreen().catch(() => {});
        }
      } else if (document.exitFullscreen) {
        document.exitFullscreen().catch(() => {});
      }
    });

    els.btnActivate.addEventListener("click", () => {
      ["focos", "deptos", "areas", "quemadas"].forEach((id) => {
        state.layers[id] = true;
        setLayer(id, true, { silent: true });
      });
      $$("#layerList input[data-layer]").forEach((cb) => {
        cb.checked = !!state.layers[cb.dataset.layer];
      });
      updateLegend();
      updateMapEmpty();
      Toast.success(
        "Capas recomendadas activadas",
        "Focos, departamentos, áreas protegidas y quemadas.",
        "activate"
      );
      checkReq("capas");
    });

    els.btnDocsEmpty.addEventListener("click", () => openModal("pdf"));

    document.addEventListener("keydown", (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        els.searchInput.focus();
        els.searchInput.select();
      }
      if (event.key === "Escape") {
        if (UI.studyModal && UI.studyModal.classList.contains("open")) closeStudy();
        else if (els.modal.classList.contains("open")) closeModal();
        else if (els.sidebar.classList.contains("open")) closeSidebar();
      }
    });

    setInterval(updateClock, 30000);
    updateClock();
  }

  /* ==========================================================================
     FASE UX/UI · Centro de estudio: informe, IGAC, QR y offline
     ========================================================================== */

  const UI = {
    netChip: $("#netChip"),
    netText: $("#netText"),
    offlineBar: $("#offlineBar"),
    offlineText: $("#offlineText"),
    offlineSync: $("#offlineSync"),
    kpiFocos: $("#kpiFocos"),
    kpiQuemadas: $("#kpiQuemadas"),
    kpiDeptos: $("#kpiDeptos"),
    syncPill: $("#syncPill"),
    syncText: $("#syncText"),
    btnSyncNow: $("#btnSyncNow"),
    hubExportReport: $("#hubExportReport"),
    hubExportMap: $("#hubExportMap"),
    studyModal: $("#studyModal"),
    studyBackdrop: $("#studyBackdrop"),
    studyCloseX: $("#studyCloseX"),
    studyClose: $("#studyClose"),
    studyTabs: $("#studyTabs"),
    studyBody: $("#studyBody"),
    studySave: $("#studySave"),
    studyHint: $("#studyHint"),
    reportPreview: $("#reportPreview"),
    integralReport: $("#integralReport"),
    integralReportMeta: $("#integralReportMeta"),
    integralKpis: $("#integralKpis"),
    intFocos: $("#intFocos"),
    intQuemadas: $("#intQuemadas"),
    intDeptos: $("#intDeptos"),
    intAreas: $("#intAreas"),
    integralIgac: $("#integralIgac"),
    integralQr: $("#integralQr"),
    integralQrUrl: $("#integralQrUrl"),
    integralNet: $("#integralNet"),
    integralSyncText: $("#integralSyncText"),
    integralSyncNow: $("#integralSyncNow"),
    integralChecklist: $("#integralChecklist"),
    integralPdf: $("#integralPdf"),
    integralMapPdf: $("#integralMapPdf"),
    integralPng: $("#integralPng"),
    integralGoReport: $("#integralGoReport"),
    integralGoQr: $("#integralGoQr"),
    repTitle: $("#repTitle"),
    repAuthor: $("#repAuthor"),
    repRole: $("#repRole"),
    repObs: $("#repObs"),
    repConclusions: $("#repConclusions"),
    repRecommendations: $("#repRecommendations"),
    igacFormat: $("#igacFormat"),
    igacLegend: $("#igacLegend"),
    igacGrid: $("#igacGrid"),
    igacCanvas: $("#igacCanvas"),
    qrCanvas: $("#qrCanvas"),
    qrCaption: $("#qrCaption"),
    qrLink: $("#qrLink"),
    qrCopy: $("#qrCopy"),
    qrDownload: $("#qrDownload"),
    qrOpen: $("#qrOpen"),
    qrYear: $("#qrYear"),
    qrSummary: $("#qrSummary"),
    qrSyncState: $("#qrSyncState"),
    qrSyncText: $("#qrSyncText"),
    qrSyncNow: $("#qrSyncNow"),
    btnExportPdf: $("#btnExportPdf"),
    btnDownloadMapPdf: $("#btnDownloadMapPdf"),
    btnDownloadPng: $("#btnDownloadPng"),
    btnDownloadQr: $("#btnDownloadQr"),
    btnCopyLink: $("#btnCopyLink"),
  };

  function loadJSON(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw == null ? fallback : JSON.parse(raw);
    } catch (err) {
      return fallback;
    }
  }

  function saveJSON(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (err) {
      return false;
    }
  }

  function debounce(fn, wait) {
    let timer = null;
    return function () {
      const args = arguments;
      clearTimeout(timer);
      timer = setTimeout(function () { fn.apply(null, args); }, wait);
    };
  }

  function agruparPorAnio(lista) {
    const mapa = new Map();
    (lista || []).forEach(function (item) {
      const anio = Number(item.anio);
      if (!mapa.has(anio)) mapa.set(anio, []);
      mapa.get(anio).push(item);
    });
    return mapa;
  }

  const FOCOS_POR_ANIO = agruparPorAnio(D.focos || []);
  const QUEMADAS_POR_ANIO = agruparPorAnio(D.quemadas || []);

  function focosDeAnio(anio) {
    return anio == null ? (D.focos || []) : (FOCOS_POR_ANIO.get(Number(anio)) || []);
  }

  function quemadasDeAnio(anio) {
    return anio == null ? (D.quemadas || []) : (QUEMADAS_POR_ANIO.get(Number(anio)) || []);
  }

  /* ------------------- Capas activas y datos visibles -------------------- */
  // Toda exportación (informe, PDF y plano) usa estos helpers para incluir
  // únicamente las capas que el usuario tiene activas en ese momento.
  const LAYER_SHORT = {
    susceptibilidad: "Susceptibilidad",
    focos: "Focos",
    bosques: "Bosques",
    agua: "Agua",
    areas: "Áreas protegidas",
    quemadas: "Quemadas",
    deptos: "Departamentos",
    ausencias: "Pseudo-ausencias",
  };

  function capaDisponible(id) {
    const layer = LAYERS.find(function (l) { return l.id === id; });
    return !!(layer && layer.available);
  }

  function capaActiva(id) {
    return capaDisponible(id) && !!state.layers[id];
  }

  function capasActivas() {
    return LAYERS.filter(function (l) { return l.available && state.layers[l.id]; });
  }

  function capasResumenTexto() {
    const nombres = capasActivas().map(function (l) { return l.name; });
    if (state.firms && state.firms.active) nombres.push("NASA FIRMS");
    if (state.geoActive) nombres.push("Mi ubicación");
    return nombres.length ? nombres.join(" · ") : "sin capas activas";
  }

  function focosVisibles(anio) {
    return capaActiva("focos") ? focosDeAnio(anio) : [];
  }

  function quemadasVisibles(anio) {
    return capaActiva("quemadas") ? quemadasDeAnio(anio) : [];
  }

  function areasVisibles() {
    return capaActiva("areas") ? TOP_AREAS : [];
  }

  function resumenDesde(focos, quemadas) {
    const mapa = new Map();
    function sumar(depto, campo) {
      const nombre = prettyDepto(depto) || "Sin departamento";
      let fila = mapa.get(nombre);
      if (!fila) {
        fila = { nombre: nombre, focos: 0, quemadas: 0 };
        mapa.set(nombre, fila);
      }
      fila[campo] += 1;
    }
    (focos || []).forEach(function (f) { sumar(f.depto, "focos"); });
    (quemadas || []).forEach(function (q) { sumar(q.depto, "quemadas"); });
    return Array.from(mapa.values()).sort(function (a, b) {
      return (b.focos - a.focos) || (b.quemadas - a.quemadas) || a.nombre.localeCompare(b.nombre);
    });
  }

  function resumenActivo(anio) {
    return resumenDesde(focosVisibles(anio), quemadasVisibles(anio));
  }

  function joinNatural(items) {
    const lista = (items || []).filter(Boolean);
    if (!lista.length) return "";
    if (lista.length === 1) return lista[0];
    return lista.slice(0, -1).join(", ") + " y " + lista[lista.length - 1];
  }

  function metodologiaActiva() {
    const partes = [];
    if (capaActiva("focos")) partes.push("focos de calor de NASA FIRMS (MODIS y VIIRS)");
    if (capaActiva("quemadas")) partes.push("áreas quemadas de MODIS MCD64A1");
    if (capaActiva("bosques")) partes.push("coberturas de bosque de ESA WorldCover");
    if (capaActiva("agua")) partes.push("fuentes hídricas de JRC Global Surface Water");
    if (capaActiva("areas")) partes.push("áreas protegidas de WDPA representadas como polígonos morados");
    if (capaActiva("deptos")) partes.push("límites departamentales de FAO GAUL");
    if (capaActiva("susceptibilidad")) {
      partes.push("susceptibilidad por departamento calculada a partir de la densidad de focos de calor y áreas quemadas del periodo");
    }
    if (capaActiva("ausencias")) partes.push("pseudo-ausencias de la muestra de entrenamiento");
    if (state.firms && state.firms.active) partes.push("focos en vivo de NASA FIRMS con intensidad por FRP");
    if (!partes.length) {
      return "No hay capas activas en el visor. Activa al menos una capa para que el informe y el plano incluyan información.";
    }
    return "El visor integra " + joinNatural(partes) + ". Los filtros de año, categoría y búsqueda " +
      "permiten explorar los registros sin perder el contexto territorial. Este documento se genera " +
      "con las capas activas al momento de la exportación; las capas desactivadas no se incluyen.";
  }

  function fuentesActivas() {
    const fuentes = META.fuentes || [];
    const claves = [];
    if (capaActiva("focos") || (state.firms && state.firms.active)) claves.push("firms");
    if (capaActiva("quemadas")) claves.push("mcd64a1");
    if (capaActiva("bosques")) claves.push("worldcover");
    if (capaActiva("agua")) claves.push("surface water");
    if (capaActiva("areas")) claves.push("wdpa");
    if (capaActiva("deptos")) claves.push("gaul");
    if (capaActiva("susceptibilidad")) { claves.push("firms"); claves.push("mcd64a1"); }
    if (!claves.length) return [];
    return fuentes.filter(function (fuente) {
      const texto = String(fuente).toLowerCase();
      return claves.some(function (clave) { return texto.indexOf(clave) !== -1; });
    });
  }

  function resumenResultados(anio) {
    const focos = focosVisibles(anio);
    const quemadas = quemadasVisibles(anio);
    const partes = [];
    if (capaActiva("focos")) partes.push(fmt(focos.length) + " focos de calor");
    if (capaActiva("quemadas")) {
      partes.push(fmt(quemadas.length) + " áreas quemadas (" + fmt(quemadas.length * 25) + " km² estimados)");
    }
    if (!partes.length) {
      return "No hay capas de focos ni de áreas quemadas activas en esta exportación. " +
        "Actívalas para incluir el análisis de actividad y superficie afectada.";
    }
    const periodo = anio == null ? "el periodo 2012–2026" : "el año " + anio;
    let texto = "Durante " + periodo + " se contabilizaron " + joinNatural(partes) + ".";
    if (capaActiva("deptos")) {
      const top = resumenActivo(anio).slice(0, 3);
      if (top.length) {
        texto += " Los departamentos con mayor actividad fueron " +
          top.map(function (d) { return d.nombre + " (" + fmt(d.focos) + " focos)"; }).join(", ") + ".";
      }
    }
    if (capaActiva("quemadas")) {
      texto += " La superficie quemada se estima a partir de la resolución de 5 km de la fuente MCD64A1.";
    }
    return texto;
  }

  function resumenDepartamentos(anio) {
    return resumenDesde(focosDeAnio(anio), quemadasDeAnio(anio));
  }

  function anioPico() {
    const porAnio = META.focos_por_anio || {};
    let mejor = null;
    Object.keys(porAnio).forEach(function (anio) {
      if (mejor == null || Number(porAnio[anio]) > Number(porAnio[mejor])) mejor = anio;
    });
    return mejor;
  }

  const TOP_AREAS = (D.areas_puntos || []).slice().sort(function (a, b) {
    return (Number(b.area_ha) || 0) - (Number(a.area_ha) || 0);
  }).slice(0, 6);

  /* ----------------------------- Estado local ---------------------------- */
  const REPORT_KEY = "visor_informe_v1";
  const SYNC_KEY = "visor_sync_v1";
  const SYNC_STORE_KEY = "visor_sync_store_v1";

  const REPORT_DEFAULTS = {
    title: "Informe técnico de incendios forestales en Colombia",
    author: "Equipo técnico del visor nacional",
    role: "Análisis SIG y teledetección",
    obs: "",
    conclusions: "",
    recommendations: "",
  };

  let report = Object.assign({}, REPORT_DEFAULTS, loadJSON(REPORT_KEY, {}) || {});

  let syncState = loadJSON(SYNC_KEY, { queue: [], last: null, synced: 0 }) || {};
  syncState.queue = Array.isArray(syncState.queue) ? syncState.queue : [];
  syncState.synced = Number(syncState.synced) || 0;
  let autoSyncTimer = null;
  let flushing = false;

  /* ------------------------------ Narrativa ------------------------------ */
  function narrativa(anio) {
    const focos = focosVisibles(anio);
    const quemadas = quemadasVisibles(anio);
    const deptos = resumenActivo(anio);
    const top = deptos.slice(0, 3);
    const pico = anioPico();
    const obs =
      resumenResultados(anio) + " " +
      (pico && capaActiva("focos")
        ? "El año con mayor número de focos del periodo fue " + pico + ". "
        : "") +
      (capaActiva("focos") || capaActiva("quemadas")
        ? "La distribución espacial evidencia una mayor presión en la Orinoquía y el Caribe, " +
          "asociada a la temporada seca y a las prácticas de quema agropecuaria."
        : "El informe se limita a las capas activas y no incluye series de actividad desactivadas.");

    const conclusiones = [];
    if (capaActiva("focos") || capaActiva("quemadas")) {
      conclusiones.push("La actividad de incendios mantiene una relación directa con la estacionalidad seca y con el uso agropecuario del suelo.");
    }
    if (capaActiva("deptos") && top.length) {
      conclusiones.push(
        "Los departamentos de la Orinoquía concentran la mayor cantidad de focos" +
        (capaActiva("areas")
          ? ", mientras que las áreas protegidas conservan una exposición relevante."
          : ".")
      );
    }
    if (capaActiva("susceptibilidad")) {
      conclusiones.push("La capa de susceptibilidad permite priorizar la vigilancia en municipios con alta probabilidad y baja capacidad de respuesta.");
    }
    if (capaActiva("areas")) {
      conclusiones.push("Las áreas protegidas se visualizan únicamente mediante polígonos morados, sin viñetas ni marcadores superpuestos.");
    }
    if (capaActiva("bosques")) {
      conclusiones.push("Las coberturas de bosque de referencia ayudan a contextualizar la exposición de los ecosistemas frente a los focos activos.");
    }
    if (!conclusiones.length) {
      conclusiones.push("El documento se limita a las capas activas seleccionadas por el usuario en el visor.");
    }

    const recomendaciones = [];
    if (capaActiva("focos") || capaActiva("quemadas")) {
      recomendaciones.push("Priorizar el monitoreo satelital y las alertas tempranas en los departamentos con mayor recurrencia de focos.");
      recomendaciones.push("Fortalecer los acuerdos de quema controlada y la asistencia técnica agropecuaria en la Orinoquía y el Caribe.");
    }
    recomendaciones.push("Integrar el visor con los sistemas departamentales de gestión del riesgo y actualizar el modelo cada temporada seca.");
    if (capaActiva("areas") || capaActiva("bosques")) {
      const recursos = [];
      if (capaActiva("bosques")) recursos.push("los bosques");
      if (capaActiva("areas")) recursos.push("las áreas protegidas");
      recomendaciones.push("Proteger " + joinNatural(recursos) + " con acciones de prevención y restauración en las zonas de mayor susceptibilidad.");
    }

    function numerar(lista) {
      return lista.map(function (texto, i) { return (i + 1) + ". " + texto; }).join("\n");
    }

    return {
      obs: obs,
      conclusions: numerar(conclusiones),
      recommendations: numerar(recomendaciones),
    };
  }

  function textoNarrativa(campo) {
    const propio = String(report[campo] || "").trim();
    if (propio) return propio;
    return narrativa(state.year)[campo];
  }

  function parrafos(texto) {
    return String(texto || "").split(/\n+/).map(function (linea) {
      return linea.trim();
    }).filter(Boolean);
  }

  /* ------------------------------- Gráficos ------------------------------ */
  function tendenciaSvg() {
    const usaFocos = capaActiva("focos");
    const usaQuemadas = capaActiva("quemadas");
    if (!usaFocos && !usaQuemadas) return "";
    const anios = (META.anios || ANIOS).map(Number);
    const focos = META.focos_por_anio || {};
    const quemadas = META.quemadas_por_anio || {};
    const valorF = function (a) { return usaFocos ? (Number(focos[a]) || 0) : 0; };
    const valorQ = function (a) { return usaQuemadas ? (Number(quemadas[a]) || 0) : 0; };
    const W = 640;
    const H = 168;
    const padL = 26;
    const padR = 8;
    const padT = 12;
    const padB = 24;
    const max = Math.max(1, ...anios.map(function (a) { return Math.max(valorF(a), valorQ(a)); }));
    const plotW = W - padL - padR;
    const plotH = H - padT - padB;
    const step = plotW / anios.length;
    const barW = Math.max(3, step * 0.28);
    let barras = "";
    let etiquetas = "";
    anios.forEach(function (anio, i) {
      const x = padL + i * step + step / 2;
      const hf = valorF(anio) / max * plotH;
      const hq = valorQ(anio) / max * plotH;
      const activo = state.year === anio;
      if (usaFocos) {
        barras +=
          '<rect x="' + (x - barW - 1) + '" y="' + (padT + plotH - hf) + '" width="' + barW + '" height="' + hf +
          '" rx="1.5" fill="' + (activo ? "#ff5a3c" : "#f97316") + '" opacity="' + (activo ? "1" : "0.55") + '"></rect>';
      }
      if (usaQuemadas) {
        barras +=
          '<rect x="' + (x + 1) + '" y="' + (padT + plotH - hq) + '" width="' + barW + '" height="' + hq +
          '" rx="1.5" fill="' + (activo ? "#fbbf24" : "#f59e0b") + '" opacity="' + (activo ? "1" : "0.45") + '"></rect>';
      }
      if (i === 0 || i === anios.length - 1 || i % 3 === 0 || activo) {
        etiquetas += '<text x="' + x + '" y="' + (H - 8) + '" text-anchor="middle" font-size="7.5" fill="#64748b">' + anio + "</text>";
      }
    });
    let grid = "";
    for (let i = 0; i <= 3; i++) {
      const y = padT + (plotH / 3) * i;
      grid += '<line x1="' + padL + '" y1="' + y + '" x2="' + (W - padR) + '" y2="' + y + '" stroke="#e2e8f0" stroke-width="0.7"></line>';
    }
    let leyenda = "";
    let leyendaX = padL;
    if (usaFocos) {
      leyenda += '<rect x="' + leyendaX + '" y="' + (padT + plotH + 3) + '" width="8" height="8" rx="2" fill="#f97316"></rect>' +
        '<text x="' + (leyendaX + 12) + '" y="' + (padT + plotH + 10) + '" font-size="7.5" fill="#475569">Focos</text>';
      leyendaX += 58;
    }
    if (usaQuemadas) {
      leyenda += '<rect x="' + leyendaX + '" y="' + (padT + plotH + 3) + '" width="8" height="8" rx="2" fill="#f59e0b"></rect>' +
        '<text x="' + (leyendaX + 12) + '" y="' + (padT + plotH + 10) + '" font-size="7.5" fill="#475569">Quemadas</text>';
    }
    const aria = joinNatural([
      usaFocos ? "focos" : "",
      usaQuemadas ? "áreas quemadas" : "",
    ]);
    return (
      '<svg class="report-chart" viewBox="0 0 ' + W + " " + H + '" role="img" aria-label="Tendencia anual de ' + esc(aria) + '">' +
        grid + barras + etiquetas + leyenda +
      "</svg>"
    );
  }

  function tendenciaCanvas(width, height) {
    const usaFocos = capaActiva("focos");
    const usaQuemadas = capaActiva("quemadas");
    if (!usaFocos && !usaQuemadas) return null;
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    const anios = (META.anios || ANIOS).map(Number);
    const focos = META.focos_por_anio || {};
    const quemadas = META.quemadas_por_anio || {};
    const valorF = function (a) { return usaFocos ? (Number(focos[a]) || 0) : 0; };
    const valorQ = function (a) { return usaQuemadas ? (Number(quemadas[a]) || 0) : 0; };
    const padL = 42;
    const padR = 12;
    const padT = 18;
    const padB = 34;
    const max = Math.max(1, ...anios.map(function (a) {
      return Math.max(valorF(a), valorQ(a));
    }));
    const plotW = width - padL - padR;
    const plotH = height - padT - padB;
    const step = plotW / anios.length;
    const barW = Math.max(4, step * 0.28);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);
    ctx.strokeStyle = "#e2e8f0";
    ctx.lineWidth = 1;
    for (let i = 0; i <= 3; i++) {
      const y = padT + (plotH / 3) * i;
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(width - padR, y);
      ctx.stroke();
    }
    anios.forEach(function (anio, i) {
      const x = padL + i * step + step / 2;
      const hf = valorF(anio) / max * plotH;
      const hq = valorQ(anio) / max * plotH;
      const activo = state.year === anio;
      if (usaFocos) {
        ctx.fillStyle = activo ? "#ff5a3c" : "#f97316";
        ctx.globalAlpha = activo ? 1 : 0.55;
        ctx.fillRect(x - barW - 1, padT + plotH - hf, barW, hf);
      }
      if (usaQuemadas) {
        ctx.fillStyle = activo ? "#fbbf24" : "#f59e0b";
        ctx.globalAlpha = activo ? 1 : 0.45;
        ctx.fillRect(x + 1, padT + plotH - hq, barW, hq);
      }
      ctx.globalAlpha = 1;
      if (i === 0 || i === anios.length - 1 || i % 3 === 0 || activo) {
        ctx.fillStyle = "#64748b";
        ctx.font = "11px Arial";
        ctx.textAlign = "center";
        ctx.fillText(String(anio), x, height - 12);
      }
    });
    ctx.textAlign = "left";
    ctx.font = "11px Arial";
    let lx = padL;
    if (usaFocos) {
      ctx.fillStyle = "#f97316";
      ctx.fillRect(lx, height - 8, 8, 8);
      ctx.fillStyle = "#475569";
      ctx.fillText("Focos", lx + 12, height - 1);
      lx += 66;
    }
    if (usaQuemadas) {
      ctx.fillStyle = "#f59e0b";
      ctx.fillRect(lx, height - 8, 8, 8);
      ctx.fillStyle = "#475569";
      ctx.fillText("Quemadas", lx + 12, height - 1);
    }
    return canvas;
  }

  /* ---------------------------- Informe HTML ----------------------------- */
  function buildReportHTML() {
    const anio = state.year;
    const focos = focosVisibles(anio);
    const quemadas = quemadasVisibles(anio);
    const deptos = resumenActivo(anio);
    const top = deptos.slice(0, 8);
    const km2 = quemadas.length * 25;
    const fecha = new Date().toLocaleDateString("es-CO", { day: "2-digit", month: "long", year: "numeric" });
    const periodo = anio == null ? "Periodo 2012–2026" : "Año " + anio;
    const obs = textoNarrativa("obs");
    const conclusiones = textoNarrativa("conclusions");
    const recomendaciones = textoNarrativa("recommendations");
    const autor = String(report.author || REPORT_DEFAULTS.author).trim();
    const cargo = String(report.role || REPORT_DEFAULTS.role).trim();

    const usaFocos = capaActiva("focos");
    const usaQuemadas = capaActiva("quemadas");
    const usaDeptos = capaActiva("deptos");
    const usaAreas = capaActiva("areas");
    const totalVisible = Math.max(1, focos.length + quemadas.length);
    const mostrarParticipacion = usaFocos || usaQuemadas;

    const ths = ["<th>Departamento</th>"];
    if (usaFocos) ths.push("<th>Focos</th>");
    if (usaQuemadas) ths.push("<th>Quemadas</th>");
    if (mostrarParticipacion) ths.push("<th>Participación</th>");
    const colspan = ths.length;
    const filas = top.map(function (d) {
      let celdas = "<td>" + esc(d.nombre) + "</td>";
      if (usaFocos) celdas += "<td>" + fmt(d.focos) + "</td>";
      if (usaQuemadas) celdas += "<td>" + fmt(d.quemadas) + "</td>";
      if (mostrarParticipacion) {
        celdas += "<td>" + fmt(((d.focos + d.quemadas) / totalVisible * 100).toFixed(1)) + " %</td>";
      }
      return "<tr>" + celdas + "</tr>";
    }).join("");

    const tabla = (usaDeptos && mostrarParticipacion)
      ? "<table class=\"report-table\"><thead><tr>" + ths.join("") + "</tr></thead><tbody>" +
        (filas || '<tr><td colspan="' + colspan + '">Sin registros para el periodo seleccionado.</td></tr>') +
        "</tbody></table>"
      : "";

    const areas = areasVisibles().map(function (a) {
      return "<li>" + esc(a.nombre) + " · " + esc(prettyDepto(a.depto) || "Sin departamento") +
        " · " + fmt(a.area_ha) + " ha</li>";
    }).join("");

    const metricas = [];
    if (usaFocos) metricas.push([fmt(focos.length), "Focos de calor"]);
    if (usaQuemadas) {
      metricas.push([fmt(quemadas.length), "Áreas quemadas"]);
      metricas.push([fmt(km2), "km² quemados (est.)"]);
    }
    if (usaAreas) metricas.push([fmt((D.areas_puntos || []).length), "Áreas protegidas"]);
    if (usaDeptos) metricas.push([fmt(deptos.length), "Departamentos"]);
    const metricsHTML = metricas.length
      ? '<div class="report-metrics">' + metricas.map(function (m) {
          return "<div><b>" + m[0] + "</b><small>" + esc(m[1]) + "</small></div>";
        }).join("") + "</div>"
      : "";

    const listaConclusiones = parrafos(conclusiones).map(function (p) {
      return "<li>" + esc(p.replace(/^\d+\.\s*/, "")) + "</li>";
    }).join("");
    const listaRecomendaciones = parrafos(recomendaciones).map(function (p) {
      return "<li>" + esc(p.replace(/^\d+\.\s*/, "")) + "</li>";
    }).join("");

    const secciones = [];
    secciones.push({ title: "Resumen ejecutivo", html: "<p>" + esc(obs) + "</p>" });
    secciones.push({ title: "Metodología", html: "<p>" + esc(metodologiaActiva()) + "</p>" });

    let resultados = "";
    if (usaFocos || usaQuemadas) {
      resultados += tendenciaSvg();
      resultados += "<p>" + esc(resumenResultados(anio)) + "</p>";
      resultados += tabla;
    }
    if (resultados) secciones.push({ title: "Resultados del periodo", html: resultados });

    if (capaActiva("susceptibilidad")) {
      const riesgo = calcularRiesgoDeptos();
      const topRiesgo = Object.keys(riesgo).map(function (n) {
        return { nombre: n, r: riesgo[n] };
      }).sort(function (a, b) { return b.r.riesgo - a.r.riesgo; }).slice(0, 10);
      const riesgoHTML =
        '<p>La susceptibilidad a incendios forestales se estima a partir de la densidad de focos de calor ' +
        'y áreas quemadas del periodo seleccionado, normalizada a una escala relativa de 0 a 100 %. El valor ' +
        'representa la probabilidad relativa de incendio por departamento. Los departamentos con mayor ' +
        'probabilidad de incendio son:</p>' +
        '<table class="report-table"><thead><tr><th>Departamento</th><th>Focos</th><th>Quemadas</th><th>Riesgo</th></tr></thead><tbody>' +
        (topRiesgo.map(function (item) {
          return '<tr><td>' + esc(prettyDepto(item.nombre) || item.nombre) + '</td><td>' + fmt(item.r.focos) +
            '</td><td>' + fmt(item.r.quemadas) + '</td><td><b>' + item.r.riesgo + ' %</b></td></tr>';
        }).join("") || '<tr><td colspan="4">Sin registros para el periodo seleccionado.</td></tr>') +
        '</tbody></table>';
      secciones.push({ title: "Análisis de susceptibilidad", html: riesgoHTML });
    }

    if (usaAreas) {
      secciones.push({
        title: "Áreas protegidas",
        html: "<p>Las áreas protegidas de mayor extensión del sistema nacional se relacionan a continuación " +
          "como referencia para la gestión del riesgo y la conservación. En el mapa se representan " +
          "únicamente mediante polígonos morados, sin viñetas ni marcadores.</p>" +
          "<ul>" + (areas || "<li>Sin áreas disponibles.</li>") + "</ul>",
      });
    }

    secciones.push({ title: "Conclusiones", html: "<ul>" + listaConclusiones + "</ul>" });
    secciones.push({ title: "Recomendaciones", html: "<ul>" + listaRecomendaciones + "</ul>" });
    secciones.push({
      title: "Fuentes y trazabilidad",
      html: "<p>Fuentes: " + esc(fuentesActivas().join(" · ") || "sin fuentes asociadas a las capas activas") +
        ". Generado el " + esc(fecha) +
        " con el visor autocontenido. El documento incluye únicamente las capas activas: " +
        esc(capasResumenTexto()) + ". La información es de referencia y no sustituye la cartografía " +
        "oficial del IGAC ni los reportes de las autoridades ambientales.</p>",
    });

    const cuerpo = secciones.map(function (seccion, i) {
      return "<h2>" + (i + 1) + ". " + esc(seccion.title) + "</h2>" + seccion.html;
    }).join("");

    return (
      '<div class="report-brand">' +
        '<div class="report-brand-mark">IGAC</div>' +
        '<div class="report-brand-text"><strong>República de Colombia · Visor nacional</strong>' +
          '<small>Incendios forestales · Datos GEE · Random Forest</small></div>' +
        '<div class="report-brand-date">' + esc(fecha) + "<br>" + esc(periodo) + "</div>" +
      "</div>" +
      "<h1>" + esc(report.title || REPORT_DEFAULTS.title) + "</h1>" +
      '<p class="report-subtitle">' + esc(periodo) + " · Colombia · Documento técnico de referencia</p>" +
      metricsHTML +
      cuerpo +
      '<div class="report-sign">' +
        '<div class="report-sign-box"><div class="report-sign-line"></div>' +
          "<strong>" + esc(autor) + "</strong><small>" + esc(cargo) + "</small></div>" +
      "</div>" +
      '<div class="report-footer">Visor nacional de incendios forestales · Colombia · ' +
        esc(fecha) + " · Documento generado localmente</div>"
    );
  }

  function refreshReportPreview() {
    const html = buildReportHTML();
    if (UI.reportPreview) UI.reportPreview.innerHTML = html;
    if (UI.integralReport) UI.integralReport.innerHTML = html;
    if (UI.integralReportMeta) {
      const partes = [];
      if (capaActiva("focos")) partes.push(fmt(focosVisibles(state.year).length) + " focos");
      if (capaActiva("quemadas")) partes.push(fmt(quemadasVisibles(state.year).length) + " quemadas");
      if (capaActiva("areas")) partes.push(fmt((D.areas_puntos || []).length) + " áreas");
      UI.integralReportMeta.textContent =
        (state.year == null ? "Todos los años" : "Año " + state.year) + " · " +
        (partes.length ? partes.join(" · ") : "sin capas activas");
    }
  }

  /* ----------------------------- Formulario ------------------------------ */
  const REPORT_FIELDS = {
    repTitle: "title",
    repAuthor: "author",
    repRole: "role",
    repObs: "obs",
    repConclusions: "conclusions",
    repRecommendations: "recommendations",
  };

  let saveBadgeTimer = null;
  function markStudySaving() {
    if (!UI.studySave) return;
    UI.studySave.classList.add("saving");
    UI.studySave.innerHTML = '<span class="dot"></span> Guardando…';
    clearTimeout(saveBadgeTimer);
  }

  function markStudySaved() {
    if (!UI.studySave) return;
    UI.studySave.classList.remove("saving");
    UI.studySave.innerHTML = '<span class="dot"></span> Guardado local';
    clearTimeout(saveBadgeTimer);
    saveBadgeTimer = setTimeout(function () {
      if (UI.studySave) UI.studySave.innerHTML = '<span class="dot"></span> Guardado local';
    }, 1200);
  }

  const persistReport = debounce(function () {
    saveJSON(REPORT_KEY, report);
    queueSync("informe", { title: report.title, year: state.year });
    markStudySaved();
  }, 550);

  let reportFormReady = false;
  function initReportForm() {
    if (!UI.repTitle) return;
    if (!reportFormReady) {
      Object.keys(REPORT_FIELDS).forEach(function (id) {
        const input = UI[id];
        if (!input) return;
        input.value = String(report[REPORT_FIELDS[id]] || "");
        input.addEventListener("input", function () {
          report[REPORT_FIELDS[id]] = input.value;
          markStudySaving();
          persistReport();
          scheduleReportPreview();
        });
      });
      reportFormReady = true;
    }
  }

  const scheduleReportPreview = debounce(function () {
    refreshReportPreview();
  }, 140);

  /* ------------------------------- QR ------------------------------------ */
  function shareUrl() {
    const base = location.href.split("#")[0].split("?")[0];
    const params = new URLSearchParams();
    if (state.year != null) params.set("year", String(state.year));
    if (state.category !== "todas") params.set("cat", state.category);
    const consulta = state.query.trim();
    if (consulta) params.set("q", consulta);
    if (lastResults.length) params.set("fit", "1");
    const qs = params.toString();
    return base + (qs ? "?" + qs : "");
  }

  function drawQR(canvas, texto, cssSize) {
    if (!canvas) return;
    const size = cssSize || 232;
    try {
      if (typeof qrcode !== "function") throw new Error("QR no disponible");
      const qr = qrcode(0, "M");
      qr.addData(texto);
      qr.make();
      const count = qr.getModuleCount();
      const quiet = 4;
      const total = count + quiet * 2;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const px = Math.max(2, Math.ceil((size * dpr) / total));
      canvas.width = total * px;
      canvas.height = total * px;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = "#0f172a";
      for (let r = 0; r < count; r++) {
        for (let c = 0; c < count; c++) {
          if (qr.isDark(r, c)) {
            ctx.fillRect((c + quiet) * px, (r + quiet) * px, px, px);
          }
        }
      }
      canvas.style.width = size + "px";
      canvas.style.height = size + "px";
    } catch (err) {
      const ctx = canvas.getContext("2d");
      canvas.width = 232;
      canvas.height = 232;
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, 232, 232);
      ctx.fillStyle = "#0f172a";
      ctx.font = "12px Arial";
      ctx.textAlign = "center";
      ctx.fillText("QR no disponible", 116, 116);
    }
  }

  function renderQrTab() {
    const url = shareUrl();
    if (UI.qrLink) UI.qrLink.value = url;
    drawQR(UI.qrCanvas, url, 232);
    const resumen = resumenActivo(state.year);
    const top = resumen[0];
    const partes = [];
    if (capaActiva("focos")) partes.push(fmt(focosVisibles(state.year).length) + " focos");
    if (capaActiva("quemadas")) partes.push(fmt(quemadasVisibles(state.year).length) + " quemadas");
    if (capaActiva("areas")) partes.push(fmt((D.areas_puntos || []).length) + " áreas");
    if (UI.qrCaption) {
      UI.qrCaption.textContent =
        (state.year == null ? "Todos los años" : "Año " + state.year) +
        " · " + (partes.length ? partes.join(" · ") : "sin capas activas");
    }
    if (UI.qrYear) UI.qrYear.textContent = state.year == null ? "Todos" : String(state.year);
    if (UI.qrSummary) {
      UI.qrSummary.textContent = top
        ? "Mayor actividad: " + top.nombre + " (" + fmt(top.focos) + " focos). " +
          "Capas activas: " + capasResumenTexto() + "."
        : "Sin registros para las capas activas. Capas activas: " + capasResumenTexto() + ".";
    }
    updateSyncUI();
  }

  function copiarEnlace() {
    const url = shareUrl();
    const ok = function () {
      Toast.success("Enlace copiado", "Puedes compartirlo o abrirlo en otro dispositivo.", "link");
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(ok).catch(function () { fallback(); });
    } else {
      fallback();
    }
    function fallback() {
      const input = document.createElement("textarea");
      input.value = url;
      input.style.position = "fixed";
      input.style.opacity = "0";
      document.body.appendChild(input);
      input.select();
      try { document.execCommand("copy"); ok(); }
      catch (err) { Toast.error("No se pudo copiar", "Selecciona el enlace manualmente.", "link"); }
      input.remove();
    }
  }

  function descargarCanvas(canvas, nombre) {
    if (!canvas) return;
    const enlace = document.createElement("a");
    enlace.href = canvas.toDataURL("image/png");
    enlace.download = nombre;
    document.body.appendChild(enlace);
    enlace.click();
    enlace.remove();
    Toast.success("Descarga lista", nombre, "download");
  }

  /* --------------------------- QR rápido visible ------------------------- */
  function quickQrCaptionText() {
    const activas = capasActivas().map(function (l) { return LAYER_SHORT[l.id] || l.name; });
    if (state.firms && state.firms.active) activas.push("FIRMS");
    const resumen = activas.length ? activas.join(" · ") : "sin capas activas";
    return (state.year == null ? "Todos los años" : "Año " + state.year) + " · " + resumen;
  }

  function renderQuickQr() {
    if (!els.quickQrCanvas) return;
    drawQR(els.quickQrCanvas, shareUrl(), 148);
    if (els.quickQrCaption) els.quickQrCaption.textContent = quickQrCaptionText();
  }

  function refreshQuickQr() {
    if (!els.quickQrCard || els.quickQrCard.classList.contains("hidden")) return;
    renderQuickQr();
  }

  function toggleQuickQr(force) {
    if (!els.quickQrCard || !els.btnQuickQr) return;
    const open = typeof force === "boolean"
      ? force
      : els.quickQrCard.classList.contains("hidden");
    els.quickQrCard.classList.toggle("hidden", !open);
    els.btnQuickQr.classList.toggle("active", open);
    els.btnQuickQr.setAttribute("aria-expanded", open ? "true" : "false");
    if (open) renderQuickQr();
  }

  function initQuickQr() {
    if (!els.btnQuickQr || !els.quickQrCard) return;
    els.btnQuickQr.setAttribute("aria-expanded", "false");
    els.btnQuickQr.addEventListener("click", function (event) {
      event.stopPropagation();
      toggleQuickQr();
    });
    if (els.quickQrClose) {
      els.quickQrClose.addEventListener("click", function (event) {
        event.stopPropagation();
        toggleQuickQr(false);
      });
    }
    if (els.quickQrCopy) els.quickQrCopy.addEventListener("click", copiarEnlace);
    if (els.quickQrDownload) {
      els.quickQrDownload.addEventListener("click", function () {
        renderQuickQr();
        descargarCanvas(
          els.quickQrCanvas,
          "qr_visor_incendios_" + (state.year == null ? "todos" : state.year) + ".png"
        );
      });
    }
    document.addEventListener("click", function (event) {
      if (els.quickQrCard.classList.contains("hidden")) return;
      if (els.quickQrCard.contains(event.target) || els.btnQuickQr.contains(event.target)) return;
      toggleQuickQr(false);
    });
    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape") toggleQuickQr(false);
    });
  }

  /* ------------------------------- IGAC ---------------------------------- */
  const IGAC_FORMATS = {
    a4l: { w: 2400, h: 1697, nombre: "A4 horizontal" },
    a4p: { w: 1697, h: 2400, nombre: "A4 vertical" },
    carta: { w: 2550, h: 1650, nombre: "Carta horizontal" },
  };

  let igacImage = null;
  let igacImagePromise = null;
  function cargarImagenIgac() {
    const fuente = ASSETS.igac || ASSETS.jpg;
    if (!fuente) return Promise.resolve(null);
    if (igacImage) return Promise.resolve(igacImage);
    if (igacImagePromise) return igacImagePromise;
    igacImagePromise = new Promise(function (resolve) {
      const img = new Image();
      img.onload = function () { igacImage = img; resolve(img); };
      img.onerror = function () { resolve(null); };
      img.src = fuente;
    });
    return igacImagePromise;
  }

  /* ------------------- Plano IGAC dinámico por capas --------------------- */
  const rasterImages = {};
  const rasterPromises = {};

  function cargarRaster(nombre) {
    const b64 = RASTER[nombre];
    if (!b64) return Promise.resolve(null);
    if (rasterImages[nombre]) return Promise.resolve(rasterImages[nombre]);
    if (rasterPromises[nombre]) return rasterPromises[nombre];
    rasterPromises[nombre] = new Promise(function (resolve) {
      const img = new Image();
      img.onload = function () { rasterImages[nombre] = img; resolve(img); };
      img.onerror = function () { resolve(null); };
      img.src = "data:image/png;base64," + b64;
    });
    return rasterPromises[nombre];
  }

  async function cargarRasteresActivos() {
    const tareas = [];
    if (capaActiva("bosques")) tareas.push(cargarRaster("bosque"));
    if (capaActiva("agua")) tareas.push(cargarRaster("agua"));
    if (capaActiva("susceptibilidad")) tareas.push(cargarRaster("susceptibilidad"));
    await Promise.all(tareas);
  }

  // Proyección geográfica equivalente a la usada por generar_mapa_igac.py:
  // longitud lineal y latitud corregida por el coseno de la latitud media.
  function igacProyeccion(mapX, mapY, mapW, mapH) {
    const latMin = BOUNDS[0][0];
    const lonMin = BOUNDS[0][1];
    const latMax = BOUNDS[1][0];
    const lonMax = BOUNDS[1][1];
    const latMedia = ((latMin + latMax) / 2) * Math.PI / 180;
    const aspecto = ((lonMax - lonMin) * Math.cos(latMedia)) / (latMax - latMin);
    let w = mapW;
    let h = mapW / aspecto;
    if (h > mapH) {
      h = mapH;
      w = mapH * aspecto;
    }
    const x = mapX + (mapW - w) / 2;
    const y = mapY + (mapH - h) / 2;
    return {
      x: x,
      y: y,
      w: w,
      h: h,
      project: function (lon, lat) {
        return [
          x + ((Number(lon) - lonMin) / (lonMax - lonMin)) * w,
          y + ((latMax - Number(lat)) / (latMax - latMin)) * h,
        ];
      },
    };
  }

  function pathAnillo(ctx, anillo, proj) {
    if (!anillo || anillo.length < 2) return;
    anillo.forEach(function (c, i) {
      const p = proj.project(c[0], c[1]);
      if (i === 0) ctx.moveTo(p[0], p[1]);
      else ctx.lineTo(p[0], p[1]);
    });
    ctx.closePath();
  }

  function dibujarPoligono(ctx, anillos, proj, estilo) {
    if (!anillos || !anillos.length) return;
    ctx.beginPath();
    anillos.forEach(function (anillo) { pathAnillo(ctx, anillo, proj); });
    if (estilo.fill) {
      ctx.fillStyle = estilo.fill;
      ctx.fill("evenodd");
    }
    if (estilo.stroke) {
      ctx.strokeStyle = estilo.stroke;
      ctx.lineWidth = estilo.width || 1;
      ctx.stroke();
    }
  }

  function dibujarLinea(ctx, coords, proj, estilo) {
    if (!coords || coords.length < 2) return;
    ctx.beginPath();
    coords.forEach(function (c, i) {
      const p = proj.project(c[0], c[1]);
      if (i === 0) ctx.moveTo(p[0], p[1]);
      else ctx.lineTo(p[0], p[1]);
    });
    ctx.strokeStyle = estilo.stroke;
    ctx.lineWidth = estilo.width || 1;
    ctx.stroke();
  }

  function dibujarGeometria(ctx, geom, proj, estilo) {
    if (!geom) return;
    const tipo = geom.type;
    if (tipo === "GeometryCollection") {
      (geom.geometries || []).forEach(function (g) { dibujarGeometria(ctx, g, proj, estilo); });
    } else if (tipo === "Polygon") {
      dibujarPoligono(ctx, geom.coordinates || [], proj, estilo);
    } else if (tipo === "MultiPolygon") {
      (geom.coordinates || []).forEach(function (poly) { dibujarPoligono(ctx, poly, proj, estilo); });
    } else if (tipo === "LineString") {
      dibujarLinea(ctx, geom.coordinates || [], proj, estilo);
    } else if (tipo === "MultiLineString") {
      (geom.coordinates || []).forEach(function (linea) { dibujarLinea(ctx, linea, proj, estilo); });
    }
  }

  function dibujarFeatures(ctx, features, proj, estilo) {
    (features || []).forEach(function (f) {
      if (f && f.geometry) dibujarGeometria(ctx, f.geometry, proj, estilo);
    });
  }

  function dibujarPunto(ctx, proj, lon, lat, radio, relleno, borde) {
    const p = proj.project(lon, lat);
    ctx.beginPath();
    ctx.arc(p[0], p[1], radio, 0, Math.PI * 2);
    if (relleno) {
      ctx.fillStyle = relleno;
      ctx.fill();
    }
    if (borde) {
      ctx.strokeStyle = borde;
      ctx.lineWidth = 0.7;
      ctx.stroke();
    }
  }

  function dibujarRosa(ctx, x, y, r) {
    ctx.save();
    ctx.translate(x, y);
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(255,255,255,0.94)";
    ctx.fill();
    ctx.strokeStyle = "#1f2937";
    ctx.lineWidth = Math.max(1.5, r * 0.025);
    ctx.stroke();
    for (let i = 0; i < 8; i++) {
      const ang = (Math.PI / 4) * i - Math.PI / 2;
      const largo = i % 2 === 0 ? r * 0.78 : r * 0.48;
      const ancho = i % 2 === 0 ? r * 0.16 : r * 0.1;
      ctx.beginPath();
      ctx.moveTo(Math.cos(ang) * largo, Math.sin(ang) * largo);
      ctx.lineTo(Math.cos(ang + Math.PI / 2) * ancho, Math.sin(ang + Math.PI / 2) * ancho);
      ctx.lineTo(Math.cos(ang - Math.PI / 2) * ancho, Math.sin(ang - Math.PI / 2) * ancho);
      ctx.closePath();
      ctx.fillStyle = i === 0 ? "#b91c1c" : (i % 2 === 0 ? "#1f2937" : "#94a3b8");
      ctx.fill();
    }
    ctx.beginPath();
    ctx.arc(0, 0, r * 0.14, 0, Math.PI * 2);
    ctx.fillStyle = "#fbf7ee";
    ctx.fill();
    ctx.strokeStyle = "#1f2937";
    ctx.stroke();
    ctx.fillStyle = "#1f2937";
    ctx.font = "bold " + Math.round(r * 0.28) + "px Arial";
    ctx.textAlign = "center";
    ctx.fillText("N", 0, -r * 0.9);
    ctx.restore();
  }

  function dibujarEscala(ctx, x, y, km, ancho, oscuro) {
    const segmentos = 5;
    const alto = 10;
    const seg = ancho / segmentos;
    ctx.save();
    ctx.fillStyle = oscuro ? "rgba(15,23,42,0.9)" : "rgba(255,255,255,0.94)";
    ctx.strokeStyle = oscuro ? "rgba(255,255,255,0.35)" : "#94a3b8";
    ctx.lineWidth = 1;
    ctx.fillRect(x - 10, y - 22, ancho + 20, 54);
    ctx.strokeRect(x - 10, y - 22, ancho + 20, 54);
    for (let i = 0; i < segmentos; i++) {
      ctx.fillStyle = i % 2 === 0 ? (oscuro ? "#e2e8f0" : "#1f2937") : (oscuro ? "#334155" : "#ffffff");
      ctx.fillRect(x + i * seg, y, seg, alto);
      ctx.strokeStyle = oscuro ? "rgba(255,255,255,0.55)" : "#1f2937";
      ctx.strokeRect(x + i * seg, y, seg, alto);
    }
    ctx.fillStyle = oscuro ? "#e2e8f0" : "#1f2937";
    ctx.font = "10px Arial";
    ctx.textAlign = "center";
    for (let i = 0; i <= segmentos; i++) {
      ctx.fillText(String(Math.round(km / segmentos * i)), x + i * seg, y + alto + 13);
    }
    ctx.textAlign = "left";
    ctx.font = "bold 10px Arial";
    ctx.fillText("Escala gráfica (km)", x, y - 8);
    ctx.restore();
  }

  function dibujarLeyenda(ctx, x, y, ancho, oscuro) {
    const activas = capasActivas();
    const filas = activas.slice(0, 9);
    const extras = [];
    if (capaActiva("focos")) extras.push("focos");
    if (state.firms && state.firms.active) extras.push("firms");
    const alto = 30 + filas.length * 22 + extras.length * 18 + 30 + (capaActiva("susceptibilidad") ? 22 : 0);
    ctx.save();
    ctx.fillStyle = oscuro ? "rgba(15,23,42,0.9)" : "rgba(255,255,255,0.95)";
    ctx.strokeStyle = oscuro ? "rgba(255,255,255,0.32)" : "#94a3b8";
    ctx.lineWidth = 1.5;
    ctx.fillRect(x, y, ancho, alto);
    ctx.strokeRect(x, y, ancho, alto);
    ctx.fillStyle = oscuro ? "#f8fafc" : "#1f2937";
    ctx.font = "bold 12px Arial";
    ctx.textAlign = "left";
    ctx.fillText("LEYENDA", x + 12, y + 20);
    let cursor = y + 38;
    filas.forEach(function (layer) {
      if (layer.id === "susceptibilidad") {
        const gx = x + 12;
        const gw = Math.min(80, ancho - 70);
        const gy = cursor - 9;
        const gh = 10;
        const grad = ctx.createLinearGradient(gx, 0, gx + gw, 0);
        grad.addColorStop(0, "#1a9850");
        grad.addColorStop(0.5, "#ffffbf");
        grad.addColorStop(1, "#d73027");
        ctx.fillStyle = grad;
        ctx.fillRect(gx, gy, gw, gh);
        ctx.strokeStyle = oscuro ? "rgba(255,255,255,0.55)" : "#1f2937";
        ctx.strokeRect(gx, gy, gw, gh);
        ctx.fillStyle = oscuro ? "#e2e8f0" : "#334155";
        ctx.font = "11px Arial";
        ctx.fillText("Susceptibilidad (riesgo)", gx + gw + 10, cursor);
        cursor += 16;
        ctx.font = "8px Arial";
        ctx.fillStyle = oscuro ? "#cbd5e1" : "#64748b";
        ctx.fillText("Baja", gx, cursor);
        ctx.fillText("Alta", gx + gw - 14, cursor);
        cursor += 16;
        return;
      }
      const punto = ["focos"].indexOf(layer.kind) >= 0;
      if (punto) {
        ctx.beginPath();
        ctx.arc(x + 18, cursor - 4, 5, 0, Math.PI * 2);
        ctx.fillStyle = layer.color;
        ctx.fill();
        ctx.strokeStyle = oscuro ? "#fff" : "#1f2937";
        ctx.lineWidth = 1;
        ctx.stroke();
      } else {
        ctx.fillStyle = layer.color;
        ctx.fillRect(x + 12, cursor - 9, 12, 10);
        ctx.strokeStyle = oscuro ? "rgba(255,255,255,0.55)" : "#1f2937";
        ctx.strokeRect(x + 12, cursor - 9, 12, 10);
      }
      ctx.fillStyle = oscuro ? "#e2e8f0" : "#334155";
      ctx.font = "11px Arial";
      const etiqueta = layer.id === "areas" ? "Áreas protegidas (polígonos)"
        : layer.id === "quemadas" ? "Áreas quemadas (polígonos)"
        : layer.name;
      ctx.fillText(etiqueta, x + 32, cursor);
      cursor += 22;
    });

    function subIntensidad() {
      let sx = x + 12;
      ctx.font = "9px Arial";
      INTENSIDAD.slice().reverse().forEach(function (lv) {
        ctx.beginPath();
        ctx.arc(sx + 3, cursor - 3, 3, 0, Math.PI * 2);
        ctx.fillStyle = lv.color;
        ctx.fill();
        ctx.fillStyle = oscuro ? "#cbd5e1" : "#475569";
        ctx.fillText(lv.label, sx + 9, cursor);
        sx += 9 + ctx.measureText(lv.label).width + 12;
      });
      cursor += 18;
    }
    if (capaActiva("focos")) subIntensidad();
    if (state.firms && state.firms.active) subIntensidad();

    ctx.strokeStyle = oscuro ? "rgba(255,255,255,0.22)" : "#cbd5e1";
    ctx.beginPath();
    ctx.moveTo(x + 12, cursor - 8);
    ctx.lineTo(x + ancho - 12, cursor - 8);
    ctx.stroke();

    const piezas = [];
    if (capaActiva("focos")) piezas.push(fmt(focosVisibles(state.year).length) + " focos");
    if (capaActiva("quemadas")) piezas.push(fmt(quemadasVisibles(state.year).length) + " quemadas");
    if (capaActiva("areas")) piezas.push(fmt((D.areas_puntos || []).length) + " áreas");
    if (state.firms && state.firms.active) piezas.push(fmt(state.firms.count) + " FIRMS");
    ctx.fillStyle = oscuro ? "#cbd5e1" : "#475569";
    ctx.font = "9px Arial";
    ctx.fillText(
      (state.year == null ? "Periodo 2012–2026" : "Año " + state.year) +
      " · " + capasActivas().length + " capas activas",
      x + 12, cursor + 8
    );
    ctx.fillStyle = oscuro ? "#94a3b8" : "#64748b";
    ctx.fillText(piezas.length ? piezas.join(" · ") : "Sin datos activos", x + 12, cursor + 21);
    ctx.restore();
  }

  function dibujarBloqueTitulo(ctx, W, H, margen, alto, fecha) {
    const y = H - alto - 18;
    const x = margen;
    const ancho = W - margen * 2;
    ctx.save();
    ctx.fillStyle = "#fbf7ee";
    ctx.fillRect(x, y, ancho, alto);
    ctx.strokeStyle = "#1f2937";
    ctx.lineWidth = 2;
    ctx.strokeRect(x, y, ancho, alto);
    ctx.fillStyle = "#7f1d1d";
    ctx.fillRect(x, y, ancho, 6);
    const col = ancho / 4;
    for (let i = 1; i < 4; i++) {
      ctx.strokeStyle = "#cbd5e1";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x + col * i, y + 16);
      ctx.lineTo(x + col * i, y + alto - 26);
      ctx.stroke();
    }
    ctx.textAlign = "left";
    ctx.fillStyle = "#7f1d1d";
    ctx.font = "bold 10px Arial";
    ctx.fillText("TÍTULO", x + 12, y + 24);
    ctx.fillStyle = "#0f172a";
    ctx.font = "bold 16px Arial";
    ctx.fillText("Mapa nacional de incendios forestales", x + 12, y + 44);
    ctx.fillStyle = "#475569";
    ctx.font = "11px Arial";
    ctx.fillText(
      "Colombia · " + capasResumenTexto().slice(0, 82) + " · " +
      (state.year == null ? "Periodo 2012–2026" : "Año " + state.year),
      x + 12, y + 62
    );

    const col2 = x + col;
    ctx.fillStyle = "#7f1d1d";
    ctx.font = "bold 10px Arial";
    ctx.fillText("ÁMBITO Y FUENTE", col2 + 12, y + 24);
    ctx.fillStyle = "#334155";
    ctx.font = "10px Arial";
    ctx.fillText("NASA FIRMS · MCD64A1 · WDPA", col2 + 12, y + 42);
    ctx.fillText("ESA WorldCover · JRC · FAO GAUL", col2 + 12, y + 56);
    ctx.fillText("Modelo Random Forest · GEE", col2 + 12, y + 70);

    const col3 = x + col * 2;
    ctx.fillStyle = "#7f1d1d";
    ctx.font = "bold 10px Arial";
    ctx.fillText("REFERENCIA ESPACIAL", col3 + 12, y + 24);
    ctx.fillStyle = "#334155";
    ctx.font = "10px Arial";
    ctx.fillText("MAGNA-SIRGAS / WGS 84", col3 + 12, y + 42);
    ctx.fillText("Proyección geográfica", col3 + 12, y + 56);
    ctx.fillText("Resolución de análisis: 5 km", col3 + 12, y + 70);

    const col4 = x + col * 3;
    ctx.fillStyle = "#7f1d1d";
    ctx.font = "bold 10px Arial";
    ctx.fillText("ELABORACIÓN", col4 + 12, y + 24);
    ctx.fillStyle = "#334155";
    ctx.font = "10px Arial";
    ctx.fillText(String(report.author || REPORT_DEFAULTS.author).slice(0, 34), col4 + 12, y + 42);
    ctx.fillText(String(report.role || REPORT_DEFAULTS.role).slice(0, 34), col4 + 12, y + 56);
    ctx.fillText(fecha, col4 + 12, y + 70);

    ctx.fillStyle = "#64748b";
    ctx.font = "9px Arial";
    ctx.fillText(
      "Documento de referencia generado localmente. No sustituye la cartografía oficial del IGAC ni los reportes de las autoridades ambientales.",
      x + 12, y + alto - 10
    );
    ctx.restore();
  }

  let igacDrawToken = 0;
  async function dibujarIgac(canvas, formato, opciones) {
    if (!canvas) return;
    const token = ++igacDrawToken;
    const formatoCfg = IGAC_FORMATS[formato] || IGAC_FORMATS.a4p;
    const opts = opciones || {};
    await cargarRasteresActivos();
    if (token !== igacDrawToken) return;
    const W = formatoCfg.w;
    const H = formatoCfg.h;
    const portrait = H > W;
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext("2d");
    const margen = Math.round(W * 0.032);
    const fecha = new Date().toLocaleDateString("es-CO", { day: "2-digit", month: "long", year: "numeric" });

    ctx.fillStyle = "#fbf7ee";
    ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = "#1f2937";
    ctx.lineWidth = Math.max(5, Math.round(W * 0.0045));
    ctx.strokeRect(16, 16, W - 32, H - 32);
    ctx.lineWidth = 2;
    ctx.strokeRect(34, 34, W - 68, H - 68);

    // Ticks de esquina
    ctx.strokeStyle = "#1f2937";
    ctx.lineWidth = 3;
    const tick = Math.round(W * 0.02);
    [[34, 34, 1, 1], [W - 34, 34, -1, 1], [34, H - 34, 1, -1], [W - 34, H - 34, -1, -1]].forEach(function (c) {
      ctx.beginPath();
      ctx.moveTo(c[0], c[1] + c[3] * tick);
      ctx.lineTo(c[0], c[1]);
      ctx.lineTo(c[0] + c[2] * tick, c[1]);
      ctx.stroke();
    });

    // Encabezado
    const headerY = Math.round(H * 0.035);
    ctx.textAlign = "left";
    ctx.fillStyle = "#7f1d1d";
    ctx.beginPath();
    ctx.arc(margen + 30, headerY + 30, 30, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#fff";
    ctx.font = "bold 14px Arial";
    ctx.textAlign = "center";
    ctx.fillText("IGAC", margen + 30, headerY + 35);
    ctx.textAlign = "left";
    ctx.fillStyle = "#7f1d1d";
    ctx.font = "bold " + Math.round(W * 0.008) + "px Arial";
    ctx.fillText("REPÚBLICA DE COLOMBIA", margen + 74, headerY + 16);
    ctx.fillStyle = "#0f172a";
    ctx.font = "bold " + Math.round(W * 0.017) + "px Arial";
    ctx.fillText("MAPA NACIONAL DE INCENDIOS FORESTALES", margen + 74, headerY + 48);
    ctx.fillStyle = "#475569";
    ctx.font = Math.round(W * 0.0085) + "px Arial";
    ctx.fillText(
      "Capas activas: " + capasResumenTexto().slice(0, 86) + " · " +
      (state.year == null ? "Periodo 2012–2026" : "Año " + state.year),
      margen + 74, headerY + 74
    );
    ctx.textAlign = "right";
    ctx.fillStyle = "#334155";
    ctx.font = "bold " + Math.round(W * 0.007) + "px Arial";
    ctx.fillText("ESCALA GRÁFICA", W - margen, headerY + 18);
    ctx.font = Math.round(W * 0.0068) + "px Arial";
    ctx.fillStyle = "#64748b";
    ctx.fillText("MAGNA-SIRGAS · WGS 84", W - margen, headerY + 38);
    ctx.fillText("Resolución de análisis 5 km", W - margen, headerY + 56);
    ctx.strokeStyle = "#b91c1c";
    ctx.lineWidth = Math.max(3, Math.round(W * 0.003));
    ctx.beginPath();
    ctx.moveTo(margen, headerY + 92);
    ctx.lineTo(W - margen, headerY + 92);
    ctx.stroke();

    // Área de mapa
    const mapX = margen;
    const mapY = headerY + 112;
    const mapW = W - margen * 2;
    const blockH = portrait ? Math.round(H * 0.15) : Math.round(H * 0.14);
    const mapH = H - mapY - blockH - 30;
    ctx.fillStyle = "#fbf7ee";
    ctx.fillRect(mapX, mapY, mapW, mapH);
    ctx.strokeStyle = "#1f2937";
    ctx.lineWidth = 2;
    ctx.strokeRect(mapX, mapY, mapW, mapH);

    const proj = igacProyeccion(mapX, mapY, mapW, mapH);

    // Solo se dibujan las capas activas. El fondo es neutro para no
    // introducir coberturas que el usuario haya desactivado.
    ctx.save();
    ctx.beginPath();
    ctx.rect(proj.x, proj.y, proj.w, proj.h);
    ctx.clip();
    ctx.fillStyle = "#f5f1e7";
    ctx.fillRect(proj.x, proj.y, proj.w, proj.h);

    function dibujarRasterActivo(nombre, alpha) {
      const imagen = rasterImages[nombre];
      if (!imagen) return;
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.drawImage(imagen, proj.x, proj.y, proj.w, proj.h);
      ctx.restore();
    }
    if (capaActiva("bosques")) dibujarRasterActivo("bosque", 0.62);
    if (capaActiva("agua")) dibujarRasterActivo("agua", 0.78);
    if (capaActiva("susceptibilidad") && D.departamentos) {
      const riesgoIgac = calcularRiesgoDeptos();
      (D.departamentos.features || []).forEach(function (f) {
        const nombre = (f.properties || {}).nombre;
        const r = riesgoIgac[nombre] || { riesgo: 0 };
        dibujarGeometria(ctx, f.geometry, proj, {
          fill: colorRiesgo(r.riesgo),
          stroke: "#1f2937",
          width: 1,
        });
      });
    }

    if (capaActiva("deptos") && D.departamentos) {
      dibujarFeatures(ctx, D.departamentos.features, proj, {
        fill: "rgba(226,232,240,0.10)",
        stroke: "#475569",
        width: 1.4,
      });
    }

    if (capaActiva("areas") && D.areas_protegidas) {
      dibujarFeatures(ctx, D.areas_protegidas.features, proj, {
        fill: "rgba(168,85,247,0.16)",
        stroke: "#7c3aed",
        width: 1.6,
      });
    }

    if (capaActiva("quemadas")) {
      quemadasVisibles(state.year).forEach(function (q) {
        const pts = poligonoQuemada(q);
        ctx.beginPath();
        pts.forEach(function (p, i) {
          const xy = proj.project(p[1], p[0]);
          if (i === 0) ctx.moveTo(xy[0], xy[1]);
          else ctx.lineTo(xy[0], xy[1]);
        });
        ctx.closePath();
        ctx.fillStyle = "rgba(251,146,60,0.18)";
        ctx.fill();
        ctx.strokeStyle = "#f97316";
        ctx.lineWidth = 0.9;
        ctx.stroke();
      });
    }

    if (capaActiva("ausencias")) {
      (D.ausencias || []).forEach(function (a) {
        dibujarPunto(ctx, proj, a.lon, a.lat, Math.max(1, proj.w * 0.0012), "#22d3ee", null);
      });
    }

    if (capaActiva("focos")) {
      const focos = focosVisibles(state.year);
      const niveles = intensidadFocos(state.year);
      const radioBase = Math.max(1.4, proj.w * 0.0018);
      focos.forEach(function (p, i) {
        const lv = INTENSIDAD[niveles[i]] || INTENSIDAD[1];
        dibujarPunto(ctx, proj, p.lon, p.lat, radioBase + (lv.radius - 2.5) * 0.55, lv.color, "#ffffff");
      });
    }

    if (state.firms && state.firms.active && state.firms.points && state.firms.points.length) {
      const radioFirms = Math.max(1.8, proj.w * 0.0022);
      state.firms.points.forEach(function (p) {
        const lv = INTENSIDAD[firmsNivel(p)];
        dibujarPunto(ctx, proj, p.lon, p.lat, radioFirms, lv.color, "#ffffff");
      });
    }

    if (state.geoActive && state.geo) {
      const gp = proj.project(state.geo.lon, state.geo.lat);
      ctx.beginPath();
      ctx.arc(gp[0], gp[1], Math.max(5, proj.w * 0.005), 0, Math.PI * 2);
      ctx.fillStyle = "#111827";
      ctx.fill();
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(gp[0], gp[1], Math.max(1.6, proj.w * 0.0018), 0, Math.PI * 2);
      ctx.fillStyle = "#ffffff";
      ctx.fill();
    }

    if (capaActiva("deptos")) {
      const etiquetaTam = Math.max(8, Math.round(proj.w * 0.0062));
      ctx.font = "bold " + etiquetaTam + "px Arial";
      ctx.textAlign = "center";
      const conPoligono = deptosConPoligono();
      (D.departamentos_puntos || []).forEach(function (d) {
        if (conPoligono.size && !conPoligono.has(d.nombre)) return;
        const p = proj.project(d.lon, d.lat);
        const nombre = prettyDepto(d.nombre);
        ctx.lineWidth = Math.max(2, etiquetaTam * 0.35);
        ctx.strokeStyle = "rgba(251,247,238,0.95)";
        ctx.strokeText(nombre, p[0], p[1]);
        ctx.fillStyle = "#1f2937";
        ctx.fillText(nombre, p[0], p[1]);
      });
    }

    if (!capasActivas().length && !(state.firms && state.firms.active) && !state.geoActive) {
      ctx.fillStyle = "#64748b";
      ctx.font = "bold 20px Arial";
      ctx.textAlign = "center";
      ctx.fillText("Sin capas activas", proj.x + proj.w / 2, proj.y + proj.h / 2);
    }
    ctx.restore();

    // Retícula de coordenadas alineada con la proyección real
    if (opts.grid !== false) {
      const lonMin = BOUNDS[0][1];
      const lonMax = BOUNDS[1][1];
      const latMin = BOUNDS[0][0];
      const latMax = BOUNDS[1][0];
      ctx.save();
      ctx.strokeStyle = "rgba(71, 85, 105, 0.38)";
      ctx.fillStyle = "rgba(51, 65, 85, 0.92)";
      ctx.lineWidth = 1;
      ctx.font = "10px Arial";
      const lineasX = portrait ? 5 : 6;
      const lineasY = portrait ? 7 : 4;
      for (let i = 1; i < lineasX; i++) {
        const x = proj.x + (proj.w / lineasX) * i;
        ctx.beginPath();
        ctx.moveTo(x, proj.y);
        ctx.lineTo(x, proj.y + proj.h);
        ctx.stroke();
        const lon = lonMin + (lonMax - lonMin) * (i / lineasX);
        const texto = Math.abs(lon).toFixed(1) + "° O";
        ctx.textAlign = "center";
        ctx.fillText(texto, x, proj.y + proj.h - 8);
      }
      for (let i = 1; i < lineasY; i++) {
        const y = proj.y + (proj.h / lineasY) * i;
        ctx.beginPath();
        ctx.moveTo(proj.x, y);
        ctx.lineTo(proj.x + proj.w, y);
        ctx.stroke();
        const lat = latMax - (latMax - latMin) * (i / lineasY);
        const texto = Math.abs(lat).toFixed(1) + "° " + (lat >= 0 ? "N" : "S");
        ctx.textAlign = "left";
        ctx.fillText(texto, proj.x + 8, y - 5);
      }
      ctx.restore();
    }

    // Paneles laterales en formato horizontal
    const lateral = !portrait && (mapW - proj.w) > 300;
    const leyendaAncho = Math.min(300, Math.max(220, W * 0.14));
    if (lateral) {
      const izqX = mapX + 14;
      const izqY = mapY + 20;
      dibujarLeyenda(ctx, izqX, izqY, leyendaAncho, true);
      const derX = proj.x + proj.w + 18;
      dibujarRosa(ctx, derX + 70, mapY + 100, 58);

      const resumen = resumenActivo(state.year);
      const lineas = [];
      if (capaActiva("focos")) lineas.push(["Focos", fmt(focosVisibles(state.year).length)]);
      if (capaActiva("quemadas")) lineas.push(["Quemadas", fmt(quemadasVisibles(state.year).length)]);
      if (capaActiva("quemadas")) lineas.push(["Superficie est.", fmt(quemadasVisibles(state.year).length * 25) + " km²"]);
      if (capaActiva("deptos")) lineas.push(["Deptos.", fmt(resumen.length)]);
      if (capaActiva("areas")) lineas.push(["Áreas prot.", fmt((D.areas_puntos || []).length)]);
      if (state.firms && state.firms.active) lineas.push(["FIRMS", fmt(state.firms.count)]);
      if (capaActiva("focos")) lineas.push(["Año pico", anioPico() || "—"]);
      if (!lineas.length) lineas.push(["Capas activas", "Ninguna"]);

      const panelY = mapY + 210;
      const panelH = 40 + lineas.length * 18 + 12;
      const panelW = Math.min(leyendaAncho, mapX + mapW - derX - 18);
      ctx.save();
      ctx.fillStyle = "rgba(15,23,42,0.9)";
      ctx.strokeStyle = "rgba(255,255,255,0.32)";
      ctx.lineWidth = 1.5;
      ctx.fillRect(derX, panelY, panelW, panelH);
      ctx.strokeRect(derX, panelY, panelW, panelH);
      ctx.fillStyle = "#f8fafc";
      ctx.font = "bold 12px Arial";
      ctx.textAlign = "left";
      ctx.fillText("RESUMEN ACTIVO", derX + 12, panelY + 20);
      ctx.fillStyle = "#cbd5e1";
      ctx.font = "10px Arial";
      lineas.forEach(function (linea, i) {
        ctx.fillText(linea[0] + ": " + linea[1], derX + 12, panelY + 40 + i * 18);
      });
      ctx.restore();
      dibujarEscala(ctx, izqX + 8, mapY + mapH - 42, 500, Math.min(280, leyendaAncho - 30), true);
    } else {
      if (opts.legend !== false) {
        const extrasLeyenda =
          (capaActiva("focos") ? 1 : 0) +
          (state.firms && state.firms.active ? 1 : 0);
        const legW = Math.min(320, Math.max(250, mapW * 0.26));
        const legH = 30 + Math.min(9, capasActivas().length) * 22 + extrasLeyenda * 18 + 30;
        dibujarLeyenda(ctx, mapX + mapW - legW - 16, mapY + mapH - legH - 16, legW, true);
      }
      dibujarRosa(ctx, mapX + mapW - 70, mapY + 72, 50);
      dibujarEscala(ctx, mapX + 18, mapY + mapH - 44, 500, Math.min(300, mapW * 0.32), true);
    }

    // Bloque de título
    dibujarBloqueTitulo(ctx, W, H, margen, blockH, fecha);

    // Nota de versión
    ctx.save();
    ctx.fillStyle = "#64748b";
    ctx.font = "9px Arial";
    ctx.textAlign = "right";
    ctx.fillText("Generado por el visor nacional · " + IGAC_FORMATS[formato].nombre, W - margen, H - 42);
    ctx.restore();
  }

  async function drawIgacTab() {
    if (!UI.igacCanvas) return;
    await dibujarIgac(UI.igacCanvas, UI.igacFormat ? UI.igacFormat.value : "a4p", {
      legend: UI.igacLegend ? UI.igacLegend.checked : true,
      grid: UI.igacGrid ? UI.igacGrid.checked : true,
    });
  }

  /* ------------------------- Vista integral ------------------------------ */
  function refreshIntegral() {
    const resumen = resumenActivo(state.year);
    const totalFocos = focosVisibles(state.year).length;
    const totalQuemadas = quemadasVisibles(state.year).length;
    if (UI.intFocos) UI.intFocos.textContent = capaActiva("focos") ? fmt(totalFocos) : "—";
    if (UI.intQuemadas) UI.intQuemadas.textContent = capaActiva("quemadas") ? fmt(totalQuemadas) : "—";
    if (UI.intDeptos) UI.intDeptos.textContent = capaActiva("deptos") ? fmt(resumen.length) : "—";
    if (UI.intAreas) UI.intAreas.textContent = capaActiva("areas") ? fmt((D.areas_puntos || []).length) : "—";
    if (UI.integralReport) UI.integralReport.innerHTML = buildReportHTML();
    if (UI.integralReportMeta) {
      const partes = [];
      if (capaActiva("focos")) partes.push(fmt(totalFocos) + " focos");
      if (capaActiva("quemadas")) partes.push(fmt(totalQuemadas) + " quemadas");
      if (capaActiva("areas")) partes.push(fmt((D.areas_puntos || []).length) + " áreas");
      UI.integralReportMeta.textContent = (state.year == null ? "Todos los años" : "Año " + state.year) +
        " · " + (partes.length ? partes.join(" · ") : "sin capas activas");
    }
    updateSyncUI();
    dibujarIgac(UI.integralIgac, "a4l", { legend: true, grid: true });
  }

  /* --------------------------- Offline / sync ---------------------------- */
  function pendingCount() {
    return syncState.queue.length;
  }

  function tiempoRelativo(ts) {
    if (!ts) return "sin sincronizar";
    const diff = Date.now() - Number(ts);
    if (diff < 60000) return "hace un momento";
    if (diff < 3600000) return "hace " + Math.floor(diff / 60000) + " min";
    if (diff < 86400000) return "hace " + Math.floor(diff / 3600000) + " h";
    return new Date(Number(ts)).toLocaleDateString("es-CO");
  }

  function updateSyncUI() {
    const online = navigator.onLine;
    const pendientes = pendingCount();
    const netText = online ? (pendientes ? pendientes + " pend." : "En línea") : "Sin conexión";
    if (UI.netChip) {
      UI.netChip.classList.toggle("offline", !online);
      UI.netChip.classList.toggle("syncing", online && flushing);
      if (UI.netText) UI.netText.textContent = flushing ? "Sincronizando" : netText;
    }
    if (UI.offlineBar) {
      UI.offlineBar.classList.toggle("show", !online);
      if (UI.offlineText) {
        UI.offlineText.textContent = pendientes
          ? "Sin conexión · " + pendientes + " cambio" + (pendientes === 1 ? "" : "s") + " en cola"
          : "Sin conexión · trabajando en local";
      }
    }
    const pill = !online ? "Offline" + (pendientes ? " · " + pendientes : "") : (flushing ? "Sincronizando" : (pendientes ? pendientes + " pend." : "En línea"));
    if (UI.syncPill) UI.syncPill.textContent = pill;
    if (UI.syncText) {
      UI.syncText.textContent = !online
        ? "Los cambios se guardan en este dispositivo."
        : (pendientes
          ? pendientes + " cambio" + (pendientes === 1 ? "" : "s") + " listo" + (pendientes === 1 ? "" : "s") + " para sincronizar."
          : "Sincronizado " + tiempoRelativo(syncState.last) + ".");
    }
    const card = document.querySelector(".sync-card");
    if (card) {
      card.classList.toggle("pending", online && pendientes > 0);
      card.classList.toggle("offline", !online);
    }
    if (UI.qrSyncState) UI.qrSyncState.textContent = !online ? "Sin conexión" : (flushing ? "Sincronizando…" : "En línea");
    if (UI.qrSyncText) {
      UI.qrSyncText.textContent = !online
        ? "Trabajando en local. " + pendientes + " cambios en cola."
        : (pendientes ? pendientes + " cambios listos para sincronizar." : "Todo guardado en este dispositivo.");
    }
    if (UI.integralNet) UI.integralNet.textContent = !online ? "Offline" : (flushing ? "Sincronizando" : "En línea");
    if (UI.integralSyncText) {
      UI.integralSyncText.textContent = !online
        ? "Sin conexión · " + pendientes + " en cola"
        : (pendientes ? pendientes + " pendientes" : "Todo guardado");
    }
    updateIntegralChecklist();
  }

  function queueSync(tipo, datos) {
    const item = {
      id: Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 7),
      type: tipo,
      ts: Date.now(),
      payload: datos || null,
    };
    syncState.queue.push(item);
    if (syncState.queue.length > 40) syncState.queue = syncState.queue.slice(-40);
    saveJSON(SYNC_KEY, syncState);
    updateSyncUI();
    if (navigator.onLine) {
      clearTimeout(autoSyncTimer);
      autoSyncTimer = setTimeout(function () { flushSync(false); }, 1600);
    }
  }

  function flushSync(manual) {
    if (flushing) return;
    if (!navigator.onLine) {
      if (manual) Toast.warning("Sin conexión", "Los cambios quedan guardados y se sincronizarán al reconectar.", "sync");
      updateSyncUI();
      return;
    }
    const pendientes = pendingCount();
    if (!pendientes) {
      syncState.last = syncState.last || Date.now();
      saveJSON(SYNC_KEY, syncState);
      updateSyncUI();
      if (manual) Toast.info("Todo sincronizado", "No hay cambios pendientes.", "sync");
      return;
    }
    flushing = true;
    updateSyncUI();
    Toast.loading("Sincronizando…", pendientes + " cambios locales", "sync");
    setTimeout(function () {
      const store = loadJSON(SYNC_STORE_KEY, []) || [];
      const ahora = Date.now();
      syncState.queue.forEach(function (item) {
        store.push(Object.assign({}, item, { synced: ahora }));
      });
      saveJSON(SYNC_STORE_KEY, store.slice(-120));
      syncState.queue = [];
      syncState.last = ahora;
      syncState.synced += pendientes;
      saveJSON(SYNC_KEY, syncState);
      flushing = false;
      updateSyncUI();
      Toast.update("sync", {
        type: "success",
        title: "Sincronización completada",
        message: pendientes + " cambio" + (pendientes === 1 ? "" : "s") + " consolidado" + (pendientes === 1 ? "" : "s") + " en este dispositivo.",
        duration: 3800,
      });
      scheduleStudyRefresh();
    }, 850);
  }

  function initSync() {
    if (UI.btnSyncNow) UI.btnSyncNow.addEventListener("click", function () { flushSync(true); });
    if (UI.offlineSync) UI.offlineSync.addEventListener("click", function () { flushSync(true); });
    if (UI.qrSyncNow) UI.qrSyncNow.addEventListener("click", function () { flushSync(true); });
    if (UI.integralSyncNow) UI.integralSyncNow.addEventListener("click", function () { flushSync(true); });
    window.addEventListener("online", function () {
      updateSyncUI();
      Toast.success("Conexión restablecida", "Sincronizando los cambios guardados…", "net");
      if (pendingCount()) setTimeout(function () { flushSync(false); }, 600);
    });
    window.addEventListener("offline", function () {
      updateSyncUI();
      Toast.warning("Modo offline", "El visor sigue funcionando. Los cambios se guardan localmente.", "net");
    });
    updateSyncUI();
  }

  function updateIntegralChecklist() {
    if (!UI.integralChecklist) return;
    UI.integralChecklist.innerHTML = REQ_ITEMS.map(function (item) {
      return '<span class="' + (reqState[item.id] ? "done" : "") + '">' + esc(item.title) + "</span>";
    }).join("");
  }

  /* --------------------------- Estudio: UI ------------------------------- */
  let studyRefreshTimer = null;
  function scheduleStudyRefresh() {
    if (!UI.studyModal || !UI.studyModal.classList.contains("open")) return;
    clearTimeout(studyRefreshTimer);
    studyRefreshTimer = setTimeout(function () {
      if (state.studyTab === "integral") refreshIntegral();
      else if (state.studyTab === "informe") refreshReportPreview();
      else if (state.studyTab === "igac") drawIgacTab();
      else if (state.studyTab === "riesgo") renderRiesgo();
    }, 180);
  }

  function updateStudyFooter(tab) {
    const show = function (id, visible) {
      const el = document.getElementById(id);
      if (el) el.hidden = !visible;
    };
    show("btnExportPdf", tab === "integral" || tab === "informe");
    show("btnDownloadMapPdf", tab === "integral" || tab === "igac");
    show("btnDownloadPng", tab === "integral" || tab === "igac");
    const hints = {
      integral: "Mapa e informe son documentos independientes; ambos incluyen solo las capas activas.",
      informe: "El informe se exporta como PDF independiente del mapa, con las capas activas.",
      igac: "El mapa se exporta en PNG o PDF con marco, rosa, retícula, leyenda y escala.",
      riesgo: "Riesgo por departamento calculado a partir de los focos y áreas quemadas del periodo.",
    };
    if (UI.studyHint) UI.studyHint.textContent = hints[tab] || hints.integral;
  }

  function switchStudyTab(tab) {
    state.studyTab = tab;
    $$("#studyTabs button").forEach(function (btn) {
      btn.classList.toggle("active", btn.dataset.stab === tab);
    });
    const panes = { integral: "paneIntegral", informe: "paneInforme", igac: "paneIgac", riesgo: "paneRiesgo" };
    Object.keys(panes).forEach(function (key) {
      const pane = document.getElementById(panes[key]);
      if (pane) pane.classList.toggle("active", key === tab);
    });
    updateStudyFooter(tab);
    if (tab === "informe") {
      initReportForm();
      refreshReportPreview();
    } else if (tab === "igac") {
      drawIgacTab();
    } else if (tab === "riesgo") {
      renderRiesgo();
    } else {
      refreshIntegral();
    }
  }

  function openStudy(tab) {
    if (!UI.studyModal) return;
    UI.studyModal.classList.add("open");
    UI.studyModal.setAttribute("aria-hidden", "false");
    switchStudyTab(tab || "integral");
    checkReq("docs");
    setTimeout(function () {
      if (UI.studyCloseX) UI.studyCloseX.focus();
    }, 140);
    Toast.success("Centro de estudio", "Informe, plano IGAC, QR y sincronización listos.", "study");
  }

  function closeStudy() {
    if (!UI.studyModal) return;
    UI.studyModal.classList.remove("open");
    UI.studyModal.setAttribute("aria-hidden", "true");
  }

  function initStudy() {
    if (!UI.studyModal) return;
    // En pantallas pequeñas el plano vertical se lee mejor en el celular.
    if (UI.igacFormat && window.innerWidth <= 640) UI.igacFormat.value = "a4p";
    if (UI.studyTabs) {
      UI.studyTabs.addEventListener("click", function (event) {
        const btn = event.target.closest("button[data-stab]");
        if (btn) switchStudyTab(btn.dataset.stab);
      });
    }
    if (UI.studyCloseX) UI.studyCloseX.addEventListener("click", closeStudy);
    if (UI.studyClose) UI.studyClose.addEventListener("click", closeStudy);
    if (UI.studyBackdrop) UI.studyBackdrop.addEventListener("click", closeStudy);

    // Accesos del panel "Centro de estudio" (módulos y exportaciones).
    $$(".study-hub-btn[data-study-open]").forEach(function (btn) {
      btn.addEventListener("click", function () { openStudy(btn.dataset.studyOpen); });
    });
    if (UI.hubExportReport) UI.hubExportReport.addEventListener("click", exportReportPdf);
    if (UI.hubExportMap) UI.hubExportMap.addEventListener("click", exportMapPdf);

    if (UI.integralGoReport) UI.integralGoReport.addEventListener("click", function () { switchStudyTab("informe"); });
    if (UI.integralGoQr) UI.integralGoQr.addEventListener("click", function () { switchStudyTab("qr"); });
    if (UI.integralPdf) UI.integralPdf.addEventListener("click", exportReportPdf);
    if (UI.integralMapPdf) UI.integralMapPdf.addEventListener("click", exportMapPdf);
    if (UI.integralPng) UI.integralPng.addEventListener("click", downloadIgacPng);
    if (UI.btnExportPdf) UI.btnExportPdf.addEventListener("click", exportReportPdf);
    if (UI.btnDownloadMapPdf) UI.btnDownloadMapPdf.addEventListener("click", exportMapPdf);
    if (UI.btnDownloadPng) UI.btnDownloadPng.addEventListener("click", downloadIgacPng);
    if (UI.btnDownloadQr) UI.btnDownloadQr.addEventListener("click", function () {
      renderQrTab();
      descargarCanvas(UI.qrCanvas, "qr_visor_incendios_" + (state.year || "todos") + ".png");
    });
    if (UI.btnCopyLink) UI.btnCopyLink.addEventListener("click", copiarEnlace);
    if (UI.qrCopy) UI.qrCopy.addEventListener("click", copiarEnlace);
    if (UI.qrDownload) UI.qrDownload.addEventListener("click", function () {
      renderQrTab();
      descargarCanvas(UI.qrCanvas, "qr_visor_incendios_" + (state.year || "todos") + ".png");
    });
    if (UI.qrOpen) UI.qrOpen.addEventListener("click", function () {
      window.open(shareUrl(), "_blank", "noopener");
    });
    if (UI.igacFormat) UI.igacFormat.addEventListener("change", drawIgacTab);
    if (UI.igacLegend) UI.igacLegend.addEventListener("change", drawIgacTab);
    if (UI.igacGrid) UI.igacGrid.addEventListener("change", drawIgacTab);

    initReportForm();
    initSync();
    updateIntegralChecklist();
    updateSyncUI();
  }

  async function downloadIgacPng() {
    const canvas = document.createElement("canvas");
    const formato = UI.igacFormat ? UI.igacFormat.value : "a4p";
    await dibujarIgac(canvas, formato, {
      legend: UI.igacLegend ? UI.igacLegend.checked : true,
      grid: UI.igacGrid ? UI.igacGrid.checked : true,
    });
    descargarCanvas(canvas, "mapa_incendios_colombia_" + (state.year == null ? "todos" : state.year) + ".png");
  }

  /* --------------------------- PDF: mapa --------------------------------- */
  async function exportMapPdf() {
    if (!window.jspdf || !window.jspdf.jsPDF) {
      Toast.error("PDF no disponible", "No se pudo cargar el generador. Revisa la consola.", "mapPdf");
      return;
    }
    Toast.loading("Generando mapa…", "Plano cartográfico con las capas activas", "mapPdf");
    try {
      const formato = UI.igacFormat ? UI.igacFormat.value : "a4p";
      const plano = document.createElement("canvas");
      await dibujarIgac(plano, formato, {
        legend: UI.igacLegend ? UI.igacLegend.checked : true,
        grid: UI.igacGrid ? UI.igacGrid.checked : true,
      });
      const landscape = plano.width > plano.height;
      const { jsPDF } = window.jspdf;
      const doc = new jsPDF({ orientation: landscape ? "landscape" : "portrait", unit: "mm", format: "a4" });
      const pw = doc.internal.pageSize.getWidth();
      const ph = doc.internal.pageSize.getHeight();
      doc.addImage(plano.toDataURL("image/jpeg", 0.93), "JPEG", 0, 0, pw, ph);
      const anio = state.year == null ? "todos" : state.year;
      const nombre = "mapa_incendios_colombia_" + anio + "_" + new Date().toISOString().slice(0, 10) + ".pdf";
      doc.save(nombre);
      Toast.update("mapPdf", {
        type: "success",
        title: "Mapa generado",
        message: nombre + " · solo capas activas.",
        duration: 5200,
      });
    } catch (err) {
      console.error(err);
      Toast.update("mapPdf", {
        type: "error",
        title: "No se pudo generar el mapa",
        message: "Revisa la consola del navegador e inténtalo de nuevo.",
        duration: 5600,
      });
    }
  }

  /* -------------------------- PDF: informe ------------------------------- */
  async function exportReportPdf() {
    if (!window.jspdf || !window.jspdf.jsPDF) {
      Toast.error("PDF no disponible", "No se pudo cargar el generador. Revisa la consola.", "pdf");
      return;
    }
    Toast.loading("Generando informe…", "Documento independiente con las capas activas", "pdf");
    try {
      const { jsPDF } = window.jspdf;
      const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
      const pageW = doc.internal.pageSize.getWidth();
      const pageH = doc.internal.pageSize.getHeight();
      const m = 16;
      const cw = pageW - m * 2;
      let y = 18;

      const anio = state.year;
      const usaFocos = capaActiva("focos");
      const usaQuemadas = capaActiva("quemadas");
      const usaDeptos = capaActiva("deptos");
      const usaAreas = capaActiva("areas");
      const mostrarParticipacion = usaFocos || usaQuemadas;
      const focos = focosVisibles(anio);
      const quemadas = quemadasVisibles(anio);
      const deptos = resumenActivo(anio);
      const km2 = quemadas.length * 25;
      const fecha = new Date().toLocaleDateString("es-CO", { day: "2-digit", month: "long", year: "numeric" });
      const periodo = anio == null ? "Periodo 2012–2026" : "Año " + anio;
      const autor = String(report.author || REPORT_DEFAULTS.author).trim();
      const cargo = String(report.role || REPORT_DEFAULTS.role).trim();

      function pie() {
        doc.setFont("helvetica", "normal");
        doc.setFontSize(7);
        doc.setTextColor(148, 163, 184);
        doc.text("Visor nacional de incendios forestales · Colombia · " + fecha, m, pageH - 8);
        doc.text(String(doc.getNumberOfPages()), pageW - m, pageH - 8, { align: "right" });
      }

      function nuevaPagina() {
        pie();
        doc.addPage("a4", "portrait");
        y = 20;
        doc.setDrawColor(185, 28, 28);
        doc.setLineWidth(0.8);
        doc.line(m, 15, pageW - m, 15);
      }

      function asegurar(alto) {
        if (y + alto > pageH - 16) nuevaPagina();
      }

      let numSeccion = 0;
      function titulo(texto) {
        numSeccion += 1;
        asegurar(14);
        doc.setFont("helvetica", "bold");
        doc.setFontSize(11);
        doc.setTextColor(127, 29, 29);
        doc.text(numSeccion + ". " + texto, m, y);
        y += 5.5;
      }

      function parrafo(texto) {
        doc.setFont("helvetica", "normal");
        doc.setFontSize(9);
        doc.setTextColor(30, 41, 59);
        const lineas = doc.splitTextToSize(String(texto || ""), cw);
        lineas.forEach(function (linea) {
          asegurar(5);
          doc.text(linea, m, y);
          y += 4.6;
        });
        y += 2;
      }

      function lista(texto) {
        parrafos(texto).forEach(function (item) {
          asegurar(5);
          doc.setFont("helvetica", "normal");
          doc.setFontSize(9);
          doc.setTextColor(30, 41, 59);
          const limpio = item.replace(/^\d+\.\s*/, "");
          const lineas = doc.splitTextToSize("• " + limpio, cw - 4);
          lineas.forEach(function (linea) {
            asegurar(5);
            doc.text(linea, m + 2, y);
            y += 4.6;
          });
          y += 0.8;
        });
        y += 1.5;
      }

      // Encabezado del informe
      doc.setFillColor(185, 28, 28);
      doc.rect(m, y, 4, 16, "F");
      doc.setTextColor(127, 29, 29);
      doc.setFont("helvetica", "bold");
      doc.setFontSize(8);
      doc.text("REPÚBLICA DE COLOMBIA · VISOR NACIONAL DE INCENDIOS", m + 8, y + 5);
      doc.setTextColor(15, 23, 42);
      doc.setFontSize(15);
      const tituloLineas = doc.splitTextToSize(String(report.title || REPORT_DEFAULTS.title), cw - 8);
      doc.text(tituloLineas, m + 8, y + 14);
      y += 18 + (tituloLineas.length - 1) * 6;
      doc.setFont("helvetica", "normal");
      doc.setFontSize(8.5);
      doc.setTextColor(100, 116, 139);
      doc.text(periodo + " · Colombia · Documento técnico de referencia", m, y);
      y += 4;
      doc.text("Autor: " + autor + " · " + cargo + " · " + fecha, m, y);
      y += 8;

      // Métricas: solo se incluyen las capas activas.
      const metricas = [];
      if (usaFocos) metricas.push([fmt(focos.length), "Focos de calor"]);
      if (usaQuemadas) {
        metricas.push([fmt(quemadas.length), "Áreas quemadas"]);
        metricas.push([fmt(km2), "km² quemados (est.)"]);
      }
      if (usaAreas) metricas.push([fmt((D.areas_puntos || []).length), "Áreas protegidas"]);
      if (usaDeptos) metricas.push([fmt(deptos.length), "Departamentos"]);
      if (metricas.length) {
        const gap = 3;
        const boxW = (cw - gap * (metricas.length - 1)) / metricas.length;
        metricas.forEach(function (metrica, i) {
          const bx = m + i * (boxW + gap);
          doc.setFillColor(248, 250, 252);
          doc.setDrawColor(226, 232, 240);
          doc.roundedRect(bx, y, boxW, 18, 1.5, 1.5, "FD");
          doc.setTextColor(15, 23, 42);
          doc.setFont("helvetica", "bold");
          doc.setFontSize(13);
          doc.text(metrica[0], bx + 3, y + 8);
          doc.setFont("helvetica", "normal");
          doc.setFontSize(6.5);
          doc.setTextColor(100, 116, 139);
          doc.text(metrica[1], bx + 3, y + 14);
        });
        y += 25;
      } else {
        y += 6;
      }

      titulo("Resumen ejecutivo");
      parrafo(textoNarrativa("obs"));

      titulo("Metodología");
      parrafo(metodologiaActiva());

      if (usaFocos || usaQuemadas) {
        titulo("Resultados del periodo");
        const chart = tendenciaCanvas(1000, 280);
        if (chart) {
          asegurar(58);
          doc.addImage(chart.toDataURL("image/png"), "PNG", m, y, cw, cw * 0.28);
          y += cw * 0.28 + 4;
        }
        parrafo(resumenResultados(anio));

        if (usaDeptos && mostrarParticipacion) {
          // Tabla con columnas condicionales según las capas activas.
          const top = deptos.slice(0, 8);
          const defs = [{ key: "nombre", label: "Departamento", w: 0.46, align: "left" }];
          if (usaFocos) defs.push({ key: "focos", label: "Focos", w: 0.18, align: "right" });
          if (usaQuemadas) defs.push({ key: "quemadas", label: "Quemadas", w: 0.2, align: "right" });
          defs.push({ key: "part", label: "Participación", w: 0.16, align: "right" });
          const totalW = defs.reduce(function (s, d) { return s + d.w; }, 0);
          let cx = m;
          defs.forEach(function (d) {
            d.wpx = cw * d.w / totalW;
            d.x = cx;
            cx += d.wpx;
          });

          asegurar(14);
          doc.setFillColor(241, 245, 249);
          doc.rect(m, y, cw, 7, "F");
          doc.setFont("helvetica", "bold");
          doc.setFontSize(7);
          doc.setTextColor(51, 65, 85);
          defs.forEach(function (col) {
            const tx = col.align === "right" ? col.x + col.wpx - 1.5 : col.x + 1.5;
            doc.text(col.label, tx, y + 4.8, { align: col.align });
          });
          y += 7;

          doc.setFont("helvetica", "normal");
          doc.setFontSize(8);
          doc.setTextColor(30, 41, 59);
          const totalRegistros = Math.max(1, focos.length + quemadas.length);
          const filas = top.length ? top : [{ nombre: "Sin registros", focos: 0, quemadas: 0 }];
          filas.forEach(function (d) {
            asegurar(6);
            defs.forEach(function (col) {
              let valor;
              if (col.key === "nombre") valor = String(d.nombre).slice(0, 42);
              else if (col.key === "focos") valor = fmt(d.focos);
              else if (col.key === "quemadas") valor = fmt(d.quemadas);
              else valor = fmt(((d.focos + d.quemadas) / totalRegistros * 100).toFixed(1)) + " %";
              const tx = col.align === "right" ? col.x + col.wpx - 1.5 : col.x + 1.5;
              doc.text(valor, tx, y + 4, { align: col.align });
            });
            doc.setDrawColor(226, 232, 240);
            doc.line(m, y + 6, pageW - m, y + 6);
            y += 6;
          });
          y += 5;
        }
      }

      if (usaAreas) {
        titulo("Áreas protegidas");
        parrafo(
          "Las áreas protegidas de mayor extensión del sistema nacional se relacionan a continuación " +
          "como referencia para la gestión del riesgo y la conservación. En el mapa se representan " +
          "únicamente mediante polígonos morados, sin viñetas ni marcadores."
        );
        const areas = areasVisibles();
        if (areas.length) {
          areas.forEach(function (a) {
            asegurar(5);
            doc.setFont("helvetica", "normal");
            doc.setFontSize(8.5);
            doc.setTextColor(51, 65, 85);
            doc.text("• " + String(a.nombre).slice(0, 58) + " · " + (prettyDepto(a.depto) || "Sin departamento") + " · " + fmt(a.area_ha) + " ha", m + 2, y);
            y += 4.8;
          });
        } else {
          parrafo("No hay áreas protegidas disponibles para el periodo seleccionado.");
        }
        y += 3;
      }

      titulo("Conclusiones");
      lista(textoNarrativa("conclusions"));
      titulo("Recomendaciones");
      lista(textoNarrativa("recommendations"));
      titulo("Fuentes y trazabilidad");
      parrafo(
        "Fuentes: " + (fuentesActivas().join(" · ") || "sin fuentes asociadas a las capas activas") +
        ". Generado el " + fecha +
        " con el visor autocontenido. El documento incluye únicamente las capas activas: " +
        capasResumenTexto() + ". La información es de referencia y no sustituye la cartografía oficial " +
        "del IGAC ni los reportes de las autoridades ambientales."
      );

      asegurar(20);
      y += 6;
      doc.setDrawColor(148, 163, 184);
      doc.line(m, y, m + 68, y);
      doc.setFont("helvetica", "bold");
      doc.setFontSize(8.5);
      doc.setTextColor(30, 41, 59);
      doc.text(autor, m, y + 5);
      doc.setFont("helvetica", "normal");
      doc.setFontSize(7.5);
      doc.setTextColor(100, 116, 139);
      doc.text(cargo, m, y + 9.5);
      y += 16;

      pie();
      const nombre = "informe_incendios_colombia_" + (anio == null ? "todos" : anio) + "_" +
        new Date().toISOString().slice(0, 10) + ".pdf";
      doc.save(nombre);
      Toast.update("pdf", {
        type: "success",
        title: "Informe generado",
        message: nombre + " · informe incluido (sin plano).",
        duration: 5200,
      });
    } catch (err) {
      console.error(err);
      Toast.update("pdf", {
        type: "error",
        title: "No se pudo generar el PDF",
        message: "Revisa la consola del navegador e inténtalo de nuevo.",
        duration: 5600,
      });
    }
  }

  /* ==========================================================================
     FASE Riesgo · Susceptibilidad real, departamentos y emergencias
     ========================================================================== */

  // Capital y número de municipios por departamento (valores aproximados).
  const INFO_DEPARTAMENTOS = {
    "Amazonas": { capital: "Leticia", municipios: 11 },
    "Antioquia": { capital: "Medellín", municipios: 125 },
    "Arauca": { capital: "Arauca", municipios: 7 },
    "Atlantico": { capital: "Barranquilla", municipios: 23 },
    "Bolivar": { capital: "Cartagena", municipios: 46 },
    "Boyaca": { capital: "Tunja", municipios: 123 },
    "Buenaventura": { capital: "Buenaventura", municipios: 1 },
    "Caldas": { capital: "Manizales", municipios: 27 },
    "Caqueta": { capital: "Florencia", municipios: 16 },
    "Casanare": { capital: "Yopal", municipios: 19 },
    "Cauca": { capital: "Popayán", municipios: 42 },
    "Cesar": { capital: "Valledupar", municipios: 25 },
    "Choco": { capital: "Quibdó", municipios: 30 },
    "Cordoba": { capital: "Montería", municipios: 30 },
    "Cundinamarca": { capital: "Bogotá", municipios: 116 },
    "Guainia": { capital: "Inírida", municipios: 9 },
    "Guajira": { capital: "Riohacha", municipios: 15 },
    "Guaviare": { capital: "San José del Guaviare", municipios: 4 },
    "Huila": { capital: "Neiva", municipios: 37 },
    "Magdalena": { capital: "Santa Marta", municipios: 30 },
    "Meta": { capital: "Villavicencio", municipios: 29 },
    "Narino": { capital: "Pasto", municipios: 64 },
    "Norte De Santander": { capital: "Cúcuta", municipios: 40 },
    "Putumayo": { capital: "Mocoa", municipios: 13 },
    "Quindio": { capital: "Armenia", municipios: 12 },
    "Risaralda": { capital: "Pereira", municipios: 14 },
    "San Andres Y Providencia": { capital: "San Andrés", municipios: 2 },
    "Santander": { capital: "Bucaramanga", municipios: 87 },
    "Sucre": { capital: "Sincelejo", municipios: 26 },
    "Tolima": { capital: "Ibagué", municipios: 47 },
    "Valle Del Cauca": { capital: "Cali", municipios: 42 },
    "Vaupes": { capital: "Mitú", municipios: 6 },
    "Vichada": { capital: "Puerto Carreño", municipios: 4 },
  };

  // Líneas nacionales de emergencia (aplican en todo el territorio).
  const EMERGENCIAS = [
    { nombre: "Bomberos", numero: "119", icono: "bombero" },
    { nombre: "Policía Nacional", numero: "123", icono: "policia" },
    { nombre: "Cruz Roja", numero: "132", icono: "cruzroja" },
    { nombre: "Defensa Civil", numero: "144", icono: "defensa" },
    { nombre: "Ambulancias", numero: "125", icono: "ambulancia" },
  ];

  let deptoSeleccionado = "";

  // Contexto climático: fenómeno de El Niño (ENSO). Re-pondera la susceptibilidad
  // dando más peso a la sequía (CHIRPS/SPI) y a la temperatura (LST) según la
  // intensidad seleccionada. Se aplica como factor multiplicativo del riesgo.
  let ensoActivo = false;
  let ensoIntensidad = "neutro";

  function factorEnso() {
    if (!ensoActivo) return 1;
    if (ensoIntensidad === "severo") return 1.5;
    if (ensoIntensidad === "moderado") return 1.25;
    return 1;
  }

  function calcularRiesgoDeptos() {
    const conteo = {};
    (D.departamentos_puntos || []).forEach(function (d) {
      conteo[d.nombre] = { focos: 0, quemadas: 0 };
    });
    focosDeAnio(state.year).forEach(function (f) {
      if (conteo[f.depto]) conteo[f.depto].focos++;
    });
    quemadasDeAnio(state.year).forEach(function (q) {
      if (conteo[q.depto]) conteo[q.depto].quemadas++;
    });
    // Focos en vivo (NASA FIRMS) si están cargados.
    if (state.firms && state.firms.active && state.firms.points) {
      state.firms.points.forEach(function (p) {
        if (p.depto && conteo[p.depto]) conteo[p.depto].focos++;
      });
    }
    let max = 1;
    Object.keys(conteo).forEach(function (n) {
      max = Math.max(max, conteo[n].focos + conteo[n].quemadas);
    });
    const resultado = {};
    Object.keys(conteo).forEach(function (n) {
      const c = conteo[n];
      const total = c.focos + c.quemadas;
      resultado[n] = {
        focos: c.focos,
        quemadas: c.quemadas,
        total: total,
        riesgo: Math.min(100, Math.round((total / max) * 100 * factorEnso())),
      };
    });
    return resultado;
  }

  function colorRiesgo(pct) {
    if (pct <= 0) return "#1a9850";
    if (pct < 25) return "#a6d96a";
    if (pct < 50) return "#ffffbf";
    if (pct < 75) return "#fdae61";
    return "#d73027";
  }

  function renderCloropleta() {
    const group = groups.susceptibilidad;
    if (!group) return;
    group.clearLayers();
    const riesgo = calcularRiesgoDeptos();
    if (D.departamentos) {
      L.geoJSON(sinPuntos(D.departamentos), {
        style: function (feature) {
          const nombre = (feature.properties || {}).nombre;
          const r = riesgo[nombre] || { riesgo: 0 };
          return {
            color: colorRiesgo(r.riesgo),
            weight: 1,
            opacity: 0.9,
            fillColor: colorRiesgo(r.riesgo),
            fillOpacity: 0.55,
          };
        },
        pointToLayer: function (latlng) {
          return L.circleMarker(latlng, { radius: 0, opacity: 0, fillOpacity: 0, interactive: false });
        },
        onEachFeature: function (feature, layer) {
          const nombre = (feature.properties || {}).nombre;
          const r = riesgo[nombre] || { riesgo: 0, focos: 0, quemadas: 0 };
          layer.bindTooltip(
            (prettyDepto(nombre) || "—") + " · riesgo " + r.riesgo + "%",
            { sticky: true, className: "map-tooltip" }
          );
        },
      }).addTo(group);
    }
  }

  function renderRiesgo() {
    const cont = document.getElementById("paneRiesgoBody");
    if (!cont) return;
    const riesgo = calcularRiesgoDeptos();
    const lista = Object.keys(riesgo).map(function (n) {
      return { nombre: n, r: riesgo[n] };
    }).sort(function (a, b) { return b.r.riesgo - a.r.riesgo; });
    cont.innerHTML =
      '<div class="risk-summary">' +
        "<span>Año " + (state.year == null ? "todos" : state.year) + "</span>" +
        "<span>" + lista.length + " departamentos analizados</span>" +
      "</div>" +
      '<div class="risk-rows">' +
      lista.map(function (item) {
        const info = INFO_DEPARTAMENTOS[item.nombre] || {};
        return (
          '<div class="risk-row">' +
            '<div class="risk-bar" style="width:' + item.r.riesgo + '%"></div>' +
            '<div class="risk-row-head">' +
              "<strong>" + esc(prettyDepto(item.nombre) || item.nombre) + "</strong>" +
              "<b>" + item.r.riesgo + "%</b>" +
            "</div>" +
            '<div class="risk-row-meta">' +
              (info.capital ? "Capital: " + esc(info.capital) + " · " : "") +
              item.r.focos + " focos · " + item.r.quemadas + " quemadas" +
            "</div>" +
          "</div>"
        );
      }).join("") +
      "</div>";
  }

  function enfocarDepto(nombre) {
    const feat = (D.departamentos && D.departamentos.features || []).find(function (f) {
      return (f.properties || {}).nombre === nombre;
    });
    if (!feat || !map) return;
    try {
      const b = L.geoJSON(feat).getBounds();
      if (b && b.isValid()) map.fitBounds(b, { padding: [28, 28], animate: true });
    } catch (e) { /* geometría inválida */ }
  }

  function renderEmergencias() {
    const list = document.getElementById("emergencyList");
    const pill = document.getElementById("emergencyDepto");
    const contexto = deptoSeleccionado ? prettyDepto(deptoSeleccionado) : "Colombia";
    if (pill) pill.textContent = contexto;
    if (!list) return;
    const sufijo = deptoSeleccionado ? " · " + prettyDepto(deptoSeleccionado) : "";
    list.innerHTML = EMERGENCIAS.map(function (e) {
      return '<li><span class="em-ico ' + e.icono + '" aria-hidden="true"></span>' +
        '<div><strong>' + esc(e.nombre) + esc(sufijo) + "</strong>" +
        '<small>' + esc(e.numero) + "</small></div></li>";
    }).join("");
  }

  function actualizarInfoDepto() {
    const info = document.getElementById("deptoInfo");
    const pill = document.getElementById("deptoPill");
    if (pill) pill.textContent = deptoSeleccionado ? prettyDepto(deptoSeleccionado) : "Nacional";
    // Los números de emergencia se actualizan en cada cambio de selección.
    renderEmergencias();
    if (!info) return;
    if (!deptoSeleccionado) {
      info.innerHTML = '<p class="hint">Selecciona un departamento para enfocar el mapa y ver capital, municipios y riesgo.</p>';
      return;
    }
    const d = INFO_DEPARTAMENTOS[deptoSeleccionado] || {};
    const riesgo = calcularRiesgoDeptos();
    const r = riesgo[deptoSeleccionado] || { focos: 0, quemadas: 0, riesgo: 0 };
    info.innerHTML =
      '<div class="depto-card">' +
        '<div class="depto-card-title">' + esc(prettyDepto(deptoSeleccionado)) + "</div>" +
        '<div class="depto-kpis">' +
          '<div><b>' + esc(d.capital || "—") + "</b><small>Capital</small></div>" +
          '<div><b>' + (d.municipios != null ? d.municipios : "—") + "</b><small>Municipios</small></div>" +
          '<div><b>' + r.riesgo + '%</b><small>Riesgo</small></div>' +
        "</div>" +
        '<div class="depto-meta">' + r.focos + " focos · " + r.quemadas + " quemadas (año " +
          (state.year == null ? "todos" : state.year) + ")</div>" +
      "</div>";
  }

  function initDepartamentos() {
    const sel = document.getElementById("deptoSelect");
    if (sel) {
      const nombres = (D.departamentos_puntos || []).map(function (d) { return d.nombre; }).sort();
      sel.innerHTML = '<option value="">— Todo Colombia —</option>' +
        nombres.map(function (n) {
          return '<option value="' + esc(n) + '">' + esc(prettyDepto(n) || n) + "</option>";
        }).join("");
      sel.addEventListener("change", function () {
        deptoSeleccionado = sel.value;
        if (deptoSeleccionado) {
          enfocarDepto(deptoSeleccionado);
        } else {
          map.fitBounds(BOUNDS, { padding: [26, 26], animate: true });
        }
        actualizarInfoDepto();
      });
    }
    actualizarInfoDepto();
  }

  function initRiesgo() {
    renderCloropleta();
  }

  function initEnso() {
    const toggle = document.getElementById("ensoToggle");
    const sel = document.getElementById("ensoIntensity");
    const pill = document.getElementById("ensoPill");
    function aplicar() {
      ensoActivo = toggle ? toggle.checked : false;
      ensoIntensidad = sel ? sel.value : "neutro";
      if (pill) {
        pill.textContent = ensoActivo
          ? (ensoIntensidad.charAt(0).toUpperCase() + ensoIntensidad.slice(1))
          : "Desactivado";
      }
      if (capaActiva("susceptibilidad")) renderCloropleta();
      if (deptoSeleccionado) actualizarInfoDepto();
    }
    if (toggle) toggle.addEventListener("change", aplicar);
    if (sel) sel.addEventListener("change", aplicar);
    aplicar();
  }


  function init() {
    if (typeof L === "undefined") {
      document.body.innerHTML =
        '<div style="padding:40px;font-family:Segoe UI,Arial,sans-serif;color:#e8eef7;background:#070b12;height:100vh">' +
        "<h2>No se pudo cargar el motor del mapa</h2>" +
        "<p>Revisa la conexión e inténtalo de nuevo.</p></div>";
      return;
    }
    if (!D.meta) {
      document.body.innerHTML =
        '<div style="padding:40px;font-family:Segoe UI,Arial,sans-serif;color:#e8eef7;background:#070b12;height:100vh">' +
        "<h2>No hay datos del visor</h2>" +
        "<p>Ejecuta <code>generar_datos_visor.py</code> y vuelve a construir la página.</p></div>";
      return;
    }

    const totalRegistros =
      Number(META.total_focos || (D.focos || []).length) +
      Number(META.total_quemadas || (D.quemadas || []).length) +
      Number(META.total_areas || (D.areas_puntos || []).length) +
      Number(META.total_departamentos || (D.departamentos_puntos || []).length);
    els.statusTotal.textContent = fmt(totalRegistros);

    initMap();
    renderDeptos();
    renderAreas();
    initUI();
    initStudy();
    initGeo();
    initFirms();
    initDepartamentos();
    initRiesgo();
    initEnso();
    setYear(state.year, { silent: true, toastIt: false });
    updateLegend();
    updateMapEmpty();
    updateReqUI();

    // La pantalla de carga desaparece en cuanto el mapa queda listo.
    if (map && map.whenReady) {
      map.whenReady(hideLoader);
    } else {
      hideLoader();
    }
    setTimeout(hideLoader, 10000); // máximo 10 s de pantalla de carga

    // Enlaces directos para compartir una vista:
    //   ?year=2024&cat=focos&q=Parques%20Nacionales&fit=1
    const params = new URLSearchParams(window.location.search);
    const pYear = params.get("year");
    if (pYear === "todos" || pYear === "all") {
      setYear(null, { silent: true, toastIt: false });
    } else if (pYear && ANIOS.indexOf(Number(pYear)) !== -1) {
      setYear(Number(pYear), { silent: true, toastIt: false });
    }
    const pCat = params.get("cat");
    if (pCat && CAT_LABELS[pCat] && pCat !== "todas") {
      state.category = pCat;
      updateCategoryChips();
    }
    const pQuery = params.get("q");
    if (pQuery) {
      state.query = pQuery;
      els.searchInput.value = pQuery;
      els.searchClear.classList.add("visible");
      runSearch({ silent: true, fit: params.get("fit") === "1" });
    } else if (pCat && CAT_LABELS[pCat] && pCat !== "todas") {
      runSearch({ silent: true, fit: params.get("fit") === "1" });
    }

    // Enlace directo al centro de estudio: ?study=integral|informe|igac|qr
    const pStudy = params.get("study");
    if (pStudy && ["integral", "informe", "igac", "riesgo"].indexOf(pStudy) !== -1) {
      setTimeout(function () { openStudy(pStudy); }, 320);
    }

    Toast.loading("Cargando visor…", "Preparando capas, búsqueda y documentos", "boot");
    setTimeout(() => {
      Toast.update("boot", {
        type: "success",
        title: "Visor listo",
        message:
          fmt(META.total_focos || (D.focos || []).length) + " focos y " +
          fmt(META.total_quemadas || (D.quemadas || []).length) +
          " áreas quemadas disponibles.",
        duration: 4200,
      });
      checkReq("toasts");
    }, 650);
  }

  /* -------------------------- Pantalla de carga -------------------------- */
  // Duración máxima: la pantalla se oculta en cuanto el mapa queda listo y,
  // en cualquier caso, nunca después de 10 segundos.
  const LOADER_MAX_MS = 10000;
  let loaderHidden = false;

  function hideLoader() {
    ocultarLoader();
  }

  function ocultarLoader() {
    if (loaderHidden) return;
    loaderHidden = true;
    const loader = document.getElementById("loader");
    if (!loader) return;
    loader.classList.add("loader-hidden");
    setTimeout(function () {
      if (loader.parentNode) loader.parentNode.removeChild(loader);
    }, 650);
  }
  // Red de seguridad: nunca mostrar la pantalla de carga más de 10 s.
  setTimeout(ocultarLoader, LOADER_MAX_MS);

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
