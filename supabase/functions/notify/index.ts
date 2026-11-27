// HIPCO Deals: push notifications.
// Called by the database (never by the app):
//   {type:"change", col, op, id, old, new, by}  -> one notification for what just happened to a deal
//   {type:"scan"}                               -> once a day: the offshore daily report (Fridays: weekly money), then one notification per deal whose alert just changed
// Everyone on the team gets every notification, except the person who made the change.
import webpush from "npm:web-push@3.6.7";
import { createClient } from "npm:@supabase/supabase-js@2.117.3";

const env = (k: string) => Deno.env.get(k) ?? "";
const APP_URL = "https://bobamin1999-debug.github.io/hipco-deals/";
webpush.setVapidDetails(APP_URL, env("VAPID_PUBLIC"), env("VAPID_PRIVATE"));
// the function's own server key, provided by Supabase inside the function (never copied anywhere else)
const serverKey = () => { try { const k = JSON.parse(env("SUPABASE_SECRET_KEYS") || "{}"); const v = Object.values(k)[0]; if (v) return String(v); } catch (_) { /* fall back */ } return env("SUPABASE_SERVICE_ROLE_KEY"); };
const db = () => createClient(env("SUPABASE_URL"), serverKey(), { auth: { persistSession: false } });

type Deal = Record<string, any>;
type Msg = { title: string; body: string; url: string };

