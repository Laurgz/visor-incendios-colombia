# SUSCEPTIBILIDAD Incendios Colombia · Visor nacional 2012–2026

Visor web de susceptibilidad a incendios forestales en Colombia (Google Earth
Engine · Random Forest · Leaflet). Esta carpeta `docs/` contiene el sitio listo
para publicar en **GitHub Pages**.

## Archivos

| Archivo | Descripción |
|---|---|
| `index.html` | Estructura de la página + pantalla de carga (loader). |
| `styles.css` | Hojas de estilo (diseño 100 % responsivo + animación del incendio). |
| `script.js` | Lógica de la aplicación (mapa, capas, año, búsqueda, GPS, QR, exportaciones). |
| `data.js` | Datos del visor (`window.DATOS`): capas, focos, áreas y rásteres. |
| `ficha_tecnica.pdf` | Ficha técnica (descargable). |
| `vista_previa_nacional.jpg` | Vista previa del mapa nacional. |
| `mapa_igac_nacional.jpg` | Plano de referencia para la salida cartográfica IGAC. |
| `vendor/` | Leaflet, QRCode.js y jsPDF (servidos localmente, sin CDN). |

Todo usa **rutas relativas** y **HTTPS** (las teselas de OSM/ArcGIS y los
servicios NASA ya apuntan a `https://`), por lo que funciona bajo
`https://<usuario>.github.io/<repositorio>/` sin configuración adicional.

## Publicar en GitHub Pages

**Opción A — carpeta `/docs` (recomendada):**

1. Sube este repositorio a GitHub (incluida la carpeta `docs/`).
2. En el repositorio: **Settings → Pages → Source → "Deploy from a branch"**.
3. Elige la rama `main` y la carpeta **`/docs`**.
4. Guarda. El sitio quedará en `https://<usuario>.github.io/<repositorio>/`.

**Opción B — raíz del repositorio:**

Copia el contenido de `docs/` a la raíz del repositorio y elige la carpeta `/`.

## Regenerar `data.js`

Si actualizas los datos con `generar_datos_visor.py`, vuelve a generar
`data.js` con:

```bash
python -c "import json;d=json.load(open('datos_visor.json',encoding='utf-8'));open('docs/data.js','w',encoding='utf-8').write('window.DATOS = '+json.dumps(d,ensure_ascii=False,separators=(',',':'))+';')"
```

## Créditos

- **UNIVERSIDAD ECCI**
- **LAURA RODRIGUEZ**
- **TOMAS ALFONSO**
