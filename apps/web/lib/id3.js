// A small ID3v2.3 writer for album tracks: title, artist, album, track
// number, genre, year, a comment, unsynchronised lyrics (USLT, which players
// show as lyrics; ffmpeg only writes a TXXX for them) and the front cover
// (APIC). Text is UTF-16 with a BOM, which every ID3v2.3 reader takes.

const utf16 = (s) => Buffer.from(`﻿${String(s ?? "")}`, "utf16le");
const ENC_UTF16 = Buffer.from([1]);
const NUL16 = Buffer.from([0, 0]);

function frame(id, body) {
  const head = Buffer.alloc(10);
  head.write(id, 0, "latin1");
  head.writeUInt32BE(body.length, 4);
  return Buffer.concat([head, body]);
}

const textFrame = (id, value) => frame(id, Buffer.concat([ENC_UTF16, utf16(value)]));

/** USLT / COMM: encoding, language, empty description, text. */
const langFrame = (id, text, lang = "eng") => frame(id, Buffer.concat([ENC_UTF16, Buffer.from(lang.slice(0, 3).padEnd(3, " "), "latin1"), utf16(""), NUL16, utf16(text)]));

function syncsafe(n) {
  return Buffer.from([(n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f]);
}

/** The audio with any leading ID3v2 tag removed. */
export function stripId3v2(bytes) {
  const b = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (b.length < 10 || b.toString("latin1", 0, 3) !== "ID3") return b;
  const size = ((b[6] & 0x7f) << 21) | ((b[7] & 0x7f) << 14) | ((b[8] & 0x7f) << 7) | (b[9] & 0x7f);
  const footer = b[5] & 0x10 ? 10 : 0;
  return b.subarray(Math.min(b.length, 10 + size + footer));
}

/**
 * The ID3v2.3 tag bytes. tags: { title, artist, album, albumArtist, track,
 * total, genre, year, comment, lyrics, cover: { bytes, mime } }.
 */
export function id3Tag(tags) {
  const frames = [];
  if (tags.title) frames.push(textFrame("TIT2", tags.title));
  if (tags.artist) frames.push(textFrame("TPE1", tags.artist));
  if (tags.albumArtist ?? tags.artist) frames.push(textFrame("TPE2", tags.albumArtist ?? tags.artist));
  if (tags.album) frames.push(textFrame("TALB", tags.album));
  if (tags.track) frames.push(textFrame("TRCK", tags.total ? `${tags.track}/${tags.total}` : String(tags.track)));
  if (tags.genre) frames.push(textFrame("TCON", tags.genre));
  if (tags.year) frames.push(textFrame("TYER", String(tags.year)));
  if (tags.comment) frames.push(langFrame("COMM", tags.comment));
  if (tags.lyrics) frames.push(langFrame("USLT", tags.lyrics));
  if (tags.cover?.bytes?.length) {
    const mime = tags.cover.mime || "image/jpeg";
    // encoding 0 (latin1), MIME, picture type 3 = front cover, empty description.
    frames.push(frame("APIC", Buffer.concat([Buffer.from([0]), Buffer.from(`${mime}\0`, "latin1"), Buffer.from([3, 0]), Buffer.from(tags.cover.bytes)])));
  }
  const body = Buffer.concat(frames);
  const head = Buffer.concat([Buffer.from("ID3", "latin1"), Buffer.from([3, 0, 0]), syncsafe(body.length)]);
  return Buffer.concat([head, body]);
}

/** An MP3 with its old ID3v2 tag replaced by one built from `tags`. */
export function tagMp3(bytes, tags) {
  return Buffer.concat([id3Tag(tags), stripId3v2(bytes)]);
}
