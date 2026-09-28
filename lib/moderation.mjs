// Message moderation against messaging-policy.v0.8.json. Checks Terms-of-Service violations
// only, before delivery:
//   - media: no attachments, no image links, no data-URI / markup images
//   - off-platform pressure: links and contact details only after enough messages
//   - rules: unsolicited sexual content (unless both opted in), harassment, threats, scams,
//     plus externally loaded lists (slurs) and per-locale rules
// Result action: allow | block (rejected, sender told why) | hold_for_review (not delivered,
// queued for trust-and-safety). `strike` tells the caller to record a strike on the sender.

const SEVERITY = { allow: 0, block: 1, hold_for_review: 2 };
const LEET = { 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', '@': 'a', $: 's' };
// Zero-width space/non-joiner/joiner, word joiner, BOM, soft hyphen.
const INVISIBLE = new RegExp(
  `[${[0x200b, 0x200c, 0x200d, 0x2060, 0xfeff, 0xad].map((c) => String.fromCodePoint(c)).join('')}]`,
  'g'
);
const compiled = new WeakMap();

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Lower-cases and undoes common evasions (zero-width characters, accents, l33t, s.p.a.c.i.n.g,
// stretched letters) so word rules still match. Used for rule matching only, never stored.
export function normalizeText(text) {
  let s = text.normalize('NFKC').replace(INVISIBLE, '').toLowerCase();
  s = s.normalize('NFD').replace(/\p{M}/gu, '');
  s = s.replace(/[013457@$]/g, (c, i, str) =>
    /[a-z]/.test(str[i - 1] ?? '') || /[a-z]/.test(str[i + 1] ?? '') ? LEET[c] : c
  );
  // Spaced-out words use one repeated separator ("d.i.c.k", "n u d e s"); requiring the same
  // separator keeps "want a d.i.c.k" from swallowing the "a".
  s = s.replace(/\b[a-z]([\s.\-_*])(?:[a-z]\1)+[a-z]\b/g, (m) => m.replace(/[\s.\-_*]/g, ''));
  s = s.replace(/([a-z])\1{2,}/g, '$1');
  return s
    .replace(/[^\p{L}\p{N}'\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function compile(policy) {
  if (compiled.has(policy)) return compiled.get(policy);
  const toRule = (rule) => ({ ...rule, regexes: rule.patterns.map((p) => new RegExp(p, 'u')) });
  const rules = policy.rules.map(toRule);
  for (const [id, list] of Object.entries(policy.external_lists ?? {})) {
    if (!list.terms?.length) continue;
    const pattern = `\\b(${list.terms.map((t) => escapeRegex(normalizeText(t))).join('|')})\\b`;
    rules.push(toRule({ ...list, id, patterns: [pattern] }));
  }
  const localeRules = Object.fromEntries(
    Object.entries(policy.locale_rules ?? {}).map(([locale, rs]) => [locale, rs.map(toRule)])
  );
  const c = {
    rules,
    localeRules,
    url: new RegExp(policy.url_pattern, 'giu'),
    contact: Object.values(policy.contact_patterns).map((p) => new RegExp(p, 'iu')),
    imageExt: new RegExp(`\\.(${policy.media.image_extensions.join('|')})([?#].*)?$`, 'i'),
    imageHosts: policy.media.image_hosts
  };
  compiled.set(policy, c);
  return c;
}

function hostOf(url) {
  const withScheme = /^https?:\/\//i.test(url) ? url : `https://${url}`;
  try {
    return new URL(withScheme).hostname.toLowerCase();
  } catch {
    return '';
  }
}

export function moderateMessage(policy, message, context = {}) {
  const ctx = {
    messages_exchanged: 0,
    explicit_consent: false,
    sender_strikes: 0,
    locale: undefined,
    ...context
  };
  const c = compile(policy);
  const reasons = [];
  const add = (rule, category, action, strike = false) =>
    reasons.push({ rule, category, action, strike });

  if (ctx.sender_strikes >= policy.strikes.suspend_messaging_at) {
    add('sender_suspended', 'enforcement', 'block');
    return finish(reasons);
  }

  const raw = (message.text ?? '').normalize('NFKC');
  const lower = raw.toLowerCase();

  if (message.attachments?.length && !policy.media.attachments) {
    add('attachments_not_allowed', 'media', 'block');
  }
  if (raw.length > policy.max_length) add('too_long', 'format', 'block');
  if (/data:image\//i.test(raw) || /<img\b/i.test(raw) || /!\[[^\]]*\]\(/.test(raw)) {
    add('embedded_image', 'media', 'block');
  }

  const urls = lower.match(c.url) ?? [];
  if (policy.media.block_image_links) {
    const isImage = (u) => {
      const host = hostOf(u);
      const path = u.replace(/^https?:\/\//, '').replace(/^[^/]*/, '');
      return (
        c.imageExt.test(path) || c.imageHosts.some((h) => host === h || host.endsWith(`.${h}`))
      );
    };
    if (urls.some(isImage)) add('image_link', 'media', 'block');
  }
  if (urls.length && ctx.messages_exchanged < policy.links.allowed_after_messages) {
    add('link_too_early', 'off_platform', 'block');
  }
  if (
    ctx.messages_exchanged < policy.contact_info.allowed_after_messages &&
    c.contact.some((re) => re.test(lower))
  ) {
    add('contact_too_early', 'off_platform', 'block');
  }

  const text = normalizeText(raw);
  const rules = [...c.rules, ...(c.localeRules[ctx.locale] ?? [])];
  for (const rule of rules) {
    if (!rule.regexes.some((re) => re.test(text))) continue;
    if (rule.allowed_with_explicit_consent && ctx.explicit_consent) continue;
    const strike =
      Boolean(rule.strike) && !(ctx.explicit_consent && rule.strike_even_with_consent === false);
    add(rule.id, rule.category, rule.action, strike);
  }

  return finish(reasons);
}

function finish(reasons) {
  const action = reasons.reduce(
    (worst, r) => (SEVERITY[r.action] > SEVERITY[worst] ? r.action : worst),
    'allow'
  );
  return {
    action,
    delivered: action === 'allow',
    strike: reasons.some((r) => r.strike),
    reasons
  };
}
