/**
 * WuKongIM 协议原生客户端
 *
 * 每个实例持有独立的 WebSocket 连接，彻底绕开 wukongimjssdk 的单例设计。
 * 支持多 bot 并发，每个 bot 独立维护 DH 密钥交换 + AES-128-CBC 会话。
 *
 * 协议格式从 wukongimjssdk ESM 源码逆向提取。
 */

import { WebSocket } from "ws";
import { randomBytes } from "node:crypto";
import { Buffer } from "node:buffer";
import { generateKeyPair, sharedKey } from "curve25519-js";
import CryptoJS from "crypto-js";
import { Md5 } from "md5-typescript";

// ─── 协议常量 ────────────────────────────────────────────────────────────────

const enum PktType {
  CONNECT    = 1,
  CONNACK    = 2,
  SEND       = 3,
  SENDACK    = 4,
  RECV       = 5,
  RECVACK    = 6,
  PING       = 7,
  PONG       = 8,
  DISCONNECT = 9,
}

const PROTOCOL_VERSION  = 5;      // SDK 默认 protoVersion = 5
const HEARTBEAT_MS      = 15_000; // PING 间隔：15s（原 30s，更积极保活）
const PONG_TIMEOUT_MS   = 10_000; // PONG 等待超时：10s 无响应则主动重连
const RECONNECT_BASE_MS = 5_000;
const RECONNECT_MAX_MS  = 60_000;

// ─── 公开类型 ─────────────────────────────────────────────────────────────────

export interface WKMessage {
  messageID:   string;
  messageSeq:  number;
  fromUID:     string;
  channelID:   string;
  channelType: number;
  timestamp:   number;
  /** 解密后的原始 payload 字节 */
  payload:     Uint8Array;
  /** 文本内容（contentObj.content 或 conversationDigest） */
  text:        string;
}

export interface WKClientOptions {
  wsUrl:    string;
  uid:      string;    // im_token 对应的 robotId
  token:    string;    // im_token
  deviceFlag?: number; // 默认 0 (APP)
  onMessage?:      (msg: WKMessage) => void;
  onConnected?:    () => void;
  onDisconnected?: () => void;
  onError?:        (err: Error) => void;
}

// ─── 二进制编解码 ─────────────────────────────────────────────────────────────

class Encoder {
  private buf: number[] = [];

  writeUint8(b: number): void { this.buf.push(b & 0xff); }

  writeInt16(v: number): void {
    this.buf.push((v >> 8) & 0xff, v & 0xff);
  }

  writeInt32(v: number): void {
    this.buf.push((v >> 24) & 0xff, (v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff);
  }

  writeInt64(v: bigint): void {
    const hi = Number(v >> 32n) & 0xffffffff;
    const lo = Number(v & 0xffffffffn);
    this.writeInt32(hi);
    this.writeInt32(lo);
  }

  writeString(s: string): void {
    const bytes = strToBytes(s);
    this.writeInt16(bytes.length);
    this.buf.push(...bytes);
  }

  writeBytes(b: number[] | Uint8Array): void {
    for (const byte of b) this.buf.push(byte);
  }

  /** MQTT 可变长度编码 */
  writeVarLen(len: number): void {
    do {
      let digit = len % 0x80;
      len = Math.floor(len / 0x80);
      if (len > 0) digit |= 0x80;
      this.buf.push(digit);
    } while (len > 0);
  }

  toUint8Array(): Uint8Array { return Uint8Array.from(this.buf); }
}

class Decoder {
  private offset = 0;
  constructor(private data: Uint8Array) {}

  readByte(): number { return this.data[this.offset++]; }

  readInt16(): number { return (this.readByte() << 8) | this.readByte(); }

  readInt32(): number {
    const b = [this.readByte(), this.readByte(), this.readByte(), this.readByte()];
    return ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0;
  }

  readInt64(): bigint {
    const hi = BigInt(this.readInt32());
    const lo = BigInt(this.readInt32());
    return (hi << 32n) | lo;
  }

  readString(): string {
    const len = this.readInt16();
    const bytes = this.data.slice(this.offset, this.offset + len);
    this.offset += len;
    return bytesToStr(bytes);
  }

