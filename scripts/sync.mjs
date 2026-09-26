// Sincroniza las bases de Notion con la página.
// Genera libros/libros.json y peliculas/peliculas.json, descarga portadas de libros
// y busca pósters y sinopsis en TMDB. Lo ejecuta GitHub Actions (.github/workflows/sync.yml).

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// IDs de las bases de Notion (no son secretos).
const BASES = {
  libros: "16b8a9a6704680139372e0795fdb6dfe",
  peliculas: "2f38a9a670468021b5cbdecd0f3896c6",
};

// Canales de YouTube para la tarjeta "Lo más reciente" (se muestra el último video de cada uno).
const CANALES = [
  { nombre: "YouTube", id: "UCh5KRE1qmG4194xMykpT2mA" },
  { nombre: "Podcast", id: "UCWrXWoyztCWWViUdJi4n-1g" },
];

// Títulos distintos que son la misma película (para no mostrarla como pendiente si ya la viste).
const ALIAS_PELICULAS = {
  "Train Dreams": "Dreams Trains",
  "retrato de una mujer en llamas": "Portrait of a lady on fire",
};

const NOTION_TOKEN = process.env.NOTION_TOKEN;
const TMDB_TOKEN = process.env.TMDB_TOKEN;
if (!NOTION_TOKEN) { console.error("Falta el secret NOTION_TOKEN"); process.exit(1); }

const HOY = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Mexico_City" }).format(new Date());
const REINTENTAR_DIAS = 7; // días antes de volver a buscar una portada o póster que no se encontró
const FORZAR = process.env.FORZAR === "1"; // botón "forzar" del workflow: reintenta todo lo que faltaba
const UA = "Mozilla/5.0 (compatible; wvxam-sync/1.0; +https://www.wvxam.com)";
const esperar = ms => new Promise(r => setTimeout(r, ms));

/* ---------- Utilidades ---------- */
const limpio = s => (s || "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
const sinAcentos = s => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
const clave = s => sinAcentos(limpio(s).replace(/\s*\(\d+\)\s*$/, "").toLowerCase()).replace(/[^a-z0-9]/g, "");
const slug = s => sinAcentos(s.toLowerCase()).replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
const mayuscula = s => s && /^[a-záéíóúñ]/.test(s) ? s[0].toUpperCase() + s.slice(1) : s;
const estrellas = s => (s.match(/⭐/g) || []).length || undefined;
const siNo = s => ({ si: true, sí: true, no: false })[s.toLowerCase()];
const diasDesde = d => (new Date(HOY) - new Date(d)) / 864e5;

async function leerJSON(file, def) {
  try { return JSON.parse(await fs.readFile(file, "utf8")); } catch { return def; }
}
async function escribirJSON(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(data, null, 1) + "\n");
}
function quitarVacios(o) {
  for (const k of Object.keys(o)) if (o[k] === undefined || o[k] === null || o[k] === "") delete o[k];
  return o;
}

