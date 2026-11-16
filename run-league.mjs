// ../../../private/tmp/pf-src6/scripts/poker/arena/run-league.ts
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { brotliDecompressSync } from "node:zlib";

// ../../../private/tmp/pf-src6/src/lib/poker-postflop/library.ts
var SUIT_PERMS = (() => {
  const out2 = [];
  const build = (prefix) => {
    if (prefix.length === 4) {
      out2.push(prefix);
      return;
    }
    for (let s = 0; s < 4; s += 1) if (!prefix.includes(s)) build([...prefix, s]);
  };
  build([]);
  return out2;
})();
var mapCard = (card, perm) => card & ~3 | perm[card & 3];
function compareCards(a, b) {
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}
function canonicalize(flop) {
  let best = null;
  let bestPerm = SUIT_PERMS[0];
  for (const perm of SUIT_PERMS) {
    const mapped = flop.map((card) => mapCard(card, perm)).sort((a, b) => a - b);
    if (!best || compareCards(mapped, best) < 0) {
      best = mapped;
      bestPerm = perm;
    }
  }
  return { cards: best, perm: bestPerm };
}
function handChecksum(game) {
  let hash = 2166136261;
  const mix = (byte) => {
    hash ^= byte & 255;
    hash = Math.imul(hash, 16777619) >>> 0;
  };
  for (const hands of game.hands) {
    for (let h = 0; h < hands.count; h += 1) {
      mix(hands.cards[2 * h]);
      mix(hands.cards[2 * h + 1]);
      const w = Math.round(hands.weight[h] * 1e4);
      mix(w);
      mix(w >> 8);
    }
  }
  return hash >>> 0;
}
var Reader = class {
  constructor(bytes) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  bytes;
  at = 0;
  view;
  u8() {
    if (this.at >= this.bytes.length) throw new Error("Stored flop record is truncated.");
    return this.bytes[this.at++];
  }
  u16() {
    return this.u8() | this.u8() << 8;
  }
  u32() {
    return (this.u16() | this.u16() << 16) >>> 0;
  }
  f32() {
    const v = this.view.getFloat32(this.at, true);
    this.at += 4;
    return v;
  }
  varint() {
    let result = 0;
    let scale = 1;
    for (; ; ) {
      const byte = this.u8();
      result += (byte & 127) * scale;
      if (byte < 128) return result;
      scale *= 128;
    }
  }
};
var unzigzag = (n) => n % 2 === 0 ? n / 2 : -(n + 1) / 2;
function liveHands(game, player, card) {
  const hands = game.hands[player];
  const out2 = [];
  for (let h = 0; h < hands.count; h += 1) if (hands.cards[2 * h] !== card && hands.cards[2 * h + 1] !== card) out2.push(h);
  return out2;
}
function decodeFlopRecord(game, bytes, actors) {
  const r = new Reader(bytes);
  const magic = String.fromCharCode(r.u8(), r.u8(), r.u8(), r.u8());
  if (magic !== "PFL1") throw new Error("Not a stored flop record.");
  const version = r.u8();
  const spot = r.u8();
  const flop = [r.u8(), r.u8(), r.u8()];
  const nodes = r.u8();
  const h0 = r.u16();
  const h1 = r.u16();
  const checksum = r.u32();
  if (h0 !== game.hands[0].count || h1 !== game.hands[1].count || checksum !== handChecksum(game)) throw new Error("Stored flop record was solved for different ranges.");
  const step = r.f32();
  const exploitability = r.f32();
  const roots = r.u16();
  const cardCount = r.u8();
  const turnCards = Array.from({ length: cardCount }, () => r.u8());
  if (nodes !== actors.length) throw new Error("Stored flop record has a different betting tree.");
  const strategies = [];
  for (let n = 0; n < nodes; n += 1) {
    const actions = r.u8();
    const hands = game.hands[actors[n]].count;
    const out2 = new Float32Array(actions * hands);
    const rest = new Float32Array(hands).fill(1);
    for (let a = 0; a < actions - 1; a += 1) {
      for (let h = 0; h < hands; h += 1) {
        const p = r.u8() / 255;
        out2[a * hands + h] = p;
        rest[h] -= p;
      }
    }
    for (let h = 0; h < hands; h += 1) out2[(actions - 1) * hands + h] = Math.max(0, rest[h]);
    strategies.push(out2);
  }
  const flopEv = [];
  for (let n = 0; n < nodes + roots; n += 1) {
    flopEv.push([0, 1].map((player) => {
      const out2 = new Float64Array(game.hands[player].count);
      let previous = 0;
      for (let h = 0; h < out2.length; h += 1) {
        previous += unzigzag(r.varint());
        out2[h] = previous * step;
      }
      return out2;
    }));
  }
  const values = [];
  for (let root = 0; root < roots; root += 1) {
    const perRoot = [];
    for (let c = 0; c < cardCount; c += 1) {
      const perCard = [];
      for (const player of [0, 1]) {
        const out2 = new Float64Array(game.hands[player].count).fill(NaN);
        let previous = 0;
        for (const h of liveHands(game, player, turnCards[c])) {
          previous += unzigzag(r.varint());
          out2[h] = previous * step;
        }
        perCard.push(out2);
      }
      perRoot.push(perCard);
    }
    values.push(perRoot);
  }
  return { version, spot, flop, strategies, step, exploitability, turnCards, flopEv, values };
}
function flopShape(game) {
  const nodes = game.tree.templates[0].nodes;
  const decisions = [];
  const roots = [];
  const visit = (id, path) => {
    const node = nodes[id];
    if (node.kind === "decision") {
      decisions.push({ id, actor: node.player, path });
      node.children.forEach((child, a) => visit(child, [...path, { action: a }]));
    } else if (node.kind === "end" && !node.allIn && node.next >= 0) {
      roots.push(path);
    }
  };
  visit(0, []);
  return { decisions, roots };
}

// ../../../private/tmp/pf-src6/src/lib/poker/cards.ts
var RANK_CHARS = "23456789TJQKA";
var SUIT_CHARS = "cdhs";
var rankOf = (card) => card >> 2;
var suitOf = (card) => card & 3;
function cardToString(card) {
  return RANK_CHARS[rankOf(card)] + SUIT_CHARS[suitOf(card)];
}
function choose(n, k) {
  if (k < 0 || k > n) return 0;
  const kk = Math.min(k, n - k);
  let result = 1;
  for (let i = 1; i <= kk; i += 1) result = result * (n - kk + i) / i;
  return Math.round(result);
}

// ../../../private/tmp/pf-src6/src/lib/poker/random.ts
function createU32Rng(seed2) {
  let a = 2654435769 | 0;
  let b = 608135816 | 0;
  let c = 3084996962 | 0;
  let d = seed2 | 0;
  const next = () => {
    const t = a + b | 0;
    a = b ^ b >>> 9;
    b = c + (c << 3) | 0;
    c = c << 21 | c >>> 11;
    d = d + 1 | 0;
    const out2 = t + d | 0;
    c = c + out2 | 0;
    return out2 >>> 0;
  };
  for (let i = 0; i < 15; i += 1) next();
  return next;
}
function createRng(seed2) {
  const next = createU32Rng(seed2);
  return () => next() / 4294967296;
}

// ../../../private/tmp/pf-src6/src/lib/poker-preflop/hands.ts
var HAND_COUNT = 169;
var TOTAL_COMBOS = 1326;
var COMBOS_AFTER_ONE_HAND = 1225;
function classCombos(index) {
  const row = Math.floor(index / 13);
  const col = index % 13;
  const out2 = [];
  if (row === col) {
    const r = 12 - row;
    for (let s1 = 0; s1 < 4; s1 += 1) for (let s2 = s1 + 1; s2 < 4; s2 += 1) out2.push([r * 4 + s1, r * 4 + s2]);
  } else if (row < col) {
    const hi = 12 - row;
    const lo = 12 - col;
    for (let s = 0; s < 4; s += 1) out2.push([hi * 4 + s, lo * 4 + s]);
  } else {
    const hi = 12 - col;
    const lo = 12 - row;
    for (let s1 = 0; s1 < 4; s1 += 1) for (let s2 = 0; s2 < 4; s2 += 1) if (s1 !== s2) out2.push([hi * 4 + s1, lo * 4 + s2]);
  }
  return out2;
}
var COMBO_COUNT = (() => {
  const counts = new Float64Array(HAND_COUNT);
  for (let i = 0; i < HAND_COUNT; i += 1) counts[i] = classCombos(i).length;
  return counts;
})();
var HAND_PRIOR = (() => {
  const prior = new Float64Array(HAND_COUNT);
  for (let i = 0; i < HAND_COUNT; i += 1) prior[i] = COMBO_COUNT[i] / TOTAL_COMBOS;
  return prior;
})();
var OPPONENT_GIVEN_HAND = (() => {
  const weights = new Float64Array(HAND_COUNT * HAND_COUNT);
  const combos = Array.from({ length: HAND_COUNT }, (_, i) => classCombos(i));
  for (let i = 0; i < HAND_COUNT; i += 1) {
    const [a, b] = combos[i][0];
    for (let j = 0; j < HAND_COUNT; j += 1) {
      let free = 0;
      for (const [c, d] of combos[j]) if (c !== a && c !== b && d !== a && d !== b) free += 1;
      weights[i * HAND_COUNT + j] = free / COMBOS_AFTER_ONE_HAND;
    }
  }
  return weights;
})();

// ../../../private/tmp/pf-src6/src/lib/poker-postflop/presets.ts
var HEADS_UP_RANGES = [
  "aaaaaaaaaabfiaaaabuuuuuuuuaaabouuuuuuuuajsaluuuuuuuuauuuauuuuuuuuauuuuatuuuurcauuuuuapuusaaauuuuuualuuaaluuuuuuuatuaauuuuubaaaaubauuuutaaaaaaaauuuubaaaaaaaauuuuaaaaaaaaa",
  "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuaauuuuuuuuuuuaauuuuuuuuuuuaauuuuupaaauuoauuuuuaaaaauaauuuuuaaaaaauauuuueaaaaaaau"
];
var COLD_CALL_RANGES = {
  "co-btn": [
    "uuuuuuuuuuuuuuuuuuuuaaaaaauuuuuuaaaaaaauuuuuaaaaaaaauujaufaaaaaaaumaaauaaaaaaauaaaaauaaaaaauaaaaaauaaaaauaaaaaaauaaaauaaaaaaaauaaauaaaaaaaaauaauaaaaaaaaaauaaaaaaaaaaaaau",
    "aaaaaauuuucaaaaaafaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaadaaaaaaaaaaaauaaaaaaaaaaaamaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaau"
  ],
  "hj-btn": [
    "uuuuuuuuuuubauuuuutaaaaaaauuuuuaaaaaaaauuautaaaaaaaaunaauaaaaaaaauaaaauaaaaaaauaaaaauaaaaaauaaaaaauaaaaaaaaaaaaauaaaaaaaaaaaaauaaaaaaaaaaaaauaaaaaaaaaaaaauaaaaaaaaaaaaaa",
    "aaaaauupaaaaaaaabbaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaataaaaaaaaaaaauaaaaaaaaaaaabaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaanaaaaaaaaaaaaauaaaaaaaaaaaaauaaaaaaaaaaaaau"
  ],
  "utg-btn": [
    "uuuuuuuuaueaauuuuuaaaaaaaauuuukaaaaaaaaufauaaaaaaaaauaaauaaaaaaaauaaaauaaaaaaataaaaauaaaaaaaaaaaaauaaaaaaaaaaaaauaaaaaaaaaaaaauaaaaaaaaaaaaauaaaaaaaaaaaaaeaaaaaaaaaaaaaa",
    "aaauuuiaaaaaaaaaoaaaaaaaaaaeaaaaaaaaaaauaaaaaaaaaaaauaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaakaaaaaaaaaaaaauaaaaaaaaaaaaauaaaaaaaaaaaaauaaaaaaaaaaaaauaaaaaaaaaaaaauaaaaaaaaaaaaaa"
  ],
  "btn-sb": [
    "aaaaaaauuuuuuaaaauuuaaaaaaaaaetaaaaaaaaaqaaaaaaaaaaaauaaaaaaaaaaaauaaaaaaaaaaauaaaaaaaaaaaauaaaaaaaaaaaauaaaaaaaaaaaauaaaaaaaacaaauaaaaaaaaauaauaaaaaaaaaauauaaaaaaaaaaau",
    "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuujaaauuuuuuuaaaaaauuuuuuuaaaaaauuuuauuaaaaaauuuaaauaaaaaauuaaaaauaaaaauuaaaaaauaaaauuaaaaaaauaaaucaaaaaaaauaauaaaaaaaaaauauaaaaaaaaaaau"
  ]
};
var SPOT_PRESETS = [
  { id: "btn-bb", opener: "BTN", label: "BTN opens, BB calls", players: ["BB", "BTN"], noDonk: true, pot: 5.5, stack: 97.5 },
  { id: "co-bb", opener: "CO", label: "CO opens, BB calls", players: ["BB", "CO"], noDonk: true, pot: 5.5, stack: 97.5 },
  { id: "hj-bb", opener: "HJ", label: "HJ opens, BB calls", players: ["BB", "HJ"], noDonk: true, pot: 5.5, stack: 97.5 },
  { id: "utg-bb", opener: "UTG", label: "UTG opens, BB calls", players: ["BB", "UTG"], noDonk: true, pot: 5.5, stack: 97.5 },
  { id: "sb-bb", opener: "SB", label: "SB opens, BB calls", players: ["SB", "BB"], noDonk: false, pot: 6, stack: 97 },
  // 3-bet pots: out-of-position 3-bets are 4x the open, in-position ones 3x (the preflop solver's sizes).
  { id: "btn-bb-3bet", opener: "BTN", threeBettor: "BB", label: "BB 3-bets BTN, BTN calls", players: ["BB", "BTN"], noDonk: false, pot: 20.5, stack: 90 },
  { id: "btn-sb-3bet", opener: "BTN", threeBettor: "SB", label: "SB 3-bets BTN, BTN calls", players: ["SB", "BTN"], noDonk: false, pot: 21, stack: 90 },
  { id: "co-btn-3bet", opener: "CO", threeBettor: "BTN", label: "BTN 3-bets CO, CO calls", players: ["CO", "BTN"], noDonk: true, pot: 16.5, stack: 92.5 },
  { id: "sb-bb-3bet", opener: "SB", threeBettor: "BB", label: "BB 3-bets SB, SB calls", players: ["SB", "BB"], noDonk: true, pot: 18, stack: 91 },
  // Heads-up: the small blind is the button, so it is in position after the flop.
  { id: "hu-sb-bb", opener: "SB", label: "Heads-up, SB opens, BB calls", players: ["BB", "SB"], noDonk: true, pot: 5, stack: 97.5, fixedRanges: HEADS_UP_RANGES },
  { id: "co-btn", caller: "BTN", opener: "CO", label: "CO opens, BTN calls", players: ["CO", "BTN"], noDonk: false, pot: 6.5, stack: 97.5, fixedRanges: COLD_CALL_RANGES["co-btn"] },
  { id: "hj-btn", caller: "BTN", opener: "HJ", label: "HJ opens, BTN calls", players: ["HJ", "BTN"], noDonk: false, pot: 6.5, stack: 97.5, fixedRanges: COLD_CALL_RANGES["hj-btn"] },
  { id: "utg-btn", caller: "BTN", opener: "UTG", label: "UTG opens, BTN calls", players: ["UTG", "BTN"], noDonk: false, pot: 6.5, stack: 97.5, fixedRanges: COLD_CALL_RANGES["utg-btn"] },
  { id: "btn-sb", caller: "SB", opener: "BTN", label: "BTN opens, SB calls", players: ["SB", "BTN"], noDonk: true, pot: 6, stack: 97.5, fixedRanges: COLD_CALL_RANGES["btn-sb"] }
];
function findNode(tree, spot) {
  return tree.decisions.find((node) => node.spot === spot) ?? null;
}
function presetRanges(tree, strategy, preset) {
  if (preset.fixedRanges) {
    const decode = (text) => Float64Array.from(text, (ch) => (ch.charCodeAt(0) - 97) / 20);
    return [decode(preset.fixedRanges[0]), decode(preset.fixedRanges[1])];
  }
  const open = findNode(tree, `${preset.opener} first in`);
  if (!open) return null;
  const share = (node, kind, hand) => {
    const index = node.actions.findIndex((action) => action.kind === kind);
    return index < 0 ? -1 : strategy[node.id][hand * node.actions.length + index];
  };
  const opener = new Float64Array(HAND_COUNT);
  const other2 = new Float64Array(HAND_COUNT);
  if (preset.threeBettor) {
    const threeBet = findNode(tree, `${preset.threeBettor} vs ${preset.opener} open`);
    const call = findNode(tree, `${preset.opener} vs ${preset.threeBettor} 3-bet`);
    if (!threeBet || !call) return null;
    for (let hand = 0; hand < HAND_COUNT; hand += 1) {
      const a = share(open, "raise", hand);
      const b = share(call, "call", hand);
      const c = share(threeBet, "raise", hand);
      if (a < 0 || b < 0 || c < 0) return null;
      opener[hand] = roundWeight(a * b);
      other2[hand] = roundWeight(c);
    }
  } else {
    const defend = findNode(tree, `${preset.caller ?? "BB"} vs ${preset.opener} open`);
    if (!defend) return null;
    for (let hand = 0; hand < HAND_COUNT; hand += 1) {
      const a = share(open, "raise", hand);
      const b = share(defend, "call", hand);
      if (a < 0 || b < 0) return null;
      opener[hand] = roundWeight(a);
      other2[hand] = roundWeight(b);
    }
  }
  return preset.players[0] === preset.opener ? [opener, other2] : [other2, opener];
}
function roundWeight(value) {
  const rounded = Math.round(value * 20) / 20;
  return rounded < 0.05 ? 0 : rounded;
}
var DEFAULT_SIZES = [
  { bet: [0.33], raise: [Infinity] },
  { bet: [0.75], raise: [Infinity] },
  { bet: [0.75], raise: [Infinity] }
];
function sizesFor(plan, noDonk) {
  const ip = plan.map((street) => ({ bet: [...street.bet], raise: street.raise.map((size) => Number.isFinite(size) ? size : 1e6) }));
  const oop = ip.map((street, index) => noDonk && index === 0 ? { bet: [], raise: street.raise } : { bet: [...street.bet], raise: [...street.raise] });
  return [oop, ip];
}

