#!/usr/bin/env node
/*
 * TcpLink nettvisning -- dataene fra PLS-en i en nettleser, under PLS-ens navn.
 *
 *     node tcplink_web.js 10.0.123.24 2000          (nettside på port 8090)
 *     node tcplink_web.js 10.0.123.24 2000 8095     (eller velg porten selv)
 *
 * og åpne så http://<denne maskinen>:8090 fra hva som helst på nettverket.
 *
 *     PLS  <--TCP-->  tcplink_web.js  <--HTTP + Server-Sent Events-->  nettleser
 *
 * Bare det som er innebygd i Node, ingen npm install. tcplink_client.js og
 * tcplink_web.html må ligge ved siden av denne filen: protokollkoden er den
 * i tcplink_client.js, så dekodingen og [enhet]-regelen er den samme
 * overalt.
 *
 * HISTORIKK. Ved hver tilkobling sender PLS-en hele historikken fra det
 * retentive minnet, og deretter nye hendelser etter hvert. Serveren holder
 * en kopi i minnet og viser den på siden. PLS-en er fasiten: serveren
 * beholder bare poster PLS-en fortsatt har, så etter en omstart av Pi-en er
 * alt tilbake så snart linken er oppe.
 *
 * DIAGNOSEBUFFER. Serveren henter diagnosebufferen fra PLS-ens web-server
 * (tcplink_diagbuf.js) ved oppstart, når linken kommer opp eller faller,
 * når et signal med {led}, {ob80} eller {alarm} i navnet endrer seg, og
 * når noen trykker Oppdater på siden. Oppføringene lagres i
 * diagbuffer.json ved siden av denne filen, så de overlever en omstart.
 *
 *     DIAG_HOST=10.0.123.52   web-serveren å hente fra (standard: PLS-en over)
 *     DIAG_HOST=av            ingen diagnosebuffer
 *     DIAG_FILE=/sti/fil.json et annet sted å lagre den
 *
 * KUN LESING. Den viser det PLS-en sender og lister kommandoene PLS-en tar
 * imot, og den holder linken i live med kommandorammer som bare inneholder
 * nuller. Den setter aldri en kommando. PLS-en tar imot én klient per
 * TcpLink-instans, så stopp andre klienter på samme port først.
 */

'use strict';

const net = require('net');
const http = require('http');
const fs = require('fs');
const path = require('path');
const link = require('./tcplink_client');
const diagbuf = require('./tcplink_diagbuf');

const PLC_HOST = process.argv[2] || '10.0.123.52';
const PLC_PORT = Number(process.argv[3] || 2000);
const HTTP_PORT = Number(process.argv[4] || 8090);   // 8080 brukes av kjøreverk-broen
const PAGE = path.join(__dirname, 'tcplink_web.html');
const DIAG_HOST = process.env.DIAG_HOST || PLC_HOST;
const DIAG_FILE = process.env.DIAG_FILE || path.join(__dirname, 'diagbuffer.json');

const KEEPALIVE = 500;      // ms mellom kommandorammer, godt under rxTimeout
const RECONNECT = 3000;     // ms før neste forsøk etter at linken har falt ut
const STALE_AFTER = 3000;   // ms uten melding før siden sier fra

// ================================================================ linken
const plc = {
  sock: null, buf: Buffer.alloc(0),
  state: 'connecting', why: '',      // connecting | up | stale | down
  rxLayout: null, seqOut: 0,
  lastSeq: null, gaps: 0, recent: [], lastAt: 0,
  names: {},                          // siste navnemelding, beholdes over nye tilkoblinger
  data: null,                         // siste datamelding, dekodet
  labelsKey: '',
  // Historikken slik PLS-en har den: løpenummer -> post. Beholdes over nye
  // tilkoblinger; hver historikkmelding sier hvilke poster PLS-en fortsatt har.
  hist: { records: new Map(), known: false, newest: 0, oldest: 1, capacity: 0,
          clearedTo: 0, localTime: false, timer: null },
};

