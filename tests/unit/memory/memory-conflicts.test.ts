/** 迁移自 tests/js/memory-conflicts.spec.ts → Vitest 统一框架 */
import { describe, it, expect } from 'vitest';
import { detectFactConflicts } from "../../src/js/memory/conflicts.js";

describe('memory-conflicts', () => {
  it("should detectFactConflicts finds conflicting fact values by key", () => {
    const existing = ["用户姓名/称呼: 张三", "用户语言偏好: 中文"];
    const incoming = ["用户姓名/称呼: 李四", "用户位置: 北京"];
    const conflicts = detectFactConflicts(existing, incoming);
    expect(conflicts.length).toBe(1);
    expect(conflicts[0].key).toBe("用户姓名/称呼");
    expect(conflicts[0].prev).toBe("张三");
    expect(conflicts[0].next).toBe("李四");
  });
});