// ../../../private/tmp/pf-src6/src/lib/poker-postflop/tree.ts
var EPS = 1e-9;
function round(value) {
  return Math.round(value * 100) / 100;
}
function buildBettingTree(config, rootStreet) {
  const templates = [];
  const { pot, stack, allIn, allInThreshold, maxRaises } = config;
  const buildStreet = (street, start, parent) => {
    const template = { id: templates.length, street, depth: street - rootStreet, nodes: [], parent };
    templates.push(template);
    const pendingEnds = [];
    const addNode = (node) => {
      template.nodes.push(node);
      return template.nodes.length - 1;
    };
    const decide = (player, invested, raises, checked) => {
      const me = invested[player];
      const them = invested[1 - player];
      const facing = them - me;
      const potNow = pot + invested[0] + invested[1];
      const node = { kind: "decision", player, invested: [invested[0], invested[1]], actions: [], children: [] };
      const id = addNode(node);
      const actions = [];
      const room = stack - me;
      const sizedAction = (put, kind) => {
        let amount = round(put);
        if (amount >= room - EPS || amount >= allInThreshold * room - EPS) amount = room;
        if (amount <= facing + EPS) return;
        const isAllIn = Math.abs(amount - room) < EPS;
        const total = round(me + amount);
        if (actions.some((action) => Math.abs(action.total - total) < EPS)) return;
        actions.push({ kind: isAllIn ? "allin" : kind, put: isAllIn ? room : amount, total: isAllIn ? stack : total });
      };
      if (facing <= EPS) {
        actions.push({ kind: "check", put: 0, total: me });
        if (room > EPS) {
          for (const size of config.sizes[player][street].bet) sizedAction(size * potNow, "bet");
          if (allIn) sizedAction(room, "bet");
        }
      } else {
        actions.push({ kind: "fold", put: 0, total: me });
        const callPut = Math.min(facing, room);
        actions.push({ kind: "call", put: callPut, total: me + callPut });
        if (raises < maxRaises && them < stack - EPS && room > facing + EPS) {
          for (const size of config.sizes[player][street].raise) {
            sizedAction(Math.max(facing + size * (potNow + facing), 2 * facing), "raise");
          }
          if (allIn) sizedAction(room, "raise");
        }
      }
      actions.sort((a, b) => a.put - b.put || (a.kind === "fold" ? -1 : 1));
      node.actions = actions;
      for (const action of actions) {
        const next = [invested[0], invested[1]];
        next[player] = action.total;
        let child;
        if (action.kind === "fold") {
          child = addNode({ kind: "fold", folder: player, invested: [invested[0], invested[1]] });
        } else if (action.kind === "check") {
          child = player === 0 && !checked ? decide(1, next, raises, true) : endStreet(next[0]);
        } else if (action.kind === "call") {
          child = endStreet(next[player]);
        } else {
          child = decide(1 - player, next, action.kind === "bet" || facing <= EPS ? raises : raises + 1, checked);
        }
        node.children.push(child);
      }
      return id;
    };
    const endStreet = (invested) => {
      const id = addNode({ kind: "end", invested, allIn: invested >= stack - EPS, next: -1 });
      pendingEnds.push(id);
      return id;
    };
    if (start >= stack - EPS) {
      endStreet(start);
    } else {
      decide(0, [start, start], 0, false);
    }
    for (const endId of pendingEnds) {
      const end = template.nodes[endId];
      if (street < 2 && !end.allIn) end.next = buildStreet(street + 1, end.invested, { template: template.id, node: endId });
    }
    return template.id;
  };
  buildStreet(rootStreet, 0, null);
  return { templates, rootStreet };
}

// ../../../private/tmp/pf-src6/src/lib/poker/hand-keys.ts
var RANK_KEYS = [0, 1, 5, 22, 98, 453, 2031, 8698, 22854, 83661, 262349, 636345, 1479181];
var HASH_SHIFT = 11;

// ../../../private/tmp/pf-src6/src/lib/poker/hand-hash-offsets.generated.ts
var HASH_TABLE_SIZE = 134098;
var HASH_OFFSETS = new Int32Array([0, 2048, 26994, 90430, 3613, 17699, 70753, 122268, 30641, 62881, 116295, 5294, 12198, 43178, 98771, 20330, 56656, 91870, 14824, 15402, 111061, 87186, 29611, 52290, 96674, 52939, 21870, 111538, 30209, 4250, 9205, 56242, 20608, 86630, 116681, 69218, 8370, 50494, 6350, 8376, 45985, 10415, 41434, 54568, 99082, 15785, 65715, 121629, 5719, 66030, 114599, 106469, 24840, 48341, 100466, 1465, 71901, 109482, 57616, 4971, 124613, 96033, 22451, 78241, 107530, 53513, 10187, 125088, 35173, 347, 4, 60734, 12202, 1, 125473, 83853, 6842, 43, 61276, 12389, 12, 40786, 51205, 105400, 70164, 41088, 88344, 50372, 9937, 2774, 122571, 106901, 3491, 95035, 21634, 14196, 100, 126145, 76071, 12387, 125, 107251, 22766, 10, 126573, 76712, 5558, 0, 107468, 12113, 174, 0, 22447, 1, 0, 107825, 13403, 15, 0, 22646, 0, 0, 93122, 112881, 80701, 22460, 31353, 45427, 6993, 22084, 72917, 48768, 23098, 49160, 99389, 49419, 92148, 101596, 10353, 25438, 53373, 97588, 45563, 72806, 95163, 13867, 6972, 60766, 64008, 6443, 85218, 119073, 70656, 939, 58690, 87573, 14026, 43, 2024, 10279, 2, 73918, 88534, 113351, 68367, 15, 10795, 28672, 4897, 34641, 91036, 6158, 776, 68556, 103423, 23722, 2549, 120116, 24941, 5742, 74281, 106214, 63267, 3776, 126150, 33727, 552, 28, 63180, 7521, 9, 126463, 88452, 7027, 214, 107223, 7956, 44, 0, 21988, 14, 0, 107596, 22728, 7, 0, 22216, 3, 0, 9601, 98310, 75373, 13581, 9754, 123157, 108936, 23553, 17, 108850, 23060, 2500, 42387, 2343, 31, 0, 109630, 13458, 2, 0, 22768, 8, 0, 110034, 13652, 157, 0, 22957, 9, 0, 0, 0, 0, 0, 23183, 173, 0, 0, 3, 0, 0, 75736, 89828, 12621, 0, 6674, 20780, 28803, 71447, 123180, 14406, 74318, 107776, 33315, 1675, 61109, 70772, 3354, 85936, 109145, 14281, 4450, 82968, 42492, 4719, 12, 7064, 20930, 96, 33528, 83332, 10996, 76, 8454, 7446, 14, 0, 0, 23728, 1, 72240, 12652, 22387, 22776, 892, 51, 22363, 5, 79080, 123672, 97084, 4336, 120668, 65166, 9098, 184, 96230, 10518, 1, 126760, 90309, 16097, 13932, 46669, 100383, 37549, 36665, 85496, 23874, 13806, 61151, 115123, 9880, 44688, 55553, 91086, 15299, 75643, 104849, 70882, 14048, 116999, 86208, 23199, 76420, 106882, 74703, 14391, 57143, 89674, 5799, 75, 97054, 31211, 11804, 123678, 78339, 8956, 19, 109629, 72125, 224, 36480, 54360, 102959, 49672, 45533, 94898, 73735, 21201, 3499, 49014, 98301, 32531, 101843, 65974, 11264, 4409, 40993, 6222, 155, 0, 98109, 23534, 22612, 50221, 15622, 190, 0, 42101, 3337, 40, 0, 2606, 75, 83369, 104235, 57557, 4336, 130591, 26911, 3793, 10, 67287, 64107, 38839, 58986, 23734, 33068, 1588, 41440, 6842, 602, 118, 37, 47558, 12119, 32573, 6965, 3118, 304, 1037, 202, 23884, 244, 25961, 3496, 28, 22441, 385, 353, 5, 0, 36, 60, 0, 119785, 70426, 23791, 31, 109860, 7434, 3, 0, 117322, 98683, 23564, 98649, 15537, 83326, 45112, 95178, 64459, 15249, 77183, 105260, 72517, 8411, 115313, 38697, 1168, 89567, 113934, 1196, 35, 127076, 11935, 5945, 20, 98861, 12622, 11, 127458, 79172, 14203, 150, 109935, 60554, 35, 0, 22830, 11815, 255, 111303, 13898, 77836, 23999, 12571, 13893, 2920, 61773, 109974, 72269, 8583, 19551, 58763, 1171, 40, 3, 99674, 14214, 6210, 81883, 16069, 329, 0, 111893, 9959, 264, 0, 23576, 110, 2910, 1031, 115, 0, 0, 4932, 165, 0, 0, 0, 178, 129524, 58633, 13841, 3, 80080, 7894, 59, 0, 11699, 20634, 23278, 42695, 20947, 357, 0, 2132, 94, 24365, 2, 87730, 8620, 2, 22922, 533, 128, 0, 3, 0, 37, 0, 2166, 313, 0, 0, 0, 141, 0, 0, 0, 0, 0, 100867, 23993, 281, 0, 23561, 15, 0, 0, 100788, 23996, 46, 23940, 8402, 10080, 94651, 54311, 15698, 204, 127511, 77278, 14365, 104, 100754, 14012, 4, 127986, 80203, 14975, 285, 111437, 9465, 138, 0, 23659, 1, 0, 111699, 14733, 7, 0, 23938, 14672, 240, 0, 0, 73, 0, 24165, 23, 24570, 13, 0, 255, 10, 25181, 14675, 8015, 4, 1, 112593, 8907, 0, 0, 24498, 299, 8325, 17607, 114, 39985, 63314, 113958, 94798, 17556, 110137, 73479, 13482, 2013, 28195, 1640, 19124, 112190, 95884, 13301, 18171, 82933, 16158, 315, 0, 101828, 24894, 16886, 64511, 4439, 26, 396, 36630, 269, 6, 0, 6930, 143, 8374, 17992, 153, 590, 0, 6418, 24, 0, 81634, 121416, 101694, 24561, 119232, 59582, 24077, 0, 24687, 5531, 9, 129609, 101646, 17863, 52, 92009, 13633, 39, 0, 2044, 121, 0, 93592, 13927, 33, 0, 4648, 6115, 5, 0, 0, 141, 0, 118203, 64898, 175, 0, 112290, 10550, 312, 0, 118116, 102765, 24892, 95362, 16207, 14489, 77, 24274, 14041, 2, 0, 102901, 14632, 258, 24460, 14370, 0, 0, 7, 8507, 19145, 69879, 115746, 31707, 59315, 115635, 86293, 96031, 101072, 65839, 37842, 61999, 69184, 50557, 13201, 111523, 35672, 3039, 6989, 72959, 788, 84189, 109334, 68438, 12866, 2081, 58199, 101227, 64123, 14184, 70471, 702, 44347, 18450, 16395, 75688, 1012, 35423, 45534, 16844, 27945, 60743, 51589, 37191, 66833, 115309, 43488, 14597, 55421, 25577, 558, 79220, 110483, 85768, 3864, 129684, 91299, 9677, 89, 29568, 3068, 0, 123405, 101725, 8032, 2, 11436, 118113, 78245, 24405, 951, 22870, 9633, 19076, 14631, 104, 246, 4705, 81961, 24112, 13779, 91304, 25336, 477, 8381, 123970, 112699, 15187, 4, 79087, 14884, 1, 128145, 70761, 9827, 638, 112867, 15348, 116, 0, 54845, 15799, 625, 113393, 4853, 3, 0, 24134, 95415, 24789, 391, 15611, 15141, 0, 24365, 5, 1, 0, 0, 24462, 51, 28164, 54410, 18208, 423, 25, 114575, 39087, 64509, 120098, 4300, 92787, 102735, 30058, 2614, 19112, 85078, 6226, 87795, 113900, 53970, 690, 65459, 34664, 13268, 133, 0, 114735, 11075, 8335, 74218, 19635, 2, 5077, 55127, 48835, 15112, 2, 7641, 19137, 3483, 21297, 30591, 6380, 69, 9189, 5654, 79, 82383, 121620, 67414, 1512, 119707, 79922, 3530, 2, 38564, 5324, 86, 130245, 80688, 6163, 137, 95929, 9890, 29, 0, 4684, 14, 2, 113893, 24226, 94, 0, 23788, 102670, 24424, 8, 0, 14888, 0, 24001, 1, 21, 0, 7, 24124, 0, 0, 50802, 104856, 82481, 4742, 60466, 51543, 15933, 82, 85250, 9980, 0, 107050, 22364, 4752, 264, 87074, 15686, 160, 0, 142, 405, 0, 88606, 15891, 347, 0, 15837, 15736, 178, 0, 10, 0, 0, 16069, 1, 0, 0, 0, 18, 0, 4110, 108819, 208, 125, 0, 89893, 77054, 118151, 102613, 1356, 90627, 76897, 12883, 6611, 1667, 984, 8814, 101904, 91338, 20218, 22, 12366, 21312, 728, 215, 0, 25238, 46, 16884, 5593, 1, 0, 0, 17852, 3959, 3, 0, 451, 131, 4863, 130, 1575, 10483, 328, 1455, 307, 17259, 124054, 115642, 15966, 14, 102903, 15506, 8504, 0, 5306, 138, 326, 115378, 24533, 851, 33394, 89052, 38481, 5696, 80002, 121775, 116398, 25176, 118324, 94514, 24660, 80763, 105635, 36157, 10955, 127734, 91964, 2232, 121, 27129, 15665, 15640, 124331, 91959, 7827, 6, 115878, 100550, 26176, 16987, 1844, 407, 10456, 103199, 24690, 1882, 1, 24187, 54027, 11119, 20235, 97783, 29367, 18775, 9937, 125079, 104213, 25524, 341, 60736, 17377, 4480, 19105, 4358, 71, 0, 116778, 17343, 419, 0, 17173, 7, 1, 117168, 17580, 601, 0, 24840, 45979, 25460, 693, 1, 17213, 39002, 30778, 16359, 22, 13297, 19305, 9330, 351, 107039, 36525, 3747, 55543, 8302, 9552, 270, 29, 167, 17813, 535, 13346, 16845, 315, 5160, 385, 25515, 716, 0, 2100, 168, 0, 136, 60, 700, 0, 27, 718, 251, 0, 56, 0, 466, 116764, 17598, 64, 0, 24369, 3, 648, 0, 104257, 24700, 0, 24596, 16504, 8, 81481, 125219, 117909, 18344, 124862, 83411, 17561, 263, 51002, 9995, 3, 128223, 92614, 9351, 444, 117649, 17491, 322, 0, 24322, 3, 0, 118164, 17774, 104, 0, 24607, 73202, 17991, 201, 0, 17557, 0, 24820, 2, 17856, 136, 2, 17768, 0, 12501, 75929, 9105, 348, 3, 118854, 18435, 570, 0, 17992, 49, 0, 119064, 18766, 753, 0, 25408, 231, 0, 0, 1, 0, 0, 25613, 413, 0, 0, 0, 18576, 506, 0, 0, 17, 98342, 10102, 4, 0, 5314, 358, 165, 0, 30669, 46746, 19398, 47, 554, 90324, 18850, 706, 768, 18651, 187, 5463, 53561, 19129, 131, 0, 19063, 369, 0, 0, 1, 0, 0, 19359, 550, 0, 0, 29, 809, 0, 0, 0, 0, 25086, 2, 0, 0, 0, 0, 0, 0, 17334, 10572, 1, 14, 1, 177, 128546, 119238, 25841, 89, 118764, 6950, 168, 0, 24821, 0, 665, 119477, 19027, 302, 0, 25011, 3, 886, 0, 1, 0, 0, 25221, 0, 0, 0, 0, 19007, 67, 0, 0, 1, 0, 0, 0, 18810, 0, 0, 7, 3, 0, 120352, 26220, 955, 0, 25699, 75, 0, 0, 0, 0, 0, 25906, 613, 51821, 107909, 81858, 17774, 1639, 6266, 19169, 347, 0, 105268, 25951, 15391, 85117, 17706, 81, 0, 120491, 19873, 812, 0, 25617, 295, 133, 41636, 42, 0, 0, 1118, 4951, 191, 0, 2, 19568, 570, 26017, 661, 50, 0, 141, 19951, 755, 57215, 94856, 18941, 3, 7680, 19471, 0, 0, 0, 20160, 941, 99362, 18744, 50, 0, 5520, 298, 0, 0, 0, 599, 0, 5734, 485, 0, 0, 0, 1537, 578, 0, 0, 0, 870, 121087, 19623, 468, 0, 25316, 17, 0, 0, 105264, 25610, 234, 25573, 19371, 0, 0, 0, 1, 0, 0, 25355, 19, 0, 43, 0, 0, 0, 0, 34539, 57672, 116019, 95048, 1684, 68260, 66862, 10298, 2, 121396, 153, 6954, 111813, 93088, 13124, 24936, 77545, 824, 34, 0, 122094, 26159, 3118, 72485, 19227, 11, 4, 66253, 62125, 11282, 8, 25828, 105954, 1124, 1112, 115, 25936, 438, 18801, 8135, 85, 87091, 119061, 56436, 19524, 29699, 85223, 11237, 73, 11537, 192, 177, 130679, 95950, 14624, 210, 19976, 7079, 0, 368, 0, 20231, 985, 57105, 19328, 104, 586, 5742, 10084, 19464, 2, 0, 3332, 430, 6058, 554, 0, 776, 0, 3575, 653, 0, 128769, 122395, 20078, 69, 122447, 25706, 151, 0, 19345, 0, 0, 124291, 19928, 0, 0, 25414, 25, 0, 0, 20333, 315, 0, 25866, 1, 0, 0, 1, 26022, 81, 0, 2, 0, 0, 0, 0, 0, 0, 0, 3, 0, 0, 126084, 26917, 970, 0, 26465, 42518, 112450, 92472, 11278, 39354, 69670, 6637, 230, 0, 127003, 21050, 11763, 9179, 8245, 60, 0, 131913, 12005, 1, 0, 26587, 539, 5122, 19405, 130, 0, 0, 11278, 19969, 485, 0, 198, 26867, 826, 26963, 1574, 16, 0, 394, 27077, 339, 130172, 105230, 20393, 189, 56348, 19878, 201, 0, 614, 149, 0, 107684, 20113, 290, 762, 6281, 506, 0, 0, 0, 862, 0, 15, 687, 0, 0, 0, 19923, 0, 0, 0, 3, 0, 0, 0, 0, 0, 0, 2, 0, 0, 108860, 76107, 20714, 349, 44910, 11246, 0, 0, 2800, 463, 0, 54305, 11896, 418, 0, 3630, 653, 0, 0, 0, 1024, 0, 20040, 16, 0, 0, 3, 75, 0, 0, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 90193, 21079, 656, 0, 20566, 43039, 85654, 20534, 11, 4, 5914, 9445, 316, 0, 26792, 255, 14907, 21535, 258, 0, 0, 26983, 128, 0, 0, 393, 0, 0, 27204, 1103, 0, 0, 536, 165, 0, 0, 0, 679, 0, 770, 0, 21738, 969, 0, 863, 450, 114099, 20967, 53, 0, 6517, 657, 637, 0, 0, 1059, 0, 25817, 14, 0, 82920, 122140, 131581, 26886, 128451, 105261, 26371, 258, 59197, 20753, 0, 130571, 93861, 3648, 441, 123242, 20944, 274, 0, 6413, 514, 6, 130973, 26268, 467, 0, 6633, 59244, 21152, 190, 0, 11535, 6, 25932, 8, 48, 0, 8, 20990, 0, 0, 129407, 106123, 27253, 428, 131475, 26741, 555, 0, 21256, 128, 0, 131729, 21961, 832, 0, 26501, 310, 0, 0, 0, 0, 0, 26707, 491, 0, 0, 1, 21872, 584, 0, 0, 62, 15615, 20756, 678, 0, 0, 27452, 253, 0, 9599, 11040, 444, 649, 219, 27240, 949, 0, 843, 428, 0, 0, 27495, 1133, 0, 1033, 619, 0, 0, 0, 1126, 0, 0, 802, 0, 0, 0, 0, 893, 0, 0, 0, 0, 26319, 1, 0, 0, 0, 0, 0, 0, 26172, 2, 0, 0, 0, 1257, 129049, 131595, 27155, 689, 126419, 11871, 172, 0, 6601, 646, 0, 131359, 26826, 594, 0, 26322, 1, 0, 0, 12, 0, 0, 26575, 14, 0, 0, 0, 21411, 111, 0, 0, 1, 0, 0, 0, 42, 0, 0, 10, 0, 0, 132011, 27553, 1e3, 0, 27054, 486, 0, 0, 13, 0, 0, 27244, 669, 0, 0, 147, 0, 0, 0, 0, 0, 0, 328, 0, 0, 0, 0, 421, 0, 0, 0, 0, 6502, 463, 0, 0, 0, 1021, 0, 0, 0, 91651, 22424, 1146, 1206, 21942, 663, 0, 0, 144, 0, 0, 22196, 848, 0, 0, 326, 0, 0, 0, 0, 0, 0, 507, 0, 0, 0, 0, 0, 0, 0, 0, 0, 11, 0, 0, 0, 0, 0, 0, 0, 762, 241, 0, 0, 0, 961, 131536, 27089, 559, 0, 26593, 40, 1147, 0, 5, 0, 0, 26781, 230, 0, 0, 3, 0, 0, 0, 0, 0, 0, 4, 0, 0, 0, 0, 4, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 27432, 884, 0, 0, 362, 0, 0, 0, 0, 0, 0, 550, 0, 1796, 49449, 20622, 436, 0, 132092, 27640, 1092, 0, 27143, 570, 0, 132420, 22607, 1279, 0, 27333, 779, 0, 0, 260, 0, 0, 27529, 964, 0, 0, 452, 22397, 1066, 0, 0, 544, 0, 641, 0, 0, 0, 0, 733, 0, 17646, 21699, 727, 0, 0, 28021, 1441, 0, 0, 922, 0, 4, 276, 0, 0, 0, 1103, 0, 0, 0, 0, 0, 0, 1296, 0, 0, 0, 0, 1388, 0, 0, 0, 0, 27041, 477, 0, 0, 1, 0, 0, 0, 26880, 274, 0, 172, 4, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 26064, 98211, 55687, 11666, 79, 129908, 106641, 231, 0, 132122, 27731, 14407, 79302, 9706, 112, 0, 132337, 22511, 1262, 0, 27443, 743, 581, 132591, 22715, 1448, 0, 27694, 106638, 28370, 1542, 407, 27854, 1022, 27976, 1114, 506, 0, 597, 28073, 1211, 113305, 93863, 11986, 393, 11912, 21795, 593, 0, 0, 22660, 1399, 11079, 3140, 13, 967, 0, 28475, 1584, 0, 0, 1064, 0, 6524, 431, 0, 0, 0, 3566, 529, 0, 0, 0, 1335, 0, 1426, 0, 0, 0, 0, 1518, 0, 131857, 27592, 700, 0, 27102, 178, 0, 0, 14, 0, 0, 27293, 364, 0, 0, 1, 0, 0, 0, 351, 0, 0, 28, 0, 0, 0, 0, 119, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 27953, 1009, 0, 0, 487, 22809, 80596, 21818, 614, 0, 132636, 22689, 1444, 0, 27910, 922, 0, 132866, 22862, 1627, 0, 28108, 1105, 0, 0, 585, 0, 0, 28296, 1293, 0, 0, 774, 28394, 1389, 0, 0, 870, 0, 961, 0, 1327, 0, 0, 1058, 0, 126229, 21657, 240, 0, 726, 250, 0, 0, 0, 1246, 0, 6725, 562, 0, 0, 0, 1428, 0, 0, 0, 0, 0, 0, 1609, 0, 0, 0, 70, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 68126, 12024, 373, 0, 3659, 513, 0, 0, 0, 1379, 0, 4225, 696, 0, 0, 0, 1560, 0, 0, 0, 0, 0, 109, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 22148, 672, 0, 0, 150, 423, 221, 265, 0, 0, 28248, 244, 0, 0, 750, 0, 0, 28463, 1462, 0, 0, 946, 0, 0, 0, 0, 0, 0, 1127, 0, 0, 0, 0, 1221, 0, 0, 0, 0, 0, 0, 0, 987, 0, 0, 0, 0, 7065, 695, 0, 0, 0, 1592, 0, 0, 0, 0, 0, 107, 0, 0, 130518, 106029, 27841, 789, 35606, 11899, 268, 0, 925, 239, 0, 127783, 22009, 297, 0, 7018, 551, 0, 0, 0, 1454, 0, 7734, 735, 0, 0, 0, 11946, 200, 0, 0, 0, 1726, 157, 0, 0, 0, 0, 0, 0, 0, 132284, 28133, 1092, 0, 27634, 570, 0, 0, 52, 0, 0, 27826, 758, 0, 0, 236, 0, 0, 0, 0, 0, 0, 420, 0, 0, 0, 0, 515, 0, 0, 0, 0, 0, 28702, 1639, 0, 0, 1124, 0, 0, 0, 28474, 1413, 0, 1307, 893, 0, 0, 0, 0, 0, 0, 1074, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 5, 0, 0, 0, 0, 0, 0, 0, 0, 1711, 0, 0, 0, 0, 132001, 22167, 622, 0, 7986, 678, 0, 0, 0, 1627, 0, 27353, 285, 0, 0, 114, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 38, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 28054, 926, 0, 0, 412, 0, 0, 0, 0, 0, 0, 593, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1473, 0, 0, 0, 0, 0, 0, 0, 22526, 1080, 0, 0, 559, 0, 0, 0, 0, 0, 0, 741, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1382, 0, 0, 0, 0, 27551, 457, 0, 0, 9, 0, 0, 0, 0, 0, 0, 117, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 751, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 132610, 28612, 1472, 0, 28146, 950, 0, 0, 433, 0, 0, 28328, 1141, 0, 0, 619, 0, 0, 0, 0, 0, 0, 801, 0, 0, 0, 0, 902, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 28987, 1789, 0, 0, 1268, 0, 0, 0, 0, 0, 0, 1451, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 275, 0, 0, 0, 0, 0, 0, 0, 52, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 130072, 133019, 29081, 0, 132527, 28574, 1375, 0, 28065, 858, 0, 132763, 22877, 1575, 0, 28414, 1054, 0, 0, 535, 0, 0, 28645, 1242, 0, 0, 729, 28765, 1344, 0, 0, 822, 0, 913, 0, 0, 0, 0, 1207, 0, 18721, 21903, 607, 0, 0, 29152, 1934, 0, 0, 1434, 0, 0, 29374, 2148, 0, 0, 1626, 0, 0, 0, 0, 0, 0, 1828, 0, 0, 0, 0, 1939, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 27983, 784, 0, 0, 273, 0, 0, 0, 0, 0, 0, 454, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1095, 0, 0, 0, 0, 0, 132934, 29238, 2066, 0, 28717, 1550, 0, 0, 1035, 0, 0, 28906, 1740, 0, 0, 1221, 0, 0, 0, 0, 0, 0, 1405, 0, 0, 0, 0, 1502, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1057, 263, 0, 0, 0, 1903, 0, 0, 0, 0, 0, 0, 2091, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 4352, 514, 0, 0, 0, 2047, 0, 0, 0, 0, 0, 0, 2228, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 820, 0, 0, 0, 0, 0, 29036, 1944, 0, 0, 1424, 0, 0, 0, 0, 0, 0, 1605, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2241, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 36901, 11976, 914, 0, 1075, 251, 0, 0, 0, 1919, 0, 7985, 546, 0, 0, 0, 2100, 0, 0, 0, 0, 0, 0, 2281, 0, 0, 0, 0, 2372, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 28375, 1211, 0, 0, 690, 0, 0, 0, 0, 0, 0, 875, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1745, 0, 0, 0, 0, 0, 0, 0, 1512, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 8157, 673, 0, 0, 0, 2239, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1005, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1136, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 505, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 28660, 1517, 0, 0, 1e3, 0, 0, 0, 0, 0, 0, 1184, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1820, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1312, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2105]);

