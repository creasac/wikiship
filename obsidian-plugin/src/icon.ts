import { addIcon } from 'obsidian';
import artwork from './assets/wikiship.svg?raw';

export const wikishipIconId = 'wikiship';

export function registerwikishipIcon() {
  // Obsidian wraps custom icons in a 100-unit viewport. Keep the selected
  // 24-unit SVG untouched and scale its viewport uniformly to fit that wrapper.
  addIcon(wikishipIconId, `<g transform="scale(${100 / 24})">${artwork}</g>`);
}
