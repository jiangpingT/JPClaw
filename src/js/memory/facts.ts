export function extractFacts(input: string): string[] {
  const text = input.trim();
  if (!text) return [];
  const facts: string[] = [];
  const patterns: Array<[RegExp, string]> = [
    [/我叫([^\s，。,.!?！？]{1,20})/i, "用户姓名/称呼: $1"],
    [/叫我([^\s，。,.!?！？]{1,20})/i, "用户偏好称呼: $1"],
    [/我是([^\s，。,.!?！？]{1,30})/i, "用户身份: $1"],
    [/请用([^\n]{1,20})回复/i, "用户回复风格偏好: $1"],
    [/以后.*称呼我([^\s，。,.!?！？]{1,20})/i, "用户偏好称呼: $1"],
    [/我在([^\s，。,.!?！？]{1,30})/i, "用户位置: $1"],
    [/以后回答.*用([^\n]{1,30})/i, "用户回答格式要求: $1"],
    [/你以后回答我.*(中文)/i, "用户语言偏好: $1"],
    [/我叫([^，。,.!?！？\n]{1,20})，?你叫([^，。,.!?！？\n]{1,20})/i, "用户命名约定: 用户=$1, 助手=$2"]
  ];
  for (const [regex, template] of patterns) {
    const match = text.match(regex);
    if (match) {
      const first = match[1] || "";
      const second = match[2] || "";
      if (template.startsWith("用户身份")) {
        if (/^(谁|什么|哪|哪位|哪个|谁啊|谁呀)/.test(first)) continue;
      }
      facts.push(template.replace("$1", first).replace("$2", second));
    }
  }
  if (text.includes("明略")) facts.push("用户高度关注明略科技相关问题");
  return facts;
}

