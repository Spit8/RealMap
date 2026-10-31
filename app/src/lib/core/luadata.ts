/**
 * Reader for the userdata files the game writes with app.saveUserdata:
 *   function data() return { key = value, … } end
 * Literal tables only (strings, numbers, booleans, nil, nested tables) — no code is evaluated.
 * Tables with keys 1..n become arrays, others plain objects.
 */
export type LuaValue = string | number | boolean | null | LuaValue[] | { [key: string]: LuaValue };

class Parser {
  private i = 0;
  constructor(private readonly s: string) {}

  private ws(): void {
    for (;;) {
      while (this.i < this.s.length && /\s/.test(this.s[this.i])) this.i++;
      if (this.s.startsWith("--", this.i)) {
        const nl = this.s.indexOf("\n", this.i);
        this.i = nl < 0 ? this.s.length : nl + 1;
      } else return;
    }
  }

  private fail(msg: string): never {
    throw new Error(`luadata: ${msg} at ${this.i}`);
  }

  expectWord(w: string): void {
    this.ws();
    if (!this.s.startsWith(w, this.i)) this.fail(`expected ${w}`);
    this.i += w.length;
  }

  value(): LuaValue {
    this.ws();
    const c = this.s[this.i];
    if (c === "{") return this.table();
    if (c === '"' || c === "'") return this.string();
    if (this.s.startsWith("true", this.i)) { this.i += 4; return true; }
    if (this.s.startsWith("false", this.i)) { this.i += 5; return false; }
    if (this.s.startsWith("nil", this.i)) { this.i += 3; return null; }
    const m = /^[-+]?(?:inf|nan|0x[0-9a-fA-F]+|\d*\.?\d+(?:[eE][-+]?\d+)?)/.exec(this.s.slice(this.i, this.i + 40));
    if (!m) this.fail("unexpected token");
    this.i += m[0].length;
    if (/inf/.test(m[0])) return m[0].startsWith("-") ? -Infinity : Infinity;
    if (/nan/.test(m[0])) return NaN;
    return Number(m[0]);
  }

  private string(): string {
    const q = this.s[this.i++];
    let out = "";
    while (this.i < this.s.length && this.s[this.i] !== q) {
      let ch = this.s[this.i++];
      if (ch === "\\") {
        const e = this.s[this.i++];
        const map: Record<string, string> = { n: "\n", t: "\t", r: "\r", "\\": "\\", '"': '"', "'": "'", "\n": "\n" };
        if (/\d/.test(e)) {
          let d = e;
          while (d.length < 3 && /\d/.test(this.s[this.i])) d += this.s[this.i++];
          ch = String.fromCharCode(Number(d));
        } else ch = map[e] ?? e;
      }
      out += ch;
    }
    this.i++;
    // The game writes UTF-8 bytes; JS strings came from a UTF-8 decoded file already.
    return out;
  }

  private table(): LuaValue {
    this.i++; // {
    const arr: LuaValue[] = [];
    const obj: Record<string, LuaValue> = {};
    let isArray = true;
    for (;;) {
      this.ws();
      if (this.s[this.i] === "}") { this.i++; break; }
      let key: string | number | null = null;
      if (this.s[this.i] === "[") {
        this.i++;
        const k = this.value();
        this.ws();
        if (this.s[this.i] !== "]") this.fail("expected ]");
        this.i++;
        this.expectWord("=");
        key = typeof k === "number" ? k : String(k);
      } else {
        const m = /^[A-Za-z_][A-Za-z0-9_]*\s*=(?!=)/.exec(this.s.slice(this.i, this.i + 80));
        if (m) {
          key = m[0].slice(0, m[0].indexOf("=")).trim();
          this.i += m[0].length;
        }
      }
      const v = this.value();
      if (key === null) arr.push(v);
      else if (typeof key === "number" && key === arr.length + 1 && isArray) arr.push(v);
      else {
        isArray = false;
        obj[String(key)] = v;
      }
      this.ws();
      if (this.s[this.i] === "," || this.s[this.i] === ";") this.i++;
    }
    if (isArray && Object.keys(obj).length === 0) return arr;
    arr.forEach((v, k) => (obj[String(k + 1)] = v));
    return obj;
  }
}

/** Parse a `function data() return … end` file; null when it is not one (or is being written). */
export function parseUserdata(text: string): LuaValue | null {
  try {
    const start = text.search(/return\s/);
    if (start < 0) return null;
    const p = new Parser(text.slice(start + 6));
    return p.value();
  } catch {
    return null;
  }
}

/** Serialise a plain JS value as a userdata file the game can read with app.loadUserdata. */
export function toUserdata(value: LuaValue): string {
  const ser = (v: LuaValue, ind: string): string => {
    if (v === null) return "nil";
    if (typeof v === "boolean") return v ? "true" : "false";
    if (typeof v === "number") return Number.isFinite(v) ? String(v) : "0";
    if (typeof v === "string") return JSON.stringify(v);
    const inner = ind + "\t";
    if (Array.isArray(v)) return `{\n${v.map((x) => `${inner}${ser(x, inner)},`).join("\n")}\n${ind}}`;
    const keys = Object.keys(v).filter((k) => v[k] !== undefined);
    const key = (k: string) => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) ? k : `[${JSON.stringify(k)}]`);
    return `{\n${keys.map((k) => `${inner}${key(k)} = ${ser(v[k], inner)},`).join("\n")}\n${ind}}`;
  };
  return `function data()\nreturn ${ser(value, "")}\nend\n`;
}
