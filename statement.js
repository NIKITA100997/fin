// Разбор PDF-выписок Сбера и Т-Банка. Вход — строки страницы: [{ x, s }], сверху вниз.

const DATE = /^\d{2}\.\d{2}\.\d{4}$/;
const num = s => parseFloat(String(s).replace(/[\s\u00a0₽]/g, '').replace(',', '.'));
const iso = d => d.split('.').reverse().join('-');
const textOf = line => line.map(i => i.s).join(' ');

/** Загружает pdf.js с CDN и возвращает строки всех страниц. */
export async function pdfLines(file) {
  if (!window.pdfjsLib) {
    await new Promise((ok, fail) => {
      const s = document.createElement('script');
      s.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
      s.onload = ok; s.onerror = () => fail(new Error('Не удалось загрузить pdf.js'));
      document.head.appendChild(s);
    });
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  }
  const doc = await window.pdfjsLib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  const out = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const tc = await (await doc.getPage(i)).getTextContent();
    const lines = new Map();
    for (const it of tc.items) {
      if (!it.str.trim()) continue;
      const y = Math.round(it.transform[5]);
      const k = [...lines.keys()].find(v => Math.abs(v - y) <= 2) ?? y;
      if (!lines.has(k)) lines.set(k, []);
      lines.get(k).push({ x: Math.round(it.transform[4]), s: it.str });
    }
    for (const [, its] of [...lines].sort((a, b) => b[0] - a[0])) out.push(its.sort((a, b) => a.x - b.x));
  }
  return out;
}

/** Сбер: «Выписка по счёту … карты». Сумма без «+» — списание. */
function parseSber(lines) {
  const all = lines.map(textOf).join('\n');
  const card = all.match(/Карта\s+.*?[•*]{2,}\s*(\d{4})/);
  const period = all.match(/За период\s+(\d{2}\.\d{2}\.\d{4})\s*[—-]\s*(\d{2}\.\d{2}\.\d{4})/);
  const debt = all.match(/Общая задолженность на\s+([\d\s]+,\d{2})\s*₽?\s*\n?\s*(\d{2}\.\d{2}\.\d{4})/);
  const closing = all.match(/Остаток на\s+(\d{2}\.\d{2}\.\d{4})\s+([\d\s]+,\d{2})\s*\n(?![\s\S]*Остаток на)/);
  const credit = /кредитной карты/i.test(all);
  const rows = [];
  let cur = null;
  for (const line of lines) {
    const t = line.map(i => i.s.trim());
    if (DATE.test(t[0]) && /^\d{2}:\d{2}$/.test(t[1] ?? '')) {
      const amountItem = line.find(i => i.x > 360 && i.x < 500 && /\d/.test(i.s));
      if (!amountItem) continue;
      const v = num(amountItem.s);
      cur = { date: iso(t[0]), time: t[1], category: line.find(i => i.x > 140 && i.x < 360)?.s.trim() ?? '',
        amount: amountItem.s.trim().startsWith('+') ? v : -v, desc: '' };
      rows.push(cur);
      continue;
    }
    if (cur && DATE.test(t[0]) && /^\d{6}$/.test(t[1] ?? '')) { cur.desc = line.filter(i => i.x > 140).map(i => i.s).join(' '); continue; }
    if (cur && line[0].x > 140 && line[0].x < 200 && !/Продолжение|Страница|Дата формирования/.test(textOf(line))) cur.desc += ' ' + textOf(line);
    if (/Продолжение на следующей|Дата формирования/.test(textOf(line))) cur = null;
  }
  for (const r of rows) {
    r.card = (r.desc.match(/\*{2,}(\d{4})/) || [])[1] ?? null;
    r.merchant = r.desc.replace(/\.?\s*Операция по карте\s*\*+\d{4}/, '').replace(/\.+$/, '').trim();
  }
  return {
    bank: 'Сбер', credit, last4: card?.[1] ?? null,
    from: period ? iso(period[1]) : null, to: period ? iso(period[2]) : null,
    closing: credit && debt ? { kind: 'debt', value: num(debt[1]), date: iso(debt[2]) }
      : closing ? { kind: 'balance', value: num(closing[2]), date: iso(closing[1]) } : null,
    rows,
  };
}