  /** MQTT 可变长度解码 */
  readVarLen(): number {
    let mul = 0, val = 0;
    while (mul < 27) {
      const b = this.readByte();
      val |= (b & 0x7f) << mul;
      if ((b & 0x80) === 0) break;
      mul += 7;
    }
    return val;
  }

  readRemaining(): Uint8Array { return this.data.slice(this.offset); }
  get remaining(): number { return this.data.length - this.offset; }
}

// ─── 字符串 ↔ 字节工具（UTF-8 via unescape/encodeURIComponent，与 SDK 一致）

function strToBytes(s: string): number[] {
  const utf8 = unescape(encodeURIComponent(s));
  return Array.from(utf8).map(c => c.charCodeAt(0));
}

function bytesToStr(b: Uint8Array): string {
  try {
    return decodeURIComponent(escape(String.fromCharCode(...b)));
  } catch {
    return Buffer.from(b).toString("utf8");
  }
}

// ─── UUID 生成 ───────────────────────────────────────────────────────────────

function makeDeviceId(): string {
  return randomBytes(16).toString("hex") + "W";
}

function makeSeed(): Uint8Array {
  // 32 字节随机种子（对标 SDK 的 guid.toString().replace(/-/g,'')）
  return randomBytes(32);
}

// ─── 帧打包 / 拆包 ───────────────────────────────────────────────────────────

function encodeFrame(pktType: number, body: number[]): Uint8Array {
  const enc = new Encoder();
  if (pktType === PktType.PING || pktType === PktType.PONG) {
    enc.writeUint8(pktType << 4);
    return enc.toUint8Array();
  }
  enc.writeUint8(pktType << 4);
  enc.writeVarLen(body.length);
  enc.writeBytes(body);
  return enc.toUint8Array();
}

interface FrameHeader { pktType: number; remainingLen: number; headerLen: number; hasServerVersion: boolean }

function decodeFrameHeader(data: Uint8Array): FrameHeader | null {
  if (data.length < 1) return null;
  const b0 = data[0];
  const pktType = b0 >> 4;
  const hasServerVersion = (b0 & 0x01) > 0;

  if (pktType === PktType.PING || pktType === PktType.PONG) {
    return { pktType, remainingLen: 0, headerLen: 1, hasServerVersion: false };
  }

  let mul = 0, remainingLen = 0, i = 1;
  while (i < data.length && mul < 27) {
    const b = data[i++];
    remainingLen |= (b & 0x7f) << mul;
    if ((b & 0x80) === 0) break;
    mul += 7;
  }
  if (i >= data.length && data[data.length - 1] & 0x80) return null; // 不完整
  return { pktType, remainingLen, headerLen: i, hasServerVersion };
}

// ─── 消息内容解析 ────────────────────────────────────────────────────────────

function parseMessageText(payload: Uint8Array): string {
  try {
    const obj = JSON.parse(bytesToStr(payload));
    // contentObj.content → conversationDigest → 整体 toString
    return (obj?.content ?? obj?.conversationDigest ?? bytesToStr(payload)).trim();
  } catch {
    return bytesToStr(payload).trim();
  }
}

// ─── AES-128-CBC 工具 ────────────────────────────────────────────────────────

class AesCipher {
  constructor(private key: string, private iv: string) {}

  decrypt(data: Uint8Array): Uint8Array {
    // payload 在 WuKongIM RECV 帧中是 base64 字符串（ASCII bytes），直接解释为 string
    const b64 = Buffer.from(data).toString("ascii");
    const dec = CryptoJS.AES.decrypt(b64, CryptoJS.enc.Utf8.parse(this.key), {
      keySize: 128 / 8,
      iv:      CryptoJS.enc.Utf8.parse(this.iv),
      mode:    CryptoJS.mode.CBC,
      padding: CryptoJS.pad.Pkcs7,
    });
    // 用 Hex 转换避免非 UTF-8 字节丢失
    const hex = dec.toString(CryptoJS.enc.Hex);
    return Uint8Array.from(Buffer.from(hex, "hex"));
  }

