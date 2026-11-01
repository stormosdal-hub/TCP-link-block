#!/usr/bin/env node
/*
 * Diagnosebufferen i PLS-en, lest fra PLS-ens egne nettsider.
 *
 *     node tcplink_diagbuf.js 10.0.123.52      (skriver ut hele bufferen)
 *
 * Som modul brukes den av tcplink_web.js til kortet "Diagnosebuffer".
 *
 * Web API-et (JSON) krever firmware 4.5 i TIA-prosjektet. Web-serveren har
 * likevel en side for diagnosebufferen, laget for nettleseren. Denne fila
 * ber om de samme sidene som nettleseren og plukker radene ut av HTML-en:
 *
 *   /ClientArea/DiagTable.mwsl?ThrNav=0     oppføring 1-25, nyeste først
 *   /ClientArea/DiagTable.mwsl?ThrNav=1     oppføring 26-50
 *   /ClientArea/DiagLong.mwsl?EventData=…   den lange teksten til én oppføring
 *
 * Hver rad har en fast nøkkel, data-event-data, på 24 heksadesimale tegn:
 * 3 byte hendelses-ID, 8 byte tid (UTC, nanosekunder siden 1970) og 1 byte
 * status (01 kommer, 00 går). En oppføring får aldri en annen nøkkel, så den
 * lange teksten hentes bare én gang, og Pi-en kan ta vare på oppføringer
 * etter at PLS-en har skjøvet dem ut. Bufferen har bare 50 plasser.
 *
 * Krav i TIA: web-serveren slått på, og brukeren "Everybody" med
 * rettigheten "query diagnostics". Teksten er på engelsk, slik PLS-en har
 * den. Bare lesing: GET-forespørsler til web-serveren, ingenting annet.
 *
 * Sidene er laget for mennesker, ikke for programmer. Endrer en ny firmware
 * eller en ny TIA-versjon dem, må parseTable og parseLong tilpasses.
 */

'use strict';

const https = require('https');
const fs = require('fs');

const PAGES = 2;          // 2 sider à 25 oppføringer: hele bufferen i en S7-1200
const TIMEOUT = 8000;     // ms per forespørsel
const KEEP = 500;         // så mange oppføringer tar Pi-en vare på

// ------------------------------------------------------------ HTML til tekst
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (m, e) => {
    if (e[0] !== '#') return ENTITIES[e.toLowerCase()] || m;
    const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
  });
}

// Et stykke HTML som ren tekst: <br> blir linjeskift, andre tagger forsvinner.
// Taggene fjernes før entitetene, så en &lt; i teksten aldri blir en tagg.
function htmlText(s) {
  return decodeEntities(s.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]*>/g, ''));
}

// Nøkkelen fra data-event-data: 3 byte hendelses-ID, 8 byte tid (UTC,
// nanosekunder siden 1970), 1 byte status (01 kommer, 00 går).
function decodeKey(key) {
  const ns = BigInt('0x' + key.slice(6, 22));
  return {
    eventId: key.slice(0, 2) + ':' + key.slice(2, 6),
    ns: ns.toString(), ms: Number(ns / 1000000n),
    incoming: key.slice(22, 24) === '01',
  };
}

// Radene i DiagTable.mwsl: <tr ... data-event-data="…"> med fem celler:
// nummer, tid, dato, status, hendelse. Tid, dato og status leses fra
// nøkkelen, så de ikke avhenger av språket og tidsformatet på siden.
function parseTable(html) {
  const out = [];
  for (const m of html.matchAll(/<tr\b([^>]*\bdata-event-data="[^"]*"[^>]*)>([\s\S]*?)<\/tr>/gi)) {
    const attr = (name) => (new RegExp('\\b' + name + '="([^"]*)"', 'i').exec(m[1]) || [])[1] || '';
    const key = attr('data-event-data').toUpperCase();
    const cells = [...m[2].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)]
      .map((c) => htmlText(c[1]).replace(/\s+/g, ' ').trim());
    if (!/^[0-9A-F]{24}$/.test(key) || cells.length < 5) continue;
    out.push(Object.assign({ key, no: Number(attr('data-event-number')) || Number(cells[0]) || 0, text: cells[4] },
                           decodeKey(key)));
  }
  return out;
}