/** Т-Банк: «Справка о движении средств». */
function parseTbank(lines) {
  const all = lines.map(textOf).join('\n');
  const period = all.match(/за период с\s+(\d{2}\.\d{2}\.\d{4})\s+по\s+(\d{2}\.\d{2}\.\d{4})/i);
  const avail = all.match(/Сумма доступного остатка на\s+(\d{2}\.\d{2}\.\d{4}):?\s+([\d\s]+[.,]\d{2})/);
  const rows = [];
  let cur = null, stage = 0;
  for (const line of lines) {
    const t = line.map(i => i.s.trim());
    if (DATE.test(t[0]) && DATE.test(t[1] ?? '')) {
      const amt = line.find(i => i.x > 180 && i.x < 260 && /[+-]?\d/.test(i.s));
      if (!amt) continue;
      const card = line.find(i => i.x > 480 && /^\d{4}$/.test(i.s.trim()));
      cur = { date: iso(t[0]), time: '', amount: num(amt.s), desc: line.filter(i => i.x > 370 && i.x < 480).map(i => i.s).join(' '),
        card: card?.s.trim() ?? null, category: '' };
      rows.push(cur); stage = 1; continue;
    }
    if (cur && stage === 1 && /^\d{2}:\d{2}$/.test(t[0])) {
      cur.time = t[0]; cur.desc += ' ' + line.filter(i => i.x > 370 && i.x < 480).map(i => i.s).join(' '); stage = 2; continue;
    }
    if (cur && line[0].x > 370 && line[0].x < 480) { cur.desc += ' ' + textOf(line); continue; }
    if (/Пополнения:|АО «ТБанк»/.test(textOf(line))) cur = null;
  }
  for (const r of rows) {
    r.desc = r.desc.replace(/\s+/g, ' ').replace(/T- Bundle/, 'T-Bundle').trim();
    r.merchant = r.desc.replace(/^Оплата в\s+/i, '').replace(/\s+RUS$/, '').trim();
    r.time = r.time || '12:00';
    r.contract = (r.desc.match(/договор\s+(\d{6,})/i) || [])[1] ?? null;
  }
  return {
    bank: 'Т-Банк', credit: null, last4: null,
    from: period ? iso(period[1]) : null, to: period ? iso(period[2]) : null,
    closing: avail ? { kind: 'available', value: num(avail[2]), date: iso(avail[1]) } : null,
    rows,
  };
}

export function parseStatement(lines) {
  const all = lines.slice(0, 40).map(textOf).join('\n');
  if (/СБЕР|sberbank/i.test(all) && /Выписка по сч[её]ту/i.test(all)) return parseSber(lines);
  if (/ТБАНК|tbank/i.test(all) && /движении средств/i.test(all)) return parseTbank(lines);
  return null;
}

/** Вид операции по описанию из выписки. */
export function rowKind(r, ownNames) {
  const d = r.desc.toLowerCase();
  const self = /перевод себе/.test(d) || ownNames.some(n => n && d.includes(n.toLowerCase().replace(/\.$/, '')))
    || /перевод от б\.\s*никита/i.test(d);
  if (/внутренний перевод на договор/.test(d)) return 'transfer_out_contract';
  if (self || (r.amount > 0 && /перевод/.test(d))) return r.amount > 0 ? 'transfer_in' : 'transfer_out';
  if (/выплата по вашему обращению|возврат|отмена/.test(d)) return 'refund';
  return r.amount < 0 ? 'purchase' : 'income';
}

/** Категории банка → категории бюджета (если такие есть у пользователя). */
export const BANK_CATEGORY_MAP = {
  'Супермаркеты': 'Продукты и быт', 'Все для дома': 'Продукты и быт',
  'Рестораны и кафе': 'Кафе, доставка, развлечения', 'Отдых и развлечения': 'Кафе, доставка, развлечения',
  'Транспорт': 'Транспорт', 'Здоровье и красота': 'Здоровье', 'Одежда и аксессуары': 'Для себя',
};
