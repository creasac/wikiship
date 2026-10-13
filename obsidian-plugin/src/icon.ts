import { addIcon } from 'obsidian';
import artwork from './assets/wikiship.svg?raw';

export const WIKISHIP_ICON_ID = 'wikiship';

export function registerWikiShipIcon() {
  // Obsidian wraps custom icons in a 100-unit viewport. Keep the selected
  // 24-unit SVG untouched and scale its viewport uniformly to fit that wrapper.
  addIcon(WIKISHIP_ICON_ID, `<g transform="scale(${100 / 24})">${artwork}</g>`);
}
