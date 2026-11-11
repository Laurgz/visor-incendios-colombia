/* ==========================================================================
   flami.js — Agente virtual de voz "Flami"
   Módulo independiente: personaje kawaii, voz (Web Speech API), NLU en español,
   historial persistente y control total de la interfaz vía window.VisorAPI.
   ========================================================================== */
(function () {
  "use strict";

  var WAKE_WORD = "hola flami";
  var IDLE_MS = 3 * 60 * 1000; // ocultar tras 3 minutos de inactividad
  var SILENCIO_MS = 7000;      // debouncer: esperar 7 s de silencio para procesar
  var PITCH = 1.7;             // voz aguda y tierna
  var RATE = 1.1;

  var activo = false;
  var escuchando = false;
  var hablando = false;        // half-duplex: la síntesis bloquea el micrófono
  var idleTimer = null;
  var silencioTimer = null;
  var bufferTexto = "";
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

  // Normaliza acentos y mayúsculas para que el NLU entienda "Boyacá" == "boyaca".
  function normalizar(s) {
    return String(s).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
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
      '<div class="flami-input-row">' +
        '<input id="flamiInput" type="text" placeholder="Escribe un comando…" autocomplete="off" aria-label="Escribir comando para Flami">' +
        '<button id="flamiSend" type="button" aria-label="Enviar comando">➤</button>' +
      '</div>' +
      '<div class="flami-status" id="flamiStatus"><span class="flami-dot"></span><span id="flamiStatusText">en espera</span></div>';
    document.body.appendChild(personaje);

    return { btn: btn, personaje: personaje };
  }

  var el = null;

  // ------------------------------------------------------------- voz (TTS)
  function hablar(texto) {
    if (!window.speechSynthesis) { return; }
    // Half-duplex: bloquear el micrófono mientras Flami habla.
    detenerMic();
    hablando = true;
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
    u.onend = function () {
      hablando = false;
      if (activo) { setEstado("escuchando"); reiniciarEscucha(); }
      else { setEstado("en espera"); }
    };
    window.speechSynthesis.speak(u);
  }

  function detenerMic() {
    if (recognition && escuchando) {
      try { recognition.stop(); } catch (e) {}
    }
    escuchando = false;
  }

  // ---------------------------------------------------- reconocimiento (STT)
  function initRecognition() {
    var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      if (el) mostrarBurbuja("Tu navegador no soporta el reconocimiento de voz. Escribe tus comandos abajo.");
      return;
    }
    recognition = new SR();
    recognition.lang = "es-ES";
    recognition.continuous = true;
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;
    recognition.onresult = function (event) {
      var finalText = "";
      for (var i = event.resultIndex; i < event.results.length; i++) {
        if (event.results[i].isFinal) finalText += event.results[i][0].transcript + " ";
      }
      finalText = (finalText || "").toLowerCase().trim();
      if (!finalText) return;
      // Despertar inmediato con la frase clave, sin esperar el debouncer.
      if (!activo && finalText.indexOf(WAKE_WORD) >= 0) {
        bufferTexto = "";
        if (silencioTimer) clearTimeout(silencioTimer);
        guardarHistorial("voz", finalText);
        activar();
        return;
      }
      bufferTexto += (bufferTexto ? " " : "") + finalText;
      // Debouncer de silencio: esperar 7 s sin hablar para procesar.
      if (silencioTimer) clearTimeout(silencioTimer);
      silencioTimer = setTimeout(procesarBuffer, SILENCIO_MS);
    };
    recognition.onerror = function (e) {
      escuchando = false;
      if ((e.error === "not-allowed" || e.error === "service-not-allowed") && el) {
        mostrarBurbuja("Activa el permiso del micrófono o escribe tus comandos abajo.");
      }
    };
    recognition.onend = function () {
      escuchando = false;
      if (bufferTexto.trim()) {
        if (silencioTimer) clearTimeout(silencioTimer);
        procesarBuffer();
        return;
      }
      if (!hablando) reiniciarEscucha();
    };
  }

  function procesarBuffer() {
    if (silencioTimer) { clearTimeout(silencioTimer); silencioTimer = null; }
    var texto = bufferTexto.trim();
    bufferTexto = "";
    if (!texto) return;
    if (!activo && texto.indexOf(WAKE_WORD) >= 0) {
      guardarHistorial("voz", texto);
      activar();
      return;
    }
    if (activo) procesar(texto);
  }

  function reiniciarEscucha() {
    if (!recognition || escuchando || hablando) return;
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
    var partes = parsearCompuesto(texto);
    var respuestas = [];
    var despedida = false;
    for (var i = 0; i < partes.length; i++) {
      var r = nlu(partes[i]);
      if (r && r.texto) respuestas.push(r.texto);
      if (/^(adios|adiós|chao|chau|hasta luego|hasta pronto|hasta manana|hasta mañana|nos vemos|me voy|me retiro|bye|hasta la proxima|hasta la próxima|buenas noches)\b/.test(normalizar(partes[i]))) despedida = true;
    }
    var textoFinal = respuestas.length ? respuestas.join(" ") : "No te entendí. Pide 'ayuda'.";
    mostrarBurbuja(textoFinal);
    hablar(textoFinal);
    if (despedida) {
      // Dejar que Flami termine de despedirse y luego ocultarse.
      setTimeout(function () { desactivar(); }, 3200);
    } else {
      resetIdle();
    }
  }

  // Parser de comandos compuestos: divide por conjunciones y comas.
  function parsearCompuesto(texto) {
    var t = String(texto);
    // Proteger coordenadas ("4.6, -74.1") para que la coma no separe el par.
    t = t.replace(/(\d)\s*,\s*(-?\d)/g, "$1~COMA~$2");
    return t
      .split(/\s*(?:,\s*|\s+y\s+|\s+luego\s+|\s+despu[eé]s\s+|\s+entonces\s+|\s+y tambi[eé]n\s+|\s+adem[aá]s\s+)/i)
      .map(function (p) { return p.trim().replace(/~COMA~/g, ", "); })
      .filter(function (p) { return p.length > 0; });
  }

  function nlu(texto) {
    var t = normalizar(texto).trim();
    var API = window.VisorAPI;

    if (/^(hola|buenos dias|buenas tardes|buenas noches|hey|que tal|hola flami)\b/.test(t)) {
      return { texto: "¡Hola! Soy Flami, tu asistente del visor de incendios de Colombia. ¿En qué te ayudo?" };
    }
    if (t === "flami" || t === "flami,") {
      return { texto: "¡Aquí estoy! Dime qué necesitas." };
    }
    if (/^(adios|adiós|chao|chau|hasta luego|hasta pronto|hasta manana|hasta mañana|nos vemos|me voy|me retiro|bye|hasta la proxima|hasta la próxima|buenas noches)\b/.test(t)) {
      return { texto: "¡Hasta luego! Gracias por explorar el visor conmigo. Nos vemos pronto. ¡Cuídate mucho!" };
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

    // resumen hablado de la situación actual del país
    if (/reporte de hoy|resumen|resumir|situacion actual|que esta pasando|dame el reporte|reporte actual|resumen de incendios|como esta el pais|cómo está el país/.test(t)) {
      var res = API ? API.getResumen() : null;
      if (res) {
        var resumen =
          "Estamos analizando el año " + res.anio + ", con " + res.focos + " focos activos y " +
          res.quemadas + " áreas quemadas. En total hay " + res.totalFocos + " focos históricos registrados. ";
        if (res.ensoActivo) {
          resumen += "Hay alerta de El Niño " + res.ensoIntensidad + ", con temperaturas superficiales elevadas y mayor sequedad, así que la susceptibilidad a incendios está aumentada. ¡Mucho cuidado con las quemas!";
        } else {
          resumen += "No hay alerta de El Niño activa en este momento.";
        }
        return { texto: resumen };
      }
      return { texto: "No pude obtener el reporte en este momento." };
    }

    // Exportaciones automáticas por voz
    if (/(realiza|realizar|haz|hacer|genera|generar|exporta|exportar|descarga|descargar|produce|producir)/.test(t)) {
      if (/informe|reporte/.test(t)) {
        if (API) API.exportarInforme();
        return { texto: "Generando el informe en PDF." };
      }
      if (/mapa|plano|cartografia|cartografía/.test(t)) {
        if (/jpg|png|imagen/.test(t)) {
          if (API) API.descargarMapa();
          return { texto: "Exportando el mapa en imagen." };
        }
        if (API) API.descargarMapaPdf();
        return { texto: /pdf/.test(t) ? "Descargando el mapa en PDF." : "Realizando el mapa en PDF." };
      }
    }

    // centro de estudio
    if (/cierra|cerrar/.test(t) && /centro de estudio|estudio|modal|panel/.test(t)) {
      if (API) API.closeStudy();
      return { texto: "Cerrando el centro de estudio." };
    }
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

    // Temperatura superficial (LST): capa pendiente de datos GEE.
    if (/temperatura|lst|termica|térmica|termico|térmico/.test(t)) {
      return { texto: "La capa de temperatura superficial (LST) requiere los datos de Google Earth Engine, que aún están pendientes de procesar." };
    }

    // capas
    if (/activa|enciende|muestra|pon|prende|ver/.test(t)) {
      var capa = encontrarCapa(t);
      if (capa) {
        if (API) API.setLayer(capa.id, true);
        var anioCapa = t.match(/en\s+(20\d\d|19\d\d)/);
        if (anioCapa && API) API.setYear(anioCapa[1]);
        return { texto: "Capa " + capa.name + " activada" + (anioCapa ? " para el año " + anioCapa[1] : "") + "." };
      }
    }
    if (/desactiva|apaga|quita|oculta|esconde/.test(t)) {
      var capa2 = encontrarCapa(t);
      if (capa2) { if (API) API.setLayer(capa2.id, false); return { texto: "Capa " + capa2.name + " desactivada." }; }
    }
    if (/todas las capas|enciende todas|activa todas/.test(t)) {
      if (API) API.setAllLayers(true);
      return { texto: "Todas las capas activadas." };
    }
    if (/ninguna capa|quita todas las capas|apaga todas|desactiva todas/.test(t)) {
      if (API) API.setAllLayers(false);
      return { texto: "Todas las capas desactivadas." };
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
    if (!/ruta|trayecto|llego|llegar|llevame|llévame|calcular/.test(t) && /foco mas cercano|foco más cercano|incendio mas cercano|incendio más cercano|mas cercano|más cercano/.test(t)) {
      var nf = API ? API.irAlFocoCercano() : null;
      return { texto: nf ? "Te llevo al foco más cercano." : "No encontré focos para el año actual." };
    }
    // Ruteo interactivo por voz.
    if (/ruta|trayecto|como llego|cómo llego|como llegar|cómo llegar|calcular ruta|llevame|llévame|llevala|llévala/.test(t)) {
      if (!API) return { texto: "No puedo calcular rutas ahora." };
      // Perfil de ruta por voz.
      if (/a pie|caminando|andando/.test(t)) API.setRouteProfile("foot");
      else if (/bicicleta|bici|en bici|cicla/.test(t)) API.setRouteProfile("bike");
      else if (/carro|coche|conduciendo|manejando|en auto|en carro/.test(t)) API.setRouteProfile("driving");

      // Foco más cercano.
      if (/foco mas cercano|foco más cercano|incendio mas cercano|incendio más cercano/.test(t)) {
        var ok = API.rutaAlFocoCercano();
        return { texto: ok ? "Calculando la ruta al foco más cercano." : "No pude calcular la ruta. Activa tu ubicación." };
      }

      // Destino específico (departamento/municipio/coordenadas).
      var objetivo = t.replace(/ruta|trayecto|como llego|cómo llego|como llegar|cómo llegar|calcular ruta|llevame|llévame|llevala|llévala|hasta|a la|al |hacia/g, " ").replace(/\s+/g, " ").trim();
      if (objetivo && API.obtenerCoordenadas) {
        var dest = API.obtenerCoordenadas(objetivo);
        if (dest && API.rutaDesdeGps) {
          var r = API.rutaDesdeGps({ lat: dest.lat, lon: dest.lon });
          return { texto: r ? "Calculando la ruta hasta " + dest.nombre + "." : "Activa tu ubicación GPS para calcular la ruta desde donde estás." };
        }
      }
      return { texto: "Abre el panel de ruta y elige origen y destino, o dime 'ruta al foco más cercano'." };
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

    // búsqueda territorial universal (departamento, municipio, vereda, cuenca, coordenadas)
    if (/busca|buscar|busco|enfoca|enfócate|ir a|llevame a|llévame a|vamos a|muestrame|muéstrame|ubicame en|ubícame en|municipio|vereda|cuenca|coordenadas|departamento/.test(t)) {
      if (API && API.searchTerritory) {
        var objetivo = t
          .replace(/busca|buscar|busco|enfoca|enfócate|ir a|llevame a|llévame a|vamos a|muestrame|muéstrame|ubicame en|ubícame en|el departamento de|el municipio de|la vereda de|la cuenca de|departamento|municipio|vereda|cuenca|coordenadas/g, " ")
          .replace(/\s+/g, " ")
          .trim();
        if (objetivo) {
          var res = API.searchTerritory(objetivo);
          if (res && res.nombre) return { texto: "Enfocando " + res.nombre + " en el mapa." };
        }
      }
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

  var CAPA_ALIASES = {
    "susceptibilidad": ["susceptibilidad", "riesgo", "susceptible"],
    "focos": ["focos", "focos de calor", "calor", "incendios", "incendio"],
    "bosques": ["bosque", "bosques", "forestal"],
    "agua": ["agua", "hidricas", "hídricas", "rios", "ríos", "lagos", "cuerpos de agua"],
    "areas": ["areas protegidas", "áreas protegidas", "parques", "protegidas", "pnn"],
    "quemadas": ["quemadas", "quemada", "areas quemadas", "áreas quemadas", "cicatrices"],
    "deptos": ["departamentos", "departamento", "limites", "límites"],
    "enso": ["el nino", "el niño", "nino", "niño", "enso"],
    "lst": ["temperatura", "temperatura superficial", "lst", "termica", "térmica", "termico", "térmico"],
  };

  function encontrarCapa(texto) {
    var API = window.VisorAPI;
    if (!API || !API.listaCapas) return null;
    var t = normalizar(texto);
    for (var i = 0; i < API.listaCapas.length; i++) {
      var capa = API.listaCapas[i];
      var aliases = CAPA_ALIASES[capa.id] || [capa.name.toLowerCase()];
      for (var j = 0; j < aliases.length; j++) {
        if (t.indexOf(normalizar(aliases[j])) >= 0) return capa;
      }
    }
    return null;
  }

  function encontrarDepto(texto) {
    var API = window.VisorAPI;
    if (!API || !API.listaDeptos) return null;
    var t = normalizar(texto);
    return API.listaDeptos.find(function (d) { return t.indexOf(normalizar(d)) >= 0; }) || null;
  }

  // ------------------------------------------------------------------ init
  var pasivoIniciado = false;

  function iniciarPasivo() {
    if (pasivoIniciado || !recognition || activo || escuchando) return;
    try {
      recognition.start();
      escuchando = true;
      pasivoIniciado = true;
    } catch (e) {
      escuchando = false;
      // No marcar pasivoIniciado: se reintentará con el primer gesto del usuario.
    }
  }

  function init() {
    el = crearDOM();
    el.btn.addEventListener("click", function () {
      if (activo) desactivar();
      else activar();
    });

    // Entrada por teclado (respaldo si no hay micrófono o permiso).
    var input = el.personaje.querySelector("#flamiInput");
    var send = el.personaje.querySelector("#flamiSend");
    if (input && send) {
      var enviar = function () {
        var texto = input.value.trim();
        if (!texto) return;
        input.value = "";
        procesar(texto);
      };
      send.addEventListener("click", enviar);
      input.addEventListener("keydown", function (e) {
        if (e.key === "Enter") { e.preventDefault(); enviar(); }
      });
    }

    // precargar voces
    if (window.speechSynthesis) {
      window.speechSynthesis.onvoiceschanged = function () { window.speechSynthesis.getVoices(); };
      window.speechSynthesis.getVoices();
    }
    initRecognition();
    // Always-On Listener: intentar iniciar la escucha pasiva desde el arranque
    // (si el navegador lo permite) y, si no, con el primer gesto del usuario.
    iniciarPasivo();
    document.addEventListener("click", iniciarPasivo, { passive: true });
    document.addEventListener("keydown", iniciarPasivo, { passive: true });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
