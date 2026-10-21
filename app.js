import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';
import * as E from './engine.js';

const CFG = window.FIN_CONFIG || {};
const configured = CFG.url && !CFG.url.includes('YOUR-PROJECT') && CFG.key && !CFG.key.includes('YOUR-');
const sb = configured ? createClient(CFG.url, CFG.key) : null;

const $app = document.getElementById('app');
const $tabs = document.getElementById('tabs');
const $dlg = document.getElementById('dlg');

const TODAY = E.todayISO();
const HORIZON = E.monthDay(TODAY, 4, 31);

let RAW = null;    // строки из БД
let STATE = null;  // вход движка
let CAL = [];      // календарь

// ---------------------------------------------------------------- утилиты
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = s => { const v = parseFloat(String(s).replace(/\s|\u00a0/g, '').replace(',', '.')); return Number.isFinite(v) ? v : null; };
const plural = (n, a, b, c) => { const m = n % 10, h = n % 100; return m === 1 && h !== 11 ? a : m >= 2 && m <= 4 && (h < 10 || h >= 20) ? b : c; };
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
const pct = v => `${Number(v).toFixed(1).replace('.', ',')}%`;
const inDays = d => { const n = E.diffDays(TODAY, d); return n === 0 ? 'сегодня' : n === 1 ? 'завтра' : n < 0 ? `${-n} ${plural(-n, 'день', 'дня', 'дней')} назад` : `через ${n} ${plural(n, 'день', 'дня', 'дней')}`; };

function toast(text) {
  const t = document.createElement('div');
  t.className = 'toast'; t.textContent = text; t.setAttribute('role', 'status');
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2200);
}

