const express = require('express')
const axios   = require('axios')
const cors    = require('cors')

const app  = express()
const PORT = process.env.PORT || 3001

app.use(cors())
app.use(express.json())

// ─── Cache en memoria ─────────────────────────────────────────────────────────
const store = {
  pokemon: [],
  types:   [],
  loaded:  false,
  loading: false,
}

const TOTAL_POKEMON = 1025
const POKEAPI       = 'https://pokeapi.co/api/v2'
const sleep = ms    => new Promise(r => setTimeout(r, ms))

// ─── Obtiene cadena de evolución y datos de especie ───────────────────────────
async function getSpeciesData(speciesUrl) {
  try {
    const species = await axios.get(speciesUrl, { timeout: 8000 })
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

    return {
      evolutions,
      generation:  species.data.generation?.name || null,
      habitat:     species.data.habitat?.name || null,
      isLegendary: species.data.is_legendary  || false,
      isMythical:  species.data.is_mythical   || false,
      flavorText:  species.data.flavor_text_entries
                     ?.find(e => e.language.name === 'es')?.flavor_text?.replace(/\f/g, ' ')
                   || species.data.flavor_text_entries
                     ?.find(e => e.language.name === 'en')?.flavor_text?.replace(/\f/g, ' ')
                   || '',
      category: species.data.genera?.find(g => g.language.name === 'en')?.genus || '',
    }
  } catch {
    return { evolutions: [], generation: null, habitat: null, isLegendary: false, isMythical: false, flavorText: '', category: '' }
  }
}

// ─── Normaliza un pokémon raw ─────────────────────────────────────────────────
async function normalizePokemon(raw) {
  const speciesData = await getSpeciesData(raw.species.url)
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
    ...speciesData,
  }
}

// ─── Carga todos los pokémon en batches ───────────────────────────────────────
async function loadAllPokemon() {
  if (store.loaded || store.loading) return
  store.loading = true
  console.log(`[Pokemon] Cargando ${TOTAL_POKEMON} pokémon...`)

  const BATCH = 20
  for (let i = 1; i <= TOTAL_POKEMON; i += BATCH) {
    const ids   = Array.from({ length: Math.min(BATCH, TOTAL_POKEMON - i + 1) }, (_, k) => i + k)
    const batch = await Promise.allSettled(
      ids.map(id => axios.get(`${POKEAPI}/pokemon/${id}`, { timeout: 10000 }))
    )
    for (const result of batch) {
      if (result.status === 'fulfilled') {
        try {
          const poke = await normalizePokemon(result.value.data)
          store.pokemon.push(poke)
        } catch { /* skip */ }
      }
    }
    if (i % 200 === 1) console.log(`[Pokemon] ${store.pokemon.length}/${TOTAL_POKEMON} cargados...`)
    await sleep(150)
  }

  try {
    const typesRes = await axios.get(`${POKEAPI}/type?limit=20`)
    store.types = typesRes.data.results.map(t => t.name).filter(t => t !== 'unknown' && t !== 'shadow')
  } catch { store.types = [] }

  store.pokemon.sort((a, b) => a.id - b.id)
  store.loaded  = true
  store.loading = false
  console.log(`[Pokemon] ✅ ${store.pokemon.length} pokémon listos`)
}

async function ensureLoaded(req, res, next) {
  if (store.loaded) return next()
  if (!store.loading) loadAllPokemon()
  let attempts = 0
  while (!store.loaded && attempts < 600) { await sleep(500); attempts++ }
  if (!store.loaded) return res.status(503).json({ error: 'Datos aún cargando, intenta en unos segundos' })
  next()
}

// ─── Rutas ────────────────────────────────────────────────────────────────────

// Endpoint principal — devuelve TODO de una vez (igual que Star Wars)
app.get('/api/universe', ensureLoaded, (req, res) => {
  res.json({
    pokemon: store.pokemon,
    types:   store.types,
  })
})

// Detalle individual (para la página de detalle)
app.get('/api/pokemon/:id', ensureLoaded, (req, res) => {
  const { id } = req.params
  const poke = isNaN(id)
    ? store.pokemon.find(p => p.name === id.toLowerCase())
    : store.pokemon.find(p => p.id === parseInt(id))
  if (!poke) return res.status(404).json({ error: 'Pokémon no encontrado' })
  res.json(poke)
})

// Status
app.get('/api/status', (req, res) => {
  res.json({
    loaded:  store.loaded,
    loading: store.loading,
    pokemon: store.pokemon.length,
    types:   store.types.length,
  })
})

app.listen(PORT, '0.0.0.0', ()  => {
  console.log(`[Pokemon] Servidor en puerto ${PORT}`)
  loadAllPokemon()
})