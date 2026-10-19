/**
 * PDF のページの中身(コンテンツストリーム)を読む小さな道具(0.3)。
 *
 * スキャンの整え(scan-pages.js)で次のことに使う:
 *  - ページが「画像1枚だけ」でできているか(スキャンしたページか)を調べる
 *  - 見開きを2ページに分けたとき、もう片方のページの OCR の文字を取り除く
 *    (そのままだと、検索や文字のコピーで、見えていない側の文字まで拾ってしまう)
 *
 * PDF の仕様(ISO 32000-1 7.2・7.8・8・9)の、コンテンツストリームの字句の規則に従う。
 * 読めないところがあっても例外にはせず、読めたところまでを返す(呼び出し側は、迷ったら手を加えない)。
 */

const WS = new Uint8Array(256);
for (const c of [0, 9, 10, 12, 13, 32]) {
  WS[c] = 1;
}
const DELIM = new Uint8Array(256);
for (const ch of "()<>[]{}/%") {
  DELIM[ch.charCodeAt(0)] = 1;
}

const isDigitStart = c => (c >= 48 && c <= 57) || c === 43 || c === 45 || c === 46; // 0-9 + - .

/**
 * コンテンツストリームを命令の並びにする。
 * @param {Uint8Array} bytes
 * @returns {Array<{op:string, args:Array, start:number, end:number}>}
 *   args の値: 数 / {name:string} / {string:true} / {array:Array} / {dict:Map} / true・false・null
 *   start・end: その命令(引数を含む)のバイト位置。取り除くときに使う
 */
