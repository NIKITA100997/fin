import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

// ===================== Парсер банковских уведомлений =====================
// Чистые функции без зависимостей: разбирают текст пуша в структуру.

type Bank = 'sber' | 'tbank' | 'ozon' | 'yandex' | 'mirpay';

interface Parsed {
  bank: Bank;
  dir: 'in' | 'out';
  amount: number;
  merchant: string | null;      // магазин или контрагент
  person: string | null;        // имя отправителя/получателя
  counterpartyBank: string | null;
  last4: string | null;
  number: number | null;        // остаток / доступно из пуша
  numberLabel: 'balance' | 'available' | null;
  when: string | null;          // время операции из текста (ISO), если есть
  hints: string[];              // 'rub_account', 'ozon_debit', 'credit', 'mirpay'
}

const NUM = String.raw`(\d[\d\s\u00a0\u202f]*(?:[.,]\d{1,2})?)`;
const CUR = String.raw`\s*(?:₽|RUB|руб\.?)`;
const money = (s: string) => parseFloat(s.replace(/[\s\u00a0\u202f]/g, '').replace(',', '.'));
const norm = (s: string) => s.toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я0-9]+/g, ' ').trim();

const isBankName = (s: string) => Object.values(BANK_ALIASES).some(list => list.includes(norm(s)));
const bankKeyOf = (s: string) => Object.entries(BANK_ALIASES).find(([, list]) => list.includes(norm(s)))?.[0] ?? null;
const OWN_KEY: Record<string, string> = { sber: 'Сбер', tbank: 'Т-Банк', ozon: 'Озон', yandex: 'Яндекс' };

const BANK_ALIASES: Record<string, string[]> = {
  'Т-Банк': ['т банк', 'тбанк', 'тинькофф', 'tinkoff', 't bank', 'tbank'],
  'Сбер': ['сбербанк', 'сбер', 'sberbank', 'sber'],
  'Озон': ['ozon банк', 'озон банк', 'ozon bank'],
  'Яндекс': ['яндекс', 'яндекс банк', 'yandex', 'яндекс пэй'],
};

/** Банк по названию приложения (MacroDroid присылает имя приложения-отправителя). */
function detectBank(app: string, title: string, body: string): Bank | null {
  const a = norm(app);
  if (/mir ?pay|мир ?pay|мирпэй/.test(a)) return 'mirpay';
  if (/сбер|sber/.test(a)) return 'sber';
  if (/т банк|тбанк|тинькофф|tinkoff|t bank/.test(a)) return 'tbank';
  if (/ozon|озон/.test(a)) return /банк|bank/.test(a) ? 'ozon' : null; // маркетплейс OZON — реклама
  if (/пэй|яндекс|yandex/.test(a)) return 'yandex';
  // запасной вариант — по содержимому
  const all = `${title}\n${body}`;
  if (new RegExp(NUM + CUR + String.raw`\s*[•·∙]{1,4}\s*\d{4}`).test(all)) return 'sber';
  return null;
}

function moscowIso(d: string, mo: string, y: string, h: string, mi: string) {
  return `${y}-${mo}-${d}T${h}:${mi}:00+03:00`;
}

function findWhen(all: string): string | null {
  const m = all.match(/(\d{2})\.(\d{2})\.(\d{4}),?\s+(\d{2}):(\d{2})/);
  return m ? moscowIso(m[1], m[2], m[3], m[4], m[5]) : null;
}

/** Сбер: «— 1,96 ₽ Burger King» / «➕ 100 ₽ по СБП от ИМЯ» + «💳 28 990,04 ₽ •• 9728». */
function parseSber(title: string, body: string): Parsed | null {
  const all = `${title}\n${body}`;
  const m = all.match(new RegExp(String.raw`([—–\-−➖➕+])\s*` + NUM + CUR + String.raw`[ \t]*([^\n]*)`));
  if (!m) return null;
  const dir = /[➕+]/.test(m[1]) ? 'in' : 'out';
  const rest = m[3].trim();
  const card = all.match(new RegExp(NUM + CUR + String.raw`\s*[•·∙.]{1,4}\s*(\d{4})`));
  let person: string | null = null, merchant: string | null = rest || null;
  const from = rest.match(/(?:по\s+СБП\s+)?(?:от|для|получателю)\s+(.+)$/i);
  if (from) { person = from[1].trim(); merchant = null; }
  else if (/^по\s+СБП/i.test(rest)) merchant = null;
  const counterpartyBank = merchant && isBankName(merchant) ? merchant : null;
  return {
    bank: 'sber', dir, amount: money(m[2]), merchant, person, counterpartyBank,
    last4: card ? card[2] : null, number: card ? money(card[1]) : null, numberLabel: card ? 'balance' : null,
    when: null, hints: [],
  };
}

