const n2 = (v) => Math.round((Number(v) + Number.EPSILON) * 100) / 100;
const NUM = /^-?\(?[\d,]+(\.\d+)?\)?$/;
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

const zero4 = () => ({ igst: 0, cgst: 0, sgst: 0, cess: 0 });
const zero5 = () => ({ taxable: 0, igst: 0, cgst: 0, sgst: 0, cess: 0 });

export function emptyFigures() {
  return {
    outward: { a: zero5(), b: zero5(), c: zero5(), d: zero5(), e: zero5() },
    itc: { import_goods: zero4(), import_services: zero4(), rcm: zero4(), isd: zero4(), other: zero4(), reversed_rules: zero4(), reversed_others: zero4(), ineligible_17_5: zero4(), ineligible_others: zero4() },
    tax_paid: { igst: 0, cgst: 0, sgst: 0, cess: 0 },
  };
}

export async function pdfText(bytes) {
  const mupdf = await import("mupdf");
  const doc = mupdf.Document.openDocument(bytes, "application/pdf");
  const parts = [];
  for (let i = 0; i < doc.countPages(); i++) parts.push(doc.loadPage(i).toStructuredText("preserve-whitespace").asText());
  return parts.join("\n");
}

function numsAfter(lines, start, count, span = 12) {
  const nums = [];
  for (let i = start; i < Math.min(lines.length, start + span) && nums.length < count; i++) {
    const tokens = lines[i].split(/\s+/).filter(Boolean);
    for (const t of tokens) {
      const c = t.replace(/[₹,]/g, "");
      if (NUM.test(c) && !/^\(?[a-z]\)?$/i.test(c)) nums.push(Number(c.replace(/^\((.*)\)$/, "-$1")));
    }
    // a following row label means the numbers ran out
    if (i > start && /^\s*\(?[a-eA-E1-5]\)\s+[A-Za-z]/.test(lines[i]) && nums.length) break;
  }
  return nums;
}

/** The figures at the end of a line: the last `count` numbers of the run of numbers that closes it, or null when the line has fewer. */
function tailNums(line, count) {
  const nums = [];
  const tokens = line.split(/\s+/).filter(Boolean);
  for (let i = tokens.length - 1; i >= 0; i--) {
    const c = tokens[i].replace(/[₹,]/g, "");
    if (!NUM.test(c) || /^\(?[a-z]\)?$/i.test(c)) break;
    nums.unshift(Number(c.replace(/^\((.*)\)$/, "-$1")));
  }
  return nums.length >= count ? nums.slice(-count) : null;
}

/** Best-effort parse of the GSTR-3B PDF text. Returns figures + how many lines were located. */
export function parseGstr3bText(text) {
  const f = emptyFigures();
  const lines = String(text).split(/\r?\n/).map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean);
  let found = 0;

  let period = null;
  const flat = lines.join(" ");
  const pm = new RegExp(`Period\\s*:?\\s*(${MONTHS.map((m) => m[0].toUpperCase() + m.slice(1)).join("|")})`, "i").exec(flat);
  const ym = /Year\s*:?\s*(\d{4})\s*-\s*(\d{2})/i.exec(flat);
  if (pm && ym) {
    const mi = MONTHS.indexOf(pm[1].toLowerCase()) + 1;
    const y = mi >= 4 ? Number(ym[1]) : Number(ym[1]) + 1;
    period = `${y}-${String(mi).padStart(2, "0")}`;
  }

  const itcStart = lines.findIndex((l) => /^4\.?\s*Eligible ITC/i.test(l) || /Eligible ITC/i.test(l) && /^4/.test(l));
  const split = itcStart > 0 ? itcStart : lines.length;
  const outLines = lines.slice(0, split);
  const itcLines = lines.slice(split);

  const out = (key, re) => {
    const i = outLines.findIndex((l) => re.test(l));
    if (i < 0) return;
    const inline = outLines[i].replace(re, " ");
    const merged = [inline, ...outLines.slice(i + 1, i + 12)];
    // the figures end the line; numbers inside the label ("other than 1 & 2 above", "rules 38, 42 & 43") are not figures
    const nums = tailNums(outLines[i], 5) || numsAfter(merged, 0, 5);
    if (nums.length >= 5) { const [t, ig, c, s, ce] = nums; f.outward[key] = { taxable: n2(t), igst: n2(ig), cgst: n2(c), sgst: n2(s), cess: n2(ce) }; found++; }
  };
  out("a", /\(a\)\s*Outward taxable supplies \(other than zero rated/i);
  out("b", /\(b\)\s*Outward taxable supplies \(zero rated\)/i);
  out("c", /\(c\)\s*Other outward supplies \(Nil rated/i);
  out("d", /\(d\)\s*Inward supplies \(liable to reverse charge\)/i);
  out("e", /\(e\)\s*Non-?GST outward supplies/i);

  const itc = (key, re) => {
    const i = itcLines.findIndex((l) => re.test(l));
    if (i < 0) return;
    const inline = itcLines[i].replace(re, " ");
    const nums = tailNums(itcLines[i], 4) || numsAfter([inline, ...itcLines.slice(i + 1, i + 10)], 0, 4);
    if (nums.length >= 4) { const [ig, c, s, ce] = nums; f.itc[key] = { igst: n2(ig), cgst: n2(c), sgst: n2(s), cess: n2(ce) }; found++; }
  };
  itc("import_goods", /\(1\)\s*Import of goods/i);
  itc("import_services", /\(2\)\s*Import of services/i);
  itc("rcm", /\(3\)\s*Inward supplies liable to reverse charge/i);
  itc("isd", /\(4\)\s*Inward supplies from ISD/i);
  itc("other", /\(5\)\s*All other ITC/i);
  itc("reversed_rules", /\(1\)\s*As per rules? 38/i);
  itc("reversed_others", /\(2\)\s*Others/i);
  itc("ineligible_17_5", /\(1\)\s*Reclaim of ITC reversed|\(1\)\s*ITC as per section 17\(5\)/i);

  return { figures: f, period, found, expected: 10 };
}

export async function parseGstr3bPdf(bytes) {
  const text = await pdfText(bytes);
  return { ...parseGstr3bText(text), text_length: text.length };
}
