import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';
import * as E from './engine.js';
import { pdfLines, parseStatement, rowKind, BANK_CATEGORY_MAP } from './statement.js';

const CFG = window.FIN_CONFIG || {};
const configured = CFG.url && !CFG.url.includes('YOUR-PROJECT') && CFG.key && !CFG.key.includes('YOUR-');
const sb = configured ? createClient(CFG.url, CFG.key) : null;

const $app = document.getElementById('app');
const $tabs = document.getElementById('tabs');
const $dlg = document.getElementById('dlg');

const TODAY = E.todayISO();
const HORIZON = E.monthDay(TODAY, 4, 31);

let USER = null;   // текущий пользователь
let RAW = null;    // строки из БД
let STATE = null;  // вход движка
let CAL = [];      // календарь

const DEBT_KINDS = new Set(['credit_card', 'loan', 'installment']);
const MONEY_KINDS = { debit: 'Карта или счёт', cash: 'Наличные', savings: 'Накопления', brokerage: 'Инвестиции' };

// ---------------------------------------------------------------- утилиты
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = s => { const v = parseFloat(String(s ?? '').replace(/\s|\u00a0/g, '').replace(',', '.')); return Number.isFinite(v) ? v : null; };
const plural = (n, a, b, c) => { const m = n % 10, h = n % 100; return m === 1 && h !== 11 ? a : m >= 2 && m <= 4 && (h < 10 || h >= 20) ? b : c; };
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
const pct = v => `${Number(v).toFixed(1).replace('.', ',')}%`;
const inDays = d => { const n = E.diffDays(TODAY, d); return n === 0 ? 'сегодня' : n === 1 ? 'завтра' : n < 0 ? `${-n} ${plural(-n, 'день', 'дня', 'дней')} назад` : `через ${n} ${plural(n, 'день', 'дня', 'дней')}`; };
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random());
const accLabel = a => a.kind === 'credit_card' ? `${a.bank}, кредитка` : a.kind === 'loan' ? `Кредит ${a.bank}` : a.name;

function toast(text) {
  const t = document.createElement('div');
  t.className = 'toast'; t.textContent = text; t.setAttribute('role', 'status');
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2200);
}

/**
 * Модальная форма. Поля: { name, label, type: 'money'|'text'|'date'|'select', value, options, list, required }.
 * actions — дополнительные кнопки: [{ value, label }]; результат { $action: value }.
 */