// ../../../private/tmp/pf-src6/src/lib/poker/hand-evaluator.ts
var CLASSES_PER_CATEGORY = [1277, 2860, 858, 858, 10, 1277, 156, 156, 10];
var HAND_CLASS_COUNT = 7462;
var CATEGORY_START = [];
{
  let start = 1;
  for (const count of CLASSES_PER_CATEGORY) {
    CATEGORY_START.push(start);
    start += count;
  }
}
var CATEGORY_OF_VALUE = new Uint8Array(HAND_CLASS_COUNT + 1);
for (let category = 0; category < 9; category += 1) {
  CATEGORY_OF_VALUE.fill(category, CATEGORY_START[category], CATEGORY_START[category] + CLASSES_PER_CATEGORY[category]);
}
var STRAIGHT_TOP = new Int8Array(8192);
for (let mask = 0; mask < 8192; mask += 1) {
  let top = -1;
  for (let high = 12; high >= 4; high -= 1) {
    const run = 31 << high - 4;
    if ((mask & run) === run) {
      top = high;
      break;
    }
  }
  if (top < 0 && (mask & 4111) === 4111) top = 3;
  STRAIGHT_TOP[mask] = top;
}
function topBits(mask, count) {
  const ranks = [];
  for (let rank = 12; rank >= 0 && ranks.length < count; rank -= 1) if (mask & 1 << rank) ranks.push(rank);
  return ranks;
}
function pack(category, kickers) {
  let score = category;
  for (let i = 0; i < 5; i += 1) score = score * 16 + (kickers[i] ?? 0);
  return score;
}
function flushScore(mask) {
  const straight = STRAIGHT_TOP[mask];
  return straight >= 0 ? pack(8, [straight]) : pack(5, topBits(mask, 5));
}
function countsScore(counts) {
  let present = 0;
  let quad = -1;
  const trips = [];
  const pairs2 = [];
  for (let rank = 12; rank >= 0; rank -= 1) {
    const n = counts[rank];
    if (n > 0) present |= 1 << rank;
    if (n >= 4 && quad < 0) quad = rank;
    else if (n === 3) trips.push(rank);
    else if (n === 2) pairs2.push(rank);
    else if (n >= 4) trips.push(rank);
  }
  if (quad >= 0) return pack(7, [quad, topBits(present & ~(1 << quad), 1)[0] ?? 0]);
  if (trips.length > 0) {
    const pairCandidates = [...trips.slice(1), ...pairs2].sort((a, b) => b - a);
    if (pairCandidates.length > 0) return pack(6, [trips[0], pairCandidates[0]]);
  }
  const straight = STRAIGHT_TOP[present];
  if (straight >= 0) return pack(4, [straight]);
  if (trips.length > 0) return pack(3, [trips[0], ...topBits(present & ~(1 << trips[0]), 2)]);
  if (pairs2.length >= 2) return pack(2, [pairs2[0], pairs2[1], topBits(present & ~(1 << pairs2[0]) & ~(1 << pairs2[1]), 1)[0] ?? 0]);
  if (pairs2.length === 1) return pack(1, [pairs2[0], ...topBits(present & ~(1 << pairs2[0]), 3)]);
  return pack(0, topBits(present, 5));
}
var scoreToValue = null;
function forEachCountPattern(total, visit) {
  const counts = new Uint8Array(13);
  const walk = (rank, left) => {
    if (rank === 12) {
      if (left <= 4) {
        counts[12] = left;
        visit(counts);
        counts[12] = 0;
      }
      return;
    }
    for (let n = 0; n <= Math.min(4, left); n += 1) {
      counts[rank] = n;
      walk(rank + 1, left - n);
    }
    counts[rank] = 0;
  };
  walk(0, total);
}
function popcount(mask) {
  let n = 0;
  for (let m = mask; m; m &= m - 1) n += 1;
  return n;
}
function valueOfScore(score) {
  if (!scoreToValue) {
    const scores = /* @__PURE__ */ new Set();
    for (let mask = 0; mask < 8192; mask += 1) if (popcount(mask) === 5) scores.add(flushScore(mask));
    forEachCountPattern(5, (counts) => scores.add(countsScore(counts)));
    const sorted = [...scores].sort((a, b) => a - b);
    scoreToValue = new Map(sorted.map((s, index) => [s, index + 1]));
  }
  const value = scoreToValue.get(score);
  if (value === void 0) throw new Error("Unknown hand score");
  return value;
}
var WAYS = Array.from({ length: 14 }, () => new Array(8).fill(0));
WAYS[0][0] = 1;
for (let n = 1; n <= 13; n += 1) for (let k = 0; k <= 7; k += 1) for (let q = 0; q <= Math.min(4, k); q += 1) WAYS[n][k] += WAYS[n - 1][k - q];
var OFFSET = new Int32Array(13 * 8 * 5);
for (let i = 0; i < 13; i += 1) {
  for (let left = 0; left <= 7; left += 1) {
    let acc = 0;
    for (let q = 0; q <= 4; q += 1) {
      OFFSET[(i * 8 + left) * 5 + q] = acc;
      if (q <= left) acc += WAYS[12 - i][left - q];
    }
  }
}
var SEVEN_CARD_PATTERNS = WAYS[13][7];
var FLUSH_TABLE = null;
var KEYED7 = null;
var CARD_RANK_KEY = new Int32Array(52);
var CARD_SUIT_KEY = new Int32Array(52);
for (let card = 0; card < 52; card += 1) {
  CARD_RANK_KEY[card] = RANK_KEYS[card >> 2];
  CARD_SUIT_KEY[card] = 1 << 4 * (card & 3);
}
var SUIT_SUM_START = 13107;
var SUIT_FLUSH_BITS = 34952;
var HASH_MASK = (1 << HASH_SHIFT) - 1;
function buildFlushTable() {
  if (FLUSH_TABLE) return FLUSH_TABLE;
  const flush = new Uint16Array(8192);
  for (let mask = 0; mask < 8192; mask += 1) if (popcount(mask) >= 5) flush[mask] = valueOfScore(flushScore(mask));
  FLUSH_TABLE = flush;
  return flush;
}
function buildEvaluatorTables() {
  if (KEYED7) return;
  buildFlushTable();
  const keyed = new Uint16Array(HASH_TABLE_SIZE);
  forEachCountPattern(7, (counts) => {
    let key = 0;
    for (let r = 0; r < 13; r += 1) key += counts[r] * RANK_KEYS[r];
    keyed[HASH_OFFSETS[key >>> HASH_SHIFT] + (key & HASH_MASK)] = valueOfScore(countsScore(counts));
  });
  KEYED7 = keyed;
}
function flushValue(suitSum, a, b, c, d, e, f, g) {
  const suit = suitSum & 8 ? 0 : suitSum & 128 ? 1 : suitSum & 2048 ? 2 : 3;
  let mask = 0;
  if ((a & 3) === suit) mask |= 1 << (a >> 2);
  if ((b & 3) === suit) mask |= 1 << (b >> 2);
  if ((c & 3) === suit) mask |= 1 << (c >> 2);
  if ((d & 3) === suit) mask |= 1 << (d >> 2);
  if ((e & 3) === suit) mask |= 1 << (e >> 2);
  if ((f & 3) === suit) mask |= 1 << (f >> 2);
  if ((g & 3) === suit) mask |= 1 << (g >> 2);
  return FLUSH_TABLE[mask];
}
function evaluate7(a, b, c, d, e, f, g) {
  if (!KEYED7) buildEvaluatorTables();
  const suitSum = SUIT_SUM_START + CARD_SUIT_KEY[a] + CARD_SUIT_KEY[b] + CARD_SUIT_KEY[c] + CARD_SUIT_KEY[d] + CARD_SUIT_KEY[e] + CARD_SUIT_KEY[f] + CARD_SUIT_KEY[g];
  if (suitSum & SUIT_FLUSH_BITS) return flushValue(suitSum, a, b, c, d, e, f, g);
  const key = CARD_RANK_KEY[a] + CARD_RANK_KEY[b] + CARD_RANK_KEY[c] + CARD_RANK_KEY[d] + CARD_RANK_KEY[e] + CARD_RANK_KEY[f] + CARD_RANK_KEY[g];
  return KEYED7[HASH_OFFSETS[key >>> HASH_SHIFT] + (key & HASH_MASK)];
}
var COUNTS = new Uint8Array(13);
var SUIT_MASKS = new Int32Array(4);
function evaluateHand(cards) {
  if (cards.length === 7) return evaluate7(cards[0], cards[1], cards[2], cards[3], cards[4], cards[5], cards[6]);
  return evaluateBitmask(cards);
}
function evaluateBitmask(cards) {
  const counts = new Uint8Array(13);
  const suits = [0, 0, 0, 0];
  const suitCounts = [0, 0, 0, 0];
  for (let i = 0; i < cards.length; i += 1) {
    const card = cards[i];
    counts[card >> 2] += 1;
    suits[card & 3] |= 1 << (card >> 2);
    suitCounts[card & 3] += 1;
  }
  let best = countsScore(counts);
  for (let s = 0; s < 4; s += 1) if (suitCounts[s] >= 5) best = Math.max(best, flushScore(suits[s]));
  return valueOfScore(best);
}
var FIVE_OF_SEVEN = [];
for (let skipA = 0; skipA < 7; skipA += 1) for (let skipB = skipA + 1; skipB < 7; skipB += 1) {
  FIVE_OF_SEVEN.push([0, 1, 2, 3, 4, 5, 6].filter((i) => i !== skipA && i !== skipB));
}
var TOTAL_HANDS = { 5: choose(52, 5), 7: choose(52, 7) };

// ../../../private/tmp/pf-src6/src/lib/poker-postflop/config.ts
function streetOfBoard(board) {
  if (board.length === 3) return 0;
  if (board.length === 4) return 1;
  if (board.length === 5) return 2;
  throw new Error("The board needs three, four or five cards.");
}