function connect() {
  const sock = net.createConnection({ host: PLC_HOST, port: PLC_PORT });
  plc.sock = sock;
  plc.buf = Buffer.alloc(0);
  plc.rxLayout = null;                // ingenting går ut før PLS-en sier hva den vil ha
  plc.lastSeq = null;
  setState('connecting', '');
  sock.setNoDelay(true);

  sock.on('connect', () => {
    plc.lastAt = Date.now();
    setState('up', '');
    console.log('[pls] tilkoblet ' + PLC_HOST + ':' + PLC_PORT);
    diagSoon('linken kom opp', 1000);
  });
  sock.on('data', onData);

  let dropped = false;
  const drop = (why) => {
    if (dropped) return;
    dropped = true;
    if (plc.sock === sock) plc.sock = null;
    sock.destroy();
    console.log('[pls] linken er nede: ' + why + ', prøver igjen om ' + RECONNECT / 1000 + ' s');
    // Faller en link som var oppe, kan CPU-en ha gått i STOP: diagnosebufferen
    // sier hvorfor. Mislykkede forsøk på å koble til igjen henter ingenting.
    if (plc.state === 'up' || plc.state === 'stale') diagSoon('linken falt', 2000);
    setState('down', why);
    setTimeout(connect, RECONNECT);
  };
  sock.on('error', (err) => drop(err.code || err.message));
  sock.on('close', () => drop('lukket av PLS-en'));
}

function onData(chunk) {
  plc.buf = Buffer.concat([plc.buf, chunk]);
  for (;;) {
    const r = link.nextFrame(plc.buf);
    plc.buf = r.rest;
    if (!r.frame) return;

    plc.lastAt = Date.now();
    if (plc.state !== 'up') setState('up', '');

    // Alle meldingstyper deler sekvensnummeret, så hull sjekkes på alle.
    const seq = r.frame.readUInt16BE(4);
    if (plc.lastSeq !== null && seq !== ((plc.lastSeq + 1) & 0xffff)) plc.gaps++;
    plc.lastSeq = seq;

    if (r.kind === link.KIND_NAMES) {
      plc.names = link.walkNames(r.frame, r.frame.length);
      console.log('[pls] navn mottatt');
      pushLabels();
      continue;
    }

    if (r.kind === link.KIND_HIST) {
      onHistory(link.decodeHistory(r.frame));
      continue;
    }

    const d = link.decodeUplink(r.frame);
    plc.recent.push(plc.lastAt);

    const changed = plc.data && diagSignalChanged(plc.data, d);
    if (changed) diagSoon('endring i «' + changed + '»', 1500);

    plc.rxLayout = d.rxLayout;
    plc.data = {
      seq: d.seq, ts: d.ts, tsValid: d.tsValid, localTime: d.localTime,
      bits: d.bits, words: d.words, times: d.times,
      ints: d.ints, dints: d.dints, reals: d.reals,
      // words som tekst etter {format} i navnet, så siden ikke trenger
      // sin egen kopi av tabellene i tcplink_client.js
      wordsText: d.words.map((v, i) => link.formatWord(v, link.nameAndUnit(plc.names, 'tx_words', i).fmt)),
    };
    pushLabels();                     // går bare ut når størrelsene har endret seg
    broadcast('data', plc.data);
  }
}

