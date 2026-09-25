/**
 * packages/shell/renderer/icons.ts
 * Minimal original line-icon set (24x24, stroke based) built with DOM APIs.
 */
const P: Record<string, string> = {
  back: 'M15 5l-7 7 7 7',
  forward: 'M9 5l7 7-7 7',
  reload: 'M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7',
  plus: 'M12 5v14M5 12h14',
  close: 'M6 6l12 12M18 6L6 18',
  shield: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z',
  shieldCheck: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6zM8.5 12l2.5 2.5 4.5-5',
  shieldAlert: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6zM12 8v5M12 16h.01',
  lock: 'M6 11h12v9H6zM8.5 11V8a3.5 3.5 0 0 1 7 0v3',
  key: 'M8 15a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM11.5 12.5L21 3M17 7l2 2M15 9l2 2',
  unlock: 'M6 11h12v9H6zM8.5 11V8a3.5 3.5 0 0 1 6.8-1.2',
  globe: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM3 12h18M12 3c3 3.5 3 14.5 0 18M12 3c-3 3.5-3 14.5 0 18',
  network: 'M4 18h4v-4H4zM16 18h4v-4h-4zM10 8h4V4h-4zM12 8v3M6 14v-3h12v3',
  box: 'M4 7l8-4 8 4v10l-8 4-8-4zM4 7l8 4 8-4M12 11v10',
  volume: 'M4 10v4h4l5 4V6L8 10zM16 9a4 4 0 0 1 0 6M18.5 6.5a8 8 0 0 1 0 11',
  mute: 'M4 10v4h4l5 4V6L8 10zM17 9l5 5M22 9l-5 5',
  download: 'M12 4v11M7 10l5 5 5-5M5 20h14',
  puzzle: 'M9 4h4v3a2 2 0 1 0 4 0V4h3v6h-3a2 2 0 1 0 0 4h3v6h-6v-3a2 2 0 1 0-4 0v3H4v-6h3a2 2 0 1 0 0-4H4V4z',
  refreshCircle: 'M4 12a8 8 0 0 1 14-5.3M20 12a8 8 0 0 1-14 5.3M18 3v4h-4M6 21v-4h4',
  settings: 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM4 12h2M18 12h2M12 4v2M12 18v2M6.3 6.3l1.4 1.4M16.3 16.3l1.4 1.4M6.3 17.7l1.4-1.4M16.3 7.7l1.4-1.4',
  star: 'M12 4l2.5 5 5.5.8-4 3.9.9 5.5-4.9-2.6-4.9 2.6.9-5.5-4-3.9 5.5-.8z',
  bookmark: 'M7 4h10v16l-5-4-5 4z',
  history: 'M4 12a8 8 0 1 0 2.3-5.7M4 4v4h4M12 8v4l3 2',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4',
  user: 'M12 4a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM4 20c1.5-4 4.5-6 8-6s6.5 2 8 6',
  users: 'M9 5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7zM2.5 19c1-3.5 3.5-5 6.5-5s5.5 1.5 6.5 5M16 5.5a3 3 0 0 1 0 6M18 14c2 .7 3.2 2.3 3.8 5',
  split: 'M4 5h16v14H4zM12 5v14',
  pip: 'M3 5h18v14H3zM12 12h7v5h-7z',
  pin: 'M9 4h6l-1 5 3 3H7l3-3zM12 12v8',
  moon: 'M20 14A8 8 0 0 1 10 4a8 8 0 1 0 10 10z',
  activity: 'M3 12h4l3-7 4 14 3-7h4',
  eye: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12zM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z',
  eyeOff: 'M3 3l18 18M10.6 5.1A10 10 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.2 4.2M6.6 6.6C3.8 8.4 2 12 2 12s3.5 7 10 7c1.6 0 3-.4 4.3-1',
  file: 'M6 3h8l4 4v14H6zM14 3v4h4',
  folder: 'M3 6h6l2 2h10v11H3z',
  trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13',
  copy: 'M8 8h12v12H8zM4 16V4h12',
  export: 'M12 15V3M7 8l5-5 5 5M5 21h14',
  import: 'M12 3v12M7 10l5 5 5-5M5 21h14',
  edit: 'M4 20h4L19 9l-4-4L4 16zM13 7l4 4',
  play: 'M7 4l13 8-13 8z',
  stop: 'M6 6h12v12H6z',
  menu: 'M4 7h16M4 12h16M4 17h16',
  info: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 11v6M12 7.5h.01',
  alert: 'M12 3l10 18H2zM12 10v5M12 18h.01',
  check: 'M5 12l5 5 9-10',
  tor: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 6a6 6 0 1 0 0 12M12 9a3 3 0 1 0 0 6',
  wifiOff: 'M3 3l18 18M8.5 16.5a5 5 0 0 1 7 0M5 13a10 10 0 0 1 5-2.7M19 13a10 10 0 0 0-2.4-1.7M2 9.5a15 15 0 0 1 4.4-2.6M12 20h.01',
  report: 'M6 3h12v18H6zM9 8h6M9 12h6M9 16h4',
  fingerprint: 'M12 4a8 8 0 0 0-8 8M12 4a8 8 0 0 1 8 8v1M8 20c1-2 1.5-4.5 1.5-8a2.5 2.5 0 0 1 5 0c0 3-.5 6-2 9M12 12c0 3-.5 6-2 8.5M17 17c.4-1.5.5-3 .5-5',
  cpu: 'M7 7h10v10H7zM10 10h4v4h-4zM10 3v4M14 3v4M10 17v4M14 17v4M3 10h4M3 14h4M17 10h4M17 14h4',
};

export function icon(name: keyof typeof P | string, size = 18, cls = ''): SVGSVGElement {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.8');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  if (cls) svg.setAttribute('class', cls);
  const path = document.createElementNS(NS, 'path');
  path.setAttribute('d', P[name] ?? P.info);
  svg.append(path);
  return svg;
}
