/**
 * Text that may end up printed on a picture (selling points, template text slots) must never carry traffic-diversion
 * content: URLs, domains, invite codes, social/contact handles, phone numbers, QR prompts. Returns a user-safe reason or null.
 */
const RULES: [RegExp, string][] = [
  [/(?:https?:|ftp:|www\.|:\/\/)/i, '网址'],
  [/[a-z0-9-]+\.(?:com|cn|net|org|xyz|top|vip|shop|store|io|cc|me|co|info|site|link|club|app)\b/i, '网址'],
  [/(?:微信|威信|薇信|v信|vx|wx|weixin|wechat|qq|扣扣|企鹅号|抖音号|小红书号|tg|telegram|whatsapp|line\s*id)/i, '联系方式'],
  [/(?:加我|私信|私聊|私我|主页|戳我|联系客服|找客服|加群|进群|扫码|二维码|邀请码|推荐码|口令|暗号)/i, '引流信息'],
  [/(?:\d[\s-]?){7,}/, '电话或号码'],
];

export function promoTextViolation(s: string): string | null {
  const t = s.normalize('NFKC');
  for (const [re, what] of RULES) if (re.test(t)) return what;
  return null;
}

/** Plain short text for slots: no control chars, quotes or template braces. */
export const cleanSlot = (s: string, max: number) =>
  s.normalize('NFKC').replace(/[\u0000-\u001f\u007f"{}<>\\`]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
