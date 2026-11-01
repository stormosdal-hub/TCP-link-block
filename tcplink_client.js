#!/usr/bin/env node
/*
 * Minimal TcpLink-klient -- bare det som er innebygd i Node, ingen npm install.
 *
 *     node tcplink_client.js 192.168.0.1 2000
 *
 * Trenger ingen konfigurasjon: størrelsen på hver seksjon leses fra
 * layoutbytene i headeren på meldingene fra PLS-en, navnene fra
 * navnemeldingen PLS-en sender ved tilkobling, og kommandorammene bygges
 * slik PLS-en sier at den forventer dem. Endre størrelse på en UDT eller gi
 * en plass nytt navn i PLS-en, og dette fortsetter å virke.
 *
 * Ved tilkobling skriver den også ut historikken fra PLS-ens retentive
 * minne, eldste hendelse først, og deretter nye hendelser etter hvert.
 *
 * Den samme protokollkoden som tcplink_client.py. Den er også en modul:
 *
 *     const link = require('./tcplink_client');
 *     const { kind, frame, rest } = link.nextFrame(buf);
 *
 * så en større klient kan bruke dekoderen på nytt i stedet for å skrive sin
 * egen. Se TCP_LINK.md for formatet på linjen.
 */

'use strict';

const net = require('net');

const UP_MAGIC = 0xa5, UP_VER = 7, UP_HDR = 32;
const DN_MAGIC = 0x5a, DN_VER = 3, DN_HDR = 14;
const KIND_DATA = 0, KIND_NAMES = 1, KIND_HIST = 2;   // byte 7 i meldingen fra PLS-en
const HIST_REC = 20;       // byte per historikkpost ("TcpLinkHistRec")
const LEN_MAX = 8192;      // TSEND sitt eget tak; alt større er en falsk header
const KEEPALIVE = 500;     // ms, må holde seg godt under rxTimeout i PLS-en

// De tolv layoutplassene, i rekkefølgen på linjen. rx_times er alltid tom foreløpig.
const SECTIONS = ['tx_bits', 'tx_words', 'tx_times', 'tx_ints', 'tx_dints', 'tx_reals',
                  'rx_bits', 'rx_words', 'rx_times', 'rx_ints', 'rx_dints', 'rx_reals'];

// Bare tallplasser har en enhet i navnet, se splitUnit.
const NUMERIC = new Set(['tx_ints', 'tx_dints', 'tx_reals', 'rx_ints', 'rx_dints', 'rx_reals']);

// S7-strenger bruker én byte per tegn; TIA skriver dem som Windows-1252.
const CP1252 = new TextDecoder('windows-1252');


// Layoutbyte, per retning, i samme rekkefølge som innholdet:
//   bit-byte, words, times, ints, dints, reals
function sectionLen(bitBytes, words, times, ints, dints, reals) {
  return bitBytes + 2 * words + 12 * times + 2 * ints + 4 * dints + 4 * reals;
}

// S7 DTL, 12 byte. Returnerer [å, mnd, d, t, min, s, ms]; år 1970 = aldri satt.
function readDTL(m, off) {
  return [m.readUInt16BE(off), m[off + 2], m[off + 3],
          m[off + 5], m[off + 6], m[off + 7],
          Math.floor(m.readUInt32BE(off + 8) / 1e6)];
}

// Byte off+0 bit 0 er element 0, minst signifikante bit først -- en S7 Bool-array.
function readBits(m, off, nBytes) {
  const out = [];
  for (let i = 0; i < nBytes * 8; i++) out.push(((m[off + (i >> 3)] >> (i & 7)) & 1) === 1);
  return out;
}

function readArray(m, off, n, size, read) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(read.call(m, off + i * size));
  return out;
}

function decodeUplink(m) {
  const lay = m.subarray(8, 20);
  const ts = readDTL(m, 20);
  const [bb, nw, nt, ni, nd, nr] = lay;

  let off = UP_HDR;
  const bits = readBits(m, off, bb);                                  off += bb;
  const words = readArray(m, off, nw, 2, Buffer.prototype.readUInt16BE); off += 2 * nw;
  const times = [];
  for (let i = 0; i < nt; i++) times.push(readDTL(m, off + 12 * i));    off += 12 * nt;
  const ints = readArray(m, off, ni, 2, Buffer.prototype.readInt16BE);   off += 2 * ni;
  const dints = readArray(m, off, nd, 4, Buffer.prototype.readInt32BE);  off += 4 * nd;
  const reals = readArray(m, off, nr, 4, Buffer.prototype.readFloatBE);

  return {
    seq: m.readUInt16BE(4), localTime: (m[6] & 1) === 1,
    ts: ts, tsValid: ts[0] >= 2000,                // 1970 = CPU-klokka aldri stilt
    bits, words, times, ints, dints, reals,
    rxLayout: Buffer.from(lay.subarray(6, 12)),
  };
}