  encrypt(text: string): string {
    const enc = CryptoJS.AES.encrypt(
      CryptoJS.enc.Utf8.parse(text),
      CryptoJS.enc.Utf8.parse(this.key),
      {
        keySize: 128 / 8,
        iv:      CryptoJS.enc.Utf8.parse(this.iv),
        mode:    CryptoJS.mode.CBC,
        padding: CryptoJS.pad.Pkcs7,
      }
    );
    return enc.toString(); // Base64
  }
}

// ─── 主客户端 ─────────────────────────────────────────────────────────────────

export class WuKongIMClient {
  private ws: WebSocket | null = null;
  private aes: AesCipher | null = null;
  private dhPrivate: Uint8Array | null = null;
  private serverVersion = 0;
  private connected = false;
  private stopped = false;
  private reconnectDelay = RECONNECT_BASE_MS;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private pongTimeoutTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** 接收缓冲区（处理 TCP 粘包） */
  private recvBuf: Buffer = Buffer.alloc(0);

  constructor(private opts: WKClientOptions) {}

  connect(): void {
    this.stopped = false;
    this._connect();
  }

  disconnect(): void {
    this.stopped = true;
    this._clearTimers();
    this.ws?.close();
    this.ws = null;
    this.connected = false;
  }

  isConnected(): boolean { return this.connected; }

  // ── 内部连接 ───────────────────────────────────────────────────────────────

  private _connect(): void {
    this._clearTimers();
    this.recvBuf = Buffer.alloc(0);

    // 生成本次连接的 DH 密钥对
    const seed = makeSeed();
    const kp = generateKeyPair(seed);
    this.dhPrivate = kp.private;
    const clientKey = Buffer.from(kp.public).toString("base64");

    try {
      this.ws = new WebSocket(this.opts.wsUrl);
      this.ws.binaryType = "nodebuffer";
    } catch (err) {
      this._scheduleReconnect();
      return;
    }

    this.ws.on("open", () => {
      this._sendConnect(clientKey);
    });

    this.ws.on("message", (data: Buffer) => {
      this.recvBuf = Buffer.concat([this.recvBuf, data]);
      this._processBuffer();
    });

    this.ws.on("close", () => {
      this._clearTimers();
      this.connected = false;
      if (!this.stopped) {
        this.opts.onDisconnected?.();
        this._scheduleReconnect();
      }
    });

    this.ws.on("error", (err) => {
      this.opts.onError?.(err);
    });
  }

  private _sendConnect(clientKey: string): void {
    const enc = new Encoder();
    enc.writeUint8(PROTOCOL_VERSION);                    // version
    enc.writeUint8(this.opts.deviceFlag ?? 0);           // deviceFlag: 0=APP
    enc.writeString(makeDeviceId());                     // deviceID
    enc.writeString(this.opts.uid);                      // uid
    enc.writeString(this.opts.token);                    // token
    enc.writeInt64(BigInt(Date.now()));                  // clientTimestamp
    enc.writeString(clientKey);                          // DH 公钥

    const body = Array.from(enc.toUint8Array());
    this._send(encodeFrame(PktType.CONNECT, body));
  }

  private _handleConnack(dec: Decoder, hasServerVersion: boolean): void {
    if (hasServerVersion) this.serverVersion = dec.readByte();
    const _timeDiff = dec.readInt64();   // 忽略时间差
    const reasonCode = dec.readByte();

    // WuKongIM 协议：reasonCode=1 表示成功（非 MQTT 的 0=成功约定）
    if (reasonCode !== 1) {
      this.opts.onError?.(new Error(`WuKongIM CONNACK failed: reasonCode=${reasonCode}`));
      return;
    }

    const serverKey = dec.readString();
    const salt      = dec.readString();

    // DH 共享密钥 → AES-128-CBC
    const serverPub = Uint8Array.from(Buffer.from(serverKey, "base64"));
    const secret    = sharedKey(this.dhPrivate!, serverPub);
    const secretB64 = Buffer.from(secret).toString("base64");
    const aesKeyFull = Md5.init(secretB64);
    const aesKey = aesKeyFull.substring(0, 16);
    const aesIV  = salt.length > 16 ? salt.substring(0, 16) : salt;

    this.aes = new AesCipher(aesKey, aesIV);
    this.connected = true;
    this.reconnectDelay = RECONNECT_BASE_MS;

    this._startHeartbeat();
    this.opts.onConnected?.();
  }

