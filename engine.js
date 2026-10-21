// Движок календаря платежей (браузерная версия engine/*.ts).
// Даты — строки 'YYYY-MM-DD' в UTC.

// ---------- даты ----------
export const parse = d => { const [y, m, dd] = d.split('-').map(Number); return new Date(Date.UTC(y, m - 1, dd)); };
export const fmt = d => d.toISOString().slice(0, 10);
export const addDays = (d, n) => { const x = parse(d); x.setUTCDate(x.getUTCDate() + n); return fmt(x); };
export const monthDay = (d, n, day) => {
  const x = parse(d), y = x.getUTCFullYear(), m = x.getUTCMonth() + n;
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return fmt(new Date(Date.UTC(y, m, Math.min(day, last))));
};
export const nextMonthDay = (from, day) => { const t = monthDay(from, 0, day); return t >= from ? t : monthDay(from, 1, day); };
export const diffDays = (a, b) => Math.round((parse(b) - parse(a)) / 86400000);
export const todayISO = () => { const n = new Date(); return fmt(new Date(Date.UTC(n.getFullYear(), n.getMonth(), n.getDate()))); };

const MONTHS = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
const MONTHS_FULL = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
export const ru = d => { const x = parse(d); return `${x.getUTCDate()} ${MONTHS[x.getUTCMonth()]}`; };
export const monthName = ym => { const [y, m] = ym.split('-').map(Number); return `${MONTHS_FULL[m - 1]} ${y}`; };
export const rub = n => Math.round(n).toLocaleString('ru-RU').replace(/\u00a0|,/g, ' ') + ' ₽';

// ---------- кредит ----------
export const annuityFactor = (r, n) => r === 0 ? n : (1 - Math.pow(1 + r, -n)) / r;
export const annuityPayment = (p, r, n) => p / annuityFactor(r, n);
export function solveMonthlyRate(p, pay, n) {
  let lo = 0, hi = 0.1;
  for (let i = 0; i < 200; i++) { const mid = (lo + hi) / 2; if (pay * annuityFactor(mid, n) > p) lo = mid; else hi = mid; }
  return (lo + hi) / 2;
}
export function monthsToRepay(p, r, pay) { const x = 1 - (p * r) / pay; return x <= 0 ? Infinity : -Math.log(x) / Math.log(1 + r); }
export function comparePrepay(p, r, pay, n, amount) {
  const totalNow = pay * n, rest = p - amount;
  const months = monthsToRepay(rest, r, pay);
  const newPay = annuityPayment(rest, r, n);
  return {
    amount,
    reduceTerm: { payment: pay, months, interestSaved: totalNow - (amount + pay * months) },
    reducePayment: { payment: newPay, months: n, interestSaved: totalNow - (amount + newPay * n) },
  };
}
export function loanRateAnnual(l) {
  if (l.rateAnnual != null) return { rate: l.rateAnnual / 100, estimated: false };
  return { rate: solveMonthlyRate(l.balance, l.payment, l.remaining) * 12, estimated: true };
}
export function loanSchedule(l, count) {
  const r = loanRateAnnual(l).rate / 12;
  let bal = l.balance, date = l.nextDate; const rows = [];
  for (let i = 0; i < Math.min(count, l.remaining) && bal > 0.5; i++) {
    const interest = bal * r, pay = Math.min(l.payment, bal + interest), principal = pay - interest;
    bal -= principal;
    rows.push({ date, payment: pay, interest, principal, balance: Math.max(0, bal) });
    date = monthDay(date, 1, l.payDay);
  }
  return rows;
}

// ---------- кредитки ----------
const roundUp = (x, step) => Math.ceil(x / step - 1e-9) * step;

