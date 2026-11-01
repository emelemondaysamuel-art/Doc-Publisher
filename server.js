const express = require("express");
const multer = require("multer");
const mammoth = require("mammoth");
const docx = require("docx");
const Anthropic = require("@anthropic-ai/sdk");
const crypto = require("crypto");
const path = require("path");

const app = express();
app.use(express.json({ limit: "5mb" }));
app.use(express.static(path.join(__dirname, "public")));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
const client = new Anthropic(); // reads ANTHROPIC_API_KEY
const MODEL = process.env.MODEL || "claude-sonnet-5-5";
const ACCESS = process.env.ACCESS_CODE || "";
const MAX_CHARS = 400000;

/* ---------- access control ---------- */
app.get("/api/config", (req, res) => res.json({ needsCode: !!ACCESS }));
app.use("/api", (req, res, next) => {
  if (req.path === "/config") return next();
  if (ACCESS && req.get("x-access-code") !== ACCESS) return res.status(401).json({ error: "Wrong or missing access code." });
  next();
});

/* ---------- chunking ---------- */
function chunkText(t, max = 4500) {
  t = t.replace(/\r\n?/g, "\n").trim();
  const units = [];
  for (const para of t.split(/\n+/)) {
    if (para.length <= max) { units.push(para); continue; }
    const sents = para.match(/[^.!?]+[.!?]+["')\]]*\s*|[^.!?]+$/g) || [para];
    let cur = "";
    for (const s of sents) {
      if ((cur + s).length > max && cur) { units.push(cur); cur = ""; }
      if (s.length > max) { for (let i = 0; i < s.length; i += max) units.push(s.slice(i, i + max)); }
      else cur += s;
    }
    if (cur) units.push(cur);
  }
  const chunks = []; let cur = "";
  for (const u of units) {
    if ((cur + "\n" + u).length > max && cur) { chunks.push(cur); cur = u; }
    else cur = cur ? cur + "\n" + u : u;
  }
  if (cur) chunks.push(cur);
  return chunks;
}

/* ---------- prompt ---------- */
function buildPrompt(chunk, i, n, prevTail, o) {
  return [
    "You are a careful copy editor and document formatter. Reformat the TEXT below.",
    "",
    "Rules:",
    "- Put correct spacing between words and after punctuation. Remove stray or doubled spaces.",
    "- Break long run-on blocks into well-formed paragraphs, separated by a blank line.",
    "- Add capital letters, commas, full stops, question marks, apostrophes and quotation marks where appropriate.",
    o.mode === "full"
      ? "- Fix spelling and grammar errors, and rewrite awkward or unclear sentences so they make logical sense in context. Keep the author's meaning, voice and facts. Never invent facts or add new ideas."
      : "- Fix spelling, grammar and punctuation only. Do not reword sentences beyond what is needed to correct errors.",
    o.headings ? "- Add short headings (lines starting with '# ' for a main title, '## ' for sections, '### ' for subsections) where the content naturally changes topic. Keep any existing headings." : "- Do not add any headings.",
    o.bullets ? "- Where the text lists items, steps or parallel points, format them as bullet points ('- ') or numbered points ('1. ', '2. ') as appropriate." : "- Do not create lists.",
    "- Do not drop any content. Do not summarise. Do not add commentary.",
    "- Output ONLY the formatted document text using this plain markup: '#', '##', '###' for headings, '- ' for bullets, '1. ' for numbered points, blank lines between paragraphs. No bold, no code fences.",
    "",
    "This is part " + (i + 1) + " of " + n + " of a longer document." + (i > 0 ? " Continue naturally from the previous part; do not repeat a title." : ""),
    prevTail ? "End of the previous part, for context only (do not repeat it):\n" + prevTail : "",
    "",
    "TEXT:",
    chunk
  ].join("\n");
}

async function polishChunk(prompt) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await client.messages.create({ model: MODEL, max_tokens: 8000, messages: [{ role: "user", content: prompt }] });
      return r.content.filter(b => b.type === "text").map(b => b.text).join("").trim().replace(/^```[a-z]*\n?|```$/g, "").trim();
    } catch (e) {
      if (attempt === 2) throw e;
      await new Promise(r => setTimeout(r, 1500 * (attempt + 1)));
    }
  }
}

/* ---------- jobs ---------- */
const jobs = new Map();
setInterval(() => { const cut = Date.now() - 60 * 60 * 1000; for (const [k, j] of jobs) if (j.created < cut) jobs.delete(k); }, 10 * 60 * 1000).unref();

