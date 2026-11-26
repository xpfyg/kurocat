export type DeskThemeId = 'classic' | 'midnight' | 'sakura' | 'matcha' | 'retro' | 'cyber' | 'ocean';

/** One coordinated keyboard + mouse look. Keys light up with the cat skin accent when pressed. */
export interface DeskTheme {
  id: DeskThemeId;
  name: string;
  emoji: string;
  /** Swatch color shown in pickers. */
  swatch: string;

  caseShadow: string;
  caseFill: string;
  caseStroke: string;
  keybed: string;

  keyTop: string;
  keySide: string;
  modTop: string;
  modSide: string;
  accentTop: string;
  accentSide: string;
  legend: string;
  accentLegend: string;
  /** Optional glow color for the keyboard underglow (cyber/ocean). */
  underglow?: string;

  mouseBase: string;
  mouseShellTop: string;
  mouseShellBottom: string;
  mouseButton: string;
  mouseOutline: string;
  mouseSeam: string;
  mouseWheelHousing: string;
  mouseWheel: string;
  mouseLegend: string;
}

export const DESK_THEMES: DeskTheme[] = [
  {
    id: 'classic',
    name: '经典白',
    emoji: '⌨️',
    swatch: '#f4f4f0',
    caseShadow: '#191a1e',
    caseFill: '#24262c',
    caseStroke: '#363840',
    keybed: '#d4d6d1',
    keyTop: '#f8f8f5',
    keySide: '#d0d2cc',
    modTop: '#efefeb',
    modSide: '#c7c9c3',
    accentTop: '#f4a524',
    accentSide: '#c27a10',
    legend: '#2c2f36',
    accentLegend: '#ffffff',
    mouseBase: '#c8cac4',
    mouseShellTop: '#ecece7',
    mouseShellBottom: '#f4f4f0',
    mouseButton: '#fafaf7',
    mouseOutline: '#2b2d34',
    mouseSeam: 'rgba(42, 45, 52, 0.6)',
    mouseWheelHousing: '#2d2f36',
    mouseWheel: '#6b6f78',
    mouseLegend: 'rgba(72, 76, 86, 0.56)',
  },
  {
    id: 'midnight',
    name: '暗夜黑金',
    emoji: '🌙',
    swatch: '#d9a441',
    caseShadow: '#08090b',
    caseFill: '#111216',
    caseStroke: '#3a3226',
    keybed: '#1b1c21',
    keyTop: '#2c2e36',
    keySide: '#17181d',
    modTop: '#24262d',
    modSide: '#131418',
    accentTop: '#d9a441',
    accentSide: '#94691d',
    legend: '#e8d3a0',
    accentLegend: '#1a1408',
    mouseBase: '#060708',
    mouseShellTop: '#25272e',
    mouseShellBottom: '#1a1b20',
    mouseButton: '#2c2e36',
    mouseOutline: '#a77f34',
    mouseSeam: 'rgba(217, 164, 65, 0.55)',
    mouseWheelHousing: '#0c0d10',
    mouseWheel: '#d9a441',
    mouseLegend: 'rgba(232, 211, 160, 0.62)',
  },
  {
    id: 'sakura',
    name: '樱花粉',
    emoji: '🌸',
    swatch: '#ff9fbd',
    caseShadow: '#c98a9c',
    caseFill: '#f5b8c9',
    caseStroke: '#e597ad',
    keybed: '#fde3ea',
    keyTop: '#fff8fa',
    keySide: '#f1cdd8',
    modTop: '#ffe4ec',
    modSide: '#eebccb',
    accentTop: '#ff8fb1',
    accentSide: '#d8648a',
    legend: '#b4587a',
    accentLegend: '#ffffff',
    mouseBase: '#e9a9bb',
    mouseShellTop: '#ffe9f0',
    mouseShellBottom: '#fff6f9',
    mouseButton: '#fffafc',
    mouseOutline: '#b8607f',
    mouseSeam: 'rgba(184, 96, 127, 0.5)',
    mouseWheelHousing: '#e48aa6',
    mouseWheel: '#ffd0de',
    mouseLegend: 'rgba(180, 88, 122, 0.6)',
  },
  {
    id: 'matcha',
    name: '抹茶拿铁',
    emoji: '🍵',
    swatch: '#8fb573',
    caseShadow: '#33452b',
    caseFill: '#5d7b50',
    caseStroke: '#7a9a6b',
    keybed: '#dfe7d2',
    keyTop: '#f6f2e4',
    keySide: '#d3cbb0',
    modTop: '#c9dbb4',
    modSide: '#9fb68a',
    accentTop: '#8fb573',
    accentSide: '#5e8549',
    legend: '#4a5d3b',
    accentLegend: '#ffffff',
    mouseBase: '#4c6642',
    mouseShellTop: '#eef0df',
    mouseShellBottom: '#f8f6ea',
    mouseButton: '#fbf9ef',
    mouseOutline: '#45593a',
    mouseSeam: 'rgba(69, 89, 58, 0.55)',
    mouseWheelHousing: '#5d7b50',
    mouseWheel: '#b9d39f',
    mouseLegend: 'rgba(74, 93, 59, 0.6)',
  },
  {
    id: 'retro',
    name: '复古米黄',
    emoji: '📼',
    swatch: '#d8cdb3',
    caseShadow: '#7d735f',
    caseFill: '#c4b99f',
    caseStroke: '#a99e85',
    keybed: '#b3a88f',
    keyTop: '#efe7d3',
    keySide: '#c8bda2',
    modTop: '#8f897b',
    modSide: '#6c665a',
    accentTop: '#d9534f',
    accentSide: '#a33a36',
    legend: '#3d3b35',
    accentLegend: '#fff6ea',
    mouseBase: '#a59a80',
    mouseShellTop: '#e4dbc4',
    mouseShellBottom: '#eee6d2',
    mouseButton: '#f2ebda',
    mouseOutline: '#6b6250',
    mouseSeam: 'rgba(107, 98, 80, 0.6)',
    mouseWheelHousing: '#5c574c',
    mouseWheel: '#d9534f',
    mouseLegend: 'rgba(61, 59, 53, 0.6)',
  },
  {
    id: 'cyber',
    name: '赛博霓虹',
    emoji: '🌃',
    swatch: '#ff3fa4',
    caseShadow: '#05060c',
    caseFill: '#0d0f1c',
    caseStroke: '#ff3fa4',
    keybed: '#141833',
    keyTop: '#222849',
    keySide: '#11142a',
    modTop: '#1b2040',
    modSide: '#0e1124',
    accentTop: '#ff3fa4',
    accentSide: '#a91f69',
    legend: '#6cf6ff',
    accentLegend: '#ffffff',
    underglow: 'rgba(108, 246, 255, 0.55)',
    mouseBase: '#05060c',
    mouseShellTop: '#1d2240',
    mouseShellBottom: '#141833',
    mouseButton: '#222849',
    mouseOutline: '#6cf6ff',
    mouseSeam: 'rgba(255, 63, 164, 0.75)',
    mouseWheelHousing: '#05060c',
    mouseWheel: '#ff3fa4',
    mouseLegend: 'rgba(108, 246, 255, 0.75)',
  },
  {
    id: 'ocean',
    name: '海盐汽水',
    emoji: '🌊',
    swatch: '#5fb8e8',
    caseShadow: '#2a5a7a',
    caseFill: '#3f86b4',
    caseStroke: '#6fb0d8',
    keybed: '#d8eef8',
    keyTop: '#f6fcff',
    keySide: '#c6e2ef',
    modTop: '#bfe4f5',
    modSide: '#8cc6e0',
    accentTop: '#ffcf5a',
    accentSide: '#d39e22',
    legend: '#2f6f94',
    accentLegend: '#5a3b00',
    underglow: 'rgba(95, 184, 232, 0.45)',
    mouseBase: '#3a7aa3',
    mouseShellTop: '#e9f6fd',
    mouseShellBottom: '#f6fcff',
    mouseButton: '#fbfeff',
    mouseOutline: '#2f6f94',
    mouseSeam: 'rgba(47, 111, 148, 0.5)',
    mouseWheelHousing: '#3f86b4',
    mouseWheel: '#ffcf5a',
    mouseLegend: 'rgba(47, 111, 148, 0.6)',
  },
];

export function getDeskTheme(id: string | null | undefined): DeskTheme {
  return DESK_THEMES.find((t) => t.id === id) ?? DESK_THEMES[0];
}