// En historikkmelding: legg til de nye postene, og glem alt PLS-en ikke
// lenger har -- overskrevet (eldre enn oldest), slettet (til og med
// clearedTo), eller fra før DB-en ble reinitialisert (nyere enn newest).
function onHistory(h) {
  const hs = plc.hist;
  for (const rec of h.records) hs.records.set(rec.recNo, rec);
  for (const n of hs.records.keys()) {
    if (n < h.oldest || n > h.newest || n <= h.clearedTo) hs.records.delete(n);
  }
  if (!hs.known || h.records.length) {
    console.log('[pls] historikk: ' + hs.records.size + ' poster, nyeste #' + h.newest);
  }
  Object.assign(hs, { known: true, newest: h.newest, oldest: h.oldest, capacity: h.capacity,
                      clearedTo: h.clearedTo, localTime: h.localTime });
  // Ved tilkobling kommer bufferen i mange små meldinger etter hverandre;
  // nettleserne får ett samlet bilde i stedet for ett per melding.
  if (!hs.timer) {
    hs.timer = setTimeout(() => { hs.timer = null; broadcast('history', history()); }, 250);
  }
}

function history() {
  const hs = plc.hist;
  const lost = hs.newest > hs.clearedTo + hs.capacity ? hs.newest - hs.clearedTo - hs.capacity : 0;
  return {
    known: hs.known, newest: hs.newest, oldest: hs.oldest, capacity: hs.capacity,
    clearedTo: hs.clearedTo, lost, localTime: hs.localTime,
    records: [...hs.records.values()]
      .sort((a, b) => b.recNo - a.recNo)                                   // nyeste først
      .map((r) => (r.section === 1
        ? Object.assign({}, r, { valueText: link.formatWord(r.value, link.nameAndUnit(plc.names, 'tx_words', r.index).fmt) })
        : r)),
  };
}

// ======================================================== diagnosebufferen
const diag = DIAG_HOST === 'av' ? null : diagbuf.createDiagBuffer({
  host: DIAG_HOST, file: DIAG_FILE,
  // Under en henting kommer det mange endringer tett; nettleserne får ett
  // samlet bilde i stedet for ett per lang tekst.
  onChange: () => {
    if (diag && !diagBroadcast) {
      diagBroadcast = setTimeout(() => { diagBroadcast = null; broadcast('diag', diag.snapshot()); }, 250);
    }
  },
});
let diagBroadcast = null, diagTimer = null;

// Hent om litt. Flere grunner tett etter hverandre gir én henting: når
// ERROR-dioden begynner å blinke, endres gjerne flere signaler samtidig,
// og oppføringen havner i bufferen et øyeblikk etter signalet.
function diagSoon(reason, ms) {
  if (!diag || diagTimer) return;
  diagTimer = setTimeout(() => { diagTimer = null; diag.refresh(reason); }, ms);
}

// Navnet på det første diagnosesignalet som er endret siden forrige
// datamelding, eller null: words med {led} eller {ob80}, bits med {alarm}.
function diagSignalChanged(a, b) {
  for (let i = 0; i < b.words.length; i++) {
    const n = link.nameAndUnit(plc.names, 'tx_words', i);
    if ((n.fmt === 'led' || n.fmt === 'ob80') && a.words[i] !== b.words[i]) return n.name;
  }
  for (let i = 0; i < b.bits.length; i++) {
    const n = link.nameAndUnit(plc.names, 'tx_bits', i);
    if (n.fmt === 'alarm' && a.bits[i] !== b.bits[i]) return n.name;
  }
  return null;
}

if (diag) diag.refresh('serveren startet');

// Hold linken i live: kommandoer med bare nuller, i størrelsen PLS-en ba om.
setInterval(() => {
  if (plc.sock && plc.rxLayout && plc.state !== 'down') {
    plc.seqOut = (plc.seqOut + 1) & 0xffff;
    plc.sock.write(link.encodeDownlink(plc.seqOut, plc.rxLayout, {}));
  }
}, KEEPALIVE);

// Oppdager stillhet, og sender statusen siden viser, én gang i sekundet.
setInterval(() => {
  const now = Date.now();
  while (plc.recent.length && now - plc.recent[0] > 1000) plc.recent.shift();
  if (plc.state === 'up' && now - plc.lastAt > STALE_AFTER) setState('stale', 'ingen melding på ' + STALE_AFTER / 1000 + ' s');
  broadcast('status', status());
}, 1000);

