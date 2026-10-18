// Beat the AI · fase 1. El bucle en tiempo real: 20 ticks por segundo del simulador (WebAssembly, el mismo Java que el mod)
// con la entrada del jugador, y el dibujo en Canvas (el mapa visto desde arriba, los tanques, los disparos, lo que decide cada
// IA y el HUD). Todo lo que pasa en la batalla lo decide el simulador; aquí solo se lee el teclado y el ratón y se dibuja.
"use strict";

const TICK_MS = 50;
const PX_MAPA = 4;                  // píxeles por bloque de mapa.webp
const FANTASMA_MS = 15000;          // lo que dura la última posición vista de un enemigo
const VEL_PROYECTIL = [773, 930, 773]; // m/s: AP, APCR, HE (para animar el vuelo del trazo)
const $ = id => document.getElementById(id);
const espera = ms => new Promise(r => setTimeout(r, ms));
const params = new URLSearchParams(location.search);
let rayos = params.has("xray");  // se ven todos los enemigos (para vídeos; en el visor de repeticiones, con la X)

const lienzo = $("lienzo"), ctx = lienzo.getContext("2d");
const mini = $("minimapa"), mctx = mini.getContext("2d");
let api = null, mapa = null, listo = false;
let info = null, prev = null, cur = null, yo = 0, nombres = {};
let jugando = false, pausado = false, terminado = false, cuentaHasta = 0;
let acumulado = 0, ultimoFrame = 0;
let zoom = 0, camX = 200, camZ = 200, mirarX = 0, mirarZ = 0;
let raton = { x: innerWidth / 2, y: innerHeight / 2, dentro: false }, disparando = false, municion = 0;
const teclas = {};
let fantasmas = {}, trazos = [], destellos = [], textos = [];
let stats = null;
let visor = null;   // viendo una repetición del Hall of Fame: {id, quien, velocidad, total}
let envio = null;   // la partida que acaba de terminar, lista para el Hall of Fame: {datos, enviado}

// ======================================================================= sonido (sintetizado con WebAudio: sin archivos)

