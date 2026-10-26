#!/usr/bin/env python3
"""
Minimal TcpLink-klient -- bare standardbiblioteket.

    python tcplink_client.py 192.168.0.1 2000

Trenger ingen konfigurasjon: størrelsen på hver seksjon leses fra
layoutbytene i headeren på meldingene fra PLS-en, navnene fra
navnemeldingen PLS-en sender ved tilkobling, og kommandorammene bygges
slik PLS-en sier at den forventer dem. Endre størrelse på en UDT eller gi
en plass nytt navn i PLS-en, og dette fortsetter å virke.

Ved tilkobling skriver den også ut historikken fra PLS-ens retentive
minne, eldste hendelse først, og deretter nye hendelser etter hvert.

Bruk den som en røyktest for et nytt PLS-prosjekt, eller som utgangspunkt
for en ekte klient. Se TCP_LINK.md for formatet på linjen.
"""

import re
import socket
import struct
import sys
import time

UP_MAGIC, UP_VER, UP_HDR = 0xA5, 7, 32
DN_MAGIC, DN_VER, DN_HDR = 0x5A, 3, 14
KIND_DATA, KIND_NAMES, KIND_HIST = 0, 1, 2   # byte 7 i meldingen fra PLS-en
HIST_REC = 20             # byte per historikkpost ("TcpLinkHistRec")
LEN_MAX = 8192            # TSEND sitt eget tak; alt større er en falsk header
KEEPALIVE = 0.5           # må holde seg godt under rxTimeout i PLS-en

# De tolv layoutplassene, i rekkefølgen på linjen. rx_times er alltid tom foreløpig.
SECTIONS = ("tx_bits", "tx_words", "tx_times", "tx_ints", "tx_dints", "tx_reals",
            "rx_bits", "rx_words", "rx_times", "rx_ints", "rx_dints", "rx_reals")

# Bare tallplasser har en enhet i navnet, se split_unit.
NUMERIC = {"tx_ints", "tx_dints", "tx_reals", "rx_ints", "rx_dints", "rx_reals"}
UNIT_RE = re.compile(r"^(.*\S)\s*\[([^\[\]]+)\]$")


# Layoutbyte, per retning, i samme rekkefølge som innholdet:
#   bit-byte, words, times, ints, dints, reals
def section_len(bit_bytes, words, times, ints, dints, reals):
    return bit_bytes + 2 * words + 12 * times + 2 * ints + 4 * dints + 4 * reals