// Den lange teksten i DiagLong.mwsl, linje for linje slik PLS-en viser den,
// med "Incoming event" / "Outgoing event" til slutt.
function parseLong(html) {
  const m = /<td\b[^>]*class="ContentLongText"[^>]*>([\s\S]*?)<\/td>/i.exec(html);
  if (!m) return null;
  return htmlText(m[1]).split('\n').map((l) => l.replace(/\s+$/, '')).join('\n').trim();
}

// ------------------------------------------------------------------ henting
function get(agent, host, path) {
  return new Promise((resolve, reject) => {
    const req = https.get({
      host, path, agent, timeout: TIMEOUT,
      // PLS-en lager sertifikatet sitt selv, så det kan ikke sjekkes mot en
      // kjent utsteder. Det som hentes, er bare tekst til visning.
      rejectUnauthorized: false,
      headers: { Cookie: 'siemens_automation_language=en' },
    }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        const denied = res.statusCode === 403 || (res.statusCode >= 300 && res.statusCode < 400);
        reject(new Error('HTTP ' + res.statusCode +
                         (denied ? ' (har "Everybody" rettigheten "query diagnostics"?)' : '')));
        return;
      }
      const parts = [];
      res.on('data', (c) => parts.push(c));
      res.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('ingen svar på ' + TIMEOUT / 1000 + ' s')));
    req.on('error', reject);
  });
}

function describe(err) {
  if (err.code === 'ECONNREFUSED') return 'ECONNREFUSED (er web-serveren slått på i PLS-en?)';
  return err.code || err.message;
}

