// HIPCO Deals connector for Claude (MCP over HTTP).
// Lama (or any editor) adds https://<ref>.supabase.co/functions/v1/hipco-mcp as a custom connector in Claude,
// signs in with her own HIPCO Deals login, and her Claude can then read and update deals as her.
// Every query runs as that signed-in user, so the same database rules as the app apply (viewers can't change anything).
import { pipeline } from "npm:@supabase/middleware@1.0.0";
import { withOAuthProtectedResource, withSupabase } from "npm:@supabase/server@1.9.2";
import { createMcpHandler, McpServer } from "npm:@modelcontextprotocol/server@2.4.0";
import { z } from "npm:zod@4.6.7";

const APP_URL = "https://bobamin1999-debug.github.io/hipco-deals/";
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Beirut", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());

type Deal = Record<string, any>;
const STAGES = ["inquiry", "offer", "signed", "order", "closed"] as const;
const STAGE_NAME: Record<string, string> = { inquiry: "Pending inquiry", offer: "Pending offer", signed: "Signed offer (waiting for mill)", order: "Order", closed: "Closed" };
const DOCS = ["inquiry", "offer", "signed", "pi", "deposit", "shipping", "invoice", "payment", "other"] as const;
const DOC_NAME: Record<string, string> = { inquiry: "Inquiry / client request", offer: "Offer sent", signed: "Signed offer", pi: "Mill PI (signed)",
  deposit: "Deposit proof", shipping: "B/L & shipping docs", invoice: "Invoice", payment: "Final payment proof", other: "Other" };

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "use YYYY-MM-DD");
const FieldsSchema = z.object({
  client: z.string().describe("Client company, as HIPCO writes it, e.g. 'M/S SIDEMA'"),
  contact: z.string(), salesman: z.string().describe("Ahmad, Ali, Mohamad, Nadine, Ouseili, Soha or Wissam"),
  product: z.string().describe("Product / quality, e.g. 'FBB/GC1', 'Duplex board'"), spec: z.string().describe("GSM / size"),
  qty: z.number().describe("Quantity in metric tons"), qtyType: z.enum(["Firm", "Approx."]).describe("Firm or approximate quantity"),
  dest: z.string().describe("Delivery / incoterm + place, e.g. 'CFR MERSIN'"), port: z.string(),
  ref: z.string().describe("Offer ref (HIP 26xxx) or offshore order no. (F26xx)"), offerDate: date, inqDate: date,
  cur: z.enum(["USD", "EUR"]), price: z.number().describe("Selling price per MT"), total: z.number().describe("Total value"),
  terms: z.string().describe("Payment terms as written"), advPct: z.number().min(0).max(1).describe("Advance as a fraction: 0.3 = 30%"),
  balDays: z.number().describe("Balance due this many days before arrival"), shipMonth: z.string().regex(/^\d{4}-\d{2}$/, "use YYYY-MM").describe("Shipment month YYYY-MM"),
  validUntil: date, signedOn: date, millOrder: z.string().describe("Mill order no."), millRef: z.string().describe("Mill PI no."), piOn: date,
  supplier: z.string().describe("Mill / supplier"), purchase: z.number().describe("Purchase price per MT"), profit: z.number(),
  depositOn: date, shippedOn: date, bl: z.string().describe("B/L no."), eta: date, arrivedOn: date, balanceDue: date, paidOn: date,
  mayCancel: z.boolean(), notes: z.string(), lostReason: z.string(),
}).partial().strict();

const isShipped = (d: Deal) => !!(d.shipped || d.shippedOn || d.bl);
const isArrived = (d: Deal) => !!(d.arrived || d.arrivedOn);
const biz = (d: Deal) => d.kind === "offshore" ? "offshore" : "beirut";
const files = (d: Deal) => Array.isArray(d.files) ? d.files : [];
const line = (id: string, d: Deal) => [id, d.ref || (d.inqNo ? `Inq #${d.inqNo}` : "inquiry"), d.client, biz(d), d.stage === "closed" ? `closed (${d.outcome || "lost"})` : d.stage,
  d.product, d.qty != null ? `${d.qty} MT` : "", d.shipMonth ? `ship ${d.shipMonth}` : "", d.eta ? `ETA ${d.eta}` : "", files(d).length ? `${files(d).length} file(s)` : ""].filter(Boolean).join(" | ");
