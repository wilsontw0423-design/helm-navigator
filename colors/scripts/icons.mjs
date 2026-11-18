// Source of the three Helm file icons (16x16 SVG). `node scripts/build-icons.mjs` writes them to icons/.
export const ICONS = {
  // {{ . }}: Go template action, in the color of the {{ }} delimiters.
  'helm-template': {
    dark: '#CF8E6D',
    light: '#A9562A',
    body: (c) =>
      `<g fill="none" stroke="${c}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">` +
      `<path d="M5.5 2.5C4.3 2.5 4 3.2 4 4.4v1.8C4 7.3 3.5 8 2.5 8c1 0 1.5.7 1.5 1.8v1.8c0 1.2.3 1.9 1.5 1.9"/>` +
      `<path d="M10.5 2.5c1.2 0 1.5.7 1.5 1.9v1.8C12 7.3 12.5 8 13.5 8c-1 0-1.5.7-1.5 1.8v1.8c0 1.2-.3 1.9-1.5 1.9"/>` +
      `</g><circle cx="8" cy="8" r="1.25" fill="${c}"/>`,
  },
  // f: helpers (_helpers.tpl) hold `define`s, in the color of template functions.
  'helm-helpers': {
    dark: '#E5C07B',
    light: '#9A7A16',
    body: (c) =>
      `<g fill="none" stroke="${c}" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">` +
      `<path d="M12 3.1c-.6-.4-1.3-.6-2-.5-1.1.2-1.7 1-1.9 2.2L6.6 11.6c-.2 1.2-.9 1.9-2 2-.7 0-1.3-.1-1.8-.5"/>` +
      `<path d="M5.2 6.6h5.6"/></g>`,
  },
  // key: value rows, in the color of YAML keys.
  'helm-values': {
    dark: '#56A8F5',
    light: '#2470C0',
    body: (c) =>
      `<g stroke="${c}" stroke-width="1.8" stroke-linecap="round">` +
      `<path d="M2.5 3.5h2.5M2.5 8h2.5M2.5 12.5h2.5"/>` +
      `<path d="M8 3.5h5.5M8 8h3.5M8 12.5h5" opacity=".7"/></g>`,
  },
};

export const svg = (body) => `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">${body}</svg>\n`;