// Sjekk en komplett navnemelding og returner strengene, eller null.
//
// Hver S7-streng er [deklarert lengde][nåværende lengde][deklarerte tegn].
// Den deklarerte lengden er et partall (PLS-en avviser odde lengder), så
// strengene følger rett etter hverandre uten fyllbyte, og må slutte
// nøyaktig ved len.
function walkNames(m, length) {
  const out = {};
  let off = UP_HDR;
  for (let s = 0; s < SECTIONS.length; s++) {
    const names = [];
    for (let n = m[8 + s]; n > 0; n--) {
      if (off + 2 > length) return null;
      const max = m[off], cur = m[off + 1];
      if (max % 2 || cur > max || off + 2 + max > length) return null;
      names.push(CP1252.decode(m.subarray(off + 2, off + 2 + cur)));
      off += 2 + max;
    }
    out[SECTIONS[s]] = names;
  }
  return off === length ? out : null;
}

// En historikkmelding (kind 2): hvor langt PLS-en har kommet, og 0..16 poster.
// Hver post er en bit eller et word i txDigital som endret seg:
// section 0 = bits, 1 = words; value er 0/1 for en bit, hele wordet ellers.
function decodeHistory(m) {
  const count = m.readUInt16BE(14);
  const records = [];
  for (let i = 0; i < count; i++) {
    const off = UP_HDR + HIST_REC * i;
    records.push({
      recNo: m.readUInt32BE(off), ts: readDTL(m, off + 4),
      section: m[off + 16], index: m[off + 17], value: m.readUInt16BE(off + 18),
    });
  }
  return {
    seq: m.readUInt16BE(4), localTime: (m[6] & 1) === 1,
    newest: m.readUInt32BE(8), capacity: m.readUInt16BE(12), count: count,
    oldest: m.readUInt32BE(16), clearedTo: m.readUInt32BE(20),
    records,
  };
}

// Korte lister fylles ut med nuller, lange kuttes, til størrelsene i PLS-en.
function encodeDownlink(seq, rxLayout, cmd) {
  const [bb, nw, nt, ni, nd, nr] = rxLayout;
  if (nt) throw new Error('PLS-en ber om times i kommandorammen; det støttes ikke her');
  const c = cmd || {};
  const length = DN_HDR + sectionLen(bb, nw, nt, ni, nd, nr);
  const b = Buffer.alloc(length);
  b[0] = DN_MAGIC; b[1] = DN_VER;
  b.writeUInt16BE(length, 2);
  b.writeUInt16BE(seq & 0xffff, 4);
  Buffer.from(rxLayout).copy(b, 8);

  const fit = (values, n) => {
    const v = (values || []).slice(0, n);
    while (v.length < n) v.push(0);
    return v;
  };

  let off = DN_HDR;
  (c.bits || []).slice(0, bb * 8).forEach((on, i) => {
    if (on) b[off + (i >> 3)] |= 1 << (i & 7);
  });
  off += bb;
  fit(c.words, nw).forEach((v, i) => b.writeUInt16BE(v & 0xffff, off + 2 * i)); off += 2 * nw;
  fit(c.ints, ni).forEach((v, i) => b.writeInt16BE(v, off + 2 * i));           off += 2 * ni;
  fit(c.dints, nd).forEach((v, i) => b.writeInt32BE(v, off + 4 * i));          off += 4 * nd;
  fit(c.reals, nr).forEach((v, i) => b.writeFloatBE(v, off + 4 * i));
  return b;
}