function form({ title, text, html, fields = [], submit = 'Сохранить', actions = [] }) {
  const input = f => {
    const req = f.required === false ? '' : 'required';
    if (f.type === 'select') return `<select name="${f.name}" ${req}>${f.options.map(o =>
      `<option value="${esc(o.value)}" ${String(o.value) === String(f.value ?? '') ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}</select>`;
    if (f.type === 'date') return `<input name="${f.name}" type="date" value="${esc(f.value ?? '')}" ${req}>`;
    if (f.type === 'text') return `<input name="${f.name}" type="text" value="${esc(f.value ?? '')}" ${f.list ? `list="dl-${f.name}"` : ''} ${req}>
      ${f.list ? `<datalist id="dl-${f.name}">${f.list.map(v => `<option value="${esc(v)}">`).join('')}</datalist>` : ''}`;
    return `<input name="${f.name}" type="text" inputmode="decimal" value="${esc(f.value ?? '')}" ${req}>`;
  };
  $dlg.innerHTML = `
    <form method="dialog">
      <h2>${esc(title)}</h2>
      ${text ? `<p class="muted small" style="margin:0">${esc(text)}</p>` : ''}
      ${html || ''}
      ${fields.map(f => `<label class="field">${esc(f.label)}${input(f)}</label>`).join('')}
      <div class="btns">
        ${submit ? `<button class="btn" value="ok">${esc(submit)}</button>` : ''}
        ${actions.map(a => `<button class="btn ghost" value="act:${a.value}" formnovalidate>${esc(a.label)}</button>`).join('')}
        <button class="btn ghost" value="cancel" formnovalidate>Отмена</button>
      </div>
    </form>`;
  $dlg.showModal();
  return new Promise(resolve => {
    $dlg.addEventListener('close', () => {
      const v = $dlg.returnValue;
      if (v === 'cancel' || !v) return resolve(null);
      if (v.startsWith('act:')) return resolve({ $action: v.slice(4) });
      resolve(Object.fromEntries(new FormData($dlg.querySelector('form')).entries()));
    }, { once: true });
  });
}

async function mutate(promise, done = 'Сохранено') {
  const { error } = await promise;
  if (error) { toast(`Не сохранилось: ${error.message}`); return false; }
  await load(); route(); toast(done); return true;
}

// ---------------------------------------------------------------- данные
async function load() {
  const all = await Promise.all([
    sb.from('accounts').select('*').eq('is_archived', false).order('created_at'),
    sb.from('balance_snapshots').select('*').order('at', { ascending: false }),
    sb.from('card_terms').select('*'),
    sb.from('grace_buckets').select('*').eq('status', 'open').order('due_date'),
    sb.from('loans').select('*'),
    sb.from('installment_plans').select('*'),
    sb.from('transactions').select('*').order('occurred_at', { ascending: false }).range(0, 1999),
    sb.from('categories').select('*').order('name'),
    sb.from('goals').select('*').order('created_at'),
    sb.from('wishlist_items').select('*').is('bought_at', null).order('priority'),
    sb.from('recurring_incomes').select('*').eq('is_active', true).order('day_of_month'),
    sb.from('budget_limits').select('*').order('sort'),
    sb.from('budget_moves').select('*'),
    sb.from('planned_events').select('*').order('date'),
    sb.from('event_items').select('*').order('created_at'),
    sb.from('budget_limit_changes').select('*').order('month'),
    sb.from('user_settings').select('*'),
    sb.from('raw_notifications').select('*').eq('status', 'unparsed').order('received_at', { ascending: false }).limit(50),
    sb.from('ingest_tokens').select('*').order('created_at', { ascending: false }),
    sb.from('category_rules').select('*'),
  ]);
  const err = all.find(r => r.error);
  if (err) throw err.error;
  const [accounts, snaps, terms, buckets, loans, plans, txs, categories, goals, wishlist, incomes, limits, moves, events, eventItems, limitChanges, settingsRows, unparsed, tokens, categoryRules] = all.map(r => r.data);

  const acc = new Map(accounts.map(a => [a.id, a]));
  const latest = new Map();
  for (const s of snaps) if (!latest.has(s.account_id)) latest.set(s.account_id, s);

  // Баланс = последний снимок + операции, внесённые после него.
  // Для долговых счетов расход увеличивает долг, погашение — уменьшает.
  const balance = new Map();
  for (const a of accounts) {
    const s = latest.get(a.id);
    let v = Number(s?.balance ?? 0);
    for (const t of txs) {
      if (t.account_id !== a.id) continue;
      if (s && t.created_at <= s.at) continue;
      v += DEBT_KINDS.has(a.kind) ? -Number(t.amount) : Number(t.amount);
    }
    balance.set(a.id, v);
  }
  const bal = id => balance.get(id) ?? 0;

  RAW = { accounts, acc, latest, bal, terms, buckets, loans, plans, txs, categories, goals, wishlist, incomes, limits, moves, events, eventItems, limitChanges, settings: settingsRows[0] ?? null, unparsed, tokens, categoryRules };

  STATE = {
    cards: terms.filter(t => acc.has(t.account_id)).map(t => {
      const a = acc.get(t.account_id);
      return {
        id: a.id, name: a.bank, limit: Number(a.credit_limit ?? 0), debt: bal(a.id), rate: Number(t.rate_purchase),
        terms: {
          graceType: t.grace_type, statementDay: t.statement_day ?? 31, payWindowDays: t.pay_window_days,
          minDueRule: t.grace_type === 'monthly_cohort' ? 'next_report' : 'window',
          minPct: Number(t.min_pct), minFloor: Number(t.min_floor), minRoundTo: Number(t.min_round_to || 1),
        },
        buckets: buckets.filter(b => b.account_id === a.id).map(b => ({
          id: b.id, due: b.due_date, amount: Number(b.amount) - Number(b.paid_amount), exact: b.is_exact,
        })),
      };
    }),
    loans: loans.filter(l => acc.has(l.account_id)).map(l => {
      const a = acc.get(l.account_id);
      let next = l.next_payment_date, rem = l.remaining_payments ?? 0;
      while (next && next < TODAY && rem > 0) { next = E.monthDay(next, 1, l.payment_day); rem--; }
      return {
        id: a.id, name: `Кредит ${a.bank}`, balance: bal(a.id), payment: Number(l.payment_amount),
        payDay: l.payment_day, nextDate: next, remaining: rem,
        rateAnnual: l.rate_annual == null ? null : Number(l.rate_annual),
      };
    }),
    installments: plans.filter(p => acc.has(p.account_id)).map(p => {
      const a = acc.get(p.account_id);
      let next = p.next_payment_date;
      while (next && next < TODAY) next = E.addDays(next, p.period_days);
      return {
        id: a.id, name: a.name, limit: Number(a.credit_limit ?? 0), debt: bal(a.id),
        nextDate: next, nextAmount: Number(p.next_payment_amount ?? 0), periodDays: p.period_days,
        fundingAccount: a.autodebit_account_id ? acc.get(a.autodebit_account_id)?.name : null,
      };
    }),
  };
  CAL = E.buildCalendar(STATE, TODAY, HORIZON);
}

const moneyAccounts = () => RAW.accounts.filter(a => a.kind in MONEY_KINDS);
const assetsTotal = () => moneyAccounts().reduce((s, a) => s + RAW.bal(a.id), 0);
const debtsTotal = () => RAW.accounts.filter(a => DEBT_KINDS.has(a.kind)).reduce((s, a) => s + RAW.bal(a.id), 0);

const liquidTotal = () => RAW.accounts.filter(a => a.kind === 'debit' || a.kind === 'cash').reduce((s, a) => s + RAW.bal(a.id), 0);

/** Ожидаемые поступления: плановые даты, по которым ещё не записан факт (±7 дней). */
function pendingIncomes(horizon = HORIZON) {
  const from = E.addDays(TODAY, -10);
  const out = [];
  for (const inc of RAW.incomes) {
    for (const date of E.incomeDates({ day: inc.day_of_month, shiftWeekend: inc.shift_weekend }, from, horizon)) {
      const got = RAW.txs.some(t => t.recurring_income_id === inc.id && Math.abs(E.diffDays(t.occurred_at.slice(0, 10), date)) <= 7);
      if (got) continue;
      if (date < TODAY && E.diffDays(date, TODAY) > 7) continue;
      out.push({ id: inc.id, date, amount: Number(inc.amount), name: inc.name, late: date < TODAY });
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

/** Прогноз свободных денег (карты и наличные) с учётом плановых доходов и платежей. */
function forecast() {
  let bal = liquidTotal();
  const ev = [
    ...pendingIncomes().map(i => ({ date: i.date < TODAY ? TODAY : i.date, delta: i.amount, inc: 1 })),
    ...CAL.filter(o => o.counts && o.date >= TODAY).map(o => ({ date: o.date, delta: -o.amount, inc: 0 })),
  ].sort((a, b) => a.date.localeCompare(b.date) || b.inc - a.inc);
  let min = { value: bal, date: TODAY };
  const byDate = new Map();
  for (const e of ev) {
    bal += e.delta;
    byDate.set(e.date, bal);
    if (bal < min.value) min = { value: bal, date: e.date };
  }
  return { min, end: bal, byDate, start: liquidTotal() };
}

const monthTotals = ym => {
  let inc = 0, exp = 0;
  for (const t of RAW.txs) {
    if (t.link_id || t.kind?.startsWith('transfer') || t.occurred_at.slice(0, 7) !== ym) continue;
    if (t.amount > 0) inc += Number(t.amount); else exp -= Number(t.amount);
  }
  return { inc, exp };
};

const staleNote = id => {
  const s = RAW.latest.get(id);
  if (!s) return 'остаток не указан';
  const d = E.diffDays(s.at.slice(0, 10), TODAY);
  return d === 0 ? 'сверено сегодня' : `сверено ${d} ${plural(d, 'день', 'дня', 'дней')} назад`;
};

// ---------------------------------------------------------------- навигация
const ICONS = {
  overview: '<path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
  money: '<path d="M3 7h15a3 3 0 0 1 3 3v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M3 7l12-4v4"/><circle cx="16.5" cy="14" r="1.2"/>',
  debts: '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20"/>',
  plan: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
};
const TABS = [['overview', 'Обзор'], ['money', 'Деньги'], ['debts', 'Долги'], ['plan', 'План'], ['calendar', 'Календарь']];
const ALIAS = { cards: 'debts', loan: 'debts', goals: 'plan', budget: 'plan' };

function renderTabs(current) {
  $tabs.hidden = false;
  $tabs.innerHTML = `<div>${TABS.map(([id, label]) => `
    <a href="#${id}" ${id === current ? 'aria-current="page"' : ''}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[id]}</svg>
      ${label}</a>`).join('')}</div>`;
}

function route() {
  let id = (location.hash || '#overview').slice(1);
  id = ALIAS[id] || id;
  const views = { overview: viewOverview, money: viewMoney, debts: viewDebts, plan: viewPlan, calendar: viewCalendar };
  if (!views[id]) id = 'overview';
  renderTabs(id);
  $app.innerHTML = views[id]();
}

// ---------------------------------------------------------------- общие блоки
function obligationRow(o, { strip = '' } = {}) {
  const title = strip && o.title.startsWith(strip + ': ') ? cap(o.title.slice(strip.length + 2)) : o.title;
  return `<div class="item ${o.counts ? '' : 'dim'}">
    <div class="item-left">
      <div class="date-col">${E.ru(o.date)}</div>
      <div class="item-main">
        <div class="item-title">${esc(title)}</div>
        ${o.note ? `<div class="item-note">${esc(o.note)}</div>` : ''}
      </div>
    </div>
    <div class="item-amt ${o.exact ? '' : 'est'}">${o.counts ? '' : '('}${E.rub(o.amount)}${o.counts ? '' : ')'}</div>
  </div>`;
}

function txRows(list) {
  // Перевод — две строки с общим link_id; показываем одну.
  const seen = new Set();
  return list.filter(t => {
    if (!t.link_id) return true;
    if (seen.has(t.link_id)) return false;
    seen.add(t.link_id); return true;
  }).map(t => {
    const a = RAW.acc.get(t.account_id);
    const cat = RAW.categories.find(c => c.id === t.category_id)?.name;
    let title, sub, amt, cls = '';
    if (t.link_id) {
      const pair = RAW.txs.find(x => x.link_id === t.link_id && x.id !== t.id);
      const from = t.amount < 0 ? t : pair, to = t.amount < 0 ? pair : t;
      title = 'Перевод';
      sub = `${accLabel(RAW.acc.get(from?.account_id) || {})} → ${accLabel(RAW.acc.get(to?.account_id) || {})}`;
      amt = E.rub(Math.abs(t.amount));
      cls = 'muted';
    } else {
      title = t.merchant || cat || (t.amount < 0 ? 'Расход' : 'Доход');
      if (t.kind?.startsWith('transfer')) { title = `Перевод ${t.amount < 0 ? 'с' : 'на'} ${a ? accLabel(a) : ''}`; }
      sub = [t.kind?.startsWith('transfer') ? 'без пары — нажмите, чтобы указать второй счёт' : null, cat && t.merchant ? cat : null, a ? accLabel(a) : null, t.source === 'push' ? 'из уведомления' : null,
        t.spread_parts ? `в бюджете ${t.spread_parts} ${plural(t.spread_parts, 'часть', 'части', 'частей')} ${t.spread_period === 'month' ? 'помесячно' : 'раз в 14 дней'}` : null].filter(Boolean).join(', ');
      amt = (t.amount > 0 ? '+' : '−') + E.rub(Math.abs(t.amount));
      cls = t.amount > 0 ? 'pos' : '';
    }
    return `<button class="item item-btn" data-tx="${t.id}">
      <div class="item-left">
        <div class="date-col">${E.ru(t.occurred_at.slice(0, 10))}</div>
        <div class="item-main"><div class="item-title">${esc(title)}</div><div class="item-note">${esc(sub)}</div></div>
      </div>
      <div class="item-amt ${cls}">${amt}</div>
    </button>`;
  }).join('');
}

// ---------------------------------------------------------------- Обзор
function viewOverview() {
  const upcoming = CAL.filter(o => o.counts && o.date >= TODAY);
  const next = upcoming[0];
  const in30 = E.addDays(TODAY, 30);
  const soon = upcoming.filter(o => o.date <= in30);
  const months = [...E.loadByMonth(CAL)].slice(0, 4);
  const max = Math.max(1, ...months.map(([, v]) => v));
  const assets = assetsTotal(), debts = debtsTotal();
  const funding = STATE.installments.filter(p => p.fundingAccount && p.nextDate && E.diffDays(TODAY, p.nextDate) <= 7);
  const nextInc = RAW.incomes.length ? pendingIncomes()[0] : null;
  const fc = RAW.incomes.length ? forecast() : null;
  const gap = fc && fc.min.value < 0 ? fc.min : null;

  return `
    <div class="top"><h1>Обзор</h1><div><button class="icon-btn" data-settings>Настройки</button><button class="icon-btn" id="logout">Выйти</button></div></div>
    <div class="stack">
      ${next ? `
      <section class="next" aria-label="Ближайший платёж">
        <div class="next-date"><span class="next-day">${E.parse(next.date).getUTCDate()}</span><span class="next-mon">${E.ru(next.date).split(' ')[1]}</span></div>
        <div>
          <div class="next-amt">${next.exact ? '' : '≈ '}${E.rub(next.amount)}</div>
          <div class="next-what">${esc(next.title)}</div>
          <div class="next-note">${inDays(next.date)}</div>
        </div>
      </section>` : ''}

      ${gap ? `<div class="notice">По плану к ${E.ru(gap.date)} на картах и наличными не хватит ≈ ${E.rub(-gap.value)}. Подробности в календаре.</div>` : ''}
      ${funding.map(p => `<div class="notice">До ${E.ru(p.nextDate)} пополните счёт «${esc(p.fundingAccount)}» на ${E.rub(p.nextAmount)}: ${esc(p.name)} списывается автоматически.</div>`).join('')}

      <section class="panel">
        <div class="kv kv3">
          <div><span>Деньги</span><b>${E.rub(assets)}</b></div>
          <div><span>Долги</span><b>${E.rub(debts)}</b></div>
          <div><span>Капитал</span><b class="${assets - debts < 0 ? 'neg' : ''}">${assets - debts < 0 ? '−' : ''}${E.rub(Math.abs(assets - debts))}</b></div>
        </div>
        ${nextInc ? `<div class="item-note" style="margin-top:8px">Ближайшее поступление: ${esc(nextInc.name)}${nextInc.late ? ', ожидалось' : ''} ${E.ru(nextInc.date)}, +${E.rub(nextInc.amount)}</div>` : '<div class="item-note" style="margin-top:8px">Добавьте зарплату на вкладке «Деньги», и здесь появится прогноз.</div>'}
        <div class="btns">
          <button class="btn small" data-new-tx="expense">Расход</button>
          <button class="btn ghost small" data-new-tx="income">Доход</button>
          <button class="btn ghost small" data-new-tx="transfer">Перевод</button>
        </div>
      </section>

      ${RAW.limits.length ? (() => { const bs = budgetState(); const wk = weekWant(bs); const total = bs.reduce((s, b) => s + Number(b.limit_amount), 0); const used = bs.reduce((s, b) => s + b.used, 0); const over = bs.filter(b => b.rem < 0);
        return `<section class="panel"><div class="panel-head"><h2>Бюджет месяца</h2><a class="btn link" href="#plan">Подробнее</a></div>
          <div class="row"><b>${E.rub(used)}</b><span class="muted small">из ${E.rub(total)}</span></div>
          <div class="meter ${used > total ? 'over' : ''}"><div style="width:${Math.min(100, used / Math.max(1, total) * 100)}%"></div></div>
          ${wk.limit ? `<div class="item-note">Удовольствия на неделе: осталось ${wk.left < 0 ? '−' : ''}${E.rub(Math.abs(wk.left))}</div>` : ''}
          ${over.length ? `<div class="item-note neg">Перерасход: ${over.map(b => esc(b.name)).join(', ')}</div>` : ''}</section>`; })() : ''}

      <section class="panel">
        <div class="panel-head"><h2>Следующие 30 дней</h2><a class="btn link" href="#calendar">Весь календарь</a></div>
        ${soon.map(o => obligationRow(o)).join('') || '<p class="muted small">Ничего не нужно платить.</p>'}
        ${soon.length ? `<div class="total"><span>Итого</span><span>${E.rub(soon.reduce((s, o) => s + o.amount, 0))}</span></div>` : ''}
      </section>

      ${months.length ? `
      <section class="panel">
        <h2>Платежи по месяцам</h2>
        <div class="months">
          ${months.map(([m, v]) => `
            <div class="month">
              <div class="month-val">${Math.round(v / 1000)} тыс.</div>
              <div class="month-bar" style="height:${Math.max(4, Math.round(v / max * 64))}px"></div>
              <div class="month-label">${E.monthName(m).split(' ')[0]}</div>
            </div>`).join('')}
        </div>
      </section>` : ''}
    </div>`;
}

// ---------------------------------------------------------------- Деньги
function accountRow(a) {
  const b = RAW.bal(a.id);
  const title = `${a.name}${a.last4 ? ` •${a.last4}` : ''}`;
  if (a.kind in MONEY_KINDS) return `<button class="item item-btn" data-acc="${a.id}">
      <div class="item-main"><div class="item-title">${esc(title)}</div>
        <div class="item-note">${MONEY_KINDS[a.kind].toLowerCase()}; ${staleNote(a.id)}</div></div>
      <div class="item-amt">${E.rub(b)}</div></button>`;
  const limit = Number(a.credit_limit ?? 0);
  const kind = { credit_card: 'кредитка', loan: 'кредит', installment: 'рассрочка' }[a.kind];
  const data = a.kind === 'loan' ? `data-loan="${a.id}"` : a.kind === 'installment' ? `data-inst="${a.id}"` : `data-debt="${a.id}"`;
  return `<button class="item item-btn" ${data}>
      <div class="item-main"><div class="item-title">${esc(title)}</div>
        <div class="item-note">${kind}${limit ? `, доступно ${E.rub(Math.max(0, limit - b))} из ${E.rub(limit)}` : ''}</div></div>
      <div class="item-amt debt">${b > 0.5 ? '−' + E.rub(b) : E.rub(0)}</div></button>`;
}

function viewMoney() {
  const mt = monthTotals(TODAY.slice(0, 7));
  const ORDER = { debit: 0, savings: 1, brokerage: 2, cash: 3, credit_card: 4, installment: 5, loan: 6 };
  const groups = new Map();
  for (const a of [...RAW.accounts].sort((x, y) => ORDER[x.kind] - ORDER[y.kind])) {
    const k = a.bank?.trim() || 'Без банка';
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(a);
  }
  const banks = [...groups].sort(([a], [b]) => (a === 'Без банка') - (b === 'Без банка') || a.localeCompare(b, 'ru'));
  const creditAvail = RAW.accounts.filter(a => a.kind === 'credit_card' || a.kind === 'installment')
    .reduce((s, a) => s + Math.max(0, Number(a.credit_limit ?? 0) - RAW.bal(a.id)), 0);

  return `
    <div class="top"><h1>Деньги</h1><div style="display:flex;gap:6px"><button class="btn ghost small" data-statement>Выписка</button><button class="btn ghost small" data-new-acc>Новый счёт</button></div></div>
    <div class="stack">
      ${RAW.unparsed.length ? `<section class="panel"><div class="panel-head"><h2>Не распознано</h2><span class="badge warn">${RAW.unparsed.length}</span></div>
        <p class="muted small" style="margin:0 0 4px">Уведомления с суммой, которые не удалось записать. Нажмите, чтобы записать вручную или скрыть.</p>
        ${RAW.unparsed.slice(0, 10).map(r => `<button class="item item-btn" data-raw="${r.id}">
          <div class="item-main"><div class="item-title">${esc(r.title || r.app)}</div>
            <div class="item-note">${esc((r.body || '').slice(0, 120))}${r.reason ? ` — ${esc(r.reason)}` : ''}</div></div></button>`).join('')}
      </section>` : ''}
      <section class="panel">
        <div class="kv kv3">
          <div><span>Свои деньги</span><b>${E.rub(assetsTotal())}</b></div>
          <div><span>Долги</span><b>${E.rub(debtsTotal())}</b></div>
          <div><span>Доступно в кредит</span><b>${E.rub(creditAvail)}</b></div>
        </div>
      </section>

      ${banks.map(([bank, list]) => {
        const own = list.filter(a => a.kind in MONEY_KINDS).reduce((s, a) => s + RAW.bal(a.id), 0);
        const debt = list.filter(a => DEBT_KINDS.has(a.kind)).reduce((s, a) => s + RAW.bal(a.id), 0);
        return `<section class="panel">
          <div class="panel-head"><h2>${esc(bank)}</h2>
            <span class="muted small">${[own ? E.rub(own) : '', debt ? `долг ${E.rub(debt)}` : ''].filter(Boolean).join(', ')}</span></div>
          ${list.map(accountRow).join('')}
        </section>`;
      }).join('')}

      <section class="panel">
        <div class="panel-head"><h2>Регулярные доходы</h2><button class="btn link" data-new-income>Добавить</button></div>
        ${RAW.incomes.map(inc => {
          const next = pendingIncomes().find(p => p.id === inc.id);
          return `<button class="item item-btn" data-income="${inc.id}">
            <div class="item-main"><div class="item-title">${esc(inc.name)}</div>
              <div class="item-note">${inc.day_of_month === 31 ? 'в последний день месяца' : `${inc.day_of_month}-го числа`}${inc.shift_weekend ? ', с выходных — раньше' : ''}${next ? `; следующее ${E.ru(next.date)}` : ''}</div></div>
            <div class="item-amt pos">+${E.rub(inc.amount)}</div></button>`;
        }).join('') || '<p class="muted small">Зарплата, аванс, подработка: даты и суммы попадут в календарь и прогноз.</p>'}
      </section>

      <section class="panel">
        <div class="panel-head"><h2>${E.monthName(TODAY.slice(0, 7))}</h2><button class="btn link" data-export>Выгрузить</button></div>
        <div class="kv">
          <div><span>Доходы</span><b class="pos">+${E.rub(mt.inc)}</b></div>
          <div><span>Расходы</span><b>−${E.rub(mt.exp)}</b></div>
        </div>
        <p class="muted small" style="margin:8px 0 0">Без переводов между своими счетами.</p>
      </section>

      <section class="panel">
        <div class="panel-head"><h2>Операции</h2></div>
        <div class="btns" style="margin:0 0 8px">
          <button class="btn small" data-new-tx="expense">Расход</button>
          <button class="btn ghost small" data-new-tx="income">Доход</button>
          <button class="btn ghost small" data-new-tx="transfer">Перевод</button>
        </div>
        ${txRows(RAW.txs.slice(0, 60)) || '<p class="muted small">Операций пока нет.</p>'}
      </section>
    </div>`;
}

// ---------------------------------------------------------------- Долги
const GRACE_LABEL = {
  per_statement: 'Без процентов, если до срока погасить сумму по выписке',
  monthly_cohort: 'Покупки месяца без процентов до конца третьего месяца после',
  per_tranche: 'У каждой покупки свой срок без процентов',
};

function cmpHtml(l, amount) {
  const { rate } = E.loanRateAnnual(l);
  const cmp = E.comparePrepay(l.balance, rate / 12, l.payment, l.remaining, amount);
  return `<div class="cmp">
    <div><span class="muted small">Уменьшить срок</span><b>${E.rub(cmp.reduceTerm.interestSaved)}</b>
      <span class="small">${Math.ceil(cmp.reduceTerm.months)} мес вместо ${l.remaining}</span></div>
    <div><span class="muted small">Уменьшить платёж</span><b>${E.rub(cmp.reducePayment.interestSaved)}</b>
      <span class="small">платёж ${E.rub(cmp.reducePayment.payment)}</span></div>
  </div>`;
}

function loanPanels() {
  return STATE.loans.map(l => {
    const { rate, estimated } = E.loanRateAnnual(l);
    const rows = E.loanSchedule(l, 6);
    const amount = Number(sessionStorage.getItem('prepay') || 100000);
    const lastDate = E.monthDay(l.nextDate, l.remaining - 1, l.payDay);
    return `
      <section class="panel">
        <div class="panel-head"><h2>${esc(l.name)}</h2><button class="btn link" data-loan="${l.id}">Изменить</button></div>
        <div style="font-size:28px;font-weight:800;letter-spacing:-0.5px">${E.rub(l.balance)}</div>
        <div class="item-note">${cap(staleNote(l.id))}</div>
        <div class="kv">
          <div><span>Платёж ${E.ru(l.nextDate)}</span><b>${E.rub(l.payment)}</b></div>
          <div><span>Ставка</span><b>${pct(rate * 100)}${estimated ? ' (оценка)' : ''}</b></div>
          <div><span>Осталось</span><b>${l.remaining} ${plural(l.remaining, 'платёж', 'платежа', 'платежей')}</b></div>
          <div><span>Последний</span><b>${E.monthName(lastDate.slice(0, 7)).toLowerCase()}</b></div>
        </div>
        <details style="margin-top:12px">
          <summary class="btn link" style="padding:0">Досрочка и график</summary>
          <label class="field" style="margin-top:8px">Сумма досрочки
            <input type="text" inputmode="decimal" id="prepay" data-loan-id="${l.id}" value="${amount}">
          </label>
          <div id="cmp">${cmpHtml(l, amount)}</div>
          <p class="muted small" style="margin:10px 0">Экономия на процентах за весь срок, расчёт приблизительный.</p>
          <table class="sched">
            <thead><tr><th>Дата</th><th>Проценты</th><th>Долг</th><th>Остаток</th></tr></thead>
            <tbody>${rows.map(r => `<tr><td>${E.ru(r.date)}</td><td>${E.rub(r.interest)}</td><td>${E.rub(r.principal)}</td><td>${E.rub(r.balance)}</td></tr>`).join('')}</tbody>
          </table>
        </details>
      </section>`;
  }).join('');
}

function viewDebts() {
  const cards = STATE.cards.map(c => {
    const t = RAW.terms.find(x => x.account_id === c.id);
    const obl = CAL.filter(o => o.account === c.id);
    const used = c.limit ? Math.min(100, c.debt / c.limit * 100) : 0;
    return `
      <section class="panel">
        <div class="panel-head"><h2>${esc(c.name)}, кредитка</h2><span class="badge">${pct(c.rate)} вне льготы</span></div>
        <div class="row"><b>${E.rub(c.debt)}</b><span class="muted small">из ${E.rub(c.limit)}</span></div>
        <div class="meter"><div style="width:${used}%"></div></div>
        <div class="item-note">${esc(GRACE_LABEL[t.grace_type])}. ${cap(staleNote(c.id))}.</div>
        <div style="margin-top:8px">${obl.map(o => obligationRow(o, { strip: c.name })).join('') || '<p class="muted small">Платежей нет.</p>'}</div>
        ${c.buckets.length ? `<div class="small muted" style="margin-top:8px">Сроки из приложения банка</div>
          ${c.buckets.map(b => `<button class="item item-btn" data-bucket="${b.id}">
            <span>до ${E.ru(b.due)}</span><span class="item-amt">${E.rub(b.amount)}</span></button>`).join('')}` : ''}
        <div class="btns">
          <button class="btn small" data-debt="${c.id}">Сверить долг</button>
          <button class="btn ghost small" data-add-bucket="${c.id}">Добавить срок</button>
        </div>
      </section>`;
  });
  const inst = STATE.installments.map(p => `
    <section class="panel">
      <div class="panel-head"><h2>${esc(p.name)}</h2><span class="badge">рассрочка</span></div>
      <div class="row"><b>${E.rub(p.debt)}</b><span class="muted small">из ${E.rub(p.limit)}</span></div>
      <div class="meter"><div style="width:${p.limit ? Math.min(100, p.debt / p.limit * 100) : 0}%"></div></div>
      <div class="item-note">Платёж раз в ${p.periodDays} дней${p.fundingAccount ? `, списывается со счёта «${esc(p.fundingAccount)}»` : ''}. ${cap(staleNote(p.id))}.</div>
      <div style="margin-top:8px">${CAL.filter(o => o.account === p.id).map(o => obligationRow({ ...o, title: 'Платёж' })).join('')}</div>
      <div class="btns"><button class="btn small" data-inst="${p.id}">Обновить</button></div>
    </section>`);
  return `
    <div class="top"><h1>Долги</h1><span class="muted small">${E.rub(debtsTotal())}</span></div>
    <div class="stack">${loanPanels()}${cards.join('')}${inst.join('')}</div>`;
}

// ---------------------------------------------------------------- Цели
const PRIORITY = { 1: 'хочу сильно', 2: 'хочу', 3: 'когда-нибудь' };

function goalHave(g) { return g.account_id ? RAW.bal(g.account_id) : Number(g.saved ?? 0); }

function viewGoals() {
  const goals = RAW.goals.map(g => {
    const have = goalHave(g), target = Number(g.target ?? 0);
    const left = Math.max(0, target - have);
    const p = target ? Math.min(100, have / target * 100) : 0;
    let plan = '';
    if (left > 0 && g.deadline) {
      const months = Math.max(1, Math.round(E.diffDays(TODAY, g.deadline) / 30.4));
      plan = `${E.rub(left / months)} в месяц до ${E.ru(g.deadline)} ${g.deadline.slice(0, 4)}`;
    } else if (left <= 0 && target) plan = 'Цель достигнута';
    const src = g.account_id ? `копится на счёте «${RAW.acc.get(g.account_id)?.name ?? '?'}»` : 'сумма ведётся вручную';
    return `
      <button class="panel goal" data-goal="${g.id}">
        <div class="panel-head"><h2>${esc(g.name)}</h2>${g.visibility === 'shared' ? '<span class="badge">общая</span>' : ''}</div>
        <div class="row"><b>${E.rub(have)}</b><span class="muted small">из ${E.rub(target)}</span></div>
        <div class="meter"><div style="width:${p}%"></div></div>
        <div class="item-note">${esc(cap(src))}${plan ? `. ${esc(plan)}` : ''}</div>
      </button>`;
  });
  const wish = RAW.wishlist.map(w => `
    <button class="item item-btn" data-wish="${w.id}">
      <div class="item-main">
        <div class="item-title">${esc(w.name)}</div>
        <div class="item-note">${PRIORITY[w.priority] ?? ''}${w.goal_id ? ', есть цель' : ''}</div>
      </div>
      <div class="item-amt">${w.price ? E.rub(w.price) : ''}</div>
    </button>`);
  const wishTotal = RAW.wishlist.reduce((s, w) => s + Number(w.price ?? 0), 0);
  return `
    <div class="btns" style="margin-top:0"><button class="btn small" data-new-goal>Новая цель</button></div>
    <div class="stack">
      ${goals.join('') || '<section class="panel"><p class="muted small" style="margin:0">Создайте цель: подушка безопасности, отпуск, досрочка по кредиту.</p></section>'}
      <section class="panel">
        <div class="panel-head"><h2>Вишлист</h2><button class="btn link" data-new-wish>Добавить</button></div>
        ${wish.join('') || '<p class="muted small">Записывайте сюда то, что хочется купить, — потом любую позицию можно превратить в цель.</p>'}
        ${wish.length ? `<div class="total"><span>Всего</span><span>${E.rub(wishTotal)}</span></div>` : ''}
      </section>
    </div>`;
}

// ---------------------------------------------------------------- Бюджет
const GROUPS = { need: 'Обязательное', want: 'Удовольствия', big: 'Крупное и нерегулярное' };
const ROLLOVER = { to_loan: 'остаток — в досрочку', carry: 'остаток копится', none: 'остаток сгорает' };
const BUDGET_TEMPLATE = [
  ['Продукты и быт', 'need', 20000, 'to_loan'], ['Жильё и связь', 'need', 10000, 'to_loan'],
  ['Транспорт', 'need', 7000, 'to_loan'], ['Кот', 'need', 3000, 'to_loan'], ['Здоровье', 'need', 2000, 'to_loan'],
  ['Кафе, доставка, развлечения', 'want', 14000, 'none'],
  ['Для себя', 'big', 7000, 'carry'], ['Резерв на нерегулярное', 'big', 7000, 'carry'],
];
const ym = d => d.slice(0, 7);
const nextYm = m => E.monthDay(`${m}-01`, 1, 1).slice(0, 7);
const catName = id => RAW.categories.find(c => c.id === id)?.name ?? 'Без категории';
const isExpense = t => t.amount < 0 && !t.link_id && !t.kind?.startsWith('transfer');

/** Части покупки для бюджета: целиком в день покупки или N частей по графику. */
function budgetParts(t) {
  const d = t.occurred_at.slice(0, 10), total = -Number(t.amount);
  if (!t.spread_parts) return [{ date: d, amount: total }];
  const n = t.spread_parts, part = total / n;
  return Array.from({ length: n }, (_, k) => ({
    date: t.spread_period === 'month' ? E.monthDay(d, k, Number(d.slice(8))) : E.addDays(d, 14 * k),
    amount: part,
  }));
}

function spentBy(month) {
  const m = new Map();
  for (const t of RAW.txs) if (isExpense(t)) for (const p of budgetParts(t)) if (ym(p.date) === month) {
    const k = t.category_id || 'none';
    m.set(k, (m.get(k) ?? 0) + p.amount);
  }
  return m;
}

/** Сколько бюджета будущих месяцев уже занято рассрочками. */
function futureCommitted(count = 3) {
  const out = [];
  let m = ym(TODAY);
  for (let i = 0; i < count; i++) {
    m = nextYm(m);
    const byCat = spentBy(m);
    const total = [...byCat.values()].reduce((s, v) => s + v, 0);
    if (total > 0.5) out.push({ month: m, total, byCat });
  }
  return out;
}

/** Состояние конвертов на текущий месяц: доступно, потрачено, остаток — с учётом переносов прошлых месяцев. */
function budgetState() {
  const cur = ym(TODAY);
  const spentCache = new Map();
  const spent = m => { if (!spentCache.has(m)) spentCache.set(m, spentBy(m)); return spentCache.get(m); };
  const moveSum = (cat, m, dir) => RAW.moves.filter(x => x.month === m && x[dir] === cat).reduce((s, x) => s + Number(x.amount), 0);
  return RAW.limits.map(l => {
    const start = ym(l.created_at) < cur ? ym(l.created_at) : cur;
    let carry = 0, avail = 0, used = 0, rem = 0;
    const hist = RAW.limitChanges.filter(c => c.category_id === l.category_id);
    const limitFor = m => { const h = hist.filter(c => c.month <= m).pop(); return Number(h ? h.amount : l.limit_amount); };
    for (let m = start; m <= cur; m = nextYm(m)) {
      avail = limitFor(m) + carry + moveSum(l.category_id, m, 'to_category') - moveSum(l.category_id, m, 'from_category');
      used = spent(m).get(l.category_id) ?? 0;
      rem = avail - used;
      carry = l.rollover === 'carry' ? rem : Math.min(0, rem);
    }
    const curLimit = limitFor(cur);
    return { ...l, limit_amount: curLimit, name: catName(l.category_id), avail, used, rem, carried: avail - curLimit - moveSum(l.category_id, cur, 'to_category') + moveSum(l.category_id, cur, 'from_category') };
  }).sort((a, b) => Object.keys(GROUPS).indexOf(a.grp) - Object.keys(GROUPS).indexOf(b.grp) || a.sort - b.sort);
}

function weekWant(bs) {
  const wd = (E.parse(TODAY).getUTCDay() + 6) % 7;
  const monday = E.addDays(TODAY, -wd);
  const days = Number(E.monthDay(TODAY, 0, 31).slice(8));
  const want = bs.filter(b => b.grp === 'want');
  const ids = new Set(want.map(b => b.category_id));
  const limit = want.reduce((s, b) => s + Number(b.limit_amount), 0) * 7 / days;
  const spent = RAW.txs.filter(t => isExpense(t) && ids.has(t.category_id))
    .flatMap(budgetParts).filter(p => p.date >= monday && p.date <= TODAY).reduce((s, p) => s + p.amount, 0);
  return { limit, spent, left: limit - spent, ids };
}

function budgetPanel() {
  if (!RAW.limits.length) return `<section class="panel"><h2>Бюджет не настроен</h2>
    <p class="muted small">Создам категории и лимиты на 70 000 ₽: обязательное 42 000, удовольствия 14 000, крупное и нерегулярное 14 000. Всё можно поменять.</p>
    <div class="btns"><button class="btn" data-budget-setup>Настроить бюджет</button></div></section>`;
  const bs = budgetState();
  const total = bs.reduce((s, b) => s + Number(b.limit_amount), 0);
  const used = bs.reduce((s, b) => s + b.used, 0);
  const wk = weekWant(bs);
  const toLoan = bs.filter(b => b.rollover === 'to_loan' && b.rem > 0).reduce((s, b) => s + b.rem, 0);
  const eventCats = new Set(RAW.events.map(e => e.category_id).filter(Boolean));
  const limited = new Set(bs.map(b => b.category_id));
  const sp = spentBy(ym(TODAY));
  const unl = [...sp].filter(([k]) => !limited.has(k) && !eventCats.has(k));
  const daysLeft = E.diffDays(TODAY, E.monthDay(TODAY, 0, 31));
  const fut = futureCommitted();
  const nextBy = fut.find(f => f.month === nextYm(ym(TODAY)))?.byCat;
  return `
    <section class="panel">
      <div class="kv kv3">
        <div><button class="kv-btn" data-total><span>Лимит, изменить</span><b>${E.rub(total)}</b></button></div>
        <div><span>Потрачено</span><b>${E.rub(used)}</b></div>
        <div><span>Осталось дней</span><b>${daysLeft}</b></div>
      </div>
      ${wk.limit ? `<div class="item-note" style="margin-top:8px">Удовольствия на этой неделе: осталось <b class="${wk.left < 0 ? 'neg' : ''}">${wk.left < 0 ? '−' : ''}${E.rub(Math.abs(wk.left))}</b> из ${E.rub(wk.limit)}</div>` : ''}
      ${toLoan > 0 ? `<div class="item-note">Если месяц закончится сейчас, в досрочку: ${E.rub(toLoan)}</div>` : ''}
      ${fut.length ? `<div class="item-note">Уже занято рассрочками: ${fut.map(f => `${E.monthName(f.month).split(' ')[0].toLowerCase()} ${E.rub(f.total)}`).join(', ')}</div>` : ''}
    </section>
    ${Object.entries(GROUPS).map(([g, title]) => {
      const list = bs.filter(b => b.grp === g);
      if (!list.length) return '';
      return `<section class="panel"><h2>${title}</h2>
        ${list.map(b => {
          const p = b.avail > 0 ? Math.min(100, b.used / b.avail * 100) : 100;
          const over = b.rem < 0;
          return `<div class="env">
            <button class="item item-btn" data-limit="${b.id}">
              <div class="item-main"><div class="item-title">${esc(b.name)}</div>
                <div class="item-note">${E.rub(b.used)} из ${E.rub(b.avail)}${Math.abs(b.carried) > 0.5 ? ` (${b.carried > 0 ? '+' : '−'}${E.rub(Math.abs(b.carried))} с прошлых месяцев)` : ''}${nextBy?.get(b.category_id) ? `; в следующем месяце уже занято ${E.rub(nextBy.get(b.category_id))}` : ''}</div></div>
              <div class="item-amt ${over ? 'neg' : ''}">${over ? '−' : ''}${E.rub(Math.abs(b.rem))}</div>
            </button>
            <div class="meter ${over ? 'over' : p >= 80 ? 'warn' : ''}"><div style="width:${p}%"></div></div>
            ${over ? `<button class="btn small" data-cover="${b.category_id}" style="margin-bottom:8px">Покрыть перерасход</button>` : ''}
          </div>`;
        }).join('')}
      </section>`;
    }).join('')}
    ${unl.length ? `<section class="panel"><h2>Без лимита</h2>
      ${unl.map(([k, v]) => `<div class="item"><div class="item-main"><div class="item-title">${esc(k === 'none' ? 'Без категории' : catName(k))}</div>
        <div class="item-note">${k === 'none' ? 'проставьте категории в операциях' : 'добавьте лимит или перенесите траты в другую категорию'}</div></div>
        <div class="item-amt">${E.rub(v)}</div></div>`).join('')}
    </section>` : ''}
    <div class="btns"><button class="btn ghost small" data-new-limit>Добавить категорию</button><button class="btn ghost small" data-move>Перенести между категориями</button></div>`;
}

// ---------------------------------------------------------------- События
function eventInfo(e) {
  const items = RAW.eventItems.filter(i => i.event_id === e.id);
  const target = items.length ? items.reduce((s, i) => s + Number(i.budget ?? 0), 0) : Number(e.amount ?? 0);
  const from = E.addDays(e.date, -75), to = E.addDays(e.date, 14);
  const spent = e.category_id ? RAW.txs.filter(t => isExpense(t) && t.category_id === e.category_id && t.occurred_at.slice(0, 10) >= from && t.occurred_at.slice(0, 10) <= to)
    .reduce((s, t) => s - Number(t.amount), 0) : 0;
  return { items, target, spent };
}

/**
 * Планы финансирования всех событий сразу, по порядку дат: более ранние события
 * первыми забирают резерв; урезание удовольствий и отсрочка досрочки — не больше одного раза в месяц.
 */
function fundingPlans(list) {
  const bs = RAW.limits.length ? budgetState() : [];
  const reserve = bs.filter(b => b.rollover === 'carry' && /резерв/i.test(b.name));
  const resNow = reserve.reduce((s, b) => s + Math.max(0, b.rem), 0);
  const resMonthly = reserve.reduce((s, b) => s + Number(b.limit_amount), 0);
  const wantHalf = bs.filter(b => b.grp === 'want').reduce((s, b) => s + Number(b.limit_amount), 0) / 2;
  const loan = STATE.loans[0];
  const DEFER = loan ? 23520 : 0;
  const rateM = loan ? E.loanRateAnnual(loan).rate / 12 : 0;
  const monthsTo = d => Math.max(0, (Number(d.slice(0, 4)) - Number(TODAY.slice(0, 4))) * 12 + Number(d.slice(5, 7)) - Number(TODAY.slice(5, 7)));
  let resUsed = 0;
  const wantLeft = new Map(), deferLeft = new Map();
  const out = new Map();
  for (const { e, need } of [...list].sort((a, b) => a.e.date.localeCompare(b.e.date))) {
    const m = ym(e.date);
    if (!wantLeft.has(m)) wantLeft.set(m, wantHalf);
    if (!deferLeft.has(m)) deferLeft.set(m, DEFER);
    const resAvail = Math.max(0, resNow + resMonthly * monthsTo(e.date) - resUsed);
    let left = need;
    const used = [];
    const take = (label, avail, cost) => { const t = Math.max(0, Math.min(avail, left)); if (t > 0) { used.push({ label, take: t, cost: typeof cost === 'function' ? cost(t) : cost }); left -= t; } return t; };
    resUsed += take('Резерв на нерегулярное к дате', resAvail, resUsed > 0 ? 'с учётом более ранних событий' : 'бесплатно');
    wantLeft.set(m, wantLeft.get(m) - take('Урезать удовольствия вдвое в месяц события', wantLeft.get(m), 'бесплатно'));
    deferLeft.set(m, deferLeft.get(m) - take('Отложить досрочку по кредиту на месяц', deferLeft.get(m), t => `≈${E.rub(t * rateM)} процентов`));
    out.set(e.id, { used, left, sberDue: E.monthDay(e.date, 3, 31), shared: used.some(u => u.cost === 'с учётом более ранних событий') });
  }
  return out;
}

function eventsPanel() {
  const active = RAW.events.filter(e => e.date >= E.addDays(TODAY, -14)).map(e => {
    const info = eventInfo(e);
    const need = info.items.length ? info.items.filter(i => !i.bought).reduce((s, i) => s + Number(i.budget ?? 0), 0) : Math.max(0, info.target - info.spent);
    return { e, ...info, need };
  });
  const plans = fundingPlans(active);
  return `${active.map(({ e, items, target, spent, need }) => {
    const fp = plans.get(e.id);
    const bought = items.filter(i => i.bought).length;
    return `<section class="panel">
      <div class="panel-head"><h2>${esc(e.name)}</h2><button class="btn link" data-event="${e.id}">Изменить</button></div>
      <div class="row"><b>${E.rub(target)}</b><span class="muted small">${E.ru(e.date)} ${e.date.slice(0, 4)}, ${inDays(e.date)}</span></div>
      ${spent ? `<div class="item-note">Уже потрачено ${E.rub(spent)} (категория «${esc(catName(e.category_id))}»)</div>` : ''}
      ${items.length ? `<div style="margin-top:8px"><div class="small muted">Подарки: куплено ${bought} из ${items.length}</div>
        ${items.map(i => `<button class="item item-btn" data-item="${i.id}">
          <div class="item-main"><div class="item-title">${i.bought ? '✓ ' : ''}${esc(i.who)}</div></div>
          <div class="item-amt ${i.bought ? 'muted' : ''}">${i.budget ? E.rub(i.budget) : ''}</div></button>`).join('')}</div>` : ''}
      <div class="btns" style="margin-top:8px"><button class="btn ghost small" data-add-item="${e.id}">Добавить подарок</button></div>
      ${need > 0 ? `<div style="margin-top:12px"><div class="small" style="font-weight:700">Осталось найти ${E.rub(need)}${items.length ? ' на некупленное' : ''}</div>
        ${fp.used.map(r => `<div class="item"><div class="item-main"><div class="item-title">${esc(r.label)}</div><div class="item-note">${esc(r.cost)}</div></div><div class="item-amt">${E.rub(r.take)}</div></div>`).join('')}
        ${fp.left > 0.5 ? `<div class="notice" style="margin-top:8px">Не хватает ${E.rub(fp.left)}: можно оплатить кредиткой Сбера в месяц события и погасить без процентов до ${E.ru(fp.sberDue)} ${fp.sberDue.slice(0, 4)}.</div>` : ''}
      </div>` : ''}
    </section>`;
  }).join('') || '<section class="panel"><p class="muted small" style="margin:0">Новый год, дни рождения, отпуск: заведите событие заранее, и приложение посчитает, откуда взять деньги.</p></section>'}
  <div class="btns"><button class="btn small" data-new-event>Новое событие</button></div>`;
}

function viewPlan() {
  const seg = sessionStorage.getItem('planSeg') || 'budget';
  const SEGS = [['budget', 'Бюджет'], ['events', 'События'], ['goals', 'Цели']];
  const body = seg === 'events' ? eventsPanel() : seg === 'goals' ? viewGoals() : budgetPanel();
  return `
    <div class="top"><h1>План</h1></div>
    <div class="seg" role="tablist">${SEGS.map(([id, label]) => `<button role="tab" aria-selected="${id === seg}" data-seg="${id}">${label}</button>`).join('')}</div>
    <div class="stack">${body}</div>`;
}

// ---------------------------------------------------------------- Календарь
function incomeRow(i) {
  return `<button class="item item-btn" data-receive="${i.id}" data-date="${i.date}">
    <div class="item-left"><div class="date-col">${E.ru(i.date)}</div>
      <div class="item-main"><div class="item-title">${esc(i.name)}</div>
        <div class="item-note">${i.late ? 'ожидалось — нажмите, когда придёт' : 'нажмите, когда придёт'}</div></div></div>
    <div class="item-amt pos">+${E.rub(i.amount)}</div></button>`;
}

function viewCalendar() {
  const fc = RAW.incomes.length ? forecast() : null;
  const rows = [
    ...CAL.filter(o => o.date >= TODAY).map(o => ({ date: o.date, html: obligationRow(o), out: o.counts ? o.amount : 0, inc: 0 })),
    ...pendingIncomes().map(i => ({ date: i.date < TODAY ? TODAY : i.date, html: incomeRow(i), out: 0, inc: i.amount })),
  ].sort((a, b) => a.date.localeCompare(b.date) || b.inc - a.inc);
  const byMonth = new Map();
  for (const r of rows) {
    const k = r.date.slice(0, 7);
    if (!byMonth.has(k)) byMonth.set(k, []);
    byMonth.get(k).push(r);
  }
  return `
    <div class="top"><h1>Календарь</h1></div>
    ${fc ? `<section class="panel" style="margin-bottom:12px">
      <div class="kv">
        <div><span>На картах и наличными</span><b>${E.rub(fc.start)}</b></div>
        <div><span>Минимум по плану</span><b class="${fc.min.value < 0 ? 'neg' : ''}">${fc.min.value < 0 ? '−' : ''}${E.rub(Math.abs(fc.min.value))}, ${E.ru(fc.min.date)}</b></div>
      </div>
      <p class="muted small" style="margin:8px 0 0">Если доходы придут по плану, а платежи пройдут в срок. Накопления и инвестиции не учитываются.</p>
    </section>` : ''}
    <p class="muted small" style="margin-top:0">≈ — прогноз, уточнится по выписке. В скобках — минимальные платежи, которые уже входят в другой платёж.</p>
    <div class="stack">
      ${[...byMonth].map(([m, list]) => {
        const out = list.reduce((s, r) => s + r.out, 0), inc = list.reduce((s, r) => s + r.inc, 0);
        const lastDate = list[list.length - 1].date;
        const left = fc ? [...fc.byDate].filter(([d]) => d <= lastDate).pop()?.[1] : null;
        return `<section class="panel">
          <h2>${E.monthName(m)}</h2>
          ${list.map(r => r.html).join('')}
          <div class="total"><span>Платежи</span><span>${E.rub(out)}</span></div>
          ${inc ? `<div class="row small" style="margin-top:6px"><span class="muted">Поступления</span><b class="pos">+${E.rub(inc)}</b></div>` : ''}
          ${left != null ? `<div class="row small" style="margin-top:6px"><span class="muted">Останется к концу месяца</span><b class="${left < 0 ? 'neg' : ''}">${left < 0 ? '−' : ''}${E.rub(Math.abs(left))}</b></div>` : ''}
        </section>`;
      }).join('')}
    </div>`;
}

// ---------------------------------------------------------------- действия
const SOURCE = { per_statement: 'statement', monthly_cohort: 'cohort', per_tranche: 'tranche' };
const accountOptions = filter => RAW.accounts.filter(filter || (() => true)).map(a => ({ value: a.id, label: accLabel(a) }));

async function categoryId(name) {
  name = (name || '').trim();
  if (!name) return null;
  const found = RAW.categories.find(c => c.name.toLowerCase() === name.toLowerCase());
  if (found) return found.id;
  const { data, error } = await sb.from('categories').insert({ owner_id: USER.id, name }).select().single();
  if (error) { toast(`Категория не создана: ${error.message}`); return null; }
  return data.id;
}

async function newTx(kind, tx, preset = {}) {
  const editing = !!tx;
  if (kind === 'transfer') {
    const v = await form({ title: 'Перевод', text: 'Между своими счетами: погашение кредитки, досрочка по кредиту, снятие наличных.', fields: [
      { name: 'from', label: 'Откуда', type: 'select', options: accountOptions(), value: moneyAccounts()[0]?.id },
      { name: 'to', label: 'Куда', type: 'select', options: accountOptions() },
      { name: 'amount', label: 'Сумма, ₽' },
      { name: 'date', label: 'Дата', type: 'date', value: TODAY },
    ], submit: 'Сохранить перевод' });
    if (!v || !num(v.amount)) return;
    if (v.from === v.to) return toast('Выберите разные счета');
    const link = uid(), at = `${v.date}T12:00:00Z`, a = num(v.amount);
    return mutate(sb.from('transactions').insert([
      { account_id: v.from, occurred_at: at, amount: -a, kind: 'transfer_out', source: 'manual', dedup_hash: `manual:${uid()}`, link_id: link },
      { account_id: v.to, occurred_at: at, amount: a, kind: 'transfer_in', source: 'manual', dedup_hash: `manual:${uid()}`, link_id: link },
    ]), 'Перевод сохранён');
  }
  const income = kind === 'income';
  const v = await form({
    title: editing ? 'Операция' : income ? 'Доход' : 'Расход',
    fields: [
      { name: 'amount', label: 'Сумма, ₽', value: editing ? Math.abs(tx.amount) : preset.amount ?? '' },
      { name: 'account', label: income ? 'На счёт' : 'Со счёта или карты', type: 'select',
        options: accountOptions(a => income ? a.kind in MONEY_KINDS : a.kind in MONEY_KINDS || a.kind === 'credit_card' || a.kind === 'installment'),
        value: editing ? tx.account_id : (preset.account || localStorage.getItem('lastAcc') || moneyAccounts()[0]?.id) },
      { name: 'category', label: 'Категория', type: 'text', list: RAW.categories.map(c => c.name), required: false,
        value: editing ? RAW.categories.find(c => c.id === tx.category_id)?.name : preset.category ?? '' },
      { name: 'merchant', label: 'Комментарий', type: 'text', required: false, value: editing ? tx.merchant : '' },
      { name: 'date', label: 'Дата', type: 'date', value: editing ? tx.occurred_at.slice(0, 10) : TODAY },
      ...(income ? [] : [
        { name: 'parts', label: 'В бюджете', type: 'select', required: false, value: editing ? (tx.spread_parts ?? '') : '',
          options: [{ value: '', label: 'Вся сумма сразу' }, ...[2, 3, 4, 6, 8, 12].map(n => ({ value: n, label: `Распределить на ${n} ${plural(n, 'часть', 'части', 'частей')}` }))] },
        { name: 'period', label: 'Части', type: 'select', required: false, value: editing ? (tx.spread_period ?? '2w') : '2w',
          options: [{ value: '2w', label: 'Раз в 14 дней (как Сплит)' }, { value: 'month', label: 'Раз в месяц' }] },
      ]),
    ],
    actions: editing ? [{ value: 'delete', label: 'Удалить' }] : [],
  });
  if (!v) return;
  if (v.$action === 'delete') return mutate(sb.from('transactions').delete().eq('id', tx.id), 'Удалено');
  const a = num(v.amount);
  if (!a) return toast('Укажите сумму');
  localStorage.setItem('lastAcc', v.account);
  const row = {
    account_id: v.account, occurred_at: `${v.date}T12:00:00Z`, amount: income ? a : -a,
    kind: income ? 'income' : 'purchase', merchant: v.merchant?.trim() || null, category_id: await categoryId(v.category),
  };
  if (!income) { row.spread_parts = v.parts ? Number(v.parts) : null; row.spread_period = v.parts ? v.period : null; }
  if (editing && tx.source === 'push' && tx.merchant && row.category_id)
    await sb.from('category_rules').upsert({ owner_id: USER.id, pattern: tx.merchant.toLowerCase(), category_id: row.category_id }, { onConflict: 'owner_id,pattern' });
  if (editing) return mutate(sb.from('transactions').update(row).eq('id', tx.id));
  if (preset.recurring) row.recurring_income_id = preset.recurring;
  return mutate(sb.from('transactions').insert({ ...row, source: 'manual', dedup_hash: `manual:${uid()}` }), income ? 'Доход сохранён' : 'Расход сохранён');
}

async function editAccount(a) {
  const isNew = !a;
  const v = await form({
    title: isNew ? 'Новый счёт' : a.name,
    text: isNew ? '' : 'Укажите остаток, как в приложении банка. Операции, внесённые после сверки, учитываются автоматически.',
    fields: [
      { name: 'name', label: 'Название', type: 'text', value: a?.name ?? '' },
      { name: 'bank', label: 'Банк', type: 'text', required: false, value: a?.bank ?? '', list: [...new Set(RAW.accounts.map(x => x.bank).filter(Boolean))] },
      { name: 'kind', label: 'Тип', type: 'select', options: Object.entries(MONEY_KINDS).map(([value, label]) => ({ value, label })), value: a?.kind ?? 'debit' },
      { name: 'balance', label: 'Остаток сейчас, ₽', value: isNew ? '' : Math.round(RAW.bal(a.id) * 100) / 100 },
      { name: 'last4', label: 'Последние 4 цифры карты', type: 'text', required: false, value: a?.last4 ?? '' },
      { name: 'aliases', label: 'Другие номера (виртуальный в Mir Pay, номер счёта), через запятую', type: 'text', required: false, value: (a?.card_aliases ?? []).join(', ') },
    ],
    actions: isNew ? [] : [{ value: 'hide', label: 'Скрыть счёт' }],
  });
  if (!v) return;
  if (v.$action === 'hide') return mutate(sb.from('accounts').update({ is_archived: true }).eq('id', a.id), 'Счёт скрыт');
  if (isNew) {
    const { data, error } = await sb.from('accounts').insert({ owner_id: USER.id, name: v.name.trim(), bank: v.bank.trim() || '', kind: v.kind, ...idsRow(v) }).select().single();
    if (error) return toast(`Не сохранилось: ${error.message}`);
    return mutate(sb.from('balance_snapshots').insert({ account_id: data.id, balance: num(v.balance) ?? 0, source: 'manual' }), 'Счёт добавлен');
  }
  const r = await sb.from('accounts').update({ name: v.name.trim(), bank: v.bank.trim() || '', kind: v.kind, ...idsRow(v) }).eq('id', a.id);
  if (r.error) return toast(`Не сохранилось: ${r.error.message}`);
  const b = num(v.balance);
  if (b != null && Math.abs(b - RAW.bal(a.id)) > 0.004) return mutate(sb.from('balance_snapshots').insert({ account_id: a.id, balance: b, source: 'manual' }));
  await load(); route(); toast('Сохранено');
}

async function editGoal(g, preset = {}) {
  const isNew = !g;
  const v = await form({
    title: isNew ? 'Новая цель' : g.name,
    fields: [
      { name: 'name', label: 'Название', type: 'text', value: g?.name ?? preset.name ?? '' },
      { name: 'target', label: 'Сколько нужно, ₽', value: g?.target ?? preset.target ?? '' },
      { name: 'deadline', label: 'К какой дате (необязательно)', type: 'date', required: false, value: g?.deadline ?? '' },
      { name: 'account', label: 'Где копится', type: 'select', required: false, value: g?.account_id ?? '',
        options: [{ value: '', label: 'Веду сумму вручную' }, ...accountOptions(a => a.kind in MONEY_KINDS)] },
      { name: 'saved', label: 'Уже отложено, ₽ (если вручную)', required: false, value: g?.saved ?? '' },
    ],
    actions: isNew ? [] : [{ value: 'delete', label: 'Удалить цель' }],
  });
  if (!v) return null;
  if (v.$action === 'delete') return mutate(sb.from('goals').delete().eq('id', g.id), 'Цель удалена');
  const row = {
    name: v.name.trim(), target: num(v.target), deadline: v.deadline || null,
    account_id: v.account || null, saved: num(v.saved) ?? 0,
  };
  if (isNew) {
    const { data, error } = await sb.from('goals').insert({ ...row, owner_id: USER.id }).select().single();
    if (error) { toast(`Не сохранилось: ${error.message}`); return null; }
    return data;
  }
  return mutate(sb.from('goals').update(row).eq('id', g.id));
}

async function editWish(w) {
  const isNew = !w;
  const v = await form({
    title: isNew ? 'Хочу купить' : w.name,
    fields: [
      { name: 'name', label: 'Что', type: 'text', value: w?.name ?? '' },
      { name: 'price', label: 'Примерная цена, ₽', required: false, value: w?.price ?? '' },
      { name: 'url', label: 'Ссылка', type: 'text', required: false, value: w?.url ?? '' },
      { name: 'priority', label: 'Насколько хочется', type: 'select', value: w?.priority ?? 2,
        options: Object.entries(PRIORITY).map(([value, label]) => ({ value, label: cap(label) })) },
    ],
    actions: isNew ? [] : [
      ...(w.goal_id ? [] : [{ value: 'goal', label: 'Сделать целью' }]),
      ...(w.url ? [{ value: 'open', label: 'Открыть ссылку' }] : []),
      { value: 'bought', label: 'Куплено' },
      { value: 'delete', label: 'Удалить' },
    ],
  });
  if (!v) return;
  if (v.$action === 'open') return window.open(w.url, '_blank', 'noopener');
  if (v.$action === 'bought') return mutate(sb.from('wishlist_items').update({ bought_at: new Date().toISOString() }).eq('id', w.id), 'Отмечено как купленное');
  if (v.$action === 'delete') return mutate(sb.from('wishlist_items').delete().eq('id', w.id), 'Удалено');
  if (v.$action === 'goal') {
    const goal = await editGoal(null, { name: w.name, target: w.price });
    if (goal?.id) return mutate(sb.from('wishlist_items').update({ goal_id: goal.id }).eq('id', w.id), 'Цель создана');
    return;
  }
  const row = { name: v.name.trim(), price: num(v.price), url: v.url?.trim() || null, priority: Number(v.priority) };
  if (isNew) return mutate(sb.from('wishlist_items').insert({ ...row, owner_id: USER.id }), 'Добавлено');
  return mutate(sb.from('wishlist_items').update(row).eq('id', w.id));
}

async function editIncome(inc) {
  const isNew = !inc;
  const v = await form({
    title: isNew ? 'Регулярный доход' : inc.name,
    text: 'Если день выплаты выпадает на выходной, обычно платят в предыдущий рабочий день.',
    fields: [
      { name: 'name', label: 'Название', type: 'text', value: inc?.name ?? 'Зарплата' },
      { name: 'amount', label: 'Сумма на руки, ₽', value: inc?.amount ?? '' },
      { name: 'day', label: 'Число месяца (31 — последний день)', value: inc?.day_of_month ?? '' },
      { name: 'account', label: 'На какой счёт', type: 'select', required: false, value: inc?.account_id ?? '',
        options: [{ value: '', label: 'Не указан' }, ...accountOptions(a => a.kind in MONEY_KINDS)] },
      { name: 'shift', label: 'С выходных переносится', type: 'select', value: inc ? String(inc.shift_weekend) : 'true',
        options: [{ value: 'true', label: 'На пятницу' }, { value: 'false', label: 'Не переносится' }] },
    ],
    actions: isNew ? [] : [{ value: 'delete', label: 'Удалить' }],
  });
  if (!v) return;
  if (v.$action === 'delete') return mutate(sb.from('recurring_incomes').update({ is_active: false }).eq('id', inc.id), 'Удалено');
  const day = Math.round(num(v.day));
  if (!(day >= 1 && day <= 31)) return toast('Число месяца — от 1 до 31');
  const row = { name: v.name.trim(), amount: num(v.amount), day_of_month: day, account_id: v.account || null, shift_weekend: v.shift === 'true' };
  if (isNew) return mutate(sb.from('recurring_incomes').insert({ ...row, owner_id: USER.id }), 'Доход добавлен');
  return mutate(sb.from('recurring_incomes').update(row).eq('id', inc.id));
}

async function exportMonth() {
  const months = [...new Set([TODAY.slice(0, 7), ...RAW.txs.map(t => t.occurred_at.slice(0, 7))])].sort().reverse();
  const v = await form({ title: 'Выгрузка операций', text: 'Файл CSV открывается в Excel и Google Таблицах.', submit: 'Скачать', fields: [
    { name: 'month', label: 'Месяц', type: 'select', value: months[0], options: months.map(m => ({ value: m, label: E.monthName(m) })) },
    { name: 'account', label: 'Счёт', type: 'select', value: '', required: false, options: [{ value: '', label: 'Все счета' }, ...accountOptions()] },
  ] });
  if (!v || v.$action) return;
  const list = RAW.txs.filter(t => t.occurred_at.slice(0, 7) === v.month && (!v.account || t.account_id === v.account))
    .sort((a, b) => a.occurred_at.localeCompare(b.occurred_at));
  const KIND = { purchase: 'Расход', income: 'Доход', transfer_in: 'Перевод (приход)', transfer_out: 'Перевод (расход)', fee: 'Комиссия', interest: 'Проценты', repayment: 'Погашение', refund: 'Возврат', cash_withdrawal: 'Снятие наличных' };
  const cell = x => `"${String(x ?? '').replace(/"/g, '""')}"`;
  const money = x => Number(x).toFixed(2).replace('.', ',');
  const lines = [['Дата', 'Счёт', 'Тип', 'Категория', 'Комментарий', 'Сумма', 'Источник'].map(cell).join(';')];
  for (const t of list) {
    const a = RAW.acc.get(t.account_id);
    lines.push([t.occurred_at.slice(0, 10).split('-').reverse().join('.'), a ? accLabel(a) : '', KIND[t.kind] ?? t.kind,
      RAW.categories.find(c => c.id === t.category_id)?.name ?? '', t.merchant ?? '', money(t.amount), ({ manual: 'вручную', push: 'пуш', sms: 'SMS', statement: 'выписка', api: 'API' })[t.source] ?? t.source].map(cell).join(';'));
  }
  // Итоги по счетам — для сверки с выпиской банка.
  lines.push('', [cell('Итоги по счетам'), cell('Приход'), cell('Расход'), cell('Итого')].join(';'));
  const byAcc = new Map();
  for (const t of list) {
    const r = byAcc.get(t.account_id) ?? { inc: 0, exp: 0 };
    if (t.amount > 0) r.inc += Number(t.amount); else r.exp += Number(t.amount);
    byAcc.set(t.account_id, r);
  }
  for (const [id, r] of byAcc) lines.push([cell(accLabel(RAW.acc.get(id) || { name: '?' })), money(r.inc), money(r.exp), money(r.inc + r.exp)].join(';'));
  const blob = new Blob(['\ufeff' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `операции-${v.month}${v.account ? '-' + (RAW.acc.get(v.account)?.name ?? '') : ''}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  toast(`Выгружено операций: ${list.length}`);
}

async function ensureCategory(name) {
  const id = await categoryId(name);
  if (id && !RAW.categories.some(c => c.id === id)) RAW.categories.push({ id, name });
  return id;
}

async function setupBudget() {
  const rows = [];
  for (const [i, [name, grp, limit, rollover]] of BUDGET_TEMPLATE.entries()) {
    const category_id = await ensureCategory(name);
    if (category_id) rows.push({ owner_id: USER.id, category_id, grp, limit_amount: limit, rollover, sort: i });
  }
  return mutate(sb.from('budget_limits').upsert(rows, { onConflict: 'owner_id,category_id' }), 'Бюджет настроен');
}

async function editLimit(l) {
  const isNew = !l;
  const v = await form({
    title: isNew ? 'Категория бюджета' : catName(l.category_id),
    fields: [
      { name: 'name', label: 'Категория', type: 'text', value: isNew ? '' : catName(l.category_id), list: isNew ? RAW.categories.map(c => c.name) : undefined },
      { name: 'limit', label: 'Лимит в месяц, ₽', value: l ? budgetState().find(b => b.id === l.id)?.limit_amount : '' },
      { name: 'grp', label: 'Группа', type: 'select', value: l?.grp ?? 'need', options: Object.entries(GROUPS).map(([value, label]) => ({ value, label })) },
      { name: 'rollover', label: 'Остаток в конце месяца', type: 'select', value: l?.rollover ?? 'to_loan', options: Object.entries(ROLLOVER).map(([value, label]) => ({ value, label: cap(label) })) },
    ],
    actions: isNew ? [] : [{ value: 'delete', label: 'Убрать лимит' }],
  });
  if (!v) return;
  if (v.$action === 'delete') return mutate(sb.from('budget_limits').delete().eq('id', l.id), 'Лимит убран');
  const row = { limit_amount: num(v.limit), grp: v.grp, rollover: v.rollover };
  if (!row.limit_amount) return toast('Укажите лимит');
  if (isNew) {
    const category_id = await ensureCategory(v.name);
    if (!category_id) return;
    return mutate(sb.from('budget_limits').upsert({ ...row, owner_id: USER.id, category_id, sort: RAW.limits.length }, { onConflict: 'owner_id,category_id' }), 'Категория добавлена');
  }
  const newName = v.name.trim();
  if (newName && newName !== catName(l.category_id)) {
    if (RAW.categories.some(c => c.id !== l.category_id && c.name.toLowerCase() === newName.toLowerCase()))
      return toast('Категория с таким названием уже есть');
    const r = await sb.from('categories').update({ name: newName }).eq('id', l.category_id);
    if (r.error) return toast(`Не сохранилось: ${r.error.message}`);
  }
  const cur = budgetState().find(b => b.id === l.id);
  if (Math.abs(row.limit_amount - cur.limit_amount) > 0.5) {
    const r2 = await sb.from('budget_limits').update({ grp: row.grp, rollover: row.rollover }).eq('id', l.id);
    if (r2.error) return toast(`Не сохранилось: ${r2.error.message}`);
    return setLimits([{ l: { ...l, limit_amount: cur.limit_amount }, amount: row.limit_amount }]);
  }
  return mutate(sb.from('budget_limits').update({ grp: row.grp, rollover: row.rollover }).eq('id', l.id));
}

/** Меняет лимиты с текущего месяца; прошлые месяцы сохраняют старые значения. */
async function setLimits(changes) {
  const cur = ym(TODAY);
  const hist = [];
  for (const { l, amount } of changes) {
    const has = RAW.limitChanges.some(c => c.category_id === l.category_id);
    const start = ym(l.created_at);
    if (!has && start < cur) hist.push({ owner_id: USER.id, category_id: l.category_id, month: start, amount: Number(l.limit_amount) });
    hist.push({ owner_id: USER.id, category_id: l.category_id, month: cur, amount });
  }
  const r1 = await sb.from('budget_limit_changes').upsert(hist, { onConflict: 'category_id,month' });
  if (r1.error) return toast(`Не сохранилось: ${r1.error.message}`);
  const res = await Promise.all(changes.map(({ l, amount }) => sb.from('budget_limits').update({ limit_amount: amount }).eq('id', l.id)));
  const err = res.find(r => r.error);
  return mutate(Promise.resolve(err || { error: null }), 'Лимиты обновлены');
}

function distribute(bs, newTotal, mode) {
  const fixed = mode === 'keep_need' ? bs.filter(b => b.grp === 'need') : [];
  const flex = bs.filter(b => !fixed.includes(b));
  const target = newTotal - fixed.reduce((s, b) => s + b.limit_amount, 0);
  if (target < 0 || !flex.length) return null;
  const old = flex.reduce((s, b) => s + b.limit_amount, 0);
  const res = flex.map(b => ({ b, amount: Math.max(0, Math.round((old ? b.limit_amount * target / old : target / flex.length) / 100) * 100) }));
  const diff = target - res.reduce((s, r) => s + r.amount, 0);
  res.sort((x, y) => y.amount - x.amount)[0].amount += diff;
  return res;
}

async function editTotal() {
  const bs = budgetState();
  const total = bs.reduce((s, b) => s + b.limit_amount, 0);
  const need = bs.filter(b => b.grp === 'need').reduce((s, b) => s + b.limit_amount, 0);
  const v = await form({
    title: 'Лимит месяца', text: `Сейчас ${E.rub(total)}, из них обязательное ${E.rub(need)}. Новый лимит действует с текущего месяца.`,
    fields: [
      { name: 'total', label: 'Новый лимит, ₽', value: total },
      { name: 'mode', label: 'Как распределить', type: 'select', value: 'keep_need', options: [
        { value: 'keep_need', label: 'Обязательное не трогать, остальное пропорционально' },
        { value: 'all', label: 'Все категории пропорционально' }] },
    ],
    submit: 'Посчитать',
  });
  if (!v) return;
  const nt = num(v.total);
  if (!nt || nt <= 0) return toast('Укажите лимит');
  const plan = distribute(bs, nt, v.mode);
  if (!plan) return toast(`Обязательное (${E.rub(need)}) больше нового лимита: выберите «Все категории пропорционально»`);
  const rows = plan.filter(p => Math.abs(p.amount - p.b.limit_amount) > 0.5).sort((x, y) => bs.indexOf(x.b) - bs.indexOf(y.b));
  if (!rows.length) return toast('Лимиты не изменились');
  const ok = await form({
    title: `Новый лимит: ${E.rub(nt)}`,
    html: `<div>${rows.map(p => `<div class="item"><div class="item-title">${esc(p.b.name)}</div>
      <div class="item-amt"><span class="muted" style="font-weight:500">${E.rub(p.b.limit_amount)} →</span> ${E.rub(p.amount)}</div></div>`).join('')}</div>
      <p class="muted small" style="margin:0">Суммы округлены до 100 ₽. Любую категорию можно потом поправить вручную.</p>`,
    submit: 'Применить',
  });
  if (!ok || ok.$action) return;
  return setLimits(rows.map(p => ({ l: p.b, amount: p.amount })));
}

/** Перенос между конвертами. Источники по умолчанию: удовольствия → для себя → резерв. */
async function moveMoney(toCat) {
  const bs = budgetState();
  const target = toCat ? bs.find(b => b.category_id === toCat) : null;
  const order = { want: 0, big: 1, need: 2 };
  const sources = bs.filter(b => b.rem > 0.5 && b.category_id !== toCat)
    .sort((a, b) => order[a.grp] - order[b.grp] || (/резерв/i.test(a.name) ? 1 : 0) - (/резерв/i.test(b.name) ? 1 : 0));
  if (!sources.length) return toast('Нет категорий с остатком: перерасход перейдёт на следующий месяц');
  const need = target ? -target.rem : '';
  const v = await form({
    title: target ? `Покрыть: ${target.name}` : 'Перенос между категориями',
    text: target ? `Перерасход ${E.rub(-target.rem)}. Источники по порядку: удовольствия, для себя, резерв.` : '',
    fields: [
      { name: 'from', label: 'Откуда', type: 'select', value: sources[0].category_id,
        options: sources.map(b => ({ value: b.category_id, label: `${b.name}: осталось ${E.rub(b.rem)}` })) },
      ...(target ? [] : [{ name: 'to', label: 'Куда', type: 'select', options: bs.map(b => ({ value: b.category_id, label: b.name })) }]),
      { name: 'amount', label: 'Сумма, ₽', value: need ? Math.ceil(Math.min(need, sources[0].rem)) : '' },
    ],
    submit: 'Перенести',
  });
  if (!v) return;
  const to = target ? toCat : v.to;
  if (v.from === to) return toast('Выберите разные категории');
  return mutate(sb.from('budget_moves').insert({ owner_id: USER.id, month: ym(TODAY), from_category: v.from, to_category: to, amount: num(v.amount) }), 'Перенесено');
}

async function editEvent(e) {
  const isNew = !e;
  const v = await form({
    title: isNew ? 'Плановое событие' : e.name,
    text: 'Траты с категорией события не считаются перерасходом бюджета. Если добавить список подарков, сумма посчитается из него.',
    fields: [
      { name: 'name', label: 'Название', type: 'text', value: e?.name ?? '' },
      { name: 'date', label: 'Дата', type: 'date', value: e?.date ?? '' },
      { name: 'amount', label: 'Общая сумма, ₽ (если без списка)', required: false, value: e?.amount ?? '' },
      { name: 'yearly', label: 'Повторяется каждый год', type: 'select', value: String(e?.repeat_yearly ?? false), options: [{ value: 'false', label: 'Нет' }, { value: 'true', label: 'Да' }] },
    ],
    actions: isNew ? [] : [{ value: 'delete', label: 'Удалить событие' }],
  });
  if (!v) return;
  if (v.$action === 'delete') return mutate(sb.from('planned_events').delete().eq('id', e.id), 'Событие удалено');
  const row = { name: v.name.trim(), date: v.date, amount: num(v.amount), repeat_yearly: v.yearly === 'true' };
  if (isNew) {
    row.category_id = await ensureCategory(row.name);
    sessionStorage.setItem('planSeg', 'events');
    return mutate(sb.from('planned_events').insert({ ...row, owner_id: USER.id }), 'Событие создано');
  }
  return mutate(sb.from('planned_events').update(row).eq('id', e.id));
}

async function editItem(i, eventId) {
  const isNew = !i;
  const v = await form({
    title: isNew ? 'Подарок' : i.who,
    fields: [
      { name: 'who', label: 'Кому или что', type: 'text', value: i?.who ?? '' },
      { name: 'budget', label: 'Бюджет, ₽', required: false, value: i?.budget ?? '' },
    ],
    actions: isNew ? [] : [{ value: 'toggle', label: i.bought ? 'Не куплено' : 'Куплено' }, { value: 'delete', label: 'Удалить' }],
  });
  if (!v) return;
  if (v.$action === 'toggle') return mutate(sb.from('event_items').update({ bought: !i.bought }).eq('id', i.id), i.bought ? 'Снята отметка' : 'Отмечено как купленное');
  if (v.$action === 'delete') return mutate(sb.from('event_items').delete().eq('id', i.id), 'Удалено');
  const row = { who: v.who.trim(), budget: num(v.budget) };
  if (isNew) return mutate(sb.from('event_items').insert({ ...row, owner_id: USER.id, event_id: eventId }), 'Добавлено');
  return mutate(sb.from('event_items').update(row).eq('id', i.id));
}

const idsRow = v => ({
  last4: (v.last4 || '').replace(/\D/g, '').slice(-4) || null,
  card_aliases: String(v.aliases || '').split(/[,\s]+/).map(x => x.replace(/\D/g, '').slice(-4)).filter(x => x.length === 4),
});

async function editIds(a) {
  const v = await form({
    title: `${accLabel(a)}: номера`, text: 'По этим номерам уведомления банков и Mir Pay привязываются к счёту.',
    fields: [
      { name: 'last4', label: 'Последние 4 цифры карты', type: 'text', required: false, value: a.last4 ?? '' },
      { name: 'aliases', label: 'Другие номера через запятую (виртуальный в Mir Pay и т. п.)', type: 'text', required: false, value: (a.card_aliases ?? []).join(', ') },
      { name: 'push', label: 'Число в уведомлении после суммы — это', type: 'select', value: a.push_number ?? 'auto', options: [
        { value: 'auto', label: 'Определять автоматически' }, { value: 'available', label: 'Доступный кредитный лимит' },
        { value: 'spend_limit', label: 'Остаток моего лимита трат' }, { value: 'balance', label: 'Остаток на счёте' }, { value: 'none', label: 'Не использовать' }] },
    ],
  });
  if (!v) return;
  return mutate(sb.from('accounts').update({ ...idsRow(v), push_number: v.push }).eq('id', a.id));
}

async function editSettings() {
  const names = (RAW.settings?.own_names ?? []).join(', ');
  const token = RAW.tokens[0]?.token;
  const url = `${CFG.url}/functions/v1/ingest`;
  const v = await form({
    title: 'Настройки',
    html: `<div class="small" style="display:flex;flex-direction:column;gap:6px">
      <b>Приём уведомлений</b>
      <div class="muted">Адрес для MacroDroid:</div><code class="code">${esc(url)}</code>
      <div class="muted">Ключ:</div><code class="code">${token ? esc(token) : 'ещё не создан'}</code>
      <div class="muted">Ключ даёт право только добавлять уведомления. Никому его не отправляйте; если он утёк, создайте новый.</div></div>`,
    fields: [{ name: 'names', label: 'Мои имена в уведомлениях банков, через запятую', type: 'text', required: false, value: names }],
    actions: [{ value: 'token', label: token ? 'Новый ключ' : 'Создать ключ' }],
  });
  if (!v) return;
  if (v.$action === 'token') {
    const bytes = crypto.getRandomValues(new Uint8Array(24));
    const t = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
    await sb.from('ingest_tokens').delete().eq('owner_id', USER.id);
    const ok = await mutate(sb.from('ingest_tokens').insert({ owner_id: USER.id, token: t }), 'Ключ создан');
    if (ok) editSettings();
    return;
  }
  const own_names = String(v.names || '').split(',').map(x => x.trim()).filter(Boolean);
  return mutate(sb.from('user_settings').upsert({ owner_id: USER.id, own_names, updated_at: new Date().toISOString() }, { onConflict: 'owner_id' }));
}

async function handleRaw(r) {
  const v = await form({
    title: r.title || r.app, text: `${r.app}: ${r.body}`, submit: '',
    actions: [{ value: 'expense', label: 'Записать расход' }, { value: 'income', label: 'Записать доход' }, { value: 'ignore', label: 'Скрыть' }],
  });
  if (!v) return;
  await sb.from('raw_notifications').update({ status: 'ignored' }).eq('id', r.id);
  if (v.$action === 'ignore') { await load(); route(); return toast('Скрыто'); }
  const m = `${r.title} ${r.body}`.match(/(\d[\d\s\u00a0]*(?:[.,]\d{1,2})?)\s*(?:₽|RUB)/);
  return newTx(v.$action, null, { amount: m ? num(m[1]) : '' });
}

async function pairTransfer(t) {
  const a = RAW.acc.get(t.account_id);
  const v = await form({
    title: 'Перевод без пары', text: `${E.rub(Math.abs(t.amount))} ${t.amount < 0 ? 'со счёта' : 'на счёт'} «${a ? accLabel(a) : '?'}». Укажите второй счёт или поменяйте тип операции.`,
    fields: [{ name: 'other', label: t.amount < 0 ? 'Куда' : 'Откуда', type: 'select', options: accountOptions(x => x.id !== t.account_id) }],
    submit: 'Связать', actions: [{ value: t.amount < 0 ? 'purchase' : 'income', label: t.amount < 0 ? 'Это покупка' : 'Это доход' }, { value: 'delete', label: 'Удалить' }],
  });
  if (!v) return;
  if (v.$action === 'delete') return mutate(sb.from('transactions').delete().eq('id', t.id), 'Удалено');
  if (v.$action) return mutate(sb.from('transactions').update({ kind: v.$action }).eq('id', t.id), 'Тип изменён');
  const link = uid();
  const r1 = await sb.from('transactions').update({ link_id: link }).eq('id', t.id);
  if (r1.error) return toast(`Не сохранилось: ${r1.error.message}`);
  return mutate(sb.from('transactions').insert({
    account_id: v.other, occurred_at: t.occurred_at, amount: -Number(t.amount), kind: t.amount < 0 ? 'transfer_in' : 'transfer_out',
    source: 'manual', dedup_hash: `manual:${uid()}`, link_id: link,
  }), 'Перевод связан');
}

// ---------------------------------------------------------------- Сверка с выпиской
function pickFile(accept) {
  return new Promise(resolve => {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = accept;
    inp.onchange = () => resolve(inp.files[0] || null);
    inp.click();
  });
}

const findByCard = c => RAW.accounts.find(a => c && (a.last4 === c || (a.card_aliases ?? []).includes(c)));
const effect = (a, amount) => DEBT_KINDS.has(a.kind) ? -Number(amount) : Number(amount);

/** Значение счёта в приложении на конец дня `date`: текущее минус всё, что было позже. */
function valueAt(a, date) {
  return RAW.bal(a.id) - RAW.txs.filter(t => t.account_id === a.id && t.occurred_at.slice(0, 10) > date)
    .reduce((s, t) => s + effect(a, t.amount), 0);
}

function reconcile(st, a) {
  const txs = RAW.txs.filter(t => t.account_id === a.id);
  const used = new Set();
  const missing = [];
  for (const r of st.rows) {
    const hit = txs.find(t => !used.has(t.id) && Math.abs(Number(t.amount) - r.amount) < 0.01
      && Math.abs(E.diffDays(t.occurred_at.slice(0, 10), r.date)) <= 2);
    if (hit) used.add(hit.id); else missing.push(r);
  }
  const extra = txs.filter(t => !used.has(t.id) && t.source !== 'statement'
    && t.occurred_at.slice(0, 10) >= st.from && t.occurred_at.slice(0, 10) <= st.to);
  return { matched: used.size, missing, extra };
}

function statementValue(st, a) {
  if (!st.closing) return null;
  if (st.closing.kind === 'available') return a.credit_limit != null ? Number(a.credit_limit) - st.closing.value : null;
  return st.closing.value;
}

async function importStatement() {
  const file = await pickFile('application/pdf');
  if (!file) return;
  toast('Читаю выписку…');
  let st;
  try { st = parseStatement(await pdfLines(file)); }
  catch (e) { return toast(`Не удалось прочитать PDF: ${e.message}`); }
  if (!st || !st.rows.length) return toast('Не узнал формат выписки: пока поддерживаются Сбер и Т-Банк');

  let a = findByCard(st.last4) || st.rows.map(r => findByCard(r.card)).find(Boolean);
  if (!a) {
    const v = await form({ title: 'Чья это выписка?', text: `${st.bank}, ${st.rows.length} операций. Номер карты не найден среди ваших счетов.`,
      fields: [{ name: 'acc', label: 'Счёт', type: 'select', options: accountOptions(x => x.kind !== 'loan') }], submit: 'Дальше' });
    if (!v || v.$action) return;
    a = RAW.acc.get(v.acc);
  }
  const newCards = [...new Set(st.rows.map(r => r.card).filter(c => c && !findByCard(c)))];
  if (newCards.length) await sb.from('accounts').update({ card_aliases: [...(a.card_aliases ?? []), ...newCards] }).eq('id', a.id);

  const { matched, missing, extra } = reconcile(st, a);
  const sumOf = list => list.reduce((s, r) => s + Math.abs(Number(r.amount)), 0);
  const row = (date, title, amount) => `<div class="item"><div class="item-left"><div class="date-col">${E.ru(date)}</div>
    <div class="item-main"><div class="item-title">${esc(title)}</div></div></div><div class="item-amt">${amount > 0 ? '+' : '−'}${E.rub(Math.abs(amount))}</div></div>`;
  const v = await form({
    title: `Выписка: ${accLabel(a)}`,
    html: `<div class="small">
      <p class="muted" style="margin:0 0 8px">${E.ru(st.from)} — ${E.ru(st.to)} ${st.to.slice(0, 4)}. Операций в выписке: ${st.rows.length}, совпало с приложением: ${matched}.</p>
      ${missing.length ? `<b>Нет в приложении: ${missing.length} на ${E.rub(sumOf(missing))}</b>
        ${missing.slice(0, 8).map(r => row(r.date, r.merchant || r.desc, r.amount)).join('')}
        ${missing.length > 8 ? `<p class="muted">и ещё ${missing.length - 8}</p>` : ''}` : '<b>Все операции выписки уже есть в приложении.</b>'}
      ${extra.length ? `<div style="margin-top:8px"><b>Есть в приложении, нет в выписке: ${extra.length}</b>
        <p class="muted" style="margin:2px 0">Проверьте: это могут быть ошибки ввода или операции, которые банк ещё не провёл.</p>
        ${extra.slice(0, 5).map(t => row(t.occurred_at.slice(0, 10), t.merchant || 'Операция', Number(t.amount))).join('')}</div>` : ''}
      ${newCards.length ? `<p class="muted">Новые номера карты ${newCards.join(', ')} привязаны к этому счёту.</p>` : ''}
    </div>`,
    submit: missing.length ? `Добавить ${missing.length} и сверить остаток` : 'Сверить остаток',
  });
  if (!v || v.$action) return;

  if (missing.length) {
    const own = RAW.settings?.own_names ?? [];
    // Внутренние переводы на договор: договор — это ваш счёт в том же банке. Спрашиваем один раз и запоминаем.
    const contractAcc = new Map();
    for (const c of [...new Set(missing.map(r => r.contract).filter(Boolean))]) {
      let target = RAW.accounts.find(x => (x.card_aliases ?? []).includes(c));
      if (!target) {
        const guess = RAW.accounts.find(x => x.bank === a.bank && x.kind === 'debit' && x.id !== a.id);
        const q = await form({ title: `Договор ${c}`, text: 'В выписке есть переводы на этот договор. Какой это ваш счёт?',
          fields: [{ name: 'acc', label: 'Счёт', type: 'select', value: guess?.id, options: accountOptions(x => x.id !== a.id) }], submit: 'Запомнить' });
        if (!q || q.$action) continue;
        target = RAW.acc.get(q.acc);
        await sb.from('accounts').update({ card_aliases: [...(target.card_aliases ?? []), c] }).eq('id', target.id);
      }
      contractAcc.set(c, target);
    }
    const rules = new Map(RAW.categoryRules.map(r => [r.pattern, r.category_id]));
    const catByName = n => RAW.categories.find(c => c.name.toLowerCase() === (n || '').toLowerCase())?.id ?? null;
    const rows = [];
    missing.forEach((r, i) => {
      const k = rowKind(r, own);
      // created_at = время операции: исторические операции уже учтены в прежних сверках остатка
      const base = { account_id: a.id, occurred_at: `${r.date}T${r.time}:00+03:00`, created_at: `${r.date}T${r.time}:00+03:00`, amount: r.amount, merchant: r.merchant || r.desc,
        source: 'statement', raw_text: r.desc, dedup_hash: `stmt:${r.date}:${r.time}:${r.amount}:${i}` };
      const to = k === 'transfer_out_contract' ? contractAcc.get(r.contract) : null;
      if (to) {
        const link = uid();
        rows.push({ ...base, kind: 'transfer_out', link_id: link, merchant: null });
        rows.push({ ...base, account_id: to.id, amount: -r.amount, kind: 'transfer_in', link_id: link, merchant: null, dedup_hash: `${base.dedup_hash}:pair` });
      } else if (k === 'transfer_out_contract') rows.push({ ...base, kind: 'transfer_out' });
      else rows.push({ ...base, kind: k, category_id: k === 'purchase' ? (rules.get((r.merchant || '').toLowerCase()) ?? catByName(BANK_CATEGORY_MAP[r.category])) : null });
    });
    const { error } = await sb.from('transactions').insert(rows);
    if (error) return toast(`Не сохранилось: ${error.message}`);
  }
  await load();
  const target = statementValue(st, a);
  if (target != null) {
    const acc = RAW.acc.get(a.id);
    const appAt = valueAt(acc, st.closing.date);
    const diff = target - appAt;
    if (Math.abs(diff) >= 0.01) {
      const label = DEBT_KINDS.has(acc.kind) ? 'Долг' : 'Остаток';
      const ok = await form({ title: 'Сверка остатка', submit: 'Исправить по выписке',
        text: `${label} на ${E.ru(st.closing.date)}: по выписке ${E.rub(target)}, в приложении ${E.rub(appAt)}. Разница ${diff > 0 ? '+' : '−'}${E.rub(Math.abs(diff))}.` });
      if (ok && !ok.$action) return mutate(sb.from('balance_snapshots').insert({ account_id: acc.id, balance: RAW.bal(acc.id) + diff, source: 'statement' }), 'Остаток сверен');
    } else toast('Остаток сходится с выпиской до копейки');
  }
  route();
}

$app.addEventListener('input', e => {
  if (e.target.id !== 'prepay') return;
  const l = STATE.loans.find(x => x.id === e.target.dataset.loanId);
  const v = num(e.target.value);
  if (l && v && v > 0 && v < l.balance) {
    sessionStorage.setItem('prepay', String(v));
    document.getElementById('cmp').innerHTML = cmpHtml(l, v);
  }
});

$app.addEventListener('click', async e => {
  const el = e.target.closest('button');
  if (!el) return;
  const d = el.dataset;

  if (el.id === 'logout') { await sb.auth.signOut(); return renderLogin(); }
  if (d.seg) { sessionStorage.setItem('planSeg', d.seg); return route(); }
  if (d.budgetSetup !== undefined) return setupBudget();
  if (d.total !== undefined) return editTotal();
  if (d.limit) return editLimit(RAW.limits.find(l => l.id === d.limit));
  if (d.newLimit !== undefined) return editLimit(null);
  if (d.cover) return moveMoney(d.cover);
  if (d.move !== undefined) return moveMoney(null);
  if (d.newEvent !== undefined) return editEvent(null);
  if (d.event) return editEvent(RAW.events.find(e => e.id === d.event));
  if (d.addItem) return editItem(null, d.addItem);
  if (d.item) return editItem(RAW.eventItems.find(i => i.id === d.item));
  if (d.newTx) return newTx(d.newTx);
  if (d.newIncome !== undefined) return editIncome(null);
  if (d.income) return editIncome(RAW.incomes.find(i => i.id === d.income));
  if (d.export !== undefined) return exportMonth();
  if (d.receive) {
    const inc = RAW.incomes.find(i => i.id === d.receive);
    return newTx('income', null, { amount: inc.amount, account: inc.account_id, category: inc.name, recurring: inc.id });
  }
  if (d.tx) {
    const t = RAW.txs.find(x => x.id === d.tx);
    if (t.link_id) {
      const v = await form({ title: 'Перевод', text: `${E.rub(Math.abs(t.amount))}, ${E.ru(t.occurred_at.slice(0, 10))}`, submit: '', actions: [{ value: 'delete', label: 'Удалить перевод' }] });
      if (v?.$action === 'delete') return mutate(sb.from('transactions').delete().eq('link_id', t.link_id), 'Удалено');
      return;
    }
    if (t.kind?.startsWith('transfer')) return pairTransfer(t);
    return newTx(t.amount > 0 ? 'income' : 'expense', t);
  }
  if (d.settings !== undefined) return editSettings();
  if (d.statement !== undefined) return importStatement();
  if (d.raw) return handleRaw(RAW.unparsed.find(r => r.id === d.raw));
  if (d.newAcc !== undefined) return editAccount(null);
  if (d.acc) return editAccount(RAW.acc.get(d.acc));
  if (d.newGoal !== undefined) { const g = await editGoal(null); if (g) { await load(); route(); toast('Цель создана'); } return; }
  if (d.goal) return editGoal(RAW.goals.find(g => g.id === d.goal));
  if (d.newWish !== undefined) return editWish(null);
  if (d.wish) return editWish(RAW.wishlist.find(w => w.id === d.wish));

  if (d.debt) {
    const v = await form({ title: 'Текущий долг', text: 'Сумма долга из приложения банка.', fields: [{ name: 'debt', label: 'Долг, ₽', value: Math.round(RAW.bal(d.debt) * 100) / 100 }],
      actions: [{ value: 'ids', label: 'Номера карты' }] });
    if (v?.$action === 'ids') return editIds(RAW.acc.get(d.debt));
    if (v && !v.$action && num(v.debt) != null) mutate(sb.from('balance_snapshots').insert({ account_id: d.debt, balance: num(v.debt), source: 'manual' }));
  }

  if (d.addBucket) {
    const t = RAW.terms.find(x => x.account_id === d.addBucket);
    const v = await form({ title: 'Срок без процентов', fields: [
      { name: 'due', label: 'Внести до', type: 'date' },
      { name: 'amount', label: 'Сумма, ₽' },
    ], submit: 'Добавить' });
    if (v && num(v.amount)) mutate(sb.from('grace_buckets').upsert(
      { account_id: d.addBucket, source: SOURCE[t.grace_type], due_date: v.due, amount: num(v.amount), is_exact: true, status: 'open', paid_amount: 0 },
      { onConflict: 'account_id,source,due_date' }), 'Срок добавлен');
  }

  if (d.bucket) {
    const b = RAW.buckets.find(x => x.id === d.bucket);
    const v = await form({ title: 'Срок без процентов', actions: [{ value: 'paid', label: 'Оплачено' }], fields: [
      { name: 'due', label: 'Внести до', type: 'date', value: b.due_date },
      { name: 'amount', label: 'Сумма, ₽', value: b.amount },
    ] });
    if (v?.$action === 'paid') mutate(sb.from('grace_buckets').update({ status: 'paid' }).eq('id', b.id), 'Отмечено как оплаченное');
    else if (v && num(v.amount)) mutate(sb.from('grace_buckets').update({ due_date: v.due, amount: num(v.amount), is_exact: true, updated_at: new Date().toISOString() }).eq('id', b.id));
  }

  if (d.inst) {
    const p = STATE.installments.find(x => x.id === d.inst);
    const v = await form({ title: p.name, fields: [
      { name: 'debt', label: 'Общий долг, ₽', value: p.debt },
      { name: 'date', label: 'Следующий платёж', type: 'date', value: p.nextDate },
      { name: 'amount', label: 'Сумма платежа, ₽', value: p.nextAmount },
    ] });
    if (v) {
      const r1 = await sb.from('installment_plans').update({ next_payment_date: v.date, next_payment_amount: num(v.amount) }).eq('account_id', d.inst);
      if (r1.error) return toast(`Не сохранилось: ${r1.error.message}`);
      mutate(sb.from('balance_snapshots').insert({ account_id: d.inst, balance: num(v.debt), source: 'manual' }));
    }
  }

  if (d.loan) {
    const l = STATE.loans.find(x => x.id === d.loan);
    const v = await form({ title: 'Кредит', fields: [
      { name: 'balance', label: 'Остаток долга, ₽', value: Math.round(l.balance * 100) / 100 },
      { name: 'payment', label: 'Ежемесячный платёж, ₽', value: l.payment },
      { name: 'remaining', label: 'Осталось платежей', value: l.remaining },
      { name: 'next', label: 'Следующий платёж', type: 'date', value: l.nextDate },
      { name: 'rate', label: 'Ставка, % годовых (если знаете)', value: l.rateAnnual ?? '', required: false },
    ] });
    if (v) {
      const r1 = await sb.from('loans').update({
        payment_amount: num(v.payment), remaining_payments: Math.round(num(v.remaining)),
        next_payment_date: v.next, rate_annual: v.rate ? num(v.rate) : null,
      }).eq('account_id', d.loan);
      if (r1.error) return toast(`Не сохранилось: ${r1.error.message}`);
      mutate(sb.from('balance_snapshots').insert({ account_id: d.loan, balance: num(v.balance), source: 'manual' }));
    }
  }
});

// ---------------------------------------------------------------- вход
function renderLogin(message = '') {
  $tabs.hidden = true;
  $app.innerHTML = `
    <form class="center" id="login">
      <h1>Финансы</h1>
      <label class="field">Почта<input type="email" name="email" autocomplete="username" required></label>
      <label class="field">Пароль<input type="password" name="password" autocomplete="current-password" required></label>
      ${message ? `<p class="error">${esc(message)}</p>` : ''}
      <button class="btn">Войти</button>
    </form>`;
  document.getElementById('login').addEventListener('submit', async e => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const { data, error } = await sb.auth.signInWithPassword({ email: String(fd.get('email')).trim(), password: fd.get('password') });
    if (error) return renderLogin(error.message === 'Invalid login credentials' ? 'Неверная почта или пароль.' : error.message);
    USER = data.user;
    start();
  });
}

async function start() {
  try { await load(); route(); }
  catch (err) {
    $tabs.hidden = true;
    $app.innerHTML = `<div class="center"><h1>Нет связи с базой</h1>
      <p class="muted">${esc(err.message || err)}</p>
      <p class="muted small">Проверьте интернет и что проект Supabase не на паузе, затем обновите страницу.</p>
      <button class="btn" onclick="location.reload()">Обновить</button></div>`;
  }
}

window.addEventListener('hashchange', () => { if (STATE) { route(); window.scrollTo(0, 0); } });

(async () => {
  if (!configured) {
    $app.innerHTML = `<div class="center"><h1>Нужна настройка</h1>
      <p class="muted">Откройте файл config.js и вставьте адрес проекта Supabase и publishable-ключ.</p></div>`;
    return;
  }
  const { data: { session } } = await sb.auth.getSession();
  if (session) { USER = session.user; start(); } else renderLogin();
})();
