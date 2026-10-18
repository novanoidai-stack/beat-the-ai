// Beat the AI · moderación a mano del Hall of Fame: quita del ranking una partida (nombre feo, bot evidente…).
// Uso: SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… node verificador/moderar.mjs ID "motivo"        → la marca «rechazada»
//      SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… node verificador/moderar.mjs ID --sin-nombre   → solo le quita el nombre
const [id, que] = process.argv.slice(2);
const URL_BASE = process.env.SUPABASE_URL, CLAVE = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL_BASE || !CLAVE || !/^\d+$/.test(id || "")) {
	console.error('uso: node verificador/moderar.mjs ID "motivo" | --sin-nombre  (con SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY)');
	process.exit(2);
}
const cambios = que === "--sin-nombre" ? { nombre: null } : { estado: "rechazada", motivo: "moderación: " + (que || "sin motivo") };
const r = await fetch(`${URL_BASE}/rest/v1/partidas?id=eq.${id}`, {
	method: "PATCH",
	headers: { apikey: CLAVE, Authorization: `Bearer ${CLAVE}`, "Content-Type": "application/json", Prefer: "return=representation" },
	body: JSON.stringify(cambios),
});
const filas = r.ok ? await r.json() : [];
console.log(r.ok && filas.length ? `#${id}: ${JSON.stringify(cambios)}` : `no se pudo (${r.status}): ${r.ok ? "no existe" : await r.text()}`);
