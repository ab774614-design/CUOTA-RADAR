# CuotaRadar

Analiza en tiempo real las cuotas de fútbol y voleibol de muchas casas a la vez, calcula la probabilidad
justa de cada resultado y te enseña las cuotas que están **a tu favor**.

## Cómo abrirla
- Doble clic en `iniciar.bat`: se abre http://localhost:5180.
- Usa el Node portátil de `Desktop\rotacion-voley\runtime`, así que no hay que instalar nada.
- Tests: `node --test test`, desde esta carpeta.

## Modos
- **Demo** (por defecto): mercado simulado con 14 competiciones de fútbol y voleibol. Las cuotas se mueven
  cada 5 s, hay casas que reaccionan tarde y de vez en cuando aparecen errores. Sirve para ver cómo funciona;
  **no son cuotas reales**.
- **Real**: ⚙ Ajustes → «Real» y pega tu clave de [The Odds API](https://the-odds-api.com). El plan gratuito
  incluye 500 créditos al mes. Salen todas las ligas de fútbol que el proveedor tenga activas; el voleibol
  aparece solo si el proveedor lo ofrece. Cada actualización de una liga gasta créditos (mercados × regiones),
  así que las cuotas se guardan en caché (180 s por defecto) y puedes elegir como máximo 20 ligas a la vez.
  Qué casas aparecen (bet365 incluida) depende de la cobertura del proveedor en las regiones que elijas.

La clave se guarda solo en `data/config.json`, en este ordenador.

## Cómo calcula la probabilidad justa
1. Si en el mercado está Pinnacle (o un exchange como Betfair), se toman sus cuotas y se les quita el margen.
2. Si no, se usa el **consenso**: la mediana de las probabilidades sin margen de todas las casas (mínimo 3).
3. Métodos para quitar el margen: potencia (por defecto), Shin, multiplicativo y aditivo.

`EV = probabilidad justa × cuota − 1`. Stake sugerido = Kelly fraccional (¼ por defecto), con un máximo del 5 % del bankroll.

## Champions League y LaLiga (siempre incluidas)
- Con clave de PulseScore entran **siempre**, aunque no estén marcadas: todos sus partidos de bet365 con todos los mercados y
  **Pinnacle (PS3838)** como referencia sin margen. Unas 4 peticiones de PulseScore por búsqueda (caché de 30 min), sin gastar
  créditos de The Odds API.
- Mercados: 1X2, doble oportunidad, empate no apuesta, ambos marcan, goles (totales y por equipo), hándicap asiático y
  **europeo**, resultado al descanso, **córners** (totales, por equipo y hándicap), **tarjetas** (totales y por equipo) y
  **disparos a puerta** (del partido y por equipo).
- Referencia: Pinnacle en 1X2, goles y hándicap asiático; en el resto no hay referencia externa gratuita y se usa el precio de
  bet365 sin su margen («referencia propia», confianza baja: el EV sale siempre algo negativo).
- **Líneas incoherentes**: si bet365 paga más por «más de 9.5» que por «más de 10.5» (o lo mismo con «menos»), se marca como
  error palpable, sin necesidad de referencia.
- No entran apuestas a cuota por debajo de 1,15 ni con más de un 90 % de acierto (arriesgan mucho para casi no ganar nada).

## Combinadas
- Oportunidades → «🎟️ Crear una apuesta»: riesgo moderado, medio, alto o **⚙️ A mi gusto** (número de selecciones, acierto
  mínimo de cada una y tipos de mercado: resultado, goles, hándicap, córners, tarjetas, disparos y voleibol). Muestra el factor
  de riesgo antes de crearla.
- Botón «➕ Combinada» en cada oportunidad para montarla a mano (una sola casa y un partido por selección).
- Los **3 planes mezclan sueltas y combinadas**: seguro, 10 % en una de 2 selecciones; moderado, 20 % en una de 3; arriesgado,
  15 % + 15 % en una de 3 y otra de 5. Los partidos de las combinadas no se repiten en las sueltas, y la simulación del riesgo
  tiene en cuenta todo junto.

## bet365 (PulseScore)
- La clave se guarda en ⚙ Ajustes → «Cuotas de bet365 (PulseScore)». Es gratis: 500 peticiones al mes. Arriba se ve cuántas llevas.
- **Fútbol**: los partidos de bet365 se emparejan con los de The Odds API por equipos y hora (`lib/match.js`). Se piden
  completas las 5 ligas de bet365 con más partidos en común (1 petición por liga, caché de 30 min) y su listado barato de
  1X2 (6 peticiones, caché de 3 h). La referencia es Pinnacle o Betfair sin margen.
- **Voleibol**: «Voleibol: todas las ligas (bet365)», en la lista de competiciones (1-2 peticiones, caché de 30 min). Como
  ningún proveedor gratuito tiene Pinnacle de voleibol, la referencia es un **modelo**: a partir del ganador del partido en
  bet365 calcula la probabilidad de ganar cada set y, con ella, el hándicap de sets, el ganador del 1.er set y el número de
  sets (`lib/b365model.js`). La confianza es baja, así que no entra en el plan seguro. El resultado exacto en sets **no** se
  modela: con datos reales el modelo se desviaba siempre y daba falsas oportunidades.
- «Apostar solo en bet365» (💰, activado si hay clave): los planes solo usan apuestas de bet365. Si no hay ninguna, la app
  dice cuántas cuotas de bet365 ha comparado y cuánto le falta a la mejor. Prueba del 2 nov: 235 cuotas, la mejor un +1,0 %,
  y un margen medio de bet365 del 7,1 %.

## Gastar pocos créditos (modo real)
- **🔎 Elegir las ligas más rentables** (panel izquierdo):
  1. Mira gratis qué ligas tienen partidos en los próximos 1, 3 o 7 días.
  2. Pide solo el 1X2 de las que tienen más partidos (1 crédito por liga).
  3. Las ordena por valor encontrado, marca solas las 3, 5 u 8 mejores y busca en ellas el resto de mercados.
  Antes de gastar te dice cuántos créditos costará. Prueba del 2 nov: 25 créditos frente a 57 buscando todo.
- **Una sola región** (Europa ya incluye Pinnacle y Betfair): la mitad de créditos que con Europa + Reino Unido.
- **Caché de 15 minutos guardada en disco** (`data/cache-odds.json`): volver a buscar, recalcular o reiniciar la app no
  vuelve a pagar las mismas cuotas, y cada mercado se guarda por separado, así que el 1X2 del rastreo no se paga dos veces.
- El botón **⟳ Buscar ahora** muestra lo que costará («~6 créditos» o «gratis (en caché)») y pide confirmación si son más de 15.
- En modo real, marcar ligas a mano ya no busca al momento, y al abrir la app solo se analiza lo que está en caché.

## Mercados analizados
- **Fútbol**: 1X2, doble oportunidad, empate no apuesta, más/menos 1.5, 2.5 y 3.5 goles, ambos marcan, goles de cada equipo,
  hándicap asiático ±1.5 y resultado exacto.
- **Voleibol**: ganador, resultado exacto en sets, más/menos 3.5 y 4.5 sets, hándicap de sets ±1.5, ganador del 1.er set y
  más/menos puntos (3 líneas).
- En modo real, The Odds API da 1X2/ganador, más/menos y hándicaps (solo se usan las líneas de medio punto). Los demás mercados
  dependen del proveedor.

## Tres planes
Con tu presupuesto calcula a la vez el plan 🛡️ **seguro** (surebets y apuestas con más del 50 % de acierto), el ⚖️ **moderado**
y el 🔥 **arriesgado** (cuotas altas y errores palpables). Para cada uno muestra el riesgo de pérdidas, el beneficio esperado y
los escenarios. Pulsando una tarjeta ves «Qué apostar»: partido, selección, casa, cuota, importe y **cuota mínima** (por debajo
de esa cuota la apuesta ya no tiene valor). El botón «Copiar» copia el plan en texto.
Las surebets de más del 10 % se tratan como posibles errores de la casa: solo entran en el plan arriesgado y se simulan con un
50 % de probabilidad de anulación.

## Noticias
Para cada partido del plan (y en el detalle de cualquier partido) se buscan noticias de los últimos días en Google Noticias, que
agrupa Marca, AS, Mundo Deportivo, Relevo, ESPN, BBC, etc. Los titulares que hablan de lesiones, bajas, dudas, sanciones,
cambios de entrenador o rotaciones aparecen como ⚠️ aviso. **No cambian las probabilidades**, porque las cuotas de Pinnacle ya
incorporan casi toda la información pública. Sirven para que revises la apuesta antes de hacerla.

## Plan de apuestas (💰)
La primera vez, la app te pregunta tu presupuesto y cuánto riesgo quieres asumir (conservador, equilibrado o agresivo).
Puedes cambiarlo cuando quieras con el botón 💰. Funciona desde 1 €.
- **Apostar todo el presupuesto** (por defecto): reparte el 100 %. Las surebets se llevan una parte (60/40/25 % según el
  perfil, si las hay) y el resto se reparte entre las apuestas de valor según su ventaja (Kelly), con un tope por apuesta.
  Con poco dinero hace pocas apuestas (10 € → como mucho 5). Los importes van en múltiplos de 0,10 € (con menos de 100 €)
  y suman exactamente el presupuesto.
- **Modo prudente** (desmarcando la casilla): Kelly fraccional y una parte en reserva.
- **Apuesta mínima por casa**: 0,10 € por defecto.

**Búsqueda fija**: por defecto no se actualiza sola. La lista y el plan se quedan como están hasta que pulses «⟳ Buscar ahora»
o «Recalcular» (que busca cuotas nuevas y rehace el plan). En el panel izquierdo puedes activar la búsqueda automática.

En la pestaña «Mi plan de apuestas» propone:
- **Dónde y cuánto apostar**: casa, partido, selección, cuota e importe (en múltiplos de 0,50 €). Las surebets van primero y
  luego las apuestas de valor, calculadas con Kelly fraccional. Hay como máximo una apuesta por partido, con un tope por
  apuesta y otro para el total arriesgado según el perfil.
- **Riesgo en %**: probabilidad de acabar en pérdidas, capital en riesgo y peor caso con su probabilidad.
- **Beneficios posibles**: beneficio esperado, escenarios malo, típico y bueno, mejor caso e histograma de 20.000 simulaciones.
  La simulación tiene en cuenta la probabilidad de que se anulen las apuestas (60 % en los errores palpables).
- En cada análisis comprueba si las apuestas del plan siguen teniendo valor: marca las que han bajado de cuota y tacha las que
  ya no merecen la pena. «Recalcular» rehace el plan con las cuotas del momento.
- En los exchanges (Betfair, Matchbook, Smarkets) se descuenta la comisión de la cuota antes de calcular el valor.

## Tipos de oportunidad
| Tipo | Qué significa | Riesgo |
|---|---|---|
| Valor (EV+) | La cuota paga más que la probabilidad justa. | Bajo-medio |
| Línea desfasada | La probabilidad justa ha subido en los últimos 10 min y esa casa no ha movido su cuota. | Medio |
| Surebet | Repartiendo el dinero entre varias casas se gana salga lo que salga. | Bajo-medio (las cuotas pueden cambiar antes de que apuestes todas las patas) |
| Arbitraje interno | Una misma casa tiene margen negativo en un mercado. | Alto: casi seguro un error |
| Error palpable | EV ≥ 25 %: cuota absurda frente al mercado. | **Alto**: las casas anulan estas apuestas |

## Limitaciones (importante)
- Las casas, bet365 incluida, pueden **anular** apuestas por «error palpable» y **limitar** las cuentas que ganan de forma
  sistemática. No todas las alertas se pueden apostar, ni a la cuota ni con el stake que propone la app.
- Las cuotas que da el proveedor llegan con retraso (desde segundos hasta minutos). La app descarta las de más de 30 min,
  pero comprueba siempre la cuota en la casa antes de apostar.
- Un EV positivo es una estimación a largo plazo, no garantiza ganar.
- La app solo analiza: no entra en tu cuenta ni apuesta por ti.
- Juego responsable: solo mayores de 18 · jugarbien.es.

## Estructura
- `server.js`: servidor sin dependencias (configuración, `/api/sports`, `/api/scan`).
- `lib/analysis.js`: quitar el margen, EV, Kelly, arbitraje, histórico y detectores.
- `lib/demo.js`: simulador (Poisson para el fútbol).
- `lib/oddsapi.js`: conector de The Odds API.
- `public/`: interfaz web.
- `test/`: tests de la matemática con casos comprobados a mano.