const Sonido = {
	ctx: null, mudo: false,
	iniciar() {
		if (this.ctx) return;
		try { this.ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch { }
		try { this.mudo = localStorage.getItem("bta-mudo") === "1"; } catch { }
	},
	ruido(dur) {
		const c = this.ctx, b = c.createBuffer(1, Math.ceil(c.sampleRate * dur), c.sampleRate), d = b.getChannelData(0);
		for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
		const s = c.createBufferSource(); s.buffer = b; return s;
	},
	salida(vol, pan) {
		const c = this.ctx, g = c.createGain(); g.gain.value = vol;
		if (c.createStereoPanner) { const p = c.createStereoPanner(); p.pan.value = Math.max(-1, Math.min(1, pan || 0)); g.connect(p); p.connect(c.destination); }
		else g.connect(c.destination);
		return g;
	},
	/** Un cañonazo: el estampido (ruido grave que se apaga) y el golpe de aire (seno a 55 Hz). */
	canon(vol = 1, pan = 0, largo = 1) {
		if (!this.ctx || this.mudo) return;
		const c = this.ctx, t = c.currentTime, o = this.salida(0.9 * vol, pan);
		const r = this.ruido(1.4 * largo), f = c.createBiquadFilter(); f.type = "lowpass"; f.frequency.setValueAtTime(1800, t); f.frequency.exponentialRampToValueAtTime(140, t + 0.9 * largo);
		const g = c.createGain(); g.gain.setValueAtTime(1, t); g.gain.exponentialRampToValueAtTime(0.001, t + 1.3 * largo);
		r.connect(f); f.connect(g); g.connect(o); r.start(t);
		const s = c.createOscillator(), gs = c.createGain(); s.frequency.setValueAtTime(70, t); s.frequency.exponentialRampToValueAtTime(38, t + 0.4);
		gs.gain.setValueAtTime(0.9, t); gs.gain.exponentialRampToValueAtTime(0.001, t + 0.5); s.connect(gs); gs.connect(o); s.start(t); s.stop(t + 0.55);
	},
	/** Metal contra metal: un golpe seco con resonancia (impacto que entra) o un silbido que se va (rebote). */
	golpe(rebote, vol = 1, pan = 0) {
		if (!this.ctx || this.mudo) return;
		const c = this.ctx, t = c.currentTime, o = this.salida(0.5 * vol, pan);
		if (rebote) {
			const s = c.createOscillator(), g = c.createGain(); s.type = "triangle";
			s.frequency.setValueAtTime(3200, t); s.frequency.exponentialRampToValueAtTime(900, t + 0.35);
			g.gain.setValueAtTime(0.5, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.4); s.connect(g); g.connect(o); s.start(t); s.stop(t + 0.42);
		}
		const r = this.ruido(0.25), f = c.createBiquadFilter(); f.type = "bandpass"; f.frequency.value = rebote ? 2600 : 900; f.Q.value = 4;
		const g = c.createGain(); g.gain.setValueAtTime(1.4, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.22);
		r.connect(f); f.connect(g); g.connect(o); r.start(t);
	},
	/** El cerrojo: dos chasquidos cortos (cañón cargado). */
	cargado() {
		if (!this.ctx || this.mudo) return;
		const c = this.ctx, o = this.salida(0.25, 0);
		for (const dt of [0, 0.09]) {
			const t = c.currentTime + dt, r = this.ruido(0.05), f = c.createBiquadFilter(); f.type = "highpass"; f.frequency.value = 2500;
			const g = c.createGain(); g.gain.setValueAtTime(1, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.045);
			r.connect(f); f.connect(g); g.connect(o); r.start(t);
		}
	},
	alternar() { this.mudo = !this.mudo; try { localStorage.setItem("bta-mudo", this.mudo ? "1" : "0"); } catch { } return this.mudo; },
};

/** Lo lejos y a qué lado está algo para el sonido: {vol, pan}. */
function oido(x, z) {
	const p = tanque(cur, yo), d = Math.hypot(x - p.x, z - p.z);
	return { vol: Math.max(0.12, Math.min(1, 60 / Math.max(60, d))), pan: Math.max(-0.8, Math.min(0.8, (x - camX) / (innerWidth / zoom / 2))) };
}

// ======================================================================= sprites del Tiger

/** El Tiger visto desde arriba (render del modelo del mod, CC BY 4.0 de drcrazzie): casco y torreta, con un tinte por bando. */
const SPRITE = { casco: 6.6, torreta: 10.8, pivote: 0.115 }; // metros que cubre cada imagen y el pivote de la torreta (delante del centro)
let sprites = null;
function cargarImagen(src) { return new Promise((ok, mal) => { const i = new Image(); i.onload = () => ok(i); i.onerror = mal; i.src = src; }); }
function tenir(img, color, alfa) {
	const c = document.createElement("canvas"); c.width = img.width; c.height = img.height;
	const g = c.getContext("2d");
	g.drawImage(img, 0, 0);
	g.globalCompositeOperation = "multiply"; g.globalAlpha = alfa; g.fillStyle = color; g.fillRect(0, 0, c.width, c.height);
	g.globalCompositeOperation = "destination-in"; g.globalAlpha = 1; g.drawImage(img, 0, 0);
	return c;
}
async function cargarSprites() {
	try {
		const [casco, torreta] = await Promise.all([cargarImagen("sprites/tiger_casco.png"), cargarImagen("sprites/tiger_torreta.png")]);
		sprites = {};
		for (const [tipo, color, alfa] of [["yo", "#ffffff", 0], ["ia", "#e5484d", 0.85], ["resto", "#2a2a2a", 0.85], ["fantasma", "#e5484d", 0.85]])
			sprites[tipo] = { casco: tenir(casco, color, alfa), torreta: tenir(torreta, color, alfa) };
	} catch (e) { console.warn("sin sprites del Tiger: se dibujan formas", e); }
}

// ======================================================================= carga

function estadoCarga(t) { $("carga").textContent = t; }

(async () => {
	try {
		const t0 = performance.now();
		const tv = await TeaVM.wasmGC.load("simulador.wasm");
		api = tv.exports;
		[mapa] = await Promise.all([cargarImagen("mapa.webp"), cargarSprites()]);
		estadoCarga("Building the battlefield (400 × 400 blocks)…");
		await espera(30);
		api.preparar();
		listo = true;
		estadoCarga(`Ready · simulator loaded in ${((performance.now() - t0) / 1000).toFixed(1)} s · build ${api.version().replace("BTA1-", "")}`);
		for (const b of document.querySelectorAll(".modo")) b.disabled = false;
		pintarRecords();
		pintarSalon();
		if (params.get("watch")) verRepeticion(parseInt(params.get("watch")));
		else if (params.get("mode")) empezar(params.get("mode"), params.get("seed") ? parseInt(params.get("seed")) : undefined);
	} catch (e) {
		console.error(e);
		estadoCarga("Could not start the simulator: " + e + ". It needs a browser with WebAssembly GC (Chrome 119+, Firefox 120+, Safari 18.2+).");
	}
})();

// ======================================================================= récords (en este navegador)

function records() {
	try { return JSON.parse(localStorage.getItem("bta-records") || "{}"); } catch { return {}; }
}
function guardarRecord(modo, gano, segundos) {
	const r = records(), m = r[modo] || { intentos: 0, victorias: 0, mejor: 0, rapida: 0 };
	m.intentos++;
	if (gano) { m.victorias++; m.rapida = m.rapida ? Math.min(m.rapida, segundos) : segundos; }
	else m.mejor = Math.max(m.mejor, segundos);
	r[modo] = m;
	try { localStorage.setItem("bta-records", JSON.stringify(r)); } catch { }
}
function pintarRecords() {
	const r = records();
	for (const modo of ["1v1", "1v3", "1v5"]) {
		const m = r[modo];
		$("r" + modo).textContent = !m ? "Not tried yet" : m.victorias ? `Beaten ${m.victorias}× in ${m.intentos} tries · best ${reloj(m.rapida)}`
			: `${m.intentos} ${m.intentos === 1 ? "try" : "tries"} · lasted ${reloj(m.mejor)}`;
	}
}

// ======================================================================= partida

function empezar(modo, semilla) {
	if (!listo) return;
	Sonido.iniciar();
	if (semilla === undefined || isNaN(semilla)) semilla = Math.floor(Math.random() * 2147483647);
	visor = null;
	prepararVista(JSON.parse(api.nueva(modo, semilla)), modo, semilla);
	cuentaHasta = performance.now() + 3000;
	history.replaceState(null, "", `?mode=${modo}&seed=${semilla}${rayos ? "&xray" : ""}`);
}

/** Todo lo que hace falta para dibujar una partida nueva (jugada o de una repetición). */
function prepararVista(nuevaInfo, modo, semilla) {
	info = nuevaInfo;
	yo = info.yo;
	nombres = {};
	for (const t of info.tanques) nombres[t.id] = t.n;
	cur = JSON.parse(api.estado());
	prev = cur;
	fantasmas = {}; trazos = []; destellos = []; textos = [];
	stats = { modo, semilla, dano: 0, kills: 0, rojos: info.tanques.length - 1, muerte: 0 };
	municion = 0;
	disparando = false;
	const t = tanque(cur, yo);
	camX = t.x; camZ = t.z; mirarX = 0; mirarZ = 0;
	zoom = Math.max(2, Math.min(innerWidth, innerHeight) / 165);
	$("portada").classList.add("oculto");
	$("final").classList.add("oculto");
	$("hud").classList.remove("oculto");
	$("avisos").innerHTML = "";
	$("modoTxt").textContent = `${modo.replace("v", " VS ")} · ELITE AI`;
	$("visorBarra").classList.toggle("oculto", !visor);
	$("pausa").classList.add("oculto");
	jugando = true; terminado = false; pausado = false;
	envio = null;
	acumulado = 0;
	actualizarHud();
}

function tanque(est, id) { return est.tk[id]; }

/** La mira en el mundo (bloques) desde la posición del ratón en la pantalla. */
function ratonMundo() {
	return { x: camX + (raton.x - innerWidth / 2) / zoom, z: camZ + (raton.y - innerHeight / 2) / zoom };
}

/** La mira del jugador: el ratón o, en el visor, adónde apuntaba el jugador de la repetición. */
function miraMundo() {
	return visor ? { x: cur.yo.mira[0], z: cur.yo.mira[1] } : ratonMundo();
}

function tick() {
	if (visor) {
		prev = cur;
		cur = JSON.parse(api.pasoRepeticion(1));
		procesar(prev, cur);
		if (!terminado && cur.t >= visor.total) acabar(); // sin más entradas (no debería pasar: se envían partidas terminadas)
		return;
	}
	const av = (teclas.KeyW || teclas.ArrowUp ? 1 : 0) - (teclas.KeyS || teclas.ArrowDown ? 1 : 0);
	const gi = (teclas.KeyA || teclas.ArrowLeft ? 1 : 0) - (teclas.KeyD || teclas.ArrowRight ? 1 : 0);
	const m = ratonMundo();
	const bits = (disparando ? 1 : 0) | (municion << 1);
	const j = api.paso(av, gi, Math.round(m.x * 8), Math.round(m.z * 8), bits);
	prev = cur;
	cur = JSON.parse(j);
	procesar(prev, cur);
}

/** Lo nuevo de este tick: disparos, avisos, quién se ve, bajas y el final. */
function procesar(a, b) {
	const ahora = performance.now();
	for (const t of b.tk) {
		if (t.id === yo) continue;
		if (t.vis && !t.d) fantasmas[t.id] = { x: t.x, z: t.z, y: t.y, tt: t.tt, cuando: ahora };
		const antes = tanque(a, t.id);
		if (t.d && !antes.d) {
			delete fantasmas[t.id];
			aviso(`${nombres[t.id]} DESTROYED`, "");
			destellos.push({ x: t.x, z: t.z, r: 9, t: ahora, dur: 900 });
		}
	}
	const yoA = tanque(a, yo), yoB = tanque(b, yo);
	for (const s of b.sh) {
		const [x0, z0, x1, z1, hit, quien] = s;
		const largo = Math.hypot(x1 - x0, z1 - z0);
		const mio = quien === yo;
		const vel = mio ? VEL_PROYECTIL[b.yo.m] : 773;
		trazos.push({ x0, z0, x1, z1, hit, mio, t: ahora, vuelo: Math.max(60, 1000 * largo / vel) });
		if (mio) Sonido.canon(1, 0); else { const o = oido(x0, z0); Sonido.canon(0.75 * o.vol, o.pan); }
		destellos.push({ x: x0, z: z0, r: 2.5, t: ahora, dur: 160, boca: true });
		// el fogonazo delata al que dispara
		if (!mio && quien >= 0 && !tanque(b, quien).vis) fantasmas[quien] = { x: tanque(b, quien).x, z: tanque(b, quien).z, y: tanque(b, quien).y, tt: tanque(b, quien).tt, cuando: ahora, fogonazo: true };
	}
	for (const [tipo, obj, tir, dano] of b.ev) {
		const t = tanque(b, obj);
		if (["PENETRACION", "REBOTE", "NO_PENETRA", "CRITICO"].includes(tipo)) {
			const o = oido(t.x, t.z);
			setTimeout(() => Sonido.golpe(tipo !== "PENETRACION" && tipo !== "CRITICO", obj === yo ? 1 : o.vol, obj === yo ? 0 : o.pan), obj === yo ? 0 : 120);
		}
		if (tipo === "DESTRUIDO") { const o = oido(t.x, t.z); setTimeout(() => Sonido.canon(obj === yo ? 1.2 : 1.1 * o.vol, obj === yo ? 0 : o.pan, 1.8), 150); }
		if (tir === yo && obj !== yo) {
			if (dano > 0) stats.dano += dano;
			const txt = { PENETRACION: `PENETRATION −${dano}`, REBOTE: "RICOCHET", NO_PENETRA: "NO PENETRATION", CRITICO: "CRITICAL HIT", AMMO_RACK: "AMMO RACK!",
				IMPACTO: `HE SPLASH −${dano}`, MODULO: "MODULE HIT", TRIPULANTE: "CREW HIT", INCENDIO: "SET ON FIRE", DESTRUIDO: "" }[tipo];
			if (txt) { aviso(txt, tipo === "REBOTE" || tipo === "NO_PENETRA" ? "gris" : ""); textos.push({ x: t.x, z: t.z, txt, t: ahora }); }
		} else if (obj === yo) {
			const txt = { PENETRACION: `YOU'RE HIT −${dano}`, REBOTE: "THEIR SHELL BOUNCED", NO_PENETRA: "ARMOR HELD", CRITICO: "CRITICAL DAMAGE", AMMO_RACK: "AMMO RACK HIT",
				IMPACTO: `HE SPLASH −${dano}`, MODULO: "MODULE DAMAGED", TRIPULANTE: "CREW WOUNDED", INCENDIO: tir < 0 ? "" : "YOU'RE ON FIRE", DESTRUIDO: "YOU'RE DESTROYED" }[tipo];
			if (txt) aviso(txt, tipo === "REBOTE" || tipo === "NO_PENETRA" ? "gris" : "malo");
		}
	}
	if (yoB.d && !yoA.d) stats.muerte = b.t;
	if (a.yo.r > 0 && b.yo.r === 0 && b.yo.ok && !yoB.d) Sonido.cargado();
	if (b.fin && !terminado) acabar();
}

function aviso(txt, clase) {
	const d = document.createElement("div");
	d.className = "aviso " + (clase || "");
	d.textContent = txt;
	const c = $("avisos");
	c.appendChild(d);
	while (c.children.length > 4) c.firstChild.remove();
	setTimeout(() => d.remove(), 2700);
}

// ======================================================================= el bucle

function bucle(ahora) {
	requestAnimationFrame(bucle);
	const dt = Math.min(250, ahora - (ultimoFrame || ahora));
	ultimoFrame = ahora;
	if (jugando && !pausado && !terminado && ahora >= cuentaHasta) {
		acumulado += dt;
		let n = 0;
		const paso = TICK_MS / (visor ? visor.velocidad : 1), tope = visor ? 4 * visor.velocidad : 4;
		while (acumulado >= paso && n < tope && !terminado) { tick(); acumulado -= paso; n++; }
		if (acumulado > paso * tope) acumulado = 0; // muy atrasado (pestaña en segundo plano): no se recupera de golpe
		if (n > 0) actualizarHud();
	}
	const quedan = cuentaHasta - ahora;
	$("cuenta").textContent = !jugando || terminado ? "" : quedan > 0 && quedan < 4000 ? Math.ceil(quedan / 1000) : quedan <= 0 && quedan > -600 ? "GO" : "";
	dibujar(ahora);
}
requestAnimationFrame(bucle);

// ======================================================================= dibujo

function lerp(a, b, k) { return a + (b - a) * k; }
function lerpAng(a, b, k) { let d = ((b - a) % 360 + 540) % 360 - 180; return a + d * k; }
function rad(yaw) { return (yaw + 90) * Math.PI / 180; } // yaw de Minecraft (0 = +z, 90 = −x) → ángulo de pantalla

function dibujar(ahora) {
	const W = innerWidth, H = innerHeight, dpr = devicePixelRatio || 1;
	if (lienzo.width !== Math.round(W * dpr) || lienzo.height !== Math.round(H * dpr)) { lienzo.width = Math.round(W * dpr); lienzo.height = Math.round(H * dpr); }
	ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
	ctx.fillStyle = "#0a0a0a";
	ctx.fillRect(0, 0, W, H);
	if (!jugando || !cur || !mapa) { dibujarFondoPortada(W, H, ahora); return; }
	const k = terminado || pausado || ahora < cuentaHasta ? 1 : Math.min(1, acumulado / (TICK_MS / (visor ? visor.velocidad : 1)));
	const pa = tanque(prev, yo), pb = tanque(cur, yo);
	const px = lerp(pa.x, pb.x, k), pz = lerp(pa.z, pb.z, k);
	// la cámara sigue al tanque y se adelanta un poco hacia donde mira el ratón
	if (visor) {
		const lim = Math.min(W, H) / zoom * 0.3;
		mirarX = lerp(mirarX, Math.max(-lim, Math.min(lim, (cur.yo.mira[0] - pb.x) * 0.3)), 0.06);
		mirarZ = lerp(mirarZ, Math.max(-lim, Math.min(lim, (cur.yo.mira[1] - pb.z) * 0.3)), 0.06);
	} else {
		mirarX = lerp(mirarX, (raton.x - W / 2) / zoom * 0.35, 0.08);
		mirarZ = lerp(mirarZ, (raton.y - H / 2) / zoom * 0.35, 0.08);
	}
	camX = px + mirarX; camZ = pz + mirarZ;
	const margen = 30, mx = W / 2 / zoom - margen, mz = H / 2 / zoom - margen;
	if (mx < info.ancho / 2) camX = Math.max(mx, Math.min(info.ancho - mx, camX));
	if (mz < info.ancho / 2) camZ = Math.max(mz, Math.min(info.ancho - mz, camZ));
	const aPantalla = (x, z) => [(x - camX) * zoom + W / 2, (z - camZ) * zoom + H / 2];
	ctx.save();
	ctx.translate(W / 2 - camX * zoom, H / 2 - camZ * zoom);
	ctx.scale(zoom, zoom);
	ctx.imageSmoothingEnabled = zoom < PX_MAPA * 0.9;
	ctx.drawImage(mapa, 0, 0, info.ancho, info.ancho);
	// el alcance (300 m: lo que ve y hasta donde llega el cañón, el tuyo y el de la IA)
	if (!pb.d) {
		ctx.beginPath(); ctx.arc(px, pz, info.rango, 0, Math.PI * 2);
		ctx.strokeStyle = "rgba(244,244,242,.18)"; ctx.lineWidth = 1.2 / zoom; ctx.setLineDash([6 / zoom, 6 / zoom]); ctx.stroke(); ctx.setLineDash([]);
	}
	// fantasmas: dónde viste a cada enemigo por última vez
	for (const id in fantasmas) {
		const f = fantasmas[id], t = tanque(cur, +id), edad = ahora - f.cuando;
		if (t.vis && !t.d || edad > FANTASMA_MS) { if (edad > FANTASMA_MS) delete fantasmas[id]; continue; }
		const a = Math.max(0, 1 - edad / FANTASMA_MS);
		ctx.globalAlpha = 0.35 + 0.55 * a;
		dibujarTanque(f.x, f.z, f.y, f.tt, "fantasma");
		ctx.globalAlpha = 1;
	}
	// los tanques
	for (const tb of cur.tk) {
		if (tb.q) continue;
		const ta = tanque(prev, tb.id);
		if (tb.id !== yo && !tb.vis && !rayos && !tb.d) continue;
		if (tb.id !== yo && tb.d && !tb.vis && !rayos) continue;
		const x = lerp(ta.x, tb.x, k), z = lerp(ta.z, tb.z, k);
		dibujarTanque(x, z, lerpAng(ta.y, tb.y, k), lerpAng(ta.tt, tb.tt, k), tb.d ? "resto" : tb.id === yo ? "yo" : "ia");
	}
	// trazos de los disparos: el proyectil vuela a su velocidad y deja la estela
	trazos = trazos.filter(s => ahora - s.t < s.vuelo + 450);
	for (const s of trazos) {
		const e = ahora - s.t, f = Math.min(1, e / s.vuelo), fx = lerp(s.x0, s.x1, f), fz = lerp(s.z0, s.z1, f);
		const desv = Math.max(0, 1 - Math.max(0, e - s.vuelo) / 450);
		ctx.lineCap = "round";
		ctx.strokeStyle = s.mio ? `rgba(255,255,255,${0.55 * desv})` : `rgba(255,120,90,${0.6 * desv})`;
		ctx.lineWidth = 0.35;
		ctx.beginPath(); ctx.moveTo(s.x0, s.z0); ctx.lineTo(fx, fz); ctx.stroke();
		if (f < 1) {
			ctx.fillStyle = s.mio ? "#fff" : "#ffb199";
			ctx.beginPath(); ctx.arc(fx, fz, 0.6, 0, Math.PI * 2); ctx.fill();
		} else if (!s.impactado) {
			s.impactado = true;
			destellos.push({ x: s.x1, z: s.z1, r: s.hit ? 3.2 : 1.8, t: ahora, dur: s.hit ? 420 : 260, hit: s.hit });
		}
	}
	destellos = destellos.filter(d => ahora - d.t < d.dur);
	for (const d of destellos) {
		const f = (ahora - d.t) / d.dur;
		ctx.fillStyle = d.boca ? `rgba(255,236,190,${1 - f})` : d.hit ? `rgba(255,200,120,${0.9 * (1 - f)})` : `rgba(220,220,210,${0.6 * (1 - f)})`;
		ctx.beginPath(); ctx.arc(d.x, d.z, d.r * (0.5 + f), 0, Math.PI * 2); ctx.fill();
	}
	// la mira: dónde quieres apuntar (el ratón) y adónde apunta el cañón ahora (a la misma distancia)
	if (!pb.d && !terminado) {
		const m = miraMundo(), dist = Math.hypot(m.x - px, m.z - pz);
		const ang = rad(lerpAng(pa.tt, pb.tt, k)), cx = px + Math.cos(ang) * dist, cz = pz + Math.sin(ang) * dist;
		ctx.strokeStyle = "rgba(255,255,255,.9)"; ctx.lineWidth = 1.6 / zoom;
		ctx.beginPath(); ctx.moveTo(cx - 2.2, cz); ctx.lineTo(cx + 2.2, cz); ctx.moveTo(cx, cz - 2.2); ctx.lineTo(cx, cz + 2.2); ctx.stroke();
	}
	ctx.restore();
	// textos en pantalla: lo que decide cada IA encima de ella, los números de daño y la mira del ratón
	ctx.textAlign = "center";
	for (const tb of cur.tk) {
		if (tb.id === yo || tb.d || (!tb.vis && !rayos)) continue;
		const ta = tanque(prev, tb.id), [sx, sy] = aPantalla(lerp(ta.x, tb.x, k), lerp(ta.z, tb.z, k));
		letrero(sx, sy - 5.5 * zoom - 8, tb);
	}
	// los enemigos que ves pero quedan fuera de la pantalla: una flecha en el borde, con la distancia y lo que decide
	for (const tb of cur.tk) {
		if (tb.id === yo || tb.d || (!tb.vis && !rayos)) continue;
		const [sx, sy] = aPantalla(tb.x, tb.z);
		if (sx > 0 && sx < W && sy > 0 && sy < H) continue;
		// dentro de la zona libre de paneles: 46 px a los lados, 78 arriba (el aviso SPOTTED) y 120 abajo (el HUD)
		const cy = (78 + H - 120) / 2, dx = sx - W / 2, dy = sy - cy, m = Math.max(Math.abs(dx) / (W / 2 - 46), Math.abs(dy) / ((H - 198) / 2));
		const ex = W / 2 + dx / m, ey = cy + dy / m, ang = Math.atan2(dy, dx);
		ctx.save(); ctx.translate(ex, ey); ctx.rotate(ang);
		ctx.fillStyle = "#e5484d"; ctx.strokeStyle = "rgba(10,10,10,.8)"; ctx.lineWidth = 2;
		ctx.beginPath(); ctx.moveTo(14, 0); ctx.lineTo(-6, -9); ctx.lineTo(-2, 0); ctx.lineTo(-6, 9); ctx.closePath(); ctx.stroke(); ctx.fill();
		ctx.restore();
		const d = Math.round(Math.hypot(tb.x - pb.x, tb.z - pb.z)), ty = ey - Math.sin(ang) * 22;
		ctx.font = "700 9.5px Montserrat, sans-serif";
		const medio = ctx.measureText(tb.lb).width / 2 + 6, tx = Math.max(medio, Math.min(W - medio, ex - Math.cos(ang) * 30));
		ctx.font = "900 11px Montserrat, sans-serif"; ctx.lineWidth = 3; ctx.strokeStyle = "rgba(10,10,10,.85)"; ctx.fillStyle = "#fff";
		ctx.strokeText(`${d} m`, tx, ty); ctx.fillText(`${d} m`, tx, ty);
		ctx.font = "700 9.5px Montserrat, sans-serif"; ctx.fillStyle = "rgba(244,244,242,.85)";
		ctx.strokeText(tb.lb, tx, ty + 12); ctx.fillText(tb.lb, tx, ty + 12);
	}
	for (const id in fantasmas) {
		const f = fantasmas[id], t = tanque(cur, +id);
		if (t.vis || t.d) continue;
		const [sx, sy] = aPantalla(f.x, f.z), s = Math.floor((ahora - f.cuando) / 1000);
		ctx.font = "700 10px Montserrat, sans-serif"; ctx.fillStyle = "rgba(244,244,242,.6)";
		ctx.fillText(f.fogonazo && s < 2 ? "MUZZLE FLASH" : `LAST SEEN ${s}s AGO`, sx, sy - 4.5 * zoom - 6);
	}
	textos = textos.filter(t => ahora - t.t < 1300);
	for (const t of textos) {
		const f = (ahora - t.t) / 1300, [sx, sy] = aPantalla(t.x, t.z);
		ctx.globalAlpha = 1 - f * f;
		ctx.font = "900 14px Montserrat, sans-serif"; ctx.lineWidth = 4; ctx.strokeStyle = "rgba(0,0,0,.75)"; ctx.fillStyle = "#fff";
		const ty = sy - 5.5 * zoom - 40 - 28 * f; // por encima del letrero de la IA
		ctx.strokeText(t.txt, sx, ty); ctx.fillText(t.txt, sx, ty);
		ctx.globalAlpha = 1;
	}
	if ((raton.dentro || visor) && !terminado) {
		const rm = miraMundo(), [rx, ry] = visor ? aPantalla(rm.x, rm.z) : [raton.x, raton.y];
		const recargando = cur.yo.r > 0;
		ctx.strokeStyle = recargando ? "rgba(244,244,242,.45)" : "#fff"; ctx.lineWidth = 1.5;
		ctx.beginPath(); ctx.arc(rx, ry, 9, 0, Math.PI * 2); ctx.stroke();
		if (visor && cur.yo.mira[2]) { ctx.fillStyle = "rgba(255,255,255,.35)"; ctx.beginPath(); ctx.arc(rx, ry, 9, 0, Math.PI * 2); ctx.fill(); }
		if (recargando) {
			const f = 1 - cur.yo.r / Math.max(0.1, cur.yo.rt);
			ctx.strokeStyle = "#fff"; ctx.lineWidth = 2.5;
			ctx.beginPath(); ctx.arc(rx, ry, 13, -Math.PI / 2, -Math.PI / 2 + f * Math.PI * 2); ctx.stroke();
		}
		ctx.fillStyle = "#fff"; ctx.fillRect(rx - 1, ry - 1, 2, 2);
		const d = Math.hypot(rm.x - pb.x, rm.z - pb.z);
		ctx.font = "700 10px Montserrat, sans-serif"; ctx.fillStyle = d > info.rango ? "#e5484d" : "rgba(244,244,242,.8)";
		ctx.fillText(`${Math.round(d)} m`, rx, ry + 26);
	}
	if (!dibujar.mini || ahora - dibujar.mini > 150) { dibujarMinimapa(); dibujar.mini = ahora; }
}

/** Un Tiger visto desde arriba: el casco con sus orugas, la torreta y el cañón. */
function dibujarTanque(x, z, yaw, torreta, tipo) {
	const L = info.largo, A = info.anchoCasco;
	const colores = {
		yo: ["#f4f4f2", "#3a3a3a", "#ffffff", "#0a0a0a"],
		ia: ["#c9443f", "#3b1715", "#e2544d", "#1a0807"],
		resto: ["#3b3b3b", "#222", "#454545", "#111"],
		fantasma: ["rgba(229,72,77,.22)", "rgba(229,72,77,.12)", "rgba(229,72,77,.3)", "rgba(255,255,255,.95)"],
	}[tipo];
	ctx.save();
	ctx.translate(x, z);
	const esc = Math.max(1, 26 / (L * zoom)); // que se vea aunque el zoom sea pequeño
	ctx.scale(esc, esc);
	if (tipo === "ia" || tipo === "yo") { ctx.shadowColor = "rgba(0,0,0,.55)"; ctx.shadowBlur = 6; ctx.shadowOffsetX = 2; ctx.shadowOffsetY = 2; }
	if (tipo === "yo") {
		ctx.beginPath(); ctx.arc(0, 0, 6.2, 0, Math.PI * 2);
		ctx.strokeStyle = "rgba(255,255,255,.85)"; ctx.lineWidth = 2.2 / zoom / esc; ctx.stroke();
	}
	ctx.rotate(rad(yaw));
	const spr = sprites && sprites[tipo];
	if (spr) {
		ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = "high";
		if (tipo === "fantasma") ctx.globalAlpha *= 0.55;
		ctx.drawImage(spr.casco, -SPRITE.casco / 2, -SPRITE.casco / 2, SPRITE.casco, SPRITE.casco);
		ctx.shadowColor = "transparent";
		ctx.translate(SPRITE.pivote, 0);
		ctx.rotate(rad(torreta) - rad(yaw));
		if (tipo === "ia" || tipo === "yo") { ctx.shadowColor = "rgba(0,0,0,.45)"; ctx.shadowBlur = 4; ctx.shadowOffsetX = 1.5; ctx.shadowOffsetY = 1.5; }
		ctx.drawImage(spr.torreta, -SPRITE.torreta / 2, -SPRITE.torreta / 2, SPRITE.torreta, SPRITE.torreta);
		ctx.shadowColor = "transparent";
		if (tipo === "resto") { ctx.fillStyle = "rgba(20,20,20,.5)"; ctx.beginPath(); ctx.arc(0.4, 0.2, 2.6, 0, Math.PI * 2); ctx.fill(); }
		ctx.restore();
		return;
	}
	ctx.lineWidth = 0.22;
	ctx.strokeStyle = colores[3];
	if (tipo === "fantasma") { ctx.setLineDash([0.9, 0.7]); ctx.lineWidth = 0.3; }
	// orugas
	ctx.fillStyle = colores[1];
	ctx.fillRect(-L / 2, -A / 2, L, 0.9); ctx.fillRect(-L / 2, A / 2 - 0.9, L, 0.9);
	ctx.shadowColor = "transparent";
	// casco
	ctx.fillStyle = colores[0];
	ctx.beginPath(); ctx.rect(-L / 2 + 0.1, -A / 2 + 0.55, L - 0.2, A - 1.1); ctx.fill(); ctx.stroke();
	ctx.strokeRect(-L / 2, -A / 2, L, A);
	ctx.rotate(rad(torreta) - rad(yaw));
	// torreta y cañón (el cañón sale de los muñones: 5,2 m hasta la boca)
	ctx.fillStyle = colores[2];
	ctx.beginPath(); ctx.rect(-1.25, -1.15, 2.6, 2.3); ctx.fill(); ctx.stroke();
	ctx.fillRect(1.1, -0.17, 4.1, 0.34); ctx.strokeRect(1.1, -0.17, 4.1, 0.34);
	ctx.setLineDash([]);
	if (tipo === "resto") { ctx.fillStyle = "rgba(20,20,20,.55)"; ctx.beginPath(); ctx.arc(0.5, 0.3, 2.4, 0, Math.PI * 2); ctx.fill(); }
	ctx.restore();
}

/** El letrero de lo que decide una IA, encima de ella: «AI · FLANKING LEFT», y debajo su estado (te apunta, recarga…). */
function letrero(sx, sy, t) {
	ctx.font = "900 11px Montserrat, sans-serif";
	const a = "AI · ", b = t.lb, wa = ctx.measureText(a).width, wb = ctx.measureText(b).width, w = wa + wb + 16;
	sx = Math.max(w / 2 + 4, Math.min(innerWidth - w / 2 - 4, sx)); // que no se salga por los lados
	ctx.fillStyle = "rgba(10,10,10,.8)";
	redondo(sx - w / 2, sy - 15, w, 19, 3); ctx.fill();
	ctx.textAlign = "left";
	ctx.fillStyle = "#8c8c8c"; ctx.fillText(a, sx - w / 2 + 8, sy - 1.5);
	ctx.fillStyle = "#f4f4f2"; ctx.fillText(b, sx - w / 2 + 8 + wa, sy - 1.5);
	// la vida, en una raya bajo el letrero
	ctx.fillStyle = "rgba(255,255,255,.15)"; ctx.fillRect(sx - w / 2, sy + 5, w, 2);
	ctx.fillStyle = "#e5484d"; ctx.fillRect(sx - w / 2, sy + 5, w * t.v, 2);
	if (t.st) {
		ctx.font = "700 9.5px Montserrat, sans-serif";
		ctx.textAlign = "center";
		ctx.fillStyle = t.st === "AIMING AT YOU" ? "#ff6b6f" : "rgba(244,244,242,.75)";
		ctx.fillText(t.st, sx, sy + 18);
	}
	ctx.textAlign = "center";
}

function redondo(x, y, w, h, r) {
	ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
	ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}

function dibujarMinimapa() {
	if (!cur || !mapa) return;
	const s = mini.width / info.ancho;
	mctx.globalAlpha = 1;
	mctx.drawImage(mapa, 0, 0, mini.width, mini.height);
	mctx.fillStyle = "rgba(10,10,10,.35)"; mctx.fillRect(0, 0, mini.width, mini.height);
	const p = tanque(cur, yo);
	mctx.strokeStyle = "rgba(255,255,255,.35)"; mctx.lineWidth = 2;
	mctx.beginPath(); mctx.arc(p.x * s, p.z * s, info.rango * s, 0, Math.PI * 2); mctx.stroke();
	// lo que se ve en la pantalla
	const W = innerWidth / zoom, H = innerHeight / zoom;
	mctx.strokeStyle = "rgba(255,255,255,.6)"; mctx.lineWidth = 1.5;
	mctx.strokeRect((camX - W / 2) * s, (camZ - H / 2) * s, W * s, H * s);
	for (const id in fantasmas) {
		const f = fantasmas[id];
		mctx.strokeStyle = "rgba(229,72,77,.8)"; mctx.lineWidth = 2;
		mctx.beginPath(); mctx.arc(f.x * s, f.z * s, 6, 0, Math.PI * 2); mctx.stroke();
	}
	for (const t of cur.tk) {
		if (t.q || t.id === yo || (!t.vis && !rayos)) continue;
		mctx.fillStyle = t.d ? "#555" : "#e5484d";
		mctx.beginPath(); mctx.arc(t.x * s, t.z * s, 6, 0, Math.PI * 2); mctx.fill();
	}
	mctx.fillStyle = p.d ? "#555" : "#fff";
	mctx.beginPath(); mctx.arc(p.x * s, p.z * s, 7, 0, Math.PI * 2); mctx.fill();
}

function dibujarFondoPortada(W, H) {
	if (!mapa) return;
	const s = Math.max(W, H) / info_ancho() * 1.15;
	ctx.globalAlpha = 0.16;
	ctx.drawImage(mapa, (W - info_ancho() * s) / 2, (H - info_ancho() * s) / 2, info_ancho() * s, info_ancho() * s);
	ctx.globalAlpha = 1;
}
function info_ancho() { return info ? info.ancho : 400; }

// ======================================================================= HUD

function reloj(seg) { seg = Math.max(0, Math.floor(seg)); return `${Math.floor(seg / 60)}:${String(seg % 60).padStart(2, "0")}`; }

function actualizarHud() {
	if (!cur) return;
	const y = cur.yo, t = tanque(cur, yo);
	$("reloj").textContent = reloj(cur.t / 20);
	if (visor) $("visorReloj").textContent = `${reloj(cur.t / 20)} / ${reloj(visor.total / 20)}`;
	$("vidaBarra").style.width = (100 * t.v).toFixed(1) + "%";
	$("vidaNum").textContent = Math.round(t.v * info.vidaMax);
	const r = y.r, rt = Math.max(0.1, y.rt);
	$("recargaBarra").style.width = (100 * (1 - r / rt)).toFixed(1) + "%";
	const rec = $("recargaTxt");
	rec.textContent = !y.ok ? "GUN DESTROYED" : r > 0 ? `RELOADING ${r.toFixed(1)} s` : "READY";
	rec.className = r > 0 || !y.ok ? "" : "listo";
	for (const el of document.querySelectorAll(".mun")) el.classList.toggle("sel", +el.dataset.m === y.m);
	for (let i = 0; i < 3; i++) $("mu" + i).textContent = y.mu[i] + " left";
	const nombresMod = ["ENGINE", "LEFT TRACK", "RIGHT TRACK", "GUN", "TURRET RING", "AMMO RACK"];
	const mal = [];
	for (let i = 0; i < 6; i++) if (y.mod[i] !== "0") mal.push(`<span class="mal">${nombresMod[i]} ${y.mod[i] === "2" ? "OUT" : "DAMAGED"}</span>`);
	if (y.fuego) mal.unshift('<span class="mal">ON FIRE</span>');
	$("estadoTanque").innerHTML = mal.length ? mal.slice(0, 3).join("<br>") : `${Math.abs(Math.round(y.vel))} KM/H · ALL GOOD`;
	const visto = $("visto");
	visto.classList.toggle("oculto", !y.visto || t.d);
	visto.textContent = y.visto === 1 ? "SPOTTED · 1 AI TANK SEES YOU" : `SPOTTED · ${y.visto} AI TANKS SEE YOU`;
	// lo que decide cada IA (solo de las que ves o has visto hace poco: lo demás no lo sabes)
	const ahora = performance.now();
	let h = "";
	for (const e of cur.tk) {
		if (e.id === yo) continue;
		const reciente = e.vis || rayos || (fantasmas[e.id] && ahora - fantasmas[e.id].cuando < 5000);
		const dec = e.d ? "DESTROYED" : reciente ? e.lb : "NO CONTACT";
		const est = e.d || !reciente ? "" : e.st;
		h += `<div class="ia${e.d ? " muerto" : reciente ? "" : " lejos"}"><span class="nom">${nombres[e.id]}</span><span class="dec">${dec}</span>` +
			`<span class="vid"><i style="width:${(100 * e.v).toFixed(0)}%"></i></span><span class="est${est === "AIMING AT YOU" ? " apunta" : ""}">${est || "&nbsp;"}</span></div>`;
	}
	$("radioLista").innerHTML = h;
}

// ======================================================================= Hall of Fame (fase 2: Supabase)

/**
 * El Hall of Fame vive en Supabase (config.js). La página solo puede mandar partidas (pendientes) y leer las verificadas: las
 * verifica el servidor (verificador/verificar_pendientes.mjs), que las vuelve a jugar con el mismo simulador.
 */
const HOF = {
	cfg: window.BTA_CONFIG || {},
	activo() { return !!(this.cfg.supabaseUrl && this.cfg.supabaseAnonKey); },
	async pedir(ruta, opciones = {}) {
		const r = await fetch(`${this.cfg.supabaseUrl}/rest/v1/${ruta}`, {
			...opciones,
			headers: { apikey: this.cfg.supabaseAnonKey, Authorization: `Bearer ${this.cfg.supabaseAnonKey}`, "Content-Type": "application/json", ...(opciones.headers || {}) },
		});
		if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 120)}`);
		return r.status === 200 ? r.json() : null;
	},
	/** Manda una partida. Al salir de la página, con keepalive (que no pasa de 64 KB). */
	enviar(datos, saliendo) {
		const cuerpo = JSON.stringify(datos);
		return this.pedir("partidas", { method: "POST", body: cuerpo, headers: { Prefer: "return=minimal" }, keepalive: saliendo && cuerpo.length < 60000 });
	},
	ranking(modo, resultado, orden, n) {
		return this.pedir(`partidas?select=id,nombre,ticks,build&estado=eq.verificada&modo=eq.${modo}&resultado=eq.${resultado}&order=ticks.${orden},id.asc&limit=${n}`);
	},
	contador() { return this.pedir("rpc/contador", { method: "POST", body: "{}" }); },
	async partida(id) { return (await this.pedir(`partidas?select=id,nombre,modo,semilla,repeticion&id=eq.${id}`))[0]; },
};

function html(t) { return String(t).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }

/** La portada: el contador de cada modo y las mejores partidas verificadas (con ▶ para verlas). */
async function pintarSalon() {
	if (!HOF.activo()) return;
	try {
		const [cuenta, ...listas] = await Promise.all([HOF.contador(), HOF.ranking("1v1", "WIN", "asc", 5), HOF.ranking("1v3", "WIN", "asc", 5),
			HOF.ranking("1v5", "WIN", "asc", 5), HOF.ranking("1v5", "LOSS", "desc", 5)]);
		const c = {};
		for (const f of cuenta) c[f.modo] = f;
		// ▶ solo en las del simulador de esta página (las de otro build no se pueden repetir aquí)
		const version = api ? api.version() : "";
		const fila = (p, i) => `<li><span class="p">${i + 1}</span><span class="q">${html(p.nombre || "Anonymous")}</span><span class="t">${reloj(p.ticks / 20)}</span>` +
			(p.build === version ? `<button data-ver="${p.id}" title="Watch this game">▶</button>` : `<span title="Played with an older version of the simulator"></span>`) + "</li>";
		const lista = (l, vacio) => l.length ? `<ol>${l.map(fila).join("")}</ol>` : `<div class="vacio">${vacio}</div>`;
		let h = "";
		["1v1", "1v3", "1v5"].forEach((modo, i) => {
			const n = c[modo] || { partidas: 0, victorias: 0 };
			$("g" + modo).textContent = `Elite AI beaten ${n.victorias}× in ${n.partidas} ${n.partidas === 1 ? "game" : "games"}`;
			h += `<div class="columna"><h3>${modo.replace("v", " VS ")}</h3><h4>Fastest wins</h4>${lista(listas[i], "Nobody has beaten it yet.")}` +
				(modo === "1v5" ? `<h4>Longest last stands</h4>${lista(listas[3], "No games yet.")}` : "") + "</div>";
		});
		$("salonColumnas").innerHTML = h;
		$("salon").classList.remove("oculto");
		for (const b of $("salonColumnas").querySelectorAll("button[data-ver]")) b.onclick = () => verRepeticion(+b.dataset.ver);
	} catch (e) {
		console.warn("[bta] Hall of Fame sin conexión:", e.message);
	}
}

function nombreGuardado() { try { return localStorage.getItem("bta-nombre") || ""; } catch { return ""; } }

/** Al acabar: la partida (su repetición) lista para mandarla; se manda con «Submit» o al salir de la tarjeta. */
function prepararEnvio() {
	envio = null;
	$("envio").classList.add("oculto");
	if (!HOF.activo() || visor) return;
	const rep = api.repeticion(), c = rep.split(";");
	envio = { enviado: false, datos: { modo: c[1], semilla: Number(c[2]), build: c[0], ticks: Number(c[3]), resultado_declarado: cur.fin, repeticion: rep } };
	$("nombre").value = nombreGuardado();
	$("enviar").disabled = false;
	$("envioEstado").textContent = "Sent when you leave this screen. Our server replays it to check it before it shows up.";
	$("envio").classList.remove("oculto");
}

async function enviarPartida(saliendo) {
	const e0 = envio; // (si empieza otra partida mientras se manda, envio ya es otro)
	if (!e0 || e0.enviado) return;
	e0.enviado = true;
	const nombre = BtaNombres.limpiarNombre($("nombre").value);
	try { localStorage.setItem("bta-nombre", nombre || ""); } catch { }
	$("enviar").disabled = true;
	$("envioEstado").textContent = "Sending…";
	try {
		await HOF.enviar({ ...e0.datos, nombre }, saliendo);
		$("envioEstado").textContent = `Sent${nombre ? ` as “${nombre}”` : " (anonymous)"}. It shows up in the Hall of Fame once our server has replayed it.`;
	} catch (e) {
		e0.enviado = false;
		$("enviar").disabled = false;
		$("envioEstado").textContent = "Couldn't send it (" + e.message + "). Try again.";
	}
}

// ======================================================================= el visor de repeticiones

/** Ver una partida del Hall of Fame: la misma batalla, con las entradas de quien la jugó. */
async function verRepeticion(id) {
	if (!listo || !HOF.activo()) return;
	let p;
	try { p = await HOF.partida(id); } catch (e) { estadoCarga("Couldn't load that game: " + e.message); return; }
	if (!p) { estadoCarga("That game isn't in the Hall of Fame."); return; }
	const r = api.cargarRepeticion(p.repeticion);
	if (r.startsWith("ERROR")) {
		volverAlMenu();
		estadoCarga("That game was played with an older version of the simulator, so this page can't replay it.");
		return;
	}
	Sonido.iniciar();
	visor = { id, quien: p.nombre || "Anonymous", velocidad: 1, total: api.ticksRepeticion() };
	prepararVista(JSON.parse(r), p.modo, p.semilla);
	cuentaHasta = performance.now();
	$("visorQuien").textContent = `${visor.quien} · ${p.modo.replace("v", " VS ")}`.toUpperCase();
	ponerVelocidad(1);
	history.replaceState(null, "", `?watch=${id}`);
}

function ponerVelocidad(v) {
	if (!visor) return;
	visor.velocidad = v;
	for (const b of document.querySelectorAll("#visorBarra .vel button")) b.classList.toggle("sel", +b.dataset.v === v);
}

// ======================================================================= el final

function acabar() {
	terminado = true;
	disparando = false;
	const fin = cur.fin, segundos = (stats.muerte || cur.t) / 20, gano = fin === "WIN";
	if (!visor) guardarRecord(stats.modo, gano, segundos);
	const modoTxt = stats.modo.replace("v", " vs ");
	$("finSup").textContent = `${visor ? "Replay" : "Beat the AI"} · ${modoTxt} · seed ${stats.semilla}`;
	if (visor) {
		const quien = html(visor.quien);
		$("finTitulo").innerHTML = gano ? `${quien} <span>beat it</span>` : fin === "DRAW" ? `Time's <span>up</span>` : `${quien} lasted <span>${reloj(segundos)}</span>`;
		$("finSub").textContent = gano ? `${modoTxt} against the Elite AI, in ${reloj(cur.t / 20)}` : `against the Elite AI · ${modoTxt}`;
	} else if (gano) { $("finTitulo").innerHTML = `You <span>beat it</span>`; $("finSub").textContent = `${modoTxt} against the Elite AI, in ${reloj(cur.t / 20)}`; }
	else if (fin === "DRAW") { $("finTitulo").innerHTML = `Time's <span>up</span>`; $("finSub").textContent = `10 minutes against the Elite AI · ${modoTxt}: nobody won`; }
	else { $("finTitulo").innerHTML = `You lasted <span>${reloj(segundos)}</span>`; $("finSub").textContent = `against the Elite AI · ${modoTxt}`; }
	stats.kills = cur.tk.filter(t => t.id !== yo && t.d).length;
	$("cKills").textContent = `${stats.kills}/${stats.rojos}`;
	$("cDano").textContent = Math.round(stats.dano);
	$("cTiros").textContent = `${cur.yo.aciertos}/${cur.yo.disparos}`;
	$("cTiempo").textContent = reloj(cur.t / 20);
	const sig = { "1v1": "1v3", "1v3": "1v5", "1v5": "1v5" }[stats.modo];
	$("siguiente").textContent = gano && stats.modo !== "1v5" ? `Try ${sig.replace("v", " vs ")}` : stats.modo === "1v1" ? "Try 1 vs 3" : "Try 1 vs 1";
	$("siguiente").dataset.modo = gano ? sig : stats.modo === "1v1" ? "1v3" : "1v1";
	$("otra").textContent = visor ? "Watch again" : "Play again";
	for (const id of ["siguiente", "guardar"]) $(id).classList.toggle("oculto", !!visor);
	prepararEnvio();
	setTimeout(() => {
		$("final").classList.remove("oculto");
		if (visor) $("verificado").innerHTML = "<b>✓ Verified on our server</b> · replayed with the same simulator, tick by tick";
		else verificar();
	}, visor ? 600 : 1400);
}

