// 비밀번호가 걸린 엑셀·워드·파워포인트(xlsx·docx·pptx)와 97~2003 엑셀(xls)·워드(doc) 풀기.
// 이런 파일은 ZIP이 아니라 OLE 컨테이너 안에 EncryptionInfo(암호 방식)와 EncryptedPackage(암호화된 ZIP)가 들어 있다.
// [MS-OFFCRYPTO] 2.3.4.10~15(Agile: Office 2010 이후 기본)과 2.3.4.5~7(Standard: Office 2007)을 따른다.
// 해시·AES는 감사받은 @noble/hashes·@noble/ciphers(MIT)를 쓴다.
import { md5, sha1 } from '@noble/hashes/legacy.js';
import { sha256, sha384, sha512 } from '@noble/hashes/sha2.js';
import { cbc, ecb } from '@noble/ciphers/aes.js';

const HASHES = { SHA1: sha1, 'SHA-1': sha1, SHA256: sha256, 'SHA-256': sha256, SHA384: sha384, 'SHA-384': sha384, SHA512: sha512, 'SHA-512': sha512 };

function unsupported(what) {
  const err = new Error(`지원하지 않는 암호 방식: ${what}`);
  err.code = 'unsupported-encryption';
  return err;
}

function b64(text) {
  const raw = atob(text || '');
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function utf16le(text) {
  const out = new Uint8Array(text.length * 2);
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    out[i * 2] = c & 0xff;
    out[i * 2 + 1] = c >> 8;
  }
  return out;
}

function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

function le32(n) {
  return new Uint8Array([n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]);
}

function equal(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}

// 길이를 맞춘다: 길면 자르고, 짧으면 pad 바이트로 채운다.
function fit(bytes, size, pad) {
  if (bytes.length >= size) return bytes.slice(0, size);
  const out = new Uint8Array(size).fill(pad);
  out.set(bytes);
  return out;
}

// H0 = H(salt + 비밀번호), Hn = H(n + Hn-1) 를 spinCount번. 같은 버퍼를 다시 써서 빠르게 돈다.
function spin(hash, salt, password, count) {
  let h = hash(concat(salt, utf16le(password)));
  const buf = new Uint8Array(4 + h.length);
  for (let i = 0; i < count; i++) {
    buf[0] = i & 0xff; buf[1] = (i >>> 8) & 0xff; buf[2] = (i >>> 16) & 0xff; buf[3] = (i >>> 24) & 0xff;
    buf.set(h, 4);
    h = hash(buf);
  }
  return h;
}

function attrs(xml, tag) {
  const m = new RegExp(`<(?:\\w+:)?${tag}\\b([^>]*)>`).exec(xml);
  if (!m) return null;
  const out = {};
  for (const a of m[1].matchAll(/(\w+)="([^"]*)"/g)) out[a[1]] = a[2];
  return out;
}

// ---------------------------------------------------------------- Agile (EncryptionInfo 4.4)

const BLOCK_VERIFIER_INPUT = new Uint8Array([0xfe, 0xa7, 0xd2, 0x76, 0x3b, 0x4b, 0x9e, 0x79]);
const BLOCK_VERIFIER_VALUE = new Uint8Array([0xd7, 0xaa, 0x0f, 0x6d, 0x30, 0x61, 0x34, 0x4e]);
const BLOCK_KEY = new Uint8Array([0x14, 0x6e, 0x0b, 0xe7, 0xab, 0xac, 0xd0, 0xd6]);

function parseAgile(info) {
  const xml = new TextDecoder().decode(info.subarray(8));
  const keyData = attrs(xml, 'keyData');
  const enc = attrs(xml, 'encryptedKey');
  if (!keyData || !enc) throw unsupported('Agile 정보 없음(인증서 암호 등)');
  for (const k of [keyData, enc]) {
    if (k.cipherAlgorithm !== 'AES') throw unsupported(k.cipherAlgorithm);
    if (k.cipherChaining !== 'ChainingModeCBC') throw unsupported(k.cipherChaining);
    if (!HASHES[k.hashAlgorithm]) throw unsupported(k.hashAlgorithm);
  }
  return { type: 'agile', keyData, enc };
}

