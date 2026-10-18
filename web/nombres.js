// Beat the AI · los nombres del Hall of Fame: cortos, con letras normales y sin insultos. Lo usan la página (antes de mandar la
// partida) y el verificador (que no se fía de la página: lo que no pasa, se queda sin nombre). Es un filtro de mínimos: el top
// también se revisa a mano (verificador/moderar.mjs).
(function (raiz) {
	"use strict";
	// Trozos que no pueden salir en un nombre (en minúsculas, sin acentos, con 0→o, 1→i, 3→e, 4→a, 5→s, 7→t, @→a, $→s).
	// Sin trozos cortos que salen en palabras normales («rape» en «grapes», «coon» en «tycoon», «puta» en «reputation»).
	const PROHIBIDOS = [
		"nigg", "negrat", "faggot", "retard", "tranny", "chink", "kike", "wetback",
		"hitler", "heil", "nazi", "kkk", "jihad",
		"maricon", "marica", "sudaca", "panchit", "subnormal", "mongolo",
		"putas", "putita", "hijoput", "zorra", "follar", "joder", "gilipolla", "cabron",
		"fuck", "fck", "phuck", "shit", "cunt", "bitch", "whore", "slut", "pussy", "penis", "vagina", "porn",
	];
	// Los números de los neonazis, en el texto tal cual (normalizado, «1488» sería «ia» y saltaría con «Maria»).
	const NUMEROS = /14\W*88|(^|[^a-z])(ss|hh)\W*88/i;
	const LEET = { 0: "o", 1: "i", 3: "e", 4: "a", 5: "s", 7: "t", "@": "a", $: "s", "!": "i" };

	function normalizar(s) {
		return s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[013457@$!]/g, c => LEET[c]).replace(/[^a-zñ]/g, "");
	}

	/** El nombre que se puede enseñar (como mucho 16 caracteres: letras, números, espacio, _ . -), o null si no hay o no vale. */
	function limpiarNombre(n) {
		if (typeof n !== "string") return null;
		const limpio = n.replace(/[^\p{L}\p{N} _.\-]/gu, "").replace(/\s+/g, " ").trim().slice(0, 16).trim();
		if (!limpio) return null;
		const norm = normalizar(limpio);
		if (NUMEROS.test(limpio) || PROHIBIDOS.some(p => norm.includes(normalizar(p)))) return null;
		return limpio;
	}

	const api = { limpiarNombre };
	if (typeof module !== "undefined" && module.exports) module.exports = api;
	else raiz.BtaNombres = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