/** Semilla + entradas = la misma partida: se vuelve a jugar entera, sin ventana, y se compara la huella (lo que hará la fase 2). */
async function verificar() {
	const v = $("verificado");
	v.textContent = "Checking the replay: seed + your inputs, played again from scratch…";
	await espera(60);
	const t0 = performance.now();
	const rep = api.repeticion(), propio = api.resumen(), otra = api.repetir(rep);
	const ms = performance.now() - t0;
	window.ultimaRepeticion = rep;
	const [ticks, , huella] = propio.split(" ");
	v.innerHTML = otra === propio
		? `<b>✓ Replay verified</b> · same battle, tick by tick (${ticks} ticks, fingerprint ${huella}, replayed in ${(ms / 1000).toFixed(1)} s) · replay ${(rep.length / 1024).toFixed(1)} KB`
		: `✗ The replay came out different: ${propio} vs ${otra}`;
	console.log("[bta] repetición", rep.length, "caracteres ·", propio, "·", otra);
}

function tarjetaPng() {
	const c = document.createElement("canvas"); c.width = 1200; c.height = 630;
	const g = c.getContext("2d");
	const fondo = g.createLinearGradient(0, 0, 1200, 630); fondo.addColorStop(0, "#161616"); fondo.addColorStop(1, "#050505");
	g.fillStyle = fondo; g.fillRect(0, 0, 1200, 630);
	g.globalAlpha = 0.24; g.drawImage(mapa, 600, 0, 630, 630); g.globalAlpha = 1;
	const deg = g.createLinearGradient(560, 0, 1000, 0); deg.addColorStop(0, "#0b0b0b"); deg.addColorStop(1, "rgba(11,11,11,0)");
	g.fillStyle = deg; g.fillRect(560, 0, 440, 630);
	g.fillStyle = "#f4f4f2";
	g.font = "900 28px Montserrat"; g.fillText("VIBE", 70, 92);
	const w = g.measureText("VIBE").width; g.strokeStyle = "#f4f4f2"; g.lineWidth = 1.2; g.strokeText("FUSER", 70 + w, 92);
	g.font = "700 22px Montserrat"; g.fillStyle = "#8c8c8c"; g.fillText($("finSup").textContent.toUpperCase(), 70, 170);
	const t = $("finTitulo").textContent.toUpperCase();
	g.font = "900 84px Montserrat"; g.fillStyle = "#f4f4f2";
	const partes = t.split(" "), mitad = Math.ceil(partes.length / 2);
	g.fillText(partes.slice(0, mitad).join(" "), 66, 280); g.fillText(partes.slice(mitad).join(" "), 66, 370);
	g.font = "700 28px Montserrat"; g.fillStyle = "#bdbdba"; g.fillText($("finSub").textContent.toUpperCase(), 70, 430);
	g.font = "700 22px Montserrat"; g.fillStyle = "#8c8c8c";
	g.fillText(`KILLS ${$("cKills").textContent}   ·   DAMAGE ${$("cDano").textContent}   ·   HITS ${$("cTiros").textContent}`, 70, 500);
	g.font = "900 24px Montserrat"; g.fillStyle = "#f4f4f2"; g.fillText("CAN YOU BEAT IT?", 70, 570);
	return c.toDataURL("image/png");
}

