const express = require('express')
const axios   = require('axios')
const cors    = require('cors')

const app  = express()
const PORT = process.env.PORT || 3001

app.use(cors())
app.use(express.json())

const store = {
  pokemon:       [],
  types:         [],
  initialLoaded: false,
  fullyLoaded:   false,
  loading:       false,
}

const TOTAL_POKEMON   = 1025
const INITIAL_POKEMON = 150
const POKEAPI         = 'https://pokeapi.co/api/v2'
const sleep           = ms => new Promise(r => setTimeout(r, ms))

// ─── Datos básicos — UNA sola llamada por pokémon ─────────────────────────────
function normalizeBasic(raw) {
  return {
    id:             raw.id,
    name:           raw.name,
    image:          raw.sprites.other?.['official-artwork']?.front_default || raw.sprites.front_default || null,
    imageShiny:     raw.sprites.other?.['official-artwork']?.front_shiny   || null,
    imageGif:       raw.sprites.other?.showdown?.front_default             || null,
    types:          raw.types.map(t => t.type.name),
    stats:          raw.stats.map(s => ({ name: s.stat.name, value: s.base_stat })),
    abilities:      raw.abilities.map(a => ({ name: a.ability.name, isHidden: a.is_hidden })),
    height:         raw.height,
    weight:         raw.weight,
    baseExperience: raw.base_experience,
    speciesUrl:     raw.species.url,
    // placeholders hasta que llegue la fase 2
    evolutions:     [],
    generation:     null,
    habitat:        null,
    isLegendary:    false,
    isMythical:     false,
    flavorText:     '',
    category:       '',
    enriched:       false,
  }
}

// ─── Enriquece un pokémon ya en el store con species + evoluciones ────────────
async function enrichPokemon(poke) {
  try {
    const species = await axios.get(poke.speciesUrl, { timeout: 8000 })
    const evoRes  = await axios.get(species.data.evolution_chain.url, { timeout: 8000 })

    const evolutions = []
    let current = evoRes.data.chain
    while (current) {
      evolutions.push({
        name:     current.species.name,
        minLevel: current.evolves_to[0]?.evolution_details[0]?.min_level || null,
        trigger:  current.evolves_to[0]?.evolution_details[0]?.trigger?.name || null,
      })
      current = current.evolves_to[0] || null
    }

    poke.evolutions  = evolutions
    poke.generation  = species.data.generation?.name || null
    poke.habitat     = species.data.habitat?.name    || null
    poke.isLegendary = species.data.is_legendary     || false
    poke.isMythical  = species.data.is_mythical      || false
    poke.flavorText  = species.data.flavor_text_entries
                         ?.find(e => e.language.name === 'es')?.flavor_text?.replace(/\f/g, ' ')
                       || species.data.flavor_text_entries
                         ?.find(e => e.language.name === 'en')?.flavor_text?.replace(/\f/g, ' ')
                       || ''
    poke.category    = species.data.genera?.find(g => g.language.name === 'en')?.genus || ''
    poke.enriched    = true
  } catch { /* deja los placeholders */ }
}

// ─── Carga básica de un batch de IDs ─────────────────────────────────────────
async function loadBasicBatch(ids) {
  const results = await Promise.allSettled(
    ids.map(id => axios.get(`${POKEAPI}/pokemon/${id}`, { timeout: 10000 }))
  )
  for (const r of results) {
    if (r.status === 'fulfilled') {
      try { store.pokemon.push(normalizeBasic(r.value.data)) } catch { }
    }
  }
}

// ─── Carga principal ──────────────────────────────────────────────────────────
async function loadAllPokemon() {
  if (store.loading) return
  store.loading = true

  // ── FASE 1: datos básicos de los primeros 150 — sin species, sin evoluciones
  console.log('[Pokemon] Fase 1: cargando datos básicos...')
  const BATCH1 = 20
  for (let i = 1; i <= INITIAL_POKEMON; i += BATCH1) {
    const ids = Array.from({ length: Math.min(BATCH1, INITIAL_POKEMON - i + 1) }, (_, k) => i + k)
    await loadBasicBatch(ids)
    await sleep(200)
  }

  // tipos (rápido, 1 sola llamada)
  try {
    const res   = await axios.get(`${POKEAPI}/type?limit=20`)
    store.types = res.data.results.map(t => t.name).filter(t => t !== 'unknown' && t !== 'shadow')
  } catch { store.types = [] }

  store.pokemon.sort((a, b) => a.id - b.id)
  store.initialLoaded = true
  console.log(`[Pokemon] ✅ Fase 1 lista — ${store.pokemon.length} pokémon visibles`)

  // ── FASE 2: resto de pokémon (básicos) en background
  console.log('[Pokemon] Fase 2: cargando resto de pokémon...')
  const BATCH2 = 10
  for (let i = INITIAL_POKEMON + 1; i <= TOTAL_POKEMON; i += BATCH2) {
    const ids = Array.from({ length: Math.min(BATCH2, TOTAL_POKEMON - i + 1) }, (_, k) => i + k)
    await loadBasicBatch(ids)
    await sleep(300)
  }
  store.pokemon.sort((a, b) => a.id - b.id)
  console.log(`[Pokemon] ✅ Fase 2 lista — ${store.pokemon.length} pokémon básicos`)

  // ── FASE 3: enriquecer con species + evoluciones de 1 en 1 en background
  console.log('[Pokemon] Fase 3: enriqueciendo con species y evoluciones...')
  for (const poke of store.pokemon) {
    await enrichPokemon(poke)
    await sleep(150)
  }

  store.fullyLoaded = true
  store.loading     = false
  console.log(`[Pokemon] ✅ Completo — ${store.pokemon.length} pokémon enriquecidos`)
}

// ─── Middleware — solo espera fase 1 ─────────────────────────────────────────
async function waitForInitial(req, res, next) {
  if (store.initialLoaded) return next()
  if (!store.loading) loadAllPokemon()
  let attempts = 0
  while (!store.initialLoaded && attempts < 120) { // máx 60s
    await sleep(500)
    attempts++
  }
  if (!store.initialLoaded) return res.status(503).json({ error: 'Arrancando, intenta en unos segundos' })
  next()
}

// ─── Rutas ────────────────────────────────────────────────────────────────────
app.get('/api/universe', waitForInitial, (req, res) => {
  res.json({
    pokemon:     store.pokemon,
    types:       store.types,
    fullyLoaded: store.fullyLoaded,
    total:       store.pokemon.length,
  })
})

app.get('/api/pokemon/:id', waitForInitial, (req, res) => {
  const { id } = req.params
  const poke = isNaN(id)
    ? store.pokemon.find(p => p.name === id.toLowerCase())
    : store.pokemon.find(p => p.id === parseInt(id))
  if (!poke) return res.status(404).json({ error: 'Pokémon no encontrado' })
  res.json(poke)
})

app.get('/api/status', (req, res) => {
  res.json({
    initialLoaded: store.initialLoaded,
    fullyLoaded:   store.fullyLoaded,
    loading:       store.loading,
    loaded:        store.pokemon.length,
    enriched:      store.pokemon.filter(p => p.enriched).length,
    total:         TOTAL_POKEMON,
  })
})

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[Pokemon] Puerto ${PORT}`)
  loadAllPokemon()
})