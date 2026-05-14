export interface KeyMapping {
  code: string;
  key: string;
  vk: number;
  needsShift: boolean;
}

const STATIC_MAP: Record<string, KeyMapping> = {
  ' ':  { code: 'Space', key: ' ', vk: 32, needsShift: false },
  '\n': { code: 'Enter', key: 'Enter', vk: 13, needsShift: false },
  '\t': { code: 'Tab', key: 'Tab', vk: 9, needsShift: false },

  // Shifted digits
  '!': { code: 'Digit1', key: '!', vk: 49, needsShift: true },
  '@': { code: 'Digit2', key: '@', vk: 50, needsShift: true },
  '#': { code: 'Digit3', key: '#', vk: 51, needsShift: true },
  '$': { code: 'Digit4', key: '$', vk: 52, needsShift: true },
  '%': { code: 'Digit5', key: '%', vk: 53, needsShift: true },
  '^': { code: 'Digit6', key: '^', vk: 54, needsShift: true },
  '&': { code: 'Digit7', key: '&', vk: 55, needsShift: true },
  '*': { code: 'Digit8', key: '*', vk: 56, needsShift: true },
  '(': { code: 'Digit9', key: '(', vk: 57, needsShift: true },
  ')': { code: 'Digit0', key: ')', vk: 48, needsShift: true },

  // Punctuation (unshifted)
  '-':  { code: 'Minus', key: '-', vk: 189, needsShift: false },
  '=':  { code: 'Equal', key: '=', vk: 187, needsShift: false },
  '[':  { code: 'BracketLeft', key: '[', vk: 219, needsShift: false },
  ']':  { code: 'BracketRight', key: ']', vk: 221, needsShift: false },
  '\\': { code: 'Backslash', key: '\\', vk: 220, needsShift: false },
  ';':  { code: 'Semicolon', key: ';', vk: 186, needsShift: false },
  "'":  { code: 'Quote', key: "'", vk: 222, needsShift: false },
  ',':  { code: 'Comma', key: ',', vk: 188, needsShift: false },
  '.':  { code: 'Period', key: '.', vk: 190, needsShift: false },
  '/':  { code: 'Slash', key: '/', vk: 191, needsShift: false },
  '`':  { code: 'Backquote', key: '`', vk: 192, needsShift: false },

  // Punctuation (shifted)
  '_': { code: 'Minus', key: '_', vk: 189, needsShift: true },
  '+': { code: 'Equal', key: '+', vk: 187, needsShift: true },
  '{': { code: 'BracketLeft', key: '{', vk: 219, needsShift: true },
  '}': { code: 'BracketRight', key: '}', vk: 221, needsShift: true },
  '|': { code: 'Backslash', key: '|', vk: 220, needsShift: true },
  ':': { code: 'Semicolon', key: ':', vk: 186, needsShift: true },
  '"': { code: 'Quote', key: '"', vk: 222, needsShift: true },
  '<': { code: 'Comma', key: '<', vk: 188, needsShift: true },
  '>': { code: 'Period', key: '>', vk: 190, needsShift: true },
  '?': { code: 'Slash', key: '?', vk: 191, needsShift: true },
  '~': { code: 'Backquote', key: '~', vk: 192, needsShift: true },
};

export function keymapForChar(char: string): KeyMapping | null {
  // a-z
  if (char >= 'a' && char <= 'z') {
    const upper = char.toUpperCase();
    return {
      code: `Key${upper}`,
      key: char,
      vk: upper.charCodeAt(0),
      needsShift: false,
    };
  }

  // A-Z
  if (char >= 'A' && char <= 'Z') {
    return {
      code: `Key${char}`,
      key: char,
      vk: char.charCodeAt(0),
      needsShift: true,
    };
  }

  // 0-9
  if (char >= '0' && char <= '9') {
    return {
      code: `Digit${char}`,
      key: char,
      vk: char.charCodeAt(0),
      needsShift: false,
    };
  }

  // Static map
  const mapping = STATIC_MAP[char];
  if (mapping) return mapping;

  // Non-ASCII or unknown — fallback
  return null;
}