const uploadLink = (id: string, cat: string) => `${APP_URL}?upload=${encodeURIComponent(id)}&cat=${cat}`;
const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
const fail = (t: string) => ({ content: [{ type: "text" as const, text: t }], isError: true });

function missingDocs(d: Deal) {
  const has = new Set(files(d).map((f: any) => f.cat)), eff = d.stage === "closed" ? (d.prevStage || "order") : d.stage, i = STAGES.indexOf(eff);
  const want: string[] = [];
  if (i >= 1 && d.kind !== "offshore") want.push("offer");
  if (i >= 2) want.push("signed");
  if (i >= 3) want.push("pi");
  if (d.depositOn) want.push("deposit");
  if (isShipped(d)) want.push("shipping");
  if (d.paidOn) want.push("payment");
  return want.filter(c => !has.has(c));
}

const STEPS = {
  offer_sent:     { stage: "offer",  date: "offerDate", need: ["ref"], say: "moved to Pending offers" },
  client_signed:  { stage: "signed", date: "signedOn",  need: [], say: "marked as signed by the client", doc: "signed" },
  mill_confirmed: { stage: "order",  date: "piOn",      need: ["millOrder"], say: "is now an order (mill confirmed)", doc: "pi" },
  deposit_received: { date: "depositOn", need: [], say: "deposit recorded", doc: "deposit" },
  shipped:        { date: "shippedOn", need: [], say: "marked shipped", doc: "shipping", extra: { shipped: true } },
  arrived:        { date: "arrivedOn", need: [], say: "marked arrived", extra: { arrived: true } },
  paid_in_full:   { stage: "closed", date: "paidOn", need: [], say: "paid and closed", doc: "payment", extra: { outcome: "paid" } },
  lost:           { stage: "closed", date: "closedOn", need: [], say: "marked lost", extra: { outcome: "lost" } },
} as Record<string, { stage?: string; date: string; need: string[]; say: string; doc?: string; extra?: Record<string, unknown> }>;

const INSTRUCTIONS = `HIPCO Deals is HIPCO's live deal tracker (paper & board trading, Beirut). Two separate businesses: "beirut" (local offers, refs like "HIP 26xxx") and "offshore" (orders F26xx, and inquiries).
A deal moves: inquiry -> offer -> signed (client signed, waiting for mill) -> order (mill signed our PI) -> closed (paid or lost). Orders then get deposit, shipped (B/L, ETA), arrived, paid in full.
Rules: never guess data; only write what the document or the user states. Dates are YYYY-MM-DD, shipment month YYYY-MM, advance % as a fraction (0.3).
Always find the deal first (find_deals / get_deal) and confirm you have the right one before changing it; if two deals could match, ask.
Use record_step for progress (it sets the stage and date like the app's buttons), update_deal for corrections and extra details.
You cannot upload files yourself: after recording a step that has a document (signed offer, mill PI, deposit proof, B/L, payment proof), call attach_link and give the user the link so they can attach the file in one tap.
Every change is saved under the signed-in person's name and the team gets a phone notification.`;