export function cardObligations(c, today, horizon) {
  const t = c.terms;
  const buckets = c.buckets.filter(b => b.due >= today).map(b => ({ ...b, settled: false }));
  if (t.graceType === 'per_statement' && t.payWindowDays != null && c.debt > 0) {
    const s = nextMonthDay(today, t.statementDay), due = addDays(s, t.payWindowDays);
    if (!buckets.some(b => b.due === due)) buckets.push({
      due, amount: c.debt, exact: false, settled: false,
      label: `по выписке ${ru(s)}`, note: `плюс покупки до ${ru(s)}; точная дата — в выписке`,
    });
  }
  buckets.sort((a, b) => a.due.localeCompare(b.due));
  const out = [];
  let debt = c.debt, calc = nextMonthDay(today, t.statementDay);
  while (calc <= horizon) {
    for (const b of buckets) if (!b.settled && b.due <= calc) { debt -= b.amount; b.settled = true; }
    if (debt <= 0.5) break;
    const minAmt = Math.min(debt, roundUp(Math.max(t.minFloor, debt * t.minPct / 100), t.minRoundTo));
    const minDue = t.minDueRule === 'window' && t.payWindowDays != null ? addDays(calc, t.payWindowDays) : monthDay(calc, 1, 31);
    const cover = buckets.find(b => !b.settled && b.due >= calc && b.due <= minDue && b.amount >= minAmt);
    if (cover) {
      out.push({ date: minDue, account: c.id, title: `${c.name}: минимальный`, amount: minAmt, kind: 'minimum', exact: false, counts: false, note: `входит в платёж до ${ru(cover.due)}` });
    } else {
      out.push({ date: minDue, account: c.id, title: `${c.name}: обязательный`, amount: minAmt, kind: 'minimum', exact: false, counts: true, note: t.minDueRule === 'next_report' ? 'срок уточнить по отчёту' : undefined });
      debt -= minAmt;
      let left = minAmt;
      for (const b of buckets) { if (b.settled || left <= 0) continue; const take = Math.min(b.amount, left); b.amount -= take; left -= take; }
    }
    calc = monthDay(calc, 1, t.statementDay);
  }
  for (const b of buckets) {
    if (b.due > horizon || b.amount <= 0.5) continue;
    out.push({ date: b.due, account: c.id, title: `${c.name}: без процентов${b.label ? ' ' + b.label : ''}`, amount: b.amount, kind: 'grace', exact: b.exact, counts: true, note: b.note });
  }
  return out;
}

export function installmentObligations(p, horizon) {
  const out = []; let remaining = p.debt, date = p.nextDate, first = true;
  while (remaining > 0.5 && date <= horizon) {
    const amount = Math.min(p.nextAmount, remaining);
    out.push({ date, account: p.id, title: p.name, amount, kind: 'installment', exact: first, counts: true,
      note: p.fundingAccount ? `спишется с «${p.fundingAccount}» — пополнить заранее` : undefined });
    remaining -= amount; date = addDays(date, p.periodDays); first = false;
  }
  return out;
}

export function loanObligations(l, horizon) {
  const out = []; let date = l.nextDate;
  for (let i = 0; i < l.remaining && date <= horizon; i++) {
    out.push({ date, account: l.id, title: l.name, amount: l.payment, kind: 'loan', exact: true, counts: true });
    date = monthDay(date, 1, l.payDay);
  }
  return out;
}

export function buildCalendar(s, today, horizon) {
  return [
    ...s.cards.flatMap(c => cardObligations(c, today, horizon)),
    ...s.installments.flatMap(p => installmentObligations(p, horizon)),
    ...s.loans.flatMap(l => loanObligations(l, horizon)),
  ].sort((a, b) => a.date.localeCompare(b.date) || b.amount - a.amount);
}

export const loadBetween = (cal, from, to) =>
  cal.filter(o => o.counts && o.date >= from && o.date <= to).reduce((s, o) => s + o.amount, 0);

export function loadByMonth(cal) {
  const m = new Map();
  for (const o of cal) if (o.counts) { const k = o.date.slice(0, 7); m.set(k, (m.get(k) ?? 0) + o.amount); }
  return m;
}

// ---------- доходы ----------
/** Если день выплаты выпадает на выходной — выплата в предыдущий рабочий день (праздники не учитываются). */
export function prevWorkday(d) {
  const w = parse(d).getUTCDay();
  return w === 6 ? addDays(d, -1) : w === 0 ? addDays(d, -2) : d;
}

/** Даты выплат регулярного дохода в интервале [from, horizon]. */
export function incomeDates(inc, from, horizon) {
  const out = [];
  for (let i = -1; i < 36; i++) {
    const planned = monthDay(from, i, inc.day);
    const pay = inc.shiftWeekend ? prevWorkday(planned) : planned;
    if (pay > horizon) break;
    if (pay >= from) out.push(pay);
  }
  return out;
}