/* ---------------------------------------------------------------- dates and alerts (same rules as the app) */
const DEFAULTS = { remindDays: 14, dueRemindDays: 7, followDays: 7, inquiryDays: 3, blWarnDays: 30 };
const pad = (n: number) => String(n).padStart(2, "0");
const todayISO = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Beirut", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const dn = (iso?: string) => { if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null; const [y, m, d] = iso.split("-").map(Number); return Date.UTC(y, m - 1, d) / 864e5; };
const isoOf = (n: number) => { const d = new Date(n * 864e5); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`; };
const fD = (iso?: string) => { if (!iso) return ""; const p = iso.split("-"); return p.length === 3 ? `${p[2]}.${p[1]}.${p[0]}` : iso; };
const fDn = (n: number | null) => n == null ? "" : fD(isoOf(n));
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const fM = (ym?: string) => { if (!ym) return ""; const [y, m] = ym.split("-").map(Number); return `${MON[m - 1]} ${y}`; };
const mStart = (ym?: string) => ym ? dn(ym + "-01") : null;
const mEnd = (ym?: string) => { if (!ym) return null; const [y, m] = ym.split("-").map(Number); return Date.UTC(y, m, 0) / 864e5; };
const num = (v: any) => { if (typeof v === "number") return v; if (typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v.trim())) return Number(v); return NaN; };
const money = (v: number, cur?: string) => { if (!isFinite(v) || v === 0) return ""; return (cur === "EUR" ? "€" : "$") + Math.round(v).toLocaleString("en-US"); };
const value = (d: Deal) => { const t = num(d.total); if (isFinite(t)) return t; const q = num(d.qty), p = num(d.price); return isFinite(q) && isFinite(p) ? q * p : 0; };
const isShipped = (d: Deal) => !!(d.shipped || d.shippedOn || d.bl);
const isArrived = (d: Deal) => !!(d.arrived || d.arrivedOn);
const needsDeposit = (d: Deal) => num(d.advPct) > 0 && !d.depositOn && !(num(d.paid) > 0);
const ymNow = () => todayISO().slice(0, 7);
const duesOf = (d: Deal) => Object.entries(d.dues && typeof d.dues === "object" ? d.dues : {}).filter(([m, v]) => /^\d{4}-\d{2}$/.test(m) && num(v) > 0).map(([m, v]) => [m, num(v)] as [string, number]);
const duesBefore = (d: Deal, ym: string) => duesOf(d).filter(([m]) => m < ym).reduce((s, [, v]) => s + v, 0);
const dueIn = (d: Deal, ym: string) => duesOf(d).filter(([m]) => m === ym).reduce((s, [, v]) => s + v, 0);
const balanceDue = (d: Deal) => { const b = dn(d.balanceDue); if (b != null) return b; const e = dn(d.eta), k = num(d.balDays); return e != null && isFinite(k) ? e - k : null; };
const remindOn = (d: Deal, c: any) => { const e = dn(d.eta), b = balanceDue(d);
  if (b != null) return (e != null && b <= e) ? e - c.remindDays : b - c.dueRemindDays;
  return e != null ? e - c.remindDays : null; };

function assess(d: Deal, c: any): { level: number; label: string; hint?: string } {
  const t = dn(todayISO())!, st = d.stage;
  if (st === "signed" && d.sheet === "pending-offers") return { level: 0, label: "Signed" };   // pending-offers sheet: tracked in the Offers tab only
  if (st === "closed") return { level: -1, label: "Closed" };
  if (st === "inquiry") {
    const a = d.inqDate ? t - dn(d.inqDate)! : 0;
    return a >= c.inquiryDays ? { level: 3, label: "Waiting for offer", hint: `${a} days old` } : { level: 0, label: "New inquiry" };
  }
  if (st === "offer") {
    if (d.millOrder) return { level: 2, label: "Booked. Client signed?", hint: `${d.millOrder} in En Cours for this client` };
    if (!d.salesman || d.salesman === "To assign") return { level: 3, label: "Assign salesman" };
    const v = dn(d.validUntil);
    if (v != null) return v < t ? { level: 3, label: "Expired, follow up", hint: `Valid until ${fD(d.validUntil)}` } : { level: 0, label: "Valid" };
    const a = d.offerDate ? t - dn(d.offerDate)! : 0;
    return a >= c.followDays ? { level: 3, label: "No reply yet, follow up", hint: `Sent ${a} days ago` } : { level: 0, label: "Waiting for client" };
  }
  if (st === "signed") {
    const a = d.signedOn ? t - dn(d.signedOn)! : 0;
    return { level: a >= 3 ? 1 : 2, label: "Mill PI not signed", hint: d.signedOn ? `Client signed ${a} day${a === 1 ? "" : "s"} ago` : "" };
  }
  const e = dn(d.eta), sh = isShipped(d), ar = isArrived(d), due = balanceDue(d), rem = remindOn(d, c);
  const ms = mStart(d.shipMonth), me = mEnd(d.shipMonth);
  if (d.mayCancel) return { level: 2, label: "May cancel. Decide" };
  if (needsDeposit(d)) return { level: 1, label: "Deposit not paid", hint: `${Math.round(num(d.advPct) * 100)}% = ${money(value(d) * num(d.advPct), d.cur)}` };
  if (due != null && due < t) return { level: 1, label: "Balance overdue", hint: `Was due ${fDn(due)}` };
  if (!sh && me != null && t > me) return { level: 1, label: "Shipment late", hint: `Offer said ${fM(d.shipMonth)}` };
  if (!ar && e != null && e < t) return { level: 1, label: sh ? "ETA passed. Confirm arrival" : "ETA passed. Not shipped?", hint: `${t - e} day${t - e === 1 ? "" : "s"} ago` };
  if (ar && (due == null || due <= t)) return { level: 1, label: "Arrived. Client not paid" };
  const late = duesBefore(d, ymNow());
  if (late > 0) return { level: 1, label: "Payment overdue", hint: `${money(late)} from earlier months not received` };
  if (rem != null && rem <= t) return { level: 2, label: "Remind client to pay", hint: due != null ? `Balance due ${fDn(due)}` : (e != null ? `Arrives in ${e - t} days` : "") };
  const now = dueIn(d, ymNow());
  if (now > 0) return { level: 2, label: "Payment due this month", hint: `${money(now)} in ${fM(ymNow())}` };
  if (!sh && e != null && e - t <= c.blWarnDays) return { level: 2, label: "No B/L yet, ETA close", hint: `${e - t} days to ETA` };
  if (!sh && ms != null && t >= ms) return { level: 2, label: "Ship month. Not shipped yet", hint: `Offer said ${fM(d.shipMonth)}` };
  // a PI counts as signed when the signed PI is attached, or once there is a B/L / shipment (Bob, 09.11.2026)
  if (!(Array.isArray(d.files) ? d.files : []).some((f: any) => f.cat === "pi") && !sh && !ar) return { level: 2, label: "Mill PI not signed", hint: d.millOrder ? `Order ${d.millOrder} · signed PI not attached` : "Signed PI not attached" };
  return { level: 0, label: "On track" };
}

/* ---------------------------------------------------------------- what changed, in words */
const BIZ = (d: Deal) => d.kind === "offshore" ? "Offshore" : "Beirut";
const head = (d: Deal) => `${d.ref || (d.inqNo ? `Inq #${d.inqNo}` : "Inquiry")} · ${d.client || ""}`.trim();
const CAT: Record<string, string> = { inquiry: "Inquiry", offer: "Offer", signed: "Signed offer", pi: "Mill PI", deposit: "Deposit proof",
  shipping: "B/L / shipping docs", invoice: "Invoice", payment: "Payment proof", other: "Document" };
const FIELD: Record<string, string> = { client: "client", contact: "contact", salesman: "salesman", product: "product", spec: "spec", qty: "quantity",
  price: "price", total: "total", cur: "currency", terms: "terms", advPct: "deposit %", balDays: "balance days", balanceDue: "balance due date",
  shipMonth: "shipment month", validUntil: "validity", millOrder: "mill order", millRef: "mill PI no.", bl: "B/L no.", eta: "ETA",
  notes: "notes", dest: "destination", port: "port", supplier: "supplier", purchase: "purchase price", profit: "profit", ref: "reference",
  kind: "business", offerDate: "offer date", inqDate: "inquiry date", mayCancel: "may-cancel flag", dues: "dues by month", balance: "balance",
  clientCode: "account no.", priceNote: "price note", etaNote: "ETA", blNote: "B/L note", lot: "lot",
  margin: "margin", purchaseNote: "supplier price", qtyNote: "quantity note" };
const SKIP = new Set(["files", "stage", "outcome", "prevStage", "closedOn", "signedOn", "piOn", "depositOn", "shipped", "shippedOn", "arrived",
  "arrivedOn", "paidOn", "updatedAt", "updatedBy", "inqStatus", "paid", "payments", "comments"]);
const url = (id: string) => `${APP_URL}?deal=${encodeURIComponent(id)}`;

function dealChange(op: string, id: string, o: Deal | null, n: Deal | null): Msg | null {
  if (op === "DELETE" && o) return { title: head(o), body: "Deal deleted", url: APP_URL };
  if (!n) return null;
  const v = money(value(n), n.cur), prod = n.product ? ` · ${n.product}` : "";
  if (op === "INSERT" || !o) {
    const b = { inquiry: "New inquiry", offer: "New offer sent", signed: "New signed offer", order: "New order", closed: "New closed deal" }[n.stage as string] || "New deal";
    return { title: head(n), body: `${b}${prod}${v ? ` · ${v}` : ""}`, url: url(id) };
  }
  const out: string[] = [];
  if (o.stage !== n.stage) {
    if (n.stage === "closed") out.push(n.outcome === "paid" ? "Paid in full. Deal closed" : n.outcome === "cancelled" ? "Cancelled" : "Marked lost");
    else if (o.stage === "closed") out.push("Reopened");
    else out.push({ offer: "Offer sent to the client", signed: "Client signed the offer", order: "Mill order placed", inquiry: "Moved back to inquiries" }[n.stage as string] || `Moved to ${n.stage}`);
  }
  if (n.depositOn && !o.depositOn) out.push("Deposit received");
  const piN = (Array.isArray(n.files) ? n.files : []).some((f: any) => f.cat === "pi"), piO = (Array.isArray(o.files) ? o.files : []).some((f: any) => f.cat === "pi");
  if (piN && !piO) out.push("Mill PI signed (attached)");
  if (isShipped(n) && !isShipped(o)) out.push(`Shipped${n.bl ? ` · B/L ${n.bl}` : ""}${n.eta ? ` · ETA ${fD(n.eta)}` : ""}`);
  else if (n.eta && o.eta && n.eta !== o.eta) out.push(`ETA changed to ${fD(n.eta)}`);
  if (isArrived(n) && !isArrived(o)) out.push("Goods arrived");
  const got = num(n.paid) - (isFinite(num(o.paid)) ? num(o.paid) : 0);
  if (isFinite(got) && got > 0) out.push(`Payment received: ${money(got)}${isFinite(num(n.balance)) ? ` · balance ${num(n.balance) > 0 ? money(num(n.balance)) : "$0"}` : ""}`);
  else if (n.paidOn && !o.paidOn && !(n.stage === "closed" && o.stage !== "closed")) out.push("Payment received");
  if (n.millRef && n.millRef !== o.millRef) out.push(`Mill PI no. ${n.millRef}`);
  const oc = Array.isArray(o.comments) ? o.comments.length : 0, nc = Array.isArray(n.comments) ? n.comments : [];
  for (const c of nc.slice(oc)) out.push(`Comment: ${c.text}`);
  const of = new Map((Array.isArray(o.files) ? o.files : []).map((f: any) => [f.id, f]));
  const nf = new Map((Array.isArray(n.files) ? n.files : []).map((f: any) => [f.id, f]));
  for (const [k, f] of nf) if (!of.has(k)) out.push(`New document: ${CAT[(f as any).cat] || "Document"} (${(f as any).name})`);
  for (const [k, f] of of) if (!nf.has(k)) out.push(`Document removed: ${(f as any).name}`);
  if (!out.length) {
    const ch = Object.keys({ ...o, ...n }).filter(k => !SKIP.has(k) && !k.startsWith("_") && JSON.stringify(o[k] ?? null) !== JSON.stringify(n[k] ?? null));
    if (!ch.length) return null;
    out.push(`Updated: ${ch.map(k => FIELD[k] || k).join(", ")}`);
  }
  return { title: head(n), body: out.join(" · "), url: url(id) };
}

function clientChange(id: string, o: Deal | null, n: Deal | null): Msg | null {
  if (!n) return null;
  const of = new Set((o?.files || []).map((f: any) => f.id));
  const added = (n.files || []).filter((f: any) => !of.has(f.id));
  if (!added.length) return null;
  return { title: `Client documents · ${n.name || id}`, body: added.map((f: any) => `New document: ${f.name}`).join(" · "), url: APP_URL };
}

/* ---------------------------------------------------------------- sending */

/* ---------------------------------------------------------------- daily report (offshore only): same rules as reportChecks() in index.html */
const REPORT_DAYS = 35, TRANSIT_DAYS = 35;
const MONTH_IX: Record<string, number> = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };
function arrivalDay(d: Deal) {
  const e = dn(d.eta); if (e != null) return e;
  const t = String(d.etaNote || "").toUpperCase(), m = t.match(/JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC/);
  if (!m) return null;
  const mi = MONTH_IX[m[0]], now = new Date(todayISO() + "T00:00:00Z"), y0 = now.getUTCFullYear(), ym = t.match(/20\d\d/);
  const y = ym ? Number(ym[0]) : (mi < now.getUTCMonth() - 1 ? y0 + 1 : y0);
  const last = new Date(Date.UTC(y, mi + 1, 0)).getUTCDate(), dd = t.match(/\b(\d{1,2})\b/);
  const day = /END/.test(t) ? last : dd ? Math.min(Number(dd[1]), last) : 15;
  return Date.UTC(y, mi, day) / 864e5;
}
const isStockDeal = (d: Deal) => /stock/i.test(`${d.product || ""} ${d.supplier || ""}`);
/* month named in a note ("END JAN", "DEC/JAN" = the later one, "Production DEC 2026"): a day number */
function noteDay(txt: any, endOfMonth: boolean) {
  const t = String(txt || "").toUpperCase(), all = t.match(/JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC/g);
  if (!all) return null;
  const mi = MONTH_IX[all[all.length - 1]], now = new Date(todayISO() + "T00:00:00Z"), y0 = now.getUTCFullYear(), ym = t.match(/20\d\d/);
  const y = ym ? Number(ym[0]) : (mi < now.getUTCMonth() - 1 ? y0 + 1 : y0);
  const last = new Date(Date.UTC(y, mi + 1, 0)).getUTCDate(), dd = t.match(/\b(\d{1,2})\b/);
  const day = endOfMonth || /END/.test(t) ? last : /BEG/.test(t) ? 1 : dd ? Math.min(Number(dd[1]), last) : 15;
  return Date.UTC(y, mi, day) / 864e5;
}
const isProdNote = (t: any) => /PRODUC/i.test(String(t || ""));
function shipByDay(d: Deal) {
  const s = dn(d.shipBy); if (s != null) return s;
  const p = dn(d.prodDate); if (p != null) return p + 7;
  const pn = d.prodNote || (isProdNote(d.etaNote) ? d.etaNote : ""); if (pn) { const x = noteDay(pn, true); if (x != null) return x + 7; }
  const e = dn(d.eta); if (e != null) return e - TRANSIT_DAYS;
  const a = isProdNote(d.etaNote) ? null : noteDay(d.etaNote, false); return a != null ? a - TRANSIT_DAYS : null;
}
const PAY_LATE = ["Payment overdue", "Balance overdue", "Arrived. Client not paid", "Deposit not paid"];
/* late = dues from earlier months, plus this month's when the terms already make it late (balance due date passed, arrived unpaid, deposit) */
const LATE_NOW = ["Balance overdue", "Arrived. Client not paid"];
const lateOf = (d: Deal, a: any) => { const ym = todayISO().slice(0, 7), l = a && a.label;
  return duesBefore(d, ym) + (LATE_NOW.includes(l) ? (dueIn(d, ym) || (duesOf(d).length ? 0 : value(d) - (num(d.paid) || 0))) : l === "Deposit not paid" ? value(d) * num(d.advPct) : 0); };
function reportChecks(d: Deal, lo: Deal | null, t: number, a?: any) {
  const files = [...(Array.isArray(d.files) ? d.files : []), ...(lo && Array.isArray(lo.files) ? lo.files : [])];
  const has = (c: string) => files.some((f: any) => f.cat === c), out: { lv: number; k: string; txt: string }[] = [];
  const push = (lv: number, k: string, txt: string) => out.push({ lv, k, txt });
  const signed = dn(d.signedOn || (lo && lo.signedOn)), age = signed != null ? t - signed : null;
  const sh = isShipped(d), stock = isStockDeal(d), booked = d.booking === "booked";
  if (!has("signed")) push(2, "copy", "Signed offer copy not attached");
  if (!stock && !sh && !has("pi")) push(age != null && age > 14 ? 1 : 2, "pi", `No signed mill PI${age != null ? ` (client signed ${age} day${age === 1 ? "" : "s"} ago)` : ""}: ask the mill for it`);
  if (!stock && !sh) {
    const p = dn(d.prodDate), sb = shipByDay(d), left = sb != null ? sb - t : null;
    if (booked) push(3, "book", `Booked${d.vessel ? ` · ${d.vessel}` : ""}${d.bookedOn ? ` (${fD(d.bookedOn)})` : ""}: waiting for the B/L`);
    else if (p != null && p < t) push(1, "book", `Production was due ${fD(d.prodDate)} and there is no booking: check with the mill for a delay`);
    else if (left != null && left < 0) push(1, "book", `Should have shipped by ${fDn(sb)} but there is no booking: check with the mill why it hasn't shipped`);
    else if (left != null && left <= 21) push(2, "book", `Must ship by ${fDn(sb)} (${left} day${left === 1 ? "" : "s"} left) and there is no booking${d.booking === "asked" ? " (asked the mill)" : ""}: chase the mill`);
    else if (left != null) push(3, "book", `Must ship by ${fDn(sb)}: no booking yet`);
    else push(3, "book", "No production date or ETA: get them from the mill");
  }
  if (sh) {
    if (!has("shipping")) push(2, "docs", "Shipped: copy of documents (B/L) not attached");
    if (!isArrived(d) && dn(d.eta) != null && dn(d.eta)! < t) push(1, "eta", `ETA ${fD(d.eta)} passed: confirm arrival`);
  }
  const late = lateOf(d, a);
  if (late > 0) push(1, "pay", `Client payment late: ${money(late, d.cur)}${a && a.label && PAY_LATE.includes(a.label) ? ` (${a.label}${a.hint ? `, ${a.hint}` : ""})` : ""}`);
  return out;
}
/* the morning report: one summary + one alert per order that should already have shipped; on Fridays also the week's money */
function dailyReport(rows: any[], cfg: any): Msg[] {
  const t = dn(todayISO())!, ym = ymNow(), byId = new Map(rows.map((r: any) => [r.id, r.data]));
  const open = rows.filter((r: any) => r.data.kind === "offshore" && r.data.outcome !== "removed" && (r.data.stage === "order" || r.data.stage === "signed"));
  const linked = new Set(open.map((r: any) => r.data.offerId).filter(Boolean));
  const deals = open.filter((r: any) => !(r.data.sheet === "pending-offers" && linked.has(r.id)));
  const lo = (d: Deal) => d.offerId ? byId.get(d.offerId) || null : null;
  const recent = deals.filter((r: any) => { const s = dn(r.data.signedOn || (lo(r.data) || {}).signedOn); return s != null && t - s <= REPORT_DAYS; });
  const checks = recent.map((r: any) => ({ r, c: reportChecks(r.data, lo(r.data), t, assess(r.data, cfg)) }));
  const urgent = checks.filter(x => x.c.some(c => c.lv === 1)).length;
  const n = (k: string) => checks.filter(x => x.c.some(c => c.k === k && c.lv < 3)).length;
  const late = deals.reduce((s: number, r: any) => s + (r.data.cur === "EUR" ? 0 : lateOf(r.data, assess(r.data, cfg))), 0);
  const due = deals.reduce((s: number, r: any) => { const a = assess(r.data, cfg); return s + (r.data.cur === "EUR" || LATE_NOW.includes(a.label) ? 0 : dueIn(r.data, ym)); }, 0);
  const noDocs = deals.filter((r: any) => isShipped(r.data) && ![...(r.data.files || []), ...((lo(r.data) || {}).files || [])].some((f: any) => f.cat === "shipping")).length;
  const RURL = `${APP_URL}?report=1`, msgs: Msg[] = [];
  msgs.push({ title: `Daily report · ${fD(todayISO())}`, url: RURL,
    body: [`${urgent} order${urgent === 1 ? "" : "s"} urgent`, `${n("pi")} without signed mill PI`, `${n("book")} need a booking`, `${n("copy")} without signed copy`, noDocs ? `${noDocs} shipped without copy of documents` : "",
      late ? `${money(late)} client payments late` : "", due ? `${money(due)} due in ${fM(ym)}` : ""].filter(Boolean).join(" · ") });
  for (const x of checks) for (const c of x.c) if (c.k === "book" && c.lv === 1)
    msgs.push({ title: `${x.r.data.client || ""} · ${x.r.data.ref || ""}`.trim(), body: c.txt, url: url(x.r.id) });
  if (new Date(todayISO() + "T00:00:00Z").getUTCDay() === 5) {   // Friday: the week in money
    const ym2 = (() => { const [y, m] = ym.split("-").map(Number); return m === 12 ? `${y + 1}-01` : `${y}-${pad(m + 1)}`; })();
    const next = deals.reduce((s: number, r: any) => s + (r.data.cur === "EUR" ? 0 : dueIn(r.data, ym2)), 0);
    const sup = deals.reduce((s: number, r: any) => s + Object.entries(r.data.supDues || {}).filter(([m]) => m <= ym2).reduce((x: number, [, v]) => x + (num(v) || 0), 0), 0);
    let profit = 0, withCost = 0;
    for (const r of recent) { const d = r.data, c = (d.purchase != null ? d : lo(d)) || {}; const pr = num(d.price), b = num(c.purchase), q = num(d.qty);
      const m = String(c.margin || "").match(/\$([\d,]+)\/MT/); const mt = m ? Number(m[1].replace(/,/g, "")) : (isFinite(pr) && isFinite(b) ? pr - b : NaN);
      if (isFinite(mt) && isFinite(q) && d.cur !== "EUR") { profit += mt * q; withCost++; } }
    msgs.push({ title: `Weekly money · ${fD(todayISO())}`, url: RURL,
      body: [`Profit on recent orders ${money(profit) || "$0"} (${withCost} with cost)`, `Late ${money(late) || "$0"}`, `Due ${fM(ym)} ${money(due) || "$0"}`, `Expected ${fM(ym2)} ${money(next) || "$0"}`, `To pay suppliers ${money(sup) || "$0"}`].join(" · ") });
  }
  return msgs;
}

