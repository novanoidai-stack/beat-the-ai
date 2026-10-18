-- Beat the AI · fase 2: el Hall of Fame sin trampas.
-- Cada partida se guarda como su repetición (semilla + entradas, «BTA1-build;modo;semilla;ticks;entradas»). Llega
-- «pendiente»; el verificador (verificador/verificar_pendientes.mjs, con la clave de servicio) la vuelve a jugar con el
-- MISMO simulador.wasm de su build y la marca «verificada» (con el resultado real) o «rechazada» (con el motivo).
-- El público (la clave anónima de la página) solo puede insertar partidas pendientes, con sus columnas, y leer las verificadas.

create table public.partidas (
	id bigint generated always as identity primary key,
	creada timestamptz not null default now(),
	-- lo que manda la página
	nombre text check (nombre is null or char_length(nombre) between 1 and 16),
	modo text not null check (modo in ('1v1', '1v3', '1v5')),
	semilla bigint not null check (semilla between 0 and 4294967295),
	build text not null check (build ~ '^BTA1-[0-9a-z]{3,16}$'),
	ticks integer not null check (ticks between 1 and 12000),
	resultado_declarado text not null check (resultado_declarado in ('WIN', 'LOSS', 'DRAW')),
	repeticion text not null check (octet_length(repeticion) <= 300000),
	-- lo que pone el verificador
	estado text not null default 'pendiente' check (estado in ('pendiente', 'verificada', 'rechazada')),
	resultado text check (resultado in ('WIN', 'LOSS', 'DRAW')),
	huella text,
	disparos integer,
	aciertos integer,
	motivo text,
	verificada_en timestamptz
);

create index partidas_pendientes on public.partidas (id) where estado = 'pendiente';
-- La misma batalla (mismo build, modo, semilla y huella) solo cuenta una vez: la primera verificada. Las repeticiones del Hall
-- of Fame son públicas; sin esto, cualquiera podría mandar la de otro con su nombre.
create unique index partidas_una_vez on public.partidas (build, modo, semilla, huella) where estado = 'verificada';
create index partidas_ranking on public.partidas (modo, resultado, ticks) where estado = 'verificada';

alter table public.partidas enable row level security;

-- Supabase da todos los permisos a anon y authenticated en las tablas nuevas: se quitan y se dan solo los justos.
revoke all on public.partidas from anon, authenticated;
grant insert (nombre, modo, semilla, build, ticks, resultado_declarado, repeticion) on public.partidas to anon, authenticated;
grant select on public.partidas to anon, authenticated;

create policy "el público inserta partidas pendientes" on public.partidas
	for insert to anon, authenticated with check (estado = 'pendiente' and resultado is null and verificada_en is null);
create policy "el público lee las verificadas" on public.partidas
	for select to anon, authenticated using (estado = 'verificada');

-- «Elite AI: beaten N times in M games», por modo (solo partidas verificadas).
create function public.contador()
returns table (modo text, partidas bigint, victorias bigint)
language sql stable security invoker set search_path = ''
as $$
	select p.modo, count(*), count(*) filter (where p.resultado = 'WIN')
	from public.partidas p
	where p.estado = 'verificada'
	group by p.modo
	order by p.modo;
$$;

revoke all on function public.contador() from public;
grant execute on function public.contador() to anon, authenticated, service_role;