// ======================================================================= entrada

addEventListener("keydown", e => {
	if (e.target && e.target.tagName === "INPUT") {
		if (e.key === "Enter" && e.target.id === "nombre") enviarPartida(false);
		return;
	}
	if (visor && jugando) {
		if (e.code === "Digit1" || e.code === "Digit2" || e.code === "Digit3") ponerVelocidad({ Digit1: 1, Digit2: 2, Digit3: 4 }[e.code]);
		if (e.code === "KeyX") rayos = !rayos;
		if (e.code === "Space") { e.preventDefault(); if (!terminado) ponerPausa(!pausado); }
		if (e.code === "Escape") volverAlMenu();
		if (e.code === "KeyM") aviso(Sonido.alternar() ? "SOUND OFF" : "SOUND ON", "gris");
		return;
	}
	if (["KeyW", "KeyA", "KeyS", "KeyD", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Space"].includes(e.code)) e.preventDefault();
	teclas[e.code] = true;
	if (!jugando || terminado) return;
	if (e.code === "Digit1") municion = 0;
	if (e.code === "Digit2") municion = 1;
	if (e.code === "Digit3") municion = 2;
	if (e.code === "Escape" || e.code === "KeyP") ponerPausa(!pausado);
	if (e.code === "KeyM") aviso(Sonido.alternar() ? "SOUND OFF" : "SOUND ON", "gris");
	if (e.code === "Space") disparando = true;
});
addEventListener("keyup", e => { teclas[e.code] = false; if (e.code === "Space") disparando = false; });
addEventListener("blur", () => { for (const k in teclas) teclas[k] = false; disparando = false; if (jugando && !terminado) ponerPausa(true); });
document.addEventListener("visibilitychange", () => { if (document.hidden && jugando && !terminado) ponerPausa(true); });
lienzo.addEventListener("mousemove", e => { raton.x = e.clientX; raton.y = e.clientY; raton.dentro = true; });
lienzo.addEventListener("mouseleave", () => { raton.dentro = false; });
lienzo.addEventListener("mousedown", e => { if (e.button === 0 && jugando && !pausado && !visor) disparando = true; });
addEventListener("mouseup", e => { if (e.button === 0) disparando = false; });
lienzo.addEventListener("contextmenu", e => e.preventDefault());
lienzo.addEventListener("wheel", e => { e.preventDefault(); zoom = Math.max(1.2, Math.min(12, zoom * (e.deltaY > 0 ? 0.88 : 1.14))); }, { passive: false });

function ponerPausa(si) {
	pausado = si;
	disparando = false;
	$("pausa").classList.toggle("oculto", !si);
	if (!si) acumulado = 0;
}

for (const b of document.querySelectorAll(".modo")) b.onclick = () => empezar(b.dataset.modo);
$("seguir").onclick = () => ponerPausa(false);
$("salir").onclick = () => volverAlMenu();
$("otra").onclick = () => { if (visor) return verRepeticion(visor.id); enviarPartida(false); empezar(stats.modo); };
$("siguiente").onclick = () => { enviarPartida(false); empezar($("siguiente").dataset.modo); };
$("menu").onclick = () => volverAlMenu();
$("enviar").onclick = () => enviarPartida(false);
addEventListener("pagehide", () => enviarPartida(true));
for (const b of document.querySelectorAll("#visorBarra .vel button")) b.onclick = () => ponerVelocidad(+b.dataset.v);
$("visorRayos").onclick = () => { rayos = !rayos; $("visorRayos").classList.toggle("sel", rayos); };
$("visorSalir").onclick = () => volverAlMenu();
$("guardar").onclick = () => { const a = document.createElement("a"); a.href = tarjetaPng(); a.download = `beat-the-ai-${stats.modo}-${stats.semilla}.png`; a.click(); };

function volverAlMenu() {
	enviarPartida(false);
	if (visor) rayos = params.has("xray");
	jugando = false; terminado = false; pausado = false; visor = null;
	$("pausa").classList.add("oculto"); $("final").classList.add("oculto"); $("hud").classList.add("oculto");
	$("portada").classList.remove("oculto");
	pintarRecords();
	pintarSalon();
	history.replaceState(null, "", location.pathname);
}
