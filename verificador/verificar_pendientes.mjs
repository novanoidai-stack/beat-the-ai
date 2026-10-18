// Beat the AI · fase 2: el verificador del Hall of Fame. Coge las partidas «pendiente» de Supabase, vuelve a jugar cada una con
// el MISMO simulador.wasm de su build (verificador/builds/<build>/) y la marca:
//   · «verificada», con el resultado, la huella, los disparos y los aciertos que da la repetición;
//   · «rechazada», con el motivo: build desconocido, cabecera que no casa, entradas ilegibles, partida sin terminar, un
//     resultado que no es el que dijo la página (una repetición tocada a mano da otra batalla) o una copia de una partida ya
//     verificada (la misma batalla: mismo build, semilla y huella; las repeticiones del Hall of Fame son públicas).
// También limpia los nombres (web/nombres.js). Lo lanza la GitHub Action cada 30 min (.github/workflows/verificar.yml).
// Uso: SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… node verificador/verificar_pendientes.mjs   (Node 22+: WebAssembly GC)
// La clave de servicio salta los permisos de la tabla: es secreta (en GitHub, un «secret»); no se imprime nunca.
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
require(path.join(AQUI, "wasm-gc-runtime.js"));
const { limpiarNombre } = require(path.join(AQUI, "..", "web", "nombres.js"));

const URL_BASE = process.env.SUPABASE_URL, CLAVE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const LOTE = Number(process.env.LOTE || 100), TIEMPO_MAX_MS = Number(process.env.TIEMPO_MAX_S || 420) * 1000;
if (!URL_BASE || !CLAVE) {
	console.error("faltan SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY");
	process.exit(2);
}

async function rest(metodo, ruta, cuerpo) {
	const r = await fetch(`${URL_BASE}/rest/v1/${ruta}`, {
		method: metodo,
		headers: { apikey: CLAVE, Authorization: `Bearer ${CLAVE}`, "Content-Type": "application/json", Prefer: "return=minimal" },
		body: cuerpo ? JSON.stringify(cuerpo) : undefined,
	});
	if (!r.ok) throw new Error(`${metodo} ${ruta.split("?")[0]}: ${r.status} ${await r.text()}`);
	return metodo === "GET" ? r.json() : null;
}

/** Un simulador por build, cargado la primera vez que hace falta (y su mapa: ~3 s); null si no tenemos ese build. */
const simuladores = new Map();
async function simulador(build) {
	if (simuladores.has(build)) return simuladores.get(build);
	const wasm = path.join(AQUI, "builds", build, "simulador.wasm");
	let api = null;
	if (/^BTA1-[0-9a-z]{3,16}$/.test(build) && fs.existsSync(wasm)) {
		const t = performance.now();
		api = (await TeaVM.wasmGC.load(wasm, { nodejs: true })).exports;
		api.preparar();
		console.log(`[verificador] simulador ${build} listo en ${((performance.now() - t) / 1000).toFixed(1)} s`);
	}
	simuladores.set(build, api);
	return api;
}

/** Lo que el verificador pone en la fila: {estado, resultado, huella, disparos, aciertos, motivo}. */
export async function verificar(p) {
	const c = String(p.repeticion).split(";", 4);
	if (c.length < 4 || c[0] !== p.build || c[1] !== p.modo || c[2] !== String(p.semilla) || Number(c[3]) !== p.ticks)
		return { estado: "rechazada", motivo: "la cabecera de la repetición no casa con la partida" };
	const api = await simulador(p.build);
	if (!api) return { estado: "rechazada", motivo: `build desconocido: ${p.build}` };
	const r = api.repetir(p.repeticion);
	if (r.startsWith("ERROR")) return { estado: "rechazada", motivo: r.slice(6) };
	const [ticks, ganador, huella, disparos, aciertos] = r.split(" ");
	const resultado = { VERDE: "WIN", ROJO: "LOSS", EMPATE: "DRAW" }[ganador];
	if (!resultado) return { estado: "rechazada", motivo: "la partida no terminó", huella };
	if (Number(ticks) !== p.ticks) return { estado: "rechazada", motivo: `dura ${ticks} ticks, no ${p.ticks}`, resultado, huella };
	if (resultado !== p.resultado_declarado) return { estado: "rechazada", motivo: `dice ${p.resultado_declarado} y la repetición da ${resultado}`, resultado, huella };
	// la misma batalla ya verificada: es una copia (las repeticiones del Hall of Fame son públicas)
	const [original] = await rest("GET", `partidas?estado=eq.verificada&build=eq.${encodeURIComponent(p.build)}&modo=eq.${p.modo}` +
		`&semilla=eq.${p.semilla}&huella=eq.${huella}&select=id&limit=1`);
	if (original) return { estado: "rechazada", motivo: `la misma batalla que la #${original.id}`, resultado, huella };
	return { estado: "verificada", resultado, huella, disparos: Number(disparos), aciertos: Number(aciertos) };
}

async function main() {
	const t0 = performance.now(), cuenta = { verificada: 0, rechazada: 0 };
	let ultimo = 0;
	while (performance.now() - t0 < TIEMPO_MAX_MS) {
		const lote = await rest("GET", `partidas?estado=eq.pendiente&id=gt.${ultimo}&order=id.asc&limit=${LOTE}` +
			"&select=id,nombre,modo,semilla,build,ticks,resultado_declarado,repeticion");
		if (!lote.length) break;
		for (const p of lote) {
			ultimo = p.id;
			let v;
			try {
				v = await verificar(p);
			} catch (e) {
				v = { estado: "rechazada", motivo: "fallo al repetirla: " + String(e).slice(0, 200) };
			}
			const nombre = limpiarNombre(p.nombre);
			const cambios = { ...v, verificada_en: new Date().toISOString() };
			if (nombre !== p.nombre) {
				cambios.nombre = nombre;
				cambios.motivo = [v.motivo, "nombre cambiado"].filter(Boolean).join(" · ");
			}
			await rest("PATCH", `partidas?id=eq.${p.id}`, cambios);
			cuenta[v.estado]++;
			console.log(`[verificador] #${p.id} ${p.modo} semilla ${p.semilla}: ${v.estado}${v.resultado ? " " + v.resultado : ""}${v.motivo ? " (" + v.motivo + ")" : ""}`);
			if (performance.now() - t0 > TIEMPO_MAX_MS) break;
		}
	}
	console.log(`[verificador] ${cuenta.verificada} verificadas, ${cuenta.rechazada} rechazadas en ${((performance.now() - t0) / 1000).toFixed(1)} s`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main().catch(e => {
	console.error("[verificador] " + e.message);
	process.exit(1);
});