export function parseOperations(bytes) {
  const n = bytes.length;
  let pos = 0;
  const ops = [];

  const skipSpace = () => {
    while (pos < n) {
      const c = bytes[pos];
      if (WS[c]) {
        pos++;
      } else if (c === 37) {
        // % から行末までは注釈
        while (pos < n && bytes[pos] !== 10 && bytes[pos] !== 13) {
          pos++;
        }
      } else {
        break;
      }
    }
  };

  const readRegular = () => {
    const s = pos;
    while (pos < n && !WS[bytes[pos]] && !DELIM[bytes[pos]]) {
      pos++;
    }
    let out = "";
    for (let i = s; i < pos; i++) {
      out += String.fromCharCode(bytes[i]);
    }
    return out;
  };

  const readName = () => {
    pos++; // "/"
    const raw = readRegular();
    return { name: raw.includes("#") ? raw.replace(/#([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))) : raw };
  };

  const skipLiteralString = () => {
    pos++; // "("
    let depth = 1;
    while (pos < n && depth > 0) {
      const c = bytes[pos++];
      if (c === 92) {
        pos++; // "\" の次の1文字は飛ばす
      } else if (c === 40) {
        depth++;
      } else if (c === 41) {
        depth--;
      }
    }
    return { string: true };
  };

  const skipHexString = () => {
    pos++; // "<"
    while (pos < n && bytes[pos] !== 62) {
      pos++;
    }
    pos++; // ">"
    return { string: true };
  };

  const readNumber = () => {
    const s = pos;
    pos++;
    while (pos < n) {
      const c = bytes[pos];
      if ((c >= 48 && c <= 57) || c === 46) {
        pos++;
      } else {
        break;
      }
    }
    let text = "";
    for (let i = s; i < pos; i++) {
      text += String.fromCharCode(bytes[i]);
    }
    const v = parseFloat(text);
    return Number.isFinite(v) ? v : 0;
  };

  // 値を1つ読む(配列・辞書の中身にも使う)。値でなければ undefined
  const readValue = () => {
    skipSpace();
    if (pos >= n) {
      return undefined;
    }
    const c = bytes[pos];
    if (c === 47) {
      return readName();
    }
    if (c === 40) {
      return skipLiteralString();
    }
    if (c === 60) {
      if (bytes[pos + 1] === 60) {
        return readDict();
      }
      return skipHexString();
    }
    if (c === 91) {
      return readArray();
    }
    if (isDigitStart(c)) {
      return readNumber();
    }
    return undefined;
  };

  const readArray = () => {
    pos++; // "["
    const items = [];
    for (;;) {
      skipSpace();
      if (pos >= n) {
        break;
      }
      if (bytes[pos] === 93) {
        pos++;
        break;
      }
      const v = readValue();
      if (v === undefined) {
        // 配列の中のキーワード(true / false / null など)
        const word = readRegular();
        if (!word) {
          pos++; // 読めない文字は飛ばす
        } else {
          items.push(word === "true" ? true : word === "false" ? false : null);
        }
      } else {
        items.push(v);
      }
    }
    return { array: items };
  };

  const readDict = () => {
    pos += 2; // "<<"
    const map = new Map();
    for (;;) {
      skipSpace();
      if (pos >= n) {
        break;
      }
      if (bytes[pos] === 62 && bytes[pos + 1] === 62) {
        pos += 2;
        break;
      }
      const key = readValue();
      if (!key || typeof key !== "object" || !("name" in key)) {
        // 壊れた辞書: 1文字飛ばして続ける
        if (key === undefined) {
          const word = readRegular();
          if (!word) {
            pos++;
          }
        }
        continue;
      }
      let v = readValue();
      if (v === undefined) {
        const word = readRegular();
        v = word === "true" ? true : word === "false" ? false : null;
      }
      map.set(key.name, v);
    }
    return { dict: map };
  };

  // BI … ID <画像のデータ> EI(インライン画像)。データの中に "EI" があっても止まらないよう、長さが書かれていれば使う
  const readInlineImage = start => {
    const map = new Map();
    for (;;) {
      skipSpace();
      if (pos >= n) {
        break;
      }
      const v = readValue();
      if (v === undefined) {
        const word = readRegular();
        if (word === "ID") {
          break;
        }
        if (!word) {
          pos++;
        }
        continue;
      }
      if (typeof v === "object" && v && "name" in v) {
        let value = readValue();
        if (value === undefined) {
          const word = readRegular();
          if (word === "ID") {
            break;
          }
          value = word;
        }
        map.set(v.name, value);
      }
    }
    // "ID" の後の空白1文字の次からがデータ
    if (pos < n && WS[bytes[pos]]) {
      pos++;
    }
    const length = map.get("L") ?? map.get("Length");
    let end = -1;
    if (typeof length === "number" && length >= 0 && pos + length <= n) {
      let p = pos + length;
      while (p < n && WS[bytes[p]]) {
        p++;
      }
      if (bytes[p] === 69 && bytes[p + 1] === 73) {
        end = p + 2;
      }
    }
    if (end < 0) {
      for (let p = pos; p + 1 < n; p++) {
        if (bytes[p] === 69 && bytes[p + 1] === 73 && (p === 0 || WS[bytes[p - 1]]) && (p + 2 >= n || WS[bytes[p + 2]] || DELIM[bytes[p + 2]])) {
          end = p + 2;
          break;
        }
      }
    }
    pos = end < 0 ? n : end;
    return { op: "BI", args: [{ dict: map }], start, end: pos };
  };

  let operands = [];
  let opStart = -1;
  while (pos < n) {
    skipSpace();
    if (pos >= n) {
      break;
    }
    const tokenStart = pos;
    const c = bytes[pos];
    const v = readValue();
    if (v !== undefined) {
      if (opStart < 0) {
        opStart = tokenStart;
      }
      operands.push(v);
      continue;
    }
    if (c === 93 || c === 62 || c === 41 || c === 123 || c === 125) {
      pos++; // 対応の無い閉じ括弧などは飛ばす
      continue;
    }
    const word = readRegular();
    if (!word) {
      pos++;
      continue;
    }
    if (word === "true" || word === "false" || word === "null") {
      if (opStart < 0) {
        opStart = tokenStart;
      }
      operands.push(word === "true" ? true : word === "false" ? false : null);
      continue;
    }
    const start = opStart < 0 ? tokenStart : opStart;
    if (word === "BI") {
      ops.push(readInlineImage(start));
    } else {
      ops.push({ op: word, args: operands, start, end: pos });
    }
    operands = [];
    opStart = -1;
  }
  return ops;
}

// ---------------------------------------------------------------------------
// 行列(PDF の行列 [a b c d e f]。点は行ベクトルで右から掛ける)
// ---------------------------------------------------------------------------

/** m を先に、n を後に適用する行列(PDF の「m × n」) */
export function multiply(m, n) {
  return [
    m[0] * n[0] + m[1] * n[2],
    m[0] * n[1] + m[1] * n[3],
    m[2] * n[0] + m[3] * n[2],
    m[2] * n[1] + m[3] * n[3],
    m[4] * n[0] + m[5] * n[2] + n[4],
    m[4] * n[1] + m[5] * n[3] + n[5],
  ];
}

export function applyPoint(m, x, y) {
  return [x * m[0] + y * m[2] + m[4], x * m[1] + y * m[3] + m[5]];
}

const IDENTITY = Object.freeze([1, 0, 0, 1, 0, 0]);

function numbers(args, count) {
  if (args.length < count) {
    return null;
  }
  const out = args.slice(args.length - count);
  return out.every(v => typeof v === "number") ? out : null;
}

const PAINT_OPS = new Set(["S", "s", "f", "F", "f*", "B", "B*", "b", "b*", "sh"]);
const SHOW_OPS = new Set(["Tj", "TJ", "'", '"']);

/**
 * 命令の並びをたどって、描くものを調べる。
 * @param {Array} ops parseOperations() の結果
 * @param {object} o
 * @param {number[]} [o.ctm] 最初の行列(フォーム XObject の中を調べるとき)
 * @param {(name:string) => ("image"|"form"|null)} [o.xobjectType] XObject の種類
 * @returns {{images:Array<{name:string|null, ctm:number[], inline:boolean}>, forms:Array<{name:string, ctm:number[]}>,
 *   visiblePaint:boolean, visibleText:boolean, texts:Array<{index:number, x:number, y:number}>}}
 *   texts: 文字を描く命令(Tj TJ ' ")の位置(ユーザー空間での文字の書き始め)
 */
export function walkOperations(ops, { ctm: startCtm = IDENTITY, xobjectType = () => null } = {}) {
  let ctm = startCtm.slice();
  const stack = [];
  let tm = IDENTITY.slice();
  let tlm = IDENTITY.slice();
  let leading = 0;
  let renderMode = 0;
  const modeStack = [];
  const images = [];
  const forms = [];
  const texts = [];
  let visiblePaint = false;
  let visibleText = false;

  const moveText = (tx, ty) => {
    tlm = multiply([1, 0, 0, 1, tx, ty], tlm);
    tm = tlm.slice();
  };

  for (let i = 0; i < ops.length; i++) {
    const { op, args } = ops[i];
    switch (op) {
      case "q":
        stack.push(ctm);
        modeStack.push(renderMode);
        break;
      case "Q":
        if (stack.length) {
          ctm = stack.pop();
          renderMode = modeStack.pop();
        }
        break;
      case "cm": {
        const m = numbers(args, 6);
        if (m) {
          ctm = multiply(m, ctm);
        }
        break;
      }
      case "BT":
        tm = IDENTITY.slice();
        tlm = IDENTITY.slice();
        break;
      case "Tm": {
        const m = numbers(args, 6);
        if (m) {
          tm = m.slice();
          tlm = m.slice();
        }
        break;
      }
      case "Td": {
        const m = numbers(args, 2);
        if (m) {
          moveText(m[0], m[1]);
        }
        break;
      }
      case "TD": {
        const m = numbers(args, 2);
        if (m) {
          leading = -m[1];
          moveText(m[0], m[1]);
        }
        break;
      }
      case "TL": {
        const m = numbers(args, 1);
        if (m) {
          leading = m[0];
        }
        break;
      }
      case "T*":
        moveText(0, -leading);
        break;
      case "Tr": {
        const m = numbers(args, 1);
        if (m) {
          renderMode = m[0];
        }
        break;
      }
      case "Do": {
        const name = args[args.length - 1]?.name;
        if (name) {
          const type = xobjectType(name);
          if (type === "image") {
            images.push({ name, ctm: ctm.slice(), inline: false });
          } else if (type === "form") {
            forms.push({ name, ctm: ctm.slice() });
          }
        }
        break;
      }
      case "BI":
        images.push({ name: null, ctm: ctm.slice(), inline: true });
        break;
      default:
        if (PAINT_OPS.has(op)) {
          visiblePaint = true;
        } else if (SHOW_OPS.has(op)) {
          if (op === "'" || op === '"') {
            moveText(0, -leading);
          }
          const [x, y] = applyPoint(ctm, tm[4], tm[5]);
          texts.push({ index: i, x, y });
          // 3 = 見えない文字(OCR の文字など)、7 = 切り抜きに使うだけ
          if (renderMode !== 3 && renderMode !== 7) {
            visibleText = true;
          }
        }
    }
  }
  return { images, forms, visiblePaint, visibleText, texts };
}

/**
 * 指定の範囲の外にある文字(Tj TJ ' ")を取り除いたコンテンツストリームを作る。
 * ' と " は「次の行へ移る」働きも持つので、移る部分(T* など)は残す。
 * @param {Uint8Array} bytes
 * @param {Array} ops parseOperations(bytes)
 * @param {Array<{index:number,x:number,y:number}>} texts walkOperations().texts
 * @param {(x:number, y:number) => boolean} keep 残す位置なら true
 * @returns {{bytes:Uint8Array, removed:number}}
 */
export function removeTextOutside(bytes, ops, texts, keep) {
  const cuts = [];
  for (const t of texts) {
    if (keep(t.x, t.y)) {
      continue;
    }
    const o = ops[t.index];
    let replacement = "";
    if (o.op === "'") {
      replacement = " T*";
    } else if (o.op === '"') {
      const [aw, ac] = o.args;
      replacement = typeof aw === "number" && typeof ac === "number" ? ` ${aw} Tw ${ac} Tc T*` : " T*";
    }
    cuts.push({ start: o.start, end: o.end, replacement });
  }
  if (!cuts.length) {
    return { bytes, removed: 0 };
  }
  cuts.sort((a, b) => a.start - b.start);
  const enc = new TextEncoder();
  const parts = [];
  let total = 0;
  let last = 0;
  for (const cut of cuts) {
    if (cut.start < last) {
      continue;
    }
    parts.push(bytes.subarray(last, cut.start));
    total += cut.start - last;
    const r = enc.encode(cut.replacement + " ");
    parts.push(r);
    total += r.length;
    last = cut.end;
  }
  parts.push(bytes.subarray(last));
  total += bytes.length - last;
  const out = new Uint8Array(total);
  let p = 0;
  for (const part of parts) {
    out.set(part, p);
    p += part.length;
  }
  return { bytes: out, removed: cuts.length };
}
