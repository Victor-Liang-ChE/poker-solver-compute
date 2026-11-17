// scripts/poker/plo/solve-flops.ts
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from "node:fs";
import { cpus } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { brotliCompressSync, constants } from "node:zlib";

// src/lib/poker/cards.ts
var RANK_CHARS = "23456789TJQKA";
var SUIT_CHARS = "cdhs";
var SUIT_SYMBOLS = ["\u2663", "\u2666", "\u2665", "\u2660"];
var rankOf = (card) => card >> 2;
var suitOf = (card) => card & 3;
var makeCard = (rank, suit) => rank * 4 + suit;
function cardToString(card) {
  return RANK_CHARS[rankOf(card)] + SUIT_CHARS[suitOf(card)];
}
function parseCard(text) {
  const match = /^(10|[2-9tjqka])([cdhs♣♦♥♠])$/i.exec(text.trim());
  if (!match) return null;
  const rank = RANK_CHARS.indexOf(match[1] === "10" ? "T" : match[1].toUpperCase());
  const symbol = match[2].toLowerCase();
  const suit = SUIT_CHARS.indexOf(symbol) >= 0 ? SUIT_CHARS.indexOf(symbol) : SUIT_SYMBOLS.indexOf(symbol);
  return rank < 0 || suit < 0 ? null : makeCard(rank, suit);
}
function parseCards(text) {
  const compact = text.replace(/[\s,]+/g, "");
  if (!compact) return [];
  const tokens = compact.match(/(10|[2-9tjqka])[cdhs♣♦♥♠]/gi);
  if (!tokens || tokens.join("").length !== compact.length) return null;
  const cards = tokens.map(parseCard);
  if (cards.some((card) => card === null)) return null;
  const unique = new Set(cards);
  return unique.size === cards.length ? cards : null;
}
function choose(n, k) {
  if (k < 0 || k > n) return 0;
  const kk = Math.min(k, n - k);
  let result = 1;
  for (let i = 1; i <= kk; i += 1) result = result * (n - kk + i) / i;
  return Math.round(result);
}