function setState(state, why) {
  plc.state = state;
  plc.why = why;
  broadcast('status', status());
}

function status() {
  return {
    state: plc.state, why: plc.why, host: PLC_HOST, port: PLC_PORT,
    rate: plc.recent.length, gaps: plc.gaps,
    ageMs: plc.lastAt ? Date.now() - plc.lastAt : null,
  };
}

// Én etikett per plass som finnes på linjen: PLS-ens navn, delt i navn og
// enhet etter samme regel som klientene, eller indeksen når plassen ikke har
// noe navn. Datameldingen sier hvor mange plasser det er; navnemeldingen
// alene kan ikke det, fordi en navnearray kan være kortere.
function labels() {
  const d = plc.data, rx = plc.rxLayout;
  if (!d || !rx) return null;
  const counts = {
    tx_bits: d.bits.length, tx_words: d.words.length, tx_times: d.times.length,
    tx_ints: d.ints.length, tx_dints: d.dints.length, tx_reals: d.reals.length,
    rx_bits: rx[0] * 8, rx_words: rx[1], rx_ints: rx[3], rx_dints: rx[4], rx_reals: rx[5],
  };
  const out = {};
  for (const sec of Object.keys(counts)) {
    const got = plc.names[sec] || [];
    out[sec] = [];
    for (let i = 0; i < counts[sec]; i++) {
      const nu = link.nameAndUnit(plc.names, sec, i);
      out[sec].push({ name: nu.name, unit: nu.unit, fmt: nu.fmt, named: !!got[i] });
    }
  }
  return out;
}

function pushLabels() {
  const l = labels();
  if (!l) return;
  const key = JSON.stringify(l);
  if (key === plc.labelsKey) return;
  plc.labelsKey = key;
  broadcast('labels', l);
}

// ======================================================= nettside + hendelser
const clients = new Set();

function send(res, event, obj) {
  res.write('event: ' + event + '\ndata: ' + JSON.stringify(obj) + '\n\n');
}

function broadcast(event, obj) {
  for (const res of clients) send(res, event, obj);
}

// En kommentarlinje nå og da holder stille forbindelser åpne gjennom alt
// som gir opp HTTP-forbindelser uten trafikk.
setInterval(() => { for (const res of clients) res.write(': ping\n\n'); }, 15000);

http.createServer((req, res) => {
  const url = req.url.split('?')[0];

  if (url === '/' || url === '/index.html') {
    // Leses ved hver forespørsel, så en endret side vises ved en vanlig oppdatering.
    fs.readFile(PAGE, (err, buf) => {
      if (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('tcplink_web.html må ligge ved siden av tcplink_web.js\n');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(buf);
    });
    return;
  }

  if (url === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    res.write('retry: 2000\n\n');
    clients.add(res);
    // En side som åpnes midt i økten, får alt med en gang.
    send(res, 'status', status());
    const l = labels();
    if (l) send(res, 'labels', l);
    if (plc.data) send(res, 'data', plc.data);
    if (plc.hist.known) send(res, 'history', history());
    send(res, 'diag', diag ? diag.snapshot() : { off: true });
    req.on('close', () => clients.delete(res));
    return;
  }

  // Oppdater-knappen. Ber bare serveren hente diagnosebufferen på nytt;
  // ingenting sendes til PLS-programmet.
  if (url === '/diag/refresh' && req.method === 'POST') {
    if (!diag) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('diagnosebufferen er slått av (DIAG_HOST=av)\n');
      return;
    }
    diag.refresh('Oppdater-knappen');
    res.writeHead(202, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('henter\n');
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('finnes ikke\n');
}).listen(HTTP_PORT, () => {
  console.log('[web] http://localhost:' + HTTP_PORT + '  (PLS ' + PLC_HOST + ':' + PLC_PORT +
              (diag ? ', diagnosebuffer fra ' + DIAG_HOST : '') + ')');
});

connect();
