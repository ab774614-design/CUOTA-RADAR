# Subir CuotaRadar a la nube (gratis)

Al terminar tendrás un enlace (por ejemplo `https://cuotaradar.onrender.com`) para abrir la app desde cualquier
ordenador o móvil, con contraseña. Tus claves de The Odds API y PulseScore se guardan como **secretos del servidor**:
no van en el código ni las ve nadie.

Necesitas dos cuentas gratuitas: **GitHub** (guarda el código) y **Render** (lo pone en marcha). Unos 15 minutos.

## 1. GitHub: guardar el código
1. Entra en <https://github.com/signup> y crea la cuenta.
2. Arriba a la derecha, **+ → New repository**.
   - Nombre: `cuotaradar`
   - Marca **Private** (privado).
   - Pulsa **Create repository**.
3. En la página que aparece, pulsa el enlace **«uploading an existing file»**.
4. Descomprime `cuotaradar-nube.zip` (está en esta carpeta). Abre la carpeta descomprimida, selecciona **todo lo que hay
   dentro** (las carpetas `lib`, `public` y `test` y los archivos `server.js`, `package.json`, `render.yaml`…) y arrástralo a
   la página de GitHub.
5. Espera a que se carguen todos y pulsa **Commit changes**.

## 2. Render: ponerla en marcha
1. Entra en <https://render.com> → **Get Started** → **GitHub** (así se conectan las dos cuentas). Acepta el acceso al
   repositorio `cuotaradar`.
2. En el panel: **New + → Blueprint** → elige `cuotaradar` → **Connect**.
3. Render te pedirá tres valores:
   - `APP_PASSWORD`: la contraseña que quieras para entrar en la app (invéntala y apúntala).
   - `ODDS_API_KEY`: tu clave de The Odds API (la del correo, 32 caracteres).
   - `PULSESCORE_KEY`: tu clave de PulseScore (Dashboard → API keys).

   Si no las tienes a mano, están en este ordenador, en `cuotas-valor\data\config.json` (`apiKey` y `psKey`). Ábrelo con el
   Bloc de notas y copia solo el texto entre comillas.
4. Pulsa **Apply**. En unos 2-3 minutos el servicio pasa a **Live**.
5. Arriba verás el enlace `https://cuotaradar-xxxx.onrender.com`. Ábrelo, escribe tu contraseña y listo. En cada ordenador o
   móvil la contraseña se pide una vez cada 30 días.

## Cosas a saber del plan gratuito
- Si nadie la usa en 15 minutos, se «duerme»: la primera vez que la abras tardará unos 30-50 segundos en despertar.
- Cada vez que se reinicia se borran las cachés. Las claves no se pierden, porque están en Render. También se reinicia el
  contador de peticiones de PulseScore, así que el número de arriba puede quedarse corto: vigila el uso en el panel de
  PulseScore.
- El presupuesto, el perfil y las ligas marcadas se guardan en cada navegador: en otro ordenador tendrás que indicarlos una vez.
- Para cambiar una clave o la contraseña: Render → tu servicio → **Environment** → cambia el valor → **Save changes**.

## Actualizar la app cuando haya cambios
1. Descomprime el `cuotaradar-nube.zip` nuevo.
2. En GitHub, abre tu repositorio `cuotaradar` → **Add file → Upload files**.
3. Arrastra **todo** el contenido de la carpeta descomprimida (los archivos con el mismo nombre se sustituyen) → **Commit changes**.
4. Render detecta el cambio y la actualiza solo en 2-3 minutos (en Render → tu servicio → **Events** verás «Deploy live»).

## Créditos de The Odds API en la nube
- La nube y tu ordenador usan la **misma clave**: los créditos que gasta una copia los pierde la otra.
- En la nube la caché se borra cada vez que el servicio se duerme, así que repetir una búsqueda tras un rato vuelve a pagarse.
- Por eso en la nube hay un **tope de 20 créditos por búsqueda** (variable `MAX_CREDITS_PER_SEARCH` en Render → Environment).
- La Champions, LaLiga y el voleibol llegan por PulseScore y no gastan créditos de The Odds API.