  private _handleRecv(dec: Decoder): void {
    const _setting = dec.readByte();      // Setting 字节（暂不用）
    const _msgKey  = dec.readString();    // 签名（暂不验证）
    const fromUID  = dec.readString();
    const channelID   = dec.readString();
    const channelType = dec.readByte();

    if (this.serverVersion >= 3) dec.readInt32(); // expire

    const clientMsgNo = dec.readString();
    const messageID   = dec.readInt64().toString();
    const messageSeq  = dec.readInt32();
    const timestamp   = dec.readInt32();

    // topic（setting bit 3）
    if ((_setting >> 3) & 0x01) dec.readString();

    const rawPayload = dec.readRemaining();

    // 解密 payload
    let payload = rawPayload;
    if (this.aes && rawPayload.length > 0) {
      try { payload = this.aes.decrypt(rawPayload); } catch { /* 解密失败，用原始 */ }
    }

    const text = parseMessageText(payload);

    // 发送 RECVACK
    this._sendRecvack(messageID, messageSeq);

    if (!fromUID) return;
    this.opts.onMessage?.({ messageID, messageSeq, fromUID, channelID, channelType, timestamp, payload, text });

    void clientMsgNo; // suppress unused warning
  }

  private _sendRecvack(messageID: string, messageSeq: number): void {
    const enc = new Encoder();
    enc.writeInt64(BigInt(messageID));
    enc.writeInt32(messageSeq);
    this._send(encodeFrame(PktType.RECVACK, Array.from(enc.toUint8Array())));
  }

  // ── TCP 粘包处理 ───────────────────────────────────────────────────────────

  private _processBuffer(): void {
    while (this.recvBuf.length > 0) {
      const header = decodeFrameHeader(Uint8Array.from(this.recvBuf));
      if (!header) break;

      const totalLen = header.headerLen + header.remainingLen;
      if (this.recvBuf.length < totalLen) break; // 等待更多数据

      const bodyData = Uint8Array.from(this.recvBuf.slice(header.headerLen, totalLen));
      this.recvBuf = this.recvBuf.slice(totalLen);

      this._handlePacket(header.pktType, header.hasServerVersion, bodyData);
    }
  }

  private _handlePacket(pktType: number, hasServerVersion: boolean, body: Uint8Array): void {
    switch (pktType) {
      case PktType.CONNACK: {
        const dec = new Decoder(body);
        this._handleConnack(dec, hasServerVersion);
        break;
      }
      case PktType.RECV: {
        const dec = new Decoder(body);
        this._handleRecv(dec);
        break;
      }
      case PktType.PONG:
        // 收到 PONG，连接正常，取消超时定时器
        if (this.pongTimeoutTimer) {
          clearTimeout(this.pongTimeoutTimer);
          this.pongTimeoutTimer = null;
        }
        break;
      case PktType.DISCONNECT:
        this.ws?.close();
        break;
    }
  }

  // ── 发送 / 心跳 / 重连 ────────────────────────────────────────────────────

  private _send(data: Uint8Array): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(data);
    }
  }

  private _startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      this._send(encodeFrame(PktType.PING, []));
      // PONG 超时检测：发出 PING 后启动定时器，10s 内无 PONG 则主动重连
      this.pongTimeoutTimer = setTimeout(() => {
        if (this.connected && !this.stopped) {
          this.opts.onError?.(new Error("WuKongIM PONG timeout, reconnecting"));
          this.ws?.close();
        }
      }, PONG_TIMEOUT_MS);
    }, HEARTBEAT_MS);
  }

  private _scheduleReconnect(): void {
    this.reconnectTimer = setTimeout(() => {
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX_MS);
      this._connect();
    }, this.reconnectDelay);
  }

  private _clearTimers(): void {
    if (this.heartbeatTimer)  { clearInterval(this.heartbeatTimer);  this.heartbeatTimer = null; }
    if (this.pongTimeoutTimer){ clearTimeout(this.pongTimeoutTimer); this.pongTimeoutTimer = null; }
    if (this.reconnectTimer)  { clearTimeout(this.reconnectTimer);   this.reconnectTimer = null; }
  }
}
