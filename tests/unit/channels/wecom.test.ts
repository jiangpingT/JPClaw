/** 迁移自 tests/js/wecom.spec.ts → Vitest 统一框架 */
import { describe, it, expect } from 'vitest';
import {
  computeWecomSignature,
  decryptWecomMessage,
  encryptWecomMessage,
  parseXmlFields
} from "../../src/js/channels/wecom-crypto.js";

describe('wecom', () => {
  it("should computeWecomSignature returns deterministic sha1", () => {
    const sig = computeWecomSignature("tkn", "1700000000", "abc123", "encrypted-body");
    expect(sig.length).toBe(40);
    expect(sig).toBe(computeWecomSignature("tkn", "1700000000", "abc123", "encrypted-body"));
  });

  it("should encrypt/decrypt roundtrip", () => {
    const aesKey = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";
    const corpId = "ww8957798d479feaf4";
    const plain = "<xml><ToUserName><![CDATA[user]]></ToUserName><Content><![CDATA[hi]]></Content></xml>";
    const encrypted = encryptWecomMessage(plain, aesKey, corpId);
    const decrypted = decryptWecomMessage(encrypted, aesKey, corpId);
    expect(decrypted).toBe(plain);
  });

  it("should parseXmlFields extracts cdata and plain tags", () => {
    const xml = [
      "<xml>",
      "<MsgType><![CDATA[text]]></MsgType>",
      "<FromUserName><![CDATA[user_a]]></FromUserName>",
      "<CreateTime>1700000000</CreateTime>",
      "</xml>"
    ].join("");
    const out = parseXmlFields(xml);
    expect(out.MsgType).toBe("text");
    expect(out.FromUserName).toBe("user_a");
    expect(out.CreateTime).toBe("1700000000");
  });
});