// Returnerer { kind, frame, rest }, med frame null når flere byte trengs.
//
// TCP er en bytestrøm: let etter headeren i stedet for å anta at alt
// ligger på plass. En byte i innholdet kan tilfeldigvis være 0xA5, så en
// header teller bare når alt i den stemmer overens: for data må len passe
// med layouten; for navn må reservebytene være null og strengene slutte
// ved len; for historikk må len passe med antall poster.
function nextFrame(buf) {
  for (;;) {
    const start = buf.indexOf(UP_MAGIC);
    if (start < 0) return { kind: null, frame: null, rest: Buffer.alloc(0) };
    buf = buf.subarray(start);
    if (buf.length < UP_HDR) return { kind: null, frame: null, rest: buf };
    const ver = buf[1], kind = buf[7], length = buf.readUInt16BE(2);

    if (ver === UP_VER && kind === KIND_DATA &&
        length === UP_HDR + sectionLen(...buf.subarray(8, 14))) {
      if (buf.length < length) return { kind: null, frame: null, rest: buf };
      return { kind: KIND_DATA, frame: buf.subarray(0, length), rest: buf.subarray(length) };
    }

    if (ver === UP_VER && kind === KIND_NAMES && length <= LEN_MAX &&
        buf[6] === 0 && buf[16] === 0 && buf.subarray(20, 32).every((x) => x === 0) &&
        length >= UP_HDR + 2 * buf.subarray(8, 20).reduce((a, x) => a + x, 0)) {
      if (buf.length < length) return { kind: null, frame: null, rest: buf };
      if (walkNames(buf, length) !== null) {
        return { kind: KIND_NAMES, frame: buf.subarray(0, length), rest: buf.subarray(length) };
      }
    }

    if (ver === UP_VER && kind === KIND_HIST && (buf[6] & 0xfe) === 0 &&
        length === UP_HDR + HIST_REC * buf.readUInt16BE(14) && length <= LEN_MAX &&
        buf.readUInt32BE(16) >= 1 && buf.subarray(24, 32).every((x) => x === 0)) {
      if (buf.length < length) return { kind: null, frame: null, rest: buf };
      return { kind: KIND_HIST, frame: buf.subarray(0, length), rest: buf.subarray(length) };
    }

    buf = buf.subarray(1);              // falsk header inne i innholdet
  }
}

// 'Moment [Nm]' -> { name: 'Moment', unit: 'Nm' }, bare for tallplasser.
// Bare hakeparenteser, og bare helt til slutt. Bits, words, times og
// kommandoknapper beholder alltid hele strengen som navn.
function splitUnit(section, text) {
  const m = NUMERIC.has(section) && /^(.*\S)\s*\[([^\[\]]+)\]$/.exec(text);
  return m ? { name: m[1], unit: m[2] } : { name: text, unit: '' };
}

// 'ERROR-diode {led}' -> { text: 'ERROR-diode', fmt: 'led' }. Et {format}
// helt til slutt i navnet sier hvordan verdien vises, for alle slags
// plasser. Kjente formater: se formatWord, og {alarm} for bits.
function splitFormat(text) {
  const m = /^(.*\S)\s*\{([A-Za-z0-9_]+)\}$/.exec(text || '');
  return m ? { text: m[1], fmt: m[2] } : { text: text || '', fmt: '' };
}

// PLS-ens navn på en plass, uten {format}, eller indeksen når den ikke har
// noe navn.
function label(names, section, i) {
  const got = (names && names[section]) || [];
  return (i < got.length && got[i]) ? splitFormat(got[i]).text : section.slice(3) + '[' + i + ']';
}

// { name, unit, fmt } for en plass. Bare et navn fra PLS-en deles opp:
// reserveetiketten 'reals[3]' skal ikke leses som enheten '3'.
function nameAndUnit(names, section, i) {
  const got = (names && names[section]) || [];
  if (!(i < got.length && got[i])) return { name: label(names, section, i), unit: '', fmt: '' };
  const f = splitFormat(got[i]);
  const u = splitUnit(section, f.text);
  return { name: u.name, unit: u.unit, fmt: f.fmt };
}

// Svarene fra LED-instruksjonen (TcpLinkDiagLeds) og fault_id fra OB80.
const LED_TEXT = { 0: 'finnes ikke', 1: 'av', 2: 'lyser', 3: 'lyser (farge 2)', 4: 'blinker',
                   5: 'blinker (farge 2)', 6: 'blinker vekselvis', 9: 'ikke tilgjengelig' };
const OB80_TEXT = { 0: 'ingen', 1: 'syklustid overskredet', 2: 'OB kalt mens den fortsatt kjørte' };

function hex4(v) { return '16#' + v.toString(16).toUpperCase().padStart(4, '0'); }