async function send(sb: any, msgs: Msg[], skipUser?: string | null) {
  if (!msgs.length) return 0;
  if (env("DEBUG")) msgs.forEach(m => console.log("MSG", JSON.stringify(m)));
  const { data: subs } = await sb.from("push_subs").select("endpoint,user_id,sub");
  let sent = 0;
  for (const s of subs || []) {
    if (skipUser && s.user_id === skipUser) continue;
    for (const m of msgs) {
      try { await webpush.sendNotification(s.sub, JSON.stringify(m), { TTL: 60 * 60 * 24 * 3, urgency: "high" }); sent++; }
      catch (e: any) {
        if (e && (e.statusCode === 404 || e.statusCode === 410)) { await sb.from("push_subs").delete().eq("endpoint", s.endpoint); break; }
        console.error("push failed", e?.statusCode, e?.body || e?.message);
      }
    }
  }
  return sent;
}

async function settings(sb: any) {
  const { data } = await sb.from("kv").select("data").eq("col", "config").eq("id", "settings").maybeSingle();
  return { ...DEFAULTS, ...(data?.data || {}) };
}

Deno.serve(async req => {
  if (req.method !== "POST" || !env("NOTIFY_SECRET") || req.headers.get("x-hipco-secret") !== env("NOTIFY_SECRET")) return new Response("no", { status: 401 });
  const p = await req.json().catch(() => ({}));
  const sb = db();
  try {
    if (p.type === "change") {
      let msg: Msg | null = null;
      if (p.col === "deals") {
        msg = dealChange(p.op, p.id, p.old, p.new);
        if (p.new && p.op !== "DELETE") {   // remember the deal's alert now, so the daily check only reports new ones
          const a = assess(p.new, await settings(sb));
          await sb.from("push_log").upsert({ deal_id: p.id, label: a.level > 0 ? a.label : "", sent_on: todayISO() });
        }
      } else if (p.col === "clients") msg = clientChange(p.id, p.old, p.new);
      const n = msg ? await send(sb, [msg], p.by) : 0;
      return Response.json({ ok: true, sent: n });
    }
    if (p.type === "scan") {
      const c = await settings(sb);
      const [{ data: rows }, { data: log }] = await Promise.all([
        sb.from("kv").select("id,data").eq("col", "deals"), sb.from("push_log").select("deal_id,label,sent_on")]);
      // remind again while the action is still open: urgent every day, "this week" every 3 days, follow-ups once
      const prev = new Map((log || []).map((r: any) => [r.deal_id, r]));
      const first = !(log || []).length, msgs: Msg[] = [], ups: any[] = [], today = todayISO(), t = dn(today)!;
      for (const r of rows || []) {
        const d = r.data, a = assess(d, c), label = a.level > 0 ? a.label : "", was = prev.get(r.id);
        const changed = !was || (was.label ?? "") !== label;
        const since = was && was.sent_on ? t - dn(was.sent_on)! : 999;
        const again = !changed && label && ((a.level === 1 && since >= 1) || (a.level === 2 && since >= 3));
        if (!changed && !again) continue;
        const notify = !!was && a.level > 0 && (changed || again);   // a deal seen for the first time is only recorded, never announced in bulk
        ups.push({ deal_id: r.id, label, sent_on: notify || (!was && label) ? today : (was?.sent_on ?? null) });
        if (notify) {
          const tag = a.level === 1 ? "Urgent: " : a.level === 2 ? "This week: " : "Follow up: ";
          msgs.push({ title: head(d), body: `${again ? "Reminder · " : ""}${tag}${a.label}${a.hint ? ` · ${a.hint}` : ""}`, url: url(r.id) });
        }
      }
      if (ups.length) await sb.from("push_log").upsert(ups);
      if (!first) msgs.unshift(...dailyReport(rows || [], c));
      const n = await send(sb, msgs, null);
      return Response.json({ ok: true, alerts: msgs.length, sent: n, seeded: first });
    }
    if (p.type === "test") return Response.json({ ok: true, sent: await send(sb, [{ title: "HIPCO Deals", body: "Notifications are working.", url: APP_URL }], null) });
    return new Response("unknown", { status: 400 });
  } catch (e: any) {
    console.error(e); return new Response(String(e?.message || e), { status: 500 });
  }
});
