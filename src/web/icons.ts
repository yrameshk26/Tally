/**
 * Interface icons: 24-unit grid, 1.75 stroke, round caps, `currentColor`, so
 * they take the text colour of whatever holds them. Drawn for this project
 * rather than lifted from an icon set, which keeps the repository free of a
 * second licence to track.
 */
const PATHS = {
  overview: 'M4 5a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1zM13 5a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1h-5a1 1 0 0 1-1-1zM13 13a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-5a1 1 0 0 1-1-1zM4 16a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z',
  transactions: 'M7 7h13m0 0-3.5-3.5M20 7l-3.5 3.5M17 17H4m0 0 3.5-3.5M4 17l3.5 3.5',
  merchants: 'M4 9 5.4 4.8A1 1 0 0 1 6.3 4h11.4a1 1 0 0 1 .9.8L20 9M4 9v10a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1V9M4 9h16M9.5 20v-5.5h5V20',
  reports: 'M7 3h7l5 5v12a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1ZM14 3v5h5M9.5 17v-2.5M12.5 17v-5M15.5 17v-3.5',
  assistant: 'M20 11.5a7.5 7.5 0 0 1-10.9 6.7L4.5 19.5l1.3-4.3A7.5 7.5 0 1 1 20 11.5ZM9 11.5h.01M12.5 11.5h.01M16 11.5h.01',
  connections: 'M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-.9.9M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l.9-.9',
  profiles: 'M15.5 20v-1.2a3.3 3.3 0 0 0-3.3-3.3H7.3A3.3 3.3 0 0 0 4 18.8V20M9.75 12a3.25 3.25 0 1 0 0-6.5 3.25 3.25 0 0 0 0 6.5ZM20 20v-1.2a3.3 3.3 0 0 0-2.4-3.2M15.3 5.6a3.25 3.25 0 0 1 0 6.3',
  settings: 'M4 7h9m4 0h3M4 17h3m4 0h9M15 5v4M9 15v4',
  security: 'M12 3.5 19 6.2v5.1c0 4.4-2.9 7.6-7 9.2-4.1-1.6-7-4.8-7-9.2V6.2zM9 12.2l2 2 4-4',
  logout: 'M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 16.5 5.5 12 10 7.5M5.5 12H15',
  star: 'm12 3.8 2.5 5.1 5.6.8-4 3.9 1 5.6-5.1-2.7-5 2.7 1-5.6-4.1-3.9 5.7-.8z',
  refresh: 'M19.5 12a7.5 7.5 0 1 1-2.2-5.3L19.5 9M19.5 4.5V9H15',
  heart: 'M12 20s-7.5-4.6-7.5-10.2A4.3 4.3 0 0 1 12 7a4.3 4.3 0 0 1 7.5 2.8C19.5 15.4 12 20 12 20Z',
  sun: 'M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM12 2.5v2M12 19.5v2M4.6 4.6l1.4 1.4M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4 6 18M18 6l1.4-1.4',
  moon: 'M20 14.5A8.5 8.5 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5Z',
  system: 'M4 5.5a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1V15a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1zM9 20h6M12 16v4',
  up: 'M7 14l5-5 5 5',
  down: 'M7 10l5 5 5-5',
} as const;

export type IconName = keyof typeof PATHS;

export function icon(name: IconName, size = 18, className = 'i'): string {
  return (
    `<svg class="${className}" width="${String(size)}" height="${String(size)}" viewBox="0 0 24 24"` +
    ` fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"` +
    ` stroke-linejoin="round" aria-hidden="true"><path d="${PATHS[name]}"/></svg>`
  );
}
