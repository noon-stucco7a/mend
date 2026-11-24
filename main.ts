// main.ts is mend, the CLI SPEC.md specifies (MIT). It implements all of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits, unified diffs (section 6), SEARCH/REPLACE blocks (section 7),
// V4A patches (section 8), line matching at three tiers (section 5) and the all-or-nothing write (section 10).
// Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

/** Successful move edits, in order, for the `R` output lines (section 2). */
type Moves = [string, string][];

// ---------- files as lines (section 3) ----------

interface FileLines {
  lines: string[];
  br: string;
  final: boolean;
}

function splitFile(text: string): FileLines {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function joinFile(fl: FileLines): string {
  if (fl.lines.length === 0) return '';
  return fl.lines.join(fl.br) + (fl.final ? fl.br : '');
}

// ---------- line matching (section 5) ----------

const rtrimST = (s: string): string => s.replace(/[ \t]+$/, '');
const trimST = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWS = (s: string): string => /^[ \t]*/.exec(s)![0];

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return rtrimST(a) === rtrimST(b);
  return trimST(a) === trimST(b);
}

/** All start positions where O occurs in lines at the given tier (occurrences may overlap). */
function occurrences(lines: string[], O: string[], tier: number): number[] {
  const out: number[] = [];
  for (let i = 0; i + O.length <= lines.length; i += 1) {
    let ok = true;
    for (let j = 0; j < O.length; j += 1) {
      if (!lineEq(lines[i + j]!, O[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

function findTier(lines: string[], O: string[], strict: boolean): { tier: number; pos: number[] } | null {
  for (const tier of strict ? [0] : [0, 1, 2]) {
    const pos = occurrences(lines, O, tier);
    if (pos.length > 0) return { tier, pos };
  }
  return null;
}

/** One body line of a hunk or chunk: context, old-only or new-only; noNL set by a following `\` line. */
interface Item {
  k: ' ' | '-' | '+' | '\\';
  t: string;
  noNL?: boolean;
}

/** The replacement lines for the O-span matched at `pos`, honouring context lines and tier-2 re-indentation. */
function buildSeg(fileLines: string[], pos: number, items: Item[], tier: number): string[] {
  const seg: string[] = [];
  const oFirst = items.find((it) => it.k === ' ' || it.k === '-')?.t ?? '';
  const P = leadWS(oFirst);
  const F = fileLines[pos] !== undefined ? leadWS(fileLines[pos]!) : '';
  let oi = 0;
  for (const it of items) {
    if (it.k === ' ') {
      seg.push(fileLines[pos + oi]!);
      oi += 1;
    } else if (it.k === '-') {
      oi += 1;
    } else if (it.k === '+') {
      let s = it.t;
      if (tier === 2 && s !== '' && trimST(s) !== '' && s.startsWith(P)) s = F + s.slice(P.length);
      seg.push(s);
    }
  }
  return seg;
}

/** Re-indent one new line at tier 2 (used where the format has no context lines). */
function reindent(s: string, fileLines: string[], pos: number, oFirst: string): string {
  if (s === '' || trimST(s) === '') return s;
  const P = leadWS(oFirst);
  if (!s.startsWith(P)) return s;
  return leadWS(fileLines[pos] ?? '') + s.slice(P.length);
}

/** Whether the hunk's last context or `+` line is followed by a `\` line. */
function lastNoNL(items: Item[]): boolean {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    if (items[i]!.k === ' ' || items[i]!.k === '+') return items[i]!.noNL === true;
  }
  return false;
}

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ---------- JSON edits (section 9) ----------

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------- unified diffs (section 6) ----------

interface Hunk {
  a: number;
  items: Item[];
}

interface Section {
  gitOld?: string;
  gitNew?: string;
  oldPath?: string | null;
  newPath?: string | null;
  hasPair: boolean;
  renameFrom?: string;
  renameTo?: string;
  newFile: boolean;
  deletedFile: boolean;
  hunks: Hunk[];
}

function parseDiffPath(line: string): string | null {
  let s = line.slice(4);
  const tab = s.indexOf('\t');
  if (tab >= 0) s = s.slice(0, tab);
  s = s.trim();
  if (s === '/dev/null') return null;
  if (s.startsWith('a/') || s.startsWith('b/')) s = s.slice(2);
  return s;
}

/** Apply one section's hunks to a file's lines; throws Fail('no-match') with an empty path for the caller to fill. */
function applyHunks(fl: FileLines, hunks: Hunk[], strict: boolean): FileLines {
  const lines = [...fl.lines];
  let final = fl.final;
  let d = 0;
  for (const hunk of hunks) {
    const oItems = hunk.items.filter((it) => it.k === ' ' || it.k === '-');
    const nCount = hunk.items.filter((it) => it.k === ' ' || it.k === '+').length;
    if (oItems.length > 0) {
      const O = oItems.map((it) => it.t);
      const f = findTier(lines, O, strict);
      if (f === null) throw new Fail('no-match', '');
      const target = hunk.a - 1 + d;
      let pos = f.pos[0]!;
      for (const p of f.pos) if (Math.abs(p - target) < Math.abs(pos - target)) pos = p;
      const seg = buildSeg(lines, pos, hunk.items, f.tier);
      const reachedEnd = pos + O.length === lines.length;
      lines.splice(pos, O.length, ...seg);
      if (reachedEnd) final = !lastNoNL(hunk.items);
      d += nCount - O.length;
    } else {
      const at = Math.min(hunk.a + d, lines.length);
      const seg = hunk.items.filter((it) => it.k === '+').map((it) => it.t);
      const reachedEnd = at === lines.length;
      lines.splice(at, 0, ...seg);
      if (reachedEnd && seg.length > 0) final = !lastNoNL(hunk.items);
      d += seg.length;
    }
  }
  return { lines, br: fl.br, final };
}

function unifiedEdits(lines: string[], strict: boolean, moves: Moves): Edit[] {
  const sections: Section[] = [];
  let sec: Section | null = null;
  let state: 'none' | 'header' | 'hunks' = 'none';
  let i = 0;
  const newSection = (): Section => {
    const s: Section = { hasPair: false, newFile: false, deletedFile: false, hunks: [] };
    sections.push(s);
    sec = s;
    state = 'header';
    return s;
  };
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.*?) b\/(.+)$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const s = newSection();
      s.gitOld = m[1]!;
      s.gitNew = m[2]!;
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (state === 'header' && sec !== null && !sec.hasPair) {
        sec.oldPath = parseDiffPath(line);
        sec.newPath = parseDiffPath(lines[i + 1]!);
        sec.hasPair = true;
      } else {
        const s = newSection();
        s.oldPath = parseDiffPath(line);
        s.newPath = parseDiffPath(lines[i + 1]!);
        s.hasPair = true;
      }
      i += 2;
      continue;
    }
    if (state === 'header' && line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
    if (line.startsWith('@@')) {
      if (sec === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      state = 'hunks';
      const items: Item[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const bl = lines[j]!;
        if (bl.startsWith('diff --git ')) break;
        if (bl.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
        if (bl === '') items.push({ k: ' ', t: '' });
        else if (bl[0] === ' ' || bl[0] === '-' || bl[0] === '+') items.push({ k: bl[0] as Item['k'], t: bl.slice(1) });
        else if (bl[0] === '\\') {
          const prev = items[items.length - 1];
          if (prev !== undefined && prev.k !== '\\') prev.noNL = true;
          else items.push({ k: '\\', t: bl.slice(1) });
        } else break;
        j += 1;
      }
      while (items.length > 0) {
        const last = items[items.length - 1]!;
        if (last.k === ' ' && last.t === '') items.pop();
        else break;
      }
      // A trailing context line with empty text (from an empty or space-only body line) is not part of the hunk.
      sec.hunks.push({ a: Number(m[1]), items });
      i = j;
      continue;
    }
    if (state === 'header' && sec !== null) {
      if (line.startsWith('rename from ')) sec.renameFrom = line.slice('rename from '.length);
      else if (line.startsWith('rename to ')) sec.renameTo = line.slice('rename to '.length);
      else if (line.startsWith('new file mode')) sec.newFile = true;
      else if (line.startsWith('deleted file mode')) sec.deletedFile = true;
    }
    i += 1;
  }
  return sections.map((s) => sectionEdit(s, strict, moves));
}

function sectionEdit(s: Section, strict: boolean, moves: Moves): Edit {
  const oldP: string | null = s.hasPair ? (s.oldPath ?? null) : (s.renameFrom ?? s.gitOld ?? null);
  const newP: string | null = s.hasPair ? (s.newPath ?? null) : (s.renameTo ?? s.gitNew ?? null);
  const creation = oldP === null || s.newFile;
  const deletion = newP === null || s.deletedFile;
  return (tree) => {
    if (creation) {
      const target = newP ?? '';
      if (!safe(target)) throw new Fail('unsafe', target);
      if (tree.get(target) !== null) throw new Fail('exists', target);
      const plus = s.hunks.flatMap((h) => h.items.filter((it) => it.k === '+'));
      const texts = plus.map((it) => it.t);
      const fin = plus.length === 0 ? true : !(plus[plus.length - 1]!.noNL === true);
      tree.now.set(target, texts.length === 0 ? '' : texts.join('\n') + (fin ? '\n' : ''));
      return;
    }
    if (deletion) {
      const source = oldP ?? '';
      if (!safe(source)) throw new Fail('unsafe', source);
      if (tree.get(source) === null) throw new Fail('missing', source);
      tree.now.set(source, null);
      return;
    }
    if (oldP !== newP) {
      const from = oldP!;
      const to = newP!;
      if (!safe(from)) throw new Fail('unsafe', from);
      if (!safe(to)) throw new Fail('unsafe', to);
      const src = tree.get(from);
      if (src === null) throw new Fail('missing', from);
      if (tree.get(to) !== null) throw new Fail('exists', to);
      let out: FileLines;
      try {
        out = applyHunks(splitFile(src), s.hunks, strict);
      } catch (e) {
        if (e instanceof Fail) throw new Fail(e.code, from);
        throw e;
      }
      tree.now.set(to, joinFile(out));
      tree.now.set(from, null);
      moves.push([from, to]);
      return;
    }
    const p = oldP!;
    if (!safe(p)) throw new Fail('unsafe', p);
    const src = tree.get(p);
    if (src === null) throw new Fail('missing', p);
    let out: FileLines;
    try {
      out = applyHunks(splitFile(src), s.hunks, strict);
    } catch (e) {
      if (e instanceof Fail) throw new Fail(e.code, p);
      throw e;
    }
    tree.now.set(p, joinFile(out));
  };
}

// ---------- SEARCH/REPLACE blocks (section 7) ----------

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let searchFrom = 0;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const sLine = i;
    let j = i + 1;
    while (j < lines.length && lines[j]!.trimEnd() !== '=======') j += 1;
    if (j >= lines.length) throw new Exit2(`error: parse ${sLine + 1}`);
    let k = j + 1;
    while (k < lines.length && lines[k]!.trimEnd() !== '>>>>>>> REPLACE') k += 1;
    if (k >= lines.length) throw new Exit2(`error: parse ${sLine + 1}`);
    const oldLines = lines.slice(i + 1, j);
    const newLines = lines.slice(j + 1, k);
    let path: string | null = null;
    for (let mIdx = sLine - 1; mIdx >= searchFrom; mIdx -= 1) {
      const cand = lines[mIdx]!;
      if (!blank(cand) && !cand.trim().startsWith('```')) {
        path = cand.trim();
        break;
      }
    }
    if (path === null) {
      if (prevPath !== null) path = prevPath;
      else throw new Exit2(`error: parse ${sLine + 1}`);
    }
    prevPath = path;
    searchFrom = k + 1;
    i = k + 1;
    const p = path;
    edits.push((tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (oldLines.length === 0) {
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
        return;
      }
      const src = tree.get(p);
      if (src === null) throw new Fail('missing', p);
      const fl = splitFile(src);
      const f = findTier(fl.lines, oldLines, strict);
      if (f === null) throw new Fail('no-match', p);
      if (f.pos.length > 1) throw new Fail('ambiguous', p);
      const pos = f.pos[0]!;
      const seg = newLines.map((s) => (f.tier === 2 ? reindent(s, fl.lines, pos, oldLines[0]!) : s));
      const out = [...fl.lines];
      out.splice(pos, oldLines.length, ...seg);
      tree.now.set(p, joinFile({ lines: out, br: fl.br, final: fl.final }));
    });
  }
  return edits;
}

// ---------- V4A patches (section 8) ----------

interface VChunk {
  anchor: string | null;
  items: Item[];
  eof: boolean;
}

interface VSection {
  kind: 'add' | 'del' | 'upd';
  path: string;
  lineNo: number;
  fileLines: string[];
  moveTo: string | null;
  chunks: VChunk[];
}

function v4aEdits(lines: string[], strict: boolean, moves: Moves): Edit[] {
  const fb = lines.findIndex((l) => !blank(l));
  if (fb < 0) throw new Exit2('error: parse 1');
  if (lines[fb]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${fb + 1}`);
  let lb = -1;
  for (let x = lines.length - 1; x >= 0; x -= 1) {
    if (!blank(lines[x]!)) {
      lb = x;
      break;
    }
  }
  if (lines[lb]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  interface Raw {
    kind: VSection['kind'];
    path: string;
    lineNo: number;
    body: { line: string; no: number }[];
  }
  const raws: Raw[] = [];
  let cur: Raw | null = null;
  for (let x = fb + 1; x < lb; x += 1) {
    const line = lines[x]!;
    const heads: [string, VSection['kind']][] = [
      ['*** Add File: ', 'add'],
      ['*** Delete File: ', 'del'],
      ['*** Update File: ', 'upd'],
    ];
    const head = heads.find(([pre]) => line.startsWith(pre));
    if (head !== undefined) {
      cur = { kind: head[1], path: line.slice(head[0].length).trim(), lineNo: x + 1, body: [] };
      raws.push(cur);
      continue;
    }
    if (cur === null) {
      if (blank(line)) continue;
      throw new Exit2(`error: parse ${x + 1}`);
    }
    cur.body.push({ line, no: x + 1 });
  }
  const sections: VSection[] = raws.map((r) => {
    const body = [...r.body];
    while (body.length > 0 && body[body.length - 1]!.line === '') body.pop();
    if (r.kind === 'add') {
      const fileLines = body.map((e) => {
        if (e.line.startsWith('+')) return e.line.slice(1);
        if (e.line === '') return '';
        throw new Exit2(`error: parse ${e.no}`);
      });
      return { kind: 'add', path: r.path, lineNo: r.lineNo, fileLines, moveTo: null, chunks: [] };
    }
    if (r.kind === 'del') {
      if (body.length > 0) throw new Exit2(`error: parse ${body[0]!.no}`);
      return { kind: 'del', path: r.path, lineNo: r.lineNo, fileLines: [], moveTo: null, chunks: [] };
    }
    let moveTo: string | null = null;
    let idx = 0;
    if (body.length > 0 && body[0]!.line.startsWith('*** Move to: ')) {
      moveTo = body[0]!.line.slice('*** Move to: '.length).trim();
      idx = 1;
    }
    const chunks: VChunk[] = [];
    let chunk: VChunk | null = null;
    for (; idx < body.length; idx += 1) {
      const e = body[idx]!;
      if (e.line.startsWith('@@')) {
        chunk = { anchor: e.line.slice(2).trim() || null, items: [], eof: false };
        chunks.push(chunk);
      } else if (e.line === '*** End of File') {
        if (chunk === null) {
          chunk = { anchor: null, items: [], eof: true };
          chunks.push(chunk);
        } else chunk.eof = true;
        chunk = null;
      } else if (e.line === '' || e.line[0] === ' ' || e.line[0] === '-' || e.line[0] === '+') {
        if (chunk === null) {
          chunk = { anchor: null, items: [], eof: false };
          chunks.push(chunk);
        }
        if (e.line === '') chunk.items.push({ k: ' ', t: '' });
        else chunk.items.push({ k: e.line[0] as Item['k'], t: e.line.slice(1) });
      } else throw new Exit2(`error: parse ${e.no}`);
    }
    if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${r.lineNo}`);
    // A trailing context line with empty text is not part of the chunk (as with unified hunk bodies).
    for (const c of chunks) {
      while (c.items.length > 0) {
        const last = c.items[c.items.length - 1]!;
        if (last.k === ' ' && last.t === '') c.items.pop();
        else break;
      }
    }
    return { kind: 'upd', path: r.path, lineNo: r.lineNo, fileLines: [], moveTo, chunks };
  });
  return sections.map((s) => v4aEdit(s, strict, moves));
}

function v4aEdit(s: VSection, strict: boolean, moves: Moves): Edit {
  return (tree) => {
    const p = s.path;
    if (s.kind === 'add') {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, s.fileLines.length === 0 ? '' : s.fileLines.join('\n') + '\n');
      return;
    }
    if (s.kind === 'del') {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    if (!safe(p)) throw new Fail('unsafe', p);
    if (s.moveTo !== null && !safe(s.moveTo)) throw new Fail('unsafe', s.moveTo);
    const src = tree.get(p);
    if (src === null) throw new Fail('missing', p);
    if (s.moveTo !== null && tree.get(s.moveTo) !== null) throw new Fail('exists', s.moveTo);
    const fl = splitFile(src);
    const out = [...fl.lines];
    let cursor = 0;
    for (const chunk of s.chunks) {
      if (chunk.anchor !== null) {
        let found = -1;
        for (const tier of strict ? [0] : [0, 1, 2]) {
          for (let x = cursor; x < out.length; x += 1) {
            if (lineEq(out[x]!, chunk.anchor, tier)) {
              found = x;
              break;
            }
          }
          if (found >= 0) break;
        }
        if (found < 0) throw new Fail('no-match', p);
        cursor = found + 1;
      }
      const oItems = chunk.items.filter((it) => it.k === ' ' || it.k === '-');
      if (oItems.length > 0) {
        const O = oItems.map((it) => it.t);
        let hit: { tier: number; pos: number } | null = null;
        for (const tier of strict ? [0] : [0, 1, 2]) {
          const cand = occurrences(out, O, tier).filter((q) => q >= cursor && (!chunk.eof || q + O.length === out.length));
          if (cand.length > 0) {
            hit = { tier, pos: cand[0]! };
            break;
          }
        }
        if (hit === null) throw new Fail('no-match', p);
        const seg = buildSeg(out, hit.pos, chunk.items, hit.tier);
        out.splice(hit.pos, O.length, ...seg);
        cursor = hit.pos + seg.length;
      } else {
        const seg = chunk.items.filter((it) => it.k === '+').map((it) => it.t);
        const at = chunk.eof ? out.length : Math.min(cursor, out.length);
        out.splice(at, 0, ...seg);
        cursor = at + seg.length;
      }
    }
    const text = joinFile({ lines: out, br: fl.br, final: fl.final });
    if (s.moveTo !== null) {
      tree.now.set(s.moveTo, text);
      tree.now.set(p, null);
      moves.push([p, s.moveTo]);
    } else tree.now.set(p, text);
  };
}

// ---------- the CLI (sections 1, 2 and 10) ----------

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  const moves: Moves = [];
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict, moves)
          : kind === 'search-replace'
            ? searchReplaceEdits(lines, strict)
            : v4aEdits(lines, strict, moves);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const changed = new Map<string, { was: string | null; now: string | null }>();
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was !== now) changed.set(p, { was, now });
  }
  const used = new Set<string>();
  const rows: { key: string; text: string }[] = [];
  for (const [from, to] of moves) {
    const cf = changed.get(from);
    const ct = changed.get(to);
    if (cf !== undefined && ct !== undefined && cf.was !== null && cf.now === null && ct.was === null && ct.now !== null && !used.has(from) && !used.has(to)) {
      rows.push({ key: to, text: `R ${from} -> ${to}` });
      used.add(from);
      used.add(to);
    }
  }
  for (const [p, c] of changed) {
    if (used.has(p)) continue;
    rows.push({ key: p, text: `${c.was === null ? 'A' : c.now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of [...changed.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
      const now = tree.now.get(p)!;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