function form({ title, fields, submit = 'Сохранить', danger }) {
  $dlg.innerHTML = `
    <form method="dialog">
      <h2>${esc(title)}</h2>
      ${fields.map(f => `
        <label class="field">${esc(f.label)}
          <input name="${f.name}" type="${f.type || 'text'}" ${f.type ? '' : 'inputmode="decimal"'}
                 value="${esc(f.value ?? '')}" ${f.required === false ? '' : 'required'}>
        </label>`).join('')}
      <p class="error" id="dlg-err" hidden></p>
      <div class="btns">
        <button class="btn" value="ok">${esc(submit)}</button>
        ${danger ? `<button class="btn ghost" value="danger" formnovalidate>${esc(danger)}</button>` : ''}
        <button class="btn ghost" value="cancel" formnovalidate>Отмена</button>
      </div>
    </form>`;
  $dlg.showModal();
  return new Promise(resolve => {
    $dlg.addEventListener('close', () => {
      const v = $dlg.returnValue;
      if (v === 'cancel' || !v) return resolve(null);
      if (v === 'danger') return resolve({ $danger: true });
      const fd = new FormData($dlg.querySelector('form'));
      resolve(Object.fromEntries(fd.entries()));
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
    sb.from('accounts').select('*').eq('is_archived', false),
    sb.from('balance_snapshots').select('*').order('at', { ascending: false }),
    sb.from('card_terms').select('*'),
    sb.from('grace_buckets').select('*').eq('status', 'open').order('due_date'),
    sb.from('loans').select('*'),
    sb.from('installment_plans').select('*'),
  ]);
  const err = all.find(r => r.error);
  if (err) throw err.error;
  const [accounts, snaps, terms, buckets, loans, plans] = all.map(r => r.data);

  const acc = new Map(accounts.map(a => [a.id, a]));
  const latest = new Map();
  for (const s of snaps) if (!latest.has(s.account_id)) latest.set(s.account_id, s);
  const bal = id => Number(latest.get(id)?.balance ?? 0);

  RAW = { accounts, acc, latest, terms, buckets, loans, plans };

  STATE = {
    cards: terms.filter(t => acc.has(t.account_id)).map(t => {
      const a = acc.get(t.account_id);
      return {
        id: a.id, name: a.bank, limit: Number(a.credit_limit ?? 0), debt: bal(a.id),
        rate: Number(t.rate_purchase),
        terms: {
          graceType: t.grace_type,
          statementDay: t.statement_day ?? 31,
          payWindowDays: t.pay_window_days,
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

const staleNote = id => {
  const s = RAW.latest.get(id);
  if (!s) return 'долг не указан';
  const d = E.diffDays(s.at.slice(0, 10), TODAY);
  return d === 0 ? 'обновлено сегодня' : `обновлено ${d} ${plural(d, 'день', 'дня', 'дней')} назад`;
};

// ---------------------------------------------------------------- навигация
const ICONS = {
  overview: '<path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
  cards: '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20"/>',
  loan: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
};
const TABS = [['overview', 'Обзор'], ['cards', 'Карты'], ['loan', 'Кредит'], ['calendar', 'Календарь']];

function renderTabs(current) {
  $tabs.hidden = false;
  $tabs.innerHTML = `<div>${TABS.map(([id, label]) => `
    <a href="#${id}" ${id === current ? 'aria-current="page"' : ''}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[id]}</svg>
      ${label}</a>`).join('')}</div>`;
}

function route() {
  const id = (location.hash || '#overview').slice(1);
  const view = { overview: viewOverview, cards: viewCards, loan: viewLoan, calendar: viewCalendar }[id] || viewOverview;
  renderTabs(id in { overview: 1, cards: 1, loan: 1, calendar: 1 } ? id : 'overview');
  $app.innerHTML = view();
  window.scrollTo(0, 0);
}

// ---------------------------------------------------------------- экраны
function obligationRow(o, { withDate = true, strip = '' } = {}) {
  const title = strip && o.title.startsWith(strip + ': ') ? cap(o.title.slice(strip.length + 2)) : o.title;
  return `<div class="item ${o.counts ? '' : 'dim'}">
    <div class="item-left">
      ${withDate ? `<div class="date-col">${E.ru(o.date)}</div>` : ''}
      <div class="item-main">
        <div class="item-title">${esc(title)}</div>
        ${o.note ? `<div class="item-note">${esc(o.note)}</div>` : ''}
      </div>
    </div>
    <div class="item-amt ${o.exact ? '' : 'est'}">${o.counts ? '' : '('}${E.rub(o.amount)}${o.counts ? '' : ')'}</div>
  </div>`;
}

function viewOverview() {
  const upcoming = CAL.filter(o => o.counts && o.date >= TODAY);
  const next = upcoming[0];
  const in30 = E.addDays(TODAY, 30);
  const soon = upcoming.filter(o => o.date <= in30);
  const months = [...E.loadByMonth(CAL)].slice(0, 4);
  const max = Math.max(1, ...months.map(([, v]) => v));

  const debts = [
    ...STATE.loans.map(l => ({ name: l.name, debt: l.balance, id: l.id })),
    ...STATE.cards.map(c => ({ name: `${c.name}, кредитка`, debt: c.debt, limit: c.limit, id: c.id })),
    ...STATE.installments.map(p => ({ name: p.name, debt: p.debt, limit: p.limit, id: p.id })),
  ].sort((a, b) => b.debt - a.debt);
  const total = debts.reduce((s, d) => s + d.debt, 0);

  const funding = STATE.installments.filter(p => p.fundingAccount && p.nextDate && E.diffDays(TODAY, p.nextDate) <= 7);

  return `
    <div class="top"><h1>Обзор</h1><button class="icon-btn" id="logout">Выйти</button></div>
    <div class="stack">
      ${next ? `
      <section class="next" aria-label="Ближайший платёж">
        <div class="next-date"><span class="next-day">${E.parse(next.date).getUTCDate()}</span><span class="next-mon">${E.ru(next.date).split(' ')[1]}</span></div>
        <div>
          <div class="next-amt">${next.exact ? '' : '≈ '}${E.rub(next.amount)}</div>
          <div class="next-what">${esc(next.title)}</div>
          <div class="next-note">${inDays(next.date)}</div>
        </div>
      </section>` : `<section class="panel"><h2>Платежей не запланировано</h2><p class="muted small">Добавьте долги и сроки на вкладке «Карты».</p></section>`}

      ${funding.map(p => `<div class="notice">До ${E.ru(p.nextDate)} пополните счёт «${esc(p.fundingAccount)}» на ${E.rub(p.nextAmount)}: ${esc(p.name)} списывается автоматически.</div>`).join('')}

      <section class="panel">
        <div class="panel-head"><h2>Следующие 30 дней</h2><a class="btn link" href="#calendar">Весь календарь</a></div>
        ${soon.map(o => obligationRow(o)).join('') || '<p class="muted small">Ничего не нужно платить.</p>'}
        ${soon.length ? `<div class="total"><span>Итого</span><span>${E.rub(soon.reduce((s, o) => s + o.amount, 0))}</span></div>` : ''}
      </section>

      <section class="panel">
        <h2>Нагрузка по месяцам</h2>
        <div class="months">
          ${months.map(([m, v]) => `
            <div class="month">
              <div class="month-val">${Math.round(v / 1000)} тыс.</div>
              <div class="month-bar" style="height:${Math.max(4, Math.round(v / max * 64))}px"></div>
              <div class="month-label">${E.monthName(m).split(' ')[0]}</div>
            </div>`).join('')}
        </div>
      </section>

      <section class="panel">
        <h2>Долги</h2>
        ${debts.map(d => `
          <div class="item">
            <div class="item-main">
              <div class="item-title">${esc(d.name)}</div>
              <div class="item-note">${d.limit ? `лимит ${E.rub(d.limit)}, ` : ''}${staleNote(d.id)}</div>
            </div>
            <div class="item-amt">${E.rub(d.debt)}</div>
          </div>`).join('')}
        <div class="total"><span>Всего</span><span>${E.rub(total)}</span></div>
      </section>
    </div>`;
}

const GRACE_LABEL = {
  per_statement: 'Без процентов, если до срока погасить сумму по выписке',
  monthly_cohort: 'Покупки месяца без процентов до конца третьего месяца после',
  per_tranche: 'У каждой покупки свой срок без процентов',
};

function viewCards() {
  const cards = STATE.cards.map(c => {
    const t = RAW.terms.find(x => x.account_id === c.id);
    const obl = CAL.filter(o => o.account === c.id);
    const used = c.limit ? Math.min(100, c.debt / c.limit * 100) : 0;
    return `
      <section class="panel">
        <div class="panel-head"><h2>${esc(c.name)}</h2><span class="badge">${pct(c.rate)} вне льготы</span></div>
        <div class="row"><b>${E.rub(c.debt)}</b><span class="muted small">из ${E.rub(c.limit)}</span></div>
        <div class="meter"><div style="width:${used}%"></div></div>
        <div class="item-note">${esc(GRACE_LABEL[t.grace_type])}. ${cap(staleNote(c.id))}.</div>
        <div style="margin-top:8px">${obl.map(o => obligationRow(o, { strip: c.name })).join('') || '<p class="muted small">Платежей нет.</p>'}</div>
        ${c.buckets.length ? `<div class="small muted" style="margin-top:8px">Сроки из приложения банка: нажмите, чтобы изменить</div>
          ${c.buckets.map(b => `<button class="item btn ghost small" style="width:100%;margin-top:6px" data-bucket="${b.id}" data-acc="${c.id}">
            <span>до ${E.ru(b.due)}</span><span>${E.rub(b.amount)}</span></button>`).join('')}` : ''}
        <div class="btns">
          <button class="btn small" data-debt="${c.id}">Обновить долг</button>
          <button class="btn ghost small" data-add-bucket="${c.id}">Добавить срок</button>
        </div>
      </section>`;
  });
  const inst = STATE.installments.map(p => `
    <section class="panel">
      <div class="panel-head"><h2>${esc(p.name)}</h2><span class="badge">рассрочка</span></div>
      <div class="row"><b>${E.rub(p.debt)}</b><span class="muted small">из ${E.rub(p.limit)}</span></div>
      <div class="meter"><div style="width:${p.limit ? Math.min(100, p.debt / p.limit * 100) : 0}%"></div></div>
      <div class="item-note">Платёж раз в ${p.periodDays} дней${p.fundingAccount ? `, списывается с «${esc(p.fundingAccount)}»` : ''}. ${cap(staleNote(p.id))}.</div>
      <div style="margin-top:8px">${CAL.filter(o => o.account === p.id).map(o => obligationRow({ ...o, title: 'Платёж' })).join('')}</div>
      <div class="btns"><button class="btn small" data-inst="${p.id}">Обновить</button></div>
    </section>`);
  return `<div class="top"><h1>Карты</h1></div><div class="stack">${cards.join('')}${inst.join('')}</div>`;
}

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

function viewLoan() {
  const l = STATE.loans[0];
  if (!l) return `<div class="top"><h1>Кредит</h1></div><p class="muted">Кредитов нет.</p>`;
  const { rate, estimated } = E.loanRateAnnual(l);
  const rows = E.loanSchedule(l, 6);
  const amount = Number(sessionStorage.getItem('prepay') || 100000);
  const lastDate = E.monthDay(l.nextDate, l.remaining - 1, l.payDay);
  return `
    <div class="top"><h1>Кредит</h1><button class="btn ghost small" data-loan="${l.id}">Изменить</button></div>
    <div class="stack">
      <section class="panel">
        <div class="muted small">${esc(l.name)}, ${staleNote(l.id)}</div>
        <div style="font-size:30px;font-weight:800;letter-spacing:-0.5px">${E.rub(l.balance)}</div>
        <div class="kv">
          <div><span>Платёж</span><b>${E.rub(l.payment)}</b></div>
          <div><span>Ставка</span><b>${pct(rate * 100)}${estimated ? ' (оценка)' : ''}</b></div>
          <div><span>Осталось</span><b>${l.remaining} ${plural(l.remaining, 'платёж', 'платежа', 'платежей')}</b></div>
          <div><span>Последний</span><b>${E.monthName(lastDate.slice(0, 7)).toLowerCase()}</b></div>
        </div>
      </section>

      <section class="panel">
        <h2>Досрочное погашение</h2>
        <label class="field" style="margin-top:8px">Сумма
          <input type="text" inputmode="decimal" id="prepay" value="${amount}">
        </label>
        <div id="cmp">${cmpHtml(l, amount)}</div>
        <p class="muted small" style="margin:10px 0 0">Экономия на процентах за весь срок. Расчёт приблизительный${estimated ? ': ставка оценена по остатку и платежу' : ''}.</p>
      </section>

      <section class="panel">
        <h2>Ближайшие платежи</h2>
        <table class="sched">
          <thead><tr><th>Дата</th><th>Проценты</th><th>Долг</th><th>Остаток</th></tr></thead>
          <tbody>${rows.map(r => `<tr><td>${E.ru(r.date)}</td><td>${E.rub(r.interest)}</td><td>${E.rub(r.principal)}</td><td>${E.rub(r.balance)}</td></tr>`).join('')}</tbody>
        </table>
      </section>
    </div>`;
}

function viewCalendar() {
  const byMonth = new Map();
  for (const o of CAL.filter(o => o.date >= TODAY)) {
    const k = o.date.slice(0, 7);
    if (!byMonth.has(k)) byMonth.set(k, []);
    byMonth.get(k).push(o);
  }
  return `
    <div class="top"><h1>Календарь</h1></div>
    <p class="muted small" style="margin-top:-8px">≈ — прогноз, уточнится по выписке. В скобках — минимальные платежи, которые уже входят в другой платёж.</p>
    <div class="stack">
      ${[...byMonth].map(([m, list]) => `
        <section class="panel">
          <h2>${E.monthName(m)}</h2>
          ${list.map(o => obligationRow(o)).join('')}
          <div class="total"><span>За месяц</span><span>${E.rub(list.filter(o => o.counts).reduce((s, o) => s + o.amount, 0))}</span></div>
        </section>`).join('')}
    </div>`;
}

// ---------------------------------------------------------------- действия
const SOURCE = { per_statement: 'statement', monthly_cohort: 'cohort', per_tranche: 'tranche' };

$app.addEventListener('input', e => {
  if (e.target.id !== 'prepay') return;
  const v = num(e.target.value);
  const l = STATE.loans[0];
  if (v && v > 0 && v < l.balance) {
    sessionStorage.setItem('prepay', String(v));
    document.getElementById('cmp').innerHTML = cmpHtml(l, v);
  }
});

$app.addEventListener('click', async e => {
  const el = e.target.closest('button');
  if (!el) return;

  if (el.id === 'logout') { await sb.auth.signOut(); return renderLogin(); }

  if (el.dataset.debt) {
    const id = el.dataset.debt;
    const v = await form({ title: 'Текущий долг', fields: [{ name: 'debt', label: 'Сумма долга, ₽', value: RAW.latest.get(id)?.balance ?? '' }] });
    if (v && num(v.debt) != null) mutate(sb.from('balance_snapshots').insert({ account_id: id, balance: num(v.debt), source: 'manual' }));
  }

  if (el.dataset.addBucket) {
    const id = el.dataset.addBucket;
    const t = RAW.terms.find(x => x.account_id === id);
    const v = await form({ title: 'Срок без процентов', fields: [
      { name: 'due', label: 'Внести до', type: 'date', value: '' },
      { name: 'amount', label: 'Сумма, ₽', value: '' },
    ], submit: 'Добавить' });
    if (v && num(v.amount)) mutate(sb.from('grace_buckets').upsert(
      { account_id: id, source: SOURCE[t.grace_type], due_date: v.due, amount: num(v.amount), is_exact: true, status: 'open', paid_amount: 0 },
      { onConflict: 'account_id,source,due_date' }), 'Срок добавлен');
  }

  if (el.dataset.bucket) {
    const b = RAW.buckets.find(x => x.id === el.dataset.bucket);
    const v = await form({ title: 'Срок без процентов', danger: 'Оплачено', fields: [
      { name: 'due', label: 'Внести до', type: 'date', value: b.due_date },
      { name: 'amount', label: 'Сумма, ₽', value: b.amount },
    ] });
    if (v?.$danger) mutate(sb.from('grace_buckets').update({ status: 'paid' }).eq('id', b.id), 'Отмечено как оплаченное');
    else if (v && num(v.amount)) mutate(sb.from('grace_buckets').update({ due_date: v.due, amount: num(v.amount), is_exact: true, updated_at: new Date().toISOString() }).eq('id', b.id));
  }

  if (el.dataset.inst) {
    const id = el.dataset.inst;
    const p = STATE.installments.find(x => x.id === id);
    const v = await form({ title: p.name, fields: [
      { name: 'debt', label: 'Общий долг, ₽', value: p.debt },
      { name: 'date', label: 'Следующий платёж', type: 'date', value: p.nextDate },
      { name: 'amount', label: 'Сумма платежа, ₽', value: p.nextAmount },
    ] });
    if (v) {
      const r1 = await sb.from('installment_plans').update({ next_payment_date: v.date, next_payment_amount: num(v.amount) }).eq('account_id', id);
      if (r1.error) return toast(`Не сохранилось: ${r1.error.message}`);
      mutate(sb.from('balance_snapshots').insert({ account_id: id, balance: num(v.debt), source: 'manual' }));
    }
  }

  if (el.dataset.loan) {
    const id = el.dataset.loan;
    const l = STATE.loans.find(x => x.id === id);
    const v = await form({ title: 'Кредит', fields: [
      { name: 'balance', label: 'Остаток долга, ₽', value: l.balance },
      { name: 'payment', label: 'Ежемесячный платёж, ₽', value: l.payment },
      { name: 'remaining', label: 'Осталось платежей', value: l.remaining },
      { name: 'next', label: 'Следующий платёж', type: 'date', value: l.nextDate },
      { name: 'rate', label: 'Ставка, % годовых (если знаете)', value: l.rateAnnual ?? '', required: false },
    ] });
    if (v) {
      const r1 = await sb.from('loans').update({
        payment_amount: num(v.payment), remaining_payments: Math.round(num(v.remaining)),
        next_payment_date: v.next, rate_annual: v.rate ? num(v.rate) : null,
      }).eq('account_id', id);
      if (r1.error) return toast(`Не сохранилось: ${r1.error.message}`);
      mutate(sb.from('balance_snapshots').insert({ account_id: id, balance: num(v.balance), source: 'manual' }));
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
    const { error } = await sb.auth.signInWithPassword({ email: fd.get('email'), password: fd.get('password') });
    if (error) return renderLogin(error.message === 'Invalid login credentials' ? 'Неверная почта или пароль.' : error.message);
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

window.addEventListener('hashchange', () => { if (STATE) route(); });

(async () => {
  if (!configured) {
    $app.innerHTML = `<div class="center"><h1>Нужна настройка</h1>
      <p class="muted">Откройте файл config.js и вставьте адрес проекта Supabase и publishable-ключ.</p></div>`;
    return;
  }
  const { data: { session } } = await sb.auth.getSession();
  if (session) start(); else renderLogin();
})();
