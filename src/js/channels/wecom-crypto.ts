import crypto from "node:crypto";

type ParsedXml = Record<string, string>;

export function parseXmlFields(xml: string): ParsedXml {
  const out: ParsedXml = {};
  const re = /<([A-Za-z0-9_]+)><!\[CDATA\[([\s\S]*?)\]\]><\/\1>|<([A-Za-z0-9_]+)>([^<]*)<\/\3>/g;
  let m: RegExpExecArray | null = re.exec(xml);
  while (m) {
    if (m[1]) out[m[1]] = m[2] || "";
    else if (m[3]) out[m[3]] = m[4] || "";
    m = re.exec(xml);
  }
  return out;
}

export function buildTextReplyXml(toUser: string, fromUser: string, content: string): string {
  const now = Math.floor(Date.now() / 1000);
  return [
    "<xml>",
    `  <ToUserName><![CDATA[${escapeCdata(toUser)}]]></ToUserName>`,
    `  <FromUserName><![CDATA[${escapeCdata(fromUser)}]]></FromUserName>`,
    `  <CreateTime>${now}</CreateTime>`,
    "  <MsgType><![CDATA[text]]></MsgType>",
    `  <Content><![CDATA[${escapeCdata(content)}]]></Content>`,
    "</xml>"
  ].join("\n");
}

export function computeWecomSignature(
  token: string,
  timestamp: string,
  nonce: string,
  encrypted: string
): string {
  const raw = [token, timestamp, nonce, encrypted].sort().join("");
  return crypto.createHash("sha1").update(raw).digest("hex");
}

export function verifyWecomSignature(
  expected: string,
  token: string,
  timestamp: string,
  nonce: string,
  encrypted: string
): boolean {
  if (!expected) return false;
  const actual = computeWecomSignature(token, timestamp, nonce, encrypted);
  return actual === expected;
}

export function decryptWecomMessage(
  encryptedBase64: string,
  encodingAesKey: string,
  corpId: string
): string {
  const key = decodeAesKey(encodingAesKey);
  const iv = key.subarray(0, 16);
  const decipher = crypto.createDecipheriv("aes-256-cbc", key, iv);
  decipher.setAutoPadding(false);
  const encrypted = Buffer.from(encryptedBase64, "base64");
  const plain = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  const unpadded = pkcs7Unpad(plain);

  const content = unpadded.subarray(16);
  const xmlLength = content.readUInt32BE(0);
  const xmlStart = 4;
  const xmlEnd = xmlStart + xmlLength;
  const xml = content.subarray(xmlStart, xmlEnd).toString("utf8");
  const receiveId = content.subarray(xmlEnd).toString("utf8");
  if (corpId && receiveId !== corpId) {
    throw new Error("wecom_receiveid_mismatch");
  }
  return xml;
}

export function encryptWecomMessage(
  plainXml: string,
  encodingAesKey: string,
  corpId: string
): string {
  const key = decodeAesKey(encodingAesKey);
  const iv = key.subarray(0, 16);
  const random16 = crypto.randomBytes(16);
  const xmlBuf = Buffer.from(plainXml, "utf8");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(xmlBuf.length, 0);
  const corp = Buffer.from(corpId, "utf8");
  const raw = Buffer.concat([random16, len, xmlBuf, corp]);
  const padded = pkcs7Pad(raw);
  const cipher = crypto.createCipheriv("aes-256-cbc", key, iv);
  cipher.setAutoPadding(false);
  const encrypted = Buffer.concat([cipher.update(padded), cipher.final()]);
  return encrypted.toString("base64");
}

export function buildEncryptedReplyXml(
  encrypted: string,
  token: string,
  timestamp: string,
  nonce: string
): string {
  const signature = computeWecomSignature(token, timestamp, nonce, encrypted);
  return [
    "<xml>",
    `  <Encrypt><![CDATA[${encrypted}]]></Encrypt>`,
    `  <MsgSignature><![CDATA[${signature}]]></MsgSignature>`,
    `  <TimeStamp>${timestamp}</TimeStamp>`,
    `  <Nonce><![CDATA[${nonce}]]></Nonce>`,
    "</xml>"
  ].join("\n");
}

function decodeAesKey(encodingAesKey: string): Buffer {
  const base64 = `${encodingAesKey}=`;
  const key = Buffer.from(base64, "base64");
  if (key.length !== 32) {
    throw new Error("invalid_wecom_encoding_aes_key");
  }
  return key;
}

function pkcs7Pad(input: Buffer): Buffer {
  const block = 32;
  let pad = block - (input.length % block);
  if (pad === 0) pad = block;
  return Buffer.concat([input, Buffer.alloc(pad, pad)]);
}

function pkcs7Unpad(input: Buffer): Buffer {
  if (input.length === 0) return input;
  const pad = input[input.length - 1];
  if (pad < 1 || pad > 32) {
    throw new Error("invalid_pkcs7_padding");
  }
  return input.subarray(0, input.length - pad);
}

function escapeCdata(input: string): string {
  return input.replace(/\]\]>/g, "]]]]><![CDATA[>");
}