function buildServer(sb: any) {
  const server = new McpServer({ name: "hipco-deals", version: "1.0.0" }, { instructions: INSTRUCTIONS });
  const all = async () => {
    const { data, error } = await sb.from("kv").select("id,data").eq("col", "deals");
    if (error) throw new Error(error.message);
    return (data || []) as { id: string; data: Deal }[];
  };
  const one = async (key: string) => {
    const k = key.trim().toLowerCase(), norm = (s: string) => String(s || "").toLowerCase().replace(/[\s\-]/g, "");
    const rows = await all();
    const exact = rows.filter(r => r.id.toLowerCase() === k || norm(r.data.ref) === norm(key) || norm(r.data.millOrder) === norm(key));
    return exact.length ? exact : rows.filter(r => norm(r.data.ref).includes(norm(key)) || norm(r.data.millRef) === norm(key) || norm(r.data.bl) === norm(key));
  };
  const merge = async (id: string, patch: Record<string, unknown>) => {
    const { data, error } = await sb.rpc("kv_merge", { p_col: "deals", p_id: id, p_patch: { ...patch, updatedAt: Date.now() } });
    if (error) throw new Error(/not allowed|42501|permission/i.test(error.message) ? "Your login can view deals but not change them." : error.message);
    if (data === false) throw new Error("That deal no longer exists.");
  };

  server.registerTool("find_deals", {
    title: "Find deals",
    description: "Search HIPCO deals by client, ref (HIP 26xxx / F26xx), mill order, mill PI no., B/L, product or notes. Filter by business and stage. Returns one line per deal starting with its id.",
    inputSchema: z.object({
      query: z.string().optional().describe("Words to search for; leave empty to list"),
      business: z.enum(["beirut", "offshore"]).optional(), stage: z.enum(STAGES).optional(),
      limit: z.number().int().min(1).max(200).optional(),
    }),
    annotations: { readOnlyHint: true },
  }, async ({ query, business, stage, limit }) => {
    const q = (query || "").toLowerCase().trim();
    const rows = (await all()).filter(r => (!business || biz(r.data) === business) && (!stage || r.data.stage === stage) &&
      (!q || q.split(/\s+/).every(w => [r.id, r.data.ref, r.data.client, r.data.contact, r.data.product, r.data.spec, r.data.millOrder, r.data.millRef, r.data.bl, r.data.notes, r.data.supplier, r.data.salesman]
        .join(" ").toLowerCase().includes(w))));
    const out = rows.slice(0, limit || 50).map(r => line(r.id, r.data));
    return text(out.length ? `${rows.length} deal(s)${rows.length > out.length ? `, first ${out.length}` : ""}:\n${out.join("\n")}` : "No deals match.");
  });

  server.registerTool("get_deal", {
    title: "Get one deal",
    description: "All details of one deal by its id, ref (HIP 26xxx / F26xx) or mill order no., including attached documents and which documents are still missing.",
    inputSchema: z.object({ deal: z.string().describe("Deal id, ref or mill order no.") }),
    annotations: { readOnlyHint: true },
  }, async ({ deal }) => {
    const m = await one(deal);
    if (!m.length) return fail(`No deal found for "${deal}". Try find_deals.`);
    if (m.length > 1) return text(`Several deals match, ask which one:\n${m.map(r => line(r.id, r.data)).join("\n")}`);
    const { id, data: d } = m[0];
    const { files: f, ...rest } = d;
    return text(JSON.stringify({ id, business: biz(d), stage_name: STAGE_NAME[d.stage], ...rest,
      documents: (f || []).map((x: any) => ({ type: DOC_NAME[x.cat] || x.cat, name: x.name, added: x.at })), missing_documents: missingDocs(d).map(c => DOC_NAME[c]),
      open_in_app: `${APP_URL}?deal=${encodeURIComponent(id)}` }, null, 1));
  });

  server.registerTool("create_deal", {
    title: "Add a deal",
    description: "Add a new inquiry, offer or order to the Beirut or Offshore business. Check with find_deals first that it isn't already there.",
    inputSchema: z.object({ business: z.enum(["beirut", "offshore"]), stage: z.enum(["inquiry", "offer", "order"]), fields: FieldsSchema }),
    annotations: { destructiveHint: false },
  }, async ({ business, stage, fields }) => {
    if (!fields.client) return fail("A client name is required.");
    if (stage !== "inquiry" && !fields.ref) return fail("An offer or order needs its ref / order no.");
    const base = String(fields.ref || `INQ-${Date.now().toString(36)}`).trim().replace(/\s+/g, "-").replace(/[^A-Za-z0-9_\-.~:@+]/g, "") || `D-${Date.now().toString(36)}`;
    const ids = new Set((await all()).map(r => r.id));
    let id = base, i = 2; while (ids.has(id)) id = `${base}-${i++}`;
    const data: Deal = { ...fields, stage, kind: business === "offshore" ? "offshore" : "local", createdAt: Date.now(), updatedAt: Date.now(), source: "claude" };
    if (stage === "inquiry" && !data.inqDate) data.inqDate = today();
    if (stage === "offer" && !data.offerDate) data.offerDate = today();
    if (stage === "order" && !data.millOrder) data.millOrder = data.ref;
    const { error } = await sb.from("kv").insert({ col: "deals", id, data });
    if (error) return fail(/row-level|permission|42501/i.test(error.message) ? "Your login can view deals but not change them." : error.message);
    return text(`Added ${id} (${business}, ${STAGE_NAME[stage]}).\nOpen: ${APP_URL}?deal=${encodeURIComponent(id)}`);
  });

  server.registerTool("update_deal", {
    title: "Update deal details",
    description: "Change or add details on one deal (price, quantity, ETA, mill PI no., notes, …). Only the fields you pass change. For progress steps use record_step instead.",
    inputSchema: z.object({ deal: z.string().describe("Deal id or ref"), fields: FieldsSchema }),
  }, async ({ deal, fields }) => {
    const m = await one(deal);
    if (m.length !== 1) return fail(m.length ? `Several deals match "${deal}": ${m.map(r => r.id).join(", ")}. Use the exact id.` : `No deal found for "${deal}".`);
    if (!Object.keys(fields).length) return fail("Nothing to change.");
    await merge(m[0].id, fields);
    return text(`Updated ${m[0].id}: ${Object.keys(fields).join(", ")}.`);
  });

  server.registerTool("record_step", {
    title: "Record a step",
    description: "Record progress on a deal like the app's buttons: offer_sent, client_signed, mill_confirmed (needs millOrder), deposit_received, shipped (B/L, ETA), arrived, paid_in_full, lost. Date defaults to today (Beirut). Extra fields (millRef, eta, bl, shipMonth, lostReason…) can be passed in fields. Returns an attach link when the step has a document.",
    inputSchema: z.object({
      deal: z.string().describe("Deal id or ref"),
      step: z.enum(Object.keys(STEPS) as [string, ...string[]]),
      date: date.optional().describe("When it happened, YYYY-MM-DD; default today"),
      fields: FieldsSchema.optional(),
    }),
  }, async ({ deal, step, date: when, fields }) => {
    const m = await one(deal);
    if (m.length !== 1) return fail(m.length ? `Several deals match "${deal}": ${m.map(r => r.id).join(", ")}. Use the exact id.` : `No deal found for "${deal}".`);
    const { id, data: d } = m[0], S = STEPS[step], f: Record<string, unknown> = { ...(fields || {}) };
    for (const k of S.need) if (!f[k] && !d[k]) return fail(`${step} needs ${k}.`);
    const patch: Record<string, unknown> = { ...f, ...(S.extra || {}), [S.date]: when || today() };
    if (S.stage) { patch.stage = S.stage; if (S.stage === "closed") patch.prevStage = d.stage === "closed" ? d.prevStage : d.stage; }
    if (step === "mill_confirmed" && !patch.millOrder) patch.millOrder = d.millOrder;
    await merge(id, patch);
    return text(`${d.ref || id} ${S.say}.` + (S.doc ? `\nTo attach the ${DOC_NAME[S.doc].toLowerCase()}: ${uploadLink(id, S.doc)}` : ""));
  });

  server.registerTool("attach_link", {
    title: "Link to attach a document",
    description: "Returns a link that opens the deal in the HIPCO Deals app on the right '+ Attach' button, so the user can attach the file in one tap. Use it whenever the user has a document for a deal.",
    inputSchema: z.object({ deal: z.string().describe("Deal id or ref"), document: z.enum(DOCS).describe("inquiry, offer, signed (signed offer), pi (mill PI), deposit, shipping (B/L), invoice, payment, other") }),
    annotations: { readOnlyHint: true },
  }, async ({ deal, document }) => {
    const m = await one(deal);
    if (m.length !== 1) return fail(m.length ? `Several deals match "${deal}": ${m.map(r => r.id).join(", ")}.` : `No deal found for "${deal}".`);
    return text(`Tap to attach the ${DOC_NAME[document].toLowerCase()} to ${m[0].data.ref || m[0].id} (${m[0].data.client}):\n${uploadLink(m[0].id, document)}`);
  });

  return server;
}

Deno.serve(pipeline(
  [withOAuthProtectedResource(), withSupabase({ auth: "user" })],
  async (req: Request, ctx: any) => {
    const handler = createMcpHandler(() => buildServer(ctx.supabase), { onerror: (e: unknown) => console.error("MCP request failed", e) });
    return handler.fetch(req);
  },
));