function agileKey(p, password) {
  const { enc, keyData } = p;
  const hash = HASHES[enc.hashAlgorithm];
  const keyBytes = Number(enc.keyBits) / 8;
  const salt = b64(enc.saltValue);
  const h = spin(hash, salt, password, Number(enc.spinCount));
  const derive = (block) => fit(hash(concat(h, block)), keyBytes, 0x36);
  const iv = fit(salt, Number(enc.blockSize), 0x36);
  const dec = (key, data) => cbc(key, iv, { disablePadding: true }).decrypt(data);
  const input = dec(derive(BLOCK_VERIFIER_INPUT), b64(enc.encryptedVerifierHashInput)).slice(0, Number(enc.saltSize));
  const value = dec(derive(BLOCK_VERIFIER_VALUE), b64(enc.encryptedVerifierHashValue)).slice(0, Number(enc.hashSize));
  if (!equal(hash(input), value)) return null; // 비밀번호가 틀림
  return dec(derive(BLOCK_KEY), b64(enc.encryptedKeyValue)).slice(0, Number(keyData.keyBits) / 8);
}

function agileDecrypt(p, key, pkg) {
  const { keyData } = p;
  const hash = HASHES[keyData.hashAlgorithm];
  const salt = b64(keyData.saltValue);
  const blockSize = Number(keyData.blockSize);
  const size = Number(new DataView(pkg.buffer, pkg.byteOffset, 8).getBigUint64(0, true));
  const data = pkg.subarray(8);
  const out = new Uint8Array(data.length);
  const SEG = 4096;
  for (let i = 0, off = 0; off < data.length; i++, off += SEG) {
    const iv = fit(hash(concat(salt, le32(i))), blockSize, 0x36);
    // 마지막 조각은 16바이트 배수로 채워 저장돼 있다.
    const chunk = data.subarray(off, Math.min(data.length, off + SEG));
    const usable = chunk.subarray(0, chunk.length - (chunk.length % 16));
    out.set(cbc(key, iv, { disablePadding: true }).decrypt(usable), off);
  }
  return out.slice(0, size);
}

// ---------------------------------------------------------------- Standard (EncryptionInfo 2.2·3.2·4.2, AES)

function parseStandard(info) {
  const dv = new DataView(info.buffer, info.byteOffset, info.byteLength);
  const flags = dv.getUint32(4, true);
  if (!(flags & 0x20)) throw unsupported('Standard RC4');
  const headerSize = dv.getUint32(8, true);
  const h = 12;
  const algId = dv.getUint32(h + 8, true);
  const keyBits = dv.getUint32(h + 16, true);
  if (algId !== 0x660e && algId !== 0x660f && algId !== 0x6610) throw unsupported(`AlgID 0x${algId.toString(16)}`);
  const v = h + headerSize;
  const saltSize = dv.getUint32(v, true);
  return {
    type: 'standard',
    keyBytes: keyBits / 8,
    salt: info.slice(v + 4, v + 4 + saltSize),
    verifier: info.slice(v + 4 + saltSize, v + 20 + saltSize),
    verifierHashSize: dv.getUint32(v + 20 + saltSize, true),
    verifierHash: info.slice(v + 24 + saltSize, v + 24 + saltSize + 32),
  };
}

function standardKey(p, password) {
  const h = spin(sha1, p.salt, password, 50000);
  const hfinal = sha1(concat(h, le32(0)));
  const x = (pad) => {
    const buf = new Uint8Array(64).fill(pad);
    for (let i = 0; i < hfinal.length; i++) buf[i] ^= hfinal[i];
    return sha1(buf);
  };
  const key = concat(x(0x36), x(0x5c)).slice(0, p.keyBytes);
  const dec = (data) => ecb(key, { disablePadding: true }).decrypt(data);
  const verifier = dec(p.verifier);
  const hash = dec(p.verifierHash).slice(0, p.verifierHashSize);
  return equal(sha1(verifier), hash) ? key : null;
}

function standardDecrypt(key, pkg) {
  const size = Number(new DataView(pkg.buffer, pkg.byteOffset, 8).getBigUint64(0, true));
  const data = pkg.subarray(8);
  const usable = data.subarray(0, data.length - (data.length % 16));
  return ecb(key, { disablePadding: true }).decrypt(usable).slice(0, size);
}

// ---------------------------------------------------------------- 공개 함수

// EncryptionInfo를 읽어 방식을 알아낸다. 풀 수 없는 방식이면 err.code = 'unsupported-encryption'.
export function readEncryptionInfo(info) {
  const dv = new DataView(info.buffer, info.byteOffset, info.byteLength);
  const major = dv.getUint16(0, true);
  const minor = dv.getUint16(2, true);
  if (major === 4 && minor === 4) return parseAgile(info);
  if ((major === 2 || major === 3 || major === 4) && minor === 2) return parseStandard(info);
  throw unsupported(`EncryptionInfo ${major}.${minor}`);
}