// ----------------------------------------------------------------- bufferen
// Holder alle oppføringer Pi-en har sett, med nummeret de har i PLS-en nå
// (0 = ikke lenger i PLS-en). Med file lagres de, så de overlever en omstart
// av Pi-en. onChange kalles hver gang noe er endret, også underveis.
function createDiagBuffer(opts) {
  const host = opts.host;
  const file = opts.file || null;
  const onChange = opts.onChange || (() => {});
  const entries = new Map();             // nøkkel -> oppføring
  // reason: grunnen til siste forsøk; fetchReason: grunnen til siste som lyktes
  const st = { busy: false, again: null, error: '', reason: '', fetchedAt: 0, fetchReason: '', plcCount: 0 };
  // Én agent så lenge bufferen lever. En ny TLS-forbindelse tar 3-4 s i en
  // S7-1200; agenten husker TLS-økten, så de neste tar et par tidels sekund.
  // Innenfor en henting brukes samme forbindelse om igjen.
  const agent = new https.Agent({ keepAlive: true, maxSockets: 1 });

  // Lukk ledige forbindelser etter hver henting: web-serveren har få av dem,
  // og økten huskes uansett.
  function closeIdle() {
    for (const list of Object.values(agent.freeSockets)) for (const s of list) s.destroy();
  }

  function sorted() {                    // nyeste først
    return [...entries.values()].sort((a, b) => {
      const d = BigInt(b.ns) - BigInt(a.ns);
      return d > 0n ? 1 : d < 0n ? -1 : 0;
    });
  }

  function load() {
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (const e of saved.entries || []) {
        if (!/^[0-9A-F]{24}$/.test(e.key || '')) continue;
        entries.set(e.key, Object.assign({ key: e.key, no: 0, text: e.text || '', long: e.long === undefined ? null : e.long },
                                         decodeKey(e.key)));
      }
      st.fetchedAt = saved.fetchedAt || 0;
      console.log('[diag] ' + entries.size + ' oppføringer lest fra ' + file);
    } catch (err) {
      if (err.code !== 'ENOENT') console.log('[diag] kunne ikke lese ' + file + ': ' + err.message);
    }
  }

  function save() {
    if (!file) return;
    const data = { fetchedAt: st.fetchedAt, entries: sorted().map((e) => ({ key: e.key, text: e.text, long: e.long })) };
    try {
      fs.writeFileSync(file + '.tmp', JSON.stringify(data, null, 1));
      fs.renameSync(file + '.tmp', file);         // en halvskrevet fil erstatter aldri den gamle
    } catch (err) {
      console.log('[diag] kunne ikke skrive ' + file + ': ' + err.message);
    }
  }

  // Én henting om gangen. Ber noen om en ny mens en pågår, kjøres den etterpå.
  async function refresh(reason) {
    if (st.busy) { st.again = reason; return; }
    st.busy = true;
    st.reason = reason;
    onChange();
    try {
      const rows = [];
      for (let p = 0; p < PAGES; p++) {
        rows.push(...parseTable(await get(agent, host, '/ClientArea/DiagTable.mwsl?ThrNav=' + p)));
      }
      if (!rows.length) throw new Error('ingen oppføringer på siden (har "Everybody" rettigheten "query diagnostics"?)');

      for (const e of entries.values()) e.no = 0;
      for (const r of rows) {
        const e = entries.get(r.key);
        if (e) { e.no = r.no; if (!e.text) e.text = r.text; }
        else entries.set(r.key, Object.assign(r, { long: null }));
      }
      for (const e of sorted().slice(KEEP)) entries.delete(e.key);
      st.plcCount = new Set(rows.map((r) => r.key)).size;
      st.fetchedAt = Date.now();
      st.fetchReason = reason;
      st.error = '';
      onChange();                                 // radene først, de lange tekstene etter hvert

      for (const e of sorted()) {
        if (!e.no || e.long !== null) continue;
        e.long = parseLong(await get(agent, host, '/ClientArea/DiagLong.mwsl?EventData=' + e.key)) || '';
        onChange();
      }
    } catch (err) {
      st.error = describe(err);
    } finally {
      closeIdle();
    }
    save();
    st.busy = false;
    onChange();
    if (st.again !== null) {
      const next = st.again;
      st.again = null;
      refresh(next);
    }
  }

  function snapshot() {
    return {
      host, busy: st.busy, error: st.error, reason: st.reason,
      fetchedAt: st.fetchedAt, fetchReason: st.fetchReason, plcCount: st.plcCount, stored: entries.size,
      entries: sorted().map((e) => ({
        key: e.key, no: e.no, eventId: e.eventId, ms: e.ms, incoming: e.incoming, text: e.text, long: e.long,
      })),
    };
  }

  if (file) load();
  return { refresh, snapshot };
}

// ------------------------------------------------------------ kommandolinje
async function main() {
  const host = process.argv[2] || '10.0.123.52';
  const buf = createDiagBuffer({ host });
  await buf.refresh('kommandolinje');
  const s = buf.snapshot();
  if (s.error) {
    console.log('feil: ' + s.error);
    process.exitCode = 1;
  }
  if (!s.entries.length) return;
  console.log('diagnosebufferen på ' + host + ': ' + s.plcCount + ' oppføringer, nyeste først, tid i UTC\n');
  for (const e of s.entries) {
    const when = new Date(e.ms).toISOString().replace('T', ' ').replace('Z', '');
    console.log(String(e.no).padStart(3) + '  ' + when + '  ' + (e.incoming ? 'kommer' : 'går   ') + '  ' +
                e.eventId + '  ' + e.text);
    if (e.long) console.log(e.long.split('\n').map((l) => '       | ' + l).join('\n') + '\n');
  }
}

if (require.main === module) main();

module.exports = { createDiagBuffer, parseTable, parseLong, decodeKey, htmlText };