/* ---------- Notion ---------- */
async function notion(ruta, { body, version = "2022-06-28", method = "POST" } = {}) {
  const r = await fetch("https://api.notion.com/v1/" + ruta, {
    method,
    headers: { Authorization: `Bearer ${NOTION_TOKEN}`, "Notion-Version": version, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Notion ${r.status} en ${ruta}: ${j.message || r.statusText}`);
  return j;
}

async function leerBase(id) {
  const paginar = async (ruta, version) => {
    const filas = []; let cursor;
    do {
      const j = await notion(ruta, { body: { page_size: 100, start_cursor: cursor }, version });
      filas.push(...j.results);
      cursor = j.has_more ? j.next_cursor : undefined;
    } while (cursor);
    return filas;
  };
  try {
    return await paginar(`databases/${id}/query`, "2022-06-28");
  } catch (e) {
    console.log("Intentando con la API nueva de Notion:", e.message);
    const V = "2025-09-03";
    const db = await notion(`databases/${id}`, { method: "GET", version: V });
    const ds = db.data_sources?.[0]?.id;
    if (!ds) throw new Error(`No encontré la fuente de datos de la base ${id}. ¿Le diste acceso a la conexión?`);
    return await paginar(`data_sources/${ds}/query`, V);
  }
}

const texto = arr => (arr || []).map(t => t.plain_text).join("");
function prop(props, nombre) {
  const k = clave(nombre);
  const encontrado = Object.keys(props).find(n => clave(n) === k);
  return encontrado ? props[encontrado] : undefined;
}
function val(p) {
  if (!p) return "";
  switch (p.type) {
    case "title": return texto(p.title);
    case "rich_text": return texto(p.rich_text);
    case "select": return p.select?.name || "";
    case "status": return p.status?.name || "";
    case "multi_select": return p.multi_select.map(x => x.name).join(", ");
    case "url": return p.url || "";
    case "number": return p.number == null ? "" : String(p.number);
    case "people": return p.people.map(x => x.name || "").join(", ");
    case "files": { const f = p.files?.[0]; return f ? (f.external?.url || f.file?.url || "") : ""; }
    case "formula": { const f = p.formula; const v = f?.[f.type]; return v == null ? "" : String(v.start ?? v); }
    default: return "";
  }
}
function fechas(p) {
  if (p?.type === "date" && p.date) return { ini: p.date.start?.slice(0, 10), fin: p.date.end?.slice(0, 10) };
  return {};
}

/* ---------- Libros ---------- */
function transformarLibros(paginas) {
  const libros = paginas.map(pg => {
    const P = pg.properties;
    const t = limpio(val(prop(P, "Name"))).replace(/\s*\(\d+\)\s*$/, "").replace(/\.$/, "");
    const u = limpio(val(prop(P, "Donde comprarlo")));
    const s = estrellas(val(prop(P, "Score")));
    const status = val(prop(P, "Status"));
    const { ini, fin } = fechas(prop(P, "Terminado"));
    let e, d0, d1;
    if (status === "En curso") { e = "leyendo"; d0 = ini; }
    else if (status === "Hecho" || s) { e = "leido"; if (fin) { d0 = ini; d1 = fin; } else d1 = ini; }
    else if (status === "Sin empezar") e = "librero";
    else e = "por_conseguir";
    return {
      t, a: limpio(val(prop(P, "Autores"))), u: u || undefined,
      i: (u.match(/\/(97[89]\d{10})\//) || [])[1], s, e, d0, d1,
      r: siNo(val(prop(P, "¿Lo volvería a leer?"))),
      manual: limpio(val(prop(P, "Portada"))) || undefined,
      k: clave(t),
    };
  }).filter(b => b.t);

  const leidos = new Set(libros.filter(b => b.e === "leido").map(b => b.k));
  const vistos = new Map(); const salida = [];
  for (const b of libros) {
    if ((b.e === "librero" || b.e === "por_conseguir") && leidos.has(b.k)) continue;
    const firma = `${b.k}|${b.e}|${b.d1 || ""}`;
    if (vistos.has(firma)) { const o = vistos.get(firma); if (!o.u && b.u) { o.u = b.u; o.i = b.i; } continue; }
    vistos.set(firma, b); salida.push(b);
  }
  for (const b of salida) if (b.e === "leyendo" && leidos.has(b.k)) b.re = true;
  return salida;
}

async function descargar(url, destinoSinExt, referer) {
  try {
    const headers = { "User-Agent": UA, Accept: "image/avif,image/webp,image/*,*/*;q=0.8" };
    if (referer) headers.Referer = referer;
    const r = await fetch(url, { headers, redirect: "follow" });
    const tipo = r.headers.get("content-type") || "";
    if (!r.ok) { console.log(`   · imagen respondió ${r.status}: ${url}`); return null; }
    if (!tipo.startsWith("image/")) { console.log(`   · no es imagen (${tipo}): ${url}`); return null; }
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length < 2500) { console.log(`   · imagen vacía (${buf.length} bytes)`); return null; }
    const ext = tipo.includes("png") ? "png" : tipo.includes("webp") ? "webp" : "jpg";
    await fs.writeFile(`${destinoSinExt}.${ext}`, buf);
    return `${path.basename(destinoSinExt)}.${ext}`;
  } catch (e) { console.log(`   · error al descargar: ${e.message}`); return null; }
}

async function portadaBuscalibre(url, isbn) {
  if (!/buscalibre\./.test(url)) return null;
  try {
    const r = await fetch(url, { headers: { "User-Agent": UA, "Accept-Language": "es-MX,es;q=0.9", Accept: "text/html" } });
    if (!r.ok) { console.log(`   · Buscalibre respondió ${r.status}`); return null; }
    const html = await r.text();
    const candidatos = [
      /<meta[^>]+(?:property|name)=["']og:image(?::secure_url)?["'][^>]*content=["']([^"']+)["']/i,
      /<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["']og:image["']/i,
      /<meta[^>]+name=["']twitter:image["'][^>]*content=["']([^"']+)["']/i,
      /"image"\s*:\s*"([^"]+)"/i,
    ].map(re => html.match(re)?.[1]).filter(Boolean);
    // Respaldo: cualquier imagen del CDN de Buscalibre que contenga el ISBN
    const cdn = [...html.matchAll(/https?:\/\/images\.cdn\d*\.buscalibre\.com\/[^"'\s)]+/g)].map(m => m[0]);
    if (isbn) candidatos.push(...cdn.filter(u => u.includes(isbn)));
    const img = candidatos.map(u => u.replace(/&amp;/g, "&").replace(/^\/\//, "https://")).find(u => !/logo|placeholder|no[-_]?image/i.test(u));
    if (!img) console.log(`   · Buscalibre sin imagen en la página (${html.length} caracteres)`);
    return img || null;
  } catch (e) { console.log(`   · error con Buscalibre: ${e.message}`); return null; }
}

const GB_KEY = process.env.GOOGLE_BOOKS_KEY;
async function portadaGoogle(b) {
  const consultas = [];
  if (b.i) consultas.push(`isbn:${b.i}`);
  consultas.push(`intitle:${b.t}${b.a ? ` inauthor:${b.a.split(/,| y | and /)[0]}` : ""}`);
  for (const q of consultas) {
    try {
      const r = await fetch(`https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(q)}&maxResults=5${GB_KEY ? `&key=${GB_KEY}` : ""}`);
      if (!r.ok) { console.log(`   · Google Books respondió ${r.status}`); await esperar(1500); continue; }
      const j = await r.json();
      const link = j.items?.map(x => x.volumeInfo?.imageLinks?.thumbnail).find(Boolean);
      if (link) return link.replace("http://", "https://").replace("&edge=curl", "");
    } catch (e) { console.log(`   · error con Google Books: ${e.message}`); }
  }
  return null;
}

async function portadaOpenLibraryBusqueda(b) {
  try {
    const autor = b.a ? `&author=${encodeURIComponent(b.a.split(/,| y | and /)[0])}` : "";
    const j = await (await fetch(`https://openlibrary.org/search.json?title=${encodeURIComponent(b.t)}${autor}&limit=5&fields=cover_i`, { headers: { "User-Agent": UA } })).json();
    const id = j.docs?.find(d => d.cover_i)?.cover_i;
    return id ? `https://covers.openlibrary.org/b/id/${id}-L.jpg` : null;
  } catch { return null; }
}

async function portadas(libros) {
  const dir = path.join(ROOT, "libros", "portadas");
  await fs.mkdir(dir, { recursive: true });
  const cacheFile = path.join(ROOT, "libros", "portadas.json");
  const cache = await leerJSON(cacheFile, {});
  const existentes = new Set(await fs.readdir(dir));

  const huella = u => createHash("md5").update(u).digest("hex").slice(0, 8);
  for (const b of libros) {
    if (b.e !== "leido" && b.e !== "leyendo") continue;
    const id = b.i || slug(`${b.t} ${b.a}`);
    const c = cache[id];
    const archivoOk = c?.f && existentes.has(c.f);
    const vigenteManual = b.manual && c?.src === "manual" && c.url === b.manual && (c.ext || archivoOk);
    const vigenteAuto = !b.manual && c?.src && c.src !== "manual" && archivoOk;
    if (vigenteManual || vigenteAuto) { b.c = c.ext || `/libros/portadas/${c.f}`; continue; }
    if (c?.miss && !b.manual && !FORZAR && diasDesde(c.miss) < REINTENTAR_DIAS) continue;
    console.log(`Buscando portada: ${b.t}`);

    // Buscalibre bloquea (403) las consultas desde los servidores de GitHub,
    // así que ya no se consulta su página automáticamente.
    const fuentes = [
      ["manual", async () => b.manual],
      ["google", async () => portadaGoogle(b)],
      ["openlibrary", async () => b.i && `https://covers.openlibrary.org/b/isbn/${b.i}-L.jpg?default=false`],
      ["openlibrary-busqueda", async () => portadaOpenLibraryBusqueda(b)],
    ];
    let hecho = false;
    for (const [src, obtener] of fuentes) {
      const url = await obtener();
      if (!url) continue;
      const f = await descargar(url, path.join(dir, `${id}-${huella(url)}`));
      await esperar(400);
      if (f) {
        if (c?.f && c.f !== f) await fs.rm(path.join(dir, c.f), { force: true });
        cache[id] = { f, src, ...(src === "manual" ? { url } : {}) };
        b.c = `/libros/portadas/${f}`;
        console.log(`Portada (${src}): ${b.t}`);
        hecho = true; break;
      }
      if (src === "manual") {
        // No se pudo descargar (el sitio bloquea a GitHub): la página la cargará directo desde el enlace.
        if (c?.f) await fs.rm(path.join(dir, c.f), { force: true });
        cache[id] = { src, url, ext: url };
        b.c = url;
        console.log(`Portada (manual, enlazada): ${b.t}`);
        hecho = true; break;
      }
    }
    if (!hecho) { cache[id] = { miss: HOY }; console.log(`Sin portada: ${b.t}`); }
  }
  await escribirJSON(cacheFile, cache);
  const faltan = libros.filter(b => (b.e === "leido" || b.e === "leyendo") && !b.c).map(b => b.t);
  console.log(`\nRESUMEN PORTADAS: ${libros.filter(b => b.c).length} con portada, ${faltan.length} sin portada`);
  if (faltan.length) console.log("Sin portada: " + faltan.join(" | "));
}

/* ---------- Películas ---------- */
function transformarPeliculas(paginas) {
  const alias = Object.fromEntries(Object.entries(ALIAS_PELICULAS).map(([a, b]) => [clave(a), clave(b)]));
  const pelis = paginas.map(pg => {
    const P = pg.properties;
    const t = mayuscula(limpio(val(prop(P, "Name"))));
    const status = val(prop(P, "Status"));
    const s = estrellas(val(prop(P, "Select")) || val(prop(P, "Score")));
    const vista = ["done", "hecho", "vista"].includes(status.toLowerCase()) || Boolean(s);
    const { ini, fin } = fechas(prop(P, "Fecha"));
    const k = clave(t);
    return {
      t, a: limpio(val(prop(P, "Director"))) || undefined, s, e: vista ? "vista" : "por_ver",
      d1: fin || ini, r: siNo(val(prop(P, "¿La volvería a ver?"))), k: alias[k] || k,
      manual: idManualTMDB(limpio(val(prop(P, "TMDB")))),
    };
  }).filter(p => p.t);
  const vistas = new Set(pelis.filter(p => p.e === "vista").map(p => p.k));
  const ya = new Set(); const salida = [];
  for (const p of pelis) {
    if (p.e === "por_ver" && vistas.has(p.k)) continue;
    const firma = `${p.k}|${p.e}`;
    if (ya.has(firma)) continue;
    ya.add(firma); salida.push(p);
  }
  return salida;
}

async function tmdb(ruta) {
  const r = await fetch("https://api.themoviedb.org/3/" + ruta, { headers: { Authorization: `Bearer ${TMDB_TOKEN}`, accept: "application/json" } });
  if (!r.ok) throw new Error(`TMDB ${r.status}`);
  return r.json();
}

function idManualTMDB(v) {
  if (!v) return undefined;
  const m = v.match(/(movie|tv)\/(\d+)/);
  if (m) return { tipo: m[1], id: Number(m[2]) };
  if (/^\d+$/.test(v)) return { tipo: "movie", id: Number(v) };
  return undefined;
}

const VERSION_TMDB = 2; // subir este número obliga a volver a buscar todas las películas
const nombreClave = s => sinAcentos((s || "").toLowerCase()).replace(/[^a-z]/g, "");

async function buscarTMDB(p) {
  const año = (p.t.match(/\b(19|20)\d{2}\b/) || [])[0];
  const esSerie = /\bserie\b/i.test(p.t);
  const q = p.t.split("/")[0].replace(/\b(19|20)\d{2}\b/g, "")
    .replace(/\b(serie|documental|anime|hbo|acci[oó]n)\b/gi, "").replace(/\s+o\s*$/i, "").trim();
  const tipo = esSerie ? "tv" : "movie";
  const filtroAño = año ? (tipo === "movie" ? `&primary_release_year=${año}` : `&first_air_date_year=${año}`) : "";
  let res = (await tmdb(`search/${tipo}?query=${encodeURIComponent(q)}&language=es-MX&include_adult=false${filtroAño}`)).results || [];
  if (!res.length && año) res = (await tmdb(`search/${tipo}?query=${encodeURIComponent(q)}&language=es-MX&include_adult=false`)).results || [];
  if (!res.length) return null;
  const candidatos = res.slice(0, 6);

  // Si hay director en Notion, elegir el resultado cuyo director coincida
  const directores = (p.a || "").split(/,| y | and |&/).map(nombreClave).filter(d => d.length > 3);
  if (directores.length && tipo === "movie") {
    for (const c of candidatos) {
      try {
        const cr = await tmdb(`movie/${c.id}/credits`);
        const dirs = (cr.crew || []).filter(x => x.job === "Director").map(x => nombreClave(x.name));
        if (dirs.some(d => directores.some(x => d.includes(x) || x.includes(d)))) return { ...c, tipo };
      } catch {}
    }
  }
  // Si no, el más conocido (más votos) entre los primeros resultados
  return { ...candidatos.sort((a, b) => (b.vote_count || 0) - (a.vote_count || 0))[0], tipo };
}

async function datosTMDB(pelis) {
  if (!TMDB_TOKEN) { console.log("Sin TMDB_TOKEN: se omiten pósters."); return; }
  const cacheFile = path.join(ROOT, "peliculas", "tmdb.json");
  const cache = await leerJSON(cacheFile, {});
  for (const p of pelis) {
    if (p.e !== "vista") continue;
    const c = cache[p.k];
    const cacheValido = c && c.v === VERSION_TMDB && (!p.manual || c.id === p.manual.id);
    if (cacheValido && !c.miss) { Object.assign(p, { p: c.p, sin: c.sin }); continue; }
    if (cacheValido && c.miss && !FORZAR && diasDesde(c.miss) < REINTENTAR_DIAS) continue;
    try {
      const m = p.manual ? { id: p.manual.id, tipo: p.manual.tipo } : await buscarTMDB(p);
      if (!m) { cache[p.k] = { v: VERSION_TMDB, miss: HOY }; console.log(`Sin resultado TMDB: ${p.t}`); continue; }
      const det = await tmdb(`${m.tipo}/${m.id}?language=es-MX`);
      let sin = det.overview;
      if (!sin) sin = (await tmdb(`${m.tipo}/${m.id}?language=en-US`)).overview;
      cache[p.k] = quitarVacios({ v: VERSION_TMDB, id: m.id, tipo: m.tipo, p: det.poster_path, sin });
      Object.assign(p, { p: det.poster_path || undefined, sin: sin || undefined });
      console.log(`TMDB${p.manual ? " (manual)" : ""}: ${p.t} → ${det.title || det.name} (${(det.release_date || det.first_air_date || "").slice(0, 4)})`);
      await esperar(250);
    } catch (e) { console.log(`Error TMDB con ${p.t}: ${e.message}`); }
  }
  await escribirJSON(cacheFile, cache);
  const faltan = pelis.filter(p => p.e === "vista" && !p.p).map(p => p.t);
  console.log(`\nRESUMEN PÓSTERS: ${faltan.length} sin póster${faltan.length ? ": " + faltan.join(" | ") : ""}`);
}

/* ---------- YouTube: último video de cada canal ---------- */
const entidades = t => (t || "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
async function ultimosVideos() {
  const salida = [];
  for (const c of CANALES) {
    try {
      const r = await fetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${c.id}`, { headers: { "User-Agent": UA } });
      if (!r.ok) { console.log(`YouTube (${c.nombre}) respondió ${r.status}`); continue; }
      const xml = await r.text();
      const videos = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map(m => {
        const e = m[1]; const g = re => (e.match(re) || [])[1];
        return { id: g(/<yt:videoId>([^<]+)</), titulo: entidades(g(/<title>([^<]*)</)), url: g(/<link rel="alternate" href="([^"]+)"/), fecha: (g(/<published>([^<]+)</) || "").slice(0, 10) };
      }).filter(v => v.id);
      // Se prefieren videos largos sobre Shorts
      const v = videos.find(x => x.url && !x.url.includes("/shorts/")) || videos[0];
      if (v) { salida.push({ canal: c.nombre, ...v }); console.log(`YouTube (${c.nombre}): ${v.titulo}`); }
    } catch (e) { console.log(`Error con YouTube (${c.nombre}): ${e.message}`); }
  }
  return salida;
}

/* ---------- Guardar solo si cambió ---------- */
async function guardar(archivo, items) {
  const file = path.join(ROOT, archivo);
  const anterior = await leerJSON(file, null);
  if (anterior && JSON.stringify(anterior.items) === JSON.stringify(items)) { console.log(`${archivo}: sin cambios`); return; }
  await escribirJSON(file, { actualizado: HOY, items });
  console.log(`${archivo}: actualizado (${items.length} registros)`);
}

/* ---------- Principal ---------- */
const videos = await ultimosVideos();
if (videos.length) await guardar("recientes.json", videos);

const libros = transformarLibros(await leerBase(BASES.libros));
await portadas(libros);
await guardar("libros/libros.json", libros.map(({ k, manual, ...b }) => quitarVacios(b)));

const pelis = transformarPeliculas(await leerBase(BASES.peliculas));
await datosTMDB(pelis);
await guardar("peliculas/peliculas.json", pelis.map(({ k, manual, ...p }) => quitarVacios(p)));