// ../../../private/tmp/pf-src6/src/lib/poker-postflop/game.ts
var IDENTITY = [0, 1, 2, 3];
function allPerms() {
  const out2 = [];
  const rec = (prefix) => {
    if (prefix.length === 4) {
      out2.push(prefix);
      return;
    }
    for (let s = 0; s < 4; s += 1) if (!prefix.includes(s)) rec([...prefix, s]);
  };
  rec([]);
  out2.sort((a, b) => Number(b.every((s, i) => s === IDENTITY[i])) - Number(a.every((s, i) => s === IDENTITY[i])));
  return out2;
}
var PERMS = allPerms();
var mapCard2 = (card, perm) => card & ~3 | perm[card & 3];
function fixesSet(perm, cards) {
  const set = new Set(cards);
  return cards.every((card) => set.has(mapCard2(card, perm)));
}
function buildHands(weights, dead, combos) {
  const cards = [];
  const weight = [];
  const classIndex = [];
  for (let index = 0; index < HAND_COUNT; index += 1) {
    const w = weights[index];
    if (!combos && !(w > 0)) continue;
    for (const [a, b] of classCombos(index)) {
      if (dead.has(a) || dead.has(b)) continue;
      const cw = combos ? combos[Math.max(a, b) * 52 + Math.min(a, b)] : w;
      if (!(cw > 0)) continue;
      cards.push(Math.max(a, b), Math.min(a, b));
      weight.push(Math.min(1, cw));
      classIndex.push(index);
    }
  }
  const count = weight.length;
  return {
    count,
    cards: Uint8Array.from(cards),
    weight: Float64Array.from(weight),
    classIndex: Uint8Array.from(classIndex),
    sameIndex: new Int32Array(count).fill(-1)
  };
}
function comboKey(a, b) {
  return a > b ? a * 52 + b : b * 52 + a;
}
function dealSet(board, symmetric, allowed) {
  const used = new Set(board);
  const canon = [];
  const canonIndex = new Int16Array(52).fill(-1);
  const permOf = new Int16Array(52).fill(-1);
  const cards = [];
  for (let card = 0; card < 52; card += 1) {
    if (used.has(card)) continue;
    cards.push(card);
    let best = card;
    let bestPerm = 0;
    for (const g of symmetric) {
      if (!allowed.includes(g)) continue;
      const perm = PERMS[g];
      const inverse = [0, 0, 0, 0];
      for (let s = 0; s < 4; s += 1) inverse[perm[s]] = s;
      const r = mapCard2(card, inverse);
      if (r < best) {
        best = r;
        bestPerm = g;
      }
    }
    if (best === card) {
      canonIndex[card] = canon.length;
      permOf[card] = 0;
      canon.push(card);
    } else {
      canonIndex[card] = canonIndex[best];
      permOf[card] = bestPerm;
    }
  }
  return { canon, canonIndex, permOf, cards };
}
function restrictDeals(full, positions) {
  const canon = positions.map((i) => full.canon[i]);
  const canonIndex = new Int16Array(52).fill(-1);
  const permOf = new Int16Array(52).fill(-1);
  for (const card of full.cards) {
    const local = positions.indexOf(full.canonIndex[card]);
    if (local < 0) continue;
    canonIndex[card] = local;
    permOf[card] = full.permOf[card];
  }
  return { canon, canonIndex, permOf, cards: full.cards };
}
function computeBoard(hands, board) {
  const strength = [new Uint16Array(hands[0].count), new Uint16Array(hands[1].count)];
  const order = [new Uint16Array(0), new Uint16Array(0)];
  const [b0, b1, b2, b3, b4] = board;
  const boardBits = new Uint8Array(52);
  for (const card of board) boardBits[card] = 1;
  for (let p = 0; p < 2; p += 1) {
    const { cards, count } = hands[p];
    const keys = new Uint32Array(count);
    let valid = 0;
    for (let h = 0; h < count; h += 1) {
      const a = cards[2 * h];
      const b = cards[2 * h + 1];
      if (boardBits[a] || boardBits[b]) continue;
      const value = evaluate7(a, b, b0, b1, b2, b3, b4);
      strength[p][h] = value;
      keys[valid] = value << 16 | h;
      valid += 1;
    }
    const sorted = keys.subarray(0, valid).sort();
    const list = new Uint16Array(valid);
    for (let i = 0; i < valid; i += 1) list[i] = sorted[i] & 65535;
    order[p] = list;
  }
  return { strength, order };
}
function buildGame(config, options = {}) {
  const board = [...config.board];
  if (new Set(board).size !== board.length) throw new Error("The board repeats a card.");
  const rootStreet = streetOfBoard(board);
  const dead = new Set(board);
  const hands = [buildHands(config.ranges[0], dead, config.combos?.[0]), buildHands(config.ranges[1], dead, config.combos?.[1])];
  if (!hands[0].count || !hands[1].count) throw new Error("Both ranges need at least one hand that the board does not block.");
  if (hands[0].count > 65535 || hands[1].count > 65535) throw new Error("Too many hands.");
  const keyIndex = [/* @__PURE__ */ new Map(), /* @__PURE__ */ new Map()];
  for (let p = 0; p < 2; p += 1) {
    for (let h = 0; h < hands[p].count; h += 1) keyIndex[p].set(comboKey(hands[p].cards[2 * h], hands[p].cards[2 * h + 1]), h);
  }
  for (let p = 0; p < 2; p += 1) {
    const other2 = keyIndex[1 - p];
    for (let h = 0; h < hands[p].count; h += 1) hands[p].sameIndex[h] = other2.get(comboKey(hands[p].cards[2 * h], hands[p].cards[2 * h + 1])) ?? -1;
  }
  const handPerm = [[], []];
  for (let p = 0; p < 2; p += 1) {
    for (const perm of PERMS) {
      const map = new Int32Array(hands[p].count);
      for (let h = 0; h < hands[p].count; h += 1) {
        const a = mapCard2(hands[p].cards[2 * h], perm);
        const b = mapCard2(hands[p].cards[2 * h + 1], perm);
        map[h] = keyIndex[p].get(comboKey(a, b)) ?? -1;
      }
      handPerm[p].push(map);
    }
  }
  const rangeSymmetric = PERMS.map((_, g) => [0, 1].every((p) => {
    const map = handPerm[p][g];
    for (let h = 0; h < hands[p].count; h += 1) if (map[h] < 0 || hands[p].weight[map[h]] !== hands[p].weight[h]) return false;
    return true;
  }));
  const useIso = options.isomorphism !== false;
  const symmetricFor = (cards) => PERMS.map((_, g) => g).filter((g) => g > 0 && useIso && rangeSymmetric[g] && fixesSet(PERMS[g], cards));
  const emptyDeals = { canon: [], canonIndex: new Int16Array(52).fill(-1), permOf: new Int16Array(52).fill(-1), cards: [] };
  const allIds = PERMS.map((_, g) => g);
  const fullDeals1 = rootStreet < 2 ? dealSet(board, symmetricFor(board), allIds) : emptyDeals;
  const deals1Positions = options.deals1Subset ?? fullDeals1.canon.map((_, i) => i);
  const deals1 = options.deals1Subset ? restrictDeals(fullDeals1, deals1Positions) : fullDeals1;
  const deals2 = [];
  const deals2Base = [];
  let deals2Count = 0;
  if (rootStreet === 0) {
    const flopSymmetric = symmetricFor(board);
    for (const turn of deals1.canon) {
      const withTurn = [...board, turn];
      const set = dealSet(withTurn, flopSymmetric.filter((g) => mapCard2(turn, PERMS[g]) === turn), allIds);
      deals2Base.push(deals2Count);
      deals2Count += set.canon.length;
      deals2.push(set);
    }
  }
  const boards = [];
  const boardIndex = new Int32Array(rootStreet === 0 ? 52 * 52 : 52).fill(-1);
  if (options.skipBoards) {
  } else if (rootStreet === 2) {
    boards.push(computeBoard(hands, board));
    boardIndex[0] = 0;
  } else if (rootStreet === 1) {
    for (const river of deals1.cards) {
      boardIndex[river] = boards.length;
      boards.push(computeBoard(hands, [...board, river]));
    }
  } else {
    const remaining = deals1.cards;
    for (let i = 0; i < remaining.length; i += 1) {
      for (let j = i + 1; j < remaining.length; j += 1) {
        const a = remaining[i];
        const b = remaining[j];
        boardIndex[a * 52 + b] = boards.length;
        boardIndex[b * 52 + a] = boards.length;
        boards.push(computeBoard(hands, [...board, a, b]));
      }
    }
  }
  const tree = buildBettingTree(config, rootStreet);
  const layout = { nodeOffset: [], templateSize: [], templateBase: [], instances: [], total: 0 };
  for (const template of tree.templates) {
    let size = 0;
    const offsets = template.nodes.map((node) => {
      if (node.kind !== "decision") return -1;
      const offset = size;
      size += node.actions.length * hands[node.player].count;
      return offset;
    });
    const instances = template.depth === 0 ? 1 : template.depth === 1 ? deals1.canon.length : deals2Count;
    layout.nodeOffset.push(offsets);
    layout.templateSize.push(size);
    layout.templateBase.push(layout.total);
    layout.instances.push(instances);
    layout.total += size * instances;
  }
  return { config, board, rootStreet, tree, hands, perms: PERMS, fullDeals1, deals1Positions, handPerm, deals1, deals2, deals2Base, deals2Count, boards, boardIndex, layout };
}

// ../../../private/tmp/pf-src6/src/lib/poker-postflop/query.ts
var PathError = class extends Error {
};
function compatibleSums(game, player, reach) {
  const mine = game.hands[player];
  const theirs = game.hands[1 - player];
  const cardSum = new Float64Array(52);
  let total = 0;
  for (let o = 0; o < theirs.count; o += 1) {
    const r = reach[o];
    if (!r) continue;
    total += r;
    cardSum[theirs.cards[2 * o]] += r;
    cardSum[theirs.cards[2 * o + 1]] += r;
  }
  const out2 = new Float64Array(mine.count);
  for (let h = 0; h < mine.count; h += 1) {
    const same = mine.sameIndex[h];
    out2[h] = total - cardSum[mine.cards[2 * h]] - cardSum[mine.cards[2 * h + 1]] + (same >= 0 ? reach[same] : 0);
  }
  return out2;
}
function rootState(game) {
  return {
    templateId: 0,
    nodeId: 0,
    depth: 0,
    instance: 0,
    t: -1,
    r: -1,
    first: -1,
    reach: [game.hands[0].weight.slice(), game.hands[1].weight.slice()],
    toActual: [0, 1, 2, 3]
  };
}
function childKind(game, templateId, nodeId) {
  const node = game.tree.templates[templateId].nodes[nodeId];
  if (node.kind === "decision") return "decision";
  if (node.kind === "fold") return "fold";
  if (game.tree.templates[templateId].street === 2) return "showdown";
  return node.allIn ? "allin" : "chance";
}
function zeroHolding(game, reach, card) {
  for (let p = 0; p < 2; p += 1) {
    const hands = game.hands[p];
    for (let h = 0; h < hands.count; h += 1) if (hands.cards[2 * h] === card || hands.cards[2 * h + 1] === card) reach[p][h] = 0;
  }
}
function mapBack(view, maps) {
  const remap = (arr, p, rows = 1) => {
    const n = maps[p].length;
    const out2 = new Float32Array(arr.length);
    for (let row = 0; row < rows; row += 1) for (let h = 0; h < n; h += 1) out2[row * n + maps[p][h]] = arr[row * n + h];
    return out2;
  };
  return {
    ...view,
    strategy: view.strategy && view.actor !== null ? remap(view.strategy, view.actor, view.actions.length) : null,
    reach: [remap(view.reach[0], 0), remap(view.reach[1], 1)],
    ev: view.ev ? [remap(view.ev[0], 0), remap(view.ev[1], 1)] : null,
    equity: [remap(view.equity[0], 0), remap(view.equity[1], 1)]
  };
}
function buildView(engine, state) {
  const { game } = engine;
  const template = game.tree.templates[state.templateId];
  const node = template.nodes[state.nodeId];
  if (node.kind === "fold") throw new PathError("That line ends the hand.");
  const isDecision = node.kind === "decision";
  if (!isDecision && (template.street === 2 || node.allIn)) throw new PathError("That line ends the hand.");
  const invested = isDecision ? [node.invested[0], node.invested[1]] : [node.invested, node.invested];
  const ev = [new Float32Array(game.hands[0].count), new Float32Array(game.hands[1].count)];
  const equity = [new Float32Array(game.hands[0].count), new Float32Array(game.hands[1].count)];
  let haveEv = true;
  for (const p of [0, 1]) {
    const oppReach = state.reach[1 - p];
    const compat = compatibleSums(game, p, oppReach);
    const values = engine.values(p, state.templateId, state.nodeId, state, oppReach);
    if (!values) haveEv = false;
    const eq = engine.equityValues(p, template.street, state.t, state.r, oppReach);
    for (let h = 0; h < game.hands[p].count; h += 1) {
      const ok = compat[h] > 1e-9 && state.reach[p][h] > 1e-9;
      ev[p][h] = compat[h] > 1e-9 && values ? values[h] / compat[h] + invested[p] : NaN;
      equity[p][h] = ok ? eq[h] / compat[h] : NaN;
    }
  }
  let strategy = null;
  let actions = [];
  let childKinds = [];
  if (isDecision) {
    const decision = node;
    strategy = Float32Array.from(engine.averageStrategy(state.templateId, state.nodeId, state.instance));
    actions = decision.actions;
    childKinds = decision.children.map((child) => childKind(game, state.templateId, child));
  }
  return {
    kind: isDecision ? "decision" : "chance",
    street: template.street,
    actor: isDecision ? node.player : null,
    actions,
    childKinds,
    invested,
    strategy,
    reach: [Float32Array.from(state.reach[0]), Float32Array.from(state.reach[1])],
    ev: haveEv ? ev : null,
    equity
  };
}
async function viewAt(engine, state, steps, forward) {
  const { game } = engine;
  let current = state;
  for (let i = 0; i < steps.length; i += 1) {
    const step = steps[i];
    const template = game.tree.templates[current.templateId];
    const node = template.nodes[current.nodeId];
    if ("action" in step) {
      if (node.kind !== "decision" || step.action < 0 || step.action >= node.actions.length) throw new PathError("No such action here.");
      const strategy = engine.averageStrategy(current.templateId, current.nodeId, current.instance);
      const actorHands = game.hands[node.player].count;
      const reach2 = [current.reach[0].slice(), current.reach[1].slice()];
      for (let h = 0; h < actorHands; h += 1) reach2[node.player][h] *= strategy[step.action * actorHands + h];
      current = { ...current, nodeId: node.children[step.action], reach: reach2 };
      continue;
    }
    if (node.kind !== "end" || node.next < 0 || node.allIn) throw new PathError("No card comes here.");
    const inverse = [0, 0, 0, 0];
    current.toActual.forEach((actual, mine) => {
      inverse[actual] = mine;
    });
    const card = mapCard2(step.card, inverse);
    const used = /* @__PURE__ */ new Set([...game.board, current.t, current.r]);
    if (used.has(card)) throw new PathError("That card is already out.");
    const reach = [current.reach[0].slice(), current.reach[1].slice()];
    zeroHolding(game, reach, card);
    const deals2 = current.depth === 0 ? forward ? game.fullDeals1 : game.deals1 : game.deals2[current.first];
    const local = deals2.canonIndex[card];
    if (local < 0) throw new PathError("That card is not in this part of the tree.");
    const g = deals2.permOf[card];
    const perm = game.perms[g];
    const maps = [game.handPerm[0][g], game.handPerm[1][g]];
    const repReach = [new Float64Array(game.hands[0].count), new Float64Array(game.hands[1].count)];
    for (let p = 0; p < 2; p += 1) for (let h = 0; h < game.hands[p].count; h += 1) repReach[p][h] = reach[p][maps[p][h]];
    const toActual = [0, 1, 2, 3].map((s) => current.toActual[perm[s]]);
    const repCard = deals2.canon[local];
    const rest = steps.slice(i + 1);
    if (current.depth === 0 && forward) {
      return mapBack(await forward({ position: local, card: repCard, templateId: node.next, reach: repReach, steps: rest, toActual }), maps);
    }
    const next = current.depth === 0 ? { templateId: node.next, nodeId: 0, depth: 1, instance: local, t: repCard, r: -1, first: local, reach: repReach, toActual } : { templateId: node.next, nodeId: 0, depth: 2, instance: game.deals2Base[current.first] + local, t: current.t, r: repCard, first: current.first, reach: repReach, toActual };
    return mapBack(await viewAt(engine, next, rest, forward), maps);
  }
  return buildView(engine, current);
}

// ../../../private/tmp/pf-src6/src/lib/wasm/postflop-cfr.wasm.base64.ts
var POSTFLOP_CFR_WASM_BASE64 = "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";

// ../../../private/tmp/pf-src6/src/lib/poker-postflop/reference-solver.ts
var DEFAULT_DISCOUNT = { alpha: 1.5, beta: 0, gamma: 3 };

