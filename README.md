# Beat the AI

Drive one Tiger against the AI from [VibeFuser](https://www.youtube.com/@vibefuser)'s Minecraft mod, right in your browser.

The AI is not a copy: it is the same Java code that fights in the mod (perception, tactics, ballistics, armour), compiled to
WebAssembly GC with [TeaVM](https://teavm.org). It only sees what its tank sees, hears your shots and knows your gun is empty
for 6.4 seconds.

## The Hall of Fame can't be faked
A game is its seed plus your inputs, tick by tick. The simulator is deterministic: the same seed and inputs give the exact same
battle in any browser, in Java and in Node. Every submitted game is played again on a server with the same `simulador.wasm` it was
played with (`verificador/verificar_pendientes.mjs`, every 30 minutes from a GitHub Action), and only then shows up. A claimed win
that the replay doesn't produce, a copy of someone else's game or a cut replay is rejected.

- `web/`: the game (static files).
- `verificador/`: the verifier and one `simulador.wasm` per simulator build.
- `supabase/migrations/`: the database. Anyone can submit a pending game and read verified ones; nothing else.

## Credits and licences
- Tiger I 3D model (top-down sprites): "German Armoured Division WWII Tiger Tank" by
  [drcrazzie](https://sketchfab.com/3d-models/german-armoured-division-wwii-tiger-tank-a982b6e03db143a8aa299f59e30b0d1a),
  [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/), modified.
- Montserrat: SIL Open Font License (`licencias/montserrat_OFL.txt`).
- `FdLibm` from OpenJDK (for `Math` exactly like the JVM), GPLv2 with the Classpath Exception, compiled into `simulador.wasm`.
  Its source is in `licencias/FdLibm.java`.
- TeaVM runtime (`wasm-gc-runtime.js`) and the patched TeaVM classes: Apache License 2.0.
- Everything else © VibeFuser.