async function runJob(job, raw, opts) {
  const chunks = chunkText(raw);
  job.total = chunks.length;
  const parts = [];
  try {
    for (let i = 0; i < chunks.length; i++) {
      const tail = parts.length ? parts[parts.length - 1].slice(-300) : "";
      parts.push(await polishChunk(buildPrompt(chunks[i], i, chunks.length, tail, opts)));
      job.progress = i + 1;
      job.text = parts.join("\n\n");
    }
    job.status = "done";
  } catch (e) {
    job.status = "error";
    job.error = (e && e.message) || "Editing failed.";
  }
}

app.post("/api/jobs", upload.single("file"), async (req, res) => {
  try {
    let raw = (req.body.text || "").trim();
    let name = "document";
    if (req.file) {
      const fn = req.file.originalname || "document";
      name = fn.replace(/\.[^.]+$/, "") || "document";
      if (/\.docx$/i.test(fn)) raw = (await mammoth.extractRawText({ buffer: req.file.buffer })).value;
      else if (/\.txt$/i.test(fn)) raw = req.file.buffer.toString("utf8");
      else return res.status(400).json({ error: "Please upload a .txt or .docx file." });
    }
    raw = (raw || "").trim();
    if (!raw) return res.status(400).json({ error: "No text found." });
    if (raw.length > MAX_CHARS) return res.status(400).json({ error: "Document is too long (limit " + MAX_CHARS.toLocaleString() + " characters)." });
    const opts = { mode: req.body.mode === "light" ? "light" : "full", headings: req.body.headings !== "false", bullets: req.body.bullets !== "false" };
    const id = crypto.randomBytes(8).toString("hex");
    const job = { status: "running", progress: 0, total: 0, text: "", error: "", name, created: Date.now() };
    jobs.set(id, job);
    runJob(job, raw, opts);
    res.json({ id, name, chars: raw.length });
  } catch (e) {
    res.status(500).json({ error: e.message || "Could not read the file." });
  }
});

app.get("/api/jobs/:id", (req, res) => {
  const j = jobs.get(req.params.id);
  if (!j) return res.status(404).json({ error: "Job not found (it may have expired)." });
  res.json({ status: j.status, progress: j.progress, total: j.total, text: j.text, error: j.error });
});

/* ---------- docx ---------- */
function toDocx(text) {
  const D = docx;
  const kids = [];
  let para = [];
  const flush = () => {
    if (para.length) {
      kids.push(new D.Paragraph({ children: [new D.TextRun(para.join(" "))], spacing: { after: 160, line: 300 } }));
      para = [];
    }
  };
  for (const raw of text.replace(/\r\n?/g, "\n").split("\n")) {
    const l = raw.trim();
    let m;
    if (!l) { flush(); continue; }
    if ((m = l.match(/^(#{1,3})\s+(.*)$/))) {
      flush();
      const lvl = [D.HeadingLevel.HEADING_1, D.HeadingLevel.HEADING_2, D.HeadingLevel.HEADING_3][m[1].length - 1];
      kids.push(new D.Paragraph({ text: m[2], heading: lvl, spacing: { before: 240, after: 120 } }));
    } else if ((m = l.match(/^[-*•]\s+(.*)$/))) {
      flush();
      kids.push(new D.Paragraph({ children: [new D.TextRun(m[1])], bullet: { level: 0 }, spacing: { after: 80 } }));
    } else if ((m = l.match(/^(\d+)[.)]\s+(.*)$/))) {
      flush();
      kids.push(new D.Paragraph({
        children: [new D.TextRun(m[1] + ".\t" + m[2])],
        indent: { left: 540, hanging: 360 },
        tabStops: [{ type: D.TabStopType.LEFT, position: 540 }],
        spacing: { after: 80 }
      }));
    } else para.push(l);
  }
  flush();
  return new D.Document({
    styles: { default: { document: { run: { font: "Calibri", size: 24 } } } },
    sections: [{ properties: { page: { margin: { top: 1440, bottom: 1440, left: 1440, right: 1440 } } }, children: kids }]
  });
}

app.post("/api/docx", async (req, res) => {
  try {
    const text = (req.body.text || "").trim();
    if (!text) return res.status(400).json({ error: "No text." });
    const name = String(req.body.name || "document").replace(/[^\w\- ]+/g, "").trim() || "document";
    const buf = await docx.Packer.toBuffer(toDocx(text));
    res.set({
      "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "Content-Disposition": 'attachment; filename="' + name + '-polished.docx"'
    });
    res.send(buf);
  } catch (e) {
    res.status(500).json({ error: e.message || "Could not build the .docx." });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Doc Polisher running on port " + PORT));