// ../../../private/tmp/pf-src6/src/lib/poker-postflop/wasm-solver.ts
var compiled;
function decodeBase64(base64) {
  const maybeBuffer = globalThis.Buffer;
  if (maybeBuffer) {
    const bytes2 = maybeBuffer.from(base64, "base64");
    const copy = new Uint8Array(bytes2.byteLength);
    copy.set(bytes2);
    return copy;
  }
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
function postflopModule() {
  if (compiled !== void 0) return compiled;
  try {
    compiled = typeof WebAssembly === "undefined" ? null : new WebAssembly.Module(decodeBase64(POSTFLOP_CFR_WASM_BASE64));
  } catch {
    compiled = null;
  }
  return compiled;
}
var pad4 = (n) => n + 3 & ~3;
var PAGE = 65536;
var MAX_BYTES = 4 * 1024 * 1024 * 1024 - PAGE;
function flattenTree(game) {
  const start = [];
  const nodes = [];
  for (const template of game.tree.templates) {
    start.push(nodes.length);
    template.nodes.forEach((node, local) => nodes.push({ template: template.id, local, node }));
  }
  return { start, nodes };
}
var Layout = class {
  padded;
  nodeOffset;
  templateSize;
  templateBase;
  /** Storage units per array: f32 values, or u16 values when compact. */
  storageUnits;
  compact;
  unitBytes;
  scratchBytes;
  tableBytes;
  slotBytes;
  totalBytes;
  constructor(game) {
    this.padded = [pad4(game.hands[0].count), pad4(game.hands[1].count)];
    this.compact = game.config.compact === true;
    this.unitBytes = this.compact ? 2 : 4;
    const header = this.compact ? 4 : 0;
    this.nodeOffset = [];
    this.templateSize = [];
    this.templateBase = [];
    let total = 0;
    let maxActions = 1;
    for (const template of game.tree.templates) {
      let size = 0;
      this.nodeOffset.push(template.nodes.map((node) => {
        if (node.kind !== "decision") return -1;
        const offset = size;
        size += header + node.actions.length * this.padded[node.player];
        maxActions = Math.max(maxActions, node.actions.length);
        return offset;
      }));
      this.templateSize.push(size);
      this.templateBase.push(total);
      total += size * game.layout.instances[template.id];
    }
    this.storageUnits = total;
    const depthOf = (templateId, nodeId) => {
      const node = game.tree.templates[templateId].nodes[nodeId];
      if (node.kind === "fold") return 0;
      if (node.kind === "end") return node.next >= 0 ? 1 + depthOf(node.next, 0) : 1;
      return 1 + Math.max(...node.children.map((child) => depthOf(templateId, child)));
    };
    const depth = depthOf(0, 0) + 2;
    const maxHands = Math.max(...this.padded);
    this.scratchBytes = 64 * 1024 + depth * ((2 * maxActions + 3) * maxHands * 4 + 64) + 2 * maxHands * 8 + (3 * maxHands + 128) * 8;
    const boards = game.boards.length;
    const deals2Cards = game.deals2.reduce((sum, set) => sum + set.canon.length, 0);
    this.tableBytes = 4096 + game.tree.templates.reduce((sum, t) => sum + t.nodes.length, 0) * 64 + 2 * maxHands * (8 + 4 + 4 + 24 * 4 + 8) + boards * (this.padded[0] + this.padded[1]) * 22 + boards * 8 + boards * 416 + 64 + 6 * 16 + 52 * 52 * 4 + game.deals2.length * 52 * 8 + deals2Cards * 4 + 1024;
    const rootNodes = game.tree.templates[0].nodes.length;
    this.slotBytes = (rootNodes * 3 + 8) * maxHands * 4;
    this.totalBytes = PAGE + this.tableBytes + this.storageUnits * this.unitBytes * 2 + this.scratchBytes + this.slotBytes;
  }
};
function discountFactors(iteration, params) {
  const t = iteration - 1;
  const ta = Math.pow(t, params.alpha);
  const tb = Math.pow(t, params.beta);
  return [t === 0 ? 0 : ta / (ta + 1), t === 0 ? 0 : tb / (tb + 1), Math.pow(t / (t + 1), params.gamma)];
}
var WasmPostflopSolver = class _WasmPostflopSolver {
  game;
  layout;
  flat;
  memory;
  exports;
  params;
  regretPointer;
  sumPointer;
  weightPointer = [0, 0];
  vecPointer;
  outPointer;
  slotReachPointer;
  slotValuePointer;
  capturePointer;
  stride;
  /** Root-street next-card nodes (global ids), in slot order. */
  slots;
  iteration = 0;
  static create(game, params = DEFAULT_DISCOUNT) {
    const module = postflopModule();
    if (!module) return null;
    const layout = new Layout(game);
    if (layout.totalBytes > MAX_BYTES) throw new Error("This tree is too big for one browser tab. Use fewer bet sizes or narrower ranges.");
    return new _WasmPostflopSolver(game, module, layout, params);
  }
  constructor(game, module, layout, params) {
    this.game = game;
    this.layout = layout;
    this.params = params;
    this.flat = flattenTree(game);
    const pages = Math.ceil(layout.totalBytes / PAGE) + 1;
    this.memory = new WebAssembly.Memory({ initial: pages, maximum: pages });
    const instance = new WebAssembly.Instance(module, { env: { memory: this.memory, abort: () => {
      throw new Error("postflop engine abort");
    } } });
    this.exports = instance.exports;
    let at = PAGE;
    const take = (bytes) => {
      const pointer = at;
      at += Math.ceil(bytes / 16) * 16;
      return pointer;
    };
    const buffer = this.memory.buffer;
    const i32 = (count, fill) => {
      const pointer = take(count * 4);
      const view = new Int32Array(buffer, pointer, count);
      if (fill) view.set(fill);
      return { pointer, view };
    };
    const f64 = (values) => {
      const pointer = take(values.length * 8);
      new Float64Array(buffer, pointer, values.length).set(values);
      return pointer;
    };
    const header = i32(72);
    const H = header.view;
    const [p0, p1] = layout.padded;
    H[0] = p0;
    H[1] = p1;
    H[2] = game.rootStreet;
    H[3] = game.board.length;
    const flat = this.flat;
    const n = flat.nodes.length;
    const kind = new Int32Array(n);
    const player = new Int32Array(n);
    const actionCount = new Int32Array(n);
    const firstChild = new Int32Array(n);
    const offset = new Int32Array(n).fill(-1);
    const template = new Int32Array(n);
    const next = new Int32Array(n).fill(-1);
    const allIn = new Int32Array(n);
    const street = new Int32Array(n);
    const inv0 = new Float64Array(n);
    const inv1 = new Float64Array(n);
    const children = [];
    flat.nodes.forEach(({ template: tpl, local, node }, id) => {
      template[id] = tpl;
      street[id] = game.tree.templates[tpl].street;
      if (node.kind === "decision") {
        kind[id] = 0;
        player[id] = node.player;
        actionCount[id] = node.actions.length;
        firstChild[id] = children.length;
        for (const child of node.children) children.push(flat.start[tpl] + child);
        offset[id] = layout.nodeOffset[tpl][local];
        inv0[id] = node.invested[0];
        inv1[id] = node.invested[1];
      } else if (node.kind === "fold") {
        kind[id] = 1;
        player[id] = node.folder;
        inv0[id] = node.invested[0];
        inv1[id] = node.invested[1];
      } else {
        kind[id] = 2;
        inv0[id] = node.invested;
        inv1[id] = node.invested;
        allIn[id] = node.allIn ? 1 : 0;
        next[id] = node.next >= 0 ? flat.start[node.next] : -1;
      }
    });
    H[4] = i32(n, kind).pointer;
    H[5] = i32(n, player).pointer;
    H[6] = i32(n, actionCount).pointer;
    H[7] = i32(n, firstChild).pointer;
    H[8] = i32(Math.max(1, children.length), children).pointer;
    H[9] = i32(n, offset).pointer;
    H[10] = i32(n, template).pointer;
    H[11] = i32(n, next).pointer;
    H[12] = i32(n, allIn).pointer;
    H[13] = i32(n, street).pointer;
    H[14] = f64(inv0);
    H[15] = f64(inv1);
    const templateBase = take(layout.templateBase.length * 4);
    new Uint32Array(buffer, templateBase, layout.templateBase.length).set(layout.templateBase);
    H[16] = templateBase;
    const templateSize = take(layout.templateSize.length * 4);
    new Uint32Array(buffer, templateSize, layout.templateSize.length).set(layout.templateSize);
    H[17] = templateSize;
    for (let p = 0; p < 2; p += 1) {
      const hands = game.hands[p];
      const padded = layout.padded[p];
      const c1 = new Int32Array(padded).fill(52);
      const c2 = new Int32Array(padded).fill(52);
      const same = new Int32Array(padded).fill(-1);
      const weight = new Float32Array(padded);
      for (let h = 0; h < hands.count; h += 1) {
        c1[h] = hands.cards[2 * h];
        c2[h] = hands.cards[2 * h + 1];
        same[h] = hands.sameIndex[h];
        weight[h] = hands.weight[h];
      }
      H[p === 0 ? 19 : 21] = i32(padded, c1).pointer;
      H[p === 0 ? 20 : 22] = i32(padded, c2).pointer;
      H[p === 0 ? 23 : 24] = i32(padded, same).pointer;
      const weightPointer = take(padded * 4);
      new Float32Array(buffer, weightPointer, padded).set(weight);
      this.weightPointer[p] = weightPointer;
      H[p === 0 ? 25 : 26] = weightPointer;
      const table = i32(24);
      for (let g = 0; g < game.perms.length; g += 1) {
        const map = new Int32Array(padded);
        for (let h = 0; h < padded; h += 1) map[h] = h < hands.count ? game.handPerm[p][g][h] : h;
        table.view[g] = i32(padded, map).pointer;
      }
      H[p === 0 ? 27 : 28] = table.pointer;
      const lists = Array.from({ length: 52 }, () => []);
      for (let h = 0; h < hands.count; h += 1) {
        lists[hands.cards[2 * h]].push(h);
        lists[hands.cards[2 * h + 1]].push(h);
      }
      const startArr = new Int32Array(53);
      const flatList = [];
      for (let c = 0; c < 52; c += 1) {
        startArr[c] = flatList.length;
        flatList.push(...lists[c]);
      }
      startArr[52] = flatList.length;
      H[p === 0 ? 29 : 31] = i32(53, startArr).pointer;
      H[p === 0 ? 30 : 32] = i32(Math.max(1, flatList.length), flatList).pointer;
    }
    H[33] = game.deals1.canon.length;
    H[34] = i32(Math.max(1, game.deals1.canon.length), game.deals1.canon).pointer;
    H[35] = i32(52, game.deals1.canonIndex).pointer;
    H[36] = i32(52, game.deals1.permOf).pointer;
    const d2count = game.deals2.length;
    const canonStart = [];
    const canonAll = [];
    const canonIndex = new Int32Array(Math.max(1, d2count) * 52).fill(-1);
    const permOf = new Int32Array(Math.max(1, d2count) * 52).fill(-1);
    game.deals2.forEach((set, i) => {
      canonStart.push(canonAll.length);
      canonAll.push(...set.canon);
      canonIndex.set(set.canonIndex, i * 52);
      permOf.set(set.permOf, i * 52);
    });
    H[37] = i32(Math.max(1, d2count), canonStart).pointer;
    H[38] = i32(Math.max(1, canonAll.length), canonAll).pointer;
    H[39] = i32(canonIndex.length, canonIndex).pointer;
    H[40] = i32(permOf.length, permOf).pointer;
    H[41] = i32(Math.max(1, d2count), game.deals2Base).pointer;
    H[42] = i32(Math.max(1, d2count), game.deals2.map((set) => set.canon.length)).pointer;
    H[43] = i32(game.boardIndex.length, game.boardIndex).pointer;
    for (let p = 0; p < 2; p += 1) {
      const padded = layout.padded[p];
      const hands = game.hands[p];
      const boards = game.boards.length;
      const orderPointer = take(boards * padded * 2);
      const strengthPointer = take(boards * padded * 2);
      const c1Pointer = take(boards * padded);
      const c2Pointer = take(boards * padded);
      const order = new Uint16Array(buffer, orderPointer, boards * padded);
      const strength = new Uint16Array(buffer, strengthPointer, boards * padded);
      const c1 = new Uint8Array(buffer, c1Pointer, boards * padded);
      const c2 = new Uint8Array(buffer, c2Pointer, boards * padded);
      const counts = new Int32Array(boards);
      game.boards.forEach((board, b) => {
        const list = board.order[p];
        const base = b * padded;
        for (let k = 0; k < list.length; k += 1) {
          const h = list[k];
          order[base + k] = h;
          strength[base + k] = board.strength[p][h];
          c1[base + k] = hands.cards[2 * h];
          c2[base + k] = hands.cards[2 * h + 1];
        }
        counts[b] = list.length;
      });
      H[p === 0 ? 44 : 45] = strengthPointer;
      H[p === 0 ? 46 : 47] = orderPointer;
      H[p === 0 ? 48 : 49] = i32(boards, counts).pointer;
      H[p === 0 ? 55 : 57] = c1Pointer;
      H[p === 0 ? 56 : 58] = c2Pointer;
    }
    {
      const boards = game.boards.length;
      const seg = new Uint16Array(boards * 2 * 104);
      const pos = [new Uint16Array(boards * layout.padded[0] * 2), new Uint16Array(boards * layout.padded[1] * 2)];
      const me = [new Uint16Array(boards * layout.padded[0] * 6), new Uint16Array(boards * layout.padded[1] * 6)];
      const start = [new Int32Array(52), new Int32Array(52)];
      const fill = new Int32Array(52);
      const fillLt = new Int32Array(52);
      const fillLe = new Int32Array(52);
      game.boards.forEach((board, b) => {
        for (let q = 0; q < 2; q += 1) {
          const list = board.order[q];
          const cards = game.hands[q].cards;
          const count = new Int32Array(52);
          for (let j = 0; j < list.length; j += 1) {
            count[cards[2 * list[j]]] += 1;
            count[cards[2 * list[j] + 1]] += 1;
          }
          let offset2 = 0;
          for (let c = 0; c < 52; c += 1) {
            start[q][c] = offset2;
            seg[(b * 2 + q) * 104 + c] = offset2;
            seg[(b * 2 + q) * 104 + 52 + c] = offset2 + count[c];
            offset2 += count[c] + 1;
          }
          fill.set(start[q]);
          const base = b * layout.padded[q] * 2;
          for (let j = 0; j < list.length; j += 1) {
            pos[q][base + 2 * j] = ++fill[cards[2 * list[j]]];
            pos[q][base + 2 * j + 1] = ++fill[cards[2 * list[j] + 1]];
          }
        }
        for (let p = 0; p < 2; p += 1) {
          const q = 1 - p;
          const mine = board.order[p];
          const theirs = board.order[q];
          const myCards = game.hands[p].cards;
          const theirCards = game.hands[q].cards;
          const myStrength = board.strength[p];
          const theirStrength = board.strength[q];
          fillLt.set(start[q]);
          fillLe.set(start[q]);
          let lt = 0;
          let le = 0;
          const base = b * layout.padded[p] * 6;
          for (let k = 0; k < mine.length; k += 1) {
            const h = mine[k];
            const s = myStrength[h];
            while (lt < theirs.length && theirStrength[theirs[lt]] < s) {
              fillLt[theirCards[2 * theirs[lt]]] += 1;
              fillLt[theirCards[2 * theirs[lt] + 1]] += 1;
              lt += 1;
            }
            while (le < theirs.length && theirStrength[theirs[le]] <= s) {
              fillLe[theirCards[2 * theirs[le]]] += 1;
              fillLe[theirCards[2 * theirs[le] + 1]] += 1;
              le += 1;
            }
            const c1 = myCards[2 * h];
            const c2 = myCards[2 * h + 1];
            const o = base + 6 * k;
            me[p][o] = lt;
            me[p][o + 1] = le;
            me[p][o + 2] = fillLt[c1];
            me[p][o + 3] = fillLt[c2];
            me[p][o + 4] = fillLe[c1];
            me[p][o + 5] = fillLe[c2];
          }
        }
      });
      const u16 = (values) => {
        const at2 = take(values.byteLength);
        new Uint16Array(buffer, at2, values.length).set(values);
        return at2;
      };
      H[64] = u16(pos[0]);
      H[65] = u16(pos[1]);
      H[66] = u16(seg);
      H[67] = u16(me[0]);
      H[68] = u16(me[1]);
    }
    const flags = new Int32Array(52);
    for (const card of game.board) flags[card] = 1;
    H[54] = i32(52, flags).pointer;
    this.regretPointer = take(layout.storageUnits * layout.unitBytes);
    this.sumPointer = take(layout.storageUnits * layout.unitBytes);
    H[69] = layout.compact ? 1 : 0;
    H[50] = this.regretPointer;
    H[51] = this.sumPointer;
    this.vecPointer = [take(p0 * 4), take(p1 * 4)];
    this.outPointer = [take(p0 * 4), take(p1 * 4)];
    const stride = Math.max(p0, p1);
    this.stride = stride;
    const rootTemplate = game.tree.templates[0];
    const nodeSlot = new Int32Array(n).fill(-1);
    this.slots = [];
    rootTemplate.nodes.forEach((node, id) => {
      if (node.kind === "end" && node.next >= 0 && !node.allIn) {
        nodeSlot[id] = this.slots.length;
        this.slots.push(id);
      }
    });
    H[59] = i32(n, nodeSlot).pointer;
    this.slotReachPointer = take(Math.max(1, this.slots.length) * stride * 4);
    this.slotValuePointer = take(Math.max(1, this.slots.length) * stride * 4);
    this.capturePointer = take(rootTemplate.nodes.length * stride * 4);
    H[60] = this.slotReachPointer;
    H[61] = this.slotValuePointer;
    H[62] = stride;
    H[63] = this.capturePointer;
    H[52] = at;
    H[53] = at + layout.scratchBytes;
    if (at + layout.scratchBytes > this.memory.buffer.byteLength) throw new Error("postflop engine memory layout overflow");
    this.exports.setup(header.pointer, game.config.pot);
  }
  iterate() {
    this.iteration += 1;
    const [alpha, beta, gamma] = discountFactors(this.iteration, this.params);
    this.exports.setPhase(0, 0);
    this.exports.run(0, 0, alpha, beta, gamma);
    this.exports.run(1, 0, alpha, beta, gamma);
  }
  /**
   * First half of a split walk: walks the root street only and returns the opponent's reach entering each
   * next-card node (slot x real hands, concatenated).
   */
  collect(who, mode, discount) {
    this.exports.setPhase(1, 0);
    this.exports.run(who, mode, discount[0], discount[1], discount[2]);
    this.exports.setPhase(0, 0);
    const opp = 1 - who;
    const count = this.game.hands[opp].count;
    const out2 = new Float32Array(this.slots.length * count);
    const all = new Float32Array(this.memory.buffer, this.slotReachPointer, Math.max(1, this.slots.length) * this.stride);
    for (let k = 0; k < this.slots.length; k += 1) out2.set(all.subarray(k * this.stride, k * this.stride + count), k * count);
    return out2;
  }
  /**
   * Second half: walks the root street again with the next-card nodes' values supplied (slot x real
   * hands of `who`), updating it when training. Returns the weighted root value sum. With capture on,
   * every root-street node's values are kept for capturedValues().
   */
  finish(who, mode, discount, values, capture = false) {
    const count = this.game.hands[who].count;
    const all = new Float32Array(this.memory.buffer, this.slotValuePointer, Math.max(1, this.slots.length) * this.stride);
    all.fill(0);
    for (let k = 0; k < this.slots.length; k += 1) all.set(values.subarray(k * count, (k + 1) * count), k * this.stride);
    this.exports.setPhase(2, capture ? 1 : 0);
    const total = this.exports.run(who, mode, discount[0], discount[1], discount[2]);
    this.exports.setPhase(0, 0);
    return total;
  }
  /** Values of `who`'s hands kept by the last captured walk at a root-street node. */
  capturedValues(who, nodeId) {
    const count = this.game.hands[who].count;
    return Float64Array.from(new Float32Array(this.memory.buffer, this.capturePointer + nodeId * this.stride * 4, count));
  }
  /** Values at root-street next-card nodes over the cards this engine holds (slot x real hands of `who`). */
  chanceValues(who, mode, discount, nodes, reach) {
    const opp = 1 - who;
    const oppCount = this.game.hands[opp].count;
    const count = this.game.hands[who].count;
    const out2 = new Float32Array(nodes.length * count);
    for (let k = 0; k < nodes.length; k += 1) {
      const vec = new Float32Array(this.memory.buffer, this.vecPointer[opp], this.layout.padded[opp]);
      vec.fill(0);
      vec.set(reach.subarray(k * oppCount, (k + 1) * oppCount));
      this.exports.chanceValues(who, mode, nodes[k], this.vecPointer[opp], this.outPointer[who], discount[0], discount[1], discount[2]);
      out2.set(new Float32Array(this.memory.buffer, this.outPointer[who], count), k * count);
    }
    return out2;
  }
  /** Sum over compatible opponent reach of win + tie / 2, per hand of `who`, from `street` with t and r dealt. */
  equityValues(who, street, t, r, reach) {
    const opp = 1 - who;
    const vec = new Float32Array(this.memory.buffer, this.vecPointer[opp], this.layout.padded[opp]);
    vec.fill(0);
    for (let o = 0; o < this.game.hands[opp].count; o += 1) vec[o] = reach[o];
    this.exports.equityValues(who, street, t, r, this.vecPointer[opp], this.outPointer[who]);
    return Float64Array.from(new Float32Array(this.memory.buffer, this.outPointer[who], this.game.hands[who].count));
  }
  normalizer() {
    const [mine, theirs] = this.game.hands;
    let total = 0;
    const cardSum = new Float64Array(52);
    let all = 0;
    for (let o = 0; o < theirs.count; o += 1) {
      all += theirs.weight[o];
      cardSum[theirs.cards[2 * o]] += theirs.weight[o];
      cardSum[theirs.cards[2 * o + 1]] += theirs.weight[o];
    }
    for (let h = 0; h < mine.count; h += 1) {
      const same = mine.sameIndex[h];
      total += mine.weight[h] * (all - cardSum[mine.cards[2 * h]] - cardSum[mine.cards[2 * h + 1]] + (same >= 0 ? theirs.weight[same] : 0));
    }
    return total;
  }
  /**
   * One walk for one player from the root: mode 0 trains (discounted for `iteration`), 1 best response,
   * 2 average strategies. Returns that player's per-hand root values (real hands).
   */
  walkRoot(who, mode, iteration = this.iteration) {
    this.exports.setPhase(0, 0);
    const [alpha, beta, gamma] = mode === 0 ? discountFactors(iteration, this.params) : [0, 0, 0];
    this.exports.run(who, mode, alpha, beta, gamma);
    const out2 = new Float32Array(this.memory.buffer, this.exports.lastRootValues(), this.game.hands[who].count);
    return Float64Array.from(out2);
  }
  /** The engine's whole state: its memory, which an engine built for the same game can load with restore(). */
  snapshot() {
    return new Uint8Array(this.memory.buffer).slice();
  }
  restore(bytes, iteration) {
    const target = new Uint8Array(this.memory.buffer);
    if (bytes.length !== target.length) throw new Error("Engine state was saved for a different game.");
    target.set(bytes);
    this.iteration = iteration;
  }
  /** Overwrites a player's root range weights (real hands), e.g. for a re-solving gadget. */
  setRootWeights(player, weights) {
    const view = new Float32Array(this.memory.buffer, this.weightPointer[player], this.layout.padded[player]);
    view.fill(0);
    for (let h = 0; h < this.game.hands[player].count; h += 1) view[h] = weights[h];
  }
  expectedValues() {
    this.exports.setPhase(0, 0);
    const norm = this.normalizer();
    return [this.exports.run(0, 2, 0, 0, 0) / norm, this.exports.run(1, 2, 0, 0, 0) / norm];
  }
  bestResponseValues() {
    this.exports.setPhase(0, 0);
    const norm = this.normalizer();
    return [this.exports.run(0, 1, 0, 0, 0) / norm, this.exports.run(1, 1, 0, 0, 0) / norm];
  }
  exploitability() {
    const [a, b] = this.bestResponseValues();
    return (a + b - this.game.config.pot) / 2;
  }
  /**
   * Replaces a decision node's average strategy (actions x real hands, each hand's column summing to 1),
   * e.g. with the rounded strategy a stored record keeps, so later walks measure exactly that strategy.
   */
  setAverageStrategy(templateId, nodeId, instance, strategy) {
    if (this.layout.compact) throw new Error("Strategies cannot be replaced in compact storage.");
    const node = this.game.tree.templates[templateId].nodes[nodeId];
    const padded = this.layout.padded[node.player];
    const count = this.game.hands[node.player].count;
    const base = this.layout.templateBase[templateId] + instance * this.layout.templateSize[templateId] + this.layout.nodeOffset[templateId][nodeId];
    const sums = new Float32Array(this.memory.buffer, this.sumPointer, this.layout.storageUnits).subarray(base);
    for (let a = 0; a < node.actions.length; a += 1) for (let h = 0; h < count; h += 1) sums[a * padded + h] = strategy[a * count + h];
  }
  /** Average strategy of a decision node in one instance, actions x real hands. */
  averageStrategy(templateId, nodeId, instance) {
    const node = this.game.tree.templates[templateId].nodes[nodeId];
    const padded = this.layout.padded[node.player];
    const count = this.game.hands[node.player].count;
    const actions = node.actions.length;
    const base = this.layout.templateBase[templateId] + instance * this.layout.templateSize[templateId] + this.layout.nodeOffset[templateId][nodeId];
    const layout = this.layout;
    const sums = layout.compact ? new Uint16Array(this.memory.buffer, this.sumPointer, layout.storageUnits).subarray(base + 4) : new Float32Array(this.memory.buffer, this.sumPointer, layout.storageUnits).subarray(base);
    const out2 = new Float64Array(actions * count);
    for (let h = 0; h < count; h += 1) {
      let total = 0;
      for (let a = 0; a < actions; a += 1) total += sums[a * padded + h];
      for (let a = 0; a < actions; a += 1) out2[a * count + h] = total > 0 ? sums[a * padded + h] / total : 1 / actions;
    }
    return out2;
  }
  /**
   * Values of `player`'s hands below a node, given the opponent's reach there (real hand count).
   * mode 1: best response, 2: average strategies.
   */
  nodeValues(player, mode, templateId, nodeId, ctx, reach) {
    const opp = 1 - player;
    const vec = new Float32Array(this.memory.buffer, this.vecPointer[opp], this.layout.padded[opp]);
    vec.fill(0);
    for (let o = 0; o < this.game.hands[opp].count; o += 1) vec[o] = reach[o];
    this.exports.nodeValues(player, mode, this.flat.start[templateId] + nodeId, ctx.depth, ctx.instance, ctx.t, ctx.r, ctx.first, this.vecPointer[opp], this.outPointer[player]);
    const out2 = new Float32Array(this.memory.buffer, this.outPointer[player], this.layout.padded[player]);
    return Float64Array.from(out2.subarray(0, this.game.hands[player].count));
  }
};

// ../../../private/tmp/pf-src6/src/lib/poker-postflop/safe-resolve.ts
function safeResolve(game, hero, stored, iterations, solver = WasmPostflopSolver.create(game), done) {
  if (!solver) throw new Error("This browser has no WebAssembly SIMD support.");
  const opp = 1 - hero;
  const base = game.hands[opp].weight;
  const count = base.length;
  const quit = new Float64Array(count);
  const enter = new Float64Array(count);
  const share = new Float64Array(count);
  const weights = new Float64Array(count);
  let t = 1;
  for (; t <= iterations; t += 1) {
    for (let h = 0; h < count; h += 1) {
      const total = quit[h] + enter[h];
      share[h] = total > 0 ? enter[h] / total : 0.5;
      weights[h] = base[h] * share[h];
    }
    solver.setRootWeights(opp, weights);
    solver.walkRoot(hero, 0, t);
    const inside = solver.walkRoot(opp, 0, t);
    for (let h = 0; h < count; h += 1) {
      const value = (1 - share[h]) * stored[h] + share[h] * inside[h];
      quit[h] = Math.max(0, quit[h] + stored[h] - value);
      enter[h] = Math.max(0, enter[h] + inside[h] - value);
    }
    if (done && done(solver, t)) break;
  }
  solver.iteration = Math.min(t, iterations);
  solver.setRootWeights(opp, base);
  return { solver, enter: share.slice() };
}
function valueMass(game, player) {
  const mine = game.hands[player];
  const compat = compatibleSums(game, player, game.hands[1 - player].weight);
  let mass = 0;
  for (let h = 0; h < mine.count; h += 1) mass += mine.weight[h] * compat[h];
  return mass;
}
function gainOverStored(solver, hero, stored) {
  const opp = 1 - hero;
  const base = solver.game.hands[opp].weight;
  const best = solver.walkRoot(opp, 1);
  let total = 0;
  let positive = 0;
  for (let h = 0; h < base.length; h += 1) {
    const gain = base[h] * (best[h] - stored[h]);
    total += gain;
    if (gain > 0) positive += gain;
  }
  return { total, positive };
}

// ../../../private/tmp/pf-src6/src/lib/poker-postflop/stored-flop.ts
var handKey = (cards, h) => cards[2 * h] * 52 + cards[2 * h + 1];
function handIndex(game, p) {
  const out2 = /* @__PURE__ */ new Map();
  const hands = game.hands[p];
  for (let h = 0; h < hands.count; h += 1) out2.set(handKey(hands.cards, h), h);
  return out2;
}
function canonicalConfig(config) {
  const { cards, perm } = canonicalize(config.board);
  return { config: { ...config, board: cards, compact: void 0, combos: void 0 }, perm };
}
var StoredFlop = class {
  game;
  canonGame;
  record;
  perm;
  /** Actual hand index -> canonical game hand index, per player. */
  toCanon;
  strategies = /* @__PURE__ */ new Map();
  flopEv = /* @__PURE__ */ new Map();
  rootPaths;
  equity;
  flopEngine;
  constructor(config, bytes) {
    this.game = buildGame(config, { skipBoards: true });
    const canonical = canonicalConfig(config);
    this.perm = canonical.perm;
    this.canonGame = buildGame(canonical.config, { skipBoards: true });
    const shape = flopShape(this.canonGame);
    this.record = decodeFlopRecord(this.canonGame, bytes, shape.decisions.map((d) => d.actor));
    this.rootPaths = shape.roots.map((path) => JSON.stringify(path));
    this.toCanon = [0, 1].map((p) => {
      const index = handIndex(this.canonGame, p);
      const hands = this.game.hands[p];
      return Int32Array.from({ length: hands.count }, (_, h) => {
        const a = mapCard2(hands.cards[2 * h], this.perm);
        const b = mapCard2(hands.cards[2 * h + 1], this.perm);
        const found = index.get(Math.max(a, b) * 52 + Math.min(a, b));
        if (found === void 0) throw new Error("Stored flop record does not match these ranges.");
        return found;
      });
    });
    const evNodes = [...shape.decisions.map((d) => d.id), ...shape.roots.map((path) => {
      let id = 0;
      for (const step of path) id = this.canonGame.tree.templates[0].nodes[id].children[step.action];
      return id;
    })];
    evNodes.forEach((id, i) => {
      this.flopEv.set(id, [0, 1].map((p) => {
        const stored = this.record.flopEv[i][p];
        return Float64Array.from(this.toCanon[p], (c) => stored[c]);
      }));
    });
    shape.decisions.forEach((decision, i) => {
      const stored = this.record.strategies[i];
      const map = this.toCanon[decision.actor];
      const n = map.length;
      const actions = stored.length / n;
      const out2 = new Float64Array(stored.length);
      for (let a = 0; a < actions; a += 1) for (let h = 0; h < n; h += 1) out2[a * n + h] = stored[a * n + map[h]];
      this.strategies.set(decision.id, out2);
    });
    const checkDown = { bet: [], raise: [] };
    const equityGame = buildGame({ ...config, sizes: [[checkDown, checkDown, checkDown], [checkDown, checkDown, checkDown]], compact: void 0 });
    const equity = WasmPostflopSolver.create(equityGame);
    if (!equity) throw new Error("This browser has no WebAssembly SIMD support.");
    this.equity = equity;
    this.flopEngine = {
      game: this.game,
      averageStrategy: (templateId, nodeId) => {
        const strategy = templateId === 0 ? this.strategies.get(nodeId) : void 0;
        if (!strategy) throw new PathError("That line is not in the stored solution.");
        return strategy;
      },
      values: (player, templateId, nodeId, _ctx, reach) => {
        const ev = templateId === 0 ? this.flopEv.get(nodeId)?.[player] : void 0;
        if (!ev) return null;
        const node = this.game.tree.templates[0].nodes[nodeId];
        const invested = node.kind === "end" ? node.invested : node.invested[player];
        const compat = compatibleSums(this.game, player, reach);
        return Float64Array.from(ev, (v, h) => (v - invested) * compat[h]);
      },
      equityValues: (player, street, t, r, reach) => this.equity.equityValues(player, street, t, r, reach)
    };
  }
  /** Splits a line at its first dealt card: the flop part and the rest. */
  static split(steps) {
    const k = steps.findIndex((step) => "card" in step);
    if (k < 0) return { flop: steps, card: null, rest: [] };
    return { flop: steps.slice(0, k), card: steps[k].card, rest: steps.slice(k + 1) };
  }
  /** Key of a turn spot, for caching re-solves. */
  turnKey(flop, card) {
    return `${JSON.stringify(flop)}|${card}`;
  }
  /** The turn game after `flop` (a line ending the flop) and `card`, with both players' stored values. */
  async turnSpot(flop, card) {
    const root = this.rootPaths.indexOf(JSON.stringify(flop));
    if (root < 0) throw new PathError("No card comes here.");
    if (this.game.board.includes(card)) throw new PathError("That card is already out.");
    const view = await viewAt(this.flopEngine, rootState(this.game), flop);
    const config = this.game.config;
    const invested = view.invested[0];
    const combos = [new Float64Array(2704), new Float64Array(2704)];
    for (const p of [0, 1]) {
      const hands = this.game.hands[p];
      for (let h = 0; h < hands.count; h += 1) combos[p][handKey(hands.cards, h)] = view.reach[p][h];
    }
    for (const p of [0, 1]) {
      const hands = this.game.hands[p];
      let live = 0;
      for (let h = 0; h < hands.count; h += 1) if (hands.cards[2 * h] !== card && hands.cards[2 * h + 1] !== card) live += view.reach[p][h];
      if (live <= 1e-9) throw new PathError("No hands get here.");
    }
    const game = buildGame({ ...config, board: [...config.board, card], pot: config.pot + 2 * invested, stack: config.stack - invested, combos, compact: void 0 });
    const canonCard = mapCard2(card, this.perm);
    const deals2 = this.canonGame.fullDeals1;
    const local = deals2.canonIndex[canonCard];
    if (local < 0) throw new PathError("That card is not in the stored solution.");
    const g = deals2.permOf[canonCard];
    const stored = [0, 1].map((p) => {
      const player = p;
      const rep = this.record.values[root][local][p];
      const maps = this.canonGame.handPerm[p][g];
      const canonValue = new Float64Array(rep.length);
      for (let h = 0; h < rep.length; h += 1) canonValue[maps[h]] = rep[h];
      const flopIndex = handIndex(this.game, player);
      const compat = compatibleSums(game, player, game.hands[1 - p].weight);
      const hands = game.hands[p];
      return Float64Array.from({ length: hands.count }, (_, h) => {
        const v = canonValue[this.toCanon[p][flopIndex.get(handKey(hands.cards, h))]];
        return (Number.isFinite(v) ? v : 0) * compat[h];
      });
    });
    return { game, stored, invested };
  }
  /** The flop view at `steps` (no dealt cards). */
  flopView(steps) {
    return viewAt(this.flopEngine, rootState(this.game), steps);
  }
  /**
   * Maps a view of a turn game back to the flop game: its hand order (hands the turn card blocks drop out)
   * and chips counted from the flop (`invested` is what each player put in on the flop).
   */
  liftView(turnGame, view, invested) {
    const maps = [0, 1].map((p) => {
      const index = handIndex(turnGame, p);
      const hands = this.game.hands[p];
      return Int32Array.from({ length: hands.count }, (_, h) => index.get(handKey(hands.cards, h)) ?? -1);
    });
    const lift = (arr, p, rows, empty) => {
      const map = maps[p];
      const from = turnGame.hands[p].count;
      const out2 = new Float32Array(rows * map.length);
      for (let row = 0; row < rows; row += 1) for (let h = 0; h < map.length; h += 1) out2[row * map.length + h] = map[h] < 0 ? empty : arr[row * from + map[h]];
      return out2;
    };
    return {
      ...view,
      invested: [view.invested[0] + invested, view.invested[1] + invested],
      strategy: view.strategy && view.actor !== null ? lift(view.strategy, view.actor, view.actions.length, 0) : null,
      reach: [lift(view.reach[0], 0, 1, 0), lift(view.reach[1], 1, 1, 0)],
      ev: view.ev ? [lift(view.ev[0], 0, 1, NaN), lift(view.ev[1], 1, 1, NaN)] : null,
      equity: [lift(view.equity[0], 0, 1, NaN), lift(view.equity[1], 1, 1, NaN)]
    };
  }
};
var ResolvedTurn = class {
  constructor(game, solvers, invested) {
    this.game = game;
    this.solvers = solvers;
    this.invested = invested;
    this.engine = {
      game,
      averageStrategy: (templateId, nodeId, instance) => {
        const node = game.tree.templates[templateId].nodes[nodeId];
        const actor = node.kind === "decision" ? node.player : 0;
        return solvers[actor].averageStrategy(templateId, nodeId, instance);
      },
      values: (player, templateId, nodeId, ctx, reach) => solvers[player].nodeValues(player, 2, templateId, nodeId, ctx, reach),
      equityValues: (player, street, t, r, reach) => solvers[0].equityValues(player, street, t, r, reach)
    };
  }
  game;
  solvers;
  invested;
  engine;
  view(steps) {
    return viewAt(this.engine, rootState(this.game), steps);
  }
  /**
   * The river game after `steps` (a line ending the turn) and `card`, with a richer river size menu, and
   * each player's best-response value there against the other player's re-solved turn strategy. A safe
   * re-solve held to those values is no more exploitable than this re-solved turn.
   */
  async riverSpot(steps, card, sizes = RIVER_SIZES, allIn = true) {
    if (this.game.config.board.length !== 4) throw new PathError("No river comes here.");
    const best = { ...this.engine, values: (player, t, n, ctx, reach) => this.solvers[1 - player].nodeValues(player, 1, t, n, ctx, reach) };
    const view = await viewAt(best, rootState(this.game), [...steps, { card }]);
    if (!view.ev) throw new PathError("No river comes here.");
    const config = this.game.config;
    const combos = [new Float64Array(2704), new Float64Array(2704)];
    for (const p of [0, 1]) {
      const hands = this.game.hands[p];
      let live = 0;
      for (let h = 0; h < hands.count; h += 1) {
        combos[p][handKey(hands.cards, h)] = view.reach[p][h];
        live += view.reach[p][h];
      }
      if (live <= 1e-9) throw new PathError("No hands get here.");
    }
    const invested = view.invested[0];
    const merge = (a, b) => [.../* @__PURE__ */ new Set([...a, ...b])].sort((x, y) => x - y);
    const riverSizes = [0, 1].map((p) => config.sizes[p].map((street, index) => index === 2 ? { bet: merge(street.bet, sizes.bet), raise: merge(street.raise, sizes.raise) } : street));
    const game = buildGame({ ...config, board: [...config.board, card], pot: config.pot + 2 * invested, stack: config.stack - invested, combos, sizes: riverSizes, allIn: allIn || config.allIn, compact: void 0 });
    const stored = [0, 1].map((p) => {
      const player = p;
      const index = handIndex(this.game, player);
      const compat = compatibleSums(game, player, game.hands[1 - p].weight);
      const hands = game.hands[p];
      return Float64Array.from({ length: hands.count }, (_, h) => {
        const v = view.ev[p][index.get(handKey(hands.cards, h))];
        return (Number.isFinite(v) ? v : 0) * compat[h];
      });
    });
    return { game, stored, invested };
  }
};
var RIVER_SIZES = { bet: [0.1, 0.33, 0.75, 1.25, 2], raise: [1e6] };
var RESOLVE_TARGET = 3e-4;
var RESOLVE_MIN = 100;
var RESOLVE_MAX = 500;
var RESOLVE_CHECK = 50;
function resolveTurnFor(spot, hero, maxIterations = RESOLVE_MAX) {
  const opp = 1 - hero;
  const stored = spot.stored[opp];
  const mass = valueMass(spot.game, opp);
  const limit = RESOLVE_TARGET * spot.game.config.pot * mass;
  return safeResolve(spot.game, hero, stored, maxIterations, void 0, (solver, t) => t >= RESOLVE_MIN && t % RESOLVE_CHECK === 0 && (mass <= 1e-9 || gainOverStored(solver, hero, stored).positive <= limit)).solver;
}

// ../../../private/tmp/pf-src6/src/lib/poker/arena/hu100.ts
var HU_SPOT = "hu-sb-bb";
var HU_PRESET = SPOT_PRESETS.find((p) => p.id === HU_SPOT);
var PREFLOP_PUT = HU_PRESET.pot / 2;
var HU_RANGES = presetRanges(void 0, [], HU_PRESET);
var mergeSizes = (a, b) => [.../* @__PURE__ */ new Set([...a, ...b])].sort((x, y) => x - y);
function huConfig(flop) {
  return {
    board: [...flop],
    ranges: HU_RANGES,
    pot: HU_PRESET.pot,
    stack: HU_PRESET.stack,
    sizes: sizesFor(DEFAULT_SIZES, HU_PRESET.noDonk),
    allIn: false,
    allInThreshold: 0.67,
    maxRaises: 1
  };
}
function streetConfig(street, board, pot, stack) {
  const base = huConfig(board.slice(0, 3));
  const sizes = base.sizes.map((perStreet) => perStreet.map((s, i) => i === 2 && street === 2 ? { bet: mergeSizes(s.bet, RIVER_SIZES.bet), raise: mergeSizes(s.raise, RIVER_SIZES.raise) } : s));
  return { ...base, board: [...board], pot, stack, sizes, allIn: street === 2 ? true : base.allIn };
}
var COMBOS = [];
for (let a = 51; a >= 0; a -= 1) {
  for (let b = a - 1; b >= 0; b -= 1) {
    const ra = a >> 2, rb = b >> 2;
    const hi = 12 - ra, lo = 12 - rb;
    const cls = ra === rb ? hi * 13 + hi : (a & 3) === (b & 3) ? hi * 13 + lo : lo * 13 + hi;
    COMBOS.push({ cards: [a, b], cls });
  }
}
function sampler(weights) {
  const cum = new Float64Array(COMBOS.length);
  let total = 0;
  COMBOS.forEach((combo, i) => {
    total += weights[combo.cls];
    cum[i] = total;
  });
  return (u) => {
    const x = u * total;
    let lo = 0, hi = cum.length - 1;
    while (lo < hi) {
      const mid = lo + hi >> 1;
      if (cum[mid] <= x) lo = mid + 1;
      else hi = mid;
    }
    return COMBOS[lo].cards;
  };
}
var pick = [sampler(HU_RANGES[0]), sampler(HU_RANGES[1])];
function dealHu(rng) {
  for (; ; ) {
    const bb = pick[0](rng());
    const sb = pick[1](rng());
    if (bb.some((card) => sb.includes(card))) continue;
    const used = /* @__PURE__ */ new Set([...bb, ...sb]);
    const board = [];
    while (board.length < 5) {
      const card = Math.floor(rng() * 52);
      if (!used.has(card)) {
        used.add(card);
        board.push(card);
      }
    }
    return { hands: [[...bb], [...sb]], board };
  }
}
function showdownShare(deal, board) {
  const a = evaluateHand([...deal.hands[0], ...board]);
  const b = evaluateHand([...deal.hands[1], ...board]);
  return a > b ? 1 : a < b ? 0 : 0.5;
}
function allInEquity(deal, shown) {
  const known = deal.board.slice(0, shown);
  const used = /* @__PURE__ */ new Set([...deal.hands[0], ...deal.hands[1], ...known]);
  const rest = Array.from({ length: 52 }, (_, c) => c).filter((c) => !used.has(c));
  let sum = 0, count = 0;
  if (shown === 4) {
    for (const c of rest) {
      sum += showdownShare(deal, [...known, c]);
      count += 1;
    }
  } else {
    for (let i = 0; i < rest.length; i += 1) for (let j = i + 1; j < rest.length; j += 1) {
      sum += showdownShare(deal, [...known, rest[i], rest[j]]);
      count += 1;
    }
  }
  return sum / count;
}
async function playHu(deal, bots) {
  const log = [];
  const steps = [];
  let pot = HU_PRESET.pot;
  let stack = HU_PRESET.stack;
  const total = [PREFLOP_PUT, PREFLOP_PUT];
  for (let street = 0; ; street = street + 1) {
    const board = deal.board.slice(0, 3 + street);
    if (street > 0) steps.push({ card: board[board.length - 1] });
    const tree = buildBettingTree(streetConfig(street, board, pot, stack), street);
    const nodes = tree.templates[0].nodes;
    let node = nodes[0];
    while (node.kind === "decision") {
      const d = node;
      const decision = { street, board, player: d.player, hand: deal.hands[d.player], actions: d.actions, street_invested: [d.invested[0], d.invested[1]], pot, stack, steps: steps.slice() };
      const index = await bots[d.player].act(decision);
      const action = d.actions[index];
      if (!action) throw new Error(`${bots[d.player].id} chose action ${index} of ${d.actions.length}`);
      log.push({ street, player: d.player, kind: action.kind, put: action.put, total: action.total });
      steps.push({ action: index });
      node = nodes[d.children[index]];
    }
    if (node.kind === "fold") {
      const folder = node.folder;
      const winner = 1 - folder;
      const net = [0, 0];
      net[folder] = -(total[folder] + node.invested[folder]);
      net[winner] = total[folder] + node.invested[folder];
      return { net, adjusted: [net[0], net[1]], log, end: "fold", street };
    }
    const put = node.invested;
    total[0] += put;
    total[1] += put;
    const allIn = node.allIn;
    if (street === 2 || allIn) {
      const share = street === 2 ? showdownShare(deal, deal.board) : showdownShare(deal, deal.board);
      const win = total[1];
      const net = [(2 * share - 1) * win, (1 - 2 * share) * win];
      if (street === 2) return { net, adjusted: [net[0], net[1]], log, end: "showdown", street };
      const eq = allInEquity(deal, 3 + street);
      return { net, adjusted: [(2 * eq - 1) * win, (1 - 2 * eq) * win], log, end: "allin", street };
    }
    pot += 2 * put;
    stack -= put;
  }
}

// ../../../private/tmp/pf-src6/src/lib/poker/preflop-equity.generated.ts
var PREFLOP_EQUITY = [
  [85.18, 67.01, 66.22, 65.43, 64.62, 62.79, 61.92, 61.04, 59.89, 59.88, 59.02, 58.28, 57.4, 65.31, 82.44, 63.45, 62.62, 61.75, 59.98, 58.34, 57.47, 56.64, 55.82, 54.83, 54.02, 53.18, 64.42, 61.44, 79.89, 60.26, 59.5, 57.69, 56.03, 54.31, 53.58, 52.8, 51.87, 51.01, 50.18, 63.56, 60.57, 58.06, 77.42, 57.47, 55.64, 54.05, 52.33, 50.59, 49.95, 49.09, 48.29, 47.39, 62.71, 59.71, 57.3, 55.27, 75.02, 54.04, 52.32, 50.68, 48.94, 47.24, 46.53, 45.67, 44.83, 60.79, 57.81, 55.39, 53.17, 51.51, 72.04, 50.76, 49.17, 47.4, 45.69, 43.87, 43.26, 42.38, 59.9, 55.99, 53.59, 51.48, 49.78, 48.09, 69.2, 47.93, 46.25, 44.54, 42.72, 40.85, 40.28, 58.8, 55.25, 51.79, 49.67, 47.94, 46.28, 45.1, 66.26, 45.39, 43.7, 41.88, 39.99, 38.16, 57.64, 54.21, 51, 47.86, 46.12, 44.5, 43.26, 42.3, 63.28, 43.16, 41.35, 39.55, 37.62, 57.74, 53.35, 50.08, 47.16, 44.29, 42.68, 41.47, 40.46, 39.98, 60.37, 41.45, 39.69, 37.87, 56.71, 52.4, 49.11, 46.15, 43.54, 40.71, 39.45, 38.56, 38.08, 38.13, 57.07, 38.68, 36.8, 55.8, 51.41, 48.2, 45.25, 42.58, 40.02, 37.5, 36.59, 36.12, 36.3, 35.17, 53.79, 35.98, 54.93, 50.55, 47.27, 44.3, 41.65, 39.06, 36.89, 34.57, 34.11, 34.3, 33.21, 32.32, 50.36],
  [73.35, 50.72, 49.42, 47.98, 47.07, 44.65, 43.48, 42.48, 41.16, 41.39, 40.51, 39.62, 38.83, 48.21, 68.89, 47.05, 45.88, 44.77, 42.26, 40.02, 39.26, 38.19, 37.35, 36.47, 35.74, 34.88, 46.96, 44.24, 64.81, 44.13, 43.13, 40.73, 38.42, 36.43, 35.72, 34.99, 33.99, 33.25, 32.44, 45.42, 43.07, 41.42, 61.26, 41.94, 39.55, 37.31, 35.19, 33.53, 32.62, 31.88, 31.1, 30.33, 44.14, 41.9, 40.22, 39.18, 57.64, 38.73, 36.7, 34.59, 32.76, 30.81, 30.08, 29.37, 28.67, 41.57, 39.27, 37.5, 36.25, 35.64, 53.56, 35.85, 34.14, 32.06, 30.18, 28.38, 27.77, 27.12, 40.31, 37.02, 35.15, 34.12, 33.32, 32.84, 49.89, 33.73, 31.97, 30.16, 28.17, 26.29, 25.77, 39.24, 35.96, 33.01, 31.85, 31.26, 30.59, 30.51, 46.38, 31.95, 30.02, 28.23, 26.43, 24.54, 37.93, 34.92, 32.26, 29.79, 29.12, 28.68, 28.48, 28.42, 43.22, 30.3, 28.56, 26.79, 24.82, 38.14, 33.95, 31.28, 29.1, 27.18, 26.56, 26.46, 26.55, 26.66, 40.11, 29.08, 27.29, 25.53, 37.06, 32.99, 30.42, 28.17, 26.49, 24.52, 24.3, 24.49, 24.88, 25.2, 36.7, 26.41, 24.67, 36.3, 32.08, 29.49, 27.29, 25.53, 23.97, 22.32, 22.45, 22.74, 23.4, 22.6, 33.54, 23.78, 35.29, 31.21, 28.57, 26.42, 24.73, 23.02, 21.71, 20.49, 20.8, 21.45, 20.66, 19.86, 30.57],
  [63.83, 41.45, 39.95, 38.49, 37.09, 34.57, 33.43, 32.36, 31.34, 31.65, 30.95, 30.34, 29.29, 38.45, 58.16, 38.24, 36.75, 35.61, 32.98, 30.72, 29.92, 29.02, 28.36, 27.47, 26.83, 26.21, 36.85, 35.26, 53.58, 35.67, 34.45, 31.79, 29.74, 27.69, 27.06, 26.18, 25.7, 24.92, 24.28, 35.38, 33.73, 32.67, 49.18, 33.88, 31.15, 29.04, 27.08, 25.18, 24.67, 24.09, 23.27, 22.68, 33.93, 32.46, 31.24, 30.7, 45.16, 31.04, 28.84, 26.86, 25.07, 23.16, 22.77, 22.13, 21.65, 30.96, 29.49, 28.29, 27.79, 27.55, 41.1, 28.52, 26.7, 24.8, 23, 21.35, 20.88, 20.17, 29.86, 27.15, 26.1, 25.5, 25.34, 24.94, 37.52, 26.56, 25.1, 23.19, 21.44, 19.83, 19.43, 28.68, 26.31, 23.8, 23.36, 23.17, 22.88, 23.11, 34.28, 25.03, 23.63, 21.73, 19.98, 18.48, 27.55, 25.28, 23.21, 21.4, 21.21, 20.99, 21.16, 21.42, 31.57, 23.63, 22.11, 20.42, 18.91, 28.12, 24.45, 22.45, 20.81, 19.31, 19.15, 19.35, 19.71, 20.02, 28.82, 22.7, 21.19, 19.49, 27.14, 23.39, 21.57, 20.05, 18.79, 17.23, 17.4, 17.83, 18.38, 18.85, 26.25, 20.38, 18.87, 26.36, 22.79, 20.93, 19.3, 18.08, 16.72, 15.73, 16.06, 16.44, 17.23, 16.38, 24.04, 18.21, 25.5, 22.11, 20.06, 18.52, 17.39, 16.07, 15.14, 14.17, 14.65, 15.51, 14.78, 13.94, 21.94],
  [55.9, 35.37, 33.67, 32.34, 31.04, 28.23, 27.35, 26.45, 25.49, 25.93, 25.38, 24.69, 24.2, 32.27, 49.9, 32.37, 31.01, 29.86, 27.11, 25.09, 24.47, 23.62, 22.97, 22.42, 21.82, 21.36, 30.47, 29.25, 44.65, 30.08, 29.12, 26.41, 24.33, 22.47, 21.91, 21.34, 20.66, 20.23, 19.73, 28.82, 27.74, 26.98, 40.42, 28.52, 26.13, 24, 22.17, 20.48, 19.89, 19.32, 18.88, 18.39, 27.45, 26.55, 25.73, 25.45, 36.26, 25.93, 24.06, 22.21, 20.45, 18.83, 18.36, 17.93, 17.47, 24.65, 23.53, 22.86, 22.7, 22.54, 32.63, 23.7, 22.06, 20.38, 18.74, 17.23, 16.86, 16.28, 23.32, 21.19, 20.65, 20.38, 20.39, 19.96, 29.53, 22.02, 20.57, 19.14, 17.52, 16.03, 15.7, 22.4, 20.4, 18.53, 18.43, 18.34, 18.29, 18.38, 26.75, 20.74, 19.4, 17.97, 16.35, 15.07, 21.43, 19.61, 17.84, 16.5, 16.44, 16.5, 16.78, 17.15, 24.5, 19.77, 18.35, 16.85, 15.49, 21.98, 18.94, 17.17, 16, 14.77, 14.83, 15.09, 15.45, 15.87, 22.36, 18.94, 17.59, 16.11, 21.25, 18.28, 16.56, 15.3, 14.39, 13.21, 13.38, 13.87, 14.45, 15, 20.6, 16.95, 15.71, 20.67, 17.72, 16.07, 14.69, 13.68, 12.74, 11.91, 12.23, 12.91, 13.64, 12.92, 19.11, 14.94, 19.86, 17.08, 15.41, 14.33, 13.2, 12.21, 11.53, 10.75, 11.18, 12.09, 11.51, 10.84, 17.73],
  [49.25, 31.06, 29.28, 27.86, 26.7, 24.1, 23.25, 22.48, 21.58, 22.09, 21.6, 21.26, 20.63, 27.84, 42.92, 28.27, 26.86, 25.73, 23.21, 21.48, 20.58, 20.01, 19.57, 18.96, 18.48, 18.17, 26, 25.11, 37.91, 26.19, 25.21, 22.68, 20.7, 19.09, 18.4, 18.01, 17.58, 17.05, 16.8, 24.34, 23.45, 22.87, 33.5, 24.93, 22.25, 20.53, 18.75, 17.27, 16.88, 16.49, 16.11, 15.69, 23.07, 22.29, 21.67, 21.41, 30.07, 22.32, 20.54, 18.9, 17.42, 15.96, 15.62, 15.28, 14.83, 20.18, 19.33, 18.81, 18.72, 18.8, 26.56, 20.31, 18.86, 17.28, 15.87, 14.55, 14.19, 13.91, 19.17, 17.36, 16.9, 16.76, 16.95, 16.71, 24.04, 19.06, 17.72, 16.24, 14.89, 13.61, 13.43, 18.32, 16.48, 15.04, 14.89, 15.03, 15.16, 15.29, 21.81, 17.9, 16.77, 15.4, 13.99, 12.92, 17.38, 15.95, 14.31, 13.15, 13.37, 13.52, 13.77, 14.11, 20.05, 16.99, 15.92, 14.42, 13.14, 17.99, 15.26, 13.87, 12.69, 11.83, 11.91, 12.31, 12.8, 13.17, 18.47, 16.46, 15.33, 14.01, 17.43, 14.84, 13.43, 12.25, 11.39, 10.46, 10.88, 11.38, 11.93, 12.61, 17.27, 14.71, 13.55, 16.92, 14.31, 12.88, 11.88, 10.98, 10.07, 9.46, 9.92, 10.56, 11.39, 10.72, 16.24, 13.09, 16.21, 13.9, 12.49, 11.44, 10.6, 9.71, 9.2, 8.64, 9.1, 9.97, 9.45, 8.96, 15.43],
  [43.55, 27.67, 26.01, 24.56, 23.59, 21.08, 20.27, 19.54, 18.93, 19.53, 19.06, 18.66, 17.98, 24.26, 37.5, 25.16, 23.71, 22.82, 20.38, 18.52, 17.9, 17.45, 17.02, 16.62, 16.3, 15.95, 22.6, 21.8, 32.54, 23.17, 22.2, 19.76, 18.15, 16.59, 16.01, 15.71, 15.22, 15.02, 14.66, 20.97, 20.35, 19.71, 28.51, 22.02, 19.64, 18.05, 16.43, 15.03, 14.69, 14.35, 14.05, 13.7, 19.69, 19.11, 18.7, 18.64, 25.34, 19.69, 18.22, 16.55, 15.05, 13.93, 13.61, 13.3, 12.93, 17.1, 16.36, 16.06, 16.01, 16.19, 22.44, 17.8, 16.48, 15.22, 14, 12.71, 12.48, 12.18, 16.23, 14.49, 14.24, 14.1, 14.44, 14.17, 20.28, 16.72, 15.59, 14.36, 13.16, 11.94, 11.7, 15.41, 13.86, 12.39, 12.4, 12.67, 12.82, 13.01, 18.62, 15.95, 14.8, 13.66, 12.37, 11.3, 14.62, 13.16, 12.01, 10.95, 11.07, 11.35, 11.85, 12.17, 17.25, 15.23, 14.18, 12.98, 11.8, 15.26, 12.78, 11.51, 10.64, 9.82, 9.91, 10.44, 11.04, 11.59, 16.13, 14.77, 13.68, 12.56, 14.79, 12.35, 11.11, 10.12, 9.56, 8.63, 9.01, 9.63, 10.37, 11.01, 15.21, 13.22, 12.29, 14.43, 11.99, 10.73, 9.86, 9.24, 8.33, 7.79, 8.41, 9.03, 9.88, 9.35, 14.56, 11.68, 13.7, 11.62, 10.42, 9.43, 8.88, 8.09, 7.6, 7.15, 7.72, 8.62, 8.19, 7.72, 14.11],
  [38.67, 24.99, 23.26, 21.97, 21.3, 18.7, 17.92, 17.41, 16.79, 17.28, 17.06, 16.8, 16.34, 21.49, 32.99, 22.52, 21.24, 20.44, 18.08, 16.52, 15.92, 15.56, 15.24, 14.94, 14.56, 14.22, 19.69, 19.1, 28.33, 20.74, 19.85, 17.64, 15.99, 14.67, 14.29, 13.96, 13.66, 13.32, 13.19, 18.31, 17.74, 17.31, 24.56, 19.75, 17.54, 16.03, 14.64, 13.43, 13.14, 12.77, 12.6, 12.37, 17.12, 16.73, 16.33, 16.27, 21.66, 17.69, 16.2, 14.81, 13.51, 12.4, 12.2, 11.88, 11.64, 14.69, 14.15, 13.71, 13.87, 14.13, 19.49, 15.81, 14.88, 13.53, 12.38, 11.39, 11.09, 10.91, 13.81, 12.35, 12.09, 12.22, 12.45, 12.38, 17.7, 15.08, 14.12, 12.81, 11.81, 10.69, 10.41, 13.15, 11.77, 10.61, 10.58, 10.96, 11.13, 11.47, 16.43, 14.46, 13.36, 12.32, 11.11, 10.15, 12.38, 11.27, 10.2, 9.29, 9.62, 9.78, 10.36, 10.78, 15.33, 13.86, 12.82, 11.83, 10.58, 13.11, 10.93, 9.73, 9.01, 8.35, 8.46, 9.07, 9.67, 10.09, 14.36, 13.47, 12.66, 11.45, 12.71, 10.53, 9.5, 8.68, 8.14, 7.34, 7.83, 8.42, 9.14, 9.79, 13.9, 12.08, 11.13, 12.39, 10.19, 9.22, 8.37, 7.79, 7.07, 6.74, 7.27, 7.92, 8.82, 8.34, 13.43, 10.68, 11.91, 9.98, 8.88, 8.07, 7.57, 6.87, 6.48, 6.18, 6.74, 7.65, 7.39, 6.84, 13.18],
  [34.56, 22.63, 21.19, 19.86, 18.89, 16.83, 16.31, 15.67, 15.11, 15.67, 15.6, 15.17, 14.81, 19.19, 29.12, 20.36, 19.32, 18.61, 16.36, 14.9, 14.4, 13.89, 13.68, 13.34, 13.24, 13.05, 17.41, 16.93, 25.02, 18.89, 17.99, 15.91, 14.54, 13.23, 12.85, 12.57, 12.35, 12.24, 11.94, 16.07, 15.64, 15.36, 21.59, 18.01, 15.89, 14.36, 13.12, 12.17, 11.74, 11.59, 11.29, 11.12, 15.2, 14.76, 14.36, 14.57, 19.04, 16.21, 14.63, 13.44, 12.27, 11.28, 11.04, 10.79, 10.51, 12.69, 12.26, 12.03, 12.17, 12.69, 17.32, 14.5, 13.57, 12.34, 11.17, 10.22, 10.06, 9.89, 11.98, 10.77, 10.54, 10.65, 10.94, 10.9, 15.91, 13.73, 12.83, 11.79, 10.56, 9.74, 9.54, 11.43, 10.24, 9.15, 9.25, 9.55, 9.86, 10.13, 14.74, 13.14, 12.35, 11.26, 10.18, 9.23, 10.83, 9.79, 8.65, 8.06, 8.33, 8.6, 9.18, 9.66, 14.03, 12.71, 11.91, 10.78, 9.67, 11.46, 9.39, 8.52, 7.82, 7.2, 7.37, 8, 8.78, 9.33, 13.28, 12.49, 11.57, 10.61, 11.19, 9.16, 8.09, 7.48, 6.98, 6.4, 6.82, 7.52, 8.24, 8.82, 12.99, 11.2, 10.26, 10.85, 8.84, 7.97, 7.24, 6.76, 6.13, 5.78, 6.37, 7.16, 8.01, 7.53, 12.73, 9.88, 10.34, 8.72, 7.72, 6.99, 6.55, 5.92, 5.58, 5.41, 5.96, 6.9, 6.6, 6.1, 12.56],
  [31.03, 20.64, 19.31, 18.12, 17.32, 15.19, 14.77, 14.25, 13.87, 14.45, 14.18, 14.03, 13.54, 17.18, 26.09, 18.73, 17.65, 16.8, 14.84, 13.64, 13.12, 12.71, 12.46, 12.3, 12.19, 11.9, 15.53, 15.04, 22.13, 17.24, 16.53, 14.48, 13.21, 12.12, 11.78, 11.53, 11.28, 11.09, 11.01, 14.24, 13.89, 13.74, 19.3, 16.52, 14.62, 13.25, 12.08, 11.06, 10.81, 10.64, 10.36, 10.26, 13.34, 13.21, 12.98, 12.99, 17.15, 14.85, 13.5, 12.34, 11.19, 10.25, 10.01, 9.88, 9.77, 11.2, 10.82, 10.7, 10.9, 11.4, 15.55, 13.53, 12.46, 11.42, 10.4, 9.41, 9.29, 9.11, 10.49, 9.46, 9.22, 9.36, 9.95, 9.81, 14.42, 12.82, 11.87, 10.85, 9.79, 8.96, 8.76, 10.02, 8.95, 8.04, 8.06, 8.55, 8.85, 9.15, 13.71, 12.39, 11.45, 10.46, 9.32, 8.47, 9.62, 8.58, 7.68, 7.05, 7.39, 7.73, 8.31, 8.76, 13.03, 11.93, 11.05, 10.01, 9.06, 10.1, 8.27, 7.37, 6.74, 6.41, 6.51, 7.22, 7.95, 8.4, 12.39, 11.63, 10.86, 9.89, 9.85, 7.99, 7.17, 6.55, 6.09, 5.53, 6.09, 6.88, 7.55, 8.27, 12.14, 10.41, 9.64, 9.61, 7.84, 6.98, 6.39, 5.97, 5.35, 5.13, 5.77, 6.52, 7.34, 6.94, 11.99, 9.13, 9.17, 7.64, 6.84, 6.2, 5.78, 5.23, 4.97, 4.88, 5.39, 6.26, 6.07, 5.55, 11.95]
];

// ../../../private/tmp/pf-src6/src/lib/poker/ranges.ts
var rankAt = (index) => 12 - index;
var HAND_CLASSES = [];
for (let row = 0; row < 13; row += 1) {
  for (let col = 0; col < 13; col += 1) {
    const a = rankAt(row);
    const b = rankAt(col);
    const high = Math.max(a, b);
    const low = Math.min(a, b);
    const kind = row === col ? "pair" : col > row ? "suited" : "offsuit";
    const label = RANK_CHARS[high] + RANK_CHARS[low] + (kind === "pair" ? "" : kind === "suited" ? "s" : "o");
    HAND_CLASSES.push({ label, row, col, high, low, kind, combos: kind === "pair" ? 6 : kind === "suited" ? 4 : 12 });
  }
}
var HAND_CLASS_BY_LABEL = new Map(HAND_CLASSES.map((hand) => [hand.label, hand]));
function comboClassLabel(a, b) {
  const ra = a >> 2;
  const rb = b >> 2;
  const high = Math.max(ra, rb);
  const low = Math.min(ra, rb);
  if (high === low) return RANK_CHARS[high] + RANK_CHARS[low];
  return RANK_CHARS[high] + RANK_CHARS[low] + ((a & 3) === (b & 3) ? "s" : "o");
}
function allCombos() {
  const combos = [];
  for (let a = 0; a < 52; a += 1) for (let b = a + 1; b < 52; b += 1) combos.push([a, b]);
  return combos;
}

// ../../../private/tmp/pf-src6/src/lib/poker/walkthrough/villain.ts
var comboKey2 = (combo) => combo[0] * 52 + combo[1];
function comboHash(combo, node, seed2) {
  let h = Math.imul(comboKey2(combo) + 1, 2654435761) ^ Math.imul(node + 7, 2246822507) ^ Math.imul(seed2 | 0, 3266489909);
  h ^= h >>> 16;
  h = Math.imul(h, 2146121005);
  h ^= h >>> 15;
  h = Math.imul(h, 2221713035);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
var classIndexOf = (combo) => {
  const hand = HAND_CLASS_BY_LABEL.get(comboClassLabel(combo[0], combo[1]));
  return hand.row * 13 + hand.col;
};
function straightOutRanks(ranks) {
  const has5 = (mask) => {
    const m = mask << 1 | mask >> 12 & 1;
    for (let low = 0; low <= 9; low += 1) if ((m >> low & 31) === 31) return true;
    return false;
  };
  if (has5(ranks)) return 0;
  let outs = 0;
  for (let r = 0; r < 13; r += 1) if (!(ranks & 1 << r) && has5(ranks | 1 << r)) outs += 1;
  return outs;
}
function drawOf(hole, board) {
  const suitCount = [0, 0, 0, 0];
  const boardSuit = [0, 0, 0, 0];
  let ranks = 0;
  let boardRanks = 0;
  for (const card of board) {
    suitCount[card & 3] += 1;
    boardSuit[card & 3] += 1;
    ranks |= 1 << (card >> 2);
    boardRanks |= 1 << (card >> 2);
  }
  for (const card of hole) {
    suitCount[card & 3] += 1;
    ranks |= 1 << (card >> 2);
  }
  const flush = suitCount.some((count, suit) => count === 4 && boardSuit[suit] < 4);
  const outs = straightOutRanks(ranks);
  const boardOuts = straightOutRanks(boardRanks);
  return { flush, straightOuts: outs > boardOuts ? outs : 0 };
}
function strengths(range, board) {
  const strength = new Float64Array(range.length);
  const draw = new Uint8Array(range.length);
  if (board.length === 0) {
    range.forEach((combo, i) => {
      strength[i] = PREFLOP_EQUITY[0][classIndexOf(combo)] / 100;
    });
    return { strength, draw };
  }
  const used = new Set(board);
  const values = [];
  const cards = [0, 0, ...board];
  for (const [a, b] of allCombos()) {
    if (used.has(a) || used.has(b)) continue;
    cards[0] = a;
    cards[1] = b;
    values.push(evaluateHand(cards));
  }
  values.sort((x, y) => x - y);
  const below = (v) => {
    let lo = 0, hi = values.length;
    while (lo < hi) {
      const mid = lo + hi >> 1;
      if (values[mid] < v) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  const above = (v) => {
    let lo = 0, hi = values.length;
    while (lo < hi) {
      const mid = lo + hi >> 1;
      if (values[mid] <= v) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  const river = board.length === 5;
  range.forEach((combo, i) => {
    cards[0] = combo[0];
    cards[1] = combo[1];
    const v = evaluateHand(cards);
    let s = (below(v) + above(v)) / 2 / values.length;
    if (!river) {
      const d = drawOf(combo, board);
      const turn = board.length === 4;
      let floor = 0;
      if (d.flush && d.straightOuts > 0) floor = turn ? 0.6 : 0.75;
      else if (d.flush) floor = turn ? 0.5 : 0.62;
      else if (d.straightOuts >= 2) floor = turn ? 0.45 : 0.55;
      else if (d.straightOuts === 1) floor = turn ? 0.25 : 0.35;
      if (floor > s) {
        s = floor;
        draw[i] = 1;
      } else if (d.flush || d.straightOuts >= 2) draw[i] = 1;
    }
    strength[i] = s;
  });
  return { strength, draw };
}

// ../../../private/tmp/pf-src6/src/lib/poker/arena/hu100-bots.ts
function sample(probs, u) {
  let total = 0;
  for (let i = 0; i < probs.length; i += 1) total += probs[i];
  let x = u * total;
  for (let i = 0; i < probs.length; i += 1) {
    x -= probs[i];
    if (x < 0) return i;
  }
  return probs.length - 1;
}
var GtoBot = class {
  constructor(source2, rng) {
    this.source = source2;
    this.rng = rng;
  }
  source;
  rng;
  id = "gto";
  flopKey = "";
  stored = null;
  turns = /* @__PURE__ */ new Map();
  rivers = /* @__PURE__ */ new Map();
  async open(flop) {
    const key = flop.join(",");
    if (this.stored && key === this.flopKey) return this.stored;
    const bytes = await this.source(flop);
    if (!bytes) throw new Error(`No stored solution for flop ${key}`);
    this.stored = new StoredFlop(huConfig(flop), bytes);
    this.flopKey = key;
    this.turns.clear();
    this.rivers.clear();
    return this.stored;
  }
  turn(stored, flop, card) {
    const key = stored.turnKey(flop, card);
    let job = this.turns.get(key);
    if (!job) {
      job = stored.turnSpot(flop, card).then((spot) => new ResolvedTurn(spot.game, [resolveTurnFor(spot, 0), resolveTurnFor(spot, 1)], spot.invested));
      this.turns.set(key, job);
    }
    return job;
  }
  river(turn, key, line, card) {
    let job = this.rivers.get(key);
    if (!job) {
      job = turn.riverSpot(line, card).then((spot) => new ResolvedTurn(spot.game, [resolveTurnFor(spot, 0), resolveTurnFor(spot, 1)], spot.invested));
      this.rivers.set(key, job);
    }
    return job;
  }
  /** The strategy view at this decision, in the stored flop game's hand order. */
  async view(decision) {
    const stored = await this.open(decision.board.slice(0, 3));
    const steps = decision.steps;
    const { flop, card, rest } = StoredFlop.split(steps);
    if (card === null) return { stored, view: await stored.flopView(flop) };
    const turn = await this.turn(stored, flop, card);
    const river = StoredFlop.split(rest);
    if (river.card === null) return { stored, view: stored.liftView(turn.game, await turn.view(rest), turn.invested) };
    const key = `${stored.turnKey(flop, card)}|${JSON.stringify(river.flop)}|${river.card}`;
    const solved = await this.river(turn, key, river.flop, river.card);
    return { stored, view: stored.liftView(solved.game, await solved.view(river.rest), turn.invested + solved.invested) };
  }
  async act(decision) {
    const { stored, view } = await this.view(decision);
    if (view.kind !== "decision" || view.actor !== decision.player || !view.strategy) throw new Error("The stored line does not match the hand.");
    if (view.actions.length !== decision.actions.length || view.actions.some((a2, i) => a2.kind !== decision.actions[i].kind || Math.abs(a2.put - decision.actions[i].put) > 0.011)) {
      throw new Error(`Menu mismatch: ${JSON.stringify(view.actions)} vs ${JSON.stringify(decision.actions)}`);
    }
    const hands = stored.game.hands[decision.player];
    const [a, b] = decision.hand[0] > decision.hand[1] ? decision.hand : [decision.hand[1], decision.hand[0]];
    let h = -1;
    for (let i = 0; i < hands.count; i += 1) if (hands.cards[2 * i] === a && hands.cards[2 * i + 1] === b) {
      h = i;
      break;
    }
    if (h < 0) throw new Error("The hand is not in the range.");
    const n = hands.count;
    const probs = view.actions.map((_, k) => view.strategy[k * n + h]);
    return sample(probs, this.rng());
  }
};
var RULE_STYLES = [
  { id: "rock", value: 0.25, bluff: 0.03, raise: 0.05, defend: 0.7 },
  { id: "station", value: 0.2, bluff: 0.02, raise: 0.03, defend: 1.5 },
  { id: "maniac", value: 0.5, bluff: 0.3, raise: 0.2, defend: 1.1 }
];
var strengthCache = /* @__PURE__ */ new Map();
function strengthOf(hand, board) {
  const key = board.join(",");
  let table = strengthCache.get(key);
  if (!table) {
    const used = new Set(board);
    const range = [];
    for (let a2 = 51; a2 >= 0; a2 -= 1) for (let b2 = a2 - 1; b2 >= 0; b2 -= 1) if (!used.has(a2) && !used.has(b2)) range.push([a2, b2]);
    const { strength, draw } = strengths(range, board);
    table = new Map(range.map((c, i) => [c[0] * 52 + c[1], { s: strength[i], draw: draw[i] === 1 }]));
    strengthCache.clear();
    strengthCache.set(key, table);
  }
  const [a, b] = hand[0] > hand[1] ? hand : [hand[1], hand[0]];
  return table.get(a * 52 + b);
}
var RuleBot = class {
  constructor(style, seed2) {
    this.style = style;
    this.seed = seed2;
  }
  style;
  seed;
  get id() {
    return this.style.id;
  }
  act(d) {
    const { s, draw } = strengthOf(d.hand, d.board);
    const st = this.style;
    const node = d.steps.length;
    const u = comboHash(d.hand[0] > d.hand[1] ? d.hand : [d.hand[1], d.hand[0]], node * 7 + d.street, this.seed);
    const find = (kinds) => d.actions.findIndex((a) => kinds.includes(a.kind));
    const facing = d.street_invested[1 - d.player] - d.street_invested[d.player];
    if (facing <= 1e-9) {
      const bets = d.actions.map((a, i) => ({ a, i })).filter((x) => x.a.kind === "bet" || x.a.kind === "allin");
      if (!bets.length) return find(["check"]);
      if (s >= 1 - st.value) return s > 0.97 ? bets[bets.length - 1].i : bets[Math.min(bets.length - 1, Math.floor(bets.length / 2))].i;
      if ((draw || s < 0.35) && u < st.bluff / 0.35) return bets[Math.min(bets.length - 1, Math.floor(bets.length / 2))].i;
      return find(["check"]);
    }
    const potNow = d.pot + d.street_invested[0] + d.street_invested[1];
    const raise = find(["raise", "allin"]);
    if (raise >= 0 && s >= 1 - st.raise) return raise;
    const defend = Math.min(0.98, st.defend * potNow / (potNow + facing) * 0.9);
    if (s >= 1 - defend || draw && facing <= 0.5 * potNow && u < 0.5) return find(["call"]);
    return find(["fold"]);
  }
};

// ../../../private/tmp/pf-src6/scripts/poker/arena/run-league.ts
var args = /* @__PURE__ */ new Map();
var argv = process.argv.slice(2).filter((a) => a !== "--");
for (let i = 0; i < argv.length; i += 2) args.set(argv[i].replace(/^--/, ""), argv[i + 1]);
var libDir = join(args.get("library") ?? "/tmp/postflop-library", HU_SPOT);
var deals = Number(args.get("deals") ?? 20);
var seed = Number(args.get("seed") ?? 1);
var out = args.get("out") ?? "league.json";
var sampleCount = Number(args.get("sample") ?? 40);
var [part, parts] = (args.get("part") ?? "0/1").split("/").map(Number);
var nameOf = (flop) => canonicalize(flop).cards.map(cardToString).join("");
var available = new Set(existsSync(libDir) ? readdirSync(libDir).filter((f) => f.endsWith(".pfl")).map((f) => f.replace(".pfl", "")) : []);
var source = (flop) => {
  const file = join(libDir, `${nameOf(flop)}.pfl`);
  return existsSync(file) ? new Uint8Array(brotliDecompressSync(readFileSync(file))) : null;
};
var BOT_IDS = ["gto", ...RULE_STYLES.map((s) => s.id)];
var allPairs = [];
for (let i = 0; i < BOT_IDS.length; i += 1) for (let j = i + 1; j < BOT_IDS.length; j += 1) allPairs.push([BOT_IDS[i], BOT_IDS[j]]);
var pairs = args.has("pairs") ? args.get("pairs").split(",").map((p) => p.split("-")) : allPairs;
var needsLibrary = pairs.some((p) => p.includes("gto"));
function makeBot(id, rng) {
  if (id === "gto") return new GtoBot(source, rng);
  return new RuleBot(RULE_STYLES.find((s) => s.id === id), seed);
}
async function main() {
  const rng = createRng(seed * 7919 + part);
  const tallies = pairs.map(([a, b]) => ({ a, b, deals: 0, net: 0, adjusted: 0, adjustedSq: 0, ms: 0 }));
  const samples = [];
  const started = Date.now();
  for (let d = 0; d < deals; d += 1) {
    let deal;
    do {
      deal = dealHu(rng);
    } while (needsLibrary && available.size < 1755 && !available.has(nameOf(deal.board.slice(0, 3))));
    for (const [k, [a, b]] of pairs.entries()) {
      const t0 = performance.now();
      const botA = makeBot(a, rng);
      const botB = makeBot(b, rng);
      const first = await playHu(deal, [botA, botB]);
      const second = await playHu(deal, [botB, botA]);
      const net = first.net[0] + second.net[1];
      const adjusted = first.adjusted[0] + second.adjusted[1];
      const tally = tallies[k];
      tally.deals += 1;
      tally.net += net;
      tally.adjusted += adjusted;
      tally.adjustedSq += adjusted * adjusted;
      tally.ms += performance.now() - t0;
      if (samples.length < sampleCount && rng() < 0.5) {
        samples.push({ deal, a, b, seats: [a, b], log: first.log, net: first.net, end: first.end });
      }
    }
    if ((d + 1) % 10 === 0 || d + 1 === deals) {
      console.log(`${d + 1}/${deals} deals, ${((Date.now() - started) / 1e3).toFixed(0)} s | ` + tallies.map((t) => `${t.a}-${t.b} ${(t.adjusted / t.deals / 2 * 100).toFixed(1)} bb/100 (${(t.ms / t.deals / 1e3).toFixed(2)} s/deal)`).join(", "));
    }
  }
  writeFileSync(out, JSON.stringify({ version: 1, spot: HU_SPOT, seed, part, parts, deals, tallies, samples }));
}
main().catch((error) => {
  console.error(error);
  process.exit(1);
});
