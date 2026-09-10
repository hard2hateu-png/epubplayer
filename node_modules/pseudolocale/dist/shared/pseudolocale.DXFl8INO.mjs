function escapeRegExp(str) {
  return str.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, "\\$&");
}
function getDelimiterRegExp({
  startDelimiter,
  endDelimiter,
  delimiter
}) {
  const startEscapedDelimiter = escapeRegExp(startDelimiter || delimiter);
  const endEscapedDelimiter = escapeRegExp(endDelimiter || delimiter);
  return new RegExp(`${startEscapedDelimiter}.*?${endEscapedDelimiter}`, "g");
}
function getTokens(str, { startDelimiter, endDelimiter, delimiter }) {
  const delimiterRegExp = getDelimiterRegExp({
    startDelimiter,
    endDelimiter,
    delimiter
  });
  let regexResult;
  const regexResults = [];
  while (regexResult = delimiterRegExp.exec(str)) {
    regexResults.push(regexResult);
  }
  return regexResults;
}

function pad(str, percent) {
  let lengthLeft = Math.floor(str.length * percent / 2);
  let lengthRight = lengthLeft;
  let paddedString = str;
  while (lengthLeft-- > 0) {
    paddedString = ` ${paddedString}`;
  }
  while (lengthRight-- > 0) {
    paddedString = `${paddedString} `;
  }
  return paddedString;
}

const charactersMapping = {
  A: String.fromCharCode(192),
  a: String.fromCharCode(224),
  B: String.fromCharCode(223),
  b: String.fromCharCode(384),
  C: String.fromCharCode(262),
  c: String.fromCharCode(263),
  D: String.fromCharCode(270),
  d: String.fromCharCode(271),
  E: String.fromCharCode(274),
  e: String.fromCharCode(275),
  F: String.fromCharCode(401),
  f: String.fromCharCode(402),
  G: String.fromCharCode(284),
  g: String.fromCharCode(285),
  H: String.fromCharCode(292),
  h: String.fromCharCode(293),
  I: String.fromCharCode(296),
  i: String.fromCharCode(297),
  J: String.fromCharCode(309),
  j: String.fromCharCode(308),
  K: String.fromCharCode(310),
  k: String.fromCharCode(311),
  L: String.fromCharCode(313),
  l: String.fromCharCode(314),
  M: String.fromCharCode(7742),
  m: String.fromCharCode(7743),
  N: String.fromCharCode(323),
  n: String.fromCharCode(324),
  O: String.fromCharCode(332),
  o: String.fromCharCode(333),
  P: String.fromCharCode(420),
  p: String.fromCharCode(421),
  Q: String.fromCharCode(490),
  q: String.fromCharCode(491),
  R: String.fromCharCode(340),
  r: String.fromCharCode(341),
  S: String.fromCharCode(346),
  s: String.fromCharCode(347),
  T: String.fromCharCode(354),
  t: String.fromCharCode(355),
  U: String.fromCharCode(360),
  u: String.fromCharCode(361),
  W: String.fromCharCode(372),
  w: String.fromCharCode(373),
  Y: String.fromCharCode(374),
  y: String.fromCharCode(375),
  Z: String.fromCharCode(377),
  z: String.fromCharCode(378)
};

const defaultOptions = {
  prepend: "[!!",
  append: "!!]",
  delimiter: "%",
  startDelimiter: "",
  endDelimiter: "",
  extend: 0,
  override: void 0
};
function str(str2, customOptions) {
  const {
    startDelimiter,
    endDelimiter,
    delimiter,
    prepend,
    append,
    extend,
    override
  } = { ...defaultOptions, ...customOptions };
  const regexTokens = getTokens(str2, {
    startDelimiter,
    endDelimiter,
    delimiter
  });
  let tokenIdx = 0;
  let result = "";
  while (result.length < str2.length) {
    const token = regexTokens[tokenIdx];
    const resultLength = result.length;
    if (token && token.index === resultLength) {
      result += token[0];
      tokenIdx++;
      continue;
    }
    const character = override || str2[resultLength];
    const convertedCharacter = charactersMapping[character];
    result += convertedCharacter || character;
  }
  return prepend + pad(result, extend) + append;
}

export { str as s };