/** Т-Банк, Озон, Яндекс: «Перевод на 100 ₽, счет RUB. Никита Б. Баланс 1 277,27 ₽» и похожие. */
function parseSentence(bank: Bank, title: string, body: string): Parsed | null {
  const all = `${title}. ${body}`;
  const amt = body.match(new RegExp(String.raw`(?:на|Сумма)\s*` + NUM + CUR, 'i')) || all.match(new RegExp(String.raw`(?:на|Сумма)\s*` + NUM + CUR, 'i'));
  if (!amt) return null;
  const low = norm(all);
  const dir: 'in' | 'out' = /пополнение|зачисление|возврат|входящий|поступление/.test(low) && !/списание|покупка|оплата/.test(norm(body).split(' ').slice(0, 3).join(' ')) ? 'in' : 'out';
  const num = all.match(new RegExp(String.raw`(Баланс|Доступно)\s*:?\s*` + NUM + CUR, 'i'));
  const card = all.match(/(?:карт[аеыу]?|card)[^\d\n]{0,12}(\d{4})\b/i) || all.match(/[•*·]{2,}\s*(\d{4})\b/);
  // части предложения после суммы: магазин, имя, банк-отправитель
  const segs = body.split(/\.\s+|\n/).map(s => s.trim().replace(/\.$/, '')).filter(Boolean);
  const idx = segs.findIndex(s => new RegExp(NUM + CUR).test(s) && /на|сумма/i.test(s));
  const tail = segs.slice(idx + 1).filter(s => !/^(баланс|доступно)/i.test(s) && !/^\d{2}\.\d{2}\.\d{4}/.test(s));
  let merchant: string | null = null, person: string | null = null, counterpartyBank: string | null = null;
  const t = title.trim();
  if (t && isBankName(t) && bankKeyOf(t) !== OWN_KEY[bank]) counterpartyBank = t;
  for (const s of tail) {
    if (isBankName(s) && bankKeyOf(s) !== OWN_KEY[bank]) counterpartyBank = counterpartyBank ?? s;
    else if (/^[А-ЯЁA-Z][а-яёa-z]+(\s+[А-ЯЁA-Z][а-яёa-z]+)?\s+[А-ЯЁA-Z]\.?$/.test(s)) person = person ?? s;
    else merchant = merchant ?? s;
  }
  const hints: string[] = [];
  if (/сч[её]т\s+RUB/i.test(body)) hints.push('rub_account');
  if (/кредит/i.test(all)) hints.push('credit');
  if (bank === 'ozon' && num && /баланс/i.test(num[1])) hints.push('ozon_debit');
  return {
    bank, dir, amount: money(amt[1]), merchant, person, counterpartyBank,
    last4: card ? card[1] : null, number: num ? money(num[2]) : null,
    numberLabel: num ? (/баланс/i.test(num[1]) ? 'balance' : 'available') : null,
    when: findWhen(all), hints,
  };
}

/** Mir Pay: «Оплата покупки» / «Сумма 2,50 ₽. 22.10.2026, 06:36. Карта Mir •••• 0979». */
function parseMirPay(title: string, body: string): Parsed | null {
  const p = parseSentence('mirpay', title, body);
  if (!p) return null;
  return { ...p, dir: /возврат/i.test(title + body) ? 'in' : 'out', merchant: null, person: null, hints: [...p.hints, 'mirpay'] };
}

function parseNotification(app: string, title: string, body: string): Parsed | null {
  const bank = detectBank(app, title, body);
  if (!bank) return null;
  if (bank === 'sber') return parseSber(title, body);
  if (bank === 'mirpay') return parseMirPay(title, body);
  return parseSentence(bank, title, body);
}

/** Есть ли в тексте одно из «моих имён» (сравнение без регистра и знаков). */
function mentionsSelf(text: string, ownNames: string[]): boolean {
  const t = ` ${norm(text)} `;
  return ownNames.some(n => n.trim() && t.includes(` ${norm(n)} `));
}


// ===================== Приём уведомлений (Supabase Edge Function) =====================
// MacroDroid отправляет: token, app, title, text — в query-параметрах, JSON или форме.


const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
const DEBT = new Set(['credit_card', 'loan', 'installment']);
const BANK_OF: Record<string, string> = { sber: 'Сбер', tbank: 'Т-Банк', ozon: 'Озон', yandex: 'Яндекс' };
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });

async function readInput(req: Request) {
  const url = new URL(req.url);
  const out: Record<string, string> = Object.fromEntries(url.searchParams.entries());
  if (req.method === 'POST') {
    const ct = req.headers.get('content-type') ?? '';
    const raw = await req.text();
    if (raw) {
      if (ct.includes('json')) { try { Object.assign(out, JSON.parse(raw)); } catch { /* ignore */ } }
      else if (ct.includes('form')) Object.assign(out, Object.fromEntries(new URLSearchParams(raw).entries()));
      else if (!out.text) out.text = raw;
    }
  }
  return { token: out.token ?? '', app: out.app ?? '', title: out.title ?? '', text: out.text ?? '' };
}

const sameBank = (accBank: string, key: string) => bankKeyOf(accBank) === key || norm(accBank) === norm(key);

/** Какому счёту принадлежит операция. */
function resolveAccount(p: Parsed, accounts: any[]) {
  if (p.last4) {
    const a = accounts.find(a => a.last4 === p.last4 || (a.card_aliases ?? []).includes(p.last4));
    if (a) return { account: a, transit: false };
    if (p.bank === 'mirpay' || p.bank === 'sber') return null;
  }
  const key = BANK_OF[p.bank];
  if (!key) return null;
  const inBank = accounts.filter(a => sameBank(a.bank ?? '', key) && a.kind !== 'loan');
  if (p.bank === 'ozon') {
    const credit = inBank.find(a => a.kind === 'credit_card');
    const debit = inBank.find(a => a.kind === 'debit');
    // Дебетовый счёт Озона — транзит: пополнение сразу уходит на кредитку.
    if (p.hints.includes('ozon_debit')) return debit ? { account: debit, transit: false } : credit ? { account: credit, transit: true } : null;
    return credit ? { account: credit, transit: false } : null;
  }
  if (p.hints.includes('credit')) {
    const c = inBank.filter(a => a.kind === 'credit_card');
    if (c.length === 1) return { account: c[0], transit: false };
  }
  const money = inBank.filter(a => a.kind === 'debit');
  if (money.length === 1) return { account: money[0], transit: false };
  if (p.bank === 'yandex') {
    const pay = inBank.find(a => /пэй|pay/i.test(a.name));
    if (pay) return { account: pay, transit: false };
  }
  return null;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok');
  const inp = await readInput(req);
  if (!inp.token) return json({ error: 'no token' }, 401);
  const { data: tok } = await sb.from('ingest_tokens').select('owner_id').eq('token', inp.token).maybeSingle();
  if (!tok) return json({ error: 'bad token' }, 401);
  const owner = tok.owner_id;

  // 1. Дубль самого уведомления (Android иногда присылает его повторно)
  const since = new Date(Date.now() - 5 * 60_000).toISOString();
  const { data: dupRaw } = await sb.from('raw_notifications').select('id')
    .eq('owner_id', owner).eq('app', inp.app).eq('title', inp.title).eq('body', inp.text).gte('received_at', since).limit(1);
  const { data: raw, error: rawErr } = await sb.from('raw_notifications').insert({
    owner_id: owner, app: inp.app, title: inp.title, body: inp.text, status: dupRaw?.length ? 'duplicate' : 'new',
  }).select().single();
  if (rawErr) return json({ error: rawErr.message }, 500);
  if (dupRaw?.length) return json({ status: 'duplicate' });
  const done = (status: string, extra: Record<string, unknown> = {}) =>
    sb.from('raw_notifications').update({ status, ...extra }).eq('id', raw.id).then(() => json({ status, ...extra }));

  // 2. Разбор
  const p = parseNotification(inp.app, inp.title, inp.text);
  if (!p) {
    const looksMoney = /\d[\d\s]*([.,]\d{1,2})?\s*(₽|RUB|руб)/i.test(`${inp.title} ${inp.text}`);
    return done(looksMoney ? 'unparsed' : 'ignored', { reason: looksMoney ? 'формат не распознан' : 'не финансовое' });
  }

  const [{ data: accounts }, { data: settings }] = await Promise.all([
    sb.from('accounts').select('*').eq('owner_id', owner).eq('is_archived', false),
    sb.from('user_settings').select('*').eq('owner_id', owner).maybeSingle(),
  ]);
  const ownNames: string[] = settings?.own_names ?? [];
  const res = resolveAccount(p, accounts ?? []);
  if (!res) return done('unparsed', { parsed: p, reason: 'счёт не найден' });
  const { account, transit } = res;

  // 3. Вид операции
  const self = (p.person && mentionsSelf(p.person, ownNames)) || mentionsSelf(`${inp.title} ${inp.text}`, ownNames);
  const toOwnBank = !!(p.counterpartyBank || (p.merchant && isBankName(p.merchant)));
  let kind: string;
  if (transit || self || (toOwnBank && p.dir === 'out' && p.bank === 'sber')) kind = p.dir === 'in' ? 'transfer_in' : 'transfer_out';
  else kind = p.dir === 'in' ? 'income' : 'purchase';
  const amount = p.dir === 'in' ? p.amount : -p.amount;
  const occurred = p.when ?? new Date().toISOString();

  // 4. Дубль Mir Pay ↔ пуш банка: та же сумма и счёт в пределах часа
  const isMir = p.hints.includes('mirpay');
  const t0 = new Date(new Date(occurred).getTime() - 60 * 60_000).toISOString();
  const t1 = new Date(new Date(occurred).getTime() + 60 * 60_000).toISOString();
  const { data: near } = await sb.from('transactions').select('*')
    .eq('account_id', account.id).eq('amount', amount).eq('source', 'push').gte('occurred_at', t0).lte('occurred_at', t1);
  const twin = (near ?? []).find(t => isMir || /mir ?pay/i.test(t.raw_text ?? '') || t.merchant == null);
  if (twin && (isMir || /mir ?pay/i.test(twin.raw_text ?? ''))) {
    if (!isMir && p.merchant) await sb.from('transactions').update({ merchant: p.merchant, raw_text: `${inp.title}\n${inp.text}` }).eq('id', twin.id);
    await snapshot();
    return done('duplicate', { parsed: p, transaction_id: twin.id, reason: 'уже записано из другого уведомления' });
  }

  // 5. Категория по правилам «магазин → категория» и зарплата
  let category_id: string | null = null, recurring_income_id: string | null = null;
  if (kind === 'purchase' && p.merchant) {
    const { data: rule } = await sb.from('category_rules').select('category_id').eq('owner_id', owner).eq('pattern', p.merchant.toLowerCase()).maybeSingle();
    category_id = rule?.category_id ?? null;
  }
  if (kind === 'income') {
    const { data: incs } = await sb.from('recurring_incomes').select('*').eq('owner_id', owner).eq('is_active', true);
    const day = new Date(occurred).getUTCDate();
    const hit = (incs ?? []).find(i => Math.abs(Number(i.amount) - p.amount) <= Number(i.amount) * 0.2
      && Math.min(Math.abs(i.day_of_month - day), 31 - Math.abs(i.day_of_month - day)) <= 7
      && (!i.account_id || i.account_id === account.id));
    if (hit) {
      recurring_income_id = hit.id;
      const { data: cat } = await sb.from('categories').select('id').eq('owner_id', owner).ilike('name', hit.name).maybeSingle();
      category_id = cat?.id ?? null;
    }
  }

  // 6. Запись операции
  const { data: tx, error: txErr } = await sb.from('transactions').insert({
    account_id: account.id, occurred_at: occurred, amount, kind, merchant: p.merchant ?? p.person,
    category_id, recurring_income_id, source: 'push', raw_text: `${inp.title}\n${inp.text}`, dedup_hash: `push:${raw.id}`,
  }).select().single();
  if (txErr) return done('unparsed', { parsed: p, reason: txErr.message });

  // 7. Склейка переводов между своими счетами (± 10 минут, та же сумма, противоположный знак)
  if (kind.startsWith('transfer') || p.dir === 'in') {
    const w0 = new Date(new Date(occurred).getTime() - 10 * 60_000).toISOString();
    const w1 = new Date(new Date(occurred).getTime() + 10 * 60_000).toISOString();
    const ids = (accounts ?? []).filter(a => a.id !== account.id).map(a => a.id);
    const { data: pairs } = await sb.from('transactions').select('*').in('account_id', ids)
      .eq('amount', -amount).is('link_id', null).gte('occurred_at', w0).lte('occurred_at', w1).limit(5);
    const pair = (pairs ?? []).find(t => kind.startsWith('transfer') || t.kind.startsWith('transfer'));
    if (pair) {
      const link = crypto.randomUUID();
      await sb.from('transactions').update({ link_id: link, kind: amount < 0 ? 'transfer_out' : 'transfer_in', category_id: null }).eq('id', tx.id);
      await sb.from('transactions').update({ link_id: link, kind: amount < 0 ? 'transfer_in' : 'transfer_out', category_id: null }).eq('id', pair.id);
    }
  }

  // 8. Сверка остатка по числу из пуша
  async function snapshot() {
    if (transit || p!.number == null) return;
    const mode = account.push_number === 'auto' ? (DEBT.has(account.kind) ? 'available' : 'balance') : account.push_number;
    let balance: number | null = null;
    if (mode === 'balance') balance = p!.number;
    if (mode === 'available' && account.credit_limit != null) balance = Number(account.credit_limit) - p!.number;
    if (balance != null) await sb.from('balance_snapshots').insert({ account_id: account.id, balance, source: 'push' });
  }
  await snapshot();
  return done('parsed', { parsed: p, transaction_id: tx.id });
});