// 비밀번호로 풀어 원래 ZIP(xlsx·docx·pptx)을 돌려준다. 비밀번호가 틀리면 null.
export function decryptPackage(parsed, password, pkg) {
  if (parsed.type === 'agile') {
    const key = agileKey(parsed, password);
    return key ? agileDecrypt(parsed, key, pkg) : null;
  }
  const key = standardKey(parsed, password);
  return key ? standardDecrypt(key, pkg) : null;
}

// ---------------------------------------------------------------- 97~2003 엑셀(xls)의 RC4 암호
// [MS-XLS] 2.4.117 FilePass, [MS-OFFCRYPTO] 2.3.6(RC4)·2.3.5(RC4 CryptoAPI).
// 통합 문서 스트림 전체에 1024바이트마다 열쇠를 새로 만든 RC4를 걸되, 기록 머리(종류·길이)와
// 암호화하지 않는 기록(BOF·FilePass 등), 시트 목록의 시작 위치 칸은 그대로 둔다.

function rc4Keystream(key, length) {
  const S = new Uint8Array(256);
  for (let i = 0; i < 256; i++) S[i] = i;
  for (let i = 0, j = 0; i < 256; i++) {
    j = (j + S[i] + key[i % key.length]) & 0xff;
    const t = S[i]; S[i] = S[j]; S[j] = t;
  }
  const out = new Uint8Array(length);
  for (let n = 0, i = 0, j = 0; n < length; n++) {
    i = (i + 1) & 0xff;
    j = (j + S[i]) & 0xff;
    const t = S[i]; S[i] = S[j]; S[j] = t;
    out[n] = S[(S[i] + S[j]) & 0xff];
  }
  return out;
}

function xorInto(data, ks) {
  const out = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i++) out[i] = data[i] ^ ks[i];
  return out;
}

// EncryptionVersionInfo부터 시작하는 RC4 암호 머리를 읽는다(xls는 FilePass 기록 안, doc은 표 스트림 맨 앞).
function readRc4Header(bytes, o, what) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const major = dv.getUint16(o, true);
  const minor = dv.getUint16(o + 2, true);
  if (major === 1 && minor === 1) {
    return {
      type: 'rc4', salt: bytes.slice(o + 4, o + 20),
      verifier: bytes.slice(o + 20, o + 36), verifierHash: bytes.slice(o + 36, o + 52),
    };
  }
  if ((major === 2 || major === 3 || major === 4) && minor === 2) {
    const headerSize = dv.getUint32(o + 8, true);
    const h = o + 12;
    const keyBits = dv.getUint32(h + 16, true) || 40;
    const v = h + headerSize;
    const saltSize = dv.getUint32(v, true);
    return {
      type: 'cryptoapi', keyBits, salt: bytes.slice(v + 4, v + 4 + saltSize),
      verifier: bytes.slice(v + 4 + saltSize, v + 20 + saltSize),
      verifierHash: bytes.slice(v + 24 + saltSize, v + 44 + saltSize),
    };
  }
  throw unsupported(`${what} RC4 ${major}.${minor}`);
}

// 통합 문서 스트림에서 FilePass를 찾아 암호 방식을 읽는다. 암호가 없으면 null.
export function readXlsEncryption(stream) {
  const dv = new DataView(stream.buffer, stream.byteOffset, stream.byteLength);
  for (let p = 0, n = 0; p + 4 <= stream.length && n < 64; n++) {
    const type = dv.getUint16(p, true);
    const len = dv.getUint16(p + 2, true);
    if (type === 0x002f) {
      if (dv.getUint16(p + 4, true) === 0) throw unsupported('XOR 난독화');
      return readRc4Header(stream, p + 6, 'xls');
    }
    p += 4 + len;
  }
  return null;
}

function rc4KeyFor(enc, password) {
  if (enc.type === 'rc4') {
    const h0 = md5(utf16le(password)).slice(0, 5);
    const buf = new Uint8Array(21 * 16);
    for (let i = 0; i < 16; i++) { buf.set(h0, i * 21); buf.set(enc.salt, i * 21 + 5); }
    const h1 = md5(buf).slice(0, 5);
    return (block) => md5(concat(h1, le32(block))).slice(0, 16);
  }
  const h0 = sha1(concat(enc.salt, utf16le(password)));
  return (block) => {
    const h = sha1(concat(h0, le32(block)));
    return enc.keyBits === 40 ? concat(h.slice(0, 5), new Uint8Array(11)) : h.slice(0, enc.keyBits / 8);
  };
}

