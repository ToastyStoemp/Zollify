import { defineComponent, h } from 'vue';

/**
 * The icon set: a small, fixed selection of Lucide glyphs, inlined so a
 * runtime module can name an icon without shipping any SVG of its own. Every
 * icon is decorative — the text next to it carries the meaning — so it is
 * hidden from assistive technology.
 */
export const ICON_PATHS: Record<string, string> = {
  home: 'M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z',
  'shopping-cart': 'M2 3h2l2.4 12.4a2 2 0 0 0 2 1.6h9.7a2 2 0 0 0 2-1.6L22 7H6M9 21a1 1 0 1 0 0-2 1 1 0 0 0 0 2zm9 0a1 1 0 1 0 0-2 1 1 0 0 0 0 2z',
  clock: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zm0-14v4l3 3',
  banknote: 'M2 7a1 1 0 0 1 1-1h18a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1zm10 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 12h.01M18 12h.01',
  coins: 'M9 14a6 6 0 1 0 0-12 6 6 0 0 0 0 12zm9-3.5a6 6 0 1 1-8.5 8.5M7 6h1v4M16.7 13.7l.7.7-2.8 2.8',
  package: 'm7.5 4.3 9 5.2M21 16V8a2 2 0 0 0-1-1.7l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.7l7 4a2 2 0 0 0 2 0l7-4a2 2 0 0 0 1-1.7zM3.3 7l8.7 5 8.7-5M12 22V12',
  layers: 'm12 2 9 5-9 5-9-5 9-5zM3 12l9 5 9-5M3 17l9 5 9-5',
  tag: 'M12.6 2.6 21.4 11.4a2 2 0 0 1 0 2.8l-7.2 7.2a2 2 0 0 1-2.8 0L2.6 12.6A2 2 0 0 1 2 11.2V4a2 2 0 0 1 2-2h7.2a2 2 0 0 1 1.4.6zM7 7h.01',
  'shopping-bag': 'M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4zM3 6h18M16 10a4 4 0 0 1-8 0',
  calendar: 'M8 2v4M16 2v4M3 10h18M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z',
  globe: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z',
  'file-text': 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M16 13H8M16 17H8M10 9H8',
  'credit-card': 'M2 5h20a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zM1 10h22',
  book: 'M4 19.5A2.5 2.5 0 0 1 6.5 17H20M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z',
  truck: 'M1 3h15v13H1zM16 8h4l3 3v5h-7V8zM5.5 21a2 2 0 1 0 0-4 2 2 0 0 0 0 4zm13 0a2 2 0 1 0 0-4 2 2 0 0 0 0 4z',
  puzzle: 'M19.4 13.5a2 2 0 0 1 0 2.8l-.9.9a1 1 0 0 0 0 1.4 1.5 1.5 0 1 1-2.1 2.1 1 1 0 0 0-1.4 0l-.9.9a2 2 0 0 1-2.8 0L9.5 19.8a1 1 0 0 0-1.4 0 1.5 1.5 0 1 1-2.1-2.1 1 1 0 0 0 0-1.4l-.9-.9a2 2 0 0 1 0-2.8l1.8-1.8a1 1 0 0 0 0-1.4 1.5 1.5 0 1 1 2.1-2.1 1 1 0 0 0 1.4 0l1.8-1.8a2 2 0 0 1 2.8 0l.9.9a1 1 0 0 0 1.4 0 1.5 1.5 0 1 1 2.1 2.1 1 1 0 0 0 0 1.4z',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm7.4-3a7.4 7.4 0 0 0-.1-1l2-1.6-2-3.4-2.4 1a7.5 7.5 0 0 0-1.7-1L14.8 3H9.2l-.4 2.6a7.5 7.5 0 0 0-1.7 1l-2.4-1-2 3.4 2 1.6a7.4 7.4 0 0 0 0 2l-2 1.6 2 3.4 2.4-1a7.5 7.5 0 0 0 1.7 1l.4 2.6h5.6l.4-2.6a7.5 7.5 0 0 0 1.7-1l2.4 1 2-3.4-2-1.6c.1-.3.1-.7.1-1z',
  upload: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12',
  download: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3',
  send: 'm22 2-7 20-4-9-9-4zM22 2 11 13',
  check: 'M20 6 9 17l-5-5',
  'alert-triangle': 'M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0zM12 9v4M12 17h.01',
  hand: 'M18 11V6a2 2 0 0 0-4 0v1M14 10V4a2 2 0 0 0-4 0v2M10 10.5V6a2 2 0 0 0-4 0v8M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.9-5.9-2.4L3 16.3a2 2 0 0 1 2.8-2.8L7 14.5',
  sparkles: 'm12 3 1.9 5.6L19.5 10l-5.6 1.9L12 17.5l-1.9-5.6L4.5 10l5.6-1.9zM5 3v4M19 17v4M3 5h4M17 19h4',
  undo: 'M3 7v6h6M21 17a9 9 0 0 0-15-6.7L3 13',
  x: 'M18 6 6 18M6 6l12 12',
  menu: 'M4 6h16M4 12h16M4 18h16',
  plus: 'M12 5v14M5 12h14',
  'arrow-left': 'm12 19-7-7 7-7M19 12H5',
  'chevron-right': 'm9 18 6-6-6-6',
  'chevron-left': 'm15 18-6-6 6-6',
  'door-open': 'M13 4h3a2 2 0 0 1 2 2v14M2 20h3M13 20h9M10 12v.01M13 4.562v16.157a1 1 0 0 1-1.242.97L5 20V5.562a2 2 0 0 1 1.515-1.94l4-1A2 2 0 0 1 13 4.561z',
  'bar-chart': 'M3 3v18h18M18 17V9M13 17V5M8 17v-3',
  copy: 'M8 8h12v12H8zM16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2',
  'refresh-cw': 'M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8M3 3v5h5M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16M16 16h5v5',
  'arrow-up': 'm5 12 7-7 7 7M12 19V5',
  'arrow-down': 'M12 5v14M19 12l-7 7-7-7',
  'list-ordered': 'M10 6h11M10 12h11M10 18h11M4 6h1v4M4 10h2M6 18H4c0-1 2-2 2-3s-1-1.5-2-1',
  smartphone: 'M7 2h10a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zM12 18h.01',
  zap: 'M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z',
  'chevron-down': 'm6 9 6 6 6-6',
  'chevron-up': 'm18 15-6-6-6 6',
  'external-link': 'M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14 21 3',
  printer: 'M6 9V2h12v7M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2M6 14h12v8H6z',
  scan: 'M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2M7 12h10',
  'trending-up': 'm22 7-8.5 8.5-5-5L2 17M16 7h6v6',
};

/**
 * `<Icon name="tag" />`. Sized by the `size` prop (px), coloured by
 * `currentColor`, so it takes the colour of the text beside it.
 */
export const Icon = defineComponent({
  name: 'ZfyIcon',
  props: {
    name: { type: String, required: true },
    size: { type: Number, default: 18 },
  },
  setup(props) {
    return () =>
      h(
        'svg',
        {
          class: 'zfy-icon',
          viewBox: '0 0 24 24',
          width: props.size,
          height: props.size,
          fill: 'none',
          stroke: 'currentColor',
          'stroke-width': 1.8,
          'stroke-linecap': 'round',
          'stroke-linejoin': 'round',
          'aria-hidden': 'true',
          focusable: 'false',
          style: 'flex:none;vertical-align:-.18em',
        },
        ICON_PATHS[props.name] ? [h('path', { d: ICON_PATHS[props.name] })] : [h('circle', { cx: 12, cy: 12, r: 3 })],
      );
  },
});