def read_dtl(m, off):
    """S7 DTL, 12 byte. Returnerer (å, mnd, d, t, min, s, ms); år 1970 = aldri satt."""
    year, month, day, _wd, hh, mm, ss, ns = struct.unpack_from(">HBBBBBBI", m, off)
    return (year, month, day, hh, mm, ss, ns // 1_000_000)


def read_bits(m, off, n_bytes):
    """Byte off+0 bit 0 er element 0, minst signifikante bit først -- en S7 Bool-array."""
    return [(m[off + (i >> 3)] >> (i & 7)) & 1 == 1 for i in range(n_bytes * 8)]


def decode_uplink(m):
    seq, flags = struct.unpack_from(">HB", m, 4)
    lay = m[8:20]
    ts = read_dtl(m, 20)
    tx_bb, tx_w, tx_t, tx_i, tx_d, tx_r = lay[0:6]

    off = UP_HDR
    bits = read_bits(m, off, tx_bb);                          off += tx_bb
    words = list(struct.unpack_from(">%dH" % tx_w, m, off));  off += 2 * tx_w
    times = [read_dtl(m, off + 12 * i) for i in range(tx_t)]; off += 12 * tx_t
    ints = list(struct.unpack_from(">%dh" % tx_i, m, off));   off += 2 * tx_i
    dints = list(struct.unpack_from(">%di" % tx_d, m, off));  off += 4 * tx_d
    reals = list(struct.unpack_from(">%df" % tx_r, m, off))

    return dict(seq=seq, local_time=bool(flags & 1),
                ts=ts, ts_valid=ts[0] >= 2000,    # 1970 = CPU-klokka aldri stilt
                bits=bits, words=words, times=times,
                ints=ints, dints=dints, reals=reals,
                rx_layout=bytes(lay[6:12]))


def walk_names(m, length):
    """Sjekk en komplett navnemelding og returner strengene, eller None.

    Hver S7-streng er [deklarert lengde][nåværende lengde][deklarerte tegn].
    Den deklarerte lengden er et partall (PLS-en avviser odde lengder), så
    strengene følger rett etter hverandre uten fyllbyte, og må slutte
    nøyaktig ved len.
    """
    counts = m[8:20]
    off, out = UP_HDR, {}
    for key, n in zip(SECTIONS, counts):
        names = []
        for _ in range(n):
            if off + 2 > length:
                return None
            mx, cur = m[off], m[off + 1]
            if mx % 2 or cur > mx or off + 2 + mx > length:
                return None
            names.append(bytes(m[off + 2:off + 2 + cur]).decode("cp1252", "replace"))
            off += 2 + mx
        out[key] = names
    return out if off == length else None


def decode_history(m):
    """En historikkmelding (kind 2): hvor langt PLS-en har kommet, og 0..16 poster.

    Hver post er en bit eller et word i txDigital som endret seg:
    section 0 = bits, 1 = words; value er 0/1 for en bit, hele wordet ellers.
    """
    seq, flags = struct.unpack_from(">HB", m, 4)
    newest, capacity, count, oldest, cleared_to = struct.unpack_from(">IHHII", m, 8)
    records = []
    for i in range(count):
        off = UP_HDR + HIST_REC * i
        rec_no = struct.unpack_from(">I", m, off)[0]
        section, index, value = struct.unpack_from(">BBH", m, off + 16)
        records.append(dict(rec_no=rec_no, ts=read_dtl(m, off + 4),
                            section=section, index=index, value=value))
    return dict(seq=seq, local_time=bool(flags & 1), newest=newest,
                capacity=capacity, count=count, oldest=oldest,
                cleared_to=cleared_to, records=records)


def encode_downlink(seq, rx_layout, bits=(), words=(), ints=(), dints=(), reals=()):
    """Korte lister fylles ut med nuller, lange kuttes, til størrelsene i PLS-en."""
    bb, nw, nt, ni, nd, nr = rx_layout
    if nt:
        raise ValueError("PLS-en ber om times i kommandorammen; det støttes ikke her")
    length = DN_HDR + section_len(bb, nw, nt, ni, nd, nr)
    b = bytearray(length)
    struct.pack_into(">BBHHBB", b, 0, DN_MAGIC, DN_VER, length, seq & 0xFFFF, 0, 0)
    b[8:14] = rx_layout

    def fit(values, n):
        values = list(values)[:n]
        return values + [0] * (n - len(values))

    off = DN_HDR
    for i, on in enumerate(list(bits)[:bb * 8]):
        if on:
            b[off + (i >> 3)] |= 1 << (i & 7)
    off += bb
    struct.pack_into(">%dH" % nw, b, off, *[v & 0xFFFF for v in fit(words, nw)]); off += 2 * nw
    struct.pack_into(">%dh" % ni, b, off, *fit(ints, ni));                        off += 2 * ni
    struct.pack_into(">%di" % nd, b, off, *fit(dints, nd));                       off += 4 * nd
    struct.pack_into(">%df" % nr, b, off, *[float(v) for v in fit(reals, nr)])
    return bytes(b)


def next_frame(buf):
    """Returner (kind, frame, rest), eller (None, None, rest) når flere byte trengs.

    TCP er en bytestrøm: let etter headeren i stedet for å anta at alt
    ligger på plass. En byte i innholdet kan tilfeldigvis være 0xA5, så en
    header teller bare når alt i den stemmer overens: for data må len passe
    med layouten; for navn må reservebytene være null og strengene slutte
    ved len; for historikk må len passe med antall poster.
    """
    while True:
        start = buf.find(bytes([UP_MAGIC]))
        if start < 0:
            return None, None, b""
        buf = buf[start:]
        if len(buf) < UP_HDR:
            return None, None, buf
        ver, kind = buf[1], buf[7]
        length = struct.unpack_from(">H", buf, 2)[0]

        if ver == UP_VER and kind == KIND_DATA and length == UP_HDR + section_len(*buf[8:14]):
            if len(buf) < length:
                return None, None, buf
            return KIND_DATA, buf[:length], buf[length:]

        if (ver == UP_VER and kind == KIND_NAMES and length <= LEN_MAX
                and buf[6] == 0 and buf[16] == 0 and not any(buf[20:32])
                and length >= UP_HDR + 2 * sum(buf[8:20])):
            if len(buf) < length:
                return None, None, buf
            if walk_names(buf, length) is not None:
                return KIND_NAMES, buf[:length], buf[length:]

        if (ver == UP_VER and kind == KIND_HIST and (buf[6] & 0xFE) == 0
                and length == UP_HDR + HIST_REC * struct.unpack_from(">H", buf, 14)[0]
                and length <= LEN_MAX and struct.unpack_from(">I", buf, 16)[0] >= 1
                and not any(buf[24:32])):
            if len(buf) < length:
                return None, None, buf
            return KIND_HIST, buf[:length], buf[length:]

        buf = buf[1:]                     # falsk header inne i innholdet


def split_unit(section, text):
    """'Moment [Nm]' -> ('Moment', 'Nm'), bare for tallplasser.

    Bare hakeparenteser, og bare helt til slutt. Bits, words, times og
    kommandoknapper beholder alltid hele strengen som navn.
    """
    m = UNIT_RE.match(text) if section in NUMERIC else None
    return (m.group(1), m.group(2)) if m else (text, "")


def label(names, section, i):
    """PLS-ens navn på en plass, eller indeksen når den ikke har noe navn."""
    got = names.get(section, [])
    return got[i] if i < len(got) and got[i] else "%s[%d]" % (section[3:], i)


def name_and_unit(names, section, i):
    """(navn, enhet) for en plass. Bare et navn fra PLS-en deles opp:
    reserveetiketten 'reals[3]' skal ikke leses som enheten '3'."""
    got = names.get(section, [])
    if i < len(got) and got[i]:
        return split_unit(section, got[i])
    return label(names, section, i), ""


def history_line(names, rec):
    """'historikk #12 2026-10-23 08:15:02.250 Feilkode = 16#0003'"""
    y, mo, d, h, mi, s, ms = rec["ts"]
    when = "%d-%02d-%02d %02d:%02d:%02d.%03d" % (y, mo, d, h, mi, s, ms)
    is_bit = rec["section"] == 0
    name = label(names, "tx_bits" if is_bit else "tx_words", rec["index"])
    value = ("på" if rec["value"] else "av") if is_bit else "16#%04X" % rec["value"]
    return "historikk #%d %s %s = %s" % (rec["rec_no"], when, name, value)


def main():
    host = sys.argv[1] if len(sys.argv) > 1 else "192.168.0.1"
    port = int(sys.argv[2]) if len(sys.argv) > 2 else 2000

    sock = socket.create_connection((host, port))
    sock.settimeout(0.1)
    buf, seq, rx_layout, last_tx, names = b"", 0, None, 0.0, {}

    # Det som skal sendes. Indeksene er kontrakten med "TcpLinkRx".
    cmd = dict(bits=[False] * 16, words=[], ints=[], dints=[], reals=[])

    while True:
        try:
            chunk = sock.recv(4096)
            if not chunk:
                print("lukket av PLS-en")
                return
            buf += chunk
        except socket.timeout:
            pass

        while True:
            kind, frame, buf = next_frame(buf)
            if frame is None:
                break

            if kind == KIND_NAMES:
                names = walk_names(frame, len(frame))
                for key in SECTIONS:
                    named = [(i, n) for i, n in enumerate(names[key]) if n]
                    if named:
                        print("navn", key, named)
                continue

            if kind == KIND_HIST:
                h = decode_history(frame)
                for rec in h["records"]:
                    print(history_line(names, rec))
                if not h["count"]:
                    print("historikk: %s (nyeste #%d, %d plasser)" % (
                        "ingen nye poster" if h["newest"] > h["cleared_to"] else "tom",
                        h["newest"], h["capacity"]))
                continue

            s = decode_uplink(frame)
            if rx_layout != s["rx_layout"]:
                rx_layout = s["rx_layout"]
                print("PLS-en forventer kommandolayout", list(rx_layout))
            on = [label(names, "tx_bits", i) for i, b in enumerate(s["bits"]) if b]
            reals = {}
            for i, r in enumerate(s["reals"][:4]):
                name, unit = name_and_unit(names, "tx_reals", i)
                reals[name] = "%g%s" % (round(r, 3), " " + unit if unit else "")
            print(s["seq"], "på:", on, "ints:", s["ints"][:4], "reals:", reals)

        # Ingenting går ut før den første meldingen har fortalt oss layouten.
        now = time.monotonic()
        if rx_layout is not None and now - last_tx >= KEEPALIVE:
            last_tx = now
            seq += 1
            sock.sendall(encode_downlink(seq, rx_layout, **cmd))


if __name__ == "__main__":
    main()
