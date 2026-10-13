import { addIcon } from 'obsidian';
import artwork from './assets/wikidiff.svg?raw';

export const PLUGIN_ICON_ID = 'wikidiff';

export function registerPluginIcon() {
  // Obsidian wraps custom icons in a 100-unit viewport. Keep the selected
  // 24-unit SVG untouched and scale its viewport uniformly to fit that wrapper.
  addIcon(PLUGIN_ICON_ID, `<g transform="scale(${100 / 24})">${artwork}</g>`);
}