// src/lib/poker-postflop/library.ts
var SUIT_PERMS = (() => {
  const out = [];
  const build2 = (prefix) => {
    if (prefix.length === 4) {
      out.push(prefix);
      return;
    }
    for (let s = 0; s < 4; s += 1) if (!prefix.includes(s)) build2([...prefix, s]);
  };
  build2([]);
  return out;
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
var flopList = null;
function canonicalFlops() {
  if (flopList) return flopList;
  const seen = /* @__PURE__ */ new Map();
  for (let a = 0; a < 52; a += 1) for (let b = a + 1; b < 52; b += 1) for (let c = b + 1; c < 52; c += 1) {
    const { cards } = canonicalize([a, b, c]);
    const key = cards.join(",");
    if (!seen.has(key)) seen.set(key, cards);
  }
  flopList = [...seen.values()].sort(compareCards);
  return flopList;
}

// src/lib/poker/hand-keys.ts
var RANK_KEYS = [0, 1, 5, 22, 98, 453, 2031, 8698, 22854, 83661, 262349, 636345, 1479181];
var HASH_SHIFT = 11;

// src/lib/poker/hand-hash-offsets.generated.ts
var HASH_OFFSETS = new Int32Array([0, 2048, 26994, 90430, 3613, 17699, 70753, 122268, 30641, 62881, 116295, 5294, 12198, 43178, 98771, 20330, 56656, 91870, 14824, 15402, 111061, 87186, 29611, 52290, 96674, 52939, 21870, 111538, 30209, 4250, 9205, 56242, 20608, 86630, 116681, 69218, 8370, 50494, 6350, 8376, 45985, 10415, 41434, 54568, 99082, 15785, 65715, 121629, 5719, 66030, 114599, 106469, 24840, 48341, 100466, 1465, 71901, 109482, 57616, 4971, 124613, 96033, 22451, 78241, 107530, 53513, 10187, 125088, 35173, 347, 4, 60734, 12202, 1, 125473, 83853, 6842, 43, 61276, 12389, 12, 40786, 51205, 105400, 70164, 41088, 88344, 50372, 9937, 2774, 122571, 106901, 3491, 95035, 21634, 14196, 100, 126145, 76071, 12387, 125, 107251, 22766, 10, 126573, 76712, 5558, 0, 107468, 12113, 174, 0, 22447, 1, 0, 107825, 13403, 15, 0, 22646, 0, 0, 93122, 112881, 80701, 22460, 31353, 45427, 6993, 22084, 72917, 48768, 23098, 49160, 99389, 49419, 92148, 101596, 10353, 25438, 53373, 97588, 45563, 72806, 95163, 13867, 6972, 60766, 64008, 6443, 85218, 119073, 70656, 939, 58690, 87573, 14026, 43, 2024, 10279, 2, 73918, 88534, 113351, 68367, 15, 10795, 28672, 4897, 34641, 91036, 6158, 776, 68556, 103423, 23722, 2549, 120116, 24941, 5742, 74281, 106214, 63267, 3776, 126150, 33727, 552, 28, 63180, 7521, 9, 126463, 88452, 7027, 214, 107223, 7956, 44, 0, 21988, 14, 0, 107596, 22728, 7, 0, 22216, 3, 0, 9601, 98310, 75373, 13581, 9754, 123157, 108936, 23553, 17, 108850, 23060, 2500, 42387, 2343, 31, 0, 109630, 13458, 2, 0, 22768, 8, 0, 110034, 13652, 157, 0, 22957, 9, 0, 0, 0, 0, 0, 23183, 173, 0, 0, 3, 0, 0, 75736, 89828, 12621, 0, 6674, 20780, 28803, 71447, 123180, 14406, 74318, 107776, 33315, 1675, 61109, 70772, 3354, 85936, 109145, 14281, 4450, 82968, 42492, 4719, 12, 7064, 20930, 96, 33528, 83332, 10996, 76, 8454, 7446, 14, 0, 0, 23728, 1, 72240, 12652, 22387, 22776, 892, 51, 22363, 5, 79080, 123672, 97084, 4336, 120668, 65166, 9098, 184, 96230, 10518, 1, 126760, 90309, 16097, 13932, 46669, 100383, 37549, 36665, 85496, 23874, 13806, 61151, 115123, 9880, 44688, 55553, 91086, 15299, 75643, 104849, 70882, 14048, 116999, 86208, 23199, 76420, 106882, 74703, 14391, 57143, 89674, 5799, 75, 97054, 31211, 11804, 123678, 78339, 8956, 19, 109629, 72125, 224, 36480, 54360, 102959, 49672, 45533, 94898, 73735, 21201, 3499, 49014, 98301, 32531, 101843, 65974, 11264, 4409, 40993, 6222, 155, 0, 98109, 23534, 22612, 50221, 15622, 190, 0, 42101, 3337, 40, 0, 2606, 75, 83369, 104235, 57557, 4336, 130591, 26911, 3793, 10, 67287, 64107, 38839, 58986, 23734, 33068, 1588, 41440, 6842, 602, 118, 37, 47558, 12119, 32573, 6965, 3118, 304, 1037, 202, 23884, 244, 25961, 3496, 28, 22441, 385, 353, 5, 0, 36, 60, 0, 119785, 70426, 23791, 31, 109860, 7434, 3, 0, 117322, 98683, 23564, 98649, 15537, 83326, 45112, 95178, 64459, 15249, 77183, 105260, 72517, 8411, 115313, 38697, 1168, 89567, 113934, 1196, 35, 127076, 11935, 5945, 20, 98861, 12622, 11, 127458, 79172, 14203, 150, 109935, 60554, 35, 0, 22830, 11815, 255, 111303, 13898, 77836, 23999, 12571, 13893, 2920, 61773, 109974, 72269, 8583, 19551, 58763, 1171, 40, 3, 99674, 14214, 6210, 81883, 16069, 329, 0, 111893, 9959, 264, 0, 23576, 110, 2910, 1031, 115, 0, 0, 4932, 165, 0, 0, 0, 178, 129524, 58633, 13841, 3, 80080, 7894, 59, 0, 11699, 20634, 23278, 42695, 20947, 357, 0, 2132, 94, 24365, 2, 87730, 8620, 2, 22922, 533, 128, 0, 3, 0, 37, 0, 2166, 313, 0, 0, 0, 141, 0, 0, 0, 0, 0, 100867, 23993, 281, 0, 23561, 15, 0, 0, 100788, 23996, 46, 23940, 8402, 10080, 94651, 54311, 15698, 204, 127511, 77278, 14365, 104, 100754, 14012, 4, 127986, 80203, 14975, 285, 111437, 9465, 138, 0, 23659, 1, 0, 111699, 14733, 7, 0, 23938, 14672, 240, 0, 0, 73, 0, 24165, 23, 24570, 13, 0, 255, 10, 25181, 14675, 8015, 4, 1, 112593, 8907, 0, 0, 24498, 299, 8325, 17607, 114, 39985, 63314, 113958, 94798, 17556, 110137, 73479, 13482, 2013, 28195, 1640, 19124, 112190, 95884, 13301, 18171, 82933, 16158, 315, 0, 101828, 24894, 16886, 64511, 4439, 26, 396, 36630, 269, 6, 0, 6930, 143, 8374, 17992, 153, 590, 0, 6418, 24, 0, 81634, 121416, 101694, 24561, 119232, 59582, 24077, 0, 24687, 5531, 9, 129609, 101646, 17863, 52, 92009, 13633, 39, 0, 2044, 121, 0, 93592, 13927, 33, 0, 4648, 6115, 5, 0, 0, 141, 0, 118203, 64898, 175, 0, 112290, 10550, 312, 0, 118116, 102765, 24892, 95362, 16207, 14489, 77, 24274, 14041, 2, 0, 102901, 14632, 258, 24460, 14370, 0, 0, 7, 8507, 19145, 69879, 115746, 31707, 59315, 115635, 86293, 96031, 101072, 65839, 37842, 61999, 69184, 50557, 13201, 111523, 35672, 3039, 6989, 72959, 788, 84189, 109334, 68438, 12866, 2081, 58199, 101227, 64123, 14184, 70471, 702, 44347, 18450, 16395, 75688, 1012, 35423, 45534, 16844, 27945, 60743, 51589, 37191, 66833, 115309, 43488, 14597, 55421, 25577, 558, 79220, 110483, 85768, 3864, 129684, 91299, 9677, 89, 29568, 3068, 0, 123405, 101725, 8032, 2, 11436, 118113, 78245, 24405, 951, 22870, 9633, 19076, 14631, 104, 246, 4705, 81961, 24112, 13779, 91304, 25336, 477, 8381, 123970, 112699, 15187, 4, 79087, 14884, 1, 128145, 70761, 9827, 638, 112867, 15348, 116, 0, 54845, 15799, 625, 113393, 4853, 3, 0, 24134, 95415, 24789, 391, 15611, 15141, 0, 24365, 5, 1, 0, 0, 24462, 51, 28164, 54410, 18208, 423, 25, 114575, 39087, 64509, 120098, 4300, 92787, 102735, 30058, 2614, 19112, 85078, 6226, 87795, 113900, 53970, 690, 65459, 34664, 13268, 133, 0, 114735, 11075, 8335, 74218, 19635, 2, 5077, 55127, 48835, 15112, 2, 7641, 19137, 3483, 21297, 30591, 6380, 69, 9189, 5654, 79, 82383, 121620, 67414, 1512, 119707, 79922, 3530, 2, 38564, 5324, 86, 130245, 80688, 6163, 137, 95929, 9890, 29, 0, 4684, 14, 2, 113893, 24226, 94, 0, 23788, 102670, 24424, 8, 0, 14888, 0, 24001, 1, 21, 0, 7, 24124, 0, 0, 50802, 104856, 82481, 4742, 60466, 51543, 15933, 82, 85250, 9980, 0, 107050, 22364, 4752, 264, 87074, 15686, 160, 0, 142, 405, 0, 88606, 15891, 347, 0, 15837, 15736, 178, 0, 10, 0, 0, 16069, 1, 0, 0, 0, 18, 0, 4110, 108819, 208, 125, 0, 89893, 77054, 118151, 102613, 1356, 90627, 76897, 12883, 6611, 1667, 984, 8814, 101904, 91338, 20218, 22, 12366, 21312, 728, 215, 0, 25238, 46, 16884, 5593, 1, 0, 0, 17852, 3959, 3, 0, 451, 131, 4863, 130, 1575, 10483, 328, 1455, 307, 17259, 124054, 115642, 15966, 14, 102903, 15506, 8504, 0, 5306, 138, 326, 115378, 24533, 851, 33394, 89052, 38481, 5696, 80002, 121775, 116398, 25176, 118324, 94514, 24660, 80763, 105635, 36157, 10955, 127734, 91964, 2232, 121, 27129, 15665, 15640, 124331, 91959, 7827, 6, 115878, 100550, 26176, 16987, 1844, 407, 10456, 103199, 24690, 1882, 1, 24187, 54027, 11119, 20235, 97783, 29367, 18775, 9937, 125079, 104213, 25524, 341, 60736, 17377, 4480, 19105, 4358, 71, 0, 116778, 17343, 419, 0, 17173, 7, 1, 117168, 17580, 601, 0, 24840, 45979, 25460, 693, 1, 17213, 39002, 30778, 16359, 22, 13297, 19305, 9330, 351, 107039, 36525, 3747, 55543, 8302, 9552, 270, 29, 167, 17813, 535, 13346, 16845, 315, 5160, 385, 25515, 716, 0, 2100, 168, 0, 136, 60, 700, 0, 27, 718, 251, 0, 56, 0, 466, 116764, 17598, 64, 0, 24369, 3, 648, 0, 104257, 24700, 0, 24596, 16504, 8, 81481, 125219, 117909, 18344, 124862, 83411, 17561, 263, 51002, 9995, 3, 128223, 92614, 9351, 444, 117649, 17491, 322, 0, 24322, 3, 0, 118164, 17774, 104, 0, 24607, 73202, 17991, 201, 0, 17557, 0, 24820, 2, 17856, 136, 2, 17768, 0, 12501, 75929, 9105, 348, 3, 118854, 18435, 570, 0, 17992, 49, 0, 119064, 18766, 753, 0, 25408, 231, 0, 0, 1, 0, 0, 25613, 413, 0, 0, 0, 18576, 506, 0, 0, 17, 98342, 10102, 4, 0, 5314, 358, 165, 0, 30669, 46746, 19398, 47, 554, 90324, 18850, 706, 768, 18651, 187, 5463, 53561, 19129, 131, 0, 19063, 369, 0, 0, 1, 0, 0, 19359, 550, 0, 0, 29, 809, 0, 0, 0, 0, 25086, 2, 0, 0, 0, 0, 0, 0, 17334, 10572, 1, 14, 1, 177, 128546, 119238, 25841, 89, 118764, 6950, 168, 0, 24821, 0, 665, 119477, 19027, 302, 0, 25011, 3, 886, 0, 1, 0, 0, 25221, 0, 0, 0, 0, 19007, 67, 0, 0, 1, 0, 0, 0, 18810, 0, 0, 7, 3, 0, 120352, 26220, 955, 0, 25699, 75, 0, 0, 0, 0, 0, 25906, 613, 51821, 107909, 81858, 17774, 1639, 6266, 19169, 347, 0, 105268, 25951, 15391, 85117, 17706, 81, 0, 120491, 19873, 812, 0, 25617, 295, 133, 41636, 42, 0, 0, 1118, 4951, 191, 0, 2, 19568, 570, 26017, 661, 50, 0, 141, 19951, 755, 57215, 94856, 18941, 3, 7680, 19471, 0, 0, 0, 20160, 941, 99362, 18744, 50, 0, 5520, 298, 0, 0, 0, 599, 0, 5734, 485, 0, 0, 0, 1537, 578, 0, 0, 0, 870, 121087, 19623, 468, 0, 25316, 17, 0, 0, 105264, 25610, 234, 25573, 19371, 0, 0, 0, 1, 0, 0, 25355, 19, 0, 43, 0, 0, 0, 0, 34539, 57672, 116019, 95048, 1684, 68260, 66862, 10298, 2, 121396, 153, 6954, 111813, 93088, 13124, 24936, 77545, 824, 34, 0, 122094, 26159, 3118, 72485, 19227, 11, 4, 66253, 62125, 11282, 8, 25828, 105954, 1124, 1112, 115, 25936, 438, 18801, 8135, 85, 87091, 119061, 56436, 19524, 29699, 85223, 11237, 73, 11537, 192, 177, 130679, 95950, 14624, 210, 19976, 7079, 0, 368, 0, 20231, 985, 57105, 19328, 104, 586, 5742, 10084, 19464, 2, 0, 3332, 430, 6058, 554, 0, 776, 0, 3575, 653, 0, 128769, 122395, 20078, 69, 122447, 25706, 151, 0, 19345, 0, 0, 124291, 19928, 0, 0, 25414, 25, 0, 0, 20333, 315, 0, 25866, 1, 0, 0, 1, 26022, 81, 0, 2, 0, 0, 0, 0, 0, 0, 0, 3, 0, 0, 126084, 26917, 970, 0, 26465, 42518, 112450, 92472, 11278, 39354, 69670, 6637, 230, 0, 127003, 21050, 11763, 9179, 8245, 60, 0, 131913, 12005, 1, 0, 26587, 539, 5122, 19405, 130, 0, 0, 11278, 19969, 485, 0, 198, 26867, 826, 26963, 1574, 16, 0, 394, 27077, 339, 130172, 105230, 20393, 189, 56348, 19878, 201, 0, 614, 149, 0, 107684, 20113, 290, 762, 6281, 506, 0, 0, 0, 862, 0, 15, 687, 0, 0, 0, 19923, 0, 0, 0, 3, 0, 0, 0, 0, 0, 0, 2, 0, 0, 108860, 76107, 20714, 349, 44910, 11246, 0, 0, 2800, 463, 0, 54305, 11896, 418, 0, 3630, 653, 0, 0, 0, 1024, 0, 20040, 16, 0, 0, 3, 75, 0, 0, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 90193, 21079, 656, 0, 20566, 43039, 85654, 20534, 11, 4, 5914, 9445, 316, 0, 26792, 255, 14907, 21535, 258, 0, 0, 26983, 128, 0, 0, 393, 0, 0, 27204, 1103, 0, 0, 536, 165, 0, 0, 0, 679, 0, 770, 0, 21738, 969, 0, 863, 450, 114099, 20967, 53, 0, 6517, 657, 637, 0, 0, 1059, 0, 25817, 14, 0, 82920, 122140, 131581, 26886, 128451, 105261, 26371, 258, 59197, 20753, 0, 130571, 93861, 3648, 441, 123242, 20944, 274, 0, 6413, 514, 6, 130973, 26268, 467, 0, 6633, 59244, 21152, 190, 0, 11535, 6, 25932, 8, 48, 0, 8, 20990, 0, 0, 129407, 106123, 27253, 428, 131475, 26741, 555, 0, 21256, 128, 0, 131729, 21961, 832, 0, 26501, 310, 0, 0, 0, 0, 0, 26707, 491, 0, 0, 1, 21872, 584, 0, 0, 62, 15615, 20756, 678, 0, 0, 27452, 253, 0, 9599, 11040, 444, 649, 219, 27240, 949, 0, 843, 428, 0, 0, 27495, 1133, 0, 1033, 619, 0, 0, 0, 1126, 0, 0, 802, 0, 0, 0, 0, 893, 0, 0, 0, 0, 26319, 1, 0, 0, 0, 0, 0, 0, 26172, 2, 0, 0, 0, 1257, 129049, 131595, 27155, 689, 126419, 11871, 172, 0, 6601, 646, 0, 131359, 26826, 594, 0, 26322, 1, 0, 0, 12, 0, 0, 26575, 14, 0, 0, 0, 21411, 111, 0, 0, 1, 0, 0, 0, 42, 0, 0, 10, 0, 0, 132011, 27553, 1e3, 0, 27054, 486, 0, 0, 13, 0, 0, 27244, 669, 0, 0, 147, 0, 0, 0, 0, 0, 0, 328, 0, 0, 0, 0, 421, 0, 0, 0, 0, 6502, 463, 0, 0, 0, 1021, 0, 0, 0, 91651, 22424, 1146, 1206, 21942, 663, 0, 0, 144, 0, 0, 22196, 848, 0, 0, 326, 0, 0, 0, 0, 0, 0, 507, 0, 0, 0, 0, 0, 0, 0, 0, 0, 11, 0, 0, 0, 0, 0, 0, 0, 762, 241, 0, 0, 0, 961, 131536, 27089, 559, 0, 26593, 40, 1147, 0, 5, 0, 0, 26781, 230, 0, 0, 3, 0, 0, 0, 0, 0, 0, 4, 0, 0, 0, 0, 4, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 27432, 884, 0, 0, 362, 0, 0, 0, 0, 0, 0, 550, 0, 1796, 49449, 20622, 436, 0, 132092, 27640, 1092, 0, 27143, 570, 0, 132420, 22607, 1279, 0, 27333, 779, 0, 0, 260, 0, 0, 27529, 964, 0, 0, 452, 22397, 1066, 0, 0, 544, 0, 641, 0, 0, 0, 0, 733, 0, 17646, 21699, 727, 0, 0, 28021, 1441, 0, 0, 922, 0, 4, 276, 0, 0, 0, 1103, 0, 0, 0, 0, 0, 0, 1296, 0, 0, 0, 0, 1388, 0, 0, 0, 0, 27041, 477, 0, 0, 1, 0, 0, 0, 26880, 274, 0, 172, 4, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 26064, 98211, 55687, 11666, 79, 129908, 106641, 231, 0, 132122, 27731, 14407, 79302, 9706, 112, 0, 132337, 22511, 1262, 0, 27443, 743, 581, 132591, 22715, 1448, 0, 27694, 106638, 28370, 1542, 407, 27854, 1022, 27976, 1114, 506, 0, 597, 28073, 1211, 113305, 93863, 11986, 393, 11912, 21795, 593, 0, 0, 22660, 1399, 11079, 3140, 13, 967, 0, 28475, 1584, 0, 0, 1064, 0, 6524, 431, 0, 0, 0, 3566, 529, 0, 0, 0, 1335, 0, 1426, 0, 0, 0, 0, 1518, 0, 131857, 27592, 700, 0, 27102, 178, 0, 0, 14, 0, 0, 27293, 364, 0, 0, 1, 0, 0, 0, 351, 0, 0, 28, 0, 0, 0, 0, 119, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 27953, 1009, 0, 0, 487, 22809, 80596, 21818, 614, 0, 132636, 22689, 1444, 0, 27910, 922, 0, 132866, 22862, 1627, 0, 28108, 1105, 0, 0, 585, 0, 0, 28296, 1293, 0, 0, 774, 28394, 1389, 0, 0, 870, 0, 961, 0, 1327, 0, 0, 1058, 0, 126229, 21657, 240, 0, 726, 250, 0, 0, 0, 1246, 0, 6725, 562, 0, 0, 0, 1428, 0, 0, 0, 0, 0, 0, 1609, 0, 0, 0, 70, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 68126, 12024, 373, 0, 3659, 513, 0, 0, 0, 1379, 0, 4225, 696, 0, 0, 0, 1560, 0, 0, 0, 0, 0, 109, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 22148, 672, 0, 0, 150, 423, 221, 265, 0, 0, 28248, 244, 0, 0, 750, 0, 0, 28463, 1462, 0, 0, 946, 0, 0, 0, 0, 0, 0, 1127, 0, 0, 0, 0, 1221, 0, 0, 0, 0, 0, 0, 0, 987, 0, 0, 0, 0, 7065, 695, 0, 0, 0, 1592, 0, 0, 0, 0, 0, 107, 0, 0, 130518, 106029, 27841, 789, 35606, 11899, 268, 0, 925, 239, 0, 127783, 22009, 297, 0, 7018, 551, 0, 0, 0, 1454, 0, 7734, 735, 0, 0, 0, 11946, 200, 0, 0, 0, 1726, 157, 0, 0, 0, 0, 0, 0, 0, 132284, 28133, 1092, 0, 27634, 570, 0, 0, 52, 0, 0, 27826, 758, 0, 0, 236, 0, 0, 0, 0, 0, 0, 420, 0, 0, 0, 0, 515, 0, 0, 0, 0, 0, 28702, 1639, 0, 0, 1124, 0, 0, 0, 28474, 1413, 0, 1307, 893, 0, 0, 0, 0, 0, 0, 1074, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 5, 0, 0, 0, 0, 0, 0, 0, 0, 1711, 0, 0, 0, 0, 132001, 22167, 622, 0, 7986, 678, 0, 0, 0, 1627, 0, 27353, 285, 0, 0, 114, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 38, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 28054, 926, 0, 0, 412, 0, 0, 0, 0, 0, 0, 593, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1473, 0, 0, 0, 0, 0, 0, 0, 22526, 1080, 0, 0, 559, 0, 0, 0, 0, 0, 0, 741, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1382, 0, 0, 0, 0, 27551, 457, 0, 0, 9, 0, 0, 0, 0, 0, 0, 117, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 751, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 132610, 28612, 1472, 0, 28146, 950, 0, 0, 433, 0, 0, 28328, 1141, 0, 0, 619, 0, 0, 0, 0, 0, 0, 801, 0, 0, 0, 0, 902, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 28987, 1789, 0, 0, 1268, 0, 0, 0, 0, 0, 0, 1451, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 275, 0, 0, 0, 0, 0, 0, 0, 52, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 130072, 133019, 29081, 0, 132527, 28574, 1375, 0, 28065, 858, 0, 132763, 22877, 1575, 0, 28414, 1054, 0, 0, 535, 0, 0, 28645, 1242, 0, 0, 729, 28765, 1344, 0, 0, 822, 0, 913, 0, 0, 0, 0, 1207, 0, 18721, 21903, 607, 0, 0, 29152, 1934, 0, 0, 1434, 0, 0, 29374, 2148, 0, 0, 1626, 0, 0, 0, 0, 0, 0, 1828, 0, 0, 0, 0, 1939, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 27983, 784, 0, 0, 273, 0, 0, 0, 0, 0, 0, 454, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1095, 0, 0, 0, 0, 0, 132934, 29238, 2066, 0, 28717, 1550, 0, 0, 1035, 0, 0, 28906, 1740, 0, 0, 1221, 0, 0, 0, 0, 0, 0, 1405, 0, 0, 0, 0, 1502, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1057, 263, 0, 0, 0, 1903, 0, 0, 0, 0, 0, 0, 2091, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 4352, 514, 0, 0, 0, 2047, 0, 0, 0, 0, 0, 0, 2228, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 820, 0, 0, 0, 0, 0, 29036, 1944, 0, 0, 1424, 0, 0, 0, 0, 0, 0, 1605, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2241, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 36901, 11976, 914, 0, 1075, 251, 0, 0, 0, 1919, 0, 7985, 546, 0, 0, 0, 2100, 0, 0, 0, 0, 0, 0, 2281, 0, 0, 0, 0, 2372, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 28375, 1211, 0, 0, 690, 0, 0, 0, 0, 0, 0, 875, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1745, 0, 0, 0, 0, 0, 0, 0, 1512, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 8157, 673, 0, 0, 0, 2239, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1005, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1136, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 505, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 28660, 1517, 0, 0, 1e3, 0, 0, 0, 0, 0, 0, 1184, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1820, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1312, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2105]);

// src/lib/poker/hand-evaluator.ts
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
  const pairs = [];
  for (let rank = 12; rank >= 0; rank -= 1) {
    const n = counts[rank];
    if (n > 0) present |= 1 << rank;
    if (n >= 4 && quad < 0) quad = rank;
    else if (n === 3) trips.push(rank);
    else if (n === 2) pairs.push(rank);
    else if (n >= 4) trips.push(rank);
  }
  if (quad >= 0) return pack(7, [quad, topBits(present & ~(1 << quad), 1)[0] ?? 0]);
  if (trips.length > 0) {
    const pairCandidates = [...trips.slice(1), ...pairs].sort((a, b) => b - a);
    if (pairCandidates.length > 0) return pack(6, [trips[0], pairCandidates[0]]);
  }
  const straight = STRAIGHT_TOP[present];
  if (straight >= 0) return pack(4, [straight]);
  if (trips.length > 0) return pack(3, [trips[0], ...topBits(present & ~(1 << trips[0]), 2)]);
  if (pairs.length >= 2) return pack(2, [pairs[0], pairs[1], topBits(present & ~(1 << pairs[0]) & ~(1 << pairs[1]), 1)[0] ?? 0]);
  if (pairs.length === 1) return pack(1, [pairs[0], ...topBits(present & ~(1 << pairs[0]), 3)]);
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
var CARD_RANK_KEY = new Int32Array(52);
var CARD_SUIT_KEY = new Int32Array(52);
for (let card = 0; card < 52; card += 1) {
  CARD_RANK_KEY[card] = RANK_KEYS[card >> 2];
  CARD_SUIT_KEY[card] = 1 << 4 * (card & 3);
}
var HASH_MASK = (1 << HASH_SHIFT) - 1;
var COUNTS = new Uint8Array(13);
var SUIT_MASKS = new Int32Array(4);
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

// src/lib/poker-plo/evaluator.ts
var TABLE_BITS = 14;
var TABLE_SIZE = 1 << TABLE_BITS;
var TABLE_MASK = TABLE_SIZE - 1;
var PATTERN_KEYS = new Int32Array(TABLE_SIZE).fill(-1);
var PATTERN_VALUES = new Uint16Array(TABLE_SIZE);
var FLUSH5 = new Uint16Array(8192);
var RANK_KEY = new Int32Array(52);
for (let card = 0; card < 52; card += 1) RANK_KEY[card] = RANK_KEYS[card >> 2];
var slotOf = (key) => Math.imul(key, 2654435761) >>> 32 - TABLE_BITS & TABLE_MASK;
var built = false;
function build() {
  if (built) return;
  built = true;
  const counts = new Uint8Array(13);
  const cards = [];
  const visit = (rank, left) => {
    if (left === 0) {
      cards.length = 0;
      let key = 0;
      let suit = 0;
      for (let r = 0; r < 13; r += 1) for (let k = 0; k < counts[r]; k += 1) {
        cards.push(r * 4 + (suit++ & 3));
        key += RANK_KEYS[r];
      }
      let slot = slotOf(key);
      while (PATTERN_KEYS[slot] !== -1) slot = slot + 1 & TABLE_MASK;
      PATTERN_KEYS[slot] = key;
      PATTERN_VALUES[slot] = evaluateBitmask(cards);
      return;
    }
    if (rank === 13) return;
    for (let c = Math.min(4, left); c >= 0; c -= 1) {
      counts[rank] = c;
      visit(rank + 1, left - c);
    }
    counts[rank] = 0;
  };
  visit(0, 5);
  for (let mask = 0; mask < 8192; mask += 1) {
    let bits = 0;
    for (let m = mask; m; m &= m - 1) bits += 1;
    if (bits !== 5) continue;
    const flush = [];
    for (let r = 0; r < 13; r += 1) if (mask & 1 << r) flush.push(r * 4);
    FLUSH5[mask] = evaluateBitmask(flush);
  }
}
var TRIPLES = [];
for (let i = 0; i < 5; i += 1) for (let j = i + 1; j < 5; j += 1) for (let k = j + 1; k < 5; k += 1) TRIPLES.push([i, j, k]);
var pairSlot = (a, b) => a < b ? a * 52 + b : b * 52 + a;
function boardPairValues(board, out = new Uint16Array(52 * 52)) {
  if (!built) build();
  out.fill(0);
  const used = new Uint8Array(52);
  for (let i = 0; i < 5; i += 1) used[board[i]] = 1;
  const tripleKey = new Int32Array(10);
  const tripleSuit = new Int8Array(10);
  const tripleMask = new Int32Array(10);
  for (let t = 0; t < 10; t += 1) {
    const [x, y, z] = TRIPLES[t];
    const a = board[x], b = board[y], c = board[z];
    tripleKey[t] = RANK_KEY[a] + RANK_KEY[b] + RANK_KEY[c];
    tripleSuit[t] = (a & 3) === (b & 3) && (b & 3) === (c & 3) ? a & 3 : -1;
    tripleMask[t] = 1 << (a >> 2) | 1 << (b >> 2) | 1 << (c >> 2);
  }
  for (let a = 0; a < 52; a += 1) {
    if (used[a]) continue;
    for (let b = a + 1; b < 52; b += 1) {
      if (used[b]) continue;
      const pairKey = RANK_KEY[a] + RANK_KEY[b];
      const pairSuit = (a & 3) === (b & 3) ? a & 3 : -2;
      const pairMask = 1 << (a >> 2) | 1 << (b >> 2);
      let best = 0;
      for (let t = 0; t < 10; t += 1) {
        let value;
        if (tripleSuit[t] === pairSuit) {
          value = FLUSH5[pairMask | tripleMask[t]];
        } else {
          const key = pairKey + tripleKey[t];
          let slot = slotOf(key);
          while (PATTERN_KEYS[slot] !== key) slot = slot + 1 & TABLE_MASK;
          value = PATTERN_VALUES[slot];
        }
        if (value > best) best = value;
      }
      out[a * 52 + b] = best;
    }
  }
  return out;
}
function omahaFromPairs(pairs, a, b, c, d) {
  let best = pairs[pairSlot(a, b)];
  let v = pairs[pairSlot(a, c)];
  if (v > best) best = v;
  v = pairs[pairSlot(a, d)];
  if (v > best) best = v;
  v = pairs[pairSlot(b, c)];
  if (v > best) best = v;
  v = pairs[pairSlot(b, d)];
  if (v > best) best = v;
  v = pairs[pairSlot(c, d)];
  if (v > best) best = v;
  return best;
}

// src/lib/poker-plo/combos.ts
var PLO_COMBO_COUNT = 270725;
var BINOM = [];
for (let n = 0; n <= 52; n += 1) {
  BINOM.push([]);
  for (let k = 0; k <= 4; k += 1) BINOM[n].push(k === 0 ? 1 : n < k ? 0 : (BINOM[n - 1]?.[k - 1] ?? 0) + (BINOM[n - 1]?.[k] ?? 0));
}
function comboIndex(a, b, c, d) {
  return BINOM[a][1] + BINOM[b][2] + BINOM[c][3] + BINOM[d][4];
}
var COMBO_CARDS = null;
function comboCards() {
  if (COMBO_CARDS) return COMBO_CARDS;
  const out = new Uint8Array(PLO_COMBO_COUNT * 4);
  for (let d = 3; d < 52; d += 1) for (let c = 2; c < d; c += 1) for (let b = 1; b < c; b += 1) for (let a = 0; a < b; a += 1) {
    const index = comboIndex(a, b, c, d);
    out[index * 4] = a;
    out[index * 4 + 1] = b;
    out[index * 4 + 2] = c;
    out[index * 4 + 3] = d;
  }
  COMBO_CARDS = out;
  return out;
}
var SUIT_PERMS2 = [];
{
  const perm = (prefix, rest) => {
    if (!rest.length) {
      SUIT_PERMS2.push(prefix);
      return;
    }
    rest.forEach((s, i) => perm([...prefix, s], rest.filter((_, j) => j !== i)));
  };
  perm([], [0, 1, 2, 3]);
}
function classKey(cards) {
  let best = Infinity;
  const relabeled = [0, 0, 0, 0];
  for (const perm of SUIT_PERMS2) {
    for (let k = 0; k < 4; k += 1) relabeled[k] = cards[k] & ~3 | perm[cards[k] & 3];
    relabeled.sort((x, y) => y - x);
    const key = ((relabeled[0] * 52 + relabeled[1]) * 52 + relabeled[2]) * 52 + relabeled[3];
    if (key < best) best = key;
  }
  return best;
}
var CLASS_TABLE = null;
function classTable() {
  if (CLASS_TABLE) return CLASS_TABLE;
  const cards = comboCards();
  const rawKeys = new Float64Array(PLO_COMBO_COUNT);
  const seen = /* @__PURE__ */ new Map();
  for (let i = 0; i < PLO_COMBO_COUNT; i += 1) {
    const key = classKey(cards.subarray(i * 4, i * 4 + 4));
    rawKeys[i] = key;
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  const keys = Float64Array.from(seen.keys()).sort();
  const idOf = /* @__PURE__ */ new Map();
  keys.forEach((key, id) => idOf.set(key, id));
  const classOf = new Uint16Array(PLO_COMBO_COUNT);
  const sizes = new Uint8Array(keys.length);
  for (let i = 0; i < PLO_COMBO_COUNT; i += 1) {
    const id = idOf.get(rawKeys[i]);
    classOf[i] = id;
    sizes[id] += 1;
  }
  CLASS_TABLE = { classOf, keys, sizes };
  return CLASS_TABLE;
}

// src/lib/poker-plo/symmetry.ts
var PERMS = (() => {
  const out = [];
  const build2 = (prefix) => {
    if (prefix.length === 4) {
      out.push(prefix);
      return;
    }
    for (let s = 0; s < 4; s += 1) if (!prefix.includes(s)) build2([...prefix, s]);
  };
  build2([]);
  return out.filter((p) => p.some((s, i) => s !== i));
})();
var permuteCard = (card, perm) => card & ~3 | perm[card & 3];
function permuteCombo(cards, offset, perm) {
  const a = permuteCard(cards[offset], perm), b = permuteCard(cards[offset + 1], perm);
  const c = permuteCard(cards[offset + 2], perm), d = permuteCard(cards[offset + 3], perm);
  const s = [a, b, c, d].sort((x, y) => x - y);
  return comboIndex(s[0], s[1], s[2], s[3]);
}
function spotSymmetries(board, sets, ranges) {
  return boardSymmetries(board, PERMS).filter((perm) => sets.every((set, p) => {
    const range = ranges[p];
    for (let h = 0; h < set.count; h += 1) if (range[permuteCombo(set.cards, h * 4, perm)] !== set.weight[h]) return false;
    return true;
  }));
}
function boardSymmetries(board, candidates) {
  const set = new Set(board);
  return candidates.filter((perm) => board.every((card) => set.has(permuteCard(card, perm))));
}
function canonicalCards(board, cards, candidates) {
  const group = boardSymmetries(board, candidates);
  const rep = new Int16Array(cards.length);
  const repPerm = new Array(cards.length).fill(null);
  const indexOf = new Map(cards.map((card, i) => [card, i]));
  for (let j = 0; j < cards.length; j += 1) {
    rep[j] = j;
    for (const p of group) {
      const i = indexOf.get(permuteCard(cards[j], p));
      if (i !== void 0 && i < j && rep[i] === i) {
        rep[j] = i;
        repPerm[j] = p;
        break;
      }
    }
  }
  return { rep, repPerm };
}

// src/lib/poker-plo/game.ts
var EPS = 1e-9;
var round = (value) => Math.round(value * 100) / 100;
var C3 = (n) => n * (n - 1) * (n - 2) / 6;
var C2 = (n) => n * (n - 1) / 2;
var tripleIndex = (a, b, c) => a + C2(b) + C3(c);
var TRIPLE_COUNT = 22100;
function buildHands(range, board) {
  const all = comboCards();
  const dead = new Uint8Array(52);
  for (const card of board) dead[card] = 1;
  const picked = [];
  for (let i = 0; i < PLO_COMBO_COUNT; i += 1) {
    if (!(range[i] > 0)) continue;
    const o = i * 4;
    if (dead[all[o]] || dead[all[o + 1]] || dead[all[o + 2]] || dead[all[o + 3]]) continue;
    picked.push(i);
  }
  const count = picked.length;
  const combo = Int32Array.from(picked);
  const cards = new Uint8Array(count * 4);
  const weight = new Float64Array(count);
  const pairs = new Int32Array(count * 6);
  const triples = new Int32Array(count * 4);
  const byCardLists = Array.from({ length: 52 }, () => []);
  for (let h = 0; h < count; h += 1) {
    const o = combo[h] * 4;
    const a = all[o], b = all[o + 1], c = all[o + 2], d = all[o + 3];
    cards.set([a, b, c, d], h * 4);
    weight[h] = range[combo[h]];
    pairs.set([a * 52 + b, a * 52 + c, a * 52 + d, b * 52 + c, b * 52 + d, c * 52 + d], h * 6);
    triples.set([tripleIndex(a, b, c), tripleIndex(a, b, d), tripleIndex(a, c, d), tripleIndex(b, c, d)], h * 4);
    byCardLists[a].push(h);
    byCardLists[b].push(h);
    byCardLists[c].push(h);
    byCardLists[d].push(h);
  }
  return { count, combo, cards, weight, pairs, triples, byCard: byCardLists.map((list) => Int32Array.from(list)) };
}
function linkTwins(a, b) {
  const indexB = /* @__PURE__ */ new Map();
  for (let i = 0; i < b.count; i += 1) indexB.set(b.combo[i], i);
  const twinA = new Int32Array(a.count).fill(-1);
  const twinB = new Int32Array(b.count).fill(-1);
  for (let i = 0; i < a.count; i += 1) {
    const j = indexB.get(a.combo[i]);
    if (j !== void 0) {
      twinA[i] = j;
      twinB[j] = i;
    }
  }
  return [{ ...a, twin: twinA }, { ...b, twin: twinB }];
}
function boardContext(cards, hands) {
  const pairValues = boardPairValues(cards);
  const dead = new Uint8Array(52);
  for (const card of cards) dead[card] = 1;
  const sorted = hands.map((set) => {
    const live = [];
    const value = new Uint16Array(set.count);
    for (let h = 0; h < set.count; h += 1) {
      const o = h * 4;
      const a = set.cards[o], b = set.cards[o + 1], c = set.cards[o + 2], d = set.cards[o + 3];
      if (dead[a] || dead[b] || dead[c] || dead[d]) continue;
      value[h] = omahaFromPairs(pairValues, a, b, c, d);
      live.push(h);
    }
    live.sort((x, y) => value[x] - value[y]);
    const order = Int32Array.from(live);
    const values = new Uint16Array(order.length);
    for (let i = 0; i < order.length; i += 1) values[i] = value[order[i]];
    return { order, values };
  });
  return { cards, order: [sorted[0].order, sorted[1].order], values: [sorted[0].values, sorted[1].values] };
}
function buildPloGame(spot) {
  if (spot.board.length < 3 || spot.board.length > 5) throw new Error("The board needs three, four or five cards.");
  const hands = linkTwins(buildHands(spot.ranges[0], spot.board), buildHands(spot.ranges[1], spot.board));
  const decisionNodes = [];
  const nodes = [];
  const boards = [];
  const register = (node) => {
    node.uid = nodes.length;
    nodes.push(node);
    return node;
  };
  const startStreet = spot.board.length - 3;
  const { pot, stack, sizes, maxBets } = spot;
  const symmetries = spot.symmetry === false ? [] : spotSymmetries(spot.board, hands, spot.ranges);
  const contextCache = /* @__PURE__ */ new Map();
  const contextFor = (cards) => {
    const key = [...cards].sort((a, b) => a - b).join(",");
    let ctx = contextCache.get(key);
    if (!ctx) {
      ctx = boardContext(cards, hands);
      contextCache.set(key, ctx);
      boards.push(ctx);
    }
    return ctx;
  };
  const showdown = (cards, invested) => {
    let ctx = null;
    return register({ kind: "showdown", uid: 0, invested, cards, board: () => ctx ??= contextFor(cards) });
  };
  const street = (board, start) => {
    const streetIndex = board.length - 3;
    const endStreet = (invested) => {
      const allIn = invested >= stack - EPS;
      if (board.length === 5) return showdown(board, invested);
      const used = new Set(board);
      const cards = [];
      for (let c = 0; c < 52; c += 1) if (!used.has(c)) cards.push(c);
      const node = register({ kind: "chance", uid: 0, invested, cards, children: [], ...canonicalCards(board, cards, symmetries) });
      if (spot.firstStreetOnly) return node;
      node.children = cards.map((card) => allIn ? runout([...board, card], invested) : street([...board, card], invested));
      return node;
    };
    const runout = (next, invested) => {
      if (next.length === 5) return showdown(next, invested);
      const used = new Set(next);
      const cards = [];
      for (let c = 0; c < 52; c += 1) if (!used.has(c)) cards.push(c);
      const node = register({ kind: "chance", uid: 0, invested, cards, children: [], ...canonicalCards(next, cards, symmetries) });
      node.children = cards.map((card) => runout([...next, card], invested));
      return node;
    };
    const decide = (player, invested, bets, checked) => {
      const me = invested[player];
      const them = invested[1 - player];
      const facing = them - me;
      const room = stack - me;
      const actions = [];
      const sized = (put, kind) => {
        let amount = round(put);
        if (amount >= room - EPS) amount = room;
        if (amount <= facing + EPS) return;
        const allIn = Math.abs(amount - room) < EPS;
        const total = round(me + amount);
        if (actions.some((action) => Math.abs(action.total - total) < EPS)) return;
        actions.push({ kind: allIn ? "allin" : kind, put: amount, total: allIn ? stack : total });
      };
      if (facing <= EPS) {
        actions.push({ kind: "check", put: 0, total: me });
        if (room > EPS && bets < maxBets) {
          const potNow = pot + invested[0] + invested[1];
          for (const size of sizes.bet) sized(Math.min(size, 1) * potNow, "bet");
        }
      } else {
        actions.push({ kind: "fold", put: 0, total: me });
        actions.push({ kind: "call", put: Math.min(facing, room), total: me + Math.min(facing, room) });
        if (bets < maxBets && them < stack - EPS && room > facing + EPS) {
          const potAfterCall = pot + invested[0] + invested[1] + facing;
          for (const size of sizes.raise) sized(facing + Math.max(Math.min(size, 1) * potAfterCall, facing), "raise");
        }
      }
      actions.sort((a, b) => a.put - b.put || (a.kind === "fold" ? -1 : 1));
      const node = register({
        kind: "decision",
        uid: 0,
        id: decisionNodes.length,
        player,
        street: streetIndex,
        invested: [invested[0], invested[1]],
        actions,
        children: [],
        regret: new Float32Array(0),
        strategySum: new Float32Array(0),
        regretScale: 1,
        sumScale: 1,
        mirrored: false
      });
      decisionNodes.push(node);
      for (const action of actions) {
        const next = [invested[0], invested[1]];
        next[player] = action.total;
        let child;
        if (action.kind === "fold") child = register({ kind: "fold", uid: 0, folder: player, invested: [invested[0], invested[1]] });
        else if (action.kind === "check") child = player === 0 && !checked ? decide(1, next, bets, true) : endStreet(next[0]);
        else if (action.kind === "call") child = endStreet(next[player]);
        else child = decide(1 - player, next, bets + 1, checked);
        node.children.push(child);
      }
      return node;
    };
    if (start >= stack - EPS) return endStreet(start);
    return decide(0, [start, start], 0, false);
  };
  const root = street(spot.board, 0);
  const chanceFactor = [0, 0, 0, 0, 0, 0];
  for (let b = 3; b <= 4; b += 1) chanceFactor[b] = 1 / (52 - 8 - b);
  void startStreet;
  const mirror = (node) => {
    if (node.kind === "decision") node.mirrored = true;
    if (node.kind === "decision" || node.kind === "chance") node.children.forEach(mirror);
  };
  for (const node of nodes) if (node.kind === "chance") node.children.forEach((child, i) => {
    if (node.rep[i] !== i) mirror(child);
  });
  const maps = /* @__PURE__ */ new Map();
  const handMap = (perm, player) => {
    const key = `${player}:${perm.join("")}`;
    let map = maps.get(key);
    if (!map) {
      const set = hands[player];
      const index = /* @__PURE__ */ new Map();
      for (let h = 0; h < set.count; h += 1) index.set(set.combo[h], h);
      map = new Int32Array(set.count);
      for (let h = 0; h < set.count; h += 1) {
        const j = index.get(permuteCombo(set.cards, h * 4, perm));
        if (j === void 0) throw new Error("A suit relabeling left the range.");
        map[h] = j;
      }
      maps.set(key, map);
    }
    return map;
  };
  return { spot, hands, root, decisionNodes, nodes, boards, boardFor: contextFor, chanceFactor, symmetries, handMap };
}
function ensureStorage(game, node) {
  if (node.regret.length) return;
  const n = game.hands[node.player].count * node.actions.length;
  node.regret = game.spot.compact ? new Int16Array(n) : new Float32Array(n);
  node.strategySum = game.spot.compact ? new Uint16Array(n) : new Float32Array(n);
  node.regretScale = 1;
  node.sumScale = 1;
}
function estimateMemory(game, compact = false) {
  let bytes = 0;
  const unit = compact ? 4 : 8;
  for (const node of game.decisionNodes) if (!node.mirrored) bytes += unit * node.actions.length * game.hands[node.player].count;
  return bytes;
}

// src/lib/poker-plo/ranges.ts
function buildRanking(data) {
  const { keys, sizes } = classTable();
  const idOf = /* @__PURE__ */ new Map();
  keys.forEach((key, id) => idOf.set(key, id));
  const order = new Uint16Array(data.keys.length);
  const position = new Uint16Array(data.keys.length);
  const equity = new Float32Array(data.keys.length);
  const cumulative = new Float64Array(data.keys.length);
  let total = 0;
  data.keys.forEach((key, i) => {
    const id = idOf.get(key);
    if (id === void 0) throw new Error("Unknown hand class in the ranking.");
    order[i] = id;
    position[id] = i;
    equity[id] = data.equity[i] / 1e4;
    total += sizes[id];
    cumulative[i] = total / PLO_COMBO_COUNT;
  });
  return { order, cumulative, equity, position };
}
function bandRange(ranking, from, to) {
  const { classOf, sizes } = classTable();
  const classWeight = new Float32Array(ranking.order.length);
  let start = 0;
  for (let i = 0; i < ranking.order.length; i += 1) {
    const end = ranking.cumulative[i];
    const overlap = Math.min(end, to) - Math.max(start, from);
    if (overlap > 0) classWeight[ranking.order[i]] = Math.min(1, overlap / (end - start));
    start = end;
  }
  void sizes;
  const weights = new Float32Array(PLO_COMBO_COUNT);
  for (let i = 0; i < PLO_COMBO_COUNT; i += 1) weights[i] = classWeight[classOf[i]];
  return weights;
}
var PLO_SPOTS = [
  { id: "btn-bb", label: "BTN opens, BB calls", seats: ["BB", "BTN"], pot: 7.5, stack: 96.5, bands: [[0.06, 0.4], [0, 0.45]] },
  { id: "co-bb", label: "CO opens, BB calls", seats: ["BB", "CO"], pot: 7.5, stack: 96.5, bands: [[0.06, 0.34], [0, 0.3]] },
  { id: "utg-bb", label: "UTG opens, BB calls", seats: ["BB", "UTG"], pot: 7.5, stack: 96.5, bands: [[0.05, 0.26], [0, 0.17]] },
  { id: "bb-btn-3bet", label: "BB 3-bets, BTN calls", seats: ["BB", "BTN"], pot: 22.5, stack: 89, bands: [[0, 0.06], [0.03, 0.2]] }
];

// src/lib/poker-plo/library.ts
var PLO_RECORD_VERSION = 1;
var PLO_LIBRARY_SPOTS = [
  { id: "bb-btn-3bet", sizes: { bet: [1], raise: [1] }, maxBets: 3 }
];
function librarySpot(spotIndex, board, ranking, compact = true) {
  const library = PLO_LIBRARY_SPOTS[spotIndex];
  const preset = PLO_SPOTS.find((spot) => spot.id === library.id);
  if (!preset) throw new Error(`Unknown spot ${library.id}`);
  return {
    board,
    pot: preset.pot,
    stack: preset.stack,
    ranges: [bandRange(ranking, preset.bands[0][0], preset.bands[0][1]), bandRange(ranking, preset.bands[1][0], preset.bands[1][1])],
    sizes: { bet: [...library.sizes.bet], raise: [...library.sizes.raise] },
    maxBets: library.maxBets,
    compact
  };
}
function flopNodes(game) {
  return game.decisionNodes.filter((node) => node.street === 0);
}
function ploHandChecksum(game) {
  let hash = 2166136261;
  const mix = (byte) => {
    hash ^= byte & 255;
    hash = Math.imul(hash, 16777619) >>> 0;
  };
  for (const set of game.hands) {
    for (let h = 0; h < set.count; h += 1) {
      const c = set.combo[h];
      mix(c);
      mix(c >>> 8);
      mix(c >>> 16);
      mix(Math.round(set.weight[h] * 255));
    }
  }
  return hash;
}
function encodePloFlopRecord(game, record) {
  const nodes = flopNodes(game);
  if (nodes.length !== record.strategies.length) throw new Error("One strategy per flop node is needed.");
  let size = 4 + 1 + 1 + 3 + 2 + 4 * 3 + 4 * 3 + 2;
  nodes.forEach((node) => {
    size += 1 + (node.actions.length - 1) * game.hands[node.player].count;
  });
  const bytes = new Uint8Array(size);
  const view = new DataView(bytes.buffer);
  let at = 0;
  for (const ch of "PLOF") bytes[at++] = ch.charCodeAt(0);
  bytes[at++] = PLO_RECORD_VERSION;
  bytes[at++] = record.spot;
  for (const card of record.board) bytes[at++] = card;
  view.setUint16(at, Math.min(65535, record.iterations), true);
  at += 2;
  view.setFloat32(at, record.exploitability, true);
  at += 4;
  view.setFloat32(at, record.ev[0], true);
  at += 4;
  view.setFloat32(at, record.ev[1], true);
  at += 4;
  view.setUint32(at, game.hands[0].count, true);
  at += 4;
  view.setUint32(at, game.hands[1].count, true);
  at += 4;
  view.setUint32(at, ploHandChecksum(game), true);
  at += 4;
  view.setUint16(at, nodes.length, true);
  at += 2;
  nodes.forEach((node, i) => {
    const n = game.hands[node.player].count;
    const k = node.actions.length;
    bytes[at++] = k;
    const s = record.strategies[i];
    for (let a = 0; a < k - 1; a += 1) for (let h = 0; h < n; h += 1) bytes[at++] = Math.max(0, Math.min(255, Math.round(s[a * n + h] * 255)));
  });
  return bytes;
}

// src/lib/wasm/plo-terminals.wasm.base64.ts
var PLO_TERMINALS_WASM_BASE64 = "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";

// src/lib/poker-plo/kernel.ts
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
function terminalsModule() {
  if (compiled !== void 0) return compiled;
  try {
    compiled = typeof WebAssembly === "undefined" ? null : new WebAssembly.Module(decodeBase64(PLO_TERMINALS_WASM_BASE64));
  } catch {
    compiled = null;
  }
  return compiled;
}
var SUMS_BYTES = (52 + 2704 + 22100) * 8;
var PloTerminalKernel = class _PloTerminalKernel {
  constructor(module, hands) {
    /** The board whose showdown order each player's slot holds now. */
    this.placedBoard = [null, null];
    let at = 1024;
    const take = (bytes) => {
      const p = at;
      at += bytes + 15 & ~15;
      return p;
    };
    const layout = hands.map((set) => ({
      count: set.count,
      cards: take(set.count * 4),
      pairs: take(set.count * 24),
      triples: take(set.count * 16),
      twin: take(set.count * 4),
      order: take(set.count * 4),
      values: take(set.count * 2)
    }));
    const most = Math.max(hands[0].count, hands[1].count);
    this.reach = take(most * 8);
    this.out = take(most * 8);
    this.sums = take(SUMS_BYTES);
    this.memory = new WebAssembly.Memory({ initial: Math.ceil(at / 65536) + 1 });
    const instance = new WebAssembly.Instance(module, { env: { memory: this.memory, abort: () => {
      throw new Error("PLO terminal kernel aborted");
    } } });
    this.exports = instance.exports;
    this.sets = layout;
    const buffer = this.memory.buffer;
    hands.forEach((set, p) => {
      const place = layout[p];
      new Uint8Array(buffer, place.cards, set.count * 4).set(set.cards);
      new Int32Array(buffer, place.pairs, set.count * 6).set(set.pairs);
      new Int32Array(buffer, place.triples, set.count * 4).set(set.triples);
      new Int32Array(buffer, place.twin, set.count).set(set.twin);
    });
  }
  /** Null when WebAssembly is unavailable or disabled. */
  static create(hands) {
    if (globalThis.__PLO_DISABLE_WASM__) return null;
    const module = terminalsModule();
    if (!module) return null;
    try {
      return new _PloTerminalKernel(module, hands);
    } catch {
      return null;
    }
  }
  loadReach(opp) {
    new Float64Array(this.memory.buffer, this.reach, opp.length).set(opp);
  }
  result(count) {
    return new Float64Array(this.memory.buffer.slice(this.out, this.out + count * 8));
  }
  /** payoff times each hero hand's compatible opposing weight. */
  fold(player, opp, payoff) {
    const hero = this.sets[player], villain = this.sets[1 - player];
    this.loadReach(opp);
    this.exports.fold(villain.count, this.reach, villain.cards, villain.pairs, villain.triples, hero.count, hero.cards, hero.pairs, hero.triples, hero.twin, payoff, this.out, this.sums);
    return this.result(hero.count);
  }
  showdown(board, player, opp, half, swing) {
    const hero = this.sets[player], villain = this.sets[1 - player];
    for (const p of [0, 1]) {
      if (this.placedBoard[p] === board) continue;
      const place = this.sets[p];
      new Int32Array(this.memory.buffer, place.order, board.order[p].length).set(board.order[p]);
      new Uint16Array(this.memory.buffer, place.values, board.values[p].length).set(board.values[p]);
      this.placedBoard[p] = board;
    }
    this.loadReach(opp);
    this.exports.showdown(
      hero.count,
      board.order[player].length,
      hero.order,
      hero.values,
      hero.cards,
      hero.pairs,
      hero.triples,
      hero.twin,
      board.order[1 - player].length,
      villain.order,
      villain.values,
      villain.cards,
      villain.pairs,
      villain.triples,
      this.reach,
      half,
      swing,
      this.out,
      this.sums
    );
    return this.result(hero.count);
  }
};

// src/lib/wasm/plo-cfr.wasm.base64.ts
var PLO_CFR_WASM_BASE64 = "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";

// src/lib/poker-plo/walk-kernel.ts
var NODE_BYTES = 56;
var N_KIND = 0;
var N_PLAYER = 4;
var N_COUNT = 8;
var N_CHILD = 12;
var N_REGRET = 16;
var N_SUM = 20;
var N_A = 24;
var N_B = 28;
var N_C = 32;
var N_D = 36;
var N_F0 = 40;
var N_F1 = 48;
var PAGE = 65536;
var MAX_PAGES = 65536;
var SUMS_BYTES2 = (52 + 2704 + 22100) * 8;
var MODES = { cfr: 0, best: 1, average: 2 };
var compiled2;
function decodeBase642(base64) {
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
function cfrModule() {
  if (compiled2 !== void 0) return compiled2;
  try {
    compiled2 = typeof WebAssembly === "undefined" ? null : new WebAssembly.Module(decodeBase642(PLO_CFR_WASM_BASE64));
  } catch {
    compiled2 = null;
  }
  return compiled2;
}
var PloWalkKernel = class _PloWalkKernel {
  constructor(module, game) {
    this.stack = 0;
    this.stackBytes = 0;
    /** Subtree roots placed so far (uid), with their decision nodes, to read the scales back after a walk. */
    this.entries = /* @__PURE__ */ new Map();
    this.storage = [];
    this.boards = /* @__PURE__ */ new Map();
    this.stackNeed = [/* @__PURE__ */ new Map(), /* @__PURE__ */ new Map()];
    this.game = game;
    this.compact = !!game.spot.compact;
    const { hands, nodes } = game;
    let at = 1024;
    const take = (bytes) => {
      const p = at;
      at += bytes + 15 & ~15;
      return p;
    };
    const placedHands = hands.map((set) => {
      const listLength = set.byCard.reduce((s, l) => s + l.length, 0);
      return {
        cards: take(set.count * 4),
        pairs: take(set.count * 24),
        triples: take(set.count * 16),
        twin: take(set.count * 4),
        start: take(53 * 4),
        list: take(listLength * 4),
        packed: take(set.count * 32)
      };
    });
    const sums = take(SUMS_BYTES2);
    const most = Math.max(hands[0].count, hands[1].count);
    this.io = [take(most * 8), take(most * 8), take(most * 8)];
    this.nodeTable = take(nodes.length * NODE_BYTES);
    let childCount = 0;
    for (const node of nodes) if (node.kind === "decision" || node.kind === "chance") childCount += node.children.length;
    const childTable = take(childCount * 4);
    const chances = nodes.filter((node) => node.kind === "chance");
    const chancePlace = /* @__PURE__ */ new Map();
    const mapPlace = /* @__PURE__ */ new Map();
    for (const node of chances) {
      const k = node.cards.length;
      chancePlace.set(node, { cards: take(k * 4), rep: take(k * 4), slot: take(k * 4), maps: [take(k * 4), take(k * 4)] });
      node.cards.forEach((_, i) => {
        const perm = node.repPerm[i];
        if (node.rep[i] === i || !perm) return;
        for (const p of [0, 1]) {
          const map = game.handMap(perm, p);
          if (!mapPlace.has(map)) mapPlace.set(map, take(map.length * 4));
        }
      });
    }
    this.memory = new WebAssembly.Memory({ initial: Math.ceil(at / PAGE) + 1, maximum: MAX_PAGES });
    const instance = new WebAssembly.Instance(module, { env: { memory: this.memory, abort: () => {
      throw new Error("PLO walk kernel aborted");
    } } });
    this.exports = instance.exports;
    this.at = at;
    this.placedNode = new Uint8Array(nodes.length);
    const buffer = this.memory.buffer;
    const i32 = new Int32Array(buffer);
    const f64 = new Float64Array(buffer);
    hands.forEach((set, p) => {
      const place = placedHands[p];
      new Uint8Array(buffer, place.cards, set.count * 4).set(set.cards);
      new Int32Array(buffer, place.pairs, set.count * 6).set(set.pairs);
      new Int32Array(buffer, place.triples, set.count * 4).set(set.triples);
      new Int32Array(buffer, place.twin, set.count).set(set.twin);
      let offset = 0;
      for (let card = 0; card < 52; card += 1) {
        i32[place.start / 4 + card] = offset;
        i32.set(set.byCard[card], place.list / 4 + offset);
        offset += set.byCard[card].length;
      }
      i32[place.start / 4 + 52] = offset;
      const u16 = new Uint16Array(buffer, place.packed, set.count * 16);
      const twin = new Int32Array(buffer, place.packed, set.count * 8);
      for (let h = 0; h < set.count; h += 1) {
        const o = h * 16;
        for (let c = 0; c < 4; c += 1) u16[o + c] = set.cards[h * 4 + c];
        for (let q = 0; q < 6; q += 1) u16[o + 4 + q] = 52 + set.pairs[h * 6 + q];
        for (let t = 0; t < 4; t += 1) u16[o + 10 + t] = 52 + 2704 + set.triples[h * 4 + t];
        twin[h * 8 + 7] = set.twin[h];
      }
      this.exports.setHands(p, set.count, place.cards, place.pairs, place.triples, place.twin, place.start, place.list, place.packed);
    });
    for (const [map, place] of mapPlace) i32.set(map, place / 4);
    let child = 0;
    nodes.forEach((node, uid) => {
      const rec = this.nodeTable + uid * NODE_BYTES;
      const w = (field, value) => {
        i32[(rec + field) / 4] = value;
      };
      if (node.kind === "decision") {
        w(N_KIND, 0);
        w(N_PLAYER, node.player);
        w(N_COUNT, node.actions.length);
        w(N_CHILD, child);
        node.children.forEach((c, a) => {
          i32[childTable / 4 + child + a] = c.uid;
        });
        child += node.children.length;
      } else if (node.kind === "fold") {
        w(N_KIND, 1);
        w(N_PLAYER, node.folder);
        f64[(rec + N_F0) / 8] = node.invested[0];
        f64[(rec + N_F1) / 8] = node.invested[1];
      } else if (node.kind === "showdown") {
        w(N_KIND, 2);
        f64[(rec + N_F0) / 8] = node.invested;
      } else {
        const place = chancePlace.get(node);
        const k = node.cards.length;
        const slotOf2 = new Int32Array(k).fill(-1);
        let slots = 0;
        for (let i = 0; i < k; i += 1) if (node.rep[i] === i && node.rep.some((r, j) => j !== i && r === i)) slotOf2[i] = slots++;
        for (let i = 0; i < k; i += 1) if (node.rep[i] !== i) slotOf2[i] = slotOf2[node.rep[i]];
        w(N_KIND, 3);
        w(N_PLAYER, slots);
        w(N_COUNT, k);
        w(N_CHILD, child);
        w(N_REGRET, place.slot);
        w(N_A, place.cards);
        w(N_B, place.rep);
        w(N_C, place.maps[0]);
        w(N_D, place.maps[1]);
        f64[(rec + N_F0) / 8] = game.chanceFactor[52 - k];
        i32.set(node.cards, place.cards / 4);
        i32.set(node.rep, place.rep / 4);
        i32.set(slotOf2, place.slot / 4);
        for (let i = 0; i < k; i += 1) {
          const perm = node.repPerm[i];
          for (const p of [0, 1]) i32[place.maps[p] / 4 + i] = node.rep[i] !== i && perm ? mapPlace.get(game.handMap(perm, p)) : 0;
        }
        node.children.forEach((c, a) => {
          i32[childTable / 4 + child + a] = c.uid;
        });
        child += node.children.length;
      }
    });
    this.exports.setup(this.nodeTable, childTable, this.compact ? 1 : 0, game.spot.pot, sums);
  }
  /** Null when WebAssembly is unavailable or disabled. */
  static create(game) {
    if (globalThis.__PLO_DISABLE_WASM__) return null;
    if (globalThis.__PLO_DISABLE_WASM_WALK__) return null;
    const module = cfrModule();
    if (!module) return null;
    try {
      return new _PloWalkKernel(module, game);
    } catch {
      return null;
    }
  }
  /** Children of a node the walk descends into: a chance node's mirrored cards are never walked. */
  walked(node) {
    if (node.kind === "decision") return node.children;
    if (node.kind === "chance") return node.children.filter((_, i) => node.rep[i] === i);
    return [];
  }
  /** Scratch bytes a walk for `player` needs below `node` (the frames of assembly/plo-cfr.ts). */
  need(node, player) {
    const memo = this.stackNeed[player];
    const known = memo.get(node.uid);
    if (known !== void 0) return known;
    const n = this.game.hands[player].count, m = this.game.hands[1 - player].count;
    let frame = 0;
    if (node.kind === "decision") {
      const k = node.actions.length;
      frame = node.player === player ? (2 * k + 1) * n * 8 : (k * m + m + n) * 8;
    } else if (node.kind === "chance") {
      const slots = node.cards.filter((_, i) => node.rep[i] === i && node.rep.some((r, j) => j !== i && r === i)).length;
      frame = (2 * n + m + slots * n) * 8;
    }
    let deepest = 0;
    for (const child of this.walked(node)) deepest = Math.max(deepest, this.need(child, player));
    const total = frame + deepest;
    memo.set(node.uid, total);
    return total;
  }
  /** Places a subtree's storage and showdown orders; false when it would not fit in module memory. */
  prepare(entry) {
    if (this.entries.has(entry.uid)) return this.entries.get(entry.uid) !== null;
    const decisions = [];
    const freshNodes = [];
    const freshBoards = /* @__PURE__ */ new Set();
    const visit = (node) => {
      if (node.kind === "decision") {
        decisions.push(node);
        if (!this.placedNode[node.uid]) freshNodes.push(node);
      } else if (node.kind === "showdown") {
        const ctx = node.board();
        if (!this.boards.has(ctx)) freshBoards.add(ctx);
      }
      for (const child of this.walked(node)) visit(child);
    };
    visit(entry);
    const align = (bytes2) => bytes2 + 15 & ~15;
    const unit = this.compact ? 2 : 4;
    let bytes = 0;
    for (const node of freshNodes) bytes += 2 * align(unit * node.actions.length * this.game.hands[node.player].count);
    for (const ctx of freshBoards) for (const p of [0, 1]) bytes += align(ctx.order[p].length * 4) + align(ctx.values[p].length * 2);
    const stackNeed = Math.max(this.need(entry, 0), this.need(entry, 1));
    const newStack = stackNeed > this.stackBytes ? align(stackNeed) : 0;
    const end = this.at + bytes + newStack;
    const pages = Math.ceil(end / PAGE);
    if (pages > MAX_PAGES) {
      this.entries.set(entry.uid, null);
      return false;
    }
    const have = this.memory.buffer.byteLength / PAGE;
    if (pages > have) {
      try {
        this.memory.grow(pages - have);
      } catch {
        this.entries.set(entry.uid, null);
        return false;
      }
    }
    const take = (size) => {
      const p = this.at;
      this.at += align(size);
      return p;
    };
    const buffer = this.memory.buffer;
    const i32 = new Int32Array(buffer);
    const f64 = new Float64Array(buffer);
    for (const node of freshNodes) {
      const length = node.actions.length * this.game.hands[node.player].count;
      const view = { node, regret: take(unit * length), sum: take(unit * length), length };
      const hadData = node.regret.length === length;
      const oldRegret = node.regret, oldSum = node.strategySum;
      this.bindStorage(view, buffer);
      if (hadData) {
        node.regret.set(oldRegret);
        node.strategySum.set(oldSum);
      } else {
        node.regretScale = 1;
        node.sumScale = 1;
      }
      const rec = this.nodeTable + node.uid * NODE_BYTES;
      i32[(rec + N_REGRET) / 4] = view.regret;
      i32[(rec + N_SUM) / 4] = view.sum;
      f64[(rec + N_F0) / 8] = node.regretScale;
      f64[(rec + N_F1) / 8] = node.sumScale;
      this.placedNode[node.uid] = 1;
      this.storage.push(view);
    }
    for (const ctx of freshBoards) {
      const view = {
        ctx,
        order: [take(ctx.order[0].length * 4), take(ctx.order[1].length * 4)],
        values: [take(ctx.values[0].length * 2), take(ctx.values[1].length * 2)],
        counts: [ctx.order[0].length, ctx.order[1].length]
      };
      const old = { order: ctx.order, values: ctx.values };
      this.bindBoard(view, buffer);
      for (const p of [0, 1]) {
        ctx.order[p].set(old.order[p]);
        ctx.values[p].set(old.values[p]);
      }
      this.boards.set(ctx, view);
    }
    if (newStack) {
      this.stack = take(newStack);
      this.stackBytes = newStack;
    }
    const placeShowdowns = (node) => {
      if (node.kind === "showdown") {
        const view = this.boards.get(node.board());
        const rec = this.nodeTable + node.uid * NODE_BYTES;
        i32[(rec + N_REGRET) / 4] = view.order[0];
        i32[(rec + N_SUM) / 4] = view.values[0];
        i32[(rec + N_A) / 4] = view.counts[0];
        i32[(rec + N_B) / 4] = view.order[1];
        i32[(rec + N_C) / 4] = view.values[1];
        i32[(rec + N_D) / 4] = view.counts[1];
      }
      for (const child of this.walked(node)) placeShowdowns(child);
    };
    placeShowdowns(entry);
    if (pages > have) this.rebind();
    this.entries.set(entry.uid, decisions);
    return true;
  }
  bindStorage(view, buffer) {
    const { node, length } = view;
    if (this.compact) {
      node.regret = new Int16Array(buffer, view.regret, length);
      node.strategySum = new Uint16Array(buffer, view.sum, length);
    } else {
      node.regret = new Float32Array(buffer, view.regret, length);
      node.strategySum = new Float32Array(buffer, view.sum, length);
    }
  }
  bindBoard(view, buffer) {
    view.ctx.order = [new Int32Array(buffer, view.order[0], view.counts[0]), new Int32Array(buffer, view.order[1], view.counts[1])];
    view.ctx.values = [new Uint16Array(buffer, view.values[0], view.counts[0]), new Uint16Array(buffer, view.values[1], view.counts[1])];
  }
  /** After memory grew, every earlier view is detached: point them at the new buffer. */
  rebind() {
    const buffer = this.memory.buffer;
    for (const view of this.storage) this.bindStorage(view, buffer);
    for (const view of this.boards.values()) this.bindBoard(view, buffer);
  }
  /**
   * The walk below `node` (PloSolver.walk without a frontier hook), or null when the subtree does not fit and the
   * caller should walk it in JavaScript.
   */
  walk(node, player, own, opp, step) {
    if (!this.prepare(node)) return null;
    const buffer = this.memory.buffer;
    const [ownAt, oppAt, outAt] = this.io;
    new Float64Array(buffer, ownAt, own.length).set(own);
    new Float64Array(buffer, oppAt, opp.length).set(opp);
    this.exports.run(node.uid, player, MODES[step.mode], step.positive, step.negative, step.strategyDiscount, ownAt, oppAt, outAt, this.stack);
    if (step.mode === "cfr" && this.compact) {
      const f64 = new Float64Array(buffer);
      for (const d of this.entries.get(node.uid)) {
        if (d.player !== player) continue;
        const rec = this.nodeTable + d.uid * NODE_BYTES;
        d.regretScale = f64[(rec + N_F0) / 8];
        d.sumScale = f64[(rec + N_F1) / 8];
      }
    }
    const count = this.game.hands[player].count;
    return new Float64Array(buffer.slice(outAt, outAt + count * 8));
  }
};

// src/lib/poker-plo/solver.ts
var RemovalSums = class {
  constructor() {
    this.total = 0;
    this.card = new Float64Array(52);
    this.pair = new Float64Array(52 * 52);
    this.triple = new Float64Array(TRIPLE_COUNT);
  }
  reset() {
    this.total = 0;
    this.card.fill(0);
    this.pair.fill(0);
    this.triple.fill(0);
  }
  add(set, h, w) {
    this.total += w;
    const c = set.cards, o4 = h * 4, o6 = h * 6;
    this.card[c[o4]] += w;
    this.card[c[o4 + 1]] += w;
    this.card[c[o4 + 2]] += w;
    this.card[c[o4 + 3]] += w;
    const p = set.pairs;
    this.pair[p[o6]] += w;
    this.pair[p[o6 + 1]] += w;
    this.pair[p[o6 + 2]] += w;
    this.pair[p[o6 + 3]] += w;
    this.pair[p[o6 + 4]] += w;
    this.pair[p[o6 + 5]] += w;
    const t = set.triples;
    this.triple[t[o4]] += w;
    this.triple[t[o4 + 1]] += w;
    this.triple[t[o4 + 2]] += w;
    this.triple[t[o4 + 3]] += w;
  }
  /** Added weight of hands sharing no card with hand h of `set`, not counting its identical twin. */
  query(set, h) {
    const c = set.cards, o4 = h * 4, o6 = h * 6, p = set.pairs, t = set.triples;
    return this.total - (this.card[c[o4]] + this.card[c[o4 + 1]] + this.card[c[o4 + 2]] + this.card[c[o4 + 3]]) + (this.pair[p[o6]] + this.pair[p[o6 + 1]] + this.pair[p[o6 + 2]] + this.pair[p[o6 + 3]] + this.pair[p[o6 + 4]] + this.pair[p[o6 + 5]]) - (this.triple[t[o4]] + this.triple[t[o4 + 1]] + this.triple[t[o4 + 2]] + this.triple[t[o4 + 3]]);
  }
};
function exploitabilityOf(br, ev, pot) {
  return { exploitability: (br[0] + br[1] - pot) / 2 / pot, values: [ev[0], ev[1]] };
}
var PloSolver = class {
  constructor(game, options = {}) {
    this.iteration = 0;
    this.sums = new RemovalSums();
    this.compactBuffer = new Float64Array(0);
    this.game = game;
    this.alpha = options.alpha ?? 1.5;
    this.beta = options.beta ?? 0;
    this.gamma = options.gamma ?? 3;
    this.kernel = options.wasm === false ? null : PloTerminalKernel.create(game.hands);
    this.walker = options.wasm === false || options.wasmWalk === false ? null : PloWalkKernel.create(game);
  }
  /** Whether terminals run in WebAssembly. */
  get usesWasm() {
    return this.kernel !== null;
  }
  /** Whether whole walks run in WebAssembly. */
  get usesWasmWalk() {
    return this.walker !== null;
  }
  /** Discount factors of the next iteration. */
  nextStep() {
    const t = this.iteration + 1;
    const ta = Math.pow(t, this.alpha), tb = Math.pow(t, this.beta);
    return { mode: "cfr", positive: ta / (ta + 1), negative: tb / (tb + 1), strategyDiscount: Math.pow(t / (t + 1), this.gamma) };
  }
  /** Runs CFR iterations, updating each player in turn. */
  run(iterations) {
    for (let i = 0; i < iterations; i += 1) {
      const step = this.nextStep();
      this.iteration += 1;
      for (const player of [0, 1]) this.walk(this.game.root, player, this.rootReach(player), this.rootReach(1 - player), step);
    }
  }
  rootReach(player) {
    return Float64Array.from(this.game.hands[player].weight);
  }
  /** Current strategy at a node from regret matching (action-major). */
  currentStrategy(node, out) {
    ensureStorage(this.game, node);
    out ??= new Float64Array(node.regret.length);
    const n = this.game.hands[node.player].count;
    const k = node.actions.length;
    const r = node.regret;
    for (let h = 0; h < n; h += 1) {
      let sum = 0;
      for (let a = 0; a < k; a += 1) {
        const v = r[a * n + h];
        if (v > 0) sum += v;
      }
      if (sum > 0) for (let a = 0; a < k; a += 1) {
        const v = r[a * n + h];
        out[a * n + h] = v > 0 ? v / sum : 0;
      }
      else for (let a = 0; a < k; a += 1) out[a * n + h] = 1 / k;
    }
    return out;
  }
  /** Average strategy at a node (action-major); hands that never reached it play uniformly. */
  averageStrategy(node, out) {
    ensureStorage(this.game, node);
    out ??= new Float64Array(node.strategySum.length);
    const n = this.game.hands[node.player].count;
    const k = node.actions.length;
    const s = node.strategySum;
    for (let h = 0; h < n; h += 1) {
      let sum = 0;
      for (let a = 0; a < k; a += 1) sum += s[a * n + h];
      if (sum > 0) for (let a = 0; a < k; a += 1) out[a * n + h] = s[a * n + h] / sum;
      else for (let a = 0; a < k; a += 1) out[a * n + h] = 1 / k;
    }
    return out;
  }
  /**
   * Counterfactual values of `player`'s hands below `node`. In 'cfr' mode it also updates that player's regrets and
   * average strategy; 'best' plays a best response against the opponent's average strategy; 'average' plays both
   * average strategies. A `frontier` hook may answer for a node instead of descending (split solving), and
   * `dryRun` walks only to collect reaches, skipping terminals and updates.
   */
  walk(node, player, own, opp, step) {
    const hero = this.game.hands[player];
    if (step.frontier) {
      const answer = step.frontier(node, own, opp);
      if (answer) return answer;
    } else if (this.walker && !step.dryRun) {
      const values2 = this.walker.walk(node, player, own, opp, step);
      if (values2) return values2;
    }
    if (node.kind === "fold" || node.kind === "showdown") return step.dryRun ? new Float64Array(hero.count) : this.terminal(node, player, opp);
    if (node.kind === "chance") return this.chance(node, player, own, opp, step, null);
    const k = node.actions.length;
    const mode = step.mode;
    if (node.player === player) {
      const n = hero.count;
      const sigma2 = mode === "cfr" ? this.currentStrategy(node) : mode === "average" ? this.averageStrategy(node) : null;
      const values2 = new Float64Array(n);
      if (!sigma2) values2.fill(-Infinity);
      const actionValues = [];
      for (let a = 0; a < k; a += 1) {
        let reach = own;
        if (sigma2) {
          reach = new Float64Array(n);
          for (let h = 0; h < n; h += 1) reach[h] = own[h] * sigma2[a * n + h];
        }
        const v = this.walk(node.children[a], player, reach, opp, step);
        if (mode === "cfr") actionValues.push(v);
        if (sigma2) for (let h = 0; h < n; h += 1) values2[h] += sigma2[a * n + h] * v[h];
        else for (let h = 0; h < n; h += 1) if (v[h] > values2[h]) values2[h] = v[h];
      }
      if (mode === "cfr" && !step.dryRun && node.regret instanceof Int16Array) {
        this.updateCompact(node, n, actionValues, values2, own, sigma2, step);
      } else if (mode === "cfr" && !step.dryRun) {
        const r = node.regret, s = node.strategySum;
        const { positive, negative, strategyDiscount } = step;
        for (let a = 0; a < k; a += 1) {
          const v = actionValues[a];
          for (let h = 0; h < n; h += 1) {
            const i = a * n + h;
            const prev = r[i];
            r[i] = prev * (prev > 0 ? positive : negative) + (v[h] - values2[h]);
            s[i] = s[i] * strategyDiscount + own[h] * sigma2[i];
          }
        }
      }
      return values2;
    }
    const m = this.game.hands[node.player].count;
    const sigma = mode === "cfr" ? this.currentStrategy(node) : this.averageStrategy(node);
    const values = new Float64Array(hero.count);
    for (let a = 0; a < k; a += 1) {
      const reach = new Float64Array(m);
      let any = false;
      for (let h = 0; h < m; h += 1) {
        reach[h] = opp[h] * sigma[a * m + h];
        if (reach[h] > 0) any = true;
      }
      if (!any) continue;
      const v = this.walk(node.children[a], player, own, reach, step);
      for (let h = 0; h < hero.count; h += 1) values[h] += v[h];
    }
    return values;
  }
  /**
   * The DCFR update in 16-bit storage: rebuild each value in chips, discount and add as usual, then requantize the
   * node with a fresh scale (largest magnitude maps to the top code) and round to nearest.
   */
  updateCompact(node, n, actionValues, values, own, sigma, step) {
    const r = node.regret, s = node.strategySum;
    const size = r.length;
    let buffer = this.compactBuffer;
    if (buffer.length < size) buffer = this.compactBuffer = new Float64Array(size);
    const { positive, negative, strategyDiscount } = step;
    const rs = node.regretScale;
    let peak = 0;
    for (let a = 0; a < actionValues.length; a += 1) {
      const v = actionValues[a];
      for (let h = 0; h < n; h += 1) {
        const i = a * n + h;
        const prev = r[i] * rs;
        const next = prev * (prev > 0 ? positive : negative) + (v[h] - values[h]);
        buffer[i] = next;
        const m = next < 0 ? -next : next;
        if (m > peak) peak = m;
      }
    }
    const rScale = peak > 0 ? peak / 32767 : 1;
    const rInverse = 1 / rScale;
    for (let i = 0; i < size; i += 1) r[i] = Math.round(buffer[i] * rInverse);
    node.regretScale = rScale;
    const ss = node.sumScale * strategyDiscount;
    peak = 0;
    for (let i = 0; i < size; i += 1) {
      const next = s[i] * ss + own[i % n] * sigma[i];
      buffer[i] = next;
      if (next > peak) peak = next;
    }
    const sScale = peak > 0 ? peak / 65535 : 1;
    const sInverse = 1 / sScale;
    for (let i = 0; i < size; i += 1) s[i] = Math.round(buffer[i] * sInverse);
    node.sumScale = sScale;
  }
  /**
   * Averages a chance node's children; hands holding the dealt card are removed from both sides. A card that mirrors
   * another by suit symmetry reuses the canonical card's values with hands relabeled, as long as the canonical card
   * is in the same subset (split solving keeps them together); otherwise it is walked like any card.
   */
  chance(node, player, own, opp, step, subset) {
    const hero = this.game.hands[player];
    const villain = this.game.hands[1 - player];
    const values = new Float64Array(hero.count);
    const boardSize = 52 - node.cards.length;
    const factor = this.game.chanceFactor[boardSize];
    const indices = subset ?? node.cards.map((_, i) => i);
    const included = new Set(indices);
    const mirrored = indices.filter((i) => node.rep[i] !== i && included.has(node.rep[i]));
    const needed = new Set(mirrored.map((i) => node.rep[i]));
    const kept = /* @__PURE__ */ new Map();
    for (const i of indices) {
      if (node.rep[i] !== i && included.has(node.rep[i])) continue;
      const card = node.cards[i];
      const o = Float64Array.from(own);
      for (const h of hero.byCard[card]) o[h] = 0;
      const p = Float64Array.from(opp);
      for (const h of villain.byCard[card]) p[h] = 0;
      const v = this.walk(node.children[i], player, o, p, step);
      for (const h of hero.byCard[card]) v[h] = 0;
      for (let h = 0; h < hero.count; h += 1) values[h] += v[h] * factor;
      if (needed.has(i)) kept.set(i, v);
    }
    for (const i of mirrored) {
      const v = kept.get(node.rep[i]);
      const map = this.game.handMap(node.repPerm[i], player);
      for (let h = 0; h < hero.count; h += 1) values[h] += v[map[h]] * factor;
    }
    return values;
  }
  /** Counterfactual value of every hero hand at a fold or showdown, given the opponent's reach. */
  terminal(node, player, opp, foldPayoff) {
    const hero = this.game.hands[player];
    const villain = this.game.hands[1 - player];
    const values = new Float64Array(hero.count);
    const sums = this.sums;
    const pot = this.game.spot.pot;
    if (node.kind === "fold" && this.kernel) {
      return this.kernel.fold(player, opp, foldPayoff ?? (node.folder === player ? -node.invested[player] : pot + node.invested[1 - player]));
    }
    if (node.kind === "fold") {
      sums.reset();
      for (let o = 0; o < villain.count; o += 1) if (opp[o] > 0) sums.add(villain, o, opp[o]);
      const payoff = foldPayoff ?? (node.folder === player ? -node.invested[player] : pot + node.invested[1 - player]);
      for (let h = 0; h < hero.count; h += 1) {
        const twin = hero.twin[h];
        values[h] = payoff * (sums.query(hero, h) + (twin >= 0 ? opp[twin] : 0));
      }
      return values;
    }
    return this.showdown(node.board(), node.invested, player, opp);
  }
  /**
   * Showdown values in one ascending sweep. For each hero hand: `below` is the compatible opposing weight with a lower
   * value, `upTo` the weight with a lower or equal value, `total` all compatible weight. Win pays pot + invested,
   * a loss costs invested and a tie returns half the pot, which is pot/2 * total + (pot/2 + invested) * (below + upTo - total).
   */
  /** Per hand: opposing weight won against plus half the weight tied with, on a complete board. */
  equityWeights(board, player, opp) {
    return this.showdown(board, 0, player, opp, 0.5, 0.5);
  }
  /** Per hand: total opposing weight that shares no card with it. */
  compatibleWeight(player, opp) {
    return this.terminal({ kind: "fold", uid: -1, folder: 1 - player, invested: [0, 0] }, player, opp, 1);
  }
  showdown(board, invested, player, opp, halfPot, swingPot) {
    if (this.kernel) {
      const half2 = halfPot ?? this.game.spot.pot / 2;
      return this.kernel.showdown(board, player, opp, half2, swingPot ?? half2 + invested);
    }
    const hero = this.game.hands[player];
    const villain = this.game.hands[1 - player];
    const values = new Float64Array(hero.count);
    const heroOrder = board.order[player], heroValues = board.values[player];
    const oppOrder = board.order[1 - player], oppValues = board.values[1 - player];
    const sums = this.sums;
    sums.reset();
    const card = sums.card, pair = sums.pair, triple = sums.triple;
    const vc = villain.cards, vp = villain.pairs, vt = villain.triples;
    const hc = hero.cards, hp = hero.pairs, ht = hero.triples, twins = hero.twin;
    let total = 0;
    const add = (o, w) => {
      total += w;
      const o4 = o * 4, o6 = o * 6;
      card[vc[o4]] += w;
      card[vc[o4 + 1]] += w;
      card[vc[o4 + 2]] += w;
      card[vc[o4 + 3]] += w;
      pair[vp[o6]] += w;
      pair[vp[o6 + 1]] += w;
      pair[vp[o6 + 2]] += w;
      pair[vp[o6 + 3]] += w;
      pair[vp[o6 + 4]] += w;
      pair[vp[o6 + 5]] += w;
      triple[vt[o4]] += w;
      triple[vt[o4 + 1]] += w;
      triple[vt[o4 + 2]] += w;
      triple[vt[o4 + 3]] += w;
    };
    const query = (h) => {
      const o4 = h * 4, o6 = h * 6;
      return total - (card[hc[o4]] + card[hc[o4 + 1]] + card[hc[o4 + 2]] + card[hc[o4 + 3]]) + (pair[hp[o6]] + pair[hp[o6 + 1]] + pair[hp[o6 + 2]] + pair[hp[o6 + 3]] + pair[hp[o6 + 4]] + pair[hp[o6 + 5]]) - (triple[ht[o4]] + triple[ht[o4 + 1]] + triple[ht[o4 + 2]] + triple[ht[o4 + 3]]);
    };
    const half = halfPot ?? this.game.spot.pot / 2;
    const swing = swingPot ?? half + invested;
    let i = 0, j = 0;
    const heroCount = heroOrder.length, oppCount = oppOrder.length;
    while (i < heroCount) {
      const v = heroValues[i];
      while (j < oppCount && oppValues[j] < v) {
        const o = oppOrder[j];
        const w = opp[o];
        if (w > 0) add(o, w);
        j += 1;
      }
      let end = i;
      while (end < heroCount && heroValues[end] === v) {
        const h = heroOrder[end];
        values[h] = query(h);
        end += 1;
      }
      let tied = false;
      while (j < oppCount && oppValues[j] === v) {
        const o = oppOrder[j];
        const w = opp[o];
        if (w > 0) {
          add(o, w);
          tied = true;
        }
        j += 1;
      }
      for (let x = i; x < end; x += 1) {
        const h = heroOrder[x];
        if (!tied) {
          values[h] *= 2;
          continue;
        }
        const twin = twins[h];
        values[h] += query(h) + (twin >= 0 ? opp[twin] : 0);
      }
      i = end;
    }
    while (j < oppCount) {
      const o = oppOrder[j];
      const w = opp[o];
      if (w > 0) add(o, w);
      j += 1;
    }
    for (let x = 0; x < heroCount; x += 1) {
      const h = heroOrder[x];
      const twin = twins[h];
      const all = query(h) + (twin >= 0 ? opp[twin] : 0);
      values[h] = half * all + swing * (values[h] - all);
    }
    return values;
  }
  /**
   * Best-response value of `player` against the opponent's average strategy, per hand, weighted by the
   * opponent's range. `evaluate` replaces the max with the player's own average strategy (expected values).
   */
  bestResponseValues(player, mode = "best") {
    return this.walk(this.game.root, player, this.rootReach(player), this.rootReach(1 - player), { mode, positive: 1, negative: 1, strategyDiscount: 1 });
  }
  /** Range-weighted average of per-hand values, per compatible deal. */
  average(player, values, norm = this.pairWeight()) {
    const w = this.game.hands[player].weight;
    let sum = 0;
    for (let h = 0; h < values.length; h += 1) sum += w[h] * values[h];
    return sum / norm;
  }
  /** Total weight of compatible hand pairs: the normalizer that turns summed values into per-deal averages. */
  pairWeight() {
    const [a, b] = this.game.hands;
    const sums = this.sums;
    sums.reset();
    for (let o = 0; o < b.count; o += 1) sums.add(b, o, b.weight[o]);
    let total = 0;
    for (let h = 0; h < a.count; h += 1) {
      const twin = a.twin[h];
      total += a.weight[h] * (sums.query(a, h) + (twin >= 0 ? b.weight[twin] : 0));
    }
    return total;
  }
  /**
   * Exploitability as a share of the starting pot: how much the two best responses gain together over the game's
   * value, halved. Zero exactly at a Nash equilibrium.
   */
  exploitability() {
    const norm = this.pairWeight();
    const br = [0, 1].map((p) => this.average(p, this.bestResponseValues(p, "best"), norm));
    const ev = [0, 1].map((p) => this.average(p, this.bestResponseValues(p, "average"), norm));
    return exploitabilityOf(br, ev, this.game.spot.pot);
  }
};

// src/lib/poker-plo/split.ts
function planFrontier(game, shardCount) {
  const plan = /* @__PURE__ */ new Map();
  if (game.spot.board.length < 5) {
    const visit2 = (node) => {
      if (node.kind === "chance") {
        const subsets = Array.from({ length: shardCount }, () => []);
        const shardOf = /* @__PURE__ */ new Map();
        let next = 0;
        node.cards.forEach((_, i) => {
          const rep = node.rep[i];
          const shard = rep === i ? next++ % shardCount : shardOf.get(rep);
          shardOf.set(i, shard);
          subsets[shard].push(i);
        });
        const parts = [];
        subsets.forEach((subset, shard) => {
          if (subset.length) parts.push({ shard, subset });
        });
        plan.set(node.uid, parts);
      } else if (node.kind === "decision") node.children.forEach(visit2);
    };
    visit2(game.root);
    return plan;
  }
  const frontier = [];
  const size = (node) => node.kind === "decision" ? 1 + node.children.reduce((sum, child) => sum + size(child), 0) : 1;
  const visit = (node, depth) => {
    if (node.kind !== "decision") return;
    if (depth === 2) {
      frontier.push({ uid: node.uid, size: size(node) });
      return;
    }
    node.children.forEach((child) => visit(child, depth + 1));
  };
  visit(game.root, 0);
  frontier.sort((a, b) => b.size - a.size);
  const load = new Array(shardCount).fill(0);
  for (const item of frontier) {
    let shard = 0;
    for (let w = 1; w < shardCount; w += 1) if (load[w] < load[shard]) shard = w;
    load[shard] += item.size;
    plan.set(item.uid, [{ shard, subset: null }]);
  }
  return plan;
}
function ownerMap(game, plan) {
  const owner = /* @__PURE__ */ new Map();
  const mark = (node, shard) => {
    owner.set(node.uid, shard);
    if (node.kind === "decision" || node.kind === "chance") node.children.forEach((child) => mark(child, shard));
  };
  for (const [uid, parts] of plan) {
    const node = game.nodes[uid];
    for (const part of parts) {
      if (part.subset && node.kind === "chance") part.subset.forEach((i) => mark(node.children[i], part.shard));
      else mark(node, part.shard);
    }
  }
  return owner;
}
var PloShardEngine = class {
  constructor(spot) {
    this.solver = new PloSolver(buildPloGame(spot));
  }
  evaluate(call) {
    const { player, step, requests } = call;
    return requests.map(({ uid, subset, own, opp }) => {
      const node = this.solver.game.nodes[uid];
      if (subset && node.kind === "chance") return this.solver.chance(node, player, own, opp, step, subset);
      return this.solver.walk(node, player, own, opp, step);
    });
  }
};
var PloSplitSolver = class {
  constructor(spot, shards) {
    this.solver = new PloSolver(buildPloGame(spot));
    this.shards = shards;
    this.plan = planFrontier(this.solver.game, shards.length);
    this.owner = ownerMap(this.solver.game, this.plan);
  }
  get game() {
    return this.solver.game;
  }
  get iteration() {
    return this.solver.iteration;
  }
  async run(iterations) {
    for (let i = 0; i < iterations; i += 1) {
      const step = this.solver.nextStep();
      for (const player of [0, 1]) await this.walk(player, step);
      this.solver.iteration += 1;
    }
  }
  /**
   * One walk for `player` across coordinator and shards, from the root or from any node with given reaches; returns
   * the values of the player's hands there.
   */
  async walk(player, step, start) {
    const solver = this.solver;
    const opponent = 1 - player;
    const root = start?.node ?? solver.game.root;
    const own = start?.own ?? solver.rootReach(player);
    const opp = start?.opp ?? solver.rootReach(opponent);
    const shard = this.owner.get(root.uid);
    if (shard !== void 0) {
      const [values] = await this.shards[shard].evaluate({ player, step, requests: [{ uid: root.uid, subset: null, own, opp }] });
      return values;
    }
    const requests = this.shards.map(() => []);
    const slots = /* @__PURE__ */ new Map();
    const zero = new Float64Array(solver.game.hands[player].count);
    solver.walk(root, player, own, opp, {
      ...step,
      dryRun: true,
      frontier: (node, own2, opp2) => {
        const parts = this.plan.get(node.uid);
        if (!parts) return null;
        slots.set(node.uid, parts.map((part) => {
          requests[part.shard].push({ uid: node.uid, subset: part.subset, own: own2, opp: opp2 });
          return { shard: part.shard, index: requests[part.shard].length - 1 };
        }));
        return zero;
      }
    });
    const results = await Promise.all(this.shards.map((shard2, w) => requests[w].length ? shard2.evaluate({ player, step, requests: requests[w] }) : Promise.resolve([])));
    return solver.walk(root, player, own, opp, {
      ...step,
      frontier: (node) => {
        const parts = slots.get(node.uid);
        if (!parts) return null;
        if (parts.length === 1) return results[parts[0].shard][parts[0].index];
        const sum = new Float64Array(zero.length);
        for (const { shard: shard2, index } of parts) {
          const part = results[shard2][index];
          for (let h = 0; h < sum.length; h += 1) sum[h] += part[h];
        }
        return sum;
      }
    });
  }
  async exploitability() {
    const solver = this.solver;
    const norm = solver.pairWeight();
    const values = async (mode) => {
      const out = [];
      for (const p of [0, 1]) out.push(solver.average(p, await this.walk(p, { mode, positive: 1, negative: 1, strategyDiscount: 1 }), norm));
      return out;
    };
    const br = await values("best");
    const ev = await values("average");
    return exploitabilityOf(br, ev, solver.game.spot.pot);
  }
};

// scripts/poker/plo/solve-flops.ts
if (process.env.PLO_DISABLE_WASM_WALK === "1") globalThis.__PLO_DISABLE_WASM_WALK__ = true;
var ThreadShard = class {
  constructor(spot) {
    this.next = 0;
    this.waiting = /* @__PURE__ */ new Map();
    this.worker = new Worker(fileURLToPath(import.meta.url), { workerData: { spot } });
    this.worker.on("message", ({ id, values }) => {
      const done = this.waiting.get(id);
      this.waiting.delete(id);
      done?.(values);
    });
    this.worker.on("error", (error) => {
      console.error("shard failed", error);
      process.exit(1);
    });
  }
  evaluate(call) {
    const id = this.next++;
    return new Promise((resolve) => {
      this.waiting.set(id, resolve);
      this.worker.postMessage({ id, call });
    });
  }
  close() {
    return this.worker.terminate();
  }
};
var flopName = (board) => board.map(cardToString).join("");
var gb = (bytes) => (bytes / 1e9).toFixed(2);
async function main() {
  const args = /* @__PURE__ */ new Map();
  const argv = process.argv.slice(2).filter((a) => a !== "--");
  for (let i = 0; i < argv.length; i += 2) args.set(argv[i].replace(/^--/, ""), argv[i + 1]);
  const spotIndex = Number(args.get("spot") ?? 0);
  const out = join(args.get("out") ?? "plo-library", PLO_LIBRARY_SPOTS[spotIndex].id);
  const workers = Number(args.get("workers") ?? Math.min(8, cpus().length));
  const target = Number(args.get("target") ?? 0.3) / 100;
  const maxIterations = Number(args.get("max") ?? 400);
  const processStart = performance.now();
  const deadline = args.has("deadline") ? Number(args.get("deadline")) * 1e3 : Infinity;
  const keep = Number(args.get("keep") ?? 1) / 100;
  const left = () => deadline - (performance.now() - processStart);
  const rankingPath = args.get("ranking") ?? join(dirname(fileURLToPath(import.meta.url)), "plo-rankings.json");
  const ranking = buildRanking(JSON.parse(readFileSync(existsSync(rankingPath) ? rankingPath : "public/data/poker/plo-rankings.json", "utf8")));
  let flops = canonicalFlops();
  const only = args.get("only");
  if (only) flops = only.split(",").map((text) => canonicalize(parseCards(text)).cards);
  const part = args.get("part");
  if (part) {
    const [k, n] = part.split("/").map(Number);
    flops = flops.filter((_, i) => i % n === k - 1);
  }
  mkdirSync(out, { recursive: true });
  console.log(`${flops.length} flops, ${workers} workers, target ${(target * 100).toFixed(2)}% of the pot, into ${out}`);
  for (const board of flops) {
    const name = flopName(board);
    const file = join(out, `${name}.plo`);
    if (existsSync(file)) continue;
    const skipUrl = args.get("skip-url");
    if (skipUrl) {
      const head = await fetch(`${skipUrl}/${PLO_LIBRARY_SPOTS[spotIndex].id}/${name}.plo`, { method: "HEAD" }).catch(() => null);
      if (head?.ok) {
        console.log(`${name}: already uploaded`);
        continue;
      }
    }
    const spot = librarySpot(spotIndex, board, ranking);
    const started = performance.now();
    const shards = Array.from({ length: workers }, () => new ThreadShard(spot));
    const split = new PloSplitSolver(spot, shards);
    console.log(`${name}: ${split.game.hands[0].count} vs ${split.game.hands[1].count} hands, ${gb(estimateMemory(split.game, true))} GB of storage`);
    let exploit = Infinity;
    let ev = [0, 0];
    let nextCheck = 20;
    let iterationMs = 0;
    let checkMs = 0;
    let checked = -1;
    let cutOff = false;
    while (split.iteration < maxIterations) {
      if (left() < iterationMs + 2 * Math.max(checkMs, 2 * iterationMs) + 6e4) {
        cutOff = true;
        break;
      }
      const begin = performance.now();
      await split.run(1);
      const took = performance.now() - begin;
      iterationMs = Math.max(iterationMs * 0.8, took);
      if (args.has("verbose")) console.log(`${name}: iteration ${split.iteration} took ${(took / 1e3).toFixed(1)} s`);
      if (split.iteration < nextCheck && split.iteration < maxIterations) continue;
      const checkBegin = performance.now();
      const result = await split.exploitability();
      exploit = result.exploitability;
      ev = result.values;
      checkMs = performance.now() - checkBegin;
      checked = split.iteration;
      const seconds = (performance.now() - started) / 1e3;
      console.log(`${name}: iteration ${split.iteration}, exploitability ${(exploit * 100).toFixed(3)}%, ${seconds.toFixed(0)} s, rss ${gb(process.memoryUsage().rss)} GB`);
      if (exploit <= target) break;
      nextCheck = split.iteration + Math.max(10, Math.round(split.iteration * 0.25));
    }
    if (cutOff) {
      if (split.iteration > 0 && checked !== split.iteration) {
        const result = await split.exploitability();
        exploit = result.exploitability;
        ev = result.values;
      }
      if (!(exploit <= keep)) {
        console.log(`${name}: out of time at iteration ${split.iteration}, ${(exploit * 100).toFixed(3)}% is above ${(keep * 100).toFixed(2)}%, not kept`);
        await Promise.all(shards.map((shard) => shard.close()));
        break;
      }
      console.log(`${name}: out of time at iteration ${split.iteration}, keeping it at ${(exploit * 100).toFixed(3)}%`);
    }
    const strategies = flopNodes(split.game).map((node) => split.solver.averageStrategy(node).slice());
    const record = encodePloFlopRecord(split.game, {
      spot: spotIndex,
      board,
      iterations: split.iteration,
      exploitability: exploit,
      ev,
      strategies: strategies.map((s) => Float32Array.from(s))
    });
    const compressed = brotliCompressSync(record, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } });
    writeFileSync(`${file}.tmp`, compressed);
    renameSync(`${file}.tmp`, file);
    await Promise.all(shards.map((shard) => shard.close()));
    console.log(`${name}: done, ${(exploit * 100).toFixed(3)}% after ${split.iteration} iterations in ${((performance.now() - started) / 1e3).toFixed(0)} s, ${(compressed.length / 1024).toFixed(0)} KB`);
    if (cutOff) break;
  }
  process.exit(0);
}
if (!isMainThread) {
  const engine = new PloShardEngine(workerData.spot);
  parentPort.on("message", ({ id, call }) => {
    const values = engine.evaluate(call);
    parentPort.postMessage({ id, values }, values.map((v) => v.buffer));
  });
} else {
  void main();
}