// Et word som tekst, etter formatet i navnet: {dec} som desimaltall, {led}
// og {ob80} som tekst, ellers heksadesimalt. En ukjent kode vises med tallet.
function formatWord(value, fmt) {
  if (fmt === 'dec') return String(value);
  if (fmt === 'led') return LED_TEXT[value] || (value >= 0x8000 ? 'LED-feil ' + hex4(value) : 'kode ' + value);
  if (fmt === 'ob80') return OB80_TEXT[value] || 'tidsfeil ' + hex4(value);
  return hex4(value);
}


// 'historikk #12 2026-10-23 08:15:02.250 Feilkode = 16#0003'
function historyLine(names, rec) {
  const t = rec.ts, p = (n, w) => String(n).padStart(w || 2, '0');
  const when = t[0] + '-' + p(t[1]) + '-' + p(t[2]) + ' ' + p(t[3]) + ':' + p(t[4]) + ':' +
               p(t[5]) + '.' + p(t[6], 3);
  const isBit = rec.section === 0;
  const n = nameAndUnit(names, isBit ? 'tx_bits' : 'tx_words', rec.index);
  const value = isBit ? (rec.value ? 'på' : 'av') : formatWord(rec.value, n.fmt);
  return 'historikk #' + rec.recNo + ' ' + when + ' ' + n.name + ' = ' + value;
}


function main() {
  const host = process.argv[2] || '10.0.123.52';
  const port = Number(process.argv[3] || 2000);

  let buf = Buffer.alloc(0), seq = 0, rxLayout = null, names = {};

  // Det som skal sendes. Indeksene er kontrakten med "TcpLinkRx".
  const cmd = { bits: new Array(16).fill(false), words: [], ints: [], dints: [], reals: [] };

  const sock = net.createConnection({ host, port });

  sock.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      const r = nextFrame(buf);
      buf = r.rest;
      if (!r.frame) break;

      if (r.kind === KIND_NAMES) {
        names = walkNames(r.frame, r.frame.length);
        for (const key of SECTIONS) {
          const named = names[key].map((n, i) => [i, n]).filter((x) => x[1]);
          if (named.length) console.log('navn', key, JSON.stringify(named));
        }
        continue;
      }

      if (r.kind === KIND_HIST) {
        const h = decodeHistory(r.frame);
        for (const rec of h.records) console.log(historyLine(names, rec));
        if (!h.count) {
          console.log('historikk: ' + (h.newest > h.clearedTo ? 'ingen nye poster' : 'tom') +
                      ' (nyeste #' + h.newest + ', ' + h.capacity + ' plasser)');
        }
        continue;
      }

      const s = decodeUplink(r.frame);
      if (!rxLayout || !rxLayout.equals(s.rxLayout)) {
        rxLayout = s.rxLayout;
        console.log('PLS-en forventer kommandolayout', JSON.stringify([...rxLayout]));
      }
      const on = s.bits.map((b, i) => (b ? label(names, 'tx_bits', i) : null)).filter((x) => x);
      const reals = {};
      s.reals.slice(0, 4).forEach((v, i) => {
        const u = nameAndUnit(names, 'tx_reals', i);
        reals[u.name] = Math.round(v * 1000) / 1000 + (u.unit ? ' ' + u.unit : '');
      });
      console.log(s.seq, 'på:', JSON.stringify(on), 'ints:', JSON.stringify(s.ints.slice(0, 4)),
                  'reals:', JSON.stringify(reals));
    }
  });

  // Ingenting går ut før den første datameldingen har fortalt oss layouten.
  const timer = setInterval(() => {
    if (rxLayout) sock.write(encodeDownlink(++seq, rxLayout, cmd));
  }, KEEPALIVE);

  sock.on('error', (err) => console.log('feil:', err.message));
  sock.on('close', () => { console.log('lukket av PLS-en'); clearInterval(timer); });
}

module.exports = {
  UP_MAGIC, UP_VER, UP_HDR, DN_MAGIC, DN_VER, DN_HDR, KIND_DATA, KIND_NAMES, KIND_HIST,
  HIST_REC, SECTIONS,
  sectionLen, readDTL, readBits, decodeUplink, walkNames, decodeHistory, encodeDownlink,
  nextFrame, splitUnit, splitFormat, label, nameAndUnit, formatWord, historyLine,
};

if (require.main === module) main();
