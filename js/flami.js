/* ==========================================================================
   flami.js — Agente virtual de voz "Flami"
   Módulo independiente: personaje kawaii, voz (Web Speech API), NLU en español,
   historial persistente y control total de la interfaz vía window.VisorAPI.
   ========================================================================== */
(function () {
  "use strict";

  var WAKE_WORD = "hola flami";
  var IDLE_MS = 3 * 60 * 1000; // ocultar tras 3 minutos de inactividad
  var PITCH = 1.7;             // voz aguda y tierna
  var RATE = 1.1;

  var activo = false;
  var escuchando = false;
  var idleTimer = null;
  var recognition = null;
  var historial = [];

  // ---------------------------------------------------------------- historial
  try {
    historial = JSON.parse(localStorage.getItem("flami_historial") || "[]") || [];
  } catch (e) { historial = []; }

  function guardarHistorial(tipo, texto) {
    historial.unshift({ tipo: tipo, texto: texto, ts: Date.now() });
    historial = historial.slice(0, 200);
    try { localStorage.setItem("flami_historial", JSON.stringify(historial)); } catch (e) {}
  }

  // ------------------------------------------------------------------- DOM
  var FLAMI_SVG =
    '<svg viewBox="0 0 120 130" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
      '<defs>' +
        '<linearGradient id="flamiBody" x1="0" y1="1" x2="0" y2="0">' +
          '<stop offset="0" stop-color="#e03e22"/><stop offset="0.5" stop-color="#ff8a3c"/><stop offset="1" stop-color="#ffd166"/>' +
        '</linearGradient>' +
      '</defs>' +
      '<g class="flami-spark s1"><circle cx="24" cy="18" r="2.4" fill="#ffe08a"/></g>' +
      '<g class="flami-spark s2"><circle cx="96" cy="12" r="2" fill="#ffd166"/></g>' +
      '<g class="flami-spark s3"><circle cx="110" cy="42" r="1.7" fill="#ffe08a"/></g>' +
      '<g class="flami-flame"><path d="M60 14 C72 34 82 46 82 72 C82 96 72 110 60 110 C48 110 38 96 38 72 C38 46 48 34 60 14 Z" fill="url(#flamiBody)"/></g>' +
      '<circle cx="50" cy="70" r="5" fill="#1f2937"/><circle cx="51.6" cy="68.4" r="1.8" fill="#fff"/>' +
      '<circle cx="72" cy="70" r="5" fill="#1f2937"/><circle cx="73.6" cy="68.4" r="1.8" fill="#fff"/>' +
      '<path d="M54 82 Q61 92 68 82" fill="none" stroke="#7f1d1d" stroke-width="3.4" stroke-linecap="round"/>' +
      '<ellipse cx="42" cy="80" rx="6" ry="4" fill="#f87171" opacity="0.9"/>' +
      '<ellipse cx="80" cy="80" rx="6" ry="4" fill="#f87171" opacity="0.9"/>' +
    '</svg>';

  function crearDOM() {
    var btn = document.createElement("button");
    btn.type = "button";
    btn.id = "flamiBtn";
    btn.className = "flami-btn";
    btn.title = "Flami · Asistente de voz";
    btn.setAttribute("aria-label", "Activar o desactivar a Flami");
    btn.innerHTML = FLAMI_SVG;
    document.body.appendChild(btn);

    var personaje = document.createElement("div");
    personaje.id = "flami";
    personaje.className = "flami flami-hidden";
    personaje.innerHTML =
      '<div class="flami-bubble" id="flamiBubble"><span id="flamiBubbleText">¡Hola! Soy Flami</span></div>' +
      '<div class="flami-avatar">' + FLAMI_SVG + '</div>' +
      '<div class="flami-status" id="flamiStatus"><span class="flami-dot"></span><span id="flamiStatusText">en espera</span></div>';
    document.body.appendChild(personaje);

    return { btn: btn, personaje: personaje };
  }

  var el = null;

  // ------------------------------------------------------------- voz (TTS)
  function hablar(texto) {
    if (!window.speechSynthesis) { return; }
    window.speechSynthesis.cancel();
    var u = new SpeechSynthesisUtterance(texto);
    u.lang = "es-ES";
    u.pitch = PITCH;
    u.rate = RATE;
    var voces = window.speechSynthesis.getVoices();
    var fem = voces.find(function (v) {
      return /es/i.test(v.lang) && /female|mujer|sabina|monica|paulina|paulina/i.test(v.name);
    }) || voces.find(function (v) { return /es/i.test(v.lang); });
    if (fem) u.voice = fem;
    u.onstart = function () { setEstado("hablando"); };
    u.onend = function () { if (activo) setEstado("escuchando"); };
    window.speechSynthesis.speak(u);
  }

  // ---------------------------------------------------- reconocimiento (STT)
  function initRecognition() {
    var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return;
    recognition = new SR();
    recognition.lang = "es-ES";
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.onresult = function (event) {
      var texto = (event.results[0][0].transcript || "").toLowerCase().trim();
      if (texto) procesar(texto);
    };
    recognition.onerror = function () { setEstado("alerta"); };
    recognition.onend = function () {
      escuchando = false;
      if (activo) {
        setEstado("escuchando");
        reiniciarEscucha();
      } else {
        setEstado("en espera");
      }
    };
  }

  function reiniciarEscucha() {
    if (!recognition || !activo || escuchando) return;
    try {
      escuchando = true;
      recognition.start();
    } catch (e) { escuchando = false; }
  }

  // ------------------------------------------------------------- estado
  function setEstado(estado) {
    if (!el) return;
    var etiquetas = { "en espera": "en espera", "escuchando": "escuchando…", "procesando": "procesando…", "hablando": "hablando…", "alerta": "alerta" };
    var texto = etiquetas[estado] || "en espera";
    el.personaje.setAttribute("data-estado", estado);
    var st = el.personaje.querySelector("#flamiStatusText");
    if (st) st.textContent = texto;
  }

  function mostrarBurbuja(texto) {
    if (!el) return;
    var b = el.personaje.querySelector("#flamiBubbleText");
    if (b) b.textContent = texto;
  }

  // --------------------------------------------------------------- activar
  function activar() {
    if (!el) return;
    activo = true;
    el.personaje.classList.remove("flami-hidden");
    el.btn.classList.add("active");
    hablar("¡Hola! Soy Flami. ¿En qué puedo ayudarte?");
    setEstado("escuchando");
    reiniciarEscucha();
    resetIdle();
  }

  function desactivar() {
    activo = false;
    escuchando = false;
    if (recognition) { try { recognition.abort(); } catch (e) {} }
    if (window.speechSynthesis) window.speechSynthesis.cancel();
    if (el) {
      el.personaje.classList.add("flami-hidden");
      el.btn.classList.remove("active");
    }
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  }

  function resetIdle() {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(function () {
      if (activo) {
        guardarHistorial("sistema", "Flami se ocultó por inactividad");
        mostrarBurbuja("Me escondo un rato. ¡Llámame con el botón o diciendo 'Hola Flami'!");
        hablar("Me escondo un rato. ¡Hasta luego!");
        setTimeout(desactivar, 1200);
      }
    }, IDLE_MS);
  }

  // ---------------------------------------------------------------- NLU
  function procesar(texto) {
    guardarHistorial("comando", texto);
    setEstado("procesando");
    var r = nlu(texto);
    mostrarBurbuja(r.texto);
    hablar(r.texto);
    resetIdle();
  }

  function nlu(texto) {
    var t = texto.toLowerCase().trim();
    var API = window.VisorAPI;

    if (/^(hola|buenos dias|buenas tardes|buenas noches|hey|que tal|hola flami)\b/.test(t)) {
      return { texto: "¡Hola! Soy Flami, tu asistente del visor de incendios de Colombia. ¿En qué te ayudo?" };
    }
    if (/como estas|que haces|como te sientes/.test(t)) {
      return { texto: "¡Estoy genial y llena de energía! Pídeme activar capas, cambiar de año o buscar un municipio." };
    }
    if (/gracias/.test(t)) return { texto: "¡De nada! Aquí estoy para lo que necesites." };
    if (/quien eres|que eres|como te llamas/.test(t)) {
      return { texto: "Soy Flami, una llama amigable que te ayuda a explorar el visor nacional de incendios forestales." };
    }

    // historial
    if (/historial/.test(t)) {
      if (!historial.length) return { texto: "Aún no hay historial de comandos." };
      var ultimos = historial.slice(0, 5).map(function (h) { return h.texto; }).join(". ");
      return { texto: "Estos son tus últimos comandos: " + ultimos + "." };
    }

    // ayuda
    if (/ayuda|que puedes hacer|comandos|que sabes|ayudame/.test(t)) {
      return { texto: "Puedo activar o apagar capas, cambiar el año, ajustar El Niño, activar tu GPS, buscar municipios, cambiar el mapa base, abrir el centro de estudio y exportar informes. Prueba con 'activa focos' o 'pon el año 2020'." };
    }

    // exportar informe
    if (/exportar|descargar|generar/.test(t) && /informe|reporte|pdf/.test(t)) {
      if (API) API.exportarInforme();
      return { texto: "Generando el informe en PDF." };
    }

    // centro de estudio
    if (/centro de estudio|abre el estudio|abre el informe|ver reporte|ver informe/.test(t)) {
      if (API) API.openStudy("integral");
      return { texto: "Abriendo el centro de estudio." };
    }

    // El Niño
    if (/el niño|el nino|fenomeno del niño|niño severo|nino severo|niño moderado/.test(t)) {
      if (!API) return { texto: "No puedo ajustar El Niño ahora mismo." };
      if (/severo/.test(t)) { API.setEnso(true, "severo"); return { texto: "El Niño severo activado. Aumenté la susceptibilidad a incendios." }; }
      if (/moderado/.test(t)) { API.setEnso(true, "moderado"); return { texto: "El Niño moderado activado." }; }
      API.setEnso(true, "moderado"); return { texto: "Contexto de El Niño activado." };
    }
    if (/desactiva el niño|apaga el niño|sin niño|desactiva el nino|apaga el nino/.test(t)) {
      if (API) API.setEnso(false, "neutro");
      return { texto: "Contexto de El Niño desactivado." };
    }

    // capas
    if (/activa|enciende|muestra|pon|prende|ver/.test(t)) {
      var capa = encontrarCapa(t);
      if (capa) { if (API) API.setLayer(capa.id, true); return { texto: "Capa " + capa.name + " activada." }; }
    }
    if (/desactiva|apaga|quita|oculta|esconde/.test(t)) {
      var capa2 = encontrarCapa(t);
      if (capa2) { if (API) API.setLayer(capa2.id, false); return { texto: "Capa " + capa2.name + " desactivada." }; }
    }
    if (/todas las capas/.test(t)) {
      var lista = API ? API.listaCapas : [];
      if (API) lista.forEach(function (c) { API.setLayer(c.id, true); });
      return { texto: "Todas las capas activadas." };
    }
    if (/ninguna capa|quita todas las capas/.test(t)) {
      var lista2 = API ? API.listaCapas : [];
      if (API) lista2.forEach(function (c) { API.setLayer(c.id, false); });
      return { texto: "Capas desactivadas." };
    }

    // año / time slider
    var anio = t.match(/(20\d\d|19\d\d)/);
    if (anio && /año|ano|anio|year|pon el año|ir al año|cambia al año|pon/.test(t)) {
      if (API) API.setYear(anio[1]);
      return { texto: "Mostrando el año " + anio[1] + "." };
    }
    if (/reproduc|animacion|animación|play|time slider/.test(t)) {
      if (API) API.toggleYearPlay();
      return { texto: "Reproduciendo la animación de años." };
    }

    // GPS
    if (/mi ubicacion|mi ubicación|donde estoy|dónde estoy|gps|mi posicion|mi posición|ubicame|ubícame/.test(t)) {
      if (API) API.startGeo();
      return { texto: "Activando tu ubicación en tiempo real." };
    }
    if (/foco mas cercano|foco más cercano|incendio mas cercano|incendio más cercano|mas cercano|más cercano/.test(t)) {
      var nf = API ? API.irAlFocoCercano() : null;
      return { texto: nf ? "Te llevo al foco más cercano." : "No encontré focos para el año actual." };
    }

    // mapa base
    if (/satelital|satélite|satelite|vista satelital|imagen satelital/.test(t)) {
      if (API) API.setBasemap("sat");
      return { texto: "Cambiando a la vista satelital." };
    }
    if (/mapa de calles|calles|openstreetmap|mapa normal|mapa base normal/.test(t)) {
      if (API) API.setBasemap("osm");
      return { texto: "Cambiando al mapa de calles." };
    }

    // departamentos
    var depto = encontrarDepto(t);
    if (depto && /departamento|enfoca|enfócate|ir a|muestra|ver|busca|buscar/.test(t)) {
      if (API) API.enfocarDepto(depto);
      return { texto: "Enfocando el departamento de " + depto + "." };
    }

    // búsqueda genérica
    if (/busca|buscar|busco/.test(t)) {
      var q = t.replace(/busca|buscar|busco/, "").trim();
      if (q && API) { API.buscar(q); return { texto: "Buscando " + q + "." }; }
    }

    // conocimiento técnico
    if (/gee|google earth engine/.test(t)) {
      return { texto: "Google Earth Engine procesa los datos satelitales y entrena el modelo Random Forest a 250 metros de resolución." };
    }
    if (/random forest/.test(t)) {
      return { texto: "El Random Forest clasifica la susceptibilidad a incendios usando 18 variables ambientales, desde temperatura hasta pendiente." };
    }
    if (/firms|nasa/.test(t)) {
      return { texto: "NASA FIRMS aporta los focos de calor de los satélites MODIS y VIIRS desde 2012." };
    }
    if (/chirps|precipitacion|precipitación|lluvia/.test(t)) {
      return { texto: "CHIRPS aporta los datos de precipitación; junto con la temperatura definen la sequía y la amenaza." };
    }
    if (/ideam/.test(t)) {
      return { texto: "El IDEAM es la fuente hidroclimática oficial de Colombia, complementaria a los datos satelitales." };
    }
    if (/roc|auc|matriz de confusion|matriz de confusión|f1/.test(t)) {
      return { texto: "El modelo se valida con matriz de confusión, ROC/AUC y F1-score sobre el 20 por ciento de los datos de prueba." };
    }
    if (/frp|potencia radiativa/.test(t)) {
      return { texto: "El FRP mide la potencia radiativa de los focos en vivo de NASA FIRMS, expresada en megavatios." };
    }
    if (/historico|histórico|desde el 2000|desde 2000/.test(t)) {
      return { texto: "El histórico oficial de focos cubre de 2012 a 2026. Extenderlo al año 2000 requiere reprocesar los datos satelitales." };
    }

    return { texto: "No te entendí bien. Prueba con 'activa focos', 'pon el año 2020' o pide 'ayuda'." };
  }

  function encontrarCapa(texto) {
    var API = window.VisorAPI;
    if (!API || !API.listaCapas) return null;
    var t = texto.toLowerCase();
    return API.listaCapas.find(function (c) { return t.indexOf(c.name.toLowerCase()) >= 0; }) || null;
  }

  function encontrarDepto(texto) {
    var API = window.VisorAPI;
    if (!API || !API.listaDeptos) return null;
    var t = texto.toLowerCase();
    return API.listaDeptos.find(function (d) { return t.indexOf(d.toLowerCase()) >= 0; }) || null;
  }

  // ------------------------------------------------------------------ init
  function init() {
    el = crearDOM();
    el.btn.addEventListener("click", function () {
      if (activo) desactivar();
      else activar();
    });
    // precargar voces
    if (window.speechSynthesis) {
      window.speechSynthesis.onvoiceschanged = function () { window.speechSynthesis.getVoices(); };
      window.speechSynthesis.getVoices();
    }
    initRecognition();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