// 비밀번호가 맞으면 블록 번호 → 열쇠 함수를, 틀리면 null을 돌려준다.
function rc4Verify(enc, password) {
  const keyFor = rc4KeyFor(enc, password);
  const hash = enc.type === 'rc4' ? md5 : sha1;
  const check = rc4Keystream(keyFor(0), 16 + enc.verifierHash.length);
  const verifier = xorInto(enc.verifier, check.subarray(0, 16));
  const verifierHash = xorInto(enc.verifierHash, check.subarray(16));
  return equal(hash(verifier), verifierHash.slice(0, hash === md5 ? 16 : 20)) ? keyFor : null;
}

// 스트림 처음부터 blockSize 바이트마다 열쇠를 새로 만든 RC4 열쇠 흐름
function rc4Blocks(keyFor, length, blockSize) {
  const ks = new Uint8Array(length);
  for (let block = 0, off = 0; off < length; block++, off += blockSize) {
    ks.set(rc4Keystream(keyFor(block), Math.min(blockSize, length - off)), off);
  }
  return ks;
}

// 풀린 통합 문서 스트림을 돌려준다(FilePass는 지워 둔다). 비밀번호가 틀리면 null.
export function decryptXlsStream(enc, password, stream) {
  const keyFor = rc4Verify(enc, password);
  if (!keyFor) return null;
  const ks = rc4Blocks(keyFor, stream.length, 1024);
  const out = stream.slice();
  const dv = new DataView(out.buffer, out.byteOffset, out.byteLength);
  const PLAIN = new Set([0x0809, 0x002f, 0x0194, 0x0195, 0x00e1, 0x0196, 0x0138]);
  for (let p = 0; p + 4 <= out.length;) {
    const type = dv.getUint16(p, true);
    const len = dv.getUint16(p + 2, true);
    const body = p + 4;
    const end = Math.min(out.length, body + len);
    if (type === 0x002f) {
      // 암호 기록은 같은 길이의 빈 기록으로 바꾼다(뒤 기록들의 위치가 그대로여야 한다).
      dv.setUint16(p, 0x0000, true);
      out.fill(0, body, end);
    } else if (!PLAIN.has(type)) {
      const from = type === 0x0085 ? body + 4 : body; // 시트 목록의 시작 위치(4바이트)는 암호화하지 않는다
      for (let i = from; i < end; i++) out[i] ^= ks[i];
    }
    p = body + len;
  }
  return out;
}

// ---------------------------------------------------------------- 97~2003 워드(doc)의 RC4 암호
// [MS-DOC] 2.2.6.2: 암호 머리는 표 스트림(0Table·1Table) 맨 앞에 있고, 길이는 FIB의 lKey에 적힌다.
// WordDocument(앞 68바이트 FIB 머리 제외)·표·Data 스트림 전체를 512바이트마다 열쇠를 새로 만든 RC4로 푼다.

const FIB_PLAIN = 0x44;

// WordDocument 스트림의 FIB를 보고 암호 방식을 읽는다. 암호가 없으면 null.
export function readDocEncryption(wordDocument, table) {
  const dv = new DataView(wordDocument.buffer, wordDocument.byteOffset, wordDocument.byteLength);
  const flags = dv.getUint16(0x0a, true);
  if (!(flags & 0x0100)) return null;
  if (flags & 0x8000) throw unsupported('XOR 난독화');
  return readRc4Header(table, 0, 'doc');
}

// 이 FIB가 가리키는 표 스트림 이름(fWhichTblStm)
export function docTableName(wordDocument) {
  return (wordDocument[0x0b] & 0x02) ? '1Table' : '0Table';
}

// 풀린 스트림들을 돌려준다(FIB의 암호 표시는 지운다). 비밀번호가 틀리면 null.
export function decryptDocStreams(enc, password, streams) {
  const keyFor = rc4Verify(enc, password);
  if (!keyFor) return null;
  const run = (s) => s && xorInto(s, rc4Blocks(keyFor, s.length, 0x200));
  const wordDocument = run(streams.wordDocument);
  wordDocument.set(streams.wordDocument.subarray(0, FIB_PLAIN));
  const dv = new DataView(wordDocument.buffer, wordDocument.byteOffset, wordDocument.byteLength);
  dv.setUint16(0x0a, dv.getUint16(0x0a, true) & ~0x8100, true); // fEncrypted·fObfuscation 끔
  dv.setUint32(0x0e, 0, true); // lKey
  return { wordDocument, table: run(streams.table), data: run(streams.data) };
}
